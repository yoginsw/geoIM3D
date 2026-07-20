/// <reference lib="webworker" />

import {
  calculateTerrainSafety,
  type TerrainSafetyBoundary,
  type TerrainSafetyResult,
} from "./terrain-safety-analysis";
import { decodeTerrainSafetyGeoTiff } from "./terrain-safety-geotiff";

interface TerrainSafetyWorkerRequest {
  id: number;
  bytes: ArrayBuffer;
  boundary: TerrainSafetyBoundary;
  warningThresholdDegrees: number;
  dangerThresholdDegrees: number;
  verticalDatumConfirmed: boolean;
}

interface TerrainSafetyWorkerResponse {
  id: number;
  ok: boolean;
  result?: TerrainSafetyResult;
  error?: string;
}

const ERROR_CODES = new Set([
  "TERRAIN_SAFETY_TIFF_INVALID",
  "TERRAIN_SAFETY_CRS_UNSUPPORTED",
  "TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED",
  "TERRAIN_SAFETY_SAMPLE_UNSUPPORTED",
  "TERRAIN_SAFETY_BOUNDARY_INVALID",
  "TERRAIN_SAFETY_VERTICAL_DATUM_UNCONFIRMED",
  "TERRAIN_SAFETY_LIMIT_EXCEEDED",
  "TERRAIN_SAFETY_EMPTY_SELECTION",
  "TERRAIN_SAFETY_EMPTY_EVALUATION",
  "TERRAIN_SAFETY_NUMERIC_INVALID",
]);

self.addEventListener("message", async (event: MessageEvent<TerrainSafetyWorkerRequest>) => {
  const request = event.data;
  try {
    const raster = await decodeTerrainSafetyGeoTiff(request.bytes);
    const result = calculateTerrainSafety({
      raster,
      boundary: request.boundary,
      warningThresholdDegrees: request.warningThresholdDegrees,
      dangerThresholdDegrees: request.dangerThresholdDegrees,
      verticalDatumConfirmed: request.verticalDatumConfirmed,
    });
    const response: TerrainSafetyWorkerResponse = {
      id: request.id,
      ok: true,
      result,
    };
    self.postMessage(response);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const response: TerrainSafetyWorkerResponse = {
      id: request.id,
      ok: false,
      error: ERROR_CODES.has(code) ? code : "TERRAIN_SAFETY_NUMERIC_INVALID",
    };
    self.postMessage(response);
  }
});

export {};
