import assert from "node:assert/strict";
import test from "node:test";
import {
  createScenePresetNativeAdapter,
  scenePresetError,
} from "../apps/geolibre-desktop/src/lib/scene-preset-native";

test("native scene preset adapter uses only dedicated opaque transport commands", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const adapter = createScenePresetNativeAdapter(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "pick_and_read_scene_preset") return { importCapability: "import-opaque", bytes: new Uint8Array([1, 2]) } as T;
    if (command === "pick_scene_preset_save_target") return { saveCapability: "save-opaque" } as T;
    if (command === "prepare_relative_scene_resource") {
      return { url: "http://geoim3d-preset-resource.localhost/v1/opaque" } as T;
    }
    return undefined as T;
  });

  const imported = await adapter.pickAndRead();
  assert.deepEqual(Array.from(imported.bytes), [1, 2]);
  assert.equal(imported.importCapability, "import-opaque");
  assert.deepEqual(await adapter.pickSaveTarget(), { saveCapability: "save-opaque" });
  await adapter.write("save-opaque", new Uint8Array([3, 4]));
  assert.deepEqual(
    await adapter.prepareRelativeResource("import-opaque", 7, "models/model.glb"),
    { url: "http://geoim3d-preset-resource.localhost/v1/opaque" },
  );
  await adapter.close("import-opaque");
  assert.deepEqual(calls.map(({ command }) => command), [
    "pick_and_read_scene_preset",
    "pick_scene_preset_save_target",
    "write_scene_preset",
    "prepare_relative_scene_resource",
    "close_scene_preset_session",
  ]);
  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes("C:\\\\"), false);
  assert.equal(serialized.includes("/Users/"), false);
});

test("adapter maps only allowlisted public errors and redacts unknowns", () => {
  assert.equal(scenePresetError("SCENE_PRESET_TOO_LARGE"), "SCENE_PRESET_TOO_LARGE");
  assert.equal(scenePresetError("C:\\Users\\private\\secret.geoim3d-preset.json"), "SCENE_PRESET_INTERNAL");
  assert.equal(scenePresetError(new Error("SCENE_PRESET_WRITE_FAILED")), "SCENE_PRESET_WRITE_FAILED");
});
