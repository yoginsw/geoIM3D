import type { GeoLibreProject } from "@geolibre/core";
import { assertNoPrivateAnalysisContent } from "./project-private-content";

const CREDENTIAL_ERROR = "SCENE_PRESET_CREDENTIAL_BLOCKED";
const SENSITIVE_KEY =
  /(?:api.?key|access.?token|auth(?:orization)?|client.?secret|connection.?string|cookie|credential|password|private.?key|secret|session.?token|token)/i;

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function assertNoCredentialFields(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (value == null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && hasMeaningfulValue(child)) {
      throw new Error(CREDENTIAL_ERROR);
    }
    assertNoCredentialFields(child, seen);
  }
}

/**
 * Preset export is stricter than a normal local project save: forbidden data is
 * rejected rather than silently stripped from the resulting template.
 */
export function assertScenePresetExportPolicy(project: GeoLibreProject): void {
  try {
    assertNoPrivateAnalysisContent(project);
  } catch {
    throw new Error("SCENE_PRESET_PRIVATE_CONTENT_BLOCKED");
  }

  if (project.preferences.environmentVariables.length > 0) {
    throw new Error(CREDENTIAL_ERROR);
  }
  if (
    Object.values(project.preferences.geocoding.apiKeys).some(
      (value) => value.trim() !== "",
    )
  ) {
    throw new Error(CREDENTIAL_ERROR);
  }

  assertNoCredentialFields(project.plugins?.settings);
  assertNoCredentialFields(project.metadata);
  for (const layer of project.layers) {
    assertNoCredentialFields(layer.source);
    assertNoCredentialFields(layer.metadata);
  }
}
