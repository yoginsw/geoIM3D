import type {
  EphemeralFeatureCollection,
  VWorldZoningService,
} from "./vworld-data";

export const VWORLD_DATA_ATTRIBUTION =
  '<a href="https://www.vworld.kr/">VWorld 디지털트윈국토</a>';

const CADASTRAL_SOURCE = "geoim3d-vworld-cadastral";
const CADASTRAL_FILL = "geoim3d-vworld-cadastral-fill";
const CADASTRAL_OUTLINE = "geoim3d-vworld-cadastral-outline";
const ZONING_SOURCE = "geoim3d-vworld-zoning";
const ZONING_FILL = "geoim3d-vworld-zoning-fill";
const ZONING_OUTLINE = "geoim3d-vworld-zoning-outline";

interface GeoJSONSourceLike {
  setData(data: EphemeralFeatureCollection): void;
}

export interface VWorldDataMapLike {
  addSource(id: string, source: Record<string, unknown>): void;
  getSource(id: string): unknown;
  removeSource(id: string): void;
  addLayer(layer: Record<string, unknown>): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  on(event: "styledata", handler: () => void): void;
  off(event: "styledata", handler: () => void): void;
}

const ZONING_COLORS: Record<VWorldZoningService, string> = {
  LT_C_UQ111: "#E24A4A",
  LT_C_UQ112: "#F29D38",
  LT_C_UQ113: "#5AAE61",
  LT_C_UQ114: "#2F80A8",
};

function source(source: unknown): GeoJSONSourceLike | null {
  return source !== null &&
    typeof source === "object" &&
    "setData" in source &&
    typeof (source as GeoJSONSourceLike).setData === "function"
    ? (source as GeoJSONSourceLike)
    : null;
}

export class VWorldDataLayerController {
  private cadastral: EphemeralFeatureCollection | null = null;
  private zoning: EphemeralFeatureCollection | null = null;
  private zoningService: VWorldZoningService | null = null;
  private disposed = false;
  private mounting = false;

  constructor(private readonly map: VWorldDataMapLike) {
    this.map.on("styledata", this.handleStyleData);
  }

  private readonly handleStyleData = () => {
    this.mount();
  };

  setCadastral(collection: EphemeralFeatureCollection): void {
    if (this.disposed) return;
    this.cadastral = collection;
    this.mount();
  }

  setZoning(
    collection: EphemeralFeatureCollection,
    service: VWorldZoningService,
  ): void {
    if (this.disposed) return;
    this.zoning = collection;
    this.zoningService = service;
    this.mount();
  }

  clearCadastral(): void {
    this.cadastral = null;
    this.remove(CADASTRAL_SOURCE, CADASTRAL_FILL, CADASTRAL_OUTLINE);
  }

  clearZoning(): void {
    this.zoning = null;
    this.zoningService = null;
    this.remove(ZONING_SOURCE, ZONING_FILL, ZONING_OUTLINE);
  }

  private mount(): void {
    if (this.disposed || this.mounting) return;
    this.mounting = true;
    try {
      if (this.cadastral) {
        this.mountCollection(
          CADASTRAL_SOURCE,
          CADASTRAL_FILL,
          CADASTRAL_OUTLINE,
          this.cadastral,
          "#33CC27",
          "#0B365F",
        );
      }
      if (this.zoning && this.zoningService) {
        this.mountCollection(
          ZONING_SOURCE,
          ZONING_FILL,
          ZONING_OUTLINE,
          this.zoning,
          ZONING_COLORS[this.zoningService],
          "#FFFFFF",
        );
      }
    } finally {
      this.mounting = false;
    }
  }

  private mountCollection(
    sourceId: string,
    fillId: string,
    outlineId: string,
    data: EphemeralFeatureCollection,
    fillColor: string,
    outlineColor: string,
  ): void {
    const existing = source(this.map.getSource(sourceId));
    if (existing) {
      existing.setData(data);
    } else {
      this.map.addSource(sourceId, {
        type: "geojson",
        data,
        attribution: VWORLD_DATA_ATTRIBUTION,
      });
    }
    if (!this.map.getLayer(fillId)) {
      this.map.addLayer({
        id: fillId,
        type: "fill",
        source: sourceId,
        paint: {
          "fill-color": fillColor,
          "fill-opacity": 0.24,
        },
      });
    }
    if (!this.map.getLayer(outlineId)) {
      this.map.addLayer({
        id: outlineId,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": outlineColor,
          "line-width": 1.5,
          "line-opacity": 0.9,
        },
      });
    }
  }

  private remove(sourceId: string, fillId: string, outlineId: string): void {
    if (this.map.getLayer(outlineId)) this.map.removeLayer(outlineId);
    if (this.map.getLayer(fillId)) this.map.removeLayer(fillId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.map.off("styledata", this.handleStyleData);
    this.remove(CADASTRAL_SOURCE, CADASTRAL_FILL, CADASTRAL_OUTLINE);
    this.remove(ZONING_SOURCE, ZONING_FILL, ZONING_OUTLINE);
    this.cadastral = null;
    this.zoning = null;
    this.zoningService = null;
  }
}
