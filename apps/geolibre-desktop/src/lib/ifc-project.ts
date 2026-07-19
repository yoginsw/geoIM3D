import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";
import {
  IFC_MAX_GLB_BYTES,
  IFC_MAX_PROJECT_GLB_BYTES,
  buildIfcModelLayer,
  createIfcImportSummary,
  parseIfcPlacement,
  validateGlb,
  type IfcImportSummary,
} from "./ifc-model";

const GLB_DATA_URL_PREFIX = "data:model/gltf-binary;base64,";
const MAX_BASE64_LENGTH = Math.ceil(IFC_MAX_GLB_BYTES / 3) * 4;

function fail(): never {
  throw new Error("IFC_PROJECT_INVALID");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function decodeGlbDataUrl(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.startsWith(GLB_DATA_URL_PREFIX)) fail();
  const encoded = value.slice(GLB_DATA_URL_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length > MAX_BASE64_LENGTH ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    fail();
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    fail();
  }
  if (binary.length > IFC_MAX_GLB_BYTES) fail();
  const glb = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    glb[index] = binary.charCodeAt(index);
  }
  validateGlb(glb);
  return glb;
}

function readPlacement(layer: GeoLibreLayer) {
  const data = (layer.source as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== 1) fail();
  const row = asRecord(data[0]);
  if (row.contract !== "geoim3d-ifc-v1") fail();
  return parseIfcPlacement({
    longitude: String(row.lng),
    latitude: String(row.lat),
    altitude: String(row.altitude),
    bearing: String(row.bearing),
    scale: String(row.scale),
  });
}

function readSummary(value: unknown, glbBytes: number): IfcImportSummary {
  const raw = asRecord(value);
  let summary: IfcImportSummary;
  try {
    summary = createIfcImportSummary(raw);
  } catch {
    fail();
  }
  if (
    raw.sourceFormat !== "IFC" ||
    raw.parser !== "web-ifc" ||
    summary.schema === "UNKNOWN" ||
    summary.elementCount < 1 ||
    summary.meshCount < 1 ||
    summary.triangleCount < 1 ||
    summary.glbBytes !== glbBytes ||
    raw.schema !== summary.schema ||
    raw.elementCount !== summary.elementCount ||
    raw.meshCount !== summary.meshCount ||
    raw.triangleCount !== summary.triangleCount ||
    raw.glbBytes !== summary.glbBytes ||
    raw.radiusMeters !== summary.radiusMeters ||
    summary.radiusMeters <= 0
  ) {
    fail();
  }
  return summary;
}

function sanitizeIfcLayer(layer: GeoLibreLayer): GeoLibreLayer {
  if (
    layer.type !== "deckgl-viz" ||
    layer.metadata.sourceKind !== "deckgl-viz" ||
    layer.metadata.customLayerType !== "scenegraph"
  ) {
    fail();
  }
  const config = asRecord(layer.metadata.vizConfig);
  const scenegraph = asRecord(config.scenegraph);
  const glb = decodeGlbDataUrl(scenegraph.modelUrl);
  const placement = readPlacement(layer);
  const summary = readSummary(layer.metadata.ifcImport, glb.byteLength);
  const rebuilt = buildIfcModelLayer({
    glb,
    placement,
    radiusMeters: summary.radiusMeters,
    summary,
  });
  return {
    ...rebuilt,
    id: typeof layer.id === "string" && layer.id.trim() ? layer.id : rebuilt.id,
    visible: layer.visible !== false,
    opacity:
      typeof layer.opacity === "number" &&
      Number.isFinite(layer.opacity) &&
      layer.opacity >= 0 &&
      layer.opacity <= 1
        ? layer.opacity
        : 1,
    ...(typeof layer.beforeId === "string" ? { beforeId: layer.beforeId } : {}),
    ...(typeof layer.groupId === "string" ? { groupId: layer.groupId } : {}),
  };
}

function isScenegraphLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "deckgl-viz" &&
    layer.metadata.sourceKind === "deckgl-viz" &&
    layer.metadata.customLayerType === "scenegraph";
}

function hasIfcContractSignal(layer: GeoLibreLayer): boolean {
  const data = (layer.source as { data?: unknown }).data;
  const contract = Array.isArray(data) && data.length === 1 &&
    data[0] && typeof data[0] === "object"
    ? (data[0] as Record<string, unknown>).contract
    : undefined;
  return layer.name === "IFC Model" || contract === "geoim3d-ifc-v1";
}

/** Remote/embed/collaboration desktop ingress must not carry private scenegraphs. */
export function containsPersistedScenegraph(project: GeoLibreProject): boolean {
  return project.layers.some(isScenegraphLayer);
}

/** Revalidate and rebuild persisted IFC layers before applying a desktop project. */
export function sanitizeIncomingIfcProject(
  project: GeoLibreProject,
): GeoLibreProject {
  let totalGlbBytes = 0;
  return {
    ...project,
    layers: project.layers.map((layer) => {
      if (layer.metadata.ifcImport === undefined) {
        if (hasIfcContractSignal(layer)) fail();
        return layer;
      }
      if (!isScenegraphLayer(layer)) fail();
      const sanitized = sanitizeIfcLayer(layer);
      totalGlbBytes += (sanitized.metadata.ifcImport as IfcImportSummary).glbBytes;
      if (totalGlbBytes > IFC_MAX_PROJECT_GLB_BYTES) fail();
      return sanitized;
    }),
  };
}
