import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  GeometryCollection,
  Position,
} from "geojson";
import proj4 from "proj4";
import { registerLocalCrsDefinitions } from "./local-crs";

export const SUPPORTED_CAD_CRS = [
  "EPSG:4326",
  "EPSG:3857",
  "EPSG:5179",
  "EPSG:5186",
] as const;

export type SupportedCadCrs = (typeof SUPPORTED_CAD_CRS)[number];
export type CadAlignmentMethod = "crs" | "similarity-2-point";
export type Point2D = readonly [number, number];

const MAX_FEATURES = 50_000;
const MAX_COORDINATES = 1_000_000;
const MIN_SCALE = 1e-6;
const MAX_SCALE = 1e6;

registerLocalCrsDefinitions();

export interface SimilarityTransform {
  scale: number;
  rotationRadians: number;
  rotationDegrees: number;
  translateX: number;
  translateY: number;
  rmsError: number;
}

export interface CadAlignmentOptions {
  sourceCrs: SupportedCadCrs;
  method: CadAlignmentMethod;
  sourceControlPoints?: readonly [Point2D, Point2D];
  targetControlPointsWgs84?: readonly [Point2D, Point2D];
}

export interface CadAlignmentSummary {
  featureCount: number;
  coordinateCount: number;
  sourceCrs: SupportedCadCrs;
  method: CadAlignmentMethod;
  scale: number;
  rotationDegrees: number;
  rmsErrorMeters: number;
}

export interface CadAlignmentResult {
  geojson: FeatureCollection;
  summary: CadAlignmentSummary;
}

export interface CoordinateAlignmentMetadata {
  sourceFormat: "DXF";
  sourceCrs: SupportedCadCrs;
  method: CadAlignmentMethod;
  scale: number;
  rotationDegrees: number;
  rmsErrorMeters: number;
}

interface MetadataInput extends Omit<CoordinateAlignmentMetadata, "sourceFormat"> {
  sourcePath?: string;
  sourceControlPoints?: readonly Point2D[];
}

function finitePoint(point: Point2D, label: string): void {
  if (
    point.length !== 2 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1])
  ) {
    throw new Error(`${label} must contain two finite coordinates.`);
  }
}

function assertWgs84Range(point: readonly number[], label: string): void {
  if (
    point.length < 2 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    point[0] < -180 ||
    point[0] > 180 ||
    point[1] < -90 ||
    point[1] > 90
  ) {
    throw new Error(`${label} is outside the valid WGS84 range.`);
  }
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function solveSimilarityTransform(
  source: readonly [Point2D, Point2D],
  target: readonly [Point2D, Point2D],
): SimilarityTransform {
  finitePoint(source[0], "Source control point 1");
  finitePoint(source[1], "Source control point 2");
  finitePoint(target[0], "Target control point 1");
  finitePoint(target[1], "Target control point 2");

  const sourceDistance = distance(source[0], source[1]);
  const targetDistance = distance(target[0], target[1]);
  if (sourceDistance <= Number.EPSILON) {
    throw new Error("Source control points must be distinct.");
  }
  if (targetDistance <= Number.EPSILON) {
    throw new Error("Target control points must be distinct.");
  }

  const scale = targetDistance / sourceDistance;
  if (!Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new Error("Computed similarity scale is outside the supported range.");
  }
  const sourceAngle = Math.atan2(
    source[1][1] - source[0][1],
    source[1][0] - source[0][0],
  );
  const targetAngle = Math.atan2(
    target[1][1] - target[0][1],
    target[1][0] - target[0][0],
  );
  const rotationRadians = targetAngle - sourceAngle;
  const cos = Math.cos(rotationRadians);
  const sin = Math.sin(rotationRadians);
  const transformedSourceX =
    scale * (cos * source[0][0] - sin * source[0][1]);
  const transformedSourceY =
    scale * (sin * source[0][0] + cos * source[0][1]);
  const transform: SimilarityTransform = {
    scale,
    rotationRadians,
    rotationDegrees: (rotationRadians * 180) / Math.PI,
    translateX: target[0][0] - transformedSourceX,
    translateY: target[0][1] - transformedSourceY,
    rmsError: 0,
  };

  const squaredErrors = source.map((point, index) => {
    const aligned = applySimilarityTransform(point, transform);
    const dx = aligned[0] - target[index][0];
    const dy = aligned[1] - target[index][1];
    return dx * dx + dy * dy;
  });
  transform.rmsError = Math.sqrt(
    squaredErrors.reduce((sum, value) => sum + value, 0) /
      squaredErrors.length,
  );
  return transform;
}

export function applySimilarityTransform(
  position: readonly number[],
  transform: SimilarityTransform,
): Position {
  if (
    position.length < 2 ||
    !Number.isFinite(position[0]) ||
    !Number.isFinite(position[1])
  ) {
    throw new Error("CAD geometry contains a non-finite coordinate.");
  }
  const cos = Math.cos(transform.rotationRadians);
  const sin = Math.sin(transform.rotationRadians);
  const x =
    transform.scale * (cos * position[0] - sin * position[1]) +
    transform.translateX;
  const y =
    transform.scale * (sin * position[0] + cos * position[1]) +
    transform.translateY;
  return [x, y, ...position.slice(2)];
}

function assertSupportedCrs(value: string): asserts value is SupportedCadCrs {
  if (!(SUPPORTED_CAD_CRS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported CRS: ${value}`);
  }
}

function convertPosition(
  position: Position,
  sourceCrs: SupportedCadCrs,
  workingCrs: SupportedCadCrs,
  transform: SimilarityTransform | null,
): Position {
  if (
    position.length < 2 ||
    !Number.isFinite(position[0]) ||
    !Number.isFinite(position[1])
  ) {
    throw new Error("CAD geometry contains a non-finite coordinate.");
  }
  if (sourceCrs === "EPSG:4326") {
    assertWgs84Range(position, "CAD geometry coordinate");
  }
  const z = position.slice(2);
  const working = proj4(sourceCrs, workingCrs, [position[0], position[1]]);
  const aligned = transform
    ? applySimilarityTransform(working, transform)
    : working;
  const wgs84 = proj4(workingCrs, "EPSG:4326", [aligned[0], aligned[1]]);
  if (
    !Number.isFinite(wgs84[0]) ||
    !Number.isFinite(wgs84[1]) ||
    wgs84[0] < -180 ||
    wgs84[0] > 180 ||
    wgs84[1] < -90 ||
    wgs84[1] > 90
  ) {
    throw new Error("Aligned coordinate is outside the valid WGS84 range.");
  }
  return [wgs84[0], wgs84[1], ...z];
}

function transformCoordinates(
  value: unknown,
  transformPosition: (position: Position) => Position,
  count: { value: number },
): unknown {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("CAD layer contains empty geometry.");
  }
  if (typeof value[0] === "number") {
    count.value += 1;
    if (count.value > MAX_COORDINATES) {
      throw new Error("CAD layer exceeds the 1,000,000-coordinate limit.");
    }
    return transformPosition(value as Position);
  }
  return value.map((item) => transformCoordinates(item, transformPosition, count));
}

function transformGeometry(
  geometry: Geometry,
  transformPosition: (position: Position) => Position,
  count: { value: number },
): Geometry {
  if (geometry.type === "GeometryCollection") {
    const collection = geometry as GeometryCollection;
    if (collection.geometries.length === 0) {
      throw new Error("CAD layer contains empty geometry.");
    }
    return {
      ...collection,
      geometries: collection.geometries.map((child) =>
        transformGeometry(child, transformPosition, count),
      ),
    };
  }
  return {
    ...geometry,
    coordinates: transformCoordinates(
      geometry.coordinates,
      transformPosition,
      count,
    ),
  } as Geometry;
}

export function alignCadFeatureCollection(
  input: FeatureCollection,
  options: CadAlignmentOptions,
): CadAlignmentResult {
  assertSupportedCrs(options.sourceCrs);
  if (!input || input.type !== "FeatureCollection") {
    throw new Error("DXF reader did not return a GeoJSON FeatureCollection.");
  }
  if (input.features.length === 0) {
    throw new Error("CAD layer contains no features.");
  }
  if (input.features.length > MAX_FEATURES) {
    throw new Error("CAD layer exceeds the 50,000-feature limit.");
  }

  const workingCrs: SupportedCadCrs =
    options.method === "similarity-2-point" && options.sourceCrs === "EPSG:4326"
      ? "EPSG:3857"
      : options.sourceCrs;
  let similarity: SimilarityTransform | null = null;
  if (options.method === "similarity-2-point") {
    if (!options.sourceControlPoints || !options.targetControlPointsWgs84) {
      throw new Error("Two source and target control points are required.");
    }
    const sourcePlanar = options.sourceControlPoints.map((point) => {
      finitePoint(point, "Source control point");
      if (options.sourceCrs === "EPSG:4326") {
        assertWgs84Range(point, "Source control point");
      }
      return proj4(options.sourceCrs, workingCrs, [...point]) as [number, number];
    }) as unknown as [Point2D, Point2D];
    const targetPlanar = options.targetControlPointsWgs84.map((point) => {
      finitePoint(point, "Target control point");
      assertWgs84Range(point, "Target control point");
      return proj4("EPSG:4326", workingCrs, [...point]) as [number, number];
    }) as unknown as [Point2D, Point2D];
    similarity = solveSimilarityTransform(sourcePlanar, targetPlanar);
  } else if (options.method !== "crs") {
    throw new Error(`Unsupported alignment method: ${String(options.method)}`);
  }

  const coordinateCount = { value: 0 };
  const features = input.features.map((feature) => {
    if (!feature.geometry) {
      throw new Error("CAD layer contains empty geometry.");
    }
    return {
      type: "Feature",
      geometry: transformGeometry(
        feature.geometry,
        (position) =>
          convertPosition(
            position,
            options.sourceCrs,
            workingCrs,
            similarity,
          ),
        coordinateCount,
      ),
      properties: {},
    } as Feature<Geometry, GeoJsonProperties>;
  });

  return {
    geojson: { type: "FeatureCollection", features },
    summary: {
      featureCount: features.length,
      coordinateCount: coordinateCount.value,
      sourceCrs: options.sourceCrs,
      method: options.method,
      scale: similarity?.scale ?? 1,
      rotationDegrees: similarity?.rotationDegrees ?? 0,
      rmsErrorMeters: similarity?.rmsError ?? 0,
    },
  };
}

export function createCoordinateAlignmentMetadata(
  input: MetadataInput,
): CoordinateAlignmentMetadata {
  assertSupportedCrs(input.sourceCrs);
  return {
    sourceFormat: "DXF",
    sourceCrs: input.sourceCrs,
    method: input.method,
    scale: input.scale,
    rotationDegrees: input.rotationDegrees,
    rmsErrorMeters: input.rmsErrorMeters,
  };
}
