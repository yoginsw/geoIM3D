import {
  normalizeViewshedResult,
  type ViewshedBoundary,
  type ViewshedResult,
} from "./viewshed-analysis";

export interface ViewshedWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ViewshedWorkerPort {
  onmessage: ((event: MessageEvent<ViewshedWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface ViewshedWorkerRequest {
  id: number;
  bytes: ArrayBuffer;
  boundary: ViewshedBoundary;
  observer: [number, number];
  observerHeightMeters: number;
  targetHeightMeters: number;
  maximumRadiusMeters: number;
}

export interface ViewshedWorkerHandle {
  promise: Promise<ViewshedResult>;
  cancel(code?: string): void;
  isQuiescent(): boolean;
}

const WORKER_ERRORS = new Set([
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
  "VIEWSHED_INTERNAL",
]);

function defaultWorker(): ViewshedWorkerPort {
  return new Worker(new URL("./viewshed-analysis.worker.ts", import.meta.url), {
    type: "module",
  });
}

export function runViewshedWorker(
  request: ViewshedWorkerRequest,
  options: {
    createWorker?: () => ViewshedWorkerPort;
    timeoutMs?: number;
    schedule?: (callback: () => void, delay: number) => TimerHandle;
    clearSchedule?: (timer: TimerHandle) => void;
  } = {}
): ViewshedWorkerHandle {
  const schedule =
    options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const clearSchedule =
    options.clearSchedule ??
    ((value) => clearTimeout(value as ReturnType<typeof setTimeout>));
  let worker: ViewshedWorkerPort | null = null;
  let timer: TimerHandle | null = null;
  let settled = false;
  let resolvePromise!: (result: ViewshedResult) => void;
  let rejectPromise!: (error: Error) => void;

  const promise = new Promise<ViewshedResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const quiesce = () => {
    const activeWorker = worker;
    const activeTimer = timer;
    worker = null;
    timer = null;
    if (activeWorker) {
      try {
        activeWorker.onmessage = null;
      } catch {
        /* continue cleanup */
      }
      try {
        activeWorker.onerror = null;
      } catch {
        /* continue cleanup */
      }
    }
    if (activeTimer !== null) {
      try {
        clearSchedule(activeTimer);
      } catch {
        /* continue cleanup */
      }
    }
    if (activeWorker) {
      try {
        activeWorker.terminate();
      } catch {
        /* settlement must continue */
      }
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
      const result = normalizeViewshedResult(value);
      settled = true;
      quiesce();
      resolvePromise(result);
    } catch {
      rejectOnce("VIEWSHED_PROJECT_INVALID");
    }
  };

  try {
    worker = (options.createWorker ?? defaultWorker)();
    const activeWorker = worker;
    activeWorker.onmessage = (event) => {
      if (event.data.id !== request.id) return;
      if (!event.data.ok) {
        rejectOnce(
          WORKER_ERRORS.has(event.data.error ?? "")
            ? event.data.error!
            : "VIEWSHED_INTERNAL"
        );
        return;
      }
      resolveOnce(event.data.result);
    };
    activeWorker.onerror = () => rejectOnce("VIEWSHED_INTERNAL");
    const scheduledTimer = schedule(
      () => rejectOnce("VIEWSHED_TIMEOUT"),
      options.timeoutMs ?? 60_000
    );
    if (settled) {
      try {
        clearSchedule(scheduledTimer);
      } catch {
        /* already quiesced */
      }
    } else {
      timer = scheduledTimer;
      activeWorker.postMessage(request, [request.bytes]);
    }
  } catch {
    rejectOnce("VIEWSHED_INTERNAL");
  }

  return {
    promise,
    cancel: (code = "VIEWSHED_CANCELLED") => rejectOnce(code),
    isQuiescent: () => settled,
  };
}
