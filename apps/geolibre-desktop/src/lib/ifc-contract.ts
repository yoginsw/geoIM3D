export const IFC_MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const IFC_MAX_GLB_BYTES = 16 * 1024 * 1024;
export const IFC_MAX_PROJECT_GLB_BYTES = 64 * 1024 * 1024;
export const IFC_MAX_GLB_JSON_BYTES = 1024 * 1024;
export const IFC_MAX_ELEMENTS = 50_000;
export const IFC_MAX_PLACED_MESHES = 100_000;
export const IFC_MAX_TRIANGLES = 2_000_000;
export const IFC_MAX_VERTICES = 1_000_000;
export const IFC_MAX_INDICES = IFC_MAX_TRIANGLES * 3;
export const IFC_MAX_GEOMETRY_BYTES = 14 * 1024 * 1024;
export const IFC_MAX_RADIUS_METERS = 100_000;
export const IFC_MAX_STEP_LINE_BYTES = 64 * 1024;
export const IFC_MAX_STEP_NESTING = 128;
export const IFC_MAX_STEP_TOKEN_BYTES = 256;
export const IFC_MAX_STEP_NUMBER_BYTES = 64;

const IFC_MAX_GLB_JSON_DEPTH = 32;
const IFC_MAX_GLB_JSON_NODES = 50_000;
const IFC_MAX_GLB_ARRAY_LENGTH = 10_000;
const IFC_MAX_GLB_OBJECT_KEYS = 256;
const IFC_MAX_GLB_PRIMITIVES = IFC_MAX_PLACED_MESHES;

const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

export interface IfcPlacement {
  longitude: number;
  latitude: number;
  altitude: number;
  bearing: number;
  scale: number;
}

export interface IfcPlacementDraft {
  longitude: string;
  latitude: string;
  altitude: string;
  bearing: string;
  scale: string;
}

export interface IfcImportSummary {
  sourceFormat: "IFC";
  schema: string;
  elementCount: number;
  meshCount: number;
  triangleCount: number;
  glbBytes: number;
  radiusMeters: number;
  parser: "web-ifc";
}

export interface IfcSummaryInput {
  schema?: unknown;
  elementCount?: unknown;
  meshCount?: unknown;
  triangleCount?: unknown;
  glbBytes?: unknown;
  radiusMeters?: unknown;
  sourcePath?: unknown;
  author?: unknown;
  globalId?: unknown;
}

function fail(code: string): never {
  throw new Error(code);
}

function parseFinite(raw: string): number {
  if (raw.trim() === "") fail("IFC_PLACEMENT_INVALID");
  const value = Number(raw);
  if (!Number.isFinite(value)) fail("IFC_PLACEMENT_INVALID");
  return value;
}

export function parseIfcPlacement(draft: IfcPlacementDraft): IfcPlacement {
  const placement = {
    longitude: parseFinite(draft.longitude),
    latitude: parseFinite(draft.latitude),
    altitude: parseFinite(draft.altitude),
    bearing: parseFinite(draft.bearing),
    scale: parseFinite(draft.scale),
  };
  if (
    placement.longitude < -180 ||
    placement.longitude > 180 ||
    placement.latitude < -90 ||
    placement.latitude > 90 ||
    placement.altitude < -10_000 ||
    placement.altitude > 100_000 ||
    placement.bearing < -360 ||
    placement.bearing > 360 ||
    placement.scale <= 0 ||
    placement.scale > 10_000
  ) {
    fail("IFC_PLACEMENT_INVALID");
  }
  return placement;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("IFC_INPUT_INVALID");
  }
}

/** Validate bounded ISO-10303-21 lexical complexity before initializing WASM. */
export function validateIfcEnvelope(input: Uint8Array): string {
  if (input.byteLength === 0 || input.byteLength > IFC_MAX_INPUT_BYTES) {
    fail("IFC_INPUT_INVALID");
  }
  const text = decodeUtf8(input);
  let lineBytes = 0;
  let nesting = 0;
  let tokenBytes = 0;
  let numberBytes = 0;
  let entityCount = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) lineBytes = 0;
    else if (++lineBytes > IFC_MAX_STEP_LINE_BYTES) fail("IFC_INPUT_INVALID");
    if (code === 39) {
      if (quoted && text.charCodeAt(index + 1) === 39) {
        index += 1;
        lineBytes += 1;
      } else {
        quoted = !quoted;
      }
      tokenBytes = 0;
      numberBytes = 0;
      continue;
    }
    if (quoted) continue;
    if (code === 40 && ++nesting > IFC_MAX_STEP_NESTING) fail("IFC_INPUT_INVALID");
    if (code === 41 && --nesting < 0) fail("IFC_INPUT_INVALID");
    const token =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95;
    tokenBytes = token ? tokenBytes + 1 : 0;
    if (tokenBytes > IFC_MAX_STEP_TOKEN_BYTES) fail("IFC_INPUT_INVALID");
    const number = code >= 48 && code <= 57;
    numberBytes = number ? numberBytes + 1 : 0;
    if (numberBytes > IFC_MAX_STEP_NUMBER_BYTES) fail("IFC_INPUT_INVALID");
    if (code === 35 && ++entityCount > IFC_MAX_ELEMENTS) fail("IFC_INPUT_INVALID");
  }
  if (quoted || nesting !== 0) fail("IFC_INPUT_INVALID");

  const head = text
    .slice(0, Math.min(text.length, 64 * 1024))
    .replace(/^\uFEFF/, "")
    .trimStart();
  const tail = text.slice(-512).trimEnd();
  if (
    head.includes("\0") ||
    !head.startsWith("ISO-10303-21;") ||
    !/\bHEADER\s*;/i.test(head) ||
    !/\bDATA\s*;/i.test(head) ||
    !/END-ISO-10303-21\s*;$/i.test(tail)
  ) {
    fail("IFC_INPUT_INVALID");
  }
  const schemaMatch = head.match(
    /FILE_SCHEMA\s*\(\s*\(\s*['"](IFC(?:2X3|4(?:X[123])?)(?:_[A-Z0-9]+)*)['"]/i,
  );
  if (!schemaMatch) fail("IFC_INPUT_INVALID");
  const normalized = schemaMatch[1].toUpperCase().match(/^IFC(?:2X3|4(?:X[123])?)/)?.[0];
  if (!normalized) fail("IFC_INPUT_INVALID");
  return normalized;
}

function boundedCount(value: unknown, maximum: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : 0;
}

export function assertIfcRadiusMeters(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > IFC_MAX_RADIUS_METERS
  ) {
    fail("IFC_RADIUS_INVALID");
  }
  return value;
}

function safeSchema(value: unknown): string {
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.trim().toUpperCase();
  return /^IFC(?:2X3|4(?:X[123])?)$/.test(normalized) ? normalized : "UNKNOWN";
}

export function createIfcImportSummary(input: IfcSummaryInput): IfcImportSummary {
  return {
    sourceFormat: "IFC",
    schema: safeSchema(input.schema),
    elementCount: boundedCount(input.elementCount, IFC_MAX_ELEMENTS),
    meshCount: boundedCount(input.meshCount, IFC_MAX_PLACED_MESHES),
    triangleCount: boundedCount(input.triangleCount, IFC_MAX_TRIANGLES),
    glbBytes: boundedCount(input.glbBytes, IFC_MAX_GLB_BYTES),
    radiusMeters: assertIfcRadiusMeters(input.radiusMeters),
    parser: "web-ifc",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("IFC_GLB_INVALID");
  }
  return value as Record<string, unknown>;
}

function safeArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("IFC_GLB_INVALID");
  return value;
}

function safeInteger(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail("IFC_GLB_INVALID");
  }
  return value;
}

function validateBoundedGltfJson(value: unknown): void {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: "$", depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; path: string; depth: number };
    nodes += 1;
    if (nodes > IFC_MAX_GLB_JSON_NODES || current.depth > IFC_MAX_GLB_JSON_DEPTH) {
      fail("IFC_GLB_INVALID");
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > IFC_MAX_GLB_ARRAY_LENGTH) fail("IFC_GLB_INVALID");
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const entries = Object.entries(current.value as Record<string, unknown>);
    if (entries.length > IFC_MAX_GLB_OBJECT_KEYS) fail("IFC_GLB_INVALID");
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      if (
        key === "extras" ||
        key === "uri" ||
        key === "extensions" ||
        key === "extensionsUsed" ||
        key === "extensionsRequired"
      ) {
        fail("IFC_GLB_INVALID");
      }
      if (
        key === "name" &&
        !(child === "AuxScene" && /^\$\.scenes\[\d+\]$/.test(current.path))
      ) {
        fail("IFC_GLB_INVALID");
      }
      stack.push({
        value: child,
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
      });
    }
  }
}

function readUnsignedIndex(
  bin: Uint8Array,
  byteOffset: number,
  componentType: number,
): number {
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (componentType === 5121) return view.getUint8(byteOffset);
  if (componentType === 5123) return view.getUint16(byteOffset, true);
  if (componentType === 5125) return view.getUint32(byteOffset, true);
  fail("IFC_GLB_INVALID");
}

function validateGltfJson(json: unknown, bin: Uint8Array): void {
  const binLength = bin.byteLength;
  const root = asRecord(json);
  const asset = asRecord(root.asset);
  if (asset.version !== "2.0") fail("IFC_GLB_INVALID");
  validateBoundedGltfJson(root);

  const buffers = safeArray(root.buffers);
  if (buffers.length > 1) fail("IFC_GLB_INVALID");
  let declaredBufferLength = 0;
  if (buffers.length === 1) {
    const buffer = asRecord(buffers[0]);
    if (buffer.uri !== undefined) fail("IFC_GLB_INVALID");
    declaredBufferLength = safeInteger(buffer.byteLength, 0, binLength);
    if (declaredBufferLength > binLength) fail("IFC_GLB_INVALID");
  } else if (binLength !== 0) {
    fail("IFC_GLB_INVALID");
  }

  const views = safeArray(root.bufferViews).map((raw) => {
    const view = asRecord(raw);
    if (safeInteger(view.buffer, 0, 0) !== 0) fail("IFC_GLB_INVALID");
    const byteOffset = view.byteOffset === undefined
      ? 0
      : safeInteger(view.byteOffset, 0, declaredBufferLength);
    const byteLength = safeInteger(view.byteLength, 0, declaredBufferLength);
    if (byteOffset + byteLength > declaredBufferLength) fail("IFC_GLB_INVALID");
    if (view.byteStride !== undefined) safeInteger(view.byteStride, 4, 252);
    return { byteOffset, byteLength, byteStride: view.byteStride };
  });

  const componentBytes: Record<number, number> = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  };
  const typeComponents: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  };
  const accessors = safeArray(root.accessors).map((raw) => {
    const accessor = asRecord(raw);
    if (accessor.sparse !== undefined) fail("IFC_GLB_INVALID");
    const viewIndex = safeInteger(accessor.bufferView, 0, views.length - 1);
    const componentType = safeInteger(accessor.componentType, 5120, 5126);
    const bytes = componentBytes[componentType];
    const components = typeof accessor.type === "string"
      ? typeComponents[accessor.type]
      : undefined;
    if (!bytes || !components) fail("IFC_GLB_INVALID");
    const count = safeInteger(accessor.count, 0, IFC_MAX_INDICES);
    const byteOffset = accessor.byteOffset === undefined
      ? 0
      : safeInteger(accessor.byteOffset, 0, views[viewIndex].byteLength);
    const elementBytes = bytes * components;
    const stride = typeof views[viewIndex].byteStride === "number"
      ? views[viewIndex].byteStride
      : elementBytes;
    const needed = count === 0 ? 0 : byteOffset + stride * (count - 1) + elementBytes;
    if (needed > views[viewIndex].byteLength) fail("IFC_GLB_INVALID");
    return {
      count,
      componentType,
      type: accessor.type,
      viewIndex,
      byteOffset,
      stride,
    };
  });

  const materials = safeArray(root.materials);
  let primitiveCount = 0;
  for (const meshRaw of safeArray(root.meshes)) {
    const mesh = asRecord(meshRaw);
    for (const primitiveRaw of safeArray(mesh.primitives)) {
      primitiveCount += 1;
      if (primitiveCount > IFC_MAX_GLB_PRIMITIVES) fail("IFC_GLB_INVALID");
      const primitive = asRecord(primitiveRaw);
      if (primitive.mode !== undefined && primitive.mode !== 4) fail("IFC_GLB_INVALID");
      const attributes = asRecord(primitive.attributes);
      const positionIndex = safeInteger(attributes.POSITION, 0, accessors.length - 1);
      const position = accessors[positionIndex];
      if (position.type !== "VEC3" || position.componentType !== 5126) {
        fail("IFC_GLB_INVALID");
      }
      if (position.count > IFC_MAX_VERTICES) fail("IFC_GLB_INVALID");
      if (primitive.indices !== undefined) {
        const index = accessors[safeInteger(primitive.indices, 0, accessors.length - 1)];
        if (index.type !== "SCALAR" || ![5121, 5123, 5125].includes(index.componentType)) {
          fail("IFC_GLB_INVALID");
        }
        if (index.count % 3 !== 0) fail("IFC_GLB_INVALID");
        const indexView = views[index.viewIndex];
        for (let element = 0; element < index.count; element += 1) {
          const offset = indexView.byteOffset + index.byteOffset + index.stride * element;
          if (readUnsignedIndex(bin, offset, index.componentType) >= position.count) {
            fail("IFC_GLB_INVALID");
          }
        }
      } else if (position.count % 3 !== 0) {
        fail("IFC_GLB_INVALID");
      }
      if (primitive.material !== undefined) {
        safeInteger(primitive.material, 0, materials.length - 1);
      }
    }
  }

  for (const imageRaw of safeArray(root.images)) {
    const image = asRecord(imageRaw);
    if (image.uri !== undefined || image.bufferView === undefined) {
      fail("IFC_GLB_INVALID");
    }
    safeInteger(image.bufferView, 0, views.length - 1);
  }
}

/** Validate GLB chunks, embedded-only resources, accessors, and metadata absence. */
export function validateGlb(glb: Uint8Array): void {
  if (glb.byteLength > IFC_MAX_GLB_BYTES) fail("IFC_GLB_TOO_LARGE");
  if (glb.byteLength < 20) fail("IFC_GLB_INVALID");
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== glb.byteLength
  ) {
    fail("IFC_GLB_INVALID");
  }

  let offset = 12;
  let jsonValue: unknown;
  let bin: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let chunkIndex = 0;
  while (offset < glb.byteLength) {
    if (offset + 8 > glb.byteLength) fail("IFC_GLB_INVALID");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 !== 0 || length > glb.byteLength - offset - 8) {
      fail("IFC_GLB_INVALID");
    }
    const start = offset + 8;
    const end = start + length;
    if (chunkIndex === 0) {
      if (type !== GLB_JSON_CHUNK || length > IFC_MAX_GLB_JSON_BYTES) {
        fail("IFC_GLB_INVALID");
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true })
          .decode(glb.subarray(start, end))
          .replace(/[\u0000\u0020]+$/g, "");
        jsonValue = JSON.parse(text);
      } catch {
        fail("IFC_GLB_INVALID");
      }
    } else {
      if (type !== GLB_BIN_CHUNK || bin.byteLength !== 0) fail("IFC_GLB_INVALID");
      bin = glb.subarray(start, end);
    }
    offset = end;
    chunkIndex += 1;
  }
  if (offset !== glb.byteLength || jsonValue === undefined) fail("IFC_GLB_INVALID");
  validateGltfJson(jsonValue, bin);
}
