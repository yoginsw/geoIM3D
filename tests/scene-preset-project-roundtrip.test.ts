import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyProject,
  parseProject,
  serializeProject,
} from "../packages/core/src/project";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
} from "../packages/core/src/types";
import { buildScenePresetFromProject } from "../apps/geolibre-desktop/src/lib/scene-preset-contract";

function activeRelativeModel(): GeoLibreLayer {
  return {
    id: "model-1",
    name: "Portable model",
    type: "gaussian-splat",
    source: {
      referenceType: "relative",
      reference: "models/model.glb",
      format: "glb",
      assetType: "model",
      url: "http://geoim3d-preset-resource.localhost/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/7",
      scenePresetStatus: "active",
      scenePresetPlacement: {
        longitude: -100,
        latitude: 40,
        altitudeMeters: 10,
        bearingDegrees: 0,
        scale: 2,
      },
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      scenePresetExternal: true,
      scenePresetStatus: "active",
    },
  } as GeoLibreLayer;
}

test("active relative model persists canonically and exports after reopen", () => {
  const project = createEmptyProject("Round-trip");
  project.layers = [activeRelativeModel()];

  const serialized = serializeProject(project);
  assert.equal(serialized.includes("geoim3d-preset-resource.localhost"), false);
  assert.equal(serialized.includes("models/model.glb"), true);

  const reopened = parseProject(serialized);
  assert.equal(reopened.layers[0].source.reference, "models/model.glb");
  assert.equal(reopened.layers[0].source.referenceType, "relative");
  assert.equal("url" in reopened.layers[0].source, false);
  assert.equal(reopened.layers[0].source.scenePresetStatus, "unresolved");

  const exported = buildScenePresetFromProject(reopened);
  const layer = exported.scene.project.layers[0];
  assert.equal(layer.kind, "external-scene");
  if (layer.kind !== "external-scene") throw new Error("unexpected layer");
  assert.deepEqual(layer.reference, {
    type: "relative",
    path: "models/model.glb",
  });
  assert.deepEqual(layer.placement, {
    longitude: -100,
    latitude: 40,
    altitudeMeters: 10,
    bearingDegrees: 0,
    scale: 2,
  });
});
