import assert from "node:assert/strict";
import test from "node:test";
import {
  BLANK_3D_SCENE_PRESET_ID,
  BUILT_IN_SCENE_PRESETS,
  getBuiltInScenePreset,
} from "../apps/geolibre-desktop/src/lib/scene-preset-builtins";
import { serializeScenePreset } from "../apps/geolibre-desktop/src/lib/scene-preset-contract";

test("built-in blank 3D preset has stable identity and canonical blank content", () => {
  assert.deepEqual(
    BUILT_IN_SCENE_PRESETS.map(({ id }) => id),
    ["geoim3d.blank-3d.v1"],
  );
  const preset = getBuiltInScenePreset(BLANK_3D_SCENE_PRESET_ID, "Blank 3D");
  assert.equal(preset.createdBy, "JBT");
  assert.equal(preset.scene.workspace, "cesium");
  assert.equal(preset.scene.project.basemap.builtInId, "geoim3d-blank-v1");
  assert.equal(preset.scene.project.basemap.visible, false);
  assert.deepEqual(preset.scene.project.layers, []);
  assert.doesNotThrow(() => serializeScenePreset(preset));
});

test("unknown built-in preset IDs fail closed", () => {
  assert.throws(
    () => getBuiltInScenePreset("unknown", "Unknown"),
    /SCENE_PRESET_INVALID/,
  );
});
