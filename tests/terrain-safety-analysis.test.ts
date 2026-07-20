import assert from "node:assert/strict";
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
  TERRAIN_SAFETY_MAX_INPUT_BYTES,
  TERRAIN_SAFETY_METHOD,
  TERRAIN_SAFETY_SCHEMA,
  buildTerrainSafetyLayer,
  calculateTerrainSafety,
  normalizeTerrainSafetyBoundary,
  normalizeTerrainSafetyResult,
  projectTerrainSafetyBoundary,
  transformTerrainSafetyPoint,
  type TerrainSafetyRaster,
} from "../apps/geolibre-desktop/src/lib/terrain-safety-analysis";
import {
  assertNoPrivateAnalysisContent,
  assertProjectSafeForExternalTransfer,
  containsPersistedTerrainSafetyAnalysis,
  selectLayersWithoutPrivateEarthwork,
} from "../apps/geolibre-desktop/src/lib/project-private-content";

import { sanitizeIncomingTerrainSafetyProject } from "../apps/geolibre-desktop/src/lib/terrain-safety-project";
import { prepareProjectForFileSave } from "../apps/geolibre-desktop/src/lib/project-file-contract";
import {
  runTerrainSafetyWorker,
  type TerrainSafetyWorkerPort,
} from "../apps/geolibre-desktop/src/lib/terrain-safety-worker-client";
import {
  TERRAIN_SAFETY_WORKER_PEAK_BUDGET_BYTES,
  decodeTerrainSafetyGeoTiff,
  estimateTerrainSafetyWorkerPeakBytes,
} from "../apps/geolibre-desktop/src/lib/terrain-safety-geotiff";

const CRS = "EPSG:5186" as const;

function projectedRectangle(
  west: number,
  south: number,
  east: number,
  north: number,
  holes: number[][][] = [],
  crs: "EPSG:5179" | "EPSG:5186" = CRS,
): Polygon {
  const ring = [
    [west, south], [east, south], [east, north], [west, north], [west, south],
  ].map((point) => transformTerrainSafetyPoint(point, crs, "EPSG:4326"));
  return {
    type: "Polygon",
    coordinates: [
      ring,
      ...holes.map((hole) =>
        hole.map((point) => transformTerrainSafetyPoint(point, crs, "EPSG:4326"))),
    ],
  };
}

function rasterFromPlane(
  width: number,
  height: number,
  value: (row: number, col: number) => number,
): TerrainSafetyRaster {
  const values = new Float64Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) values[row * width + col] = value(row, col);
  }
  return {
    values,
    width,
    height,
    tieI: 0,
    tieJ: 0,
    tieX: 200000,
    tieY: 489012.9556910066 + height,
    scaleX: 1,
    scaleY: 1,
    nodata: null,
    sourceCrs: CRS,
  };
}

function fullBoundary(raster: TerrainSafetyRaster): Polygon {
  const west = raster.tieX + (0 - raster.tieI) * raster.scaleX;
  const east = raster.tieX + (raster.width - raster.tieI) * raster.scaleX;
  const north = raster.tieY - (0 - raster.tieJ) * raster.scaleY;
  const south = raster.tieY - (raster.height - raster.tieJ) * raster.scaleY;
  return projectedRectangle(
    Math.min(west, east) + raster.scaleX * 0.1,
    Math.min(south, north) + raster.scaleY * 0.1,
    Math.max(west, east) - raster.scaleX * 0.1,
    Math.max(south, north) - raster.scaleY * 0.1,
  );
}

function run(raster: TerrainSafetyRaster, warning = 15, danger = 30) {
  return calculateTerrainSafety({
    raster,
    boundary: fullBoundary(raster),
    warningThresholdDegrees: warning,
    dangerThresholdDegrees: danger,
    verticalDatumConfirmed: true,
  });
}

function sampleTerrainGeoTiff(samplesPerPixel = 1): ArrayBuffer {
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
  add(256, 4, 1, 2);
  add(257, 4, 1, 2);
  add(258, 3, 1, 32);
  add(259, 3, 1, 1);
  add(262, 3, 1, 1);
  add(273, 4, 1, pixelOffset);
  add(277, 3, 1, samplesPerPixel);
  add(278, 4, 1, 2);
  add(279, 4, 1, 16);
  add(284, 3, 1, 1);
  add(339, 3, 1, 3);
  add(33550, 12, 3, scaleOffset);
  add(33922, 12, 6, tieOffset);
  add(34735, 3, 16, geoKeyOffset);
  view.setUint32(entry, 0, true);
  [1, 1, 0].forEach((value, index) => view.setFloat64(scaleOffset + index * 8, value, true));
  [0, 0, 0, 200000, 489014.9556910066, 0].forEach((value, index) =>
    view.setFloat64(tieOffset + index * 8, value, true),
  );
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 5186];
  geoKeys.forEach((value, index) => view.setUint16(geoKeyOffset + index * 2, value, true));
  [12, 8, 10, 10].forEach((value, index) =>
    view.setFloat32(pixelOffset + index * 4, value, true),
  );
  return bytes;
}

function sampleTerrainIntegerGeoTiff(
  bits: 8 | 16 | 32,
  sampleFormat: 1 | 2,
): { bytes: ArrayBuffer; expected: number[] } {
  const bytes = sampleTerrainGeoTiff();
  const view = new DataView(bytes);
  const entryOffset = (index: number) => 8 + 2 + index * 12 + 8;
  view.setUint16(entryOffset(2), bits, true);
  view.setUint16(entryOffset(10), sampleFormat, true);
  view.setUint32(entryOffset(8), 4 * (bits / 8), true);
  const pixelOffset = view.getUint32(entryOffset(5), true);
  const expected = sampleFormat === 1 ? [1, 2, 3, 4] : [-1, 2, -3, 4];
  expected.forEach((value, index) => {
    const offset = pixelOffset + index * (bits / 8);
    if (sampleFormat === 1 && bits === 8) view.setUint8(offset, value);
    else if (sampleFormat === 2 && bits === 8) view.setInt8(offset, value);
    else if (sampleFormat === 1 && bits === 16) view.setUint16(offset, value, true);
    else if (sampleFormat === 2 && bits === 16) view.setInt16(offset, value, true);
    else if (sampleFormat === 1) view.setUint32(offset, value, true);
    else view.setInt32(offset, value, true);
  });
  return { bytes, expected };
}

function sampleTerrainMultiStripGeoTiff(): ArrayBuffer {
  const entryCount = 14;
  const ifdOffset = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const scaleOffset = ifdOffset + ifdBytes;
  const tieOffset = scaleOffset + 24;
  const geoKeyOffset = tieOffset + 48;
  const stripOffsetsOffset = geoKeyOffset + 32;
  const stripCountsOffset = stripOffsetsOffset + 8;
  const pixelOffset = stripCountsOffset + 8;
  const bytes = new ArrayBuffer(pixelOffset + 24);
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
  add(256, 4, 1, 2);
  add(257, 4, 1, 3);
  add(258, 3, 1, 32);
  add(259, 3, 1, 1);
  add(262, 3, 1, 1);
  add(273, 4, 2, stripOffsetsOffset);
  add(277, 3, 1, 1);
  add(278, 4, 1, 2);
  add(279, 4, 2, stripCountsOffset);
  add(284, 3, 1, 1);
  add(339, 3, 1, 3);
  add(33550, 12, 3, scaleOffset);
  add(33922, 12, 6, tieOffset);
  add(34735, 3, 16, geoKeyOffset);
  view.setUint32(entry, 0, true);
  [1, 1, 0].forEach((value, index) => view.setFloat64(scaleOffset + index * 8, value, true));
  [0, 0, 0, 200000, 489015.9556910066, 0].forEach((value, index) =>
    view.setFloat64(tieOffset + index * 8, value, true),
  );
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 5186];
  geoKeys.forEach((value, index) => view.setUint16(geoKeyOffset + index * 2, value, true));
  view.setUint32(stripOffsetsOffset, pixelOffset, true);
  view.setUint32(stripOffsetsOffset + 4, pixelOffset + 16, true);
  view.setUint32(stripCountsOffset, 16, true);
  view.setUint32(stripCountsOffset + 4, 8, true);
  [1, 2, 3, 4, 5, 6].forEach((value, index) =>
    view.setFloat32(pixelOffset + index * 4, value, true),
  );
  return bytes;
}

function sampleTerrainBigEndianGeoTiff(): ArrayBuffer {
  const entryCount = 14;
  const ifdOffset = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const scaleOffset = ifdOffset + ifdBytes;
  const tieOffset = scaleOffset + 24;
  const geoKeyOffset = tieOffset + 48;
  const pixelOffset = geoKeyOffset + 32;
  const bytes = new ArrayBuffer(pixelOffset + 16);
  const view = new DataView(bytes);
  view.setUint8(0, 0x4d);
  view.setUint8(1, 0x4d);
  view.setUint16(2, 42, false);
  view.setUint32(4, ifdOffset, false);
  view.setUint16(ifdOffset, entryCount, false);
  let entry = ifdOffset + 2;
  const add = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(entry, tag, false);
    view.setUint16(entry + 2, type, false);
    view.setUint32(entry + 4, count, false);
    if (type === 3 && count === 1) view.setUint16(entry + 8, value, false);
    else view.setUint32(entry + 8, value, false);
    entry += 12;
  };
  add(256, 4, 1, 2);
  add(257, 4, 1, 2);
  add(258, 3, 1, 32);
  add(259, 3, 1, 1);
  add(262, 3, 1, 1);
  add(273, 4, 1, pixelOffset);
  add(277, 3, 1, 1);
  add(278, 4, 1, 2);
  add(279, 4, 1, 16);
  add(284, 3, 1, 1);
  add(339, 3, 1, 3);
  add(33550, 12, 3, scaleOffset);
  add(33922, 12, 6, tieOffset);
  add(34735, 3, 16, geoKeyOffset);
  view.setUint32(entry, 0, false);
  [1, 1, 0].forEach((value, index) => view.setFloat64(scaleOffset + index * 8, value, false));
  [0, 0, 0, 200000, 489014.9556910066, 0].forEach((value, index) =>
    view.setFloat64(tieOffset + index * 8, value, false),
  );
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 5186];
  geoKeys.forEach((value, index) => view.setUint16(geoKeyOffset + index * 2, value, false));
  [12, 8, 10, 10].forEach((value, index) =>
    view.setFloat32(pixelOffset + index * 4, value, false),
  );
  return bytes;
}

function setTerrainIfdEntry(
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

class FakeTerrainWorker implements TerrainSafetyWorkerPort {
  onmessage: TerrainSafetyWorkerPort["onmessage"] = null;
  onerror: TerrainSafetyWorkerPort["onerror"] = null;
  terminateCount = 0;
  posted: { message: unknown; transfer: Transferable[] } | null = null;
  throwOnPost = false;

  postMessage(message: unknown, transfer: Transferable[]): void {
    if (this.throwOnPost) throw new DOMException("clone", "DataCloneError");
    this.posted = { message, transfer };
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

describe("geoIM3D terrain slope/safety", () => {
  it("preserves sub-1e-8 WGS84 coordinates without implicit quantization", () => {
    const geometry = normalizeTerrainSafetyBoundary({
      type: "Polygon",
      coordinates: [[
        [0, 0], [4e-9, 0], [4e-9, 1], [0, 1], [0, 0],
      ]],
    });
    assert.equal(geometry.coordinates[0][1][0], 4e-9);
  });

  it("rejects out-of-contract raster tiepoints and derived pixel centers", () => {
    const boundary = fullBoundary(rasterFromPlane(5, 5, () => 7));
    const oversizedTie = rasterFromPlane(5, 5, () => 7);
    oversizedTie.tieX = 10_000_001;
    assert.throws(() => calculateTerrainSafety({
      raster: oversizedTie,
      boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    }), /TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED/);
    const oversizedCenter = rasterFromPlane(5, 5, () => 7);
    oversizedCenter.tieX = 9_999_999;
    assert.throws(() => calculateTerrainSafety({
      raster: oversizedCenter,
      boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    }), /TERRAIN_SAFETY_LIMIT_EXCEEDED/);
  });

  it("computes Horn 3x3 zero slope and classifies only interior cells", () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    assert.equal(result.summary.aoiCandidateCells, 25);
    assert.equal(result.summary.evaluatedCells, 9);
    assert.equal(result.summary.unknownCells, 16);
    assert.equal(result.summary.safeCells, 9);
    assert.equal(result.summary.warningCells, 0);
    assert.equal(result.summary.dangerCells, 0);
    assert.equal(result.summary.minSlopeDegrees, 0);
    assert.equal(result.summary.maxSlopeDegrees, 0);
    assert.equal(result.summary.meanSlopeDegrees, 0);
    assert.equal(result.summary.safeAreaSquareMeters, 9);
    assert.equal(result.summary.unknownAreaSquareMeters, 16);
  });

  it("accepts a partially overlapping AOI and rejects only a disjoint selection", () => {
    const raster = rasterFromPlane(5, 5, () => 7);
    const partial = calculateTerrainSafety({
      raster,
      boundary: projectedRectangle(199998, 489014, 200003, 489020),
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    });
    assert.ok(partial.summary.aoiCandidateCells > 0);
    assert.throws(
      () => calculateTerrainSafety({
        raster,
        boundary: projectedRectangle(210000, 500000, 210010, 500010),
        warningThresholdDegrees: 15,
        dangerThresholdDegrees: 30,
        verticalDatumConfirmed: true,
      }),
      /TERRAIN_SAFETY_EMPTY_SELECTION/,
    );
  });

  it("supports EPSG:5179 with the approved x/y axis order", () => {
    const raster = rasterFromPlane(5, 5, (_row, col) => col);
    raster.sourceCrs = "EPSG:5179";
    raster.tieX = 955500;
    raster.tieY = 1889180;
    const result = calculateTerrainSafety({
      raster,
      boundary: projectedRectangle(
        955500.1,
        1889175.1,
        955504.9,
        1889179.9,
        [],
        "EPSG:5179",
      ),
      warningThresholdDegrees: 44,
      dangerThresholdDegrees: 60,
      verticalDatumConfirmed: true,
    });
    assert.ok(Math.abs(result.summary.meanSlopeDegrees - 45) < 1e-10);
    assert.equal(result.summary.warningCells, 9);
  });

  it("adaptively densifies long RFC 7946 edges before projected containment", () => {
    const raster: TerrainSafetyRaster = {
      values: new Float32Array(0),
      width: 1000,
      height: 1000,
      tieI: 0,
      tieJ: 0,
      tieX: 150000,
      tieY: 550000,
      scaleX: 100,
      scaleY: 100,
      nodata: null,
      sourceCrs: CRS,
    };
    const boundary = projectedRectangle(150100, 450100, 249900, 549900);
    const projected = projectTerrainSafetyBoundary(boundary, raster);
    assert.ok(projected[0][0].length > 5);
    assert.ok(projected[0][0].length <= 200_000);
  });

  it("excludes hole interiors and boundaries before exterior inclusion", () => {
    const raster = rasterFromPlane(7, 7, () => 7);
    const south = raster.tieY - raster.height;
    const boundary = projectedRectangle(
      raster.tieX + 0.1,
      south + 0.1,
      raster.tieX + raster.width - 0.1,
      raster.tieY - 0.1,
      [[
        [200003, 489015.9],
        [200004, 489015.9],
        [200004, 489017],
        [200003, 489017],
        [200003, 489015.9],
      ]],
    );
    const result = calculateTerrainSafety({
      raster,
      boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    });
    assert.equal(result.summary.aoiCandidateCells, 48);
  });

  it("counts disjoint MultiPolygon components once and rejects touching components", () => {
    const raster = rasterFromPlane(9, 5, () => 7);
    const south = raster.tieY - raster.height;
    const left = projectedRectangle(200000.1, south + 0.1, 200002.9, raster.tieY - 0.1);
    const right = projectedRectangle(200006.1, south + 0.1, 200008.9, raster.tieY - 0.1);
    const boundary = {
      type: "MultiPolygon" as const,
      coordinates: [left.coordinates, right.coordinates],
    };
    const result = calculateTerrainSafety({
      raster,
      boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    });
    assert.equal(result.summary.aoiCandidateCells, 30);

    const touchingLeft = projectedRectangle(200000.1, south + 0.1, 200004, raster.tieY - 0.1);
    const touchingRight = projectedRectangle(200004, south + 0.1, 200008.9, raster.tieY - 0.1);
    assert.throws(
      () => calculateTerrainSafety({
        raster,
        boundary: {
          type: "MultiPolygon",
          coordinates: [touchingLeft.coordinates, touchingRight.coordinates],
        },
        warningThresholdDegrees: 15,
        dangerThresholdDegrees: 30,
        verticalDatumConfirmed: true,
      }),
      /TERRAIN_SAFETY_BOUNDARY_INVALID/,
    );
  });

  it("keeps NoData exact and produces deterministic repeated Kahan summaries", () => {
    const raster = rasterFromPlane(7, 7, (row, col) => row * 0.000001 + col * 1000);
    raster.nodata = -9999;
    (raster.values as Float64Array)[0] = -9999;
    const first = run(raster, 10, 80).summary;
    const second = run(raster, 10, 80).summary;
    assert.deepEqual(second, first);
    const allNoData = rasterFromPlane(5, 5, () => -9999);
    allNoData.nodata = -9999;
    assert.throws(() => run(allNoData), /TERRAIN_SAFETY_EMPTY_EVALUATION/);
  });

  it("matches analytic east/west/north/south planes", () => {
    const planes = [
      (row: number, col: number) => col,
      (row: number, col: number) => -col,
      (row: number) => row,
      (row: number) => -row,
    ];
    for (const plane of planes) {
      const summary = run(rasterFromPlane(5, 5, plane), 44, 60).summary;
      assert.ok(Math.abs(summary.meanSlopeDegrees - 45) < 1e-10);
      assert.equal(summary.warningCells, 9);
    }
  });

  it("uses independent x/y resolution in the Horn formula", () => {
    const raster = rasterFromPlane(5, 5, (row, col) => 2 * col + 15 * row);
    raster.scaleX = 2;
    raster.scaleY = 5;
    const expected = Math.atan(Math.sqrt(10)) * 180 / Math.PI;
    const summary = run(raster, 70, 80).summary;
    assert.ok(Math.abs(summary.meanSlopeDegrees - expected) < 1e-10);
  });

  it("uses raw exact threshold boundaries", () => {
    const raster = rasterFromPlane(5, 5, (_row, col) => col);
    const warning = run(raster, 45, 60).summary;
    assert.equal(warning.safeCells, 0);
    assert.equal(warning.warningCells, 9);
    const danger = run(raster, 10, 45).summary;
    assert.equal(danger.dangerCells, 9);
  });

  it("treats border and NoData-neighbour windows as unknown", () => {
    const raster = rasterFromPlane(7, 7, () => 10);
    raster.nodata = -9999;
    (raster.values as Float64Array)[3 * 7 + 3] = -9999;
    const summary = run(raster).summary;
    assert.equal(summary.aoiCandidateCells, 49);
    assert.equal(summary.evaluatedCells, 16);
    assert.equal(summary.unknownCells, 33);
    assert.equal(summary.safeCells, 16);
  });

  it("rejects invalid samples, invalid thresholds, unconfirmed datum, and empty evaluation", () => {
    const invalid = rasterFromPlane(5, 5, () => 10);
    (invalid.values as Float64Array)[0] = Number.NaN;
    assert.throws(() => run(invalid), /TERRAIN_SAFETY_SAMPLE_UNSUPPORTED/);
    const flat = rasterFromPlane(5, 5, () => 10);
    assert.throws(() => calculateTerrainSafety({
      raster: flat,
      boundary: fullBoundary(flat),
      warningThresholdDegrees: 30,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    }), /TERRAIN_SAFETY_NUMERIC_INVALID/);
    assert.throws(() => calculateTerrainSafety({
      raster: flat,
      boundary: fullBoundary(flat),
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: false,
    }), /TERRAIN_SAFETY_VERTICAL_DATUM_UNCONFIRMED/);
    assert.throws(() => run(rasterFromPlane(2, 2, () => 10)), /TERRAIN_SAFETY_EMPTY_EVALUATION/);
  });

  it("builds and validates an exact geometry-only private DTO", () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    assert.equal(result.summary.schema, TERRAIN_SAFETY_SCHEMA);
    assert.equal(result.summary.method, TERRAIN_SAFETY_METHOD);
    const layer = buildTerrainSafetyLayer(result);
    assert.equal(layer.type, "geojson");
    assert.deepEqual(layer.source, { type: "geojson" });
    assert.equal(layer.metadata.customLayerType, "terrain-slope-safety");
    assert.equal(layer.metadata.excludeFromHistory, true);
    assert.deepEqual(layer.geojson?.features[0]?.properties, {});
    assert.deepEqual(normalizeTerrainSafetyResult(result), result);
    const tampered = structuredClone(result) as unknown as {
      summary: Record<string, unknown>;
    };
    tampered.summary.foreign = "blocked";
    assert.throws(() => normalizeTerrainSafetyResult(tampered), /TERRAIN_SAFETY_PROJECT_INVALID/);
    const serializedPrivateDto = JSON.stringify({
      metadata: layer.metadata,
      geojson: layer.geojson,
    });
    assert.doesNotMatch(
      serializedPrivateDto,
      /"(?:path|filename|nodata|credential|stack|rawError|pixels?)"\s*:/i,
    );
  });

  it("enforces the 117 MiB design ledger under a 128 MiB hard budget", () => {
    const mib = 1024 * 1024;
    assert.equal(
      estimateTerrainSafetyWorkerPeakBytes(
        TERRAIN_SAFETY_MAX_INPUT_BYTES,
        20 * mib,
        8 * mib,
      ),
      117 * mib,
    );
    assert.equal(TERRAIN_SAFETY_WORKER_PEAK_BUDGET_BYTES, 128 * mib);
    assert.throws(
      () => estimateTerrainSafetyWorkerPeakBytes(49 * mib, 20 * mib, 8 * mib),
      /TERRAIN_SAFETY_LIMIT_EXCEEDED/,
    );
  });

  it("decodes the approved classic single-band uncompressed GeoTIFF", async () => {
    const decoded = await decodeTerrainSafetyGeoTiff(sampleTerrainGeoTiff());
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
    assert.equal(decoded.sourceCrs, CRS);
    assert.equal(decoded.scaleX, 1);
    assert.equal(decoded.scaleY, 1);
    assert.deepEqual(Array.from(decoded.values), [12, 8, 10, 10]);
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(sampleTerrainGeoTiff(2)),
      /TERRAIN_SAFETY_SAMPLE_UNSUPPORTED/,
    );
  });

  it("decodes big-endian Classic TIFF and an EPSG:5179 GeoKey", async () => {
    const bigEndian = await decodeTerrainSafetyGeoTiff(sampleTerrainBigEndianGeoTiff());
    assert.deepEqual(Array.from(bigEndian.values), [12, 8, 10, 10]);
    const epsg5179 = sampleTerrainGeoTiff();
    new DataView(epsg5179).setUint16(254 + 15 * 2, 5179, true);
    const decoded5179 = await decodeTerrainSafetyGeoTiff(epsg5179);
    assert.equal(decoded5179.sourceCrs, "EPSG:5179");
  });

  it("accepts a final partial strip and rejects malformed strip contracts", async () => {
    const valid = await decodeTerrainSafetyGeoTiff(sampleTerrainMultiStripGeoTiff());
    assert.deepEqual(Array.from(valid.values), [1, 2, 3, 4, 5, 6]);

    const badRows = sampleTerrainMultiStripGeoTiff();
    new DataView(badRows).setUint32(8 + 2 + 7 * 12 + 8, 0, true);
    await assert.rejects(() => decodeTerrainSafetyGeoTiff(badRows), /TERRAIN_SAFETY_TIFF_INVALID/);

    const badExpectedCount = sampleTerrainMultiStripGeoTiff();
    new DataView(badExpectedCount).setUint32(8 + 2 + 7 * 12 + 8, 3, true);
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(badExpectedCount),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );

    const mismatchedArrays = sampleTerrainMultiStripGeoTiff();
    new DataView(mismatchedArrays).setUint32(8 + 2 + 8 * 12 + 4, 1, true);
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(mismatchedArrays),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );

    const overlap = sampleTerrainMultiStripGeoTiff();
    new DataView(overlap).setUint32(286 + 4, 302 + 8, true);
    await assert.rejects(() => decodeTerrainSafetyGeoTiff(overlap), /TERRAIN_SAFETY_TIFF_INVALID/);

    const byteMismatch = sampleTerrainMultiStripGeoTiff();
    new DataView(byteMismatch).setUint32(294 + 4, 16, true);
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(byteMismatch),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );
  });

  it("rejects PixelIsPoint, GCP/RPC, ModelTransformation, and negative scale", async () => {
    const pixelIsPoint = sampleTerrainGeoTiff();
    new DataView(pixelIsPoint).setUint16(254 + 11 * 2, 2, true);
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(pixelIsPoint),
      /TERRAIN_SAFETY_CRS_UNSUPPORTED/,
    );

    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 12, 33922, 12, 12, 206),
      ),
      /TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED/,
    );
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 13, 50844, 12, 3, 182),
      ),
      /TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED/,
    );
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 11, 34264, 12, 3, 182),
      ),
      /TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED/,
    );
    const negativeScale = sampleTerrainGeoTiff();
    new DataView(negativeScale).setFloat64(182, -1, true);
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(negativeScale),
      /TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED/,
    );
  });

  it("directly decodes every approved integer sample type", async () => {
    for (const bits of [8, 16, 32] as const) {
      for (const sampleFormat of [1, 2] as const) {
        const fixture = sampleTerrainIntegerGeoTiff(bits, sampleFormat);
        const decoded = await decodeTerrainSafetyGeoTiff(fixture.bytes);
        assert.deepEqual(Array.from(decoded.values), fixture.expected);
      }
    }
  });

  it("rejects hidden SubIFDs, mask/overview flags, oversized metadata, and huge IFD arrays", async () => {
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 13, 330, 4, 1, 200),
      ),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 13, 254, 4, 1, 1),
      ),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 13, 42112, 2, 1024 * 1024 + 1, 200),
      ),
      /TERRAIN_SAFETY_LIMIT_EXCEEDED/,
    );
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 13, 42112, 2, 2, 0x000028c3),
      ),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(
        setTerrainIfdEntry(sampleTerrainGeoTiff(), 5, 273, 4, 100_001, 200),
      ),
      /TERRAIN_SAFETY_/,
    );
  });

  it("rejects non-classic and malformed TIFF before decode materialization", async () => {
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]).buffer),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );
    await assert.rejects(
      () => decodeTerrainSafetyGeoTiff(new Uint8Array([0x49, 0x49, 43, 0, 0, 0, 0, 0]).buffer),
      /TERRAIN_SAFETY_TIFF_INVALID/,
    );
  });

  it("settles success once, transfers ownership, and reaches quiescence", async () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    const bytes = new ArrayBuffer(8);
    const worker = new FakeTerrainWorker();
    let clearCount = 0;
    const handle = runTerrainSafetyWorker({
      id: 7,
      bytes,
      boundary: result.boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    }, {
      createWorker: () => worker,
      schedule: () => 1,
      clearSchedule: () => { clearCount += 1; },
    });
    assert.equal(worker.posted?.transfer[0], bytes);
    worker.onmessage?.({ data: { id: 7, ok: true, result } } as MessageEvent);
    assert.deepEqual(await handle.promise, result);
    assert.equal(handle.isQuiescent(), true);
    assert.equal(worker.terminateCount, 1);
    assert.equal(clearCount, 1);
    assert.equal(worker.onmessage, null);
    assert.equal(worker.onerror, null);
    handle.cancel();
    assert.equal(worker.terminateCount, 1);
  });

  it("cancels exactly once and discards stale responses", async () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    const worker = new FakeTerrainWorker();
    const handle = runTerrainSafetyWorker({
      id: 9,
      bytes: new ArrayBuffer(8),
      boundary: result.boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    }, {
      createWorker: () => worker,
      schedule: () => 1,
      clearSchedule: () => undefined,
    });
    worker.onmessage?.({ data: { id: 8, ok: true, result } } as MessageEvent);
    assert.equal(handle.isQuiescent(), false);
    const rejected = assert.rejects(handle.promise, /TERRAIN_SAFETY_CANCELLED/);
    handle.cancel();
    await rejected;
    handle.cancel();
    assert.equal(worker.terminateCount, 1);
    assert.equal(handle.isQuiescent(), true);
  });

  it("times out with one settlement and full cleanup", async () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    const worker = new FakeTerrainWorker();
    let timeout: (() => void) | null = null;
    let clearCount = 0;
    const handle = runTerrainSafetyWorker({
      id: 11,
      bytes: new ArrayBuffer(8),
      boundary: result.boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    }, {
      createWorker: () => worker,
      schedule: (callback) => { timeout = callback; return 1; },
      clearSchedule: () => { clearCount += 1; },
    });
    const rejected = assert.rejects(handle.promise, /TERRAIN_SAFETY_TIMEOUT/);
    (timeout as (() => void) | null)?.();
    await rejected;
    assert.equal(worker.terminateCount, 1);
    assert.equal(clearCount, 1);
    assert.equal(worker.onmessage, null);
    assert.equal(worker.onerror, null);
  });

  it("cleans worker resources when postMessage throws synchronously", async () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    const worker = new FakeTerrainWorker();
    worker.throwOnPost = true;
    let clearCount = 0;
    const handle = runTerrainSafetyWorker({
      id: 12,
      bytes: new ArrayBuffer(8),
      boundary: result.boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true,
    }, {
      createWorker: () => worker,
      schedule: () => 1,
      clearSchedule: () => { clearCount += 1; },
    });
    await assert.rejects(handle.promise, /TERRAIN_SAFETY_NUMERIC_INVALID/);
    assert.equal(worker.terminateCount, 1);
    assert.equal(clearCount, 1);
    assert.equal(worker.onmessage, null);
    assert.equal(worker.onerror, null);
  });

  it("rejects and quiesces when scheduler or cleanup hooks throw synchronously", async () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    const request = {
      id: 13,
      bytes: new ArrayBuffer(8),
      boundary: result.boundary,
      warningThresholdDegrees: 15,
      dangerThresholdDegrees: 30,
      verticalDatumConfirmed: true as const,
    };

    const scheduleThrowWorker = new FakeTerrainWorker();
    const scheduleThrowHandle = runTerrainSafetyWorker(request, {
      createWorker: () => scheduleThrowWorker,
      schedule: () => { throw new Error("scheduler failed"); },
    });
    await assert.rejects(scheduleThrowHandle.promise, /TERRAIN_SAFETY_NUMERIC_INVALID/);
    assert.equal(scheduleThrowWorker.terminateCount, 1);
    assert.equal(scheduleThrowWorker.onmessage, null);
    assert.equal(scheduleThrowWorker.onerror, null);

    const cleanupThrowWorker = new FakeTerrainWorker();
    const cleanupThrowHandle = runTerrainSafetyWorker({ ...request, bytes: new ArrayBuffer(8) }, {
      createWorker: () => cleanupThrowWorker,
      schedule: () => 2,
      clearSchedule: () => { throw new Error("clear failed"); },
    });
    const cancelled = assert.rejects(
      cleanupThrowHandle.promise,
      /TERRAIN_SAFETY_CANCELLED/,
    );
    cleanupThrowHandle.cancel();
    await cancelled;
    assert.equal(cleanupThrowWorker.terminateCount, 1);
    assert.equal(cleanupThrowWorker.onmessage, null);
    assert.equal(cleanupThrowWorker.onerror, null);

    const synchronousTimeoutWorker = new FakeTerrainWorker();
    let synchronousClearCount = 0;
    const synchronousTimeoutHandle = runTerrainSafetyWorker(
      { ...request, bytes: new ArrayBuffer(8) },
      {
        createWorker: () => synchronousTimeoutWorker,
        schedule: (callback) => { callback(); return 3; },
        clearSchedule: () => { synchronousClearCount += 1; },
      },
    );
    await assert.rejects(synchronousTimeoutHandle.promise, /TERRAIN_SAFETY_TIMEOUT/);
    assert.equal(synchronousTimeoutWorker.posted, null);
    assert.equal(synchronousTimeoutWorker.terminateCount, 1);
    assert.equal(synchronousClearCount, 1);
  });

  it("round-trips only the exact local allowlist and rejects tampering", async () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    const project = createEmptyProject("Terrain Safety");
    project.layers.push(buildTerrainSafetyLayer(result));
    const serialized = serializeProject(project);
    assert.doesNotMatch(serialized, /\.tiff?|sourcePath|StripOffsets|NoData|credential/i);
    const reopened = sanitizeIncomingTerrainSafetyProject(parseProject(serialized));
    assert.deepEqual(reopened.layers[0].metadata.terrainSafetyAnalysis, result.summary);
    const prepared = prepareProjectForFileSave(project);
    assert.doesNotThrow(() => sanitizeIncomingTerrainSafetyProject(prepared));

    useAppStore.getState().newProject({ name: "Terrain runtime save" });
    useAppStore.getState().addLayer(buildTerrainSafetyLayer(result));
    const runtimeProject = createEmptyProject("Terrain runtime save");
    runtimeProject.layers = useAppStore.getState().layers;
    assert.equal(Object.hasOwn(runtimeProject.layers[0], "beforeId"), true);
    const runtimeSanitized = sanitizeIncomingTerrainSafetyProject(runtimeProject);
    assert.equal(Object.hasOwn(runtimeSanitized.layers[0], "beforeId"), false);
    const persistedBeforeId = structuredClone(reopened) as unknown as {
      layers: Array<{ beforeId?: string }>;
    };
    persistedBeforeId.layers[0].beforeId = "foreign-layer";
    assert.throws(
      () => sanitizeIncomingTerrainSafetyProject(persistedBeforeId as never),
      /TERRAIN_SAFETY_PROJECT_INVALID/,
    );

    assert.throws(
      () => assertProjectSafeForExternalTransfer(reopened),
      /PROJECT_PRIVATE_CONTENT_REJECTED/,
    );
    const tampered = structuredClone(reopened);
    const summary = tampered.layers[0].metadata.terrainSafetyAnalysis as Record<string, unknown>;
    summary.meanSlopeDegrees = 99;
    assert.throws(
      () => sanitizeIncomingTerrainSafetyProject(tampered),
      /TERRAIN_SAFETY_PROJECT_INVALID/,
    );
    const foreign = structuredClone(reopened) as unknown as {
      layers: Array<Record<string, unknown>>;
    };
    foreign.layers[0].foreign = "blocked";
    assert.throws(
      () => sanitizeIncomingTerrainSafetyProject(foreign as never),
      /TERRAIN_SAFETY_PROJECT_INVALID/,
    );
    const foreignStyle = structuredClone(reopened) as unknown as {
      layers: Array<{ style: Record<string, unknown> }>;
    };
    foreignStyle.layers[0].style.sourcePath = "C:/private/dem.tif";
    assert.throws(
      () => sanitizeIncomingTerrainSafetyProject(foreignStyle as never),
      /TERRAIN_SAFETY_PROJECT_INVALID/,
    );

  });

  it("detects stripped, nested, and serialized private terrain summaries", () => {
    const result = run(rasterFromPlane(5, 5, () => 7));
    const layer = buildTerrainSafetyLayer(result);
    assert.equal(containsPersistedTerrainSafetyAnalysis(layer), true);
    assert.equal(containsPersistedTerrainSafetyAnalysis({ nested: { ...result.summary } }), true);
    const stripped = { ...result.summary } as Record<string, unknown>;
    delete stripped.schema;
    delete stripped.method;
    assert.equal(containsPersistedTerrainSafetyAnalysis(JSON.stringify({ payload: stripped })), true);
    assert.throws(
      () => assertNoPrivateAnalysisContent({ payload: layer }),
      /TERRAIN_SAFETY_PRIVATE_CONTENT_BLOCKED/,
    );
    assert.equal(selectLayersWithoutPrivateEarthwork([layer]).length, 0);
  });

  it("keeps terrain safety out of undo snapshots while preserving the live layer", () => {
    useAppStore.getState().newProject({ name: "Terrain safety history" });
    const privateLayer = buildTerrainSafetyLayer(run(rasterFromPlane(5, 5, () => 7)));
    useAppStore.getState().addLayer(privateLayer);
    const safeId = useAppStore.getState().addGeoJsonLayer("Safe", {
      type: "FeatureCollection",
      features: [],
    });
    useAppStore.temporal.getState().clear();
    useAppStore.getState().setLayerOpacity(safeId, 0.5);
    const history = useAppStore.temporal.getState().pastStates;
    assert.doesNotMatch(
      JSON.stringify(history),
      /geoim3d-terrain-slope-safety|terrainSafetyAnalysis/i,
    );
    undo();
    assert.ok(useAppStore.getState().layers.some((layer) => layer.id === privateLayer.id));
    useAppStore.getState().newProject({ name: "Cleanup" });
  });
});
