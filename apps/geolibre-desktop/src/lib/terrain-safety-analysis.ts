import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import booleanIntersects from "@turf/boolean-intersects";
import booleanValid from "@turf/boolean-valid";
import rewind from "@turf/rewind";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import {
  transformLocalCrsPoint,
  type KoreanProjectedCrs,
  type LocalCrs,
} from "./local-crs";

export const TERRAIN_SAFETY_SCHEMA = "geoim3d-terrain-slope-safety-v1" as const;
export const TERRAIN_SAFETY_METHOD = "horn-3x3-pixel-center-v1" as const;
export const TERRAIN_SAFETY_VERTICAL_DATUM_POLICY =
  "user-confirmed-same-meter-datum-v1" as const;
export const TERRAIN_SAFETY_RESULT_NAME = "경사·안전 분석";
export const TERRAIN_SAFETY_MAX_INPUT_BYTES = 48 * 1024 * 1024;
export const TERRAIN_SAFETY_MAX_PIXELS = 5_000_000;

const MAX_INPUT_COORDINATES = 20_000;
const MAX_PROJECTED_COORDINATES = 200_000;
const MAX_DENSIFY_DEPTH = 20;
const MAX_COORDINATE_ABS = 10_000_000;
const MAX_AXIS_EXTENT = 100_000;
const MIN_ELEVATION = -1_000;
const MAX_ELEVATION = 10_000;
const MAX_AREA = 100_000_000_000;

type Point2D = [number, number];
export type TerrainSafetyProjectedRing = Point2D[];
export type TerrainSafetyProjectedPolygon = TerrainSafetyProjectedRing[];
type ProjectedRing = TerrainSafetyProjectedRing;
type ProjectedPolygon = TerrainSafetyProjectedPolygon;
export type TerrainSafetyBoundary = Polygon | MultiPolygon;

export interface TerrainSafetyRaster {
  values: ArrayLike<number>;
  width: number;
  height: number;
  tieI: number;
  tieJ: number;
  tieX: number;
  tieY: number;
  scaleX: number;
  scaleY: number;
  nodata: number | null;
  sourceCrs: KoreanProjectedCrs;
}

export interface TerrainSafetySummary {
  schema: typeof TERRAIN_SAFETY_SCHEMA;
  sourceFormat: "GeoTIFF DEM";
  sourceCrs: KoreanProjectedCrs;
  verticalDatumPolicy: typeof TERRAIN_SAFETY_VERTICAL_DATUM_POLICY;
  method: typeof TERRAIN_SAFETY_METHOD;
  warningThresholdDegrees: number;
  dangerThresholdDegrees: number;
  cellAreaSquareMeters: number;
  aoiCandidateCells: number;
  evaluatedCells: number;
  unknownCells: number;
  safeCells: number;
  warningCells: number;
  dangerCells: number;
  safeAreaSquareMeters: number;
  warningAreaSquareMeters: number;
  dangerAreaSquareMeters: number;
  unknownAreaSquareMeters: number;
  minSlopeDegrees: number;
  maxSlopeDegrees: number;
  meanSlopeDegrees: number;
}

export interface TerrainSafetyResult {
  boundary: TerrainSafetyBoundary;
  summary: TerrainSafetySummary;
}

export interface CalculateTerrainSafetyInput {
  raster: TerrainSafetyRaster;
  boundary: TerrainSafetyBoundary;
  warningThresholdDegrees: number;
  dangerThresholdDegrees: number;
  verticalDatumConfirmed: boolean;
}

const SUMMARY_KEYS = [
  "schema", "sourceFormat", "sourceCrs", "verticalDatumPolicy", "method",
  "warningThresholdDegrees", "dangerThresholdDegrees", "cellAreaSquareMeters",
  "aoiCandidateCells", "evaluatedCells", "unknownCells", "safeCells",
  "warningCells", "dangerCells", "safeAreaSquareMeters",
  "warningAreaSquareMeters", "dangerAreaSquareMeters", "unknownAreaSquareMeters",
  "minSlopeDegrees", "maxSlopeDegrees", "meanSlopeDegrees",
] as const;
const SORTED_SUMMARY_KEYS = [...SUMMARY_KEYS].sort();

function fail(code: string): never {
  throw new Error(code);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function transformTerrainSafetyPoint(
  point: readonly number[],
  source: LocalCrs,
  target: LocalCrs,
): Point2D {
  try {
    return transformLocalCrsPoint([point[0], point[1]], source, target);
  } catch {
    fail("TERRAIN_SAFETY_CRS_UNSUPPORTED");
  }
}

function samePoint(left: readonly number[], right: readonly number[]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function signedArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return sum / 2;
}

function normalizeRing(value: unknown, count: { value: number }): Position[] {
  if (!Array.isArray(value) || value.length < 4) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
  const ring = value.map((candidate): Position => {
    if (
      !Array.isArray(candidate) || candidate.length !== 2 ||
      !finite(candidate[0]) || !finite(candidate[1]) ||
      candidate[0] < -180 || candidate[0] > 180 ||
      candidate[1] < -90 || candidate[1] > 90
    ) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
    count.value += 1;
    if (count.value > MAX_INPUT_COORDINATES) fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
    return [candidate[0], candidate[1]];
  });
  if (!samePoint(ring[0], ring.at(-1)!)) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (samePoint(ring[index], ring[index + 1])) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
    if (Math.abs(ring[index][0] - ring[index + 1][0]) > 180) {
      fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
    }
  }
  if (Math.abs(signedArea(ring)) <= Number.EPSILON) {
    fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
  }
  return ring;
}

function geometryFeature<T extends TerrainSafetyBoundary>(geometry: T): Feature<T> {
  return { type: "Feature", geometry, properties: {} };
}

export function normalizeTerrainSafetyBoundary(value: unknown): TerrainSafetyBoundary {
  if (!value || typeof value !== "object") fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (
    Object.keys(value).length !== 2 ||
    !("type" in value) ||
    !("coordinates" in value)
  ) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
  const count = { value: 0 };
  let geometry: TerrainSafetyBoundary;
  if (candidate.type === "Polygon" && Array.isArray(candidate.coordinates)) {
    geometry = {
      type: "Polygon",
      coordinates: candidate.coordinates.map((ring) => normalizeRing(ring, count)),
    };
  } else if (candidate.type === "MultiPolygon" && Array.isArray(candidate.coordinates)) {
    if (candidate.coordinates.length === 0) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
    geometry = {
      type: "MultiPolygon",
      coordinates: candidate.coordinates.map((polygon) => {
        if (!Array.isArray(polygon) || polygon.length === 0) {
          fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
        }
        return polygon.map((ring) => normalizeRing(ring, count));
      }),
    };
  } else {
    fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
  }
  if (!booleanValid(geometryFeature(geometry))) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
  if (geometry.type === "MultiPolygon") {
    for (let left = 0; left < geometry.coordinates.length; left += 1) {
      for (let right = left + 1; right < geometry.coordinates.length; right += 1) {
        const a: Polygon = { type: "Polygon", coordinates: geometry.coordinates[left] };
        const b: Polygon = { type: "Polygon", coordinates: geometry.coordinates[right] };
        if (booleanIntersects(geometryFeature(a), geometryFeature(b))) {
          fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
        }
      }
    }
  }
  const rewound = rewind(geometryFeature(geometry), {
    reverse: false,
    mutate: false,
  }) as Feature<TerrainSafetyBoundary>;
  return rewound.geometry;
}

function assertRaster(raster: TerrainSafetyRaster): void {
  if (
    !Number.isSafeInteger(raster.width) || !Number.isSafeInteger(raster.height) ||
    raster.width < 1 || raster.height < 1 || raster.width > 10_000 || raster.height > 10_000
  ) fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
  const pixels = raster.width * raster.height;
  if (
    !Number.isSafeInteger(pixels) || pixels > TERRAIN_SAFETY_MAX_PIXELS ||
    raster.values.length !== pixels
  ) fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
  if (
    !finite(raster.tieI) || !finite(raster.tieJ) ||
    !finite(raster.tieX) || !finite(raster.tieY) ||
    !finite(raster.scaleX) || !finite(raster.scaleY) ||
    Math.abs(raster.tieI) > MAX_COORDINATE_ABS ||
    Math.abs(raster.tieJ) > MAX_COORDINATE_ABS ||
    Math.abs(raster.tieX) > MAX_COORDINATE_ABS ||
    Math.abs(raster.tieY) > MAX_COORDINATE_ABS ||
    raster.scaleX < 0.01 || raster.scaleX > 100 ||
    raster.scaleY < 0.01 || raster.scaleY > 100
  ) fail("TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED");
  if (
    raster.width * raster.scaleX > MAX_AXIS_EXTENT ||
    raster.height * raster.scaleY > MAX_AXIS_EXTENT
  ) fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
  const centerXs = [
    raster.tieX + (0.5 - raster.tieI) * raster.scaleX,
    raster.tieX + (raster.width - 0.5 - raster.tieI) * raster.scaleX,
  ];
  const centerYs = [
    raster.tieY - (0.5 - raster.tieJ) * raster.scaleY,
    raster.tieY - (raster.height - 0.5 - raster.tieJ) * raster.scaleY,
  ];
  if (
    [...centerXs, ...centerYs].some((coordinate) =>
      !finite(coordinate) || Math.abs(coordinate) > MAX_COORDINATE_ABS)
  ) fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
  if (raster.sourceCrs !== "EPSG:5179" && raster.sourceCrs !== "EPSG:5186") {
    fail("TERRAIN_SAFETY_CRS_UNSUPPORTED");
  }
  if (raster.nodata !== null && !finite(raster.nodata)) {
    fail("TERRAIN_SAFETY_SAMPLE_UNSUPPORTED");
  }
}

function pointLineDistance(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator,
  ));
  return Math.hypot(
    point[0] - (start[0] + t * dx),
    point[1] - (start[1] + t * dy),
  );
}

function densifyEdge(
  startWgs: Position,
  endWgs: Position,
  startProjected: Point2D,
  endProjected: Point2D,
  crs: KoreanProjectedCrs,
  tolerance: number,
  depth: number,
  output: Point2D[],
  count: { value: number },
): void {
  const midpointWgs: Point2D = [
    (startWgs[0] + endWgs[0]) / 2,
    (startWgs[1] + endWgs[1]) / 2,
  ];
  const midpointProjected = transformTerrainSafetyPoint(midpointWgs, "EPSG:4326", crs);
  if (pointLineDistance(midpointProjected, startProjected, endProjected) <= tolerance) {
    output.push(endProjected);
    count.value += 1;
    if (count.value > MAX_PROJECTED_COORDINATES) fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
    return;
  }
  if (depth >= MAX_DENSIFY_DEPTH) fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
  densifyEdge(
    startWgs, midpointWgs, startProjected, midpointProjected,
    crs, tolerance, depth + 1, output, count,
  );
  densifyEdge(
    midpointWgs, endWgs, midpointProjected, endProjected,
    crs, tolerance, depth + 1, output, count,
  );
}

function projectRing(
  ring: Position[],
  raster: TerrainSafetyRaster,
  count: { value: number },
): ProjectedRing {
  const output: ProjectedRing = [];
  const tolerance = Math.min(0.01, Math.min(raster.scaleX, raster.scaleY) * 0.01);
  output.push(transformTerrainSafetyPoint(ring[0], "EPSG:4326", raster.sourceCrs));
  count.value += 1;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = transformTerrainSafetyPoint(ring[index], "EPSG:4326", raster.sourceCrs);
    const end = transformTerrainSafetyPoint(ring[index + 1], "EPSG:4326", raster.sourceCrs);
    densifyEdge(
      ring[index], ring[index + 1], start, end, raster.sourceCrs,
      tolerance, 0, output, count,
    );
  }
  return output;
}

export function projectTerrainSafetyBoundary(
  boundary: TerrainSafetyBoundary,
  raster: TerrainSafetyRaster,
): ProjectedPolygon[] {
  const count = { value: 0 };
  const polygons = boundary.type === "Polygon" ? [boundary.coordinates] : boundary.coordinates;
  const projected = polygons.map((polygon) =>
    polygon.map((ring) => projectRing(ring, raster, count)),
  );
  for (const polygon of projected) {
    for (const ring of polygon) {
      for (const point of ring) {
        if (
          !finite(point[0]) || !finite(point[1]) ||
          Math.abs(point[0]) > MAX_COORDINATE_ABS ||
          Math.abs(point[1]) > MAX_COORDINATE_ABS
        ) fail("TERRAIN_SAFETY_BOUNDARY_INVALID");
      }
    }
  }
  return projected;
}

function pointOnSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D,
  epsilon: number,
): boolean {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]) <= epsilon;
  }
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  const parameterTolerance = epsilon / Math.sqrt(lengthSquared);
  return t >= -parameterTolerance && t <= 1 + parameterTolerance &&
    pointLineDistance(point, start, end) <= epsilon;
}

function onRingBoundary(point: Point2D, ring: ProjectedRing, epsilon: number): boolean {
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (pointOnSegment(point, ring[index], ring[index + 1], epsilon)) return true;
  }
  return false;
}

function insideRing(point: Point2D, ring: ProjectedRing): boolean {
  let inside = false;
  for (
    let current = 0, previous = ring.length - 2;
    current < ring.length - 1;
    previous = current, current += 1
  ) {
    const a = ring[current];
    const b = ring[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const crossingX = ((b[0] - a[0]) * (point[1] - a[1])) /
        (b[1] - a[1]) + a[0];
      if (point[0] < crossingX) inside = !inside;
    }
  }
  return inside;
}

function insidePolygon(
  point: Point2D,
  polygon: ProjectedPolygon,
  epsilon: number,
): boolean {
  for (let index = 1; index < polygon.length; index += 1) {
    if (onRingBoundary(point, polygon[index], epsilon) || insideRing(point, polygon[index])) {
      return false;
    }
  }
  return onRingBoundary(point, polygon[0], epsilon) || insideRing(point, polygon[0]);
}

class KahanSum {
  private sum = 0;
  private compensation = 0;

  add(value: number): void {
    const adjusted = value - this.compensation;
    const next = this.sum + adjusted;
    this.compensation = next - this.sum - adjusted;
    this.sum = next;
  }

  value(): number {
    return this.sum;
  }
}

function isNoData(value: number, nodata: number | null): boolean {
  return nodata !== null && value === nodata;
}

function hornSlopeDegrees(raster: TerrainSafetyRaster, row: number, column: number): number | null {
  if (row === 0 || column === 0 || row === raster.height - 1 || column === raster.width - 1) {
    return null;
  }
  const z = new Array<number>(9);
  let index = 0;
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
      const value = raster.values[
        (row + rowOffset) * raster.width + column + columnOffset
      ];
      if (isNoData(value, raster.nodata)) return null;
      z[index] = value;
      index += 1;
    }
  }
  const dzdx = (z[2] + 2 * z[5] + z[8] - (z[0] + 2 * z[3] + z[6])) /
    (8 * raster.scaleX);
  const dzdy = (z[6] + 2 * z[7] + z[8] - (z[0] + 2 * z[1] + z[2])) /
    (8 * raster.scaleY);
  const slope = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
  if (!finite(slope) || slope < 0 || slope > 90) fail("TERRAIN_SAFETY_NUMERIC_INVALID");
  return slope;
}

export function calculateTerrainSafety(input: CalculateTerrainSafetyInput): TerrainSafetyResult {
  if (!input.verticalDatumConfirmed) {
    fail("TERRAIN_SAFETY_VERTICAL_DATUM_UNCONFIRMED");
  }
  assertRaster(input.raster);
  if (
    !finite(input.warningThresholdDegrees) || !finite(input.dangerThresholdDegrees) ||
    input.warningThresholdDegrees < 0.1 || input.warningThresholdDegrees >= 89 ||
    input.dangerThresholdDegrees <= input.warningThresholdDegrees ||
    input.dangerThresholdDegrees > 89
  ) fail("TERRAIN_SAFETY_NUMERIC_INVALID");

  let validSamples = 0;
  for (let index = 0; index < input.raster.values.length; index += 1) {
    const value = input.raster.values[index];
    if (isNoData(value, input.raster.nodata)) continue;
    if (!finite(value) || value < MIN_ELEVATION || value > MAX_ELEVATION) {
      fail("TERRAIN_SAFETY_SAMPLE_UNSUPPORTED");
    }
    validSamples += 1;
  }
  if (validSamples === 0) fail("TERRAIN_SAFETY_EMPTY_EVALUATION");

  const boundary = normalizeTerrainSafetyBoundary(input.boundary);
  const projected = projectTerrainSafetyBoundary(boundary, input.raster);
  const epsilon = Math.max(
    1e-8,
    Math.min(input.raster.scaleX, input.raster.scaleY) * 1e-7,
  );
  const cellArea = input.raster.scaleX * input.raster.scaleY;
  const slopeSum = new KahanSum();
  let candidates = 0;
  let evaluated = 0;
  let unknown = 0;
  let safe = 0;
  let warning = 0;
  let danger = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;

  for (let row = 0; row < input.raster.height; row += 1) {
    const y = input.raster.tieY - (row + 0.5 - input.raster.tieJ) * input.raster.scaleY;
    if (!finite(y) || Math.abs(y) > MAX_COORDINATE_ABS) {
      fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
    }
    for (let column = 0; column < input.raster.width; column += 1) {
      const x = input.raster.tieX +
        (column + 0.5 - input.raster.tieI) * input.raster.scaleX;
      if (!finite(x) || Math.abs(x) > MAX_COORDINATE_ABS) {
        fail("TERRAIN_SAFETY_LIMIT_EXCEEDED");
      }
      if (!projected.some((polygon) => insidePolygon([x, y], polygon, epsilon))) continue;
      candidates += 1;
      const slope = hornSlopeDegrees(input.raster, row, column);
      if (slope === null) {
        unknown += 1;
        continue;
      }
      evaluated += 1;
      slopeSum.add(slope);
      minimum = Math.min(minimum, slope);
      maximum = Math.max(maximum, slope);
      if (slope < input.warningThresholdDegrees) safe += 1;
      else if (slope < input.dangerThresholdDegrees) warning += 1;
      else danger += 1;
    }
  }
  if (candidates === 0) fail("TERRAIN_SAFETY_EMPTY_SELECTION");
  if (evaluated === 0) fail("TERRAIN_SAFETY_EMPTY_EVALUATION");
  const mean = slopeSum.value() / evaluated;
  const summary: TerrainSafetySummary = {
    schema: TERRAIN_SAFETY_SCHEMA,
    sourceFormat: "GeoTIFF DEM",
    sourceCrs: input.raster.sourceCrs,
    verticalDatumPolicy: TERRAIN_SAFETY_VERTICAL_DATUM_POLICY,
    method: TERRAIN_SAFETY_METHOD,
    warningThresholdDegrees: input.warningThresholdDegrees,
    dangerThresholdDegrees: input.dangerThresholdDegrees,
    cellAreaSquareMeters: cellArea,
    aoiCandidateCells: candidates,
    evaluatedCells: evaluated,
    unknownCells: unknown,
    safeCells: safe,
    warningCells: warning,
    dangerCells: danger,
    safeAreaSquareMeters: safe * cellArea,
    warningAreaSquareMeters: warning * cellArea,
    dangerAreaSquareMeters: danger * cellArea,
    unknownAreaSquareMeters: unknown * cellArea,
    minSlopeDegrees: minimum,
    maxSlopeDegrees: maximum,
    meanSlopeDegrees: mean,
  };
  validateTerrainSafetySummary(summary);
  return { boundary, summary };
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 1e-12);
}

export function validateTerrainSafetySummary(value: unknown): TerrainSafetySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("TERRAIN_SAFETY_PROJECT_INVALID");
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (
    keys.length !== SORTED_SUMMARY_KEYS.length ||
    !keys.every((key, index) => key === SORTED_SUMMARY_KEYS[index])
  ) fail("TERRAIN_SAFETY_PROJECT_INVALID");
  const integers = [
    raw.aoiCandidateCells, raw.evaluatedCells, raw.unknownCells,
    raw.safeCells, raw.warningCells, raw.dangerCells,
  ];
  const numeric = [
    raw.warningThresholdDegrees, raw.dangerThresholdDegrees,
    raw.cellAreaSquareMeters, raw.safeAreaSquareMeters,
    raw.warningAreaSquareMeters, raw.dangerAreaSquareMeters,
    raw.unknownAreaSquareMeters, raw.minSlopeDegrees,
    raw.maxSlopeDegrees, raw.meanSlopeDegrees,
  ];
  if (
    raw.schema !== TERRAIN_SAFETY_SCHEMA ||
    raw.sourceFormat !== "GeoTIFF DEM" ||
    (raw.sourceCrs !== "EPSG:5179" && raw.sourceCrs !== "EPSG:5186") ||
    raw.verticalDatumPolicy !== TERRAIN_SAFETY_VERTICAL_DATUM_POLICY ||
    raw.method !== TERRAIN_SAFETY_METHOD ||
    numeric.some((item) => !finite(item)) ||
    integers.some((item) => !Number.isSafeInteger(item))
  ) fail("TERRAIN_SAFETY_PROJECT_INVALID");
  const summary = raw as unknown as TerrainSafetySummary;
  if (
    summary.warningThresholdDegrees < 0.1 ||
    summary.warningThresholdDegrees >= 89 ||
    summary.dangerThresholdDegrees <= summary.warningThresholdDegrees ||
    summary.dangerThresholdDegrees > 89 ||
    summary.cellAreaSquareMeters < 0.0001 || summary.cellAreaSquareMeters > 10_000 ||
    summary.aoiCandidateCells < 1 || summary.aoiCandidateCells > TERRAIN_SAFETY_MAX_PIXELS ||
    summary.evaluatedCells < 1 || summary.evaluatedCells > summary.aoiCandidateCells ||
    summary.unknownCells < 0 || summary.safeCells < 0 ||
    summary.warningCells < 0 || summary.dangerCells < 0 ||
    summary.aoiCandidateCells !== summary.evaluatedCells + summary.unknownCells ||
    summary.evaluatedCells !== summary.safeCells + summary.warningCells + summary.dangerCells ||
    summary.minSlopeDegrees < 0 || summary.maxSlopeDegrees > 90 ||
    summary.minSlopeDegrees > summary.meanSlopeDegrees ||
    summary.meanSlopeDegrees > summary.maxSlopeDegrees ||
    !approximatelyEqual(summary.safeAreaSquareMeters, summary.safeCells * summary.cellAreaSquareMeters) ||
    !approximatelyEqual(summary.warningAreaSquareMeters, summary.warningCells * summary.cellAreaSquareMeters) ||
    !approximatelyEqual(summary.dangerAreaSquareMeters, summary.dangerCells * summary.cellAreaSquareMeters) ||
    !approximatelyEqual(summary.unknownAreaSquareMeters, summary.unknownCells * summary.cellAreaSquareMeters) ||
    summary.safeAreaSquareMeters < 0 || summary.warningAreaSquareMeters < 0 ||
    summary.dangerAreaSquareMeters < 0 || summary.unknownAreaSquareMeters < 0 ||
    summary.safeAreaSquareMeters + summary.warningAreaSquareMeters +
      summary.dangerAreaSquareMeters + summary.unknownAreaSquareMeters > MAX_AREA
  ) fail("TERRAIN_SAFETY_PROJECT_INVALID");
  return { ...summary };
}

export function normalizeTerrainSafetyResult(value: unknown): TerrainSafetyResult {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("TERRAIN_SAFETY_PROJECT_INVALID");
    }
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).length !== 2 || !("boundary" in raw) || !("summary" in raw)) {
      fail("TERRAIN_SAFETY_PROJECT_INVALID");
    }
    return {
      boundary: normalizeTerrainSafetyBoundary(raw.boundary),
      summary: validateTerrainSafetySummary(raw.summary),
    };
  } catch {
    fail("TERRAIN_SAFETY_PROJECT_INVALID");
  }
}

export function buildTerrainSafetyLayer(result: TerrainSafetyResult): GeoLibreLayer {
  const normalized = normalizeTerrainSafetyResult(result);
  const featureCollection: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: normalized.boundary, properties: {} }],
  };
  return {
    id: crypto.randomUUID(),
    name: TERRAIN_SAFETY_RESULT_NAME,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: "#ef4444",
      strokeColor: "#991b1b",
      fillOpacity: 0.2,
      strokeWidth: 2,
    },
    metadata: {
      customLayerType: "terrain-slope-safety",
      excludeFromHistory: true,
      terrainSafetyAnalysis: { ...normalized.summary },
    },
    geojson: featureCollection,
  };
}
