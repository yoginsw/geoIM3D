import type { GeoIm3dScenePresetV1 } from "./scene-preset-contract";
import type {
  ScenePresetWorkerRequest,
  ScenePresetWorkerResponse,
} from "./scene-preset-parser.worker";

export interface ScenePresetParserContext {
  requestId: number;
  generation: number;
  signal: AbortSignal;
}

export interface ScenePresetParserWorkerLike {
  onmessage: ((event: MessageEvent<ScenePresetWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ScenePresetWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface ScenePresetParserClientOptions {
  workerFactory?: () => ScenePresetParserWorkerLike;
  nonceFactory?: () => string;
  timeoutMs?: number;
}

export interface ScenePresetParserClient {
  parse(
    input: ArrayBuffer | Uint8Array,
    context: ScenePresetParserContext,
  ): Promise<GeoIm3dScenePresetV1>;
  cancel(): void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("SCENE_PRESET_INTERNAL");
  }
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortError(): DOMException {
  return new DOMException("Scene preset parser request aborted.", "AbortError");
}

function workerError(code: string): Error {
  return new Error(
    code === "SCENE_PRESET_INVALID" ||
      code === "SCENE_PRESET_TOO_LARGE" ||
      code === "SCENE_PRESET_LIMIT_EXCEEDED" ||
      code === "SCENE_PRESET_REFERENCE_INVALID" ||
      code === "SCENE_PRESET_CREDENTIAL_BLOCKED" ||
      code === "SCENE_PRESET_PRIVATE_CONTENT_BLOCKED"
      ? code
      : "SCENE_PRESET_INTERNAL",
  );
}

export function createScenePresetParserClient(
  options: ScenePresetParserClientOptions = {},
): ScenePresetParserClient {
  const workerFactory =
    options.workerFactory ??
    (() =>
      new Worker(
        new URL("./scene-preset-parser.worker.ts", import.meta.url),
        { type: "module", name: "geoim3d-scene-preset-parser" },
      ));
  const nonceFactory = options.nonceFactory ?? makeNonce;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let activeCancel: (() => void) | null = null;

  const cancel = () => {
    activeCancel?.();
    activeCancel = null;
  };

  const parse = (
    input: ArrayBuffer | Uint8Array,
    context: ScenePresetParserContext,
  ): Promise<GeoIm3dScenePresetV1> => {
    cancel();
    if (context.signal.aborted) return Promise.reject(abortError());
    const worker = workerFactory();
    // Transfer an already-standalone backing store without a duplicate copy.
    // A sub-view is copied only when its buffer contains unrelated bytes.
    const bytes =
      input instanceof Uint8Array
        ? input.byteOffset === 0 &&
          input.buffer instanceof ArrayBuffer &&
          input.byteLength === input.buffer.byteLength
          ? input.buffer
          : input.slice().buffer
        : input;
    const expectedByteLength = bytes.byteLength;
    const nonce = nonceFactory();
    const request: ScenePresetWorkerRequest = {
      type: "parse",
      nonce,
      requestId: context.requestId,
      projectGeneration: context.generation,
      bytes,
    };

    return new Promise<GeoIm3dScenePresetV1>((resolve, reject) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => finishReject(new Error("SCENE_PRESET_INTERNAL")), timeoutMs);

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
        worker.onmessage = null;
        worker.onerror = null;
        activeCancel = null;
        try {
          worker.terminate();
        } catch {
          // Termination is best-effort; the request is already terminal.
        }
        callback();
      };
      const finishReject = (error: unknown) => finish(() => reject(error));
      const onAbort = () => finishReject(abortError());

      worker.onmessage = (event) => {
        const response = event.data;
        if (
          response.nonce !== nonce ||
          response.requestId !== context.requestId ||
          response.projectGeneration !== context.generation
        ) {
          return;
        }
        if (response.type === "error") {
          finishReject(workerError(response.code));
          return;
        }
        if (
          !(response.bytes instanceof ArrayBuffer) ||
          response.bytes.byteLength !== expectedByteLength
        ) {
          finishReject(new Error("SCENE_PRESET_INTERNAL"));
          return;
        }
        // Accessing the returned buffer is part of the ownership handoff. The
        // parser result is the only value retained by this client.
        finish(() => resolve(response.preset));
      };
      worker.onerror = () => finishReject(new Error("SCENE_PRESET_INTERNAL"));
      context.signal.addEventListener("abort", onAbort, { once: true });
      activeCancel = onAbort;
      try {
        worker.postMessage(request, [bytes]);
      } catch (error) {
        finishReject(new Error("SCENE_PRESET_INTERNAL"));
      }
    });
  };

  return { parse, cancel };
}
