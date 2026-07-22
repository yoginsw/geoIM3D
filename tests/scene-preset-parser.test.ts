import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createScenePresetParserClient,
  type ScenePresetParserWorkerLike,
} from "../apps/geolibre-desktop/src/lib/scene-preset-parser";
import type { ScenePresetWorkerResponse } from "../apps/geolibre-desktop/src/lib/scene-preset-parser.worker";

class FakeWorker implements ScenePresetParserWorkerLike {
  onmessage: ((event: MessageEvent<ScenePresetWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: { message: unknown; transfer: Transferable[] } | null = null;
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[]) {
    this.posted = { message, transfer };
  }

  terminate() {
    this.terminated = true;
  }

  respond(response: ScenePresetWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<ScenePresetWorkerResponse>);
  }
}

function context(signal = new AbortController().signal) {
  return { requestId: 7, generation: 12, signal };
}

const preset = { schema: "geoim3d-scene-preset-v1" } as never;

describe("scene preset dedicated parser client", () => {
  it("transfers a standalone ArrayBuffer and accepts only the bound response", async () => {
    const worker = new FakeWorker();
    const client = createScenePresetParserClient({
      workerFactory: () => worker,
      nonceFactory: () => "nonce-a",
    });
    const source = new Uint8Array([1, 2, 3]);
    const resultPromise = client.parse(source, context());
    const request = worker.posted?.message as {
      nonce: string;
      requestId: number;
      projectGeneration: number;
      bytes: ArrayBuffer;
    };
    assert.equal(request.nonce, "nonce-a");
    assert.equal(request.requestId, 7);
    assert.equal(request.projectGeneration, 12);
    assert.equal(request.bytes, source.buffer);
    assert.deepEqual(worker.posted?.transfer, [request.bytes]);

    worker.respond({
      type: "parsed",
      nonce: "wrong",
      requestId: 7,
      projectGeneration: 12,
      preset,
      bytes: request.bytes,
    });
    let settled = false;
    void resultPromise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);

    worker.respond({
      type: "parsed",
      nonce: "nonce-a",
      requestId: 7,
      projectGeneration: 12,
      preset,
      bytes: request.bytes,
    });
    assert.equal(await resultPromise, preset);
    assert.equal(worker.terminated, true);
  });

  it("terminates and rejects on abort, and latest parse invalidates the prior worker", async () => {
    const workers: FakeWorker[] = [];
    const client = createScenePresetParserClient({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      nonceFactory: (() => {
        let index = 0;
        return () => `nonce-${++index}`;
      })(),
    });
    const first = client.parse(new Uint8Array([1]), context());
    assert.equal(workers.length, 1);
    const second = client.parse(new Uint8Array([2]), context());
    assert.equal(workers[0].terminated, true);
    await assert.rejects(first, { name: "AbortError" });

    const controller = new AbortController();
    const third = client.parse(new Uint8Array([3]), context(controller.signal));
    controller.abort();
    assert.equal(workers[2].terminated, true);
    await assert.rejects(third, { name: "AbortError" });
    client.cancel();
    await assert.rejects(second, { name: "AbortError" });
  });

  it("does not create a Worker for an already-aborted request", async () => {
    let workers = 0;
    const client = createScenePresetParserClient({
      workerFactory: () => {
        workers += 1;
        return new FakeWorker();
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client.parse(new Uint8Array([1]), context(controller.signal)),
      { name: "AbortError" },
    );
    assert.equal(workers, 0);
  });

  it("preserves allowlisted parser errors and redacts unknown Worker errors", async () => {
    const workers: FakeWorker[] = [];
    const client = createScenePresetParserClient({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      nonceFactory: () => "nonce-errors",
    });

    const blocked = client.parse(new Uint8Array([1]), context());
    workers[0].respond({
      type: "error",
      nonce: "nonce-errors",
      requestId: 7,
      projectGeneration: 12,
      code: "SCENE_PRESET_CREDENTIAL_BLOCKED",
    });
    await assert.rejects(blocked, { message: "SCENE_PRESET_CREDENTIAL_BLOCKED" });

    const unknown = client.parse(new Uint8Array([2]), context());
    workers[1].respond({
      type: "error",
      nonce: "nonce-errors",
      requestId: 7,
      projectGeneration: 12,
      code: "SCENE_PRESET_INTERNAL",
    });
    await assert.rejects(unknown, { message: "SCENE_PRESET_INTERNAL" });
  });

  it("copies only a sub-view so unrelated backing bytes are not transferred", () => {
    const worker = new FakeWorker();
    const client = createScenePresetParserClient({
      workerFactory: () => worker,
      nonceFactory: () => "nonce-subview",
    });
    const backing = new Uint8Array([9, 1, 2, 9]);
    const pending = client.parse(backing.subarray(1, 3), context());
    const request = worker.posted?.message as { bytes: ArrayBuffer };
    assert.notEqual(request.bytes, backing.buffer);
    assert.deepEqual(Array.from(new Uint8Array(request.bytes)), [1, 2]);
    client.cancel();
    return assert.rejects(pending, { name: "AbortError" });
  });
});
