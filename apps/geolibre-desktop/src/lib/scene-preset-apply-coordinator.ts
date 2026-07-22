import type { GeoLibreProject } from "@geolibre/core";

export interface ScenePresetPreparedGeneration {
  project: GeoLibreProject;
  /** Releases resources that have not been published into the active generation. */
  disposePending: () => void | Promise<void>;
  /** Transfers prepared resources into generation ownership after publication. */
  retainForGeneration?: (generation: number) => void;
}

export interface ScenePresetPrepareContext {
  requestId: number;
  generation: number;
  signal: AbortSignal;
}

export type ScenePresetApplyResult =
  | { status: "applied"; generation: number }
  | { status: "stale" };

export interface ScenePresetApplyDependencies<TInput> {
  prepare: (
    input: TInput,
    context: ScenePresetPrepareContext,
  ) => Promise<ScenePresetPreparedGeneration>;
  /** Must perform the one Store publication and return its resulting generation. */
  publish: (project: GeoLibreProject) => number;
  getGeneration: () => number;
  /** Called only after publication; failures are isolated from the active project. */
  retireGeneration?: (
    oldGeneration: number,
    newGeneration: number,
  ) => void | Promise<void>;
}

export interface ScenePresetApplyCoordinator<TInput> {
  apply: (input: TInput) => Promise<ScenePresetApplyResult>;
  cancel: () => void;
}

async function disposePendingSafely(
  prepared: ScenePresetPreparedGeneration,
): Promise<void> {
  try {
    await prepared.disposePending();
  } catch {
    // Cleanup is best-effort and must never mutate or invalidate the active Store.
  }
}

/**
 * Coordinates preset preparation outside the Store and one latest-wins publish.
 * Starting or cancelling another request invalidates all older completions.
 */
export function createScenePresetApplyCoordinator<TInput>(
  dependencies: ScenePresetApplyDependencies<TInput>,
): ScenePresetApplyCoordinator<TInput> {
  let requestId = 0;
  let activeAbort: AbortController | null = null;

  const cancel = () => {
    requestId += 1;
    activeAbort?.abort();
    activeAbort = null;
  };

  const apply = async (input: TInput): Promise<ScenePresetApplyResult> => {
    activeAbort?.abort();
    const ownRequestId = ++requestId;
    const abort = new AbortController();
    activeAbort = abort;
    const initialGeneration = dependencies.getGeneration();

    let prepared: ScenePresetPreparedGeneration;
    try {
      prepared = await dependencies.prepare(input, {
        requestId: ownRequestId,
        generation: initialGeneration,
        signal: abort.signal,
      });
    } catch (error) {
      if (ownRequestId !== requestId || abort.signal.aborted) {
        return { status: "stale" };
      }
      activeAbort = null;
      throw error;
    }

    if (
      ownRequestId !== requestId ||
      abort.signal.aborted ||
      dependencies.getGeneration() !== initialGeneration
    ) {
      await disposePendingSafely(prepared);
      return { status: "stale" };
    }

    let nextGeneration: number;
    try {
      nextGeneration = dependencies.publish(prepared.project);
    } catch (error) {
      activeAbort = null;
      await disposePendingSafely(prepared);
      throw error;
    }
    activeAbort = null;
    prepared.retainForGeneration?.(nextGeneration);

    // Retirement is deliberately post-publish and independently failure-isolated.
    if (dependencies.retireGeneration) {
      try {
        await dependencies.retireGeneration(initialGeneration, nextGeneration);
      } catch {
        // The new active generation remains valid even when old cleanup fails.
      }
    }

    return { status: "applied", generation: nextGeneration };
  };

  return { apply, cancel };
}
