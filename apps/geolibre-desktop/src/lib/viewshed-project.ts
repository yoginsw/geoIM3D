import {
  createEmptyProject,
  type GeoLibreLayer,
  type GeoLibreProject,
  type MapViewState,
} from "@geolibre/core";
import {
  VIEWSHED_RESULT_NAME,
  buildViewshedLayer,
  normalizeViewshedResult,
  type ViewshedResult,
} from "./viewshed-analysis";
import { containsPersistedViewshedAnalysis } from "./project-private-content";

const CANONICAL_PROJECT_NAME = "geoIM3D Viewshed Project";
const CANONICAL_PROJECT_VERSION = "0.2.0";
const CANONICAL_BASEMAP_STYLE = "";
const CANONICAL_ZOOM = 14;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => exactJsonEqual(value, right[index]))
    );
  }
  const a = asRecord(left);
  const b = asRecord(right);
  if (!a || !b) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key, index) => key === bKeys[index] && exactJsonEqual(a[key], b[key])
    )
  );
}

function featureGeometry(feature: unknown): unknown {
  const record = asRecord(feature);
  if (
    !record ||
    Object.keys(record).some(
      (key) => !["type", "geometry", "properties"].includes(key)
    ) ||
    record.type !== "Feature" ||
    !record.geometry ||
    !asRecord(record.properties) ||
    Object.keys(record.properties as Record<string, unknown>).length !== 0
  )
    throw new Error("VIEWSHED_PROJECT_INVALID");
  return record.geometry;
}

function sanitizeViewshedLayer(layer: GeoLibreLayer): GeoLibreLayer {
  const metadata = asRecord(layer.metadata);
  const source = asRecord(layer.source);
  const collection = layer.geojson;
  if (
    Object.keys(layer).some(
      (key) =>
        ![
          "id",
          "name",
          "type",
          "source",
          "visible",
          "opacity",
          "style",
          "metadata",
          "geojson",
          "beforeId",
          "excludeFromHistory",
        ].includes(key)
    ) ||
    layer.beforeId !== undefined ||
    layer.name !== VIEWSHED_RESULT_NAME ||
    layer.type !== "geojson" ||
    layer.excludeFromHistory !== true ||
    !metadata ||
    Object.keys(metadata).length !== 2 ||
    metadata.customLayerType !== "viewshed-analysis" ||
    !source ||
    Object.keys(source).length !== 1 ||
    source.type !== "geojson" ||
    collection?.type !== "FeatureCollection" ||
    Object.keys(collection).length !== 2 ||
    collection.features.length !== 3 ||
    typeof layer.id !== "string" ||
    layer.id.length < 1 ||
    layer.id.length > 128 ||
    typeof layer.visible !== "boolean" ||
    !Number.isFinite(layer.opacity) ||
    layer.opacity < 0 ||
    layer.opacity > 1
  )
    throw new Error("VIEWSHED_PROJECT_INVALID");
  let result: ViewshedResult;
  try {
    result = normalizeViewshedResult({
      boundary: featureGeometry(collection.features[0]),
      observer: featureGeometry(collection.features[1]),
      visibleRuns: featureGeometry(collection.features[2]),
      summary: metadata.viewshedAnalysis,
    });
  } catch {
    throw new Error("VIEWSHED_PROJECT_INVALID");
  }
  const canonical = buildViewshedLayer(result);
  if (!exactJsonEqual(layer.style, canonical.style))
    throw new Error("VIEWSHED_PROJECT_INVALID");
  return {
    id: layer.id,
    name: canonical.name,
    type: canonical.type,
    source: canonical.source,
    visible: layer.visible,
    opacity: layer.opacity,
    style: canonical.style,
    metadata: canonical.metadata,
    geojson: canonical.geojson,
    excludeFromHistory: true,
  };
}

function canonicalLayers(project: GeoLibreProject): GeoLibreLayer[] {
  const { layers, ...outsideLayers } = project;
  if (
    !Array.isArray(layers) ||
    containsPersistedViewshedAnalysis(outsideLayers)
  ) {
    throw new Error("VIEWSHED_PROJECT_INVALID");
  }
  const viewshedLayers = layers
    .filter((layer) => containsPersistedViewshedAnalysis(layer))
    .map(sanitizeViewshedLayer);
  if (
    viewshedLayers.length === 0 ||
    viewshedLayers.length !==
      layers.filter((layer) => containsPersistedViewshedAnalysis(layer)).length
  ) {
    throw new Error("VIEWSHED_PROJECT_INVALID");
  }
  return viewshedLayers;
}

function canonicalMapView(layers: GeoLibreLayer[]): MapViewState {
  const observer = layers[0].geojson?.features[1]?.geometry;
  if (observer?.type !== "Point" || observer.coordinates.length < 2) {
    throw new Error("VIEWSHED_PROJECT_INVALID");
  }
  return {
    center: [observer.coordinates[0], observer.coordinates[1]],
    zoom: CANONICAL_ZOOM,
    bearing: 0,
    pitch: 0,
  };
}

/** Fixed-key/order disk DTO. No caller project metadata, names, plugins or non-private layers enter it. */
export function buildCanonicalViewshedProjectDto(
  project: GeoLibreProject
): Record<string, unknown> {
  const layers = canonicalLayers(project);
  return {
    version: CANONICAL_PROJECT_VERSION,
    name: CANONICAL_PROJECT_NAME,
    mapView: canonicalMapView(layers),
    basemapStyleUrl: CANONICAL_BASEMAP_STYLE,
    basemapVisible: true,
    basemapOpacity: 1,
    layers,
    layerGroups: [],
    styles: {},
    metadata: {},
  };
}

/** Strict raw-JSON ingress before the generic project parser can discard foreign fields. */
export function parseCanonicalViewshedProjectDto(
  value: unknown
): GeoLibreProject {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.layers))
    throw new Error("VIEWSHED_PROJECT_INVALID");
  const candidate = record as unknown as GeoLibreProject;
  const expected = buildCanonicalViewshedProjectDto(candidate);
  if (!exactJsonEqual(record, expected))
    throw new Error("VIEWSHED_PROJECT_INVALID");
  return canonicalRuntimeProject(candidate);
}

function canonicalRuntimeProject(project: GeoLibreProject): GeoLibreProject {
  const layers = canonicalLayers(project);
  return {
    ...createEmptyProject(CANONICAL_PROJECT_NAME, {
      basemapStyleUrl: CANONICAL_BASEMAP_STYLE,
      mapView: canonicalMapView(layers),
    }),
    layers,
  };
}

/** Local Save egress: collapse a mixed live project to the fixed private snapshot DTO. */
export function sanitizeViewshedProjectForLocalSave(
  project: GeoLibreProject
): GeoLibreProject {
  if (!containsPersistedViewshedAnalysis(project)) return project;
  return canonicalRuntimeProject(project);
}

/** Local Open ingress: only the exact parse-normalized canonical snapshot is accepted. */
export function sanitizeIncomingViewshedProject(
  project: GeoLibreProject
): GeoLibreProject {
  if (!containsPersistedViewshedAnalysis(project)) return project;
  const canonical = canonicalRuntimeProject(project);
  if (!exactJsonEqual(project, canonical))
    throw new Error("VIEWSHED_PROJECT_INVALID");
  return canonical;
}
