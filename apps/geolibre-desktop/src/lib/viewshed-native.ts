import { invoke } from "@tauri-apps/api/core";
import { VIEWSHED_MAX_INPUT_BYTES } from "./viewshed-analysis";

const COMMAND = "pick_and_read_viewshed_geotiff";
const ALLOWED_CODES = new Set([
  "VIEWSHED_CANCELLED",
  "VIEWSHED_FILE_UNSUPPORTED",
  "VIEWSHED_FILE_TOO_LARGE",
  "VIEWSHED_FILE_CHANGED",
  "VIEWSHED_FILE_UNREADABLE",
  "VIEWSHED_TIFF_INVALID",
  "VIEWSHED_CRS_UNSUPPORTED",
  "VIEWSHED_TRANSFORM_UNSUPPORTED",
  "VIEWSHED_SAMPLE_UNSUPPORTED",
  "VIEWSHED_BOUNDARY_INVALID",
  "VIEWSHED_OBSERVER_INVALID",
  "VIEWSHED_PARAMETER_INVALID",
  "VIEWSHED_LIMIT_EXCEEDED",
  "VIEWSHED_RESULT_TOO_COMPLEX",
  "VIEWSHED_EMPTY_SELECTION",
  "VIEWSHED_EMPTY_EVALUATION",
  "VIEWSHED_NUMERIC_INVALID",
  "VIEWSHED_TIMEOUT",
  "VIEWSHED_PROJECT_INVALID",
  "VIEWSHED_INTERNAL",
]);

function fixedCode(error: unknown): string {
  const value = String(error);
  return ALLOWED_CODES.has(value) ? value : "VIEWSHED_INTERNAL";
}

export async function pickAndReadViewshedGeoTiff(): Promise<ArrayBuffer | null> {
  try {
    const response = await invoke<ArrayBuffer>(COMMAND);
    if (!(response instanceof ArrayBuffer))
      throw new Error("VIEWSHED_INTERNAL");
    if (response.byteLength < 8) throw new Error("VIEWSHED_TIFF_INVALID");
    if (response.byteLength > VIEWSHED_MAX_INPUT_BYTES) {
      throw new Error("VIEWSHED_FILE_TOO_LARGE");
    }
    return response;
  } catch (error) {
    const code = fixedCode(error instanceof Error ? error.message : error);
    if (code === "VIEWSHED_CANCELLED") return null;
    throw new Error(code);
  }
}
