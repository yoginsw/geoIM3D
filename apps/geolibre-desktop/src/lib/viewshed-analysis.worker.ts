/// <reference lib="webworker" />

import {
  calculateViewshed,
  type ViewshedBoundary,
  type ViewshedResult,
} from "./viewshed-analysis";
import { decodeViewshedGeoTiff } from "./viewshed-geotiff";
import {
  VIEWSHED_IPC_CLONE_RESERVE_BYTES,
  VIEWSHED_IPC_RESULT_RESERVE_BYTES,
  VIEWSHED_RUNTIME_RESERVE_BYTES,
  ViewshedMemoryLedger,
} from "./viewshed-memory";

interface ViewshedWorkerRequest {
  id: number;
  bytes: ArrayBuffer;
  boundary: ViewshedBoundary;
  observer: [number, number];
  observerHeightMeters: number;
  targetHeightMeters: number;
  maximumRadiusMeters: number;
}

interface ViewshedWorkerResponse {
  id: number;
  ok: boolean;
  result?: ViewshedResult;
  error?: string;
}

const ERROR_CODES = new Set([
  "VIEWSHED_TIFF_INVALID",
  "VIEWSHED_CRS_UNSUPPORTED",
  "VIEWSHED_TRANSFORM_UNSUPPORTED",
  "VIEWSHED_SAMPLE_UNSUPPORTED",
  "VIEWSHED_BOUNDARY_INVALID",
  "VIEWSHED_OBSERVER_INVALID",
  "VIEWSHED_PARAMETER_INVALID",
  "VIEWSHED_LIMIT_EXCEEDED",
  "VIEWSHED_EMPTY_SELECTION",
  "VIEWSHED_EMPTY_EVALUATION",
  "VIEWSHED_NUMERIC_INVALID",
  "VIEWSHED_RESULT_TOO_COMPLEX",
  "VIEWSHED_PROJECT_INVALID",
]);

self.addEventListener(
  "message",
  async (event: MessageEvent<ViewshedWorkerRequest>) => {
    const request = event.data;
    const ledger = new ViewshedMemoryLedger();
    let raster: Awaited<ReturnType<typeof decodeViewshedGeoTiff>> | null = null;
    try {
      raster = await decodeViewshedGeoTiff(request.bytes, ledger);
      request.bytes = new ArrayBuffer(0);
      ledger.release("input");
      ledger.release("parser");
      const result = calculateViewshed(
        {
          raster,
          boundary: request.boundary,
          observer: request.observer,
          observerHeightMeters: request.observerHeightMeters,
          targetHeightMeters: request.targetHeightMeters,
          maximumRadiusMeters: request.maximumRadiusMeters,
        },
        ledger
      );
      raster.values = new Float64Array(0);
      raster = null;
      ledger.reset();
      ledger.reserve("runtime", VIEWSHED_RUNTIME_RESERVE_BYTES);
      ledger.reserve("ipc-result", VIEWSHED_IPC_RESULT_RESERVE_BYTES);
      ledger.reserve("ipc-clone", VIEWSHED_IPC_CLONE_RESERVE_BYTES);
      const response: ViewshedWorkerResponse = {
        id: request.id,
        ok: true,
        result,
      };
      self.postMessage(response);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      ledger.reset();
      ledger.reserve("runtime", VIEWSHED_RUNTIME_RESERVE_BYTES);
      const response: ViewshedWorkerResponse = {
        id: request.id,
        ok: false,
        error: ERROR_CODES.has(code) ? code : "VIEWSHED_INTERNAL",
      };
      self.postMessage(response);
    } finally {
      request.bytes = new ArrayBuffer(0);
      if (raster) raster.values = new Float64Array(0);
      raster = null;
      ledger.reset();
    }
  }
);

export {};
