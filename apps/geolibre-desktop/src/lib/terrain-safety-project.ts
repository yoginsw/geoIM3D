import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";
import {
  TERRAIN_SAFETY_RESULT_NAME,
  buildTerrainSafetyLayer,
  normalizeTerrainSafetyResult,
  type TerrainSafetyResult,
} from "./terrain-safety-analysis";
import { containsPersistedTerrainSafetyAnalysis } from "./project-private-content";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => exactJsonEqual(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && exactJsonEqual(leftRecord[key], rightRecord[key]),
    );
}

function sanitizeTerrainSafetyLayer(layer: GeoLibreLayer): GeoLibreLayer {
  const metadata = asRecord(layer.metadata);
  const summary = metadata?.terrainSafetyAnalysis;
  const collection = layer.geojson;
  const source = asRecord(layer.source);
  if (
    Object.keys(layer).some((key) =>
      !["id", "name", "type", "source", "visible", "opacity", "style", "metadata", "geojson", "beforeId"].includes(key),
    ) ||
    layer.beforeId !== undefined ||
    layer.name !== TERRAIN_SAFETY_RESULT_NAME ||
    layer.type !== "geojson" ||
    metadata?.customLayerType !== "terrain-slope-safety" ||
    metadata?.excludeFromHistory !== true ||
    Object.keys(metadata).length !== 3 ||
    !source ||
    Object.keys(source).length !== 1 ||
    source.type !== "geojson" ||
    collection?.type !== "FeatureCollection" ||
    Object.keys(collection).length !== 2 ||
    collection.features.length !== 1
  ) {
    throw new Error("TERRAIN_SAFETY_PROJECT_INVALID");
  }
  const feature = collection.features[0];
  if (
    feature.type !== "Feature" ||
    !feature.geometry ||
    !feature.properties ||
    Object.keys(feature.properties).length !== 0 ||
    "id" in feature ||
    Object.keys(feature).some((key) => !["type", "geometry", "properties"].includes(key))
  ) {
    throw new Error("TERRAIN_SAFETY_PROJECT_INVALID");
  }
  let result: TerrainSafetyResult;
  try {
    result = normalizeTerrainSafetyResult({ boundary: feature.geometry, summary });
  } catch {
    throw new Error("TERRAIN_SAFETY_PROJECT_INVALID");
  }
  if (
    typeof layer.id !== "string" ||
    layer.id.length < 1 ||
    layer.id.length > 128 ||
    typeof layer.visible !== "boolean" ||
    typeof layer.opacity !== "number" ||
    !Number.isFinite(layer.opacity) ||
    layer.opacity < 0 ||
    layer.opacity > 1
  ) {
    throw new Error("TERRAIN_SAFETY_PROJECT_INVALID");
  }
  const sanitized = buildTerrainSafetyLayer(result);
  if (!exactJsonEqual(layer.style, sanitized.style)) {
    throw new Error("TERRAIN_SAFETY_PROJECT_INVALID");
  }
  return {
    ...sanitized,
    id: layer.id,
    visible: layer.visible,
    opacity: layer.opacity,
  };
}

export function sanitizeIncomingTerrainSafetyProject(
  project: GeoLibreProject,
): GeoLibreProject {
  const { layers, ...projectWithoutLayers } = project;
  if (containsPersistedTerrainSafetyAnalysis(projectWithoutLayers)) {
    throw new Error("TERRAIN_SAFETY_PROJECT_INVALID");
  }
  return {
    ...project,
    layers: layers.map((layer) =>
      containsPersistedTerrainSafetyAnalysis(layer) ? sanitizeTerrainSafetyLayer(layer) : layer,
    ),
  };
}
