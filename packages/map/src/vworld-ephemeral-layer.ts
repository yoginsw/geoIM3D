import {
  addProtocol,
  removeProtocol,
  type AddProtocolAction,
} from "maplibre-gl";

export const VWORLD_PROTOCOL = "geoim3d-vworld";
export const VWORLD_ATTRIBUTION_HTML =
  '<a href="https://www.vworld.kr/" target="_blank" rel="noopener noreferrer">VWorld 디지털트윈국토</a>';

const SOURCE_ID = "geoim3d-vworld-source";
const LAYER_ID = "geoim3d-vworld-layer";
const HYBRID_SOURCE_ID = "geoim3d-vworld-hybrid-source";
const HYBRID_LAYER_ID = "geoim3d-vworld-hybrid-layer";
const MIN_ZOOM = 6;

export type VWorldRasterLayer =
  | "Base"
  | "white"
  | "midnight"
  | "Hybrid"
  | "Satellite";

export interface VWorldTileRequest {
  layer: VWorldRasterLayer;
  z: number;
  x: number;
  y: number;
}

export interface VWorldTileResult {
  contentType: "image/png" | "image/jpeg";
  bytes: readonly number[];
}

export type VWorldTileTransport = (
  request: VWorldTileRequest,
  signal: AbortSignal
) => Promise<VWorldTileResult>;

export interface VWorldProtocolRuntime {
  addProtocol(protocol: string, handler: AddProtocolAction): void;
  removeProtocol(protocol: string): void;
}

export interface VWorldMapLike {
  addSource(id: string, source: Record<string, unknown>): void;
  getSource(id: string): unknown;
  removeSource(id: string): void;
  addLayer(layer: Record<string, unknown>): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  on(event: "style.load", listener: () => void): void;
  off(event: "style.load", listener: () => void): void;
}

interface ControllerOptions {
  desktop: boolean;
  map: VWorldMapLike;
  protocol?: VWorldProtocolRuntime;
  transport: VWorldTileTransport;
}

interface ProtocolLease {
  protocol: VWorldProtocolRuntime;
  transport: VWorldTileTransport;
  references: number;
}

const defaultProtocolRuntime: VWorldProtocolRuntime = {
  addProtocol,
  removeProtocol,
};

let protocolLease: ProtocolLease | null = null;

function maxZoom(layer: VWorldRasterLayer): number {
  return layer === "white" || layer === "midnight" ? 18 : 19;
}

function contentType(
  layer: VWorldRasterLayer
): VWorldTileResult["contentType"] {
  return layer === "Satellite" ? "image/jpeg" : "image/png";
}

function isLayer(value: string): value is VWorldRasterLayer {
  return (
    value === "Base" ||
    value === "white" ||
    value === "midnight" ||
    value === "Hybrid" ||
    value === "Satellite"
  );
}

function parseInteger(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseVWorldTileUrl(url: string): VWorldTileRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${VWORLD_PROTOCOL}:` ||
    parsed.hostname !== "tile" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return null;
  const [layerValue, zValue, xValue, yValue] = segments;
  if (!isLayer(layerValue)) return null;
  const z = parseInteger(zValue);
  const x = parseInteger(xValue);
  const y = parseInteger(yValue);
  if (z === null || x === null || y === null) return null;
  if (z < MIN_ZOOM || z > maxZoom(layerValue)) return null;
  const dimension = 2 ** z;
  if (x >= dimension || y >= dimension) return null;
  return { layer: layerValue, z, x, y };
}

function acquireProtocol(
  protocol: VWorldProtocolRuntime,
  transport: VWorldTileTransport
): void {
  if (protocolLease) {
    if (
      protocolLease.protocol !== protocol ||
      protocolLease.transport !== transport
    ) {
      throw new Error("vworld_protocol_conflict");
    }
    protocolLease.references += 1;
    return;
  }

  const handler: AddProtocolAction = async (
    requestParameters,
    abortController
  ) => {
    const request = parseVWorldTileUrl(requestParameters.url);
    if (!request) throw new Error("vworld_invalid_request");
    const result = await transport(request, abortController.signal);
    if (result.contentType !== contentType(request.layer)) {
      throw new Error("vworld_invalid_response");
    }
    const bytes = Uint8Array.from(result.bytes);
    return {
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ),
    };
  };

  protocol.addProtocol(VWORLD_PROTOCOL, handler);
  protocolLease = { protocol, transport, references: 1 };
}

function releaseProtocol(
  protocol: VWorldProtocolRuntime,
  transport: VWorldTileTransport
): void {
  if (
    !protocolLease ||
    protocolLease.protocol !== protocol ||
    protocolLease.transport !== transport
  ) {
    return;
  }
  protocolLease.references -= 1;
  if (protocolLease.references > 0) return;
  protocol.removeProtocol(VWORLD_PROTOCOL);
  protocolLease = null;
}

export class VWorldEphemeralLayerController {
  private readonly desktop: boolean;
  private readonly map: VWorldMapLike;
  private readonly protocol: VWorldProtocolRuntime;
  private readonly transport: VWorldTileTransport;
  private activeLayer: VWorldRasterLayer | null = null;
  private leased = false;
  private disposed = false;
  private mounting = false;

  private readonly handleStyleData = () => {
    if (this.activeLayer && !this.disposed) this.mountLayer();
  };

  constructor(options: ControllerOptions) {
    this.desktop = options.desktop;
    this.map = options.map;
    this.protocol = options.protocol ?? defaultProtocolRuntime;
    this.transport = options.transport;
  }

  activate(layer: VWorldRasterLayer): boolean {
    if (this.disposed || !this.desktop || !isLayer(layer)) return false;
    if (!this.leased) {
      acquireProtocol(this.protocol, this.transport);
      this.leased = true;
      this.map.on("style.load", this.handleStyleData);
    }
    if (this.activeLayer !== layer) this.removeMapState();
    this.activeLayer = layer;
    this.mountLayer();
    return true;
  }

  deactivate(): void {
    if (!this.leased) return;
    this.map.off("style.load", this.handleStyleData);
    this.removeMapState();
    this.activeLayer = null;
    releaseProtocol(this.protocol, this.transport);
    this.leased = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivate();
    this.disposed = true;
  }

  private mountLayer(): void {
    const layer = this.activeLayer;
    if (!layer || this.mounting) return;
    this.mounting = true;
    try {
      this.mountRaster(SOURCE_ID, LAYER_ID, layer);
      if (layer === "Satellite") {
        this.mountRaster(HYBRID_SOURCE_ID, HYBRID_LAYER_ID, "Hybrid");
      }
    } finally {
      this.mounting = false;
    }
  }

  private mountRaster(
    sourceId: string,
    layerId: string,
    layer: VWorldRasterLayer
  ): void {
    if (!this.map.getSource(sourceId)) {
      this.map.addSource(sourceId, {
        type: "raster",
        tiles: [`${VWORLD_PROTOCOL}://tile/${layer}/{z}/{x}/{y}`],
        tileSize: 256,
        minzoom: MIN_ZOOM,
        maxzoom: maxZoom(layer),
        attribution: VWORLD_ATTRIBUTION_HTML,
      });
    }
    if (!this.map.getLayer(layerId)) {
      this.map.addLayer({
        id: layerId,
        type: "raster",
        source: sourceId,
      });
    }
  }

  private removeMapState(): void {
    if (this.map.getLayer(HYBRID_LAYER_ID))
      this.map.removeLayer(HYBRID_LAYER_ID);
    if (this.map.getSource(HYBRID_SOURCE_ID))
      this.map.removeSource(HYBRID_SOURCE_ID);
    if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
    if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
  }
}

export function resetVWorldProtocolForTests(): void {
  if (protocolLease) {
    protocolLease.protocol.removeProtocol(VWORLD_PROTOCOL);
    protocolLease = null;
  }
}
