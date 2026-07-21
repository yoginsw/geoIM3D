#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const GENERATOR_VERSION = "phase7e-memory-fixtures-v1";
const EXPECTED_SHA256 = Object.freeze({
  "phase7e-feature-25000-v1.geoim3d-preset.json":
    "3d380dad92f3509761097de0059025df5d8873591119eb095afcfe4517f0faaf",
  "phase7e-coordinate-250000-v1.geoim3d-preset.json":
    "f03a3fc0f8e8a85b4c46e895d2db70001662599fe8bbfd94cd1840312923f4a5",
});

function basicStyle() {
  return {
    minZoom: 0,
    maxZoom: 24,
    fillColor: "#3b82f6",
    fillOpacity: 0.6,
    strokeColor: "#1e40af",
    strokeWidth: 2,
    strokeWidthUnit: "pixels",
    circleRadius: 6,
    label: {
      enabled: false,
      field: "",
      placement: "point",
      size: 13,
      color: "#111827",
      haloColor: "#ffffff",
      haloWidth: 1.5,
      minZoom: 0,
      maxZoom: 24,
      allowOverlap: false,
    },
    extrusion: {
      enabled: false,
      color: "#3b82f6",
      opacity: 0.8,
      heightProperty: "height",
      heightScale: 1,
      base: 0,
    },
    elevation3d: {
      enabled: false,
      verticalScale: 1,
      offsetMeters: 0,
    },
  };
}

function projectWithData(data) {
  return {
    basemap: {
      id: "geoim3d-blank-v1",
      visible: false,
      opacity: 1,
    },
    mapView: {
      longitude: 127,
      latitude: 37,
      zoom: 8,
      bearing: 0,
      pitch: 0,
      center: [127, 37],
    },
    mapPreferences: {
      projection: "mercator",
      glyphsUrl: "",
      scaleUnits: "metric",
      zoomControls: true,
      maxBounds: null,
      minZoom: 0,
      maxZoom: 22,
    },
    groups: [],
    layers: [
      {
        kind: "geojson",
        id: "layer-1",
        name: "Memory Fixture",
        visible: true,
        opacity: 1,
        style: basicStyle(),
        data,
      },
    ],
  };
}

function preset(id, data) {
  return {
    schema: "geoim3d-scene-preset/v1",
    kind: "geoim3d-scene-project-preset",
    id,
    name: id,
    description: GENERATOR_VERSION,
    createdBy: "user",
    scene: {
      workspaceTab: "cesium",
      mapLayout: { rows: 1, columns: 1 },
      project: projectWithData(data),
    },
  };
}

function featureFixture() {
  const geometry = { type: "Point", coordinates: [0, 0] };
  return preset("phase7e-feature-25000-v1", {
    type: "FeatureCollection",
    features: Array.from({ length: 25_000 }, () => ({
      type: "Feature",
      geometry,
      properties: {},
    })),
  });
}

function coordinateFixture() {
  return preset("phase7e-coordinate-250000-v1", {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "MultiPoint",
          coordinates: Array.from({ length: 250_000 }, () => [0, 0]),
        },
        properties: {},
      },
    ],
  });
}

function render(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const fixtures = [
  ["phase7e-feature-25000-v1.geoim3d-preset.json", featureFixture],
  ["phase7e-coordinate-250000-v1.geoim3d-preset.json", coordinateFixture],
];

const args = process.argv.slice(2);
const verifyOnly = args.length === 1 && args[0] === "--verify";
const outputMode = args.length === 2 && args[0] === "--out" && args[1] !== "";
if (!verifyOnly && !outputMode) {
  throw new Error(
    "usage: generate-scene-preset-memory-fixtures.mjs --verify | --out DIR"
  );
}
const outputDirectory = verifyOnly ? null : resolve(args[1]);
if (outputDirectory) {
  try {
    const metadata = await lstat(outputDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("output must be an empty regular directory");
    }
    if ((await readdir(outputDirectory)).length !== 0) {
      throw new Error("output must be an empty regular directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(outputDirectory, { recursive: true });
    const metadata = await lstat(outputDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("output must be an empty regular directory");
    }
  }
}

for (const [filename, build] of fixtures) {
  const bytes = render(build());
  const digest = sha256(bytes);
  if (digest !== EXPECTED_SHA256[filename]) {
    throw new Error(
      `${filename}: expected ${EXPECTED_SHA256[filename]}, received ${digest}`
    );
  }
  if (outputDirectory)
    await writeFile(resolve(outputDirectory, filename), bytes);
  process.stdout.write(`${filename} ${bytes.byteLength} ${digest}\n`);
}
