import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Detect a persisted private scenegraph without importing any desktop model
 * parser or model-specific contract into Web/PWA bundles.
 *
 * Multiple coupled signals are checked so deleting only one discriminator does
 * not turn a private model into a portable public layer.
 */
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

export function containsPersistedPrivateScenegraph(
  project: GeoLibreProject,
): boolean {
  return project.layers.some(isPersistedPrivateScenegraph);
}

const EARTHWORK_MARKERS = [
  "earthwork-analysis",
  "geoim3d-earthwork-v1",
  "geoim3d-earthwork-1",
  "pixel-center-constant-grade-v1",
  "pixel-center-midpoint-v1",
  "geotiff dem",
] as const;

const EARTHWORK_SUMMARY_KEYS = [
  "cutcubicmeters",
  "fillcubicmeters",
  "netcubicmeters",
  "includedcells",
] as const;

function stringContainsEarthworkMarker(value: string): boolean {
  const normalized = value.toLowerCase();
  return EARTHWORK_MARKERS.some((marker) => normalized.includes(marker));
}

/** Detect Earthwork markers even when stripped from their outer layer. */
export function containsPersistedEarthworkAnalysis(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > 32 || visited > 100_000) {
      throw new Error("PROJECT_PRIVATE_CONTENT_REJECTED");
    }
    if (typeof current.value === "string") {
      if (stringContainsEarthworkMarker(current.value)) return true;
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
      normalizedKeys.has("earthworkanalysis") ||
      EARTHWORK_SUMMARY_KEYS.every((key) => normalizedKeys.has(key))
    ) {
      return true;
    }
    for (const [, child] of entries) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

export function isPersistedPrivateEarthwork(layer: GeoLibreLayer): boolean {
  return containsPersistedEarthworkAnalysis(layer);
}

export function assertNoEarthworkPrivateContent(value: unknown): void {
  if (containsPersistedEarthworkAnalysis(value)) {
    throw new Error("EARTHWORK_PRIVATE_CONTENT_BLOCKED");
  }
}

const safeLayerCache = new WeakMap<GeoLibreLayer[], GeoLibreLayer[]>();

export function selectLayersWithoutPrivateEarthwork(
  layers: GeoLibreLayer[],
): GeoLibreLayer[] {
  const cached = safeLayerCache.get(layers);
  if (cached) return cached;
  const filtered = layers.filter((layer) => !isPersistedPrivateEarthwork(layer));
  safeLayerCache.set(layers, filtered);
  return filtered;
}

/** Fail closed before any project snapshot crosses a public/remote boundary. */
export function assertProjectSafeForExternalTransfer(
  project: GeoLibreProject,
): void {
  if (
    containsPersistedPrivateScenegraph(project) ||
    containsPersistedEarthworkAnalysis(project)
  ) {
    throw new Error("PROJECT_PRIVATE_CONTENT_REJECTED");
  }
}
