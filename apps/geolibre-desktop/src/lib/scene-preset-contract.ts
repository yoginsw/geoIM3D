import {
  createEmptyProject,
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import { assertScenePresetExportPolicy } from "./scene-preset-export-policy";

export type BuiltInBasemapIdV1 =
  | "geoim3d-blank-v1"
  | "geoim3d-openfreemap-liberty-v1";

export type ExternalSceneReferenceV1 =
  | { type: "https"; url: string }
  | { type: "relative"; path: string };

type ExternalSceneFormatV1 = "glb" | "3d-tiles" | "i3s";

export interface ExternalScenePlacementV1 {
  longitude: number;
  latitude: number;
  altitudeMeters: number;
  bearingDegrees: number;
  scale: number;
}

export interface BasicLabelStyleV1 {
  enabled: boolean;
  field: string;
  placement: "point" | "line";
  size: number;
  color: string;
  haloColor: string;
  haloWidth: number;
  minZoom: number;
  maxZoom: number;
  allowOverlap: boolean;
}

export interface BasicExtrusionStyleV1 {
  enabled: boolean;
  color: string;
  opacity: number;
  heightProperty: string;
  heightScale: number;
  base: number;
}

export interface BasicElevation3dStyleV1 {
  enabled: boolean;
  verticalScale: number;
  offsetMeters: number;
}

export interface BasicVectorStyleV1 {
  minZoom: number;
  maxZoom: number;
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
  strokeWidthUnit: "pixels" | "meters";
  circleRadius: number;
  label: BasicLabelStyleV1;
  extrusion: BasicExtrusionStyleV1;
  elevation3d: BasicElevation3dStyleV1;
}

export interface PresetLayerGroupV1 {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
}

export type PresetLayerV1 =
  | {
      kind: "geojson";
      id: string;
      name: string;
      groupId?: string;
      visible: boolean;
      opacity: number;
      style: BasicVectorStyleV1;
      data: GeoJSON.FeatureCollection;
    }
  | {
      kind: "external-scene";
      id: string;
      name: string;
      groupId?: string;
      visible: boolean;
      opacity: number;
      format: ExternalSceneFormatV1;
      reference: ExternalSceneReferenceV1;
      placement?: ExternalScenePlacementV1;
    };

export interface StrictPortableProjectTemplateV1 {
  projectName: string;
  mapView: {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  };
  basemap: {
    builtInId: BuiltInBasemapIdV1;
    visible: boolean;
    opacity: number;
  };
  mapPreferences: {
    restrictBounds: boolean;
    bounds: [number, number, number, number];
    minZoom: number;
    maxZoom: number;
    maxPitch: number;
    renderWorldCopies: boolean;
    projection: "globe" | "mercator";
    ellipsoidId: string;
    scaleUnit: "metric" | "imperial" | "nautical";
  };
  groups: PresetLayerGroupV1[];
  layers: PresetLayerV1[];
}

export interface GeoIm3dScenePresetV1 {
  schema: "geoim3d-scene-preset-v1";
  version: 1;
  kind: "3d-scene-project-template";
  name: string;
  description?: string;
  createdBy: "JBT" | "user";
  scene: {
    workspace: "cesium";
    mapGrid: { rows: 1; cols: 1 };
    project: StrictPortableProjectTemplateV1;
  };
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 400_000;
const MAX_STRING_BYTES = 2 * 1024 * 1024;
const MAX_STRING = 64 * 1024;
const MAX_PROPERTY_NAME_BYTES = 256;
const MAX_NAME_BYTES = 128;
const MAX_LAYERS = 1_000;
const MAX_GROUPS = 1_000;
const MAX_FEATURES = 25_000;
const MAX_COORDINATE_POSITIONS = 250_000;
const MAX_EXTERNAL_REFERENCES = 1_000;
const encoder = new TextEncoder();

class ScenePresetContractError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function invalid(code = "SCENE_PRESET_INVALID"): never {
  throw new ScenePresetContractError(code);
}

function exactObject(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    invalid();
  }
  if (keys) {
    const actual = Object.keys(value);
    if (
      actual.length !== keys.length ||
      actual.some((key, index) => key !== keys[index])
    ) {
      invalid();
    }
  }
  return value as Record<string, unknown>;
}

function exactArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) invalid();
  }
  return value;
}

function stringValue(value: unknown, maxBytes = MAX_STRING): string {
  if (typeof value !== "string" || encoder.encode(value).byteLength > maxBytes) {
    return invalid("SCENE_PRESET_LIMIT_EXCEEDED");
  }
  return value;
}

function numberValue(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    return invalid();
  }
  return value;
}

function rangedNumber(value: unknown, minimum: number, maximum: number): number {
  const number = numberValue(value);
  if (number < minimum || number > maximum) invalid();
  return number;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
  return value as T;
}

function colorValue(value: unknown): string {
  const color = stringValue(value, 9);
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) invalid();
  return color;
}

function parseJsonBytes(bytes: Uint8Array): { text: string; value: unknown } {
  if (bytes.byteLength > MAX_BYTES) invalid("SCENE_PRESET_TOO_LARGE");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }

  let index = 0;
  let containerNodes = 0;
  let totalStringBytes = 0;

  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index += 1;
  };

  const accountString = (value: string): string => {
    const byteLength = encoder.encode(value).byteLength;
    if (byteLength > MAX_STRING) invalid("SCENE_PRESET_LIMIT_EXCEEDED");
    totalStringBytes += byteLength;
    if (totalStringBytes > MAX_STRING_BYTES) {
      invalid("SCENE_PRESET_LIMIT_EXCEEDED");
    }
    return value;
  };

  const parseString = (): string => {
    if (text[index] !== '"') invalid();
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      if (character === '"' && !escaped) {
        index += 1;
        const token = text.slice(start, index);
        let decoded: unknown;
        try {
          decoded = JSON.parse(token);
        } catch {
          return invalid();
        }
        if (typeof decoded !== "string") invalid();
        for (let cursor = 0; cursor < decoded.length; cursor += 1) {
          const code = decoded.charCodeAt(cursor);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = decoded.charCodeAt(cursor + 1);
            if (next < 0xdc00 || next > 0xdfff) invalid();
            cursor += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            invalid();
          }
        }
        return accountString(decoded);
      }
      if (character === "\n" || character === "\r" || character === undefined) {
        invalid();
      }
      if (character === "\\" && !escaped) {
        escaped = true;
      } else {
        escaped = false;
      }
      index += 1;
    }
    return invalid();
  };

  const parseNumber = (): number => {
    const match = text
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) return invalid();
    index += match[0].length;
    return numberValue(Number(match[0]));
  };

  const parseValue = (depth: number): unknown => {
    if (depth > MAX_DEPTH) invalid("SCENE_PRESET_LIMIT_EXCEEDED");
    whitespace();
    const character = text[index];

    if (character === "{") {
      containerNodes += 1;
      if (containerNodes > MAX_NODES) invalid("SCENE_PRESET_LIMIT_EXCEEDED");
      index += 1;
      const object: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return object;
      }
      while (true) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (text[index] !== ":") invalid();
        index += 1;
        object[key] = parseValue(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return object;
        }
        if (text[index] !== ",") invalid();
        index += 1;
      }
    }

    if (character === "[") {
      containerNodes += 1;
      if (containerNodes > MAX_NODES) invalid("SCENE_PRESET_LIMIT_EXCEEDED");
      index += 1;
      const array: unknown[] = [];
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return array;
      }
      while (true) {
        array.push(parseValue(depth + 1));
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return array;
        }
        if (text[index] !== ",") invalid();
        index += 1;
      }
    }

    if (character === '"') return parseString();
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  };

  const value = parseValue(1);
  whitespace();
  if (index !== text.length) invalid();
  return { text, value };
}

interface GeoJsonLimits {
  features: number;
  coordinatePositions: number;
}

function validatePosition(value: unknown, limits: GeoJsonLimits): void {
  const position = exactArray(value);
  if (position.length < 2 || position.length > 3) invalid();
  for (const coordinate of position) numberValue(coordinate);
  limits.coordinatePositions += 1;
  if (limits.coordinatePositions > MAX_COORDINATE_POSITIONS) {
    invalid("SCENE_PRESET_LIMIT_EXCEEDED");
  }
}

function validatePositionTree(
  value: unknown,
  depth: number,
  limits: GeoJsonLimits,
): void {
  if (depth === 0) {
    validatePosition(value, limits);
    return;
  }
  for (const child of exactArray(value)) {
    validatePositionTree(child, depth - 1, limits);
  }
}

function validateGeometry(value: unknown, limits: GeoJsonLimits): void {
  const geometry = exactObject(value);
  const type = enumValue(geometry.type, [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
  ] as const);

  if (type === "GeometryCollection") {
    exactObject(geometry, ["type", "geometries"]);
    for (const child of exactArray(geometry.geometries)) {
      validateGeometry(child, limits);
    }
    return;
  }

  exactObject(geometry, ["type", "coordinates"]);
  const depth = {
    Point: 0,
    MultiPoint: 1,
    LineString: 1,
    MultiLineString: 2,
    Polygon: 2,
    MultiPolygon: 3,
  }[type];
  validatePositionTree(geometry.coordinates, depth, limits);
}

const PROPERTY_CREDENTIAL_KEY =
  /(?:api.?key|authorization|client.?secret|connection.?string|cookie|credential|password|private.?key|secret|session|token)/i;

function validateFeatureCollection(
  value: unknown,
  limits: GeoJsonLimits,
): GeoJSON.FeatureCollection {
  const collection = exactObject(value, ["type", "features"]);
  if (collection.type !== "FeatureCollection") invalid();
  const features = exactArray(collection.features);
  limits.features += features.length;
  if (limits.features > MAX_FEATURES) invalid("SCENE_PRESET_LIMIT_EXCEEDED");

  for (const featureValue of features) {
    const feature = exactObject(featureValue, [
      "type",
      "geometry",
      "properties",
    ]);
    if (feature.type !== "Feature") invalid();
    if (feature.geometry !== null) validateGeometry(feature.geometry, limits);
    const properties = exactObject(feature.properties);
    for (const [key, property] of Object.entries(properties)) {
      stringValue(key, MAX_PROPERTY_NAME_BYTES);
      if (PROPERTY_CREDENTIAL_KEY.test(key)) {
        invalid("SCENE_PRESET_CREDENTIAL_BLOCKED");
      }
      if (
        property !== null &&
        typeof property !== "string" &&
        typeof property !== "boolean" &&
        typeof property !== "number"
      ) {
        invalid();
      }
      if (typeof property === "string") stringValue(property);
      if (typeof property === "number") numberValue(property);
    }
  }
  return value as GeoJSON.FeatureCollection;
}

function validateLabelStyle(value: unknown): BasicLabelStyleV1 {
  const style = exactObject(value, [
    "enabled",
    "field",
    "placement",
    "size",
    "color",
    "haloColor",
    "haloWidth",
    "minZoom",
    "maxZoom",
    "allowOverlap",
  ]);
  booleanValue(style.enabled);
  stringValue(style.field, MAX_PROPERTY_NAME_BYTES);
  enumValue(style.placement, ["point", "line"] as const);
  rangedNumber(style.size, 1, 256);
  colorValue(style.color);
  colorValue(style.haloColor);
  rangedNumber(style.haloWidth, 0, 100);
  const minZoom = rangedNumber(style.minZoom, 0, 24);
  const maxZoom = rangedNumber(style.maxZoom, 0, 24);
  if (minZoom > maxZoom) invalid();
  booleanValue(style.allowOverlap);
  return value as BasicLabelStyleV1;
}

function validateExtrusionStyle(value: unknown): BasicExtrusionStyleV1 {
  const style = exactObject(value, [
    "enabled",
    "color",
    "opacity",
    "heightProperty",
    "heightScale",
    "base",
  ]);
  booleanValue(style.enabled);
  colorValue(style.color);
  rangedNumber(style.opacity, 0, 1);
  stringValue(style.heightProperty, MAX_PROPERTY_NAME_BYTES);
  rangedNumber(style.heightScale, 0, 1_000_000);
  rangedNumber(style.base, -100_000, 100_000_000);
  return value as BasicExtrusionStyleV1;
}

function validateElevation3dStyle(value: unknown): BasicElevation3dStyleV1 {
  const style = exactObject(value, [
    "enabled",
    "verticalScale",
    "offsetMeters",
  ]);
  booleanValue(style.enabled);
  rangedNumber(style.verticalScale, 0, 1_000_000);
  rangedNumber(style.offsetMeters, -100_000, 100_000_000);
  return value as BasicElevation3dStyleV1;
}

function validateVectorStyle(value: unknown): BasicVectorStyleV1 {
  const style = exactObject(value, [
    "minZoom",
    "maxZoom",
    "fillColor",
    "fillOpacity",
    "strokeColor",
    "strokeWidth",
    "strokeWidthUnit",
    "circleRadius",
    "label",
    "extrusion",
    "elevation3d",
  ]);
  const minZoom = rangedNumber(style.minZoom, 0, 24);
  const maxZoom = rangedNumber(style.maxZoom, 0, 24);
  if (minZoom > maxZoom) invalid();
  colorValue(style.fillColor);
  rangedNumber(style.fillOpacity, 0, 1);
  colorValue(style.strokeColor);
  rangedNumber(style.strokeWidth, 0, 10_000);
  enumValue(style.strokeWidthUnit, ["pixels", "meters"] as const);
  rangedNumber(style.circleRadius, 0, 10_000);
  validateLabelStyle(style.label);
  validateExtrusionStyle(style.extrusion);
  validateElevation3dStyle(style.elevation3d);
  return value as BasicVectorStyleV1;
}

function validateHttpsReference(reference: string): void {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    return invalid("SCENE_PRESET_REFERENCE_INVALID");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.href !== reference ||
    host === "localhost" ||
    host.endsWith(".local") ||
    !host.includes(".") ||
    host.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    invalid("SCENE_PRESET_REFERENCE_INVALID");
  }
}

function validateRelativeReference(reference: string, format: ExternalSceneFormatV1): void {
  if (
    reference === "" ||
    reference.startsWith("/") ||
    reference.includes("\\") ||
    reference.includes("\0") ||
    /^[a-z]:/i.test(reference) ||
    reference.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalid("SCENE_PRESET_REFERENCE_INVALID");
  }
  const lower = reference.toLowerCase();
  if (
    format !== "glb" ||
    !lower.endsWith(".glb")
  ) {
    invalid("SCENE_PRESET_REFERENCE_INVALID");
  }
}

function validateReference(
  value: unknown,
  format: ExternalSceneFormatV1,
): ExternalSceneReferenceV1 {
  const reference = exactObject(value);
  const type = enumValue(reference.type, ["https", "relative"] as const);
  if (type === "https") {
    exactObject(reference, ["type", "url"]);
    const url = stringValue(reference.url, 2_048);
    validateHttpsReference(url);
  } else {
    exactObject(reference, ["type", "path"]);
    const path = stringValue(reference.path, 1_024);
    validateRelativeReference(path, format);
  }
  return value as ExternalSceneReferenceV1;
}

function validatePlacement(value: unknown): ExternalScenePlacementV1 {
  const placement = exactObject(value, [
    "longitude",
    "latitude",
    "altitudeMeters",
    "bearingDegrees",
    "scale",
  ]);
  rangedNumber(placement.longitude, -180, 180);
  rangedNumber(placement.latitude, -90, 90);
  rangedNumber(placement.altitudeMeters, -100_000, 100_000_000);
  rangedNumber(placement.bearingDegrees, -360, 360);
  rangedNumber(placement.scale, 0.000001, 1_000_000);
  return value as ExternalScenePlacementV1;
}

function validatePreset(value: unknown): GeoIm3dScenePresetV1 {
  const root = exactObject(value);
  const rootKeys = root.description === undefined
    ? ["schema", "version", "kind", "name", "createdBy", "scene"]
    : [
        "schema",
        "version",
        "kind",
        "name",
        "description",
        "createdBy",
        "scene",
      ];
  exactObject(root, rootKeys);
  if (
    root.schema !== "geoim3d-scene-preset-v1" ||
    root.version !== 1 ||
    root.kind !== "3d-scene-project-template"
  ) {
    invalid();
  }
  stringValue(root.name, MAX_NAME_BYTES);
  if (root.description !== undefined) stringValue(root.description);
  enumValue(root.createdBy, ["JBT", "user"] as const);

  const scene = exactObject(root.scene, ["workspace", "mapGrid", "project"]);
  if (scene.workspace !== "cesium") invalid();
  const mapGrid = exactObject(scene.mapGrid, ["rows", "cols"]);
  if (mapGrid.rows !== 1 || mapGrid.cols !== 1) invalid();

  const project = exactObject(scene.project, [
    "projectName",
    "mapView",
    "basemap",
    "mapPreferences",
    "groups",
    "layers",
  ]);
  stringValue(project.projectName, MAX_NAME_BYTES);

  const mapView = exactObject(project.mapView, [
    "center",
    "zoom",
    "bearing",
    "pitch",
  ]);
  const center = exactArray(mapView.center);
  if (center.length !== 2) invalid();
  rangedNumber(center[0], -180, 180);
  rangedNumber(center[1], -90, 90);
  rangedNumber(mapView.zoom, 0, 24);
  rangedNumber(mapView.bearing, -360, 360);
  rangedNumber(mapView.pitch, 0, 85);

  const basemap = exactObject(project.basemap, [
    "builtInId",
    "visible",
    "opacity",
  ]);
  enumValue(basemap.builtInId, [
    "geoim3d-blank-v1",
    "geoim3d-openfreemap-liberty-v1",
  ] as const);
  booleanValue(basemap.visible);
  rangedNumber(basemap.opacity, 0, 1);

  const mapPreferences = exactObject(project.mapPreferences, [
    "restrictBounds",
    "bounds",
    "minZoom",
    "maxZoom",
    "maxPitch",
    "renderWorldCopies",
    "projection",
    "ellipsoidId",
    "scaleUnit",
  ]);
  booleanValue(mapPreferences.restrictBounds);
  const bounds = exactArray(mapPreferences.bounds);
  if (bounds.length !== 4) invalid();
  const west = rangedNumber(bounds[0], -180, 180);
  const south = rangedNumber(bounds[1], -90, 90);
  const east = rangedNumber(bounds[2], -180, 180);
  const north = rangedNumber(bounds[3], -90, 90);
  if (west >= east || south >= north) invalid();
  const minZoom = rangedNumber(mapPreferences.minZoom, 0, 24);
  const maxZoom = rangedNumber(mapPreferences.maxZoom, 0, 24);
  if (minZoom > maxZoom) invalid();
  rangedNumber(mapPreferences.maxPitch, 0, 85);
  booleanValue(mapPreferences.renderWorldCopies);
  enumValue(mapPreferences.projection, ["globe", "mercator"] as const);
  stringValue(mapPreferences.ellipsoidId, MAX_NAME_BYTES);
  enumValue(mapPreferences.scaleUnit, [
    "metric",
    "imperial",
    "nautical",
  ] as const);

  const groups = exactArray(project.groups);
  if (groups.length > MAX_GROUPS) invalid("SCENE_PRESET_LIMIT_EXCEEDED");
  const groupIds = new Set<string>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = exactObject(groups[index], [
      "id",
      "name",
      "visible",
      "opacity",
    ]);
    const id = stringValue(group.id, 64);
    if (id !== `group-${index + 1}` || groupIds.has(id)) invalid();
    groupIds.add(id);
    stringValue(group.name, MAX_NAME_BYTES);
    booleanValue(group.visible);
    rangedNumber(group.opacity, 0, 1);
  }

  const layers = exactArray(project.layers);
  if (layers.length > MAX_LAYERS) invalid("SCENE_PRESET_LIMIT_EXCEEDED");
  const geoJsonLimits: GeoJsonLimits = { features: 0, coordinatePositions: 0 };
  let externalReferences = 0;

  for (let index = 0; index < layers.length; index += 1) {
    const layer = exactObject(layers[index]);
    const kind = enumValue(layer.kind, ["geojson", "external-scene"] as const);
    const sharedKeys = [
      "kind",
      "id",
      "name",
      ...(layer.groupId === undefined ? [] : ["groupId"]),
      "visible",
      "opacity",
    ];
    exactObject(
      layer,
      kind === "geojson"
        ? [...sharedKeys, "style", "data"]
        : [
            ...sharedKeys,
            "format",
            "reference",
            ...(layer.placement === undefined ? [] : ["placement"]),
          ],
    );
    if (layer.id !== `layer-${index + 1}`) invalid();
    stringValue(layer.id, 64);
    stringValue(layer.name, MAX_NAME_BYTES);
    if (
      layer.groupId !== undefined &&
      !groupIds.has(stringValue(layer.groupId, 64))
    ) {
      invalid();
    }
    booleanValue(layer.visible);
    rangedNumber(layer.opacity, 0, 1);

    if (kind === "geojson") {
      validateVectorStyle(layer.style);
      validateFeatureCollection(layer.data, geoJsonLimits);
      continue;
    }

    externalReferences += 1;
    if (externalReferences > MAX_EXTERNAL_REFERENCES) {
      invalid("SCENE_PRESET_LIMIT_EXCEEDED");
    }
    const format = enumValue(layer.format, ["glb", "3d-tiles", "i3s"] as const);
    validateReference(layer.reference, format);
    if (layer.placement !== undefined) {
      validatePlacement(layer.placement);
    }
  }

  return value as GeoIm3dScenePresetV1;
}

export function parseScenePresetBytes(
  input: ArrayBuffer | Uint8Array,
): GeoIm3dScenePresetV1 {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const parsed = parseJsonBytes(bytes);
    const preset = validatePreset(parsed.value);
    if (JSON.stringify(preset) !== parsed.text) invalid();
    return preset;
  } catch (error) {
    if (error instanceof ScenePresetContractError) throw error;
    return invalid();
  }
}

export function serializeScenePreset(
  preset: GeoIm3dScenePresetV1,
): Uint8Array {
  const valid = validatePreset(preset);
  const bytes = encoder.encode(JSON.stringify(valid));
  if (bytes.byteLength > MAX_BYTES) invalid("SCENE_PRESET_TOO_LARGE");
  return bytes;
}

function vectorStyleFromLayer(layer: GeoLibreLayer): BasicVectorStyleV1 {
  const style = layer.style;
  return {
    minZoom: style.minZoom,
    maxZoom: style.maxZoom,
    fillColor: style.fillColor,
    fillOpacity: style.fillOpacity,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    strokeWidthUnit: style.strokeWidthUnit,
    circleRadius: style.circleRadius,
    label: {
      enabled: style.labels.enabled,
      field: style.labels.field,
      placement: style.labels.placement,
      size: style.labels.size,
      color: style.labels.color,
      haloColor: style.labels.haloColor,
      haloWidth: style.labels.haloWidth,
      minZoom: style.labels.minZoom,
      maxZoom: style.labels.maxZoom,
      allowOverlap: style.labels.allowOverlap,
    },
    extrusion: {
      enabled: style.extrusionEnabled,
      color: style.extrusionColor,
      opacity: style.extrusionOpacity,
      heightProperty: style.extrusionHeightProperty,
      heightScale: style.extrusionHeightScale,
      base: style.extrusionBase,
    },
    elevation3d: {
      enabled: style.elevation3dEnabled,
      verticalScale: style.elevation3dVerticalScale,
      offsetMeters: style.elevation3dOffset,
    },
  };
}

function builtInBasemapId(url: string): BuiltInBasemapIdV1 {
  if (url === "") return "geoim3d-blank-v1";
  if (url === DEFAULT_BASEMAP) return "geoim3d-openfreemap-liberty-v1";
  return invalid("SCENE_PRESET_REFERENCE_INVALID");
}

function projectExternalReference(layer: GeoLibreLayer): ExternalSceneReferenceV1 {
  const candidate = layer.source.reference ?? layer.source.url ?? layer.source.path;
  if (typeof candidate !== "string") {
    return invalid("SCENE_PRESET_REFERENCE_INVALID");
  }
  if (candidate.startsWith("https://")) {
    validateHttpsReference(candidate);
    return { type: "https", url: candidate };
  }
  const format = layer.type === "3d-tiles" ? "3d-tiles" : "glb";
  validateRelativeReference(candidate, format);
  return { type: "relative", path: candidate };
}

export function buildScenePresetFromProject(
  project: GeoLibreProject,
  name = project.name,
): GeoIm3dScenePresetV1 {
  assertScenePresetExportPolicy(project);

  const sourceGroups = project.layerGroups ?? [];
  const groupIdMap = new Map(
    sourceGroups.map((group, index) => [group.id, `group-${index + 1}`]),
  );
  const groups: PresetLayerGroupV1[] = sourceGroups.map((group, index) => ({
    id: `group-${index + 1}`,
    name: group.name,
    visible: group.visible,
    opacity: group.opacity,
  }));

  const layers: PresetLayerV1[] = project.layers.map((layer, index) => {
    if (layer.sourcePath) {
      invalid("SCENE_PRESET_REFERENCE_INVALID");
    }
    const groupId = layer.groupId ? groupIdMap.get(layer.groupId) : undefined;
    if (layer.groupId && !groupId) invalid();
    const shared = {
      id: `layer-${index + 1}`,
      name: layer.name,
      ...(groupId ? { groupId } : {}),
      visible: layer.visible,
      opacity: layer.opacity,
    };

    if (layer.type === "geojson" && layer.geojson) {
      return {
        kind: "geojson",
        ...shared,
        style: vectorStyleFromLayer(layer),
        data: layer.geojson,
      };
    }

    if (layer.type === "3d-tiles" || layer.type === "gaussian-splat") {
      return {
        kind: "external-scene",
        ...shared,
        format: layer.type === "3d-tiles" ? "3d-tiles" : "glb",
        reference: projectExternalReference(layer),
        ...(layer.source.scenePresetPlacement === undefined
          ? {}
          : { placement: validatePlacement(layer.source.scenePresetPlacement) }),
      };
    }

    return invalid("SCENE_PRESET_PRIVATE_CONTENT_BLOCKED");
  });

  const mapPreferences = project.preferences.map;
  return validatePreset({
    schema: "geoim3d-scene-preset-v1",
    version: 1,
    kind: "3d-scene-project-template",
    name: stringValue(name, MAX_NAME_BYTES),
    createdBy: "user",
    scene: {
      workspace: "cesium",
      mapGrid: { rows: 1, cols: 1 },
      project: {
        projectName: stringValue(project.name, MAX_NAME_BYTES),
        mapView: {
          center: [...project.mapView.center] as [number, number],
          zoom: project.mapView.zoom,
          bearing: project.mapView.bearing,
          pitch: project.mapView.pitch,
        },
        basemap: {
          builtInId: builtInBasemapId(project.basemapStyleUrl),
          visible: project.basemapVisible,
          opacity: project.basemapOpacity,
        },
        mapPreferences: {
          restrictBounds: mapPreferences.restrictBounds,
          bounds: [...mapPreferences.bounds] as [number, number, number, number],
          minZoom: mapPreferences.minZoom,
          maxZoom: mapPreferences.maxZoom,
          maxPitch: mapPreferences.maxPitch,
          renderWorldCopies: mapPreferences.renderWorldCopies,
          projection: mapPreferences.projection,
          ellipsoidId: mapPreferences.ellipsoidId,
          scaleUnit: mapPreferences.scaleUnit,
        },
        groups,
        layers,
      },
    },
  });
}

function freshId(prefix: string): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    return invalid("SCENE_PRESET_INTERNAL");
  }
  return `${prefix}-${crypto.randomUUID()}`;
}

function layerStyleFromPreset(style: BasicVectorStyleV1) {
  return {
    ...DEFAULT_LAYER_STYLE,
    minZoom: style.minZoom,
    maxZoom: style.maxZoom,
    fillColor: style.fillColor,
    fillOpacity: style.fillOpacity,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    strokeWidthUnit: style.strokeWidthUnit,
    circleRadius: style.circleRadius,
    textColor: style.label.color,
    textHaloColor: style.label.haloColor,
    textHaloWidth: style.label.haloWidth,
    textSize: style.label.size,
    labels: {
      ...DEFAULT_LAYER_STYLE.labels,
      enabled: style.label.enabled,
      field: style.label.field,
      placement: style.label.placement,
      size: style.label.size,
      color: style.label.color,
      haloColor: style.label.haloColor,
      haloWidth: style.label.haloWidth,
      minZoom: style.label.minZoom,
      maxZoom: style.label.maxZoom,
      allowOverlap: style.label.allowOverlap,
    },
    extrusionEnabled: style.extrusion.enabled,
    extrusionColor: style.extrusion.color,
    extrusionOpacity: style.extrusion.opacity,
    extrusionHeightProperty: style.extrusion.heightProperty,
    extrusionHeightScale: style.extrusion.heightScale,
    extrusionBase: style.extrusion.base,
    elevation3dEnabled: style.elevation3d.enabled,
    elevation3dVerticalScale: style.elevation3d.verticalScale,
    elevation3dOffset: style.elevation3d.offsetMeters,
  };
}

export function createProjectFromScenePreset(
  preset: GeoIm3dScenePresetV1,
): GeoLibreProject {
  const projectTemplate = validatePreset(preset).scene.project;
  const project = createEmptyProject(projectTemplate.projectName, {
    mapView: { ...projectTemplate.mapView },
    basemapStyleUrl:
      projectTemplate.basemap.builtInId === "geoim3d-blank-v1"
        ? ""
        : DEFAULT_BASEMAP,
  });
  project.basemapVisible = projectTemplate.basemap.visible;
  project.basemapOpacity = projectTemplate.basemap.opacity;
  project.preferences.map = {
    ...project.preferences.map,
    ...projectTemplate.mapPreferences,
    bounds: [...projectTemplate.mapPreferences.bounds] as [
      number,
      number,
      number,
      number,
    ],
  };

  const groupIdMap = new Map(
    projectTemplate.groups.map((group) => [group.id, freshId("group")]),
  );
  project.layerGroups = projectTemplate.groups.map((group) => ({
    id: groupIdMap.get(group.id)!,
    name: group.name,
    collapsed: false,
    visible: group.visible,
    opacity: group.opacity,
  }));

  project.layers = projectTemplate.layers.map((layer) => {
    const id = freshId("layer");
    const groupId = layer.groupId ? groupIdMap.get(layer.groupId) : undefined;
    if (layer.kind === "geojson") {
      return {
        id,
        name: layer.name,
        type: "geojson",
        source: { type: "geojson" },
        visible: layer.visible,
        opacity: layer.opacity,
        style: layerStyleFromPreset(layer.style),
        metadata: {},
        ...(groupId ? { groupId } : {}),
        geojson: layer.data,
      } satisfies GeoLibreLayer;
    }

    const reference =
      layer.reference.type === "https"
        ? layer.reference.url
        : layer.reference.path;
    return {
      id,
      name: layer.name,
      type: layer.format === "glb" ? "gaussian-splat" : "3d-tiles",
      // Never expose the reference as source.url/sourcePath. Until native
      // materialization succeeds this remains an unresolved, non-fetching layer.
      source: {
        reference,
        referenceType: layer.reference.type,
        format: layer.format,
        scenePresetStatus: "unresolved",
        ...(layer.placement
          ? { scenePresetPlacement: { ...layer.placement } }
          : {}),
      },
      visible: layer.visible,
      opacity: layer.opacity,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {
        scenePresetExternal: true,
        scenePresetStatus: "unresolved",
        scenePresetError: "SCENE_PRESET_REMOTE_UNAVAILABLE",
      },
      ...(groupId ? { groupId } : {}),
    } satisfies GeoLibreLayer;
  });

  return project;
}
