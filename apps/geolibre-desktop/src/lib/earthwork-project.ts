import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";
import {
  buildEarthworkLayer,
  normalizeEarthworkResult,
  type EarthworkResult,
} from "./earthwork-analysis";
import { containsPersistedEarthworkAnalysis } from "./project-private-content";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeEarthworkLayer(layer: GeoLibreLayer): GeoLibreLayer {
  const metadata = asRecord(layer.metadata);
  const summary = metadata?.earthworkAnalysis;
  const collection = layer.geojson;
  const source = asRecord(layer.source);
  if (
    layer.type !== "geojson" ||
    metadata?.customLayerType !== "earthwork-analysis" ||
    metadata?.excludeFromHistory !== true ||
    Object.keys(metadata).length !== 3 ||
    !source ||
    Object.keys(source).length !== 1 ||
    source.type !== "geojson" ||
    collection?.type !== "FeatureCollection" ||
    collection.features.length !== 1
  ) {
    throw new Error("EARTHWORK_PROJECT_INVALID");
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
    throw new Error("EARTHWORK_PROJECT_INVALID");
  }
  let result: EarthworkResult;
  try {
    result = normalizeEarthworkResult({ boundary: feature.geometry, summary });
  } catch {
    throw new Error("EARTHWORK_PROJECT_INVALID");
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
    throw new Error("EARTHWORK_PROJECT_INVALID");
  }
  const sanitized = buildEarthworkLayer(result);
  return {
    ...sanitized,
    id: layer.id,
    visible: layer.visible,
    opacity: layer.opacity,
  };
}

export function sanitizeIncomingEarthworkProject(
  project: GeoLibreProject,
): GeoLibreProject {
  const { layers, ...projectWithoutLayers } = project;
  if (containsPersistedEarthworkAnalysis(projectWithoutLayers)) {
    throw new Error("EARTHWORK_PROJECT_INVALID");
  }
  return {
    ...project,
    layers: layers.map((layer) =>
      containsPersistedEarthworkAnalysis(layer) ? sanitizeEarthworkLayer(layer) : layer,
    ),
  };
}
