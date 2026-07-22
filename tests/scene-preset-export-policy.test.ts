import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject } from "@geolibre/core";
import { assertScenePresetExportPolicy } from "../apps/geolibre-desktop/src/lib/scene-preset-export-policy";

function cleanProject() {
  return createEmptyProject("Preset policy", { basemapStyleUrl: "" });
}

describe("scene preset export fail-closed policy", () => {
  it("accepts a credential-free blank project", () => {
    assert.doesNotThrow(() => assertScenePresetExportPolicy(cleanProject()));
  });

  it("rejects environment values instead of sanitizing them", () => {
    const project = cleanProject();
    project.preferences.environmentVariables = [
      { key: "SAFE_RENDER_OPTION", value: "1", enabled: true },
    ];
    assert.throws(
      () => assertScenePresetExportPolicy(project),
      /SCENE_PRESET_CREDENTIAL_BLOCKED/,
    );
  });

  it("rejects geocoder keys and nested plugin credentials", () => {
    const geocoder = cleanProject();
    geocoder.preferences.geocoding.apiKeys = { mapbox: "secret" };
    assert.throws(
      () => assertScenePresetExportPolicy(geocoder),
      /SCENE_PRESET_CREDENTIAL_BLOCKED/,
    );

    const plugin = cleanProject();
    plugin.plugins = {
      manifestUrls: [],
      activePluginIds: [],
      mapControlPositions: {},
      settings: { example: { clientSecret: "secret" } },
    };
    assert.throws(
      () => assertScenePresetExportPolicy(plugin),
      /SCENE_PRESET_CREDENTIAL_BLOCKED/,
    );
  });

  it("maps private analysis rejection to the preset public code", () => {
    const project = cleanProject();
    project.metadata = { analysisKind: "earthwork-analysis" };
    assert.throws(
      () => assertScenePresetExportPolicy(project),
      /SCENE_PRESET_PRIVATE_CONTENT_BLOCKED/,
    );
  });
});
