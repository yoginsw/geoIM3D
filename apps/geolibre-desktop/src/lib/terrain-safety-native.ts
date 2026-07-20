import { invoke } from "@tauri-apps/api/core";
import { TERRAIN_SAFETY_MAX_INPUT_BYTES } from "./terrain-safety-analysis";

const COMMAND = "pick_and_read_terrain_safety_geotiff";
const ALLOWED_CODES = new Set([
  "TERRAIN_SAFETY_PICK_CANCELLED",
  "TERRAIN_SAFETY_FILE_INVALID",
  "TERRAIN_SAFETY_FILE_TOO_LARGE",
  "TERRAIN_SAFETY_FILE_READ_FAILED",
  "TERRAIN_SAFETY_TIFF_INVALID",
]);

function fixedCode(error: unknown): string {
  const value = String(error);
  return ALLOWED_CODES.has(value) ? value : "TERRAIN_SAFETY_FILE_READ_FAILED";
}

export async function pickAndReadTerrainSafetyGeoTiff(): Promise<ArrayBuffer | null> {
  try {
    const response = await invoke<ArrayBuffer>(COMMAND);
    if (!(response instanceof ArrayBuffer)) throw new Error("TERRAIN_SAFETY_FILE_READ_FAILED");
    if (response.byteLength < 8) throw new Error("TERRAIN_SAFETY_TIFF_INVALID");
    if (response.byteLength > TERRAIN_SAFETY_MAX_INPUT_BYTES) {
      throw new Error("TERRAIN_SAFETY_FILE_TOO_LARGE");
    }
    return response;
  } catch (error) {
    const code = fixedCode(error instanceof Error ? error.message : error);
    if (code === "TERRAIN_SAFETY_PICK_CANCELLED") return null;
    throw new Error(code);
  }
}
