import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildScenePresetFromProject,
  createProjectFromScenePreset,
  parseScenePresetBytes,
  serializeScenePreset,
  type GeoIm3dScenePresetV1,
} from "../apps/geolibre-desktop/src/lib/scene-preset-contract";
import { createEmptyProject, DEFAULT_LAYER_STYLE, type GeoLibreProject } from "@geolibre/core";

const basePreset = (): GeoIm3dScenePresetV1 => ({
  schema: "geoim3d-scene-preset-v1",
  version: 1,
  kind: "3d-scene-project-template",
  name: "Demo",
  createdBy: "user",
  scene: {
    workspace: "cesium",
    mapGrid: { rows: 1, cols: 1 },
    project: {
      projectName: "Demo project",
      mapView: { center: [10, 20], zoom: 3, bearing: 0, pitch: 15 },
      basemap: { builtInId: "geoim3d-blank-v1", visible: false, opacity: 1 },
      mapPreferences: {
        restrictBounds: false,
        bounds: [-180, -85, 180, 85],
        minZoom: 0,
        maxZoom: 24,
        maxPitch: 85,
        renderWorldCopies: true,
        projection: "globe",
        ellipsoidId: "earth",
        scaleUnit: "metric",
      },
      groups: [],
      layers: [],
    },
  },
});

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function projectWithLayer(): GeoLibreProject {
  const project = createEmptyProject("Portable");
  project.basemapStyleUrl = "";
  project.layers = [{
    id: "original-layer-id",
    name: "Points",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 0.75,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { label: "A" } }],
    },
  }];
  return project;
}

describe("Phase 7E strict scene preset contract", () => {
  it("round-trips canonical bytes and rejects reordered/unknown keys", () => {
    const preset = basePreset();
    const encoded = serializeScenePreset(preset);
    assert.deepEqual(serializeScenePreset(parseScenePresetBytes(encoded)), encoded);
    const originalProject = preset.scene.project;
    const reorderedProject = { ...originalProject } as Record<string, unknown>;
    delete reorderedProject.layers;
    delete reorderedProject.groups;
    reorderedProject.layers = originalProject.layers;
    reorderedProject.groups = originalProject.groups;
    const reordered = { ...preset, scene: { ...preset.scene, project: reorderedProject } };
    assert.throws(() => parseScenePresetBytes(bytes(reordered)), /SCENE_PRESET_INVALID/);
    assert.throws(() => parseScenePresetBytes(bytes({ ...preset, extra: true })), /SCENE_PRESET_INVALID/);
  });

  it("rejects duplicate keys, fatal UTF-8, -0, and unsupported references", () => {
    assert.throws(() => parseScenePresetBytes(new TextEncoder().encode('{"schema":"geoim3d-scene-preset-v1","schema":"geoim3d-scene-preset-v1"}')), /SCENE_PRESET_INVALID/);
    assert.throws(() => parseScenePresetBytes(new Uint8Array([0xc3, 0x28])), /SCENE_PRESET_INVALID/);
    const negativeZero = basePreset();
    assert.throws(() => parseScenePresetBytes(new TextEncoder().encode(JSON.stringify(negativeZero).replace('"zoom":3', '"zoom":-0'))), /SCENE_PRESET_INVALID/);
    const invalid = basePreset();
    invalid.scene.project.layers = [{ kind: "external-scene", id: "layer-1", name: "Model", visible: true, opacity: 1, format: "glb", reference: { type: "https", url: "https://example.test/model.glb?token=secret" } }];
    assert.throws(() => parseScenePresetBytes(bytes(invalid)), /SCENE_PRESET_REFERENCE_INVALID/);
    const relativeTiles = basePreset();
    relativeTiles.scene.project.layers = [{ kind: "external-scene", id: "layer-1", name: "Tiles", visible: true, opacity: 1, format: "3d-tiles", reference: { type: "relative", path: "tiles/tileset.json" } }];
    assert.throws(() => parseScenePresetBytes(bytes(relativeTiles)), /SCENE_PRESET_REFERENCE_INVALID/);
  });

  it("rejects non-canonical bytes, lone surrogates, and hard parser ceilings", () => {
    const canonical = new TextDecoder().decode(serializeScenePreset(basePreset()));
    assert.throws(
      () => parseScenePresetBytes(new TextEncoder().encode(`${canonical}\n`)),
      /SCENE_PRESET_INVALID/,
    );
    assert.throws(
      () => parseScenePresetBytes(new TextEncoder().encode('"\\ud800"')),
      /SCENE_PRESET_INVALID/,
    );
    assert.throws(
      () => parseScenePresetBytes(new Uint8Array(8 * 1024 * 1024 + 1)),
      /SCENE_PRESET_TOO_LARGE/,
    );
    const tooManyContainers = new TextEncoder().encode(
      `{"nodes":[${"{},".repeat(400_000)}{}]}`,
    );
    assert.throws(
      () => parseScenePresetBytes(tooManyContainers),
      /SCENE_PRESET_LIMIT_EXCEEDED/,
    );
  });

  it("rejects credential-bearing GeoJSON properties", () => {
    const preset = buildScenePresetFromProject(projectWithLayer(), "Credential");
    const layer = preset.scene.project.layers[0];
    if (layer?.kind !== "geojson") throw new Error("expected GeoJSON layer");
    layer.data.features[0]!.properties = { apiToken: "secret" };
    assert.throws(
      () => serializeScenePreset(preset),
      /SCENE_PRESET_CREDENTIAL_BLOCKED/,
    );
  });

  it("exports ordinal IDs, preserves allowed data, and imports fresh IDs with group remapping", () => {
    const preset = buildScenePresetFromProject(projectWithLayer(), "Custom");
    assert.equal(preset.scene.project.layers[0]?.id, "layer-1");
    assert.equal(preset.scene.project.basemap.builtInId, "geoim3d-blank-v1");
    const imported = createProjectFromScenePreset(preset);
    assert.notEqual(imported.layers[0]?.id, "layer-1");
    assert.equal(imported.layers[0]?.type, "geojson");
    assert.equal(imported.layers[0]?.geojson?.features.length, 1);

  });

  it("preserves external-scene placement through Project import and export", () => {
    const preset = basePreset();
    const placement = {
      longitude: -100,
      latitude: 40,
      altitudeMeters: 500,
      bearingDegrees: 30,
      scale: 250,
    };
    preset.scene.project.layers = [{
      kind: "external-scene",
      id: "layer-1",
      name: "Placed model",
      visible: true,
      opacity: 1,
      format: "glb",
      reference: { type: "relative", path: "model.glb" },
      placement,
    }];

    const project = createProjectFromScenePreset(preset);
    assert.deepEqual(project.layers[0]?.source.scenePresetPlacement, placement);
    const exported = buildScenePresetFromProject(project, "Placed model");
    const layer = exported.scene.project.layers[0];
    assert.equal(layer?.kind, "external-scene");
    if (layer?.kind !== "external-scene") throw new Error("expected external scene");
    assert.deepEqual(layer.placement, placement);
  });

  it("parses the authoritative 25,000-feature and 250,000-coordinate fixtures", () => {
    const output = join(
      tmpdir(),
      `geoim3d-scene-preset-fixtures-${process.pid}-${Date.now()}`,
    );
    try {
      execFileSync(
        process.execPath,
        [
          "tests/fixtures/generate-scene-preset-memory-fixtures.mjs",
          "--out",
          output,
        ],
        { cwd: process.cwd(), stdio: "pipe" },
      );
      const featurePreset = parseScenePresetBytes(
        readFileSync(
          join(output, "phase7e-feature-25000-v1.geoim3d-preset.json"),
        ),
      );
      const coordinatePreset = parseScenePresetBytes(
        readFileSync(
          join(output, "phase7e-coordinate-250000-v1.geoim3d-preset.json"),
        ),
      );
      const featureLayer = featurePreset.scene.project.layers[0];
      const coordinateLayer = coordinatePreset.scene.project.layers[0];
      if (featureLayer?.kind !== "geojson") {
        throw new Error("feature fixture must contain a GeoJSON layer");
      }
      if (coordinateLayer?.kind !== "geojson") {
        throw new Error("coordinate fixture must contain a GeoJSON layer");
      }
      assert.equal(featureLayer.data.features.length, 25_000);
      const geometry = coordinateLayer.data.features[0]?.geometry;
      if (geometry?.type !== "MultiPoint") {
        throw new Error("coordinate fixture must contain MultiPoint geometry");
      }
      assert.equal(geometry.coordinates.length, 250_000);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
