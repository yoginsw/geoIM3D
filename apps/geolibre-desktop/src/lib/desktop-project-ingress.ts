import type { GeoLibreProject } from "@geolibre/core";
import { assertProjectSafeForExternalTransfer } from "./project-private-content";

export type DesktopProjectIngressSource = "local" | "remote";

/**
 * Central compile-time desktop project ingress gate.
 *
 * The dynamic module is absent from Web/PWA builds because __TAURI_BUILD__ is
 * replaced with false. Remote URL/embed/collaboration payloads cannot carry
 * persisted scenegraphs; private IFC/GLB content stays local-file-only.
 */
export async function sanitizeIncomingDesktopProject(
  project: GeoLibreProject,
  source: DesktopProjectIngressSource,
): Promise<GeoLibreProject> {
  if (source === "remote" || !__TAURI_BUILD__) {
    assertProjectSafeForExternalTransfer(project);
  }
  if (!__TAURI_BUILD__) return project;
  const { sanitizeIncomingIfcProject } = await import("./ifc-project");
  const ifcSanitized = sanitizeIncomingIfcProject(project);
  const { sanitizeIncomingEarthworkProject } = await import("./earthwork-project");
  return sanitizeIncomingEarthworkProject(ifcSanitized);
}
