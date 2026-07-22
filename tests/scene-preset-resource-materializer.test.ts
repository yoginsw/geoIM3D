import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreProject } from "../packages/core/src/types";
import type { GeoIm3dScenePresetV1 } from "../apps/geolibre-desktop/src/lib/scene-preset-contract";
import { materializeRelativeSceneResources } from "../apps/geolibre-desktop/src/lib/scene-preset-resource-materializer";

function preset(format: "glb" | "3d-tiles" = "glb"): GeoIm3dScenePresetV1 {
  return {
    scene: {
      project: {
        layers: [
          {
            kind: "external-scene",
            format,
            reference: { type: "relative", path: "models/model.glb" },
          },
        ],
      },
    },
  } as unknown as GeoIm3dScenePresetV1;
}

function project(): GeoLibreProject {
  return {
    layers: [
      {
        id: "layer",
        name: "model",
        type: "gaussian-splat",
        source: {
          reference: "models/model.glb",
          referenceType: "relative",
          format: "glb",
          scenePresetStatus: "unresolved",
        },
        visible: true,
        opacity: 1,
        style: {},
        metadata: {
          scenePresetExternal: true,
          scenePresetStatus: "unresolved",
          scenePresetError: "SCENE_PRESET_REMOTE_UNAVAILABLE",
        },
      },
    ],
  } as unknown as GeoLibreProject;
}

test("materializes relative GLB while retaining its canonical portable reference", async () => {
  const pending = project();
  const calls: unknown[][] = [];
  const needed = await materializeRelativeSceneResources(preset(), pending, {
    importCapability: "import-opaque",
    generation: 12,
    signal: new AbortController().signal,
    native: {
      async prepareRelativeResource(...args) {
        calls.push(args);
        return {
          url: "http://geoim3d-preset-resource.localhost/v1/aaaaaaaa/bbbbbbbb/12",
        };
      },
    },
  });
  assert.equal(needed, true);
  assert.deepEqual(calls, [["import-opaque", 12, "models/model.glb"]]);
  assert.equal(pending.layers[0].source.scenePresetStatus, "active");
  assert.equal(pending.layers[0].source.assetType, "model");
  assert.equal(pending.layers[0].source.reference, "models/model.glb");
  assert.equal(pending.layers[0].source.referenceType, "relative");
  assert.equal("scenePresetError" in pending.layers[0].metadata, false);
  assert.equal(JSON.stringify(pending).includes("models/model.glb"), true);
});

test("rejects relative 3D Tiles before native materialization", async () => {
  let called = false;
  await assert.rejects(
    materializeRelativeSceneResources(preset("3d-tiles"), project(), {
      importCapability: "import-opaque",
      generation: 12,
      signal: new AbortController().signal,
      native: {
        async prepareRelativeResource() {
          called = true;
          return { url: "unused" };
        },
      },
    }),
    /SCENE_PRESET_REFERENCE_INVALID/,
  );
  assert.equal(called, false);
});

test("fails closed on HTTPS before native materialization while TLS adapter is unavailable", async () => {
  const remote = preset();
  const layer = remote.scene.project.layers[0];
  if (layer.kind !== "external-scene") throw new Error("invalid fixture");
  layer.reference = { type: "https", url: "https://assets.example.test/model.glb" };
  let called = false;
  await assert.rejects(
    materializeRelativeSceneResources(remote, project(), {
      generation: 12,
      signal: new AbortController().signal,
      native: {
        async prepareRelativeResource() {
          called = true;
          return { url: "unused" };
        },
      },
    }),
    /SCENE_PRESET_REMOTE_UNAVAILABLE/,
  );
  assert.equal(called, false);
});

test("rejects a completion that is aborted during native preparation", async () => {
  const abort = new AbortController();
  const pending = project();
  await assert.rejects(
    materializeRelativeSceneResources(preset(), pending, {
      importCapability: "import-opaque",
      generation: 12,
      signal: abort.signal,
      native: {
        async prepareRelativeResource() {
          abort.abort();
          return { url: "http://geoim3d-preset-resource.localhost/v1/stale" };
        },
      },
    }),
    /SCENE_PRESET_SESSION_STALE/,
  );
  assert.equal(pending.layers[0].source.scenePresetStatus, "unresolved");
});
