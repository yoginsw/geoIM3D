import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject, type GeoLibreProject } from "@geolibre/core";
import {
  createScenePresetApplyCoordinator,
  type ScenePresetPreparedGeneration,
} from "../apps/geolibre-desktop/src/lib/scene-preset-apply-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function prepared(
  name: string,
  disposePending: () => void | Promise<void> = () => {},
): ScenePresetPreparedGeneration {
  return { project: createEmptyProject(name), disposePending };
}

describe("scene preset apply coordinator", () => {
  it("does not publish when preparation fails", async () => {
    let publishes = 0;
    const coordinator = createScenePresetApplyCoordinator<Uint8Array>({
      prepare: async () => {
        throw new Error("SCENE_PRESET_INVALID");
      },
      publish: () => {
        publishes += 1;
        return 1;
      },
      getGeneration: () => 0,
    });

    await assert.rejects(coordinator.apply(new Uint8Array()), /SCENE_PRESET_INVALID/);
    assert.equal(publishes, 0);
  });

  it("publishes only the latest completion and disposes stale pending state", async () => {
    const first = deferred<ScenePresetPreparedGeneration>();
    const second = deferred<ScenePresetPreparedGeneration>();
    let prepareCall = 0;
    let generation = 4;
    const published: GeoLibreProject[] = [];
    let staleDisposals = 0;
    const coordinator = createScenePresetApplyCoordinator<number>({
      prepare: async () => (++prepareCall === 1 ? first.promise : second.promise),
      publish: (project) => {
        published.push(project);
        generation += 1;
        return generation;
      },
      getGeneration: () => generation,
    });

    const oldApply = coordinator.apply(1);
    const newApply = coordinator.apply(2);
    second.resolve(prepared("New"));
    assert.deepEqual(await newApply, { status: "applied", generation: 5 });
    first.resolve(prepared("Old", () => {
      staleDisposals += 1;
    }));
    assert.deepEqual(await oldApply, { status: "stale" });
    assert.equal(staleDisposals, 1);
    assert.deepEqual(published.map((project) => project.name), ["New"]);
  });

  it("disposes prepared state when the single Store publish throws", async () => {
    let disposals = 0;
    const coordinator = createScenePresetApplyCoordinator<string>({
      prepare: async () => prepared("Prepared", () => {
        disposals += 1;
      }),
      publish: () => {
        throw new Error("publish failed");
      },
      getGeneration: () => 12,
    });

    await assert.rejects(coordinator.apply("preset"), /publish failed/);
    assert.equal(disposals, 1);
  });

  it("retires the old generation only after one publish and tolerates cleanup failures", async () => {
    const events: string[] = [];
    let generation = 9;
    const coordinator = createScenePresetApplyCoordinator<string>({
      prepare: async () => ({
        ...prepared("Applied", () => {
          events.push("dispose-pending");
          throw new Error("cleanup failed");
        }),
        retainForGeneration: (value: number) => events.push(`retain:${value}`),
      }),
      publish: () => {
        events.push("publish");
        generation += 1;
        return generation;
      },
      getGeneration: () => generation,
      retireGeneration: async (oldGeneration, newGeneration) => {
        events.push(`retire:${oldGeneration}->${newGeneration}`);
        throw new Error("retire failed");
      },
    });

    assert.deepEqual(await coordinator.apply("preset"), {
      status: "applied",
      generation: 10,
    });
    assert.deepEqual(events, ["publish", "retain:10", "retire:9->10"]);
    coordinator.cancel();
    coordinator.cancel();
  });
});
