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

export const EARTHWORK_MAX_INPUT_BYTES = 48 * 1024 * 1024;
export const EARTHWORK_MAX_PIXELS = 5_000_000;
export const EARTHWORK_MAX_INPUT_COORDINATES = 20_000;
export const EARTHWORK_MAX_PROJECTED_COORDINATES = 200_000;
export const EARTHWORK_RESULT_NAME = "토공량 분석";
export const EARTHWORK_SCHEMA = "geoim3d-earthwork-v1" as const;
export const EARTHWORK_METHOD = "pixel-center-constant-grade-v1" as const;
export const EARTHWORK_VERTICAL_DATUM_POLICY =
  "user-confirmed-same-meter-datum-v1" as const;

const MIN_ELEVATION = -1_000;
const MAX_ELEVATION = 10_000;
const MAX_COORDINATE_ABS = 10_000_000;
const MAX_AXIS_EXTENT = 100_000;
const MAX_VOLUME = 1_000_000_000_000_000;
const MAX_INCLUDED_AREA = 100_000_000_000;
const MAX_DENSIFY_DEPTH = 20;

export type EarthworkBoundary = Polygon | MultiPolygon;
type Point2D = [number, number];
type ProjectedRing = Point2D[];
type ProjectedPolygon = ProjectedRing[];

export interface EarthworkRaster {
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

export interface EarthworkSummary {
  schema: typeof EARTHWORK_SCHEMA;
  sourceFormat: "GeoTIFF DEM";
  sourceCrs: KoreanProjectedCrs;
  verticalDatumPolicy: typeof EARTHWORK_VERTICAL_DATUM_POLICY;
  designElevationMeters: number;
  cellAreaSquareMeters: number;
  includedCells: number;
  includedAreaSquareMeters: number;
  cutCubicMeters: number;
  fillCubicMeters: number;
  netCubicMeters: number;
  method: typeof EARTHWORK_METHOD;
}

export interface EarthworkResult {
  boundary: EarthworkBoundary;
  summary: EarthworkSummary;
}

export interface CalculateEarthworkInput {
  raster: EarthworkRaster;
  boundary: EarthworkBoundary;
  designElevationMeters: number;
  verticalDatumConfirmed: boolean;
}

const SUMMARY_KEYS = [
  "schema",
  "sourceFormat",
  "sourceCrs",
  "verticalDatumPolicy",
  "designElevationMeters",
  "cellAreaSquareMeters",
  "includedCells",
  "includedAreaSquareMeters",
  "cutCubicMeters",
  "fillCubicMeters",
  "netCubicMeters",
  "method",
] as const;
const SORTED_SUMMARY_KEYS = [...SUMMARY_KEYS].sort();

function fail(code: string): never {
  throw new Error(code);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function transformEarthworkPoint(
  point: readonly number[],
  source: LocalCrs,
  target: LocalCrs,
): Point2D {
  try {
    return transformLocalCrsPoint([point[0], point[1]], source, target);
  } catch {
    fail("EARTHWORK_CRS_UNSUPPORTED");
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function signedArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return sum / 2;
}

function normalizeRing(value: unknown, count: { value: number }): Position[] {
  if (!Array.isArray(value) || value.length < 4) fail("EARTHWORK_BOUNDARY_INVALID");
  const ring: Position[] = value.map((candidate) => {
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 2 ||
      !finite(candidate[0]) ||
      !finite(candidate[1]) ||
      candidate[0] < -180 ||
      candidate[0] > 180 ||
      candidate[1] < -90 ||
      candidate[1] > 90
    ) {
      fail("EARTHWORK_BOUNDARY_INVALID");
    }
    count.value += 1;
    if (count.value > EARTHWORK_MAX_INPUT_COORDINATES) {
      fail("EARTHWORK_LIMIT_EXCEEDED");
    }
    return [rounded(candidate[0]), rounded(candidate[1])];
  });
  if (!samePoint(ring[0], ring[ring.length - 1])) fail("EARTHWORK_BOUNDARY_INVALID");
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (samePoint(ring[index], ring[index + 1])) fail("EARTHWORK_BOUNDARY_INVALID");
    if (Math.abs(ring[index][0] - ring[index + 1][0]) > 180) {
      fail("EARTHWORK_BOUNDARY_INVALID");
    }
  }
  if (Math.abs(signedArea(ring)) <= Number.EPSILON) fail("EARTHWORK_BOUNDARY_INVALID");
  return ring;
}

function geometryFeature<T extends EarthworkBoundary>(geometry: T): Feature<T> {
  return { type: "Feature", geometry, properties: {} };
}

export function normalizeEarthworkBoundary(value: unknown): EarthworkBoundary {
  if (!value || typeof value !== "object") fail("EARTHWORK_BOUNDARY_INVALID");
  const candidate = value as { type?: unknown; coordinates?: unknown };
  const count = { value: 0 };
  let geometry: EarthworkBoundary;
  if (candidate.type === "Polygon" && Array.isArray(candidate.coordinates)) {
    geometry = {
      type: "Polygon",
      coordinates: candidate.coordinates.map((ring) => normalizeRing(ring, count)),
    };
  } else if (candidate.type === "MultiPolygon" && Array.isArray(candidate.coordinates)) {
    if (candidate.coordinates.length === 0) fail("EARTHWORK_BOUNDARY_INVALID");
    geometry = {
      type: "MultiPolygon",
      coordinates: candidate.coordinates.map((polygon) => {
        if (!Array.isArray(polygon) || polygon.length === 0) {
          fail("EARTHWORK_BOUNDARY_INVALID");
        }
        return polygon.map((ring) => normalizeRing(ring, count));
      }),
    };
  } else {
    fail("EARTHWORK_BOUNDARY_INVALID");
  }

  if (!booleanValid(geometryFeature(geometry))) fail("EARTHWORK_BOUNDARY_INVALID");
  if (geometry.type === "MultiPolygon") {
    for (let left = 0; left < geometry.coordinates.length; left += 1) {
      for (let right = left + 1; right < geometry.coordinates.length; right += 1) {
        const a: Polygon = { type: "Polygon", coordinates: geometry.coordinates[left] };
        const b: Polygon = { type: "Polygon", coordinates: geometry.coordinates[right] };
        if (booleanIntersects(geometryFeature(a), geometryFeature(b))) {
          fail("EARTHWORK_BOUNDARY_INVALID");
        }
      }
    }
  }

  const rewound = rewind(geometryFeature(geometry), {
    reverse: false,
    mutate: false,
  }) as Feature<EarthworkBoundary>;
  return rewound.geometry;
}

function assertRaster(raster: EarthworkRaster): void {
  if (
    !Number.isSafeInteger(raster.width) ||
    !Number.isSafeInteger(raster.height) ||
    raster.width < 1 ||
    raster.height < 1 ||
    raster.width > 10_000 ||
    raster.height > 10_000
  ) {
    fail("EARTHWORK_LIMIT_EXCEEDED");
  }
  const pixels = raster.width * raster.height;
  if (!Number.isSafeInteger(pixels) || pixels > EARTHWORK_MAX_PIXELS || raster.values.length !== pixels) {
    fail("EARTHWORK_LIMIT_EXCEEDED");
  }
  if (
    !finite(raster.tieI) ||
    !finite(raster.tieJ) ||
    !finite(raster.tieX) ||
    !finite(raster.tieY) ||
    !finite(raster.scaleX) ||
    !finite(raster.scaleY) ||
    raster.scaleX < 0.01 ||
    raster.scaleX > 100 ||
    raster.scaleY < 0.01 ||
    raster.scaleY > 100
  ) {
    fail("EARTHWORK_TRANSFORM_UNSUPPORTED");
  }
  if (raster.width * raster.scaleX > MAX_AXIS_EXTENT || raster.height * raster.scaleY > MAX_AXIS_EXTENT) {
    fail("EARTHWORK_LIMIT_EXCEEDED");
  }
  if (raster.sourceCrs !== "EPSG:5179" && raster.sourceCrs !== "EPSG:5186") {
    fail("EARTHWORK_CRS_UNSUPPORTED");
  }
  if (raster.nodata !== null && !finite(raster.nodata)) fail("EARTHWORK_SAMPLE_UNSUPPORTED");
}

function projectionTolerance(raster: EarthworkRaster): number {
  return Math.min(0.01, Math.min(raster.scaleX, raster.scaleY) * 0.01);
}

function pointLineDistance(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
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
  const midpointProjected = transformEarthworkPoint(midpointWgs, "EPSG:4326", crs);
  const deviation = pointLineDistance(midpointProjected, startProjected, endProjected);
  if (deviation <= tolerance) {
    output.push(endProjected);
    count.value += 1;
    if (count.value > EARTHWORK_MAX_PROJECTED_COORDINATES) fail("EARTHWORK_LIMIT_EXCEEDED");
    return;
  }
  if (depth >= MAX_DENSIFY_DEPTH) fail("EARTHWORK_LIMIT_EXCEEDED");
  densifyEdge(startWgs, midpointWgs, startProjected, midpointProjected, crs, tolerance, depth + 1, output, count);
  densifyEdge(midpointWgs, endWgs, midpointProjected, endProjected, crs, tolerance, depth + 1, output, count);
}

function projectRing(
  ring: Position[],
  raster: EarthworkRaster,
  count: { value: number },
): ProjectedRing {
  const projected: ProjectedRing = [];
  const tolerance = projectionTolerance(raster);
  const first = transformEarthworkPoint(ring[0], "EPSG:4326", raster.sourceCrs);
  projected.push(first);
  count.value += 1;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = transformEarthworkPoint(ring[index], "EPSG:4326", raster.sourceCrs);
    const end = transformEarthworkPoint(ring[index + 1], "EPSG:4326", raster.sourceCrs);
    densifyEdge(ring[index], ring[index + 1], start, end, raster.sourceCrs, tolerance, 0, projected, count);
  }
  return projected;
}

function rasterExtent(raster: EarthworkRaster) {
  const west = raster.tieX + (0 - raster.tieI) * raster.scaleX;
  const east = raster.tieX + (raster.width - raster.tieI) * raster.scaleX;
  const north = raster.tieY - (0 - raster.tieJ) * raster.scaleY;
  const south = raster.tieY - (raster.height - raster.tieJ) * raster.scaleY;
  if (![west, east, north, south].every(finite)) fail("EARTHWORK_TRANSFORM_UNSUPPORTED");
  return { west: Math.min(west, east), east: Math.max(west, east), south: Math.min(south, north), north: Math.max(south, north) };
}

function projectBoundary(boundary: EarthworkBoundary, raster: EarthworkRaster): ProjectedPolygon[] {
  const count = { value: 0 };
  const polygons = boundary.type === "Polygon" ? [boundary.coordinates] : boundary.coordinates;
  const projected = polygons.map((polygon) => polygon.map((ring) => projectRing(ring, raster, count)));
  const extent = rasterExtent(raster);
  for (const polygon of projected) {
    for (const ring of polygon) {
      for (const point of ring) {
        if (
          !finite(point[0]) ||
          !finite(point[1]) ||
          Math.abs(point[0]) > MAX_COORDINATE_ABS ||
          Math.abs(point[1]) > MAX_COORDINATE_ABS ||
          point[0] < extent.west ||
          point[0] > extent.east ||
          point[1] < extent.south ||
          point[1] > extent.north
        ) {
          fail("EARTHWORK_BOUNDARY_INVALID");
        }
      }
    }
  }
  return projected;
}

function pointOnSegment(point: Point2D, start: Point2D, end: Point2D, epsilon: number): boolean {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]) <= epsilon;
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  const parameterTolerance = epsilon / Math.sqrt(lengthSquared);
  if (t < -parameterTolerance || t > 1 + parameterTolerance) return false;
  return pointLineDistance(point, start, end) <= epsilon;
}

function onRingBoundary(point: Point2D, ring: ProjectedRing, epsilon: number): boolean {
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (pointOnSegment(point, ring[index], ring[index + 1], epsilon)) return true;
  }
  return false;
}

function insideRing(point: Point2D, ring: ProjectedRing): boolean {
  let inside = false;
  for (let current = 0, previous = ring.length - 2; current < ring.length - 1; previous = current, current += 1) {
    const a = ring[current];
    const b = ring[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const crossingX = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (point[0] < crossingX) inside = !inside;
    }
  }
  return inside;
}

function insidePolygon(point: Point2D, polygon: ProjectedPolygon, epsilon: number): boolean {
  for (let index = 1; index < polygon.length; index += 1) {
    if (onRingBoundary(point, polygon[index], epsilon) || insideRing(point, polygon[index])) return false;
  }
  if (onRingBoundary(point, polygon[0], epsilon)) return true;
  return insideRing(point, polygon[0]);
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

export function calculateEarthwork(input: CalculateEarthworkInput): EarthworkResult {
  if (!input.verticalDatumConfirmed) fail("EARTHWORK_VERTICAL_DATUM_UNCONFIRMED");
  assertRaster(input.raster);
  if (!finite(input.designElevationMeters) || input.designElevationMeters < MIN_ELEVATION || input.designElevationMeters > MAX_ELEVATION) {
    fail("EARTHWORK_NUMERIC_INVALID");
  }
  const boundary = normalizeEarthworkBoundary(input.boundary);
  const projected = projectBoundary(boundary, input.raster);
  const epsilon = Math.max(1e-8, Math.min(input.raster.scaleX, input.raster.scaleY) * 1e-7);
  const cellArea = input.raster.scaleX * input.raster.scaleY;
  const cut = new KahanSum();
  const fill = new KahanSum();
  let includedCells = 0;

  for (let row = 0; row < input.raster.height; row += 1) {
    const y = input.raster.tieY - (row + 0.5 - input.raster.tieJ) * input.raster.scaleY;
    for (let column = 0; column < input.raster.width; column += 1) {
      const elevation = input.raster.values[row * input.raster.width + column];
      if (input.raster.nodata !== null && elevation === input.raster.nodata) continue;
      if (!finite(elevation) || elevation < MIN_ELEVATION || elevation > MAX_ELEVATION) {
        fail("EARTHWORK_SAMPLE_UNSUPPORTED");
      }
      const x = input.raster.tieX + (column + 0.5 - input.raster.tieI) * input.raster.scaleX;
      const point: Point2D = [x, y];
      if (!projected.some((polygon) => insidePolygon(point, polygon, epsilon))) continue;
      includedCells += 1;
      const delta = elevation - input.designElevationMeters;
      if (Math.abs(delta) > 11_000) fail("EARTHWORK_NUMERIC_INVALID");
      if (delta > 0) cut.add(delta * cellArea);
      else if (delta < 0) fill.add(-delta * cellArea);
    }
  }

  if (includedCells === 0) fail("EARTHWORK_EMPTY_SELECTION");
  const cutValue = cut.value();
  const fillValue = fill.value();
  const netValue = cutValue - fillValue;
  const includedArea = includedCells * cellArea;
  if (
    !Number.isSafeInteger(includedCells) ||
    !finite(cutValue) ||
    !finite(fillValue) ||
    !finite(netValue) ||
    !finite(includedArea) ||
    cutValue < 0 ||
    fillValue < 0 ||
    cutValue > MAX_VOLUME ||
    fillValue > MAX_VOLUME ||
    includedArea <= 0 ||
    includedArea > MAX_INCLUDED_AREA
  ) {
    fail("EARTHWORK_NUMERIC_INVALID");
  }

  return {
    boundary,
    summary: {
      schema: EARTHWORK_SCHEMA,
      sourceFormat: "GeoTIFF DEM",
      sourceCrs: input.raster.sourceCrs,
      verticalDatumPolicy: EARTHWORK_VERTICAL_DATUM_POLICY,
      designElevationMeters: input.designElevationMeters,
      cellAreaSquareMeters: cellArea,
      includedCells,
      includedAreaSquareMeters: includedArea,
      cutCubicMeters: cutValue,
      fillCubicMeters: fillValue,
      netCubicMeters: netValue,
      method: EARTHWORK_METHOD,
    },
  };
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-6, Math.abs(right) * 1e-12);
}

export function validateEarthworkSummary(value: unknown): EarthworkSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("EARTHWORK_NUMERIC_INVALID");
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (
    keys.length !== SORTED_SUMMARY_KEYS.length ||
    !keys.every((key, index) => key === SORTED_SUMMARY_KEYS[index])
  ) {
    fail("EARTHWORK_NUMERIC_INVALID");
  }
  if (
    raw.schema !== EARTHWORK_SCHEMA ||
    raw.sourceFormat !== "GeoTIFF DEM" ||
    (raw.sourceCrs !== "EPSG:5179" && raw.sourceCrs !== "EPSG:5186") ||
    raw.verticalDatumPolicy !== EARTHWORK_VERTICAL_DATUM_POLICY ||
    raw.method !== EARTHWORK_METHOD ||
    !finite(raw.designElevationMeters) ||
    raw.designElevationMeters < MIN_ELEVATION ||
    raw.designElevationMeters > MAX_ELEVATION ||
    !finite(raw.cellAreaSquareMeters) ||
    raw.cellAreaSquareMeters < 0.0001 ||
    raw.cellAreaSquareMeters > 10_000 ||
    !Number.isSafeInteger(raw.includedCells) ||
    (raw.includedCells as number) < 1 ||
    (raw.includedCells as number) > EARTHWORK_MAX_PIXELS ||
    !finite(raw.includedAreaSquareMeters) ||
    raw.includedAreaSquareMeters <= 0 ||
    raw.includedAreaSquareMeters > MAX_INCLUDED_AREA ||
    !finite(raw.cutCubicMeters) ||
    raw.cutCubicMeters < 0 ||
    raw.cutCubicMeters > MAX_VOLUME ||
    !finite(raw.fillCubicMeters) ||
    raw.fillCubicMeters < 0 ||
    raw.fillCubicMeters > MAX_VOLUME ||
    !finite(raw.netCubicMeters) ||
    !approximatelyEqual(
      raw.includedAreaSquareMeters,
      (raw.includedCells as number) * raw.cellAreaSquareMeters,
    ) ||
    !approximatelyEqual(raw.netCubicMeters, raw.cutCubicMeters - raw.fillCubicMeters)
  ) {
    fail("EARTHWORK_NUMERIC_INVALID");
  }
  return {
    schema: EARTHWORK_SCHEMA,
    sourceFormat: "GeoTIFF DEM",
    sourceCrs: raw.sourceCrs,
    verticalDatumPolicy: EARTHWORK_VERTICAL_DATUM_POLICY,
    designElevationMeters: raw.designElevationMeters,
    cellAreaSquareMeters: raw.cellAreaSquareMeters,
    includedCells: raw.includedCells as number,
    includedAreaSquareMeters: raw.includedAreaSquareMeters,
    cutCubicMeters: raw.cutCubicMeters,
    fillCubicMeters: raw.fillCubicMeters,
    netCubicMeters: raw.netCubicMeters,
    method: EARTHWORK_METHOD,
  };
}

export function normalizeEarthworkResult(value: unknown): EarthworkResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("EARTHWORK_FAILED");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !("boundary" in raw) || !("summary" in raw)) {
    fail("EARTHWORK_FAILED");
  }
  return {
    boundary: normalizeEarthworkBoundary(raw.boundary),
    summary: validateEarthworkSummary(raw.summary),
  };
}

export function buildEarthworkLayer(result: EarthworkResult): GeoLibreLayer {
  const normalized = normalizeEarthworkResult(result);
  const boundary = normalized.boundary;
  const featureCollection: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: boundary, properties: {} }],
  };
  return {
    id: crypto.randomUUID(),
    name: EARTHWORK_RESULT_NAME,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: "#f59e0b",
      strokeColor: "#b45309",
      fillOpacity: 0.25,
      strokeWidth: 2,
    },
    metadata: {
      customLayerType: "earthwork-analysis",
      excludeFromHistory: true,
      earthworkAnalysis: { ...normalized.summary },
    },
    geojson: featureCollection,
  };
}
