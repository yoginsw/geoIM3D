import type { GeoLibreProject, RecentProjectEntry } from "@geolibre/core";
import {
  isCanonicalProjectFileName,
  isCanonicalProjectReference,
  isLegacyProjectFileName,
} from "./file-names";

export type ProjectDropClassification =
  | { kind: "project"; reference: string }
  | { kind: "invalid-project"; reason: "legacy" | "mixed" }
  | { kind: "data" };

/**
 * Route a file drop before the existing vector/raster import pipeline.
 * A project open is intentionally atomic: exactly one canonical project and no
 * data files. Legacy project names are rejected pending an explicit migration
 * decision rather than being interpreted as generic JSON data.
 */
export function classifyProjectDrop(
  references: readonly string[],
): ProjectDropClassification {
  if (references.some(isLegacyProjectFileName)) {
    return { kind: "invalid-project", reason: "legacy" };
  }

  const projects = references.filter(isCanonicalProjectFileName);
  if (projects.length === 0) return { kind: "data" };
  if (projects.length !== 1 || references.length !== 1) {
    return { kind: "invalid-project", reason: "mixed" };
  }
  return { kind: "project", reference: projects[0] };
}

/**
 * Produce a project payload that may leave the application boundary.
 * Runtime environment values can contain API keys and remain in the live store,
 * but they are never persisted or transmitted inside a portable project.
 */
export function preparePortableProject(
  project: GeoLibreProject,
): GeoLibreProject {
  return {
    ...project,
    preferences: {
      ...project.preferences,
      environmentVariables: [],
    },
  };
}

/** Backward-compatible file-save name for the shared portable boundary. */
export const prepareProjectForFileSave = preparePortableProject;

/** Remove persisted entries that the current product contract cannot reopen. */
export function filterCanonicalRecentProjects(
  entries: readonly RecentProjectEntry[],
): RecentProjectEntry[] {
  return entries.filter((entry) => isCanonicalProjectReference(entry.path));
}
