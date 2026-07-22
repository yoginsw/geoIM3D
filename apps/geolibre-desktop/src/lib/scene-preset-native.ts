import { invoke } from "@tauri-apps/api/core";

export const SCENE_PRESET_ERROR_CODES = [
  "SCENE_PRESET_CANCELLED",
  "SCENE_PRESET_INVALID",
  "SCENE_PRESET_TOO_LARGE",
  "SCENE_PRESET_PRIVATE_CONTENT_BLOCKED",
  "SCENE_PRESET_CREDENTIAL_BLOCKED",
  "SCENE_PRESET_REFERENCE_INVALID",
  "SCENE_PRESET_REFERENCE_MISSING",
  "SCENE_PRESET_REMOTE_DENIED",
  "SCENE_PRESET_REMOTE_UNAVAILABLE",
  "SCENE_PRESET_SESSION_STALE",
  "SCENE_PRESET_PROJECT_ROOT_MISMATCH",
  "SCENE_PRESET_WRITE_FAILED",
  "SCENE_PRESET_LIMIT_EXCEEDED",
  "SCENE_PRESET_INTERNAL",
] as const;

export type ScenePresetErrorCode = (typeof SCENE_PRESET_ERROR_CODES)[number];
export type ScenePresetInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface ScenePresetImport { importCapability: string; bytes: Uint8Array }
export interface ScenePresetSave { saveCapability: string }
export interface PreparedSceneResource { url: string }

export function scenePresetError(error: unknown): ScenePresetErrorCode {
  const value = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return (SCENE_PRESET_ERROR_CODES as readonly string[]).includes(value)
    ? (value as ScenePresetErrorCode)
    : "SCENE_PRESET_INTERNAL";
}

export function createScenePresetNativeAdapter(call: ScenePresetInvoke = invoke) {
  return {
    async pickAndRead(): Promise<ScenePresetImport> {
      const result = await call<{ importCapability: string; bytes: ArrayBuffer | number[] | Uint8Array }>("pick_and_read_scene_preset");
      const bytes = result.bytes instanceof ArrayBuffer ? new Uint8Array(result.bytes) : new Uint8Array(result.bytes);
      return { importCapability: result.importCapability, bytes };
    },
    pickSaveTarget(): Promise<ScenePresetSave> {
      return call<ScenePresetSave>("pick_scene_preset_save_target");
    },
    write(saveCapability: string, bytes: Uint8Array): Promise<void> {
      return call<void>("write_scene_preset", { saveCapability, bytes: Array.from(bytes) });
    },
    prepareRelativeResource(
      importCapability: string,
      generation: number,
      relativeReference: string,
    ): Promise<PreparedSceneResource> {
      return call<PreparedSceneResource>("prepare_relative_scene_resource", {
        importCapability,
        generation,
        relativeReference,
      });
    },
    close(importCapability: string): Promise<void> {
      return call<void>("close_scene_preset_session", { importCapability });
    },
    toPublicError(error: unknown): ScenePresetErrorCode {
      return scenePresetError(error);
    },
  };
}

export const scenePresetNative = createScenePresetNativeAdapter();
