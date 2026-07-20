import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Polygon } from "geojson";
import {
  createEmptyProject,
  parseProject,
  serializeProject,
  undo,
  useAppStore,
} from "../packages/core/src/index";
import {
  EARTHWORK_MAX_INPUT_BYTES,
  EARTHWORK_MAX_PIXELS,
  buildEarthworkLayer,
  calculateEarthwork,
  normalizeEarthworkBoundary,
  transformEarthworkPoint,
  type EarthworkRaster,
} from "../apps/geolibre-desktop/src/lib/earthwork-analysis";
import {
  EARTHWORK_WORKER_PEAK_BUDGET_BYTES,
  decodeEarthworkGeoTiff,
  estimateEarthworkWorkerPeakBytes,
} from "../apps/geolibre-desktop/src/lib/earthwork-geotiff";
import { sanitizeIncomingEarthworkProject } from "../apps/geolibre-desktop/src/lib/earthwork-project";
import {
  assertNoEarthworkPrivateContent,
  assertProjectSafeForExternalTransfer,
  containsPersistedEarthworkAnalysis,
  selectLayersWithoutPrivateEarthwork,
} from "../apps/geolibre-desktop/src/lib/project-private-content";

const CRS = "EPSG:5186" as const;

function projectedRectangle(
  west: number,
  south: number,
  east: number,
  north: number,
  holes: number[][][] = [],
): Polygon {
  const ring = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ].map((point) => transformEarthworkPoint(point, CRS, "EPSG:4326"));
  return {
    type: "Polygon",
    coordinates: [
      ring,
      ...holes.map((hole) =>
        hole.map((point) => transformEarthworkPoint(point, CRS, "EPSG:4326")),
      ),
    ],
  };
}

function sampleRaster(): EarthworkRaster {
  return {
    values: new Float32Array([12, 8, 10, 10]),
    width: 2,
    height: 2,
    tieI: 0,
    tieJ: 0,
    tieX: 200000,
    tieY: 489014.9556910066,
    scaleX: 1,
    scaleY: 1,
    nodata: null,
    sourceCrs: CRS,
  };
}

function sampleGeoTiff(samplesPerPixel = 1): ArrayBuffer {
  const entryCount = 14;
  const ifdOffset = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const scaleOffset = ifdOffset + ifdBytes;
  const tieOffset = scaleOffset + 24;
  const geoKeyOffset = tieOffset + 48;
  const pixelOffset = geoKeyOffset + 32;
  const bytes = new ArrayBuffer(pixelOffset + 16);
  const view = new DataView(bytes);
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);
  let entry = ifdOffset + 2;
  const add = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
    entry += 12;
  };
  add(256, 4, 1, 2); // width
  add(257, 4, 1, 2); // height
  add(258, 3, 1, 32); // bits
  add(259, 3, 1, 1); // uncompressed
  add(262, 3, 1, 1); // black-is-zero
  add(273, 4, 1, pixelOffset); // strip offset
  add(277, 3, 1, samplesPerPixel);
  add(278, 4, 1, 2); // rows per strip
  add(279, 4, 1, 16); // strip bytes
  add(284, 3, 1, 1); // chunky
  add(339, 3, 1, 3); // IEEE float
  add(33550, 12, 3, scaleOffset);
  add(33922, 12, 6, tieOffset);
  add(34735, 3, 16, geoKeyOffset);
  view.setUint32(entry, 0, true); // next IFD
  [1, 1, 0].forEach((value, index) => view.setFloat64(scaleOffset + index * 8, value, true));
  [0, 0, 0, 200000, 489014.9556910066, 0].forEach((value, index) =>
    view.setFloat64(tieOffset + index * 8, value, true),
  );
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 5186];
  geoKeys.forEach((value, index) => view.setUint16(geoKeyOffset + index * 2, value, true));
  [12, 8, 10, 10].forEach((value, index) => view.setFloat32(pixelOffset + index * 4, value, true));
  return bytes;
}

function setIfdShort(bytes: ArrayBuffer, entryIndex: number, value: number): ArrayBuffer {
  new DataView(bytes).setUint16(8 + 2 + entryIndex * 12 + 8, value, true);
  return bytes;
}

function setIfdLong(bytes: ArrayBuffer, entryIndex: number, value: number): ArrayBuffer {
  new DataView(bytes).setUint32(8 + 2 + entryIndex * 12 + 8, value, true);
  return bytes;
}

function setIfdEntry(
  bytes: ArrayBuffer,
  entryIndex: number,
  tag: number,
  type: number,
  count: number,
  value: number,
): ArrayBuffer {
  const view = new DataView(bytes);
  const offset = 8 + 2 + entryIndex * 12;
  view.setUint16(offset, tag, true);
  view.setUint16(offset + 2, type, true);
  view.setUint32(offset + 4, count, true);
  view.setUint32(offset + 8, value, true);
  return bytes;
}

describe("geoIM3D earthwork cut/fill", () => {
  it("fixes bounded input and allocation contracts", () => {
    assert.equal(EARTHWORK_MAX_INPUT_BYTES, 48 * 1024 * 1024);
    assert.equal(EARTHWORK_MAX_PIXELS, 5_000_000);
  });

  it("uses the approved local Korean CRS definitions and x/y axis order", () => {
    const p5179 = transformEarthworkPoint([127, 37], "EPSG:4326", "EPSG:5179");
    const p5186 = transformEarthworkPoint([127, 37], "EPSG:4326", "EPSG:5186");
    assert.ok(Math.abs(p5179[0] - 955511.8092851528) < 1e-6);
    assert.ok(Math.abs(p5179[1] - 1889174.1743467299) < 1e-6);
    assert.ok(Math.abs(p5186[0] - 200000) < 1e-6);
    assert.ok(Math.abs(p5186[1] - 489012.9556910066) < 1e-6);
  });

  it("preflights and decodes an approved single-band uncompressed GeoTIFF", async () => {
    const decoded = await decodeEarthworkGeoTiff(sampleGeoTiff());
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
    assert.equal(decoded.sourceCrs, CRS);
    assert.equal(decoded.scaleX, 1);
    assert.equal(decoded.scaleY, 1);
    assert.deepEqual(Array.from(decoded.values), [12, 8, 10, 10]);
    await assert.rejects(
      () => decodeEarthworkGeoTiff(sampleGeoTiff(2)),
      /EARTHWORK_SAMPLE_UNSUPPORTED/,
    );
  });

  it("rejects palette samples and malformed uncompressed strip layouts", async () => {
    await assert.rejects(
      () => decodeEarthworkGeoTiff(setIfdShort(sampleGeoTiff(), 4, 3)),
      /EARTHWORK_SAMPLE_UNSUPPORTED/,
    );
    await assert.rejects(
      () => decodeEarthworkGeoTiff(setIfdLong(sampleGeoTiff(), 7, 1)),
      /EARTHWORK_TIFF_INVALID/,
    );
    await assert.rejects(
      () => decodeEarthworkGeoTiff(setIfdLong(sampleGeoTiff(), 8, 12)),
      /EARTHWORK_TIFF_INVALID/,
    );
  });

  it("rejects hidden SubIFDs, mask/overview flags, oversized metadata, and huge IFD arrays", async () => {
    await assert.rejects(
      () => decodeEarthworkGeoTiff(setIfdEntry(sampleGeoTiff(), 13, 330, 4, 1, 200)),
      /EARTHWORK_TIFF_INVALID/,
    );
    await assert.rejects(
      () => decodeEarthworkGeoTiff(setIfdEntry(sampleGeoTiff(), 13, 254, 4, 1, 1)),
      /EARTHWORK_TIFF_INVALID/,
    );
    await assert.rejects(
      () => decodeEarthworkGeoTiff(
        setIfdEntry(sampleGeoTiff(), 13, 42112, 2, 1024 * 1024 + 1, 200),
      ),
      /EARTHWORK_LIMIT_EXCEEDED/,
    );
    await assert.rejects(
      () => decodeEarthworkGeoTiff(setIfdEntry(sampleGeoTiff(), 5, 273, 4, 100_001, 200)),
      /EARTHWORK_/,
    );
  });

  it("enforces the explicit 128 MiB worker peak ledger", () => {
    const peak = estimateEarthworkWorkerPeakBytes(
      48 * 1024 * 1024,
      20 * 1024 * 1024,
      8 * 1024 * 1024,
    );
    assert.equal(peak, 116 * 1024 * 1024);
    assert.ok(peak < EARTHWORK_WORKER_PEAK_BUDGET_BYTES);
    assert.throws(
      () => estimateEarthworkWorkerPeakBytes(
        80 * 1024 * 1024,
        20 * 1024 * 1024,
        8 * 1024 * 1024,
      ),
      /EARTHWORK_LIMIT_EXCEEDED/,
    );
  });

  it("calculates deterministic cut/fill/net from PixelIsArea centers", () => {
    const boundary = projectedRectangle(200000.1, 489013.0556910066, 200001.9, 489014.8556910066);
    const result = calculateEarthwork({
      raster: sampleRaster(),
      boundary,
      designElevationMeters: 10,
      verticalDatumConfirmed: true,
    });
    assert.equal(result.summary.includedCells, 4);
    assert.equal(result.summary.includedAreaSquareMeters, 4);
    assert.equal(result.summary.cutCubicMeters, 2);
    assert.equal(result.summary.fillCubicMeters, 2);
    assert.equal(result.summary.netCubicMeters, 0);
    assert.equal(result.summary.sourceCrs, CRS);
  });

  it("rejects an invalid non-NoData elevation outside the selected boundary", () => {
    const raster = sampleRaster();
    raster.values = new Float32Array([12, 8, 10, Number.NaN]);
    const boundary = projectedRectangle(
      200000.25,
      489014.2056910066,
      200000.75,
      489014.7056910066,
    );
    assert.throws(
      () => calculateEarthwork({
        raster,
        boundary,
        designElevationMeters: 10,
        verticalDatumConfirmed: true,
      }),
      /EARTHWORK_SAMPLE_UNSUPPORTED/,
    );
  });

  it("excludes hole interiors before exterior-boundary inclusion", () => {
    const hole = [
      [200000.25, 489014.2056910066],
      [200000.75, 489014.2056910066],
      [200000.75, 489014.7056910066],
      [200000.25, 489014.7056910066],
      [200000.25, 489014.2056910066],
    ];
    const boundary = projectedRectangle(
      200000.1,
      489013.0556910066,
      200001.9,
      489014.8556910066,
      [hole],
    );
    const result = calculateEarthwork({
      raster: sampleRaster(),
      boundary,
      designElevationMeters: 10,
      verticalDatumConfirmed: true,
    });
    assert.equal(result.summary.includedCells, 3);
    assert.equal(result.summary.cutCubicMeters, 0);
    assert.equal(result.summary.fillCubicMeters, 2);
    assert.equal(result.summary.netCubicMeters, -2);
  });

  it("normalizes geometry and rejects unsafe boundaries or datum state", () => {
    const boundary = projectedRectangle(200000.1, 489013.0556910066, 200001.9, 489014.8556910066);
    const normalized = normalizeEarthworkBoundary(boundary);
    assert.equal(normalized.type, "Polygon");
    assert.deepEqual(normalized.coordinates[0][0], normalized.coordinates[0].at(-1));
    assert.throws(
      () => calculateEarthwork({
        raster: sampleRaster(),
        boundary,
        designElevationMeters: 10,
        verticalDatumConfirmed: false,
      }),
      /EARTHWORK_VERTICAL_DATUM_UNCONFIRMED/,
    );
    assert.throws(
      () => normalizeEarthworkBoundary({
        type: "Polygon",
        coordinates: [[[127, 37], [128, 37], [127, 38]]],
      }),
      /EARTHWORK_BOUNDARY_INVALID/,
    );
  });

  it("creates a geometry-only private result DTO", () => {
    const boundary = projectedRectangle(200000.1, 489013.0556910066, 200001.9, 489014.8556910066);
    const result = calculateEarthwork({
      raster: sampleRaster(),
      boundary,
      designElevationMeters: 10,
      verticalDatumConfirmed: true,
    });
    const layer = buildEarthworkLayer(result);
    assert.equal(layer.name, "토공량 분석");
    assert.equal(layer.type, "geojson");
    assert.equal(layer.metadata.customLayerType, "earthwork-analysis");
    assert.deepEqual(layer.geojson?.features[0]?.properties, {});
    assert.deepEqual(layer.source, { type: "geojson" });
    const serialized = JSON.stringify(layer);
    for (const forbidden of ["sourcePath", "nodata", "credential"]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
    }
  });

  it("round-trips only the allowlisted boundary and summary in a local project", () => {
    const result = calculateEarthwork({
      raster: sampleRaster(),
      boundary: projectedRectangle(200000.1, 489013.0556910066, 200001.9, 489014.8556910066),
      designElevationMeters: 10,
      verticalDatumConfirmed: true,
    });
    const project = createEmptyProject("Earthwork");
    project.layers.push(buildEarthworkLayer(result));
    const serialized = serializeProject(project);
    assert.doesNotMatch(serialized, /\.tiff?|sourcePath|StripOffsets|NoData|credential/i);
    const reopened = sanitizeIncomingEarthworkProject(parseProject(serialized));
    assert.deepEqual(reopened.layers[0].metadata.earthworkAnalysis, result.summary);
    assert.throws(
      () => assertProjectSafeForExternalTransfer(reopened),
      /PROJECT_PRIVATE_CONTENT_REJECTED/,
    );
    const tampered = structuredClone(reopened);
    const summary = tampered.layers[0].metadata.earthworkAnalysis as Record<string, unknown>;
    summary.netCubicMeters = 999;
    assert.throws(
      () => sanitizeIncomingEarthworkProject(tampered),
      /EARTHWORK_PROJECT_INVALID/,
    );
  });

  it("detects nested, discriminator-stripped, and serialized Earthwork payloads", () => {
    const project = createEmptyProject("Remote");
    project.metadata = {
      ...project.metadata,
      nested: { payload: { schema: "geoim3d-earthwork-v1" } },
    } as typeof project.metadata;
    assert.throws(
      () => assertProjectSafeForExternalTransfer(project),
      /PROJECT_PRIVATE_CONTENT_REJECTED/,
    );

    const strippedSummary = {
      cutCubicMeters: 2,
      fillCubicMeters: 2,
      netCubicMeters: 0,
      includedCells: 4,
    };
    assert.equal(containsPersistedEarthworkAnalysis({ nested: strippedSummary }), true);
    assert.throws(
      () => assertNoEarthworkPrivateContent(JSON.stringify({ nested: strippedSummary })),
      /EARTHWORK_PRIVATE_CONTENT_BLOCKED/,
    );
    assert.throws(
      () => assertNoEarthworkPrivateContent(JSON.stringify({ nested: {
        schema: "geoim3d-earthwork-v1",
        method: "pixel-center-constant-grade-v1",
        ...strippedSummary,
      } })),
      /EARTHWORK_PRIVATE_CONTENT_BLOCKED/,
    );
  });

  it("blocks Earthwork from external and generic consumer adapters", () => {
    const result = calculateEarthwork({
      raster: sampleRaster(),
      boundary: projectedRectangle(200000.1, 489013.0556910066, 200001.9, 489014.8556910066),
      designElevationMeters: 10,
      verticalDatumConfirmed: true,
    });
    const privateLayer = buildEarthworkLayer(result);
    const safeLayer = { ...privateLayer, id: "safe", metadata: {}, name: "Safe" };
    assert.deepEqual(selectLayersWithoutPrivateEarthwork([safeLayer, privateLayer]), [safeLayer]);

    const guardedSources = [
      "apps/geolibre-desktop/src/lib/assistant/tools.ts",
      "apps/geolibre-desktop/src/lib/scripting/scriptingApi.ts",
      "apps/geolibre-desktop/src/lib/html-export.ts",
      "apps/geolibre-desktop/src/lib/print-layout-export.ts",
    ];
    for (const source of guardedSources) {
      const text = readFileSync(source, "utf8");
      assert.match(text, /assert(NoEarthworkPrivateContent|ProjectSafeForExternalTransfer)|assistantLayers/);
    }
    for (const source of [
      "VectorToolsDialog.tsx",
      "NetworkToolsDialog.tsx",
      "ProcessingDialog.tsx",
      "ModelBuilderDialog.tsx",
      "RasterToolsDialog.tsx",
    ]) {
      assert.match(
        readFileSync(`apps/geolibre-desktop/src/components/processing/${source}`, "utf8"),
        /selectLayersWithoutPrivateEarthwork/,
      );
    }
  });

  it("keeps Earthwork out of undo snapshots while preserving the live layer", () => {
    useAppStore.getState().newProject({ name: "Earthwork history" });
    const result = calculateEarthwork({
      raster: sampleRaster(),
      boundary: projectedRectangle(200000.1, 489013.0556910066, 200001.9, 489014.8556910066),
      designElevationMeters: 10,
      verticalDatumConfirmed: true,
    });
    const privateLayer = buildEarthworkLayer(result);
    useAppStore.getState().addLayer(privateLayer);
    const safeId = useAppStore.getState().addGeoJsonLayer("Safe", {
      type: "FeatureCollection",
      features: [],
    });
    useAppStore.temporal.getState().clear();
    useAppStore.getState().setLayerOpacity(safeId, 0.5);
    const history = useAppStore.temporal.getState().pastStates;
    assert.doesNotMatch(JSON.stringify(history), /geoim3d-earthwork|earthworkAnalysis/i);
    undo();
    assert.ok(useAppStore.getState().layers.some((layer) => layer.id === privateLayer.id));
    useAppStore.getState().newProject({ name: "Cleanup" });
  });
});
