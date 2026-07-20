import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Detect a persisted private IFC scenegraph without loading model parsers. */
export function isPersistedPrivateScenegraph(layer: GeoLibreLayer): boolean {
  if (layer.type !== "deckgl-viz") return false;
  const metadata = asRecord(layer.metadata);
  const config = asRecord(metadata?.vizConfig);
  const scenegraph = asRecord(config?.scenegraph);
  const source = asRecord(layer.source);
  const rows = Array.isArray(source?.data) ? source.data : [];
  const firstRow = asRecord(rows[0]);
  const privateImportMetadata = Object.entries(metadata ?? {}).some(
    ([key, value]) => key.toLowerCase().endsWith("import") && asRecord(value) !== null,
  );
  return (
    metadata?.customLayerType === "scenegraph" ||
    scenegraph !== null ||
    privateImportMetadata ||
    typeof firstRow?.modelUrl === "string" ||
    typeof firstRow?.contract === "string"
  );
}

export function containsPersistedPrivateScenegraph(project: GeoLibreProject): boolean {
  return project.layers.some(isPersistedPrivateScenegraph);
}

const EARTHWORK_MARKERS = [
  "earthwork-analysis",
  "geoim3d-earthwork-v1",
  "geoim3d-earthwork-1",
  "pixel-center-constant-grade-v1",
  "pixel-center-midpoint-v1",
] as const;
const EARTHWORK_SUMMARY_KEYS = [
  "cutcubicmeters", "fillcubicmeters", "netcubicmeters", "includedcells",
] as const;

const TERRAIN_SAFETY_MARKERS = [
  "terrain-slope-safety",
  "geoim3d-terrain-slope-safety-v1",
  "horn-3x3-pixel-center-v1",
] as const;
const TERRAIN_SAFETY_SUMMARY_KEYS = [
  "safecells", "warningcells", "dangercells", "unknowncells", "meanslopedegrees",
] as const;

function containsBoundedPrivateMarker(
  value: unknown,
  markers: readonly string[],
  containerKey: string,
  summaryKeys: readonly string[],
): boolean {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > 32 || visited > 100_000) {
      throw new Error("PROJECT_PRIVATE_CONTENT_REJECTED");
    }
    if (typeof current.value === "string") {
      const normalized = current.value.toLowerCase();
      if (markers.some((marker) => normalized.includes(marker))) return true;
      const trimmed = current.value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        if (trimmed.length > 16 * 1024 * 1024) {
          throw new Error("PROJECT_PRIVATE_CONTENT_REJECTED");
        }
        try {
          stack.push({ value: JSON.parse(trimmed) as unknown, depth: current.depth + 1 });
        } catch {
          // Non-JSON text has no recursively inspectable object structure.
        }
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value as object)) continue;
    seen.add(current.value as object);
    visited += 1;
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    const entries = Object.entries(current.value as Record<string, unknown>);
    const normalizedKeys = new Set(entries.map(([key]) => key.toLowerCase()));
    if (
      normalizedKeys.has(containerKey) ||
      summaryKeys.every((key) => normalizedKeys.has(key))
    ) return true;
    for (const [, child] of entries) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

export function containsPersistedEarthworkAnalysis(value: unknown): boolean {
  return containsBoundedPrivateMarker(
    value,
    EARTHWORK_MARKERS,
    "earthworkanalysis",
    EARTHWORK_SUMMARY_KEYS,
  );
}

export function containsPersistedTerrainSafetyAnalysis(value: unknown): boolean {
  return containsBoundedPrivateMarker(
    value,
    TERRAIN_SAFETY_MARKERS,
    "terrainsafetyanalysis",
    TERRAIN_SAFETY_SUMMARY_KEYS,
  );
}

export function containsPersistedPrivateAnalysis(value: unknown): boolean {
  return containsPersistedEarthworkAnalysis(value) || containsPersistedTerrainSafetyAnalysis(value);
}

export function isPersistedPrivateEarthwork(layer: GeoLibreLayer): boolean {
  return containsPersistedEarthworkAnalysis(layer);
}

export function assertNoEarthworkPrivateContent(value: unknown): void {
  if (containsPersistedEarthworkAnalysis(value)) {
    throw new Error("EARTHWORK_PRIVATE_CONTENT_BLOCKED");
  }
  if (containsPersistedTerrainSafetyAnalysis(value)) {
    throw new Error("TERRAIN_SAFETY_PRIVATE_CONTENT_BLOCKED");
  }
}

export const assertNoPrivateAnalysisContent = assertNoEarthworkPrivateContent;

const safeLayerCache = new WeakMap<GeoLibreLayer[], GeoLibreLayer[]>();

/** Compatibility name retained; filters all private DEM-analysis layers. */
export function selectLayersWithoutPrivateEarthwork(layers: GeoLibreLayer[]): GeoLibreLayer[] {
  const cached = safeLayerCache.get(layers);
  if (cached) return cached;
  const filtered = layers.filter((layer) => !containsPersistedPrivateAnalysis(layer));
  safeLayerCache.set(layers, filtered);
  return filtered;
}

/** Fail closed before any project snapshot crosses a public/remote boundary. */
export function assertProjectSafeForExternalTransfer(project: GeoLibreProject): void {
  if (
    containsPersistedPrivateScenegraph(project) ||
    containsPersistedPrivateAnalysis(project)
  ) {
    throw new Error("PROJECT_PRIVATE_CONTENT_REJECTED");
  }
}
