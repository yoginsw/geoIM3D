import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  createEmptyProject,
  parseProject,
  serializeProject,
} from "../packages/core/src/index";
import {
  SUPPORTED_CAD_CRS,
  alignCadFeatureCollection,
  applySimilarityTransform,
  createCoordinateAlignmentMetadata,
  solveSimilarityTransform,
} from "../apps/geolibre-desktop/src/lib/cad-coordinate-alignment";

const pointCollection = (coordinates: number[]): FeatureCollection => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { layer: "CAD" },
      geometry: { type: "Point", coordinates },
    },
  ],
});

describe("CAD/GIS coordinate alignment", () => {
  it("exposes only the approved offline CRS allowlist", () => {
    assert.deepEqual(SUPPORTED_CAD_CRS, [
      "EPSG:4326",
      "EPSG:3857",
      "EPSG:5179",
      "EPSG:5186",
    ]);
  });

  it("solves translation, rotation, and uniform scale from two point pairs", () => {
    const transform = solveSimilarityTransform(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [100, 200],
        [100, 220],
      ],
    );

    assert.ok(Math.abs(transform.scale - 2) < 1e-12);
    assert.ok(Math.abs(transform.rotationDegrees - 90) < 1e-12);
    const transformed = applySimilarityTransform([3, 4, 7], transform);
    assert.ok(Math.abs(transformed[0] - 92) < 1e-12);
    assert.ok(Math.abs(transformed[1] - 206) < 1e-12);
    assert.equal(transformed[2], 7);
    assert.ok(transform.rmsError < 1e-9);
  });

  it("reprojects Web Mercator input to WGS84 and preserves Z", () => {
    const result = alignCadFeatureCollection(pointCollection([0, 0, 35]), {
      sourceCrs: "EPSG:3857",
      method: "crs",
    });
    const point = result.geojson.features[0]?.geometry;
    assert.equal(point?.type, "Point");
    if (point?.type !== "Point") throw new Error("Point expected");
    assert.ok(Math.abs(point.coordinates[0]) < 1e-12);
    assert.ok(Math.abs(point.coordinates[1]) < 1e-12);
    assert.equal(point.coordinates[2], 35);
    assert.equal(result.summary.featureCount, 1);
  });

  it("aligns in the source planar CRS before WGS84 output", () => {
    const result = alignCadFeatureCollection(pointCollection([3, 4, 9]), {
      sourceCrs: "EPSG:3857",
      method: "similarity-2-point",
      sourceControlPoints: [
        [0, 0],
        [10, 0],
      ],
      targetControlPointsWgs84: [
        [0.0008983152841195213, 0.0017966305679446145],
        [0.0008983152841195213, 0.001976293624421148],
      ],
    });
    const point = result.geojson.features[0]?.geometry;
    if (point?.type !== "Point") throw new Error("Point expected");
    assert.ok(Math.abs(point.coordinates[0] - 0.000826450061498033) < 1e-9);
    assert.ok(Math.abs(point.coordinates[1] - 0.001850529485) < 1e-9);
    assert.equal(point.coordinates[2], 9);
    assert.ok(Math.abs(result.summary.scale - 2) < 1e-8);
  });

  it("rejects duplicate control points, unsupported CRS, and excessive features", () => {
    assert.throws(
      () =>
        solveSimilarityTransform(
          [
            [1, 1],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
          ],
        ),
      /distinct/i,
    );
    assert.throws(
      () =>
        alignCadFeatureCollection(pointCollection([0, 0]), {
          sourceCrs: "EPSG:9999" as "EPSG:4326",
          method: "crs",
        }),
      /unsupported CRS/i,
    );
    const oversized: FeatureCollection = {
      type: "FeatureCollection",
      features: Array.from({ length: 50_001 }, (_, index) => ({
        type: "Feature",
        properties: { index },
        geometry: { type: "Point", coordinates: [index, index] },
      })),
    };
    assert.throws(
      () =>
        alignCadFeatureCollection(oversized, {
          sourceCrs: "EPSG:4326",
          method: "crs",
        }),
      /50,000-feature limit/i,
    );
  });

  it("rejects out-of-range WGS84 source geometry and target control points", () => {
    for (const coordinates of [
      [181, 0],
      [-181, 0],
      [0, 91],
      [0, -91],
    ]) {
      assert.throws(
        () =>
          alignCadFeatureCollection(pointCollection(coordinates), {
            sourceCrs: "EPSG:4326",
            method: "crs",
          }),
        /WGS84 range/i,
      );
    }

    assert.throws(
      () =>
        alignCadFeatureCollection(pointCollection([0, 0]), {
          sourceCrs: "EPSG:3857",
          method: "similarity-2-point",
          sourceControlPoints: [
            [0, 0],
            [10, 0],
          ],
          targetControlPointsWgs84: [
            [181, 0],
            [181.0001, 0],
          ],
        }),
      /WGS84 range/i,
    );

    assert.doesNotThrow(() =>
      alignCadFeatureCollection(pointCollection([180, 90, 4]), {
        sourceCrs: "EPSG:4326",
        method: "crs",
      }),
    );
  });

  it("keeps the CAD endpoint out of the shared Web processing entry", () => {
    const processingIndex = readFileSync(
      new URL("../packages/processing/src/index.ts", import.meta.url),
      "utf8",
    );
    const sharedClient = readFileSync(
      new URL("../packages/processing/src/sidecar-client.ts", import.meta.url),
      "utf8",
    );
    const sharedDesktopSidecar = readFileSync(
      new URL(
        "../apps/geolibre-desktop/src/lib/sidecar.ts",
        import.meta.url,
      ),
      "utf8",
    );
    assert.doesNotMatch(processingIndex, /runCadReadDxf|CadReadDxfRequest/);
    assert.doesNotMatch(sharedClient, /conversion\/cad\/read-dxf|runCadReadDxf/);
    assert.doesNotMatch(sharedDesktopSidecar, /conversion\/cad\/read-dxf|runCadReadDxf/);
  });

  it("cancels the active backend job when the dialog closes", () => {
    const dialogSource = readFileSync(
      new URL(
        "../apps/geolibre-desktop/src/components/processing/CadCoordinateAlignmentDialog.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const clientSource = readFileSync(
      new URL("../packages/processing/src/sidecar-client.ts", import.meta.url),
      "utf8",
    );
    assert.match(clientSource, /export async function cancelConversionJob/);
    assert.match(dialogSource, /activeJobIdRef/);
    assert.match(dialogSource, /cancelConversionJob\(jobId\)/);
  });

  it("rebuilds renderer features as geometry-only DTOs", () => {
    const input = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "source-entity-1",
          geometry: { type: "Point", coordinates: [127, 37, 5] },
          properties: { layer: "secret-source-layer" },
          source_path: "C:\\private\\site.dxf",
        },
      ],
    } as never;

    const result = alignCadFeatureCollection(input, {
      sourceCrs: "EPSG:4326",
      method: "crs",
    });
    assert.deepEqual(Object.keys(result.geojson.features[0]).sort(), [
      "geometry",
      "properties",
      "type",
    ]);
    assert.deepEqual(result.geojson.features[0].properties, {});
    assert.equal("id" in result.geojson.features[0], false);
    assert.equal("source_path" in result.geojson.features[0], false);
  });

  it("creates only the approved non-sensitive project metadata", () => {
    const metadata = createCoordinateAlignmentMetadata({
      sourceCrs: "EPSG:5186",
      method: "similarity-2-point",
      scale: 1.0002,
      rotationDegrees: 0.25,
      rmsErrorMeters: 0.01,
      sourcePath: "C:\\secret\\site.dxf",
      sourceControlPoints: [[1, 2], [3, 4]],
    });
    assert.deepEqual(metadata, {
      sourceFormat: "DXF",
      sourceCrs: "EPSG:5186",
      method: "similarity-2-point",
      scale: 1.0002,
      rotationDegrees: 0.25,
      rmsErrorMeters: 0.01,
    });
    assert.doesNotMatch(JSON.stringify(metadata), /secret|sourcePath|ControlPoints/i);
  });

  it("round-trips aligned data and summary without an original file path", () => {
    const project = createEmptyProject("CAD alignment");
    project.layers.push({
      id: "aligned-cad",
      name: "site 정합",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {
        coordinateAlignment: createCoordinateAlignmentMetadata({
          sourceCrs: "EPSG:5186",
          method: "crs",
          scale: 1,
          rotationDegrees: 0,
          rmsErrorMeters: 0,
        }),
      },
      geojson: pointCollection([127, 37.5, 5]),
    });

    const serialized = serializeProject(project);
    const restored = parseProject(serialized);
    assert.deepEqual(restored.layers[0]?.geojson, project.layers[0]?.geojson);
    assert.deepEqual(
      restored.layers[0]?.metadata.coordinateAlignment,
      project.layers[0]?.metadata.coordinateAlignment,
    );
    assert.doesNotMatch(serialized, /[A-Z]:\\|sourcePath|sourceControlPoints/i);
  });
});
