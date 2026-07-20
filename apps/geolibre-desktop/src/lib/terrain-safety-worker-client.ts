import {
  normalizeTerrainSafetyResult,
  type TerrainSafetyBoundary,
  type TerrainSafetyResult,
} from "./terrain-safety-analysis";

export interface TerrainSafetyWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface TerrainSafetyWorkerPort {
  onmessage: ((event: MessageEvent<TerrainSafetyWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface TerrainSafetyWorkerRequest {
  id: number;
  bytes: ArrayBuffer;
  boundary: TerrainSafetyBoundary;
  warningThresholdDegrees: number;
  dangerThresholdDegrees: number;
  verticalDatumConfirmed: true;
}

export interface TerrainSafetyWorkerHandle {
  promise: Promise<TerrainSafetyResult>;
  cancel(code?: string): void;
  isQuiescent(): boolean;
}

const WORKER_ERRORS = new Set([
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

function defaultWorker(): TerrainSafetyWorkerPort {
  return new Worker(
    new URL("./terrain-safety-analysis.worker.ts", import.meta.url),
    { type: "module" },
  );
}

export function runTerrainSafetyWorker(
  request: TerrainSafetyWorkerRequest,
  options: {
    createWorker?: () => TerrainSafetyWorkerPort;
    timeoutMs?: number;
    schedule?: (callback: () => void, delay: number) => TimerHandle;
    clearSchedule?: (timer: TimerHandle) => void;
  } = {},
): TerrainSafetyWorkerHandle {
  const worker = (options.createWorker ?? defaultWorker)();
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const clearSchedule = options.clearSchedule ??
    ((value) => clearTimeout(value as ReturnType<typeof setTimeout>));
  let timer: TimerHandle | null = null;
  let settled = false;
  let resolvePromise!: (result: TerrainSafetyResult) => void;
  let rejectPromise!: (error: Error) => void;

  const promise = new Promise<TerrainSafetyResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const quiesce = () => {
    const activeTimer = timer;
    timer = null;
    worker.onmessage = null;
    worker.onerror = null;
    if (activeTimer !== null) {
      try {
        clearSchedule(activeTimer);
      } catch {
        // Cleanup hooks are untrusted; termination must still run.
      }
    }
    try {
      worker.terminate();
    } catch {
      // Quiescence is best-effort and must never block promise settlement.
    }
  };

  const rejectOnce = (code: string) => {
    if (settled) return;
    settled = true;
    quiesce();
    rejectPromise(new Error(code));
  };

  const resolveOnce = (value: unknown) => {
    if (settled) return;
    try {
      const result = normalizeTerrainSafetyResult(value);
      settled = true;
      quiesce();
      resolvePromise(result);
    } catch {
      rejectOnce("TERRAIN_SAFETY_PROJECT_INVALID");
    }
  };

  worker.onmessage = (event) => {
    if (event.data.id !== request.id) return;
    if (!event.data.ok) {
      rejectOnce(
        WORKER_ERRORS.has(event.data.error ?? "")
          ? event.data.error!
          : "TERRAIN_SAFETY_NUMERIC_INVALID",
      );
      return;
    }
    resolveOnce(event.data.result);
  };
  worker.onerror = () => rejectOnce("TERRAIN_SAFETY_NUMERIC_INVALID");
  try {
    const scheduledTimer = schedule(
      () => rejectOnce("TERRAIN_SAFETY_TIMEOUT"),
      options.timeoutMs ?? 60_000,
    );
    if (settled) {
      try {
        clearSchedule(scheduledTimer);
      } catch {
        // A synchronous scheduler callback may already have quiesced the worker.
      }
    } else {
      timer = scheduledTimer;
      worker.postMessage(request, [request.bytes]);
    }
  } catch {
    rejectOnce("TERRAIN_SAFETY_NUMERIC_INVALID");
  }

  return {
    promise,
    cancel: (code = "TERRAIN_SAFETY_CANCELLED") => rejectOnce(code),
    isQuiescent: () => settled,
  };
}
