import { invoke } from "@tauri-apps/api/core";
import { isTauri, pickLocalPathWithFallback } from "./tauri-io";

const FILE_ERROR_CODES = new Set([
  "EARTHWORK_FILE_INVALID",
  "EARTHWORK_FILE_TOO_LARGE",
  "EARTHWORK_FILE_READ_FAILED",
  "EARTHWORK_TIFF_INVALID",
]);

export async function pickAndReadEarthworkGeoTiff(): Promise<ArrayBuffer | null> {
  if (!isTauri()) throw new Error("EARTHWORK_FILE_READ_FAILED");
  const path = await pickLocalPathWithFallback({
    filters: [{ name: "DEM GeoTIFF", extensions: ["tif", "tiff"] }],
  });
  if (!path) return null;
  try {
    const bytes = await invoke<ArrayBuffer>("read_earthwork_geotiff", { path });
    if (!(bytes instanceof ArrayBuffer)) throw new Error("EARTHWORK_FILE_READ_FAILED");
    return bytes;
  } catch (error) {
    const code = typeof error === "string" ? error : "";
    throw new Error(FILE_ERROR_CODES.has(code) ? code : "EARTHWORK_FILE_READ_FAILED");
  }
}
