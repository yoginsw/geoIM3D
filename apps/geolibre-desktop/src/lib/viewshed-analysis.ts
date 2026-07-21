import booleanIntersects from "@turf/boolean-intersects";
import booleanValid from "@turf/boolean-valid";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type {
  Feature,
  FeatureCollection,
  GeometryCollection,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import {
  VIEWSHED_ANALYSIS_OBJECT_RESERVE_BYTES,
  VIEWSHED_RUNTIME_RESERVE_BYTES,
  ViewshedMemoryLedger,
} from "./viewshed-memory";
import {
  transformLocalCrsPoint,
  type KoreanProjectedCrs,
  type LocalCrs,
} from "./local-crs";

export const VIEWSHED_SCHEMA = "geoim3d-viewshed-v1" as const;
export const VIEWSHED_METHOD = "grid-positive-interval-dda-los-v1" as const;
export const VIEWSHED_MODEL = "planar-cell-column" as const;
export const VIEWSHED_AREA_MODEL = "selected-full-cell-footprint" as const;
export const VIEWSHED_RESULT_NAME = "가시권 분석";
export const VIEWSHED_MAX_INPUT_BYTES = 48 * 1024 * 1024;
export const VIEWSHED_MAX_CANDIDATE_CELLS = 250_000;
export const VIEWSHED_MAX_DDA_VISITS = 50_000_000;

export const VIEWSHED_MAX_PIXELS = 5_000_000;
const MAX_PIXELS = VIEWSHED_MAX_PIXELS;
const MAX_INPUT_COORDINATES = 20_000;
const MAX_PROJECTED_COORDINATES = 200_000;
const MAX_DENSIFY_DEPTH = 20;
const MAX_COORDINATE_ABS = 10_000_000;
const MIN_ELEVATION = -1_000;
const MAX_ELEVATION = 10_000;
const MAX_VISIBLE_RUNS = 20_000;

type Point2D = [number, number];
type ProjectedRing = Point2D[];
type ProjectedPolygon = ProjectedRing[];
export type ViewshedBoundary = Polygon | MultiPolygon;
export type ViewshedClassification = "visible" | "occluded" | "unknown";

export interface ViewshedRaster {
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

export interface ViewshedSummary {
  schema: typeof VIEWSHED_SCHEMA;
  method: typeof VIEWSHED_METHOD;
  model: typeof VIEWSHED_MODEL;
  areaModel: typeof VIEWSHED_AREA_MODEL;
  sourceCrs: KoreanProjectedCrs;
  observerHeightMeters: number;
  targetHeightMeters: number;
  maximumRadiusMeters: number;
  cellAreaSquareMeters: number;
  candidateCells: number;
  visibleCells: number;
  occludedCells: number;
  unknownCells: number;
  evaluatedCells: number;
  visibleAreaSquareMeters: number;
  occludedAreaSquareMeters: number;
  unknownAreaSquareMeters: number;
  visiblePercentage: number;
  visibleRunCount: number;
  visibleRunLengths: number[];
}

export interface ViewshedResult {
  boundary: ViewshedBoundary;
  observer: Point;
  visibleRuns: GeometryCollection<Polygon>;
  summary: ViewshedSummary;
}

export interface CalculateViewshedInput {
  raster: ViewshedRaster;
  boundary: ViewshedBoundary;
  observer: Position;
  observerHeightMeters: number;
  targetHeightMeters: number;
  maximumRadiusMeters: number;
}

function fail(code: string): never {
  throw new Error(code);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalNumber(value: number): number {
  if (Object.is(value, -0)) return 0;
  if (value === -180) return 180;
  return value;
}

function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function comparePoint(a: readonly number[], b: readonly number[]): number {
  return a[0] - b[0] || a[1] - b[1];
}

function compareSequence(
  a: readonly Position[],
  b: readonly Position[]
): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const compared = comparePoint(a[index], b[index]);
    if (compared !== 0) return compared;
  }
  return a.length - b.length;
}

function signedArea(ring: readonly Position[]): number {
  let sum = 0;
  let compensation = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const term =
      ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
    const adjusted = term - compensation;
    const next = sum + adjusted;
    // Standard Kahan update: c = (t - sum) - y.
    compensation = next - sum - adjusted;
    sum = next;
  }
  return sum / 2;
}

function canonicalRotation(points: Position[]): Position[] {
  let best: Position[] | null = null;
  for (let start = 0; start < points.length; start += 1) {
    const rotated = points.slice(start).concat(points.slice(0, start));
    if (best === null || compareSequence(rotated, best) < 0) best = rotated;
  }
  return best!;
}

function normalizeRing(
  value: unknown,
  exterior: boolean,
  count: { value: number }
): Position[] {
  if (!Array.isArray(value) || value.length < 3)
    fail("VIEWSHED_BOUNDARY_INVALID");
  const points: Position[] = [];
  for (const candidate of value) {
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 2 ||
      !finite(candidate[0]) ||
      !finite(candidate[1]) ||
      candidate[0] < -180 ||
      candidate[0] > 180 ||
      candidate[1] < -90 ||
      candidate[1] > 90
    )
      fail("VIEWSHED_BOUNDARY_INVALID");
    const point: Position = [
      canonicalNumber(candidate[0]),
      canonicalNumber(candidate[1]),
    ];
    count.value += 1;
    if (count.value > MAX_INPUT_COORDINATES) fail("VIEWSHED_LIMIT_EXCEEDED");
    if (points.length === 0 || !samePoint(points.at(-1)!, point))
      points.push(point);
  }
  while (points.length > 1 && samePoint(points.at(-1)!, points[0]))
    points.pop();
  if (points.length < 3) fail("VIEWSHED_BOUNDARY_INVALID");
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (samePoint(points[left], points[right]))
        fail("VIEWSHED_BOUNDARY_INVALID");
    }
    const next = points[(left + 1) % points.length];
    if (Math.abs(points[left][0] - next[0]) > 180)
      fail("VIEWSHED_BOUNDARY_INVALID");
  }
  let closed = [...points, points[0]];
  const area = signedArea(closed);
  if (!finite(area) || area === 0) fail("VIEWSHED_BOUNDARY_INVALID");
  const shouldReverse = exterior ? area < 0 : area > 0;
  let oriented = shouldReverse ? [...points].reverse() : points;
  oriented = canonicalRotation(oriented);
  closed = [...oriented, oriented[0]];
  return closed;
}

function geometryFeature<T extends ViewshedBoundary>(geometry: T): Feature<T> {
  return { type: "Feature", geometry, properties: {} };
}

function polygonKey(polygon: Position[][]): string {
  return JSON.stringify(polygon);
}

export function normalizeViewshedBoundary(value: unknown): ViewshedBoundary {
  if (!value || typeof value !== "object") fail("VIEWSHED_BOUNDARY_INVALID");
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (
    Object.keys(value).length !== 2 ||
    !("type" in value) ||
    !("coordinates" in value)
  ) {
    fail("VIEWSHED_BOUNDARY_INVALID");
  }
  const count = { value: 0 };
  let polygons: Position[][][];
  if (candidate.type === "Polygon" && Array.isArray(candidate.coordinates)) {
    polygons = [candidate.coordinates as unknown as Position[][]];
  } else if (
    candidate.type === "MultiPolygon" &&
    Array.isArray(candidate.coordinates)
  ) {
    polygons = candidate.coordinates as unknown as Position[][][];
  } else {
    fail("VIEWSHED_BOUNDARY_INVALID");
  }
  if (polygons.length === 0) fail("VIEWSHED_BOUNDARY_INVALID");
  const normalized = polygons.map((polygon) => {
    if (!Array.isArray(polygon) || polygon.length === 0)
      fail("VIEWSHED_BOUNDARY_INVALID");
    const exterior = normalizeRing(polygon[0], true, count);
    const holes = polygon
      .slice(1)
      .map((ring) => normalizeRing(ring, false, count));
    holes.sort((a, b) => compareSequence(a, b));
    return [exterior, ...holes];
  });
  normalized.sort((a, b) => polygonKey(a).localeCompare(polygonKey(b), "en"));
  const geometry: ViewshedBoundary =
    candidate.type === "Polygon"
      ? { type: "Polygon", coordinates: normalized[0] }
      : { type: "MultiPolygon", coordinates: normalized };
  if (!booleanValid(geometryFeature(geometry)))
    fail("VIEWSHED_BOUNDARY_INVALID");
  if (geometry.type === "MultiPolygon") {
    for (let left = 0; left < geometry.coordinates.length; left += 1) {
      for (
        let right = left + 1;
        right < geometry.coordinates.length;
        right += 1
      ) {
        if (
          booleanIntersects(
            geometryFeature({
              type: "Polygon",
              coordinates: geometry.coordinates[left],
            }),
            geometryFeature({
              type: "Polygon",
              coordinates: geometry.coordinates[right],
            })
          )
        )
          fail("VIEWSHED_BOUNDARY_INVALID");
      }
    }
  }
  return geometry;
}

export function transformViewshedPoint(
  point: readonly number[],
  source: LocalCrs,
  target: LocalCrs
): Point2D {
  if (
    !finite(point[0]) ||
    !finite(point[1]) ||
    (source !== "EPSG:4326" &&
      (Math.abs(point[0]) > 10_000_000 || Math.abs(point[1]) > 10_000_000))
  )
    fail("VIEWSHED_TRANSFORM_UNSUPPORTED");
  let transformed: [number, number];
  try {
    transformed = transformLocalCrsPoint([point[0], point[1]], source, target);
  } catch {
    fail("VIEWSHED_CRS_UNSUPPORTED");
  }
  if (
    !finite(transformed[0]) ||
    !finite(transformed[1]) ||
    (target !== "EPSG:4326" &&
      (Math.abs(transformed[0]) > 10_000_000 ||
        Math.abs(transformed[1]) > 10_000_000))
  )
    fail("VIEWSHED_TRANSFORM_UNSUPPORTED");
  return [canonicalNumber(transformed[0]), canonicalNumber(transformed[1])];
}

function assertRaster(raster: ViewshedRaster): void {
  if (
    !Number.isSafeInteger(raster.width) ||
    !Number.isSafeInteger(raster.height) ||
    raster.width < 1 ||
    raster.height < 1 ||
    raster.width > 10_000 ||
    raster.height > 10_000
  )
    fail("VIEWSHED_LIMIT_EXCEEDED");
  const pixels = raster.width * raster.height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_PIXELS ||
    raster.values.length !== pixels
  ) {
    fail("VIEWSHED_LIMIT_EXCEEDED");
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
  )
    fail("VIEWSHED_TRANSFORM_UNSUPPORTED");
  const coordinates = [
    raster.tieX - raster.tieI * raster.scaleX,
    raster.tieX + (raster.width - raster.tieI) * raster.scaleX,
    raster.tieY + raster.tieJ * raster.scaleY,
    raster.tieY - (raster.height - raster.tieJ) * raster.scaleY,
  ];
  if (
    coordinates.some(
      (coordinate) =>
        !finite(coordinate) || Math.abs(coordinate) > MAX_COORDINATE_ABS
    )
  ) {
    fail("VIEWSHED_LIMIT_EXCEEDED");
  }
  if (raster.sourceCrs !== "EPSG:5179" && raster.sourceCrs !== "EPSG:5186") {
    fail("VIEWSHED_CRS_UNSUPPORTED");
  }
  if (raster.nodata !== null && !finite(raster.nodata))
    fail("VIEWSHED_SAMPLE_UNSUPPORTED");
}

function pointLineDistance(
  point: Point2D,
  start: Point2D,
  end: Point2D
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  if (denominator === 0)
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator
    )
  );
  return Math.hypot(
    point[0] - (start[0] + t * dx),
    point[1] - (start[1] + t * dy)
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
  count: { value: number }
): void {
  const midpointWgs: Point2D = [
    (startWgs[0] + endWgs[0]) / 2,
    (startWgs[1] + endWgs[1]) / 2,
  ];
  const midpointProjected = transformViewshedPoint(
    midpointWgs,
    "EPSG:4326",
    crs
  );
  if (
    pointLineDistance(midpointProjected, startProjected, endProjected) <=
    tolerance
  ) {
    output.push(endProjected);
    count.value += 1;
    if (count.value > MAX_PROJECTED_COORDINATES)
      fail("VIEWSHED_LIMIT_EXCEEDED");
    return;
  }
  if (depth >= MAX_DENSIFY_DEPTH) fail("VIEWSHED_LIMIT_EXCEEDED");
  densifyEdge(
    startWgs,
    midpointWgs,
    startProjected,
    midpointProjected,
    crs,
    tolerance,
    depth + 1,
    output,
    count
  );
  densifyEdge(
    midpointWgs,
    endWgs,
    midpointProjected,
    endProjected,
    crs,
    tolerance,
    depth + 1,
    output,
    count
  );
}

function projectBoundary(
  boundary: ViewshedBoundary,
  raster: ViewshedRaster
): ProjectedPolygon[] {
  const polygons =
    boundary.type === "Polygon" ? [boundary.coordinates] : boundary.coordinates;
  const count = { value: 0 };
  const tolerance = Math.min(
    0.01,
    Math.min(raster.scaleX, raster.scaleY) * 0.01
  );
  return polygons.map((polygon) =>
    polygon.map((ring) => {
      const output: Point2D[] = [];
      const first = transformViewshedPoint(
        ring[0],
        "EPSG:4326",
        raster.sourceCrs
      );
      output.push(first);
      count.value += 1;
      for (let index = 0; index < ring.length - 1; index += 1) {
        const start = transformViewshedPoint(
          ring[index],
          "EPSG:4326",
          raster.sourceCrs
        );
        const end = transformViewshedPoint(
          ring[index + 1],
          "EPSG:4326",
          raster.sourceCrs
        );
        densifyEdge(
          ring[index],
          ring[index + 1],
          start,
          end,
          raster.sourceCrs,
          tolerance,
          0,
          output,
          count
        );
      }
      return output;
    })
  );
}

const RING_BOUNDARY_TOLERANCE_METERS = 1e-7;

function pointOnSegment(point: Point2D, start: Point2D, end: Point2D): boolean {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) {
    return (
      Math.hypot(point[0] - start[0], point[1] - start[1]) <=
      RING_BOUNDARY_TOLERANCE_METERS
    );
  }
  const pointX = point[0] - start[0];
  const pointY = point[1] - start[1];
  const cross = pointX * deltaY - pointY * deltaX;
  if (Math.abs(cross) > RING_BOUNDARY_TOLERANCE_METERS * length) return false;
  const projection = pointX * deltaX + pointY * deltaY;
  const lengthSquared = length * length;
  const projectionTolerance = RING_BOUNDARY_TOLERANCE_METERS * length;
  return (
    projection >= -projectionTolerance &&
    projection <= lengthSquared + projectionTolerance
  );
}

type RingContainment = "outside" | "inside" | "boundary";

function classifyRingContainment(
  point: Point2D,
  ring: ProjectedRing
): RingContainment {
  let inside = false;
  for (
    let current = 0, previous = ring.length - 2;
    current < ring.length - 1;
    previous = current, current += 1
  ) {
    const a = ring[current];
    const b = ring[previous];
    if (pointOnSegment(point, a, b)) return "boundary";
    if (a[1] > point[1] !== b[1] > point[1]) {
      const crossing =
        ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (point[0] < crossing) inside = !inside;
    }
  }
  return inside ? "inside" : "outside";
}

function insidePolygon(point: Point2D, polygon: ProjectedPolygon): boolean {
  if (classifyRingContainment(point, polygon[0]) !== "inside") return false;
  for (let index = 1; index < polygon.length; index += 1) {
    if (classifyRingContainment(point, polygon[index]) !== "outside")
      return false;
  }
  return true;
}

function isNoData(value: number, nodata: number | null): boolean {
  return nodata !== null && canonicalNumber(value) === canonicalNumber(nodata);
}

export function classifyViewshedTarget(
  raster: ViewshedRaster,
  observerRow: number,
  observerColumn: number,
  targetRow: number,
  targetColumn: number,
  observerHeightMeters: number,
  targetHeightMeters: number,
  maximumVisitedCells = Number.POSITIVE_INFINITY
): { classification: ViewshedClassification; visitedCells: number } {
  const targetValue = raster.values[targetRow * raster.width + targetColumn];
  if (isNoData(targetValue, raster.nodata))
    return { classification: "unknown", visitedCells: 0 };
  if (observerRow === targetRow && observerColumn === targetColumn) {
    return { classification: "visible", visitedCells: 0 };
  }
  const observerValue =
    raster.values[observerRow * raster.width + observerColumn];
  if (isNoData(observerValue, raster.nodata)) fail("VIEWSHED_OBSERVER_INVALID");
  const observerZ = observerValue + observerHeightMeters;
  const targetZ = targetValue + targetHeightMeters;
  const deltaColumn = targetColumn - observerColumn;
  const deltaRow = targetRow - observerRow;
  const stepColumn = Math.sign(deltaColumn);
  const stepRow = Math.sign(deltaRow);
  const deltaTColumn =
    deltaColumn === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(deltaColumn);
  const deltaTRow =
    deltaRow === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(deltaRow);
  let nextColumnT =
    deltaColumn === 0 ? Number.POSITIVE_INFINITY : 0.5 / Math.abs(deltaColumn);
  let nextRowT =
    deltaRow === 0 ? Number.POSITIVE_INFINITY : 0.5 / Math.abs(deltaRow);
  let row = observerRow;
  let column = observerColumn;
  let visitedCells = 0;
  let blocked = false;
  let unknown = false;
  const ascending = targetZ >= observerZ;

  while (row !== targetRow || column !== targetColumn) {
    const enter = Math.min(nextColumnT, nextRowT, 1);
    if (nextColumnT < nextRowT) {
      column += stepColumn;
      nextColumnT += deltaTColumn;
    } else if (nextRowT < nextColumnT) {
      row += stepRow;
      nextRowT += deltaTRow;
    } else {
      column += stepColumn;
      row += stepRow;
      nextColumnT += deltaTColumn;
      nextRowT += deltaTRow;
    }
    if (row === targetRow && column === targetColumn) break;
    const exit = Math.min(nextColumnT, nextRowT, 1);
    if (!(enter < exit)) continue;
    if (visitedCells === maximumVisitedCells) fail("VIEWSHED_LIMIT_EXCEEDED");
    visitedCells += 1;
    const terrain = raster.values[row * raster.width + column];
    if (isNoData(terrain, raster.nodata)) {
      unknown = true;
      continue;
    }
    const worst = ascending ? enter : exit;
    const lineHeight = observerZ + (targetZ - observerZ) * worst;
    if (terrain >= lineHeight) blocked = true;
  }
  return {
    classification: unknown ? "unknown" : blocked ? "occluded" : "visible",
    visitedCells,
  };
}

function densifyInverseEdge(
  startProjected: Point2D,
  endProjected: Point2D,
  startWgs: Point2D,
  endWgs: Point2D,
  crs: KoreanProjectedCrs,
  tolerance: number,
  depth: number,
  output: Position[],
  count: { value: number }
): void {
  const projectedMidpoint: Point2D = [
    (startProjected[0] + endProjected[0]) / 2,
    (startProjected[1] + endProjected[1]) / 2,
  ];
  const wgsMidpoint = transformViewshedPoint(
    projectedMidpoint,
    crs,
    "EPSG:4326"
  );
  const wgsChordMidpoint: Point2D = [
    (startWgs[0] + endWgs[0]) / 2,
    (startWgs[1] + endWgs[1]) / 2,
  ];
  const projectedChordMidpoint = transformViewshedPoint(
    wgsChordMidpoint,
    "EPSG:4326",
    crs
  );
  if (
    Math.hypot(
      projectedChordMidpoint[0] - projectedMidpoint[0],
      projectedChordMidpoint[1] - projectedMidpoint[1]
    ) <= tolerance
  ) {
    output.push(endWgs);
    count.value += 1;
    if (count.value > MAX_PROJECTED_COORDINATES)
      fail("VIEWSHED_RESULT_TOO_COMPLEX");
    return;
  }
  if (depth >= MAX_DENSIFY_DEPTH) fail("VIEWSHED_RESULT_TOO_COMPLEX");
  densifyInverseEdge(
    startProjected,
    projectedMidpoint,
    startWgs,
    wgsMidpoint,
    crs,
    tolerance,
    depth + 1,
    output,
    count
  );
  densifyInverseEdge(
    projectedMidpoint,
    endProjected,
    wgsMidpoint,
    endWgs,
    crs,
    tolerance,
    depth + 1,
    output,
    count
  );
}

function wgsRunPolygon(
  raster: ViewshedRaster,
  row: number,
  startColumn: number,
  endColumnExclusive: number,
  coordinateCount: { value: number }
): Polygon {
  const west = raster.tieX + (startColumn - raster.tieI) * raster.scaleX;
  const east = raster.tieX + (endColumnExclusive - raster.tieI) * raster.scaleX;
  const north = raster.tieY - (row - raster.tieJ) * raster.scaleY;
  const south = raster.tieY - (row + 1 - raster.tieJ) * raster.scaleY;
  const projected: Point2D[] = [
    [west, north],
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
  const wgs = projected.map((point) =>
    transformViewshedPoint(point, raster.sourceCrs, "EPSG:4326")
  );
  const ring: Position[] = [wgs[0]];
  coordinateCount.value += 1;
  const tolerance = Math.min(
    0.01,
    Math.min(raster.scaleX, raster.scaleY) * 0.01
  );
  for (let index = 0; index < 4; index += 1) {
    densifyInverseEdge(
      projected[index],
      projected[index + 1],
      wgs[index],
      wgs[index + 1],
      raster.sourceCrs,
      tolerance,
      0,
      ring,
      coordinateCount
    );
  }
  if (signedArea(ring) <= 0) fail("VIEWSHED_NUMERIC_INVALID");
  return { type: "Polygon", coordinates: [ring] };
}

export function calculateViewshed(
  input: CalculateViewshedInput,
  ledger = new ViewshedMemoryLedger()
): ViewshedResult {
  ledger.reserve("runtime", VIEWSHED_RUNTIME_RESERVE_BYTES);
  ledger.reserve("analysis-objects", VIEWSHED_ANALYSIS_OBJECT_RESERVE_BYTES);
  assertRaster(input.raster);
  if (
    !finite(input.observerHeightMeters) ||
    input.observerHeightMeters < 0.1 ||
    input.observerHeightMeters > 100 ||
    !finite(input.targetHeightMeters) ||
    input.targetHeightMeters < 0 ||
    input.targetHeightMeters > 100 ||
    !finite(input.maximumRadiusMeters) ||
    input.maximumRadiusMeters <
      Math.max(input.raster.scaleX, input.raster.scaleY) ||
    input.maximumRadiusMeters > 10_000
  )
    fail("VIEWSHED_PARAMETER_INVALID");
  for (let index = 0; index < input.raster.values.length; index += 1) {
    const value = canonicalNumber(input.raster.values[index]);
    if (isNoData(value, input.raster.nodata)) continue;
    if (!finite(value) || value < MIN_ELEVATION || value > MAX_ELEVATION) {
      fail("VIEWSHED_SAMPLE_UNSUPPORTED");
    }
  }
  const boundary = normalizeViewshedBoundary(input.boundary);
  const projectedBoundary = projectBoundary(boundary, input.raster);
  if (
    !Array.isArray(input.observer) ||
    input.observer.length !== 2 ||
    !finite(input.observer[0]) ||
    !finite(input.observer[1]) ||
    input.observer[0] < -180 ||
    input.observer[0] > 180 ||
    input.observer[1] < -90 ||
    input.observer[1] > 90
  )
    fail("VIEWSHED_OBSERVER_INVALID");
  const observerCoordinates: Point2D = [
    canonicalNumber(input.observer[0]),
    canonicalNumber(input.observer[1]),
  ];
  const projectedObserver = transformViewshedPoint(
    observerCoordinates,
    "EPSG:4326",
    input.raster.sourceCrs
  );
  if (
    !projectedBoundary.some((polygon) =>
      insidePolygon(projectedObserver, polygon)
    )
  ) {
    fail("VIEWSHED_OBSERVER_INVALID");
  }
  const observerColumn = Math.floor(
    input.raster.tieI +
      (projectedObserver[0] - input.raster.tieX) / input.raster.scaleX
  );
  const observerRow = Math.floor(
    input.raster.tieJ +
      (input.raster.tieY - projectedObserver[1]) / input.raster.scaleY
  );
  if (
    observerRow < 0 ||
    observerColumn < 0 ||
    observerRow >= input.raster.height ||
    observerColumn >= input.raster.width ||
    isNoData(
      input.raster.values[observerRow * input.raster.width + observerColumn],
      input.raster.nodata
    )
  )
    fail("VIEWSHED_OBSERVER_INVALID");

  const stateBytes = input.raster.width * input.raster.height;
  if (!Number.isSafeInteger(stateBytes)) fail("VIEWSHED_LIMIT_EXCEEDED");
  ledger.reserve("visibility", stateBytes);
  const state = new Uint8Array(stateBytes);
  const observerCenterX =
    input.raster.tieX +
    (observerColumn + 0.5 - input.raster.tieI) * input.raster.scaleX;
  const observerCenterY =
    input.raster.tieY -
    (observerRow + 0.5 - input.raster.tieJ) * input.raster.scaleY;
  const radiusSquared = input.maximumRadiusMeters * input.maximumRadiusMeters;
  let candidateCells = 0;
  let visibleCells = 0;
  let occludedCells = 0;
  let unknownCells = 0;
  let ddaVisits = 0;

  for (let row = 0; row < input.raster.height; row += 1) {
    const y =
      input.raster.tieY - (row + 0.5 - input.raster.tieJ) * input.raster.scaleY;
    for (let column = 0; column < input.raster.width; column += 1) {
      const x =
        input.raster.tieX +
        (column + 0.5 - input.raster.tieI) * input.raster.scaleX;
      if (!projectedBoundary.some((polygon) => insidePolygon([x, y], polygon)))
        continue;
      const dx = x - observerCenterX;
      const dy = y - observerCenterY;
      if (dx * dx + dy * dy > radiusSquared) continue;
      if (candidateCells === VIEWSHED_MAX_CANDIDATE_CELLS)
        fail("VIEWSHED_LIMIT_EXCEEDED");
      candidateCells += 1;
      const classification = classifyViewshedTarget(
        input.raster,
        observerRow,
        observerColumn,
        row,
        column,
        input.observerHeightMeters,
        input.targetHeightMeters,
        VIEWSHED_MAX_DDA_VISITS - ddaVisits
      );
      ddaVisits += classification.visitedCells;
      const index = row * input.raster.width + column;
      if (classification.classification === "visible") {
        state[index] = 1;
        visibleCells += 1;
      } else if (classification.classification === "occluded") {
        state[index] = 2;
        occludedCells += 1;
      } else {
        state[index] = 3;
        unknownCells += 1;
      }
    }
  }
  if (candidateCells === 0) fail("VIEWSHED_EMPTY_SELECTION");
  const evaluatedCells = visibleCells + occludedCells;
  if (evaluatedCells === 0) fail("VIEWSHED_EMPTY_EVALUATION");

  const geometries: Polygon[] = [];
  const visibleRunLengths: number[] = [];
  const outputCoordinateCount = { value: 0 };
  for (let row = 0; row < input.raster.height; row += 1) {
    let column = 0;
    while (column < input.raster.width) {
      if (state[row * input.raster.width + column] !== 1) {
        column += 1;
        continue;
      }
      const start = column;
      while (
        column < input.raster.width &&
        state[row * input.raster.width + column] === 1
      ) {
        column += 1;
      }
      if (geometries.length === MAX_VISIBLE_RUNS)
        fail("VIEWSHED_RESULT_TOO_COMPLEX");
      geometries.push(
        wgsRunPolygon(input.raster, row, start, column, outputCoordinateCount)
      );
      visibleRunLengths.push(column - start);
    }
  }
  const cellArea = input.raster.scaleX * input.raster.scaleY;
  const summary: ViewshedSummary = {
    schema: VIEWSHED_SCHEMA,
    method: VIEWSHED_METHOD,
    model: VIEWSHED_MODEL,
    areaModel: VIEWSHED_AREA_MODEL,
    sourceCrs: input.raster.sourceCrs,
    observerHeightMeters: input.observerHeightMeters,
    targetHeightMeters: input.targetHeightMeters,
    maximumRadiusMeters: input.maximumRadiusMeters,
    cellAreaSquareMeters: cellArea,
    candidateCells,
    visibleCells,
    occludedCells,
    unknownCells,
    evaluatedCells,
    visibleAreaSquareMeters: visibleCells * cellArea,
    occludedAreaSquareMeters: occludedCells * cellArea,
    unknownAreaSquareMeters: unknownCells * cellArea,
    visiblePercentage: (visibleCells / evaluatedCells) * 100,
    visibleRunCount: geometries.length,
    visibleRunLengths,
  };
  return {
    boundary,
    observer: { type: "Point", coordinates: observerCoordinates },
    visibleRuns: { type: "GeometryCollection", geometries },
    summary,
  };
}

const SUMMARY_KEYS = [
  "schema",
  "method",
  "model",
  "areaModel",
  "sourceCrs",
  "observerHeightMeters",
  "targetHeightMeters",
  "maximumRadiusMeters",
  "cellAreaSquareMeters",
  "candidateCells",
  "visibleCells",
  "occludedCells",
  "unknownCells",
  "evaluatedCells",
  "visibleAreaSquareMeters",
  "occludedAreaSquareMeters",
  "unknownAreaSquareMeters",
  "visiblePercentage",
  "visibleRunCount",
  "visibleRunLengths",
] as const;

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCanonicalVisibleRun(
  polygon: Polygon,
  sourceCrs: KoreanProjectedCrs,
  runLength: number,
  cellArea: number
): boolean {
  const ring = polygon.coordinates[0];
  const projected = ring.map((position) =>
    transformViewshedPoint(position, "EPSG:4326", sourceCrs)
  );
  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const west = Math.min(...xs);
  const east = Math.max(...xs);
  const south = Math.min(...ys);
  const north = Math.max(...ys);
  const width = east - west;
  const height = north - south;
  if (!(width > 0) || !(height > 0)) return false;
  const tolerance = Math.max(1e-6, Math.max(width, height) * 1e-9);
  const close = (left: number, right: number) =>
    Math.abs(left - right) <= tolerance;
  if (
    !close(projected[0][0], west) ||
    !close(projected[0][1], north) ||
    Math.abs((width / runLength) * height - cellArea) >
      Math.max(1e-6, cellArea * 1e-9)
  )
    return false;
  let phase = 0;
  let previous = projected[0];
  for (let index = 1; index < projected.length; index += 1) {
    const point = projected[index];
    if (phase === 0) {
      if (!close(point[0], west) || point[1] > previous[1] + tolerance)
        return false;
      if (close(point[1], south)) phase = 1;
    } else if (phase === 1) {
      if (!close(point[1], south) || point[0] < previous[0] - tolerance)
        return false;
      if (close(point[0], east)) phase = 2;
    } else if (phase === 2) {
      if (!close(point[0], east) || point[1] < previous[1] - tolerance)
        return false;
      if (close(point[1], north)) phase = 3;
    } else if (!close(point[1], north) || point[0] > previous[0] + tolerance) {
      return false;
    }
    previous = point;
  }
  return phase === 3 && close(previous[0], west) && close(previous[1], north);
}

export function normalizeViewshedResult(value: unknown): ViewshedResult {
  const record = asRecord(value);
  if (
    !record ||
    !exactKeys(record, ["boundary", "observer", "visibleRuns", "summary"])
  ) {
    fail("VIEWSHED_PROJECT_INVALID");
  }
  let boundary: ViewshedBoundary;
  try {
    boundary = normalizeViewshedBoundary(record.boundary);
  } catch {
    fail("VIEWSHED_PROJECT_INVALID");
  }
  const observerRecord = asRecord(record.observer);
  if (
    !observerRecord ||
    !exactKeys(observerRecord, ["type", "coordinates"]) ||
    observerRecord.type !== "Point" ||
    !Array.isArray(observerRecord.coordinates) ||
    observerRecord.coordinates.length !== 2 ||
    !finite(observerRecord.coordinates[0]) ||
    !finite(observerRecord.coordinates[1]) ||
    observerRecord.coordinates[0] < -180 ||
    observerRecord.coordinates[0] > 180 ||
    observerRecord.coordinates[1] < -90 ||
    observerRecord.coordinates[1] > 90
  )
    fail("VIEWSHED_PROJECT_INVALID");
  const observer: Point = {
    type: "Point",
    coordinates: [
      canonicalNumber(observerRecord.coordinates[0]),
      canonicalNumber(observerRecord.coordinates[1]),
    ],
  };
  const runsRecord = asRecord(record.visibleRuns);
  if (
    !runsRecord ||
    !exactKeys(runsRecord, ["type", "geometries"]) ||
    runsRecord.type !== "GeometryCollection" ||
    !Array.isArray(runsRecord.geometries) ||
    runsRecord.geometries.length > MAX_VISIBLE_RUNS
  )
    fail("VIEWSHED_PROJECT_INVALID");
  let coordinateCount = 0;
  const geometries: Polygon[] = runsRecord.geometries.map(
    (geometry): Polygon => {
      const polygon = asRecord(geometry);
      if (
        !polygon ||
        !exactKeys(polygon, ["type", "coordinates"]) ||
        polygon.type !== "Polygon" ||
        !Array.isArray(polygon.coordinates) ||
        polygon.coordinates.length !== 1 ||
        !Array.isArray(polygon.coordinates[0])
      )
        fail("VIEWSHED_PROJECT_INVALID");
      const ring = polygon.coordinates[0].map((position): Position => {
        if (
          !Array.isArray(position) ||
          position.length !== 2 ||
          !finite(position[0]) ||
          !finite(position[1]) ||
          position[0] < -180 ||
          position[0] > 180 ||
          position[1] < -90 ||
          position[1] > 90
        )
          fail("VIEWSHED_PROJECT_INVALID");
        coordinateCount += 1;
        if (coordinateCount > MAX_PROJECTED_COORDINATES)
          fail("VIEWSHED_PROJECT_INVALID");
        return [canonicalNumber(position[0]), canonicalNumber(position[1])];
      });
      if (
        ring.length < 5 ||
        !samePoint(ring[0], ring.at(-1)!) ||
        signedArea(ring) <= 0
      ) {
        fail("VIEWSHED_PROJECT_INVALID");
      }
      return { type: "Polygon", coordinates: [ring] };
    }
  );
  const summary = asRecord(record.summary);
  if (!summary || !exactKeys(summary, SUMMARY_KEYS))
    fail("VIEWSHED_PROJECT_INVALID");
  if (
    summary.schema !== VIEWSHED_SCHEMA ||
    summary.method !== VIEWSHED_METHOD ||
    summary.model !== VIEWSHED_MODEL ||
    summary.areaModel !== VIEWSHED_AREA_MODEL ||
    (summary.sourceCrs !== "EPSG:5179" && summary.sourceCrs !== "EPSG:5186")
  )
    fail("VIEWSHED_PROJECT_INVALID");
  const numericKeys = SUMMARY_KEYS.filter(
    (key) =>
      ![
        "schema",
        "method",
        "model",
        "areaModel",
        "sourceCrs",
        "visibleRunLengths",
      ].includes(key)
  );
  if (numericKeys.some((key) => !finite(summary[key])))
    fail("VIEWSHED_PROJECT_INVALID");
  const integerKeys = [
    "candidateCells",
    "visibleCells",
    "occludedCells",
    "unknownCells",
    "evaluatedCells",
    "visibleRunCount",
  ] as const;
  if (
    integerKeys.some(
      (key) =>
        !Number.isSafeInteger(summary[key]) || (summary[key] as number) < 0
    )
  ) {
    fail("VIEWSHED_PROJECT_INVALID");
  }
  if (
    !Array.isArray(summary.visibleRunLengths) ||
    summary.visibleRunLengths.length !== summary.visibleRunCount ||
    summary.visibleRunLengths.some(
      (length) => !Number.isSafeInteger(length) || length < 1
    )
  )
    fail("VIEWSHED_PROJECT_INVALID");
  const runLengths = summary.visibleRunLengths as number[];
  const runCellSum = runLengths.reduce((sum, length) => sum + length, 0);
  const cellArea = summary.cellAreaSquareMeters as number;
  const visible = summary.visibleCells as number;
  const occluded = summary.occludedCells as number;
  const unknown = summary.unknownCells as number;
  const evaluated = summary.evaluatedCells as number;
  const observerHeight = summary.observerHeightMeters as number;
  const targetHeight = summary.targetHeightMeters as number;
  const radius = summary.maximumRadiusMeters as number;
  const candidate = summary.candidateCells as number;
  const runCount = summary.visibleRunCount as number;
  const percentage = summary.visiblePercentage as number;
  if (
    observerHeight < 0.1 ||
    observerHeight > 100 ||
    targetHeight < 0 ||
    targetHeight > 100 ||
    radius <= 0 ||
    radius > 10_000 ||
    cellArea <= 0 ||
    cellArea > 10_000 ||
    candidate < 1 ||
    candidate > VIEWSHED_MAX_CANDIDATE_CELLS ||
    runCount > MAX_VISIBLE_RUNS ||
    percentage < 0 ||
    percentage > 100 ||
    (summary.visibleAreaSquareMeters as number) < 0 ||
    (summary.occludedAreaSquareMeters as number) < 0 ||
    (summary.unknownAreaSquareMeters as number) < 0 ||
    summary.visibleRunCount !== geometries.length ||
    runCellSum !== visible ||
    summary.candidateCells !== visible + occluded + unknown ||
    evaluated !== visible + occluded ||
    evaluated < 1 ||
    summary.visibleAreaSquareMeters !== visible * cellArea ||
    summary.occludedAreaSquareMeters !== occluded * cellArea ||
    summary.unknownAreaSquareMeters !== unknown * cellArea ||
    summary.visiblePercentage !== (visible / evaluated) * 100
  )
    fail("VIEWSHED_PROJECT_INVALID");
  try {
    if (
      geometries.some(
        (geometry, index) =>
          !isCanonicalVisibleRun(
            geometry,
            summary.sourceCrs as KoreanProjectedCrs,
            runLengths[index],
            cellArea
          )
      )
    )
      fail("VIEWSHED_PROJECT_INVALID");
  } catch {
    fail("VIEWSHED_PROJECT_INVALID");
  }
  return {
    boundary,
    observer,
    visibleRuns: { type: "GeometryCollection", geometries },
    summary: {
      ...(summary as unknown as ViewshedSummary),
      visibleRunLengths: [...runLengths],
    },
  };
}

export function buildViewshedLayer(result: ViewshedResult): GeoLibreLayer {
  const normalized = normalizeViewshedResult(result);
  const featureCollection: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: normalized.boundary, properties: {} },
      { type: "Feature", geometry: normalized.observer, properties: {} },
      { type: "Feature", geometry: normalized.visibleRuns, properties: {} },
    ],
  };
  return {
    id: crypto.randomUUID(),
    name: VIEWSHED_RESULT_NAME,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    excludeFromHistory: true,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: "#22c55e",
      strokeColor: "#15803d",
      fillOpacity: 0.3,
      strokeWidth: 1,
    },
    metadata: {
      customLayerType: "viewshed-analysis",
      viewshedAnalysis: { ...normalized.summary },
    },
    geojson: featureCollection,
  };
}
