/// <reference lib="webworker" />

import {
  calculateEarthwork,
  type EarthworkBoundary,
  type EarthworkResult,
} from "./earthwork-analysis";
import { decodeEarthworkGeoTiff } from "./earthwork-geotiff";

interface EarthworkWorkerRequest {
  id: number;
  bytes: ArrayBuffer;
  boundary: EarthworkBoundary;
  designElevationMeters: number;
  verticalDatumConfirmed: boolean;
}

interface EarthworkWorkerSuccess {
  id: number;
  ok: true;
  result: EarthworkResult;
}

interface EarthworkWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

const ERROR_CODES = new Set([
  "EARTHWORK_FILE_INVALID",
  "EARTHWORK_FILE_TOO_LARGE",
  "EARTHWORK_FILE_READ_FAILED",
  "EARTHWORK_TIFF_INVALID",
  "EARTHWORK_CRS_UNSUPPORTED",
  "EARTHWORK_TRANSFORM_UNSUPPORTED",
  "EARTHWORK_SAMPLE_UNSUPPORTED",
  "EARTHWORK_BOUNDARY_INVALID",
  "EARTHWORK_VERTICAL_DATUM_UNCONFIRMED",
  "EARTHWORK_LIMIT_EXCEEDED",
  "EARTHWORK_EMPTY_SELECTION",
  "EARTHWORK_NUMERIC_INVALID",
]);

self.addEventListener("message", async (event: MessageEvent<EarthworkWorkerRequest>) => {
  const request = event.data;
  try {
    const raster = await decodeEarthworkGeoTiff(request.bytes);
    const result = calculateEarthwork({
      raster,
      boundary: request.boundary,
      designElevationMeters: request.designElevationMeters,
      verticalDatumConfirmed: request.verticalDatumConfirmed,
    });
    const response: EarthworkWorkerSuccess = { id: request.id, ok: true, result };
    self.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const response: EarthworkWorkerFailure = {
      id: request.id,
      ok: false,
      error: ERROR_CODES.has(message) ? message : "EARTHWORK_FAILED",
    };
    self.postMessage(response);
  }
});

export {};
