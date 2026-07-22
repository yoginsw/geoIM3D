/// <reference lib="webworker" />

import {
  parseScenePresetBytes,
  type GeoIm3dScenePresetV1,
} from "./scene-preset-contract";

export interface ScenePresetWorkerRequest {
  type: "parse";
  nonce: string;
  requestId: number;
  projectGeneration: number;
  bytes: ArrayBuffer;
}

export interface ScenePresetWorkerSuccess {
  type: "parsed";
  nonce: string;
  requestId: number;
  projectGeneration: number;
  preset: GeoIm3dScenePresetV1;
  bytes: ArrayBuffer;
}

export interface ScenePresetWorkerFailure {
  type: "error";
  nonce: string;
  requestId: number;
  projectGeneration: number;
  code:
    | "SCENE_PRESET_INVALID"
    | "SCENE_PRESET_TOO_LARGE"
    | "SCENE_PRESET_LIMIT_EXCEEDED"
    | "SCENE_PRESET_REFERENCE_INVALID"
    | "SCENE_PRESET_CREDENTIAL_BLOCKED"
    | "SCENE_PRESET_PRIVATE_CONTENT_BLOCKED"
    | "SCENE_PRESET_INTERNAL";
}

export type ScenePresetWorkerResponse =
  | ScenePresetWorkerSuccess
  | ScenePresetWorkerFailure;

const ALLOWED_ERRORS = new Set([
  "SCENE_PRESET_INVALID",
  "SCENE_PRESET_TOO_LARGE",
  "SCENE_PRESET_LIMIT_EXCEEDED",
  "SCENE_PRESET_REFERENCE_INVALID",
  "SCENE_PRESET_CREDENTIAL_BLOCKED",
  "SCENE_PRESET_PRIVATE_CONTENT_BLOCKED",
]);

function publicError(error: unknown): ScenePresetWorkerFailure["code"] {
  if (error instanceof Error && ALLOWED_ERRORS.has(error.message)) {
    return error.message as ScenePresetWorkerFailure["code"];
  }
  return "SCENE_PRESET_INTERNAL";
}

self.onmessage = (event: MessageEvent<ScenePresetWorkerRequest>) => {
  const request = event.data;
  if (
    request?.type !== "parse" ||
    typeof request.nonce !== "string" ||
    !Number.isSafeInteger(request.requestId) ||
    !Number.isSafeInteger(request.projectGeneration) ||
    !(request.bytes instanceof ArrayBuffer)
  ) {
    return;
  }

  try {
    const preset = parseScenePresetBytes(request.bytes);
    const response: ScenePresetWorkerSuccess = {
      type: "parsed",
      nonce: request.nonce,
      requestId: request.requestId,
      projectGeneration: request.projectGeneration,
      preset,
      // Return the same transferred backing store. The main thread either
      // accepts this exact response or drops it; no second byte copy is made.
      bytes: request.bytes,
    };
    self.postMessage(response, { transfer: [request.bytes] });
  } catch (error) {
    const response: ScenePresetWorkerFailure = {
      type: "error",
      nonce: request.nonce,
      requestId: request.requestId,
      projectGeneration: request.projectGeneration,
      code: publicError(error),
    };
    self.postMessage(response);
  }
};
