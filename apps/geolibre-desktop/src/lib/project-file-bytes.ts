import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { containsPersistedViewshedAnalysis } from "./project-private-content";

export const MAX_LOCAL_PROJECT_BYTES = 8 * 1024 * 1024;

/** Bounded fatal UTF-8 decoder with strict raw Viewshed DTO reconstruction. */
export async function parseBoundedLocalProjectBytes(
  bytes: ArrayBuffer
): Promise<GeoLibreProject> {
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength > MAX_LOCAL_PROJECT_BYTES
  ) {
    throw new Error("PROJECT_FILE_TOO_LARGE");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("PROJECT_FILE_INVALID");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("PROJECT_FILE_INVALID");
  }
  if (containsPersistedViewshedAnalysis(raw)) {
    if (
      typeof __WINDOWS_TAURI_BUILD__ === "undefined" ||
      !__WINDOWS_TAURI_BUILD__
    ) {
      throw new Error("PROJECT_PRIVATE_CONTENT_REJECTED");
    }
    const { parseCanonicalViewshedProjectDto } = await import(
      "./viewshed-project"
    );
    return parseCanonicalViewshedProjectDto(raw);
  }
  return parseProject(text);
}
