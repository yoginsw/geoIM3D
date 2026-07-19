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

/** Fail closed before any project snapshot crosses a public/remote boundary. */
export function assertProjectSafeForExternalTransfer(
  project: GeoLibreProject,
): void {
  if (containsPersistedPrivateScenegraph(project)) {
    throw new Error("PROJECT_PRIVATE_CONTENT_REJECTED");
  }
}
