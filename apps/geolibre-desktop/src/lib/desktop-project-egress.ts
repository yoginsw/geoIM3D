import type { GeoLibreProject } from "@geolibre/core";
import { assertNoPrivateAnalysisContent } from "./project-private-content";

export async function sanitizeDesktopProjectForLocalSave(
  project: GeoLibreProject
): Promise<GeoLibreProject> {
  if (
    typeof __WINDOWS_TAURI_BUILD__ === "undefined" ||
    !__WINDOWS_TAURI_BUILD__
  ) {
    assertNoPrivateAnalysisContent(project);
    return project;
  }
  const { sanitizeIncomingTerrainSafetyProject } = await import(
    "./terrain-safety-project"
  );
  const terrainSanitized = sanitizeIncomingTerrainSafetyProject(project);
  const { sanitizeViewshedProjectForLocalSave } = await import(
    "./viewshed-project"
  );
  return sanitizeViewshedProjectForLocalSave(terrainSanitized);
}
