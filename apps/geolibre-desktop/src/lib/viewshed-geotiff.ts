import { fromArrayBuffer } from "geotiff";
import {
  VIEWSHED_MAX_INPUT_BYTES,
  VIEWSHED_MAX_PIXELS,
  type ViewshedRaster,
} from "./viewshed-analysis";
import {
  VIEWSHED_MEMORY_BUDGET_BYTES,
  VIEWSHED_PARSER_RESERVE_BYTES,
  VIEWSHED_RUNTIME_RESERVE_BYTES,
  ViewshedMemoryLedger,
} from "./viewshed-memory";

const MAX_DECODED_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_STRIPS = 100_000;
const MAX_STRIP_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 10_000;
const MAX_RESOLUTION = 100;
const MIN_RESOLUTION = 0.01;
export const VIEWSHED_WORKER_PEAK_BUDGET_BYTES = VIEWSHED_MEMORY_BUDGET_BYTES;

type FileDirectory = {
  hasTag(tag: string | number): boolean;
  loadValue(tag: string | number): Promise<unknown>;
  actualizedFields?: Map<unknown, unknown>;
  deferredFields?: Map<unknown, unknown>;
  deferredArrays?: Map<unknown, unknown>;
};

function fail(code: string): never {
  throw new Error(code);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numbers(value: unknown, maxItems: number): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const source = value as ArrayLike<unknown>;
    if (source.length > maxItems) fail("VIEWSHED_LIMIT_EXCEEDED");
    const result = new Array<number>(source.length);
    for (let index = 0; index < source.length; index += 1) {
      const item = source[index];
      if (!finite(item)) fail("VIEWSHED_TIFF_INVALID");
      result[index] = item;
    }
    return result;
  }
  fail("VIEWSHED_TIFF_INVALID");
}

async function optionalNumbers(
  directory: FileDirectory,
  tag: string | number,
  maxItems = 16
): Promise<number[] | null> {
  if (!directory.hasTag(tag)) return null;
  return numbers(await directory.loadValue(tag), maxItems);
}

function assertMaterializedMetadataBound(directory: FileDirectory): number {
  const maps = [
    directory.actualizedFields,
    directory.deferredFields,
    directory.deferredArrays,
  ];
  let count = 0;
  let size = 0;
  for (const map of maps) {
    if (!map) continue;
    count += map.size;
    if (count > 256) fail("VIEWSHED_LIMIT_EXCEEDED");
    for (const [key, value] of map) {
      size += String(key).length * 2;
      if (typeof value === "string") {
        size += new TextEncoder().encode(value).byteLength;
      } else if (ArrayBuffer.isView(value)) {
        size += value.byteLength;
      } else if (value instanceof ArrayBuffer) {
        size += value.byteLength;
      } else if (Array.isArray(value)) {
        size += value.length * 8;
      } else {
        size += 16;
      }
      if (size > MAX_METADATA_BYTES) fail("VIEWSHED_LIMIT_EXCEEDED");
    }
  }
  return size;
}

function assertClassicTiff(bytes: ArrayBuffer): void {
  if (bytes.byteLength < 8 || bytes.byteLength > VIEWSHED_MAX_INPUT_BYTES) {
    fail(
      bytes.byteLength > VIEWSHED_MAX_INPUT_BYTES
        ? "VIEWSHED_FILE_TOO_LARGE"
        : "VIEWSHED_TIFF_INVALID"
    );
  }
  const magic = new Uint8Array(bytes, 0, 4);
  if (
    !(
      (magic[0] === 0x49 &&
        magic[1] === 0x49 &&
        magic[2] === 42 &&
        magic[3] === 0) ||
      (magic[0] === 0x4d &&
        magic[1] === 0x4d &&
        magic[2] === 0 &&
        magic[3] === 42)
    )
  ) {
    fail("VIEWSHED_TIFF_INVALID");
  }
}

const TIFF_TYPE_BYTES: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};
const MATERIALIZED_TAG_MAX_ITEMS: Readonly<Record<number, number>> = {
  254: 1,
  256: 1,
  257: 1,
  258: 1,
  259: 1,
  262: 1,
  273: MAX_STRIPS,
  277: 1,
  278: 1,
  279: MAX_STRIPS,
  284: 1,
  339: 1,
  33550: 3,
  33922: 6,
  34735: 64,
  34736: 32,
  34737: 1024,
  42112: MAX_METADATA_BYTES,
  42113: 64,
};
const ALLOWED_TAG_TYPES: Readonly<Record<number, readonly number[]>> = {
  254: [3, 4],
  256: [3, 4],
  257: [3, 4],
  258: [3],
  259: [3],
  262: [3],
  273: [3, 4],
  277: [3],
  278: [3, 4],
  279: [3, 4],
  284: [3],
  339: [3],
  33550: [12],
  33922: [12],
  34735: [3],
  34736: [12],
  34737: [2],
  42112: [2],
  42113: [2],
};

function checkedProduct(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) fail("VIEWSHED_LIMIT_EXCEEDED");
  return value;
}

interface ClassicIfdPreflight {
  littleEndian: boolean;
  stripOffsets: number[];
  stripByteCounts: number[];
  gdalMetadata: string | null;
}

interface IfdEntryDescriptor {
  type: number;
  count: number;
  fieldBytes: number;
  entryOffset: number;
}

function materializeIfdNumbers(
  view: DataView,
  littleEndian: boolean,
  descriptor: IfdEntryDescriptor
): number[] {
  if (descriptor.type !== 3 && descriptor.type !== 4)
    fail("VIEWSHED_TIFF_INVALID");
  const valueOffset =
    descriptor.fieldBytes <= 4
      ? descriptor.entryOffset + 8
      : view.getUint32(descriptor.entryOffset + 8, littleEndian);
  const values = new Array<number>(descriptor.count);
  for (let index = 0; index < descriptor.count; index += 1) {
    values[index] =
      descriptor.type === 3
        ? view.getUint16(valueOffset + index * 2, littleEndian)
        : view.getUint32(valueOffset + index * 4, littleEndian);
  }
  if (
    values.length !== descriptor.count ||
    checkedProduct(values.length, descriptor.type === 3 ? 2 : 4) !==
      descriptor.fieldBytes ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    fail("VIEWSHED_TIFF_INVALID");
  }
  return values;
}

/** Bound every IFD-controlled allocation before geotiff.js parses the file. */
function preflightBoundedClassicIfd(bytes: ArrayBuffer): ClassicIfdPreflight {
  const view = new DataView(bytes);
  const littleEndian = view.getUint8(0) === 0x49;
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset < 8 || ifdOffset + 2 > bytes.byteLength) {
    fail("VIEWSHED_TIFF_INVALID");
  }
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  if (entryCount < 1 || entryCount > 256) fail("VIEWSHED_LIMIT_EXCEEDED");
  const directoryEnd = ifdOffset + 2 + entryCount * 12;
  if (
    !Number.isSafeInteger(directoryEnd) ||
    directoryEnd + 4 > bytes.byteLength
  ) {
    fail("VIEWSHED_TIFF_INVALID");
  }

  let metadataBytes = 0;
  let stripOffsetsCount: number | null = null;
  let stripByteCountsCount: number | null = null;
  let stripOffsetsDescriptor: IfdEntryDescriptor | null = null;
  let stripByteCountsDescriptor: IfdEntryDescriptor | null = null;
  let gdalMetadataDescriptor: IfdEntryDescriptor | null = null;
  const tags = new Set<number>();
  for (let index = 0; index < entryCount; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    const tag = view.getUint16(offset, littleEndian);
    const type = view.getUint16(offset + 2, littleEndian);
    const count = view.getUint32(offset + 4, littleEndian);
    const typeBytes = TIFF_TYPE_BYTES[type];
    if (tags.has(tag) || !typeBytes || count < 1) fail("VIEWSHED_TIFF_INVALID");
    tags.add(tag);
    const fieldBytes = checkedProduct(count, typeBytes);
    const maximumItems = MATERIALIZED_TAG_MAX_ITEMS[tag];
    const allowedTypes = ALLOWED_TAG_TYPES[tag];
    if (maximumItems === undefined || !allowedTypes?.includes(type)) {
      fail("VIEWSHED_TIFF_INVALID");
    }
    if (count > maximumItems) {
      fail("VIEWSHED_LIMIT_EXCEEDED");
    }
    metadataBytes += fieldBytes;
    if (
      !Number.isSafeInteger(metadataBytes) ||
      metadataBytes > MAX_METADATA_BYTES
    ) {
      fail("VIEWSHED_LIMIT_EXCEEDED");
    }
    if (fieldBytes > 4) {
      const valueOffset = view.getUint32(offset + 8, littleEndian);
      const valueEnd = valueOffset + fieldBytes;
      if (
        !Number.isSafeInteger(valueEnd) ||
        valueOffset < 8 ||
        valueEnd > bytes.byteLength
      ) {
        fail("VIEWSHED_TIFF_INVALID");
      }
    }
    if (tag === 273) stripOffsetsCount = count;
    if (tag === 279) stripByteCountsCount = count;
    const descriptor = { type, count, fieldBytes, entryOffset: offset };
    if (tag === 273) stripOffsetsDescriptor = descriptor;
    if (tag === 279) stripByteCountsDescriptor = descriptor;
    if (tag === 42112) {
      if (type !== 2) fail("VIEWSHED_TIFF_INVALID");
      gdalMetadataDescriptor = descriptor;
    }
    if ((tag === 273 || tag === 279) && count > MAX_STRIPS) {
      fail("VIEWSHED_LIMIT_EXCEEDED");
    }
    if (tag === 330) fail("VIEWSHED_TIFF_INVALID");
    if (tag === 254) {
      if (count !== 1 || (type !== 3 && type !== 4))
        fail("VIEWSHED_TIFF_INVALID");
      const value =
        type === 3
          ? view.getUint16(offset + 8, littleEndian)
          : view.getUint32(offset + 8, littleEndian);
      if (value !== 0) fail("VIEWSHED_TIFF_INVALID");
    }
    if (tag === 255) fail("VIEWSHED_TIFF_INVALID");
  }
  if (
    stripOffsetsCount === null ||
    stripByteCountsCount === null ||
    stripOffsetsCount !== stripByteCountsCount
  ) {
    fail("VIEWSHED_TIFF_INVALID");
  }
  if (view.getUint32(directoryEnd, littleEndian) !== 0) {
    fail("VIEWSHED_TIFF_INVALID");
  }
  if (!stripOffsetsDescriptor || !stripByteCountsDescriptor) {
    fail("VIEWSHED_TIFF_INVALID");
  }
  const stripOffsets = materializeIfdNumbers(
    view,
    littleEndian,
    stripOffsetsDescriptor
  );
  const stripByteCounts = materializeIfdNumbers(
    view,
    littleEndian,
    stripByteCountsDescriptor
  );
  let gdalMetadata: string | null = null;
  if (gdalMetadataDescriptor) {
    const valueOffset =
      gdalMetadataDescriptor.fieldBytes <= 4
        ? gdalMetadataDescriptor.entryOffset + 8
        : view.getUint32(gdalMetadataDescriptor.entryOffset + 8, littleEndian);
    const raw = new Uint8Array(
      bytes,
      valueOffset,
      gdalMetadataDescriptor.fieldBytes
    );
    if (raw.byteLength !== gdalMetadataDescriptor.fieldBytes) {
      fail("VIEWSHED_TIFF_INVALID");
    }
    const end = raw[raw.length - 1] === 0 ? raw.length - 1 : raw.length;
    try {
      gdalMetadata = new TextDecoder("utf-8", { fatal: true }).decode(
        raw.subarray(0, end)
      );
      const actualBytes = new TextEncoder().encode(gdalMetadata).byteLength;
      if (actualBytes !== end || actualBytes > MAX_METADATA_BYTES) {
        fail("VIEWSHED_TIFF_INVALID");
      }
    } catch {
      fail("VIEWSHED_TIFF_INVALID");
    }
  }
  return { littleEndian, stripOffsets, stripByteCounts, gdalMetadata };
}

function assertSampleContract(
  bits: number[],
  sampleFormat: number[],
  compression: number[],
  samples: number
): void {
  if (
    samples !== 1 ||
    bits.length !== 1 ||
    sampleFormat.length !== 1 ||
    compression.length !== 1 ||
    compression[0] !== 1 ||
    ![1, 2, 3].includes(sampleFormat[0]) ||
    ![8, 16, 32, 64].includes(bits[0]) ||
    (sampleFormat[0] === 3 && bits[0] !== 32 && bits[0] !== 64) ||
    (sampleFormat[0] !== 3 && bits[0] === 64)
  ) {
    fail("VIEWSHED_SAMPLE_UNSUPPORTED");
  }
}

export function isViewshedNoDataLossless(
  nodata: number,
  bits: number,
  sampleFormat: number
): boolean {
  if (!finite(nodata)) return false;
  if (sampleFormat === 3)
    return bits === 64 || (bits === 32 && Math.fround(nodata) === nodata);
  if ((sampleFormat !== 1 && sampleFormat !== 2) || ![8, 16, 32].includes(bits))
    return false;
  const minimum = sampleFormat === 1 ? 0 : -(2 ** (bits - 1));
  const maximum = sampleFormat === 1 ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
  return Number.isInteger(nodata) && nodata >= minimum && nodata <= maximum;
}

function assertStripRanges(
  offsets: number[],
  counts: number[],
  fileBytes: number,
  width: number,
  height: number,
  rowsPerStrip: number,
  bytesPerSample: number
): void {
  if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip < 1) {
    fail("VIEWSHED_TIFF_INVALID");
  }
  const expectedStrips = Math.ceil(height / rowsPerStrip);
  if (
    offsets.length === 0 ||
    offsets.length !== counts.length ||
    offsets.length !== expectedStrips ||
    offsets.length > MAX_STRIPS
  ) {
    fail("VIEWSHED_TIFF_INVALID");
  }
  const ranges = offsets.map((offset, index) => {
    const count = counts[index];
    const stripStartRow = index * rowsPerStrip;
    const stripRows = Math.min(rowsPerStrip, height - stripStartRow);
    const expectedCount = width * stripRows * bytesPerSample;
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(expectedCount) ||
      offset < 0 ||
      count < 1 ||
      count !== expectedCount ||
      count > MAX_STRIP_BYTES ||
      offset + count > fileBytes ||
      !Number.isSafeInteger(offset + count)
    ) {
      fail("VIEWSHED_TIFF_INVALID");
    }
    return [offset, offset + count] as const;
  });
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) fail("VIEWSHED_TIFF_INVALID");
  }
}

function decodeUncompressedSamples(
  bytes: ArrayBuffer,
  preflight: ClassicIfdPreflight,
  pixels: number,
  bits: number,
  sampleFormat: number
): ArrayLike<number> {
  let output:
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | Float32Array
    | Float64Array;
  if (sampleFormat === 1 && bits === 8) output = new Uint8Array(pixels);
  else if (sampleFormat === 2 && bits === 8) output = new Int8Array(pixels);
  else if (sampleFormat === 1 && bits === 16) output = new Uint16Array(pixels);
  else if (sampleFormat === 2 && bits === 16) output = new Int16Array(pixels);
  else if (sampleFormat === 1 && bits === 32) output = new Uint32Array(pixels);
  else if (sampleFormat === 2 && bits === 32) output = new Int32Array(pixels);
  else if (sampleFormat === 3 && bits === 32) output = new Float32Array(pixels);
  else if (sampleFormat === 3 && bits === 64) output = new Float64Array(pixels);
  else fail("VIEWSHED_SAMPLE_UNSUPPORTED");

  const view = new DataView(bytes);
  const bytesPerSample = bits / 8;
  let outputIndex = 0;
  for (
    let stripIndex = 0;
    stripIndex < preflight.stripOffsets.length;
    stripIndex += 1
  ) {
    const offset = preflight.stripOffsets[stripIndex];
    const count = preflight.stripByteCounts[stripIndex];
    for (
      let position = offset;
      position < offset + count;
      position += bytesPerSample
    ) {
      let value: number;
      if (sampleFormat === 1 && bits === 8) value = view.getUint8(position);
      else if (sampleFormat === 2 && bits === 8) value = view.getInt8(position);
      else if (sampleFormat === 1 && bits === 16) {
        value = view.getUint16(position, preflight.littleEndian);
      } else if (sampleFormat === 2 && bits === 16) {
        value = view.getInt16(position, preflight.littleEndian);
      } else if (sampleFormat === 1 && bits === 32) {
        value = view.getUint32(position, preflight.littleEndian);
      } else if (sampleFormat === 2 && bits === 32) {
        value = view.getInt32(position, preflight.littleEndian);
      } else if (bits === 32) {
        value = view.getFloat32(position, preflight.littleEndian);
      } else {
        value = view.getFloat64(position, preflight.littleEndian);
      }
      if (outputIndex >= pixels) fail("VIEWSHED_TIFF_INVALID");
      output[outputIndex] = value;
      outputIndex += 1;
    }
  }
  if (outputIndex !== pixels) fail("VIEWSHED_TIFF_INVALID");
  return output;
}

export function estimateViewshedWorkerPeakBytes(
  inputBytes: number,
  decodedBytes: number,
  largestStripBytes: number
): number {
  const values = [inputBytes, decodedBytes, largestStripBytes];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    inputBytes > VIEWSHED_MAX_INPUT_BYTES ||
    decodedBytes > MAX_DECODED_BYTES ||
    largestStripBytes > MAX_STRIP_BYTES
  ) {
    fail("VIEWSHED_LIMIT_EXCEEDED");
  }
  const peak =
    inputBytes +
    decodedBytes +
    Math.max(largestStripBytes, VIEWSHED_PARSER_RESERVE_BYTES) +
    VIEWSHED_RUNTIME_RESERVE_BYTES;
  if (!Number.isSafeInteger(peak) || peak > VIEWSHED_WORKER_PEAK_BUDGET_BYTES) {
    fail("VIEWSHED_LIMIT_EXCEEDED");
  }
  return peak;
}

export async function decodeViewshedGeoTiff(
  bytes: ArrayBuffer,
  ledger = new ViewshedMemoryLedger()
): Promise<ViewshedRaster> {
  ledger.reserve("input", bytes.byteLength);
  ledger.reserve("parser", VIEWSHED_PARSER_RESERVE_BYTES);
  ledger.reserve("runtime", VIEWSHED_RUNTIME_RESERVE_BYTES);
  ledger.reserve("decoded", MAX_DECODED_BYTES);
  assertClassicTiff(bytes);
  const preflight = preflightBoundedClassicIfd(bytes);
  estimateViewshedWorkerPeakBytes(
    bytes.byteLength,
    MAX_DECODED_BYTES,
    MAX_STRIP_BYTES
  );
  try {
    const tiff = await fromArrayBuffer(bytes);
    if ((await tiff.getImageCount()) !== 1) fail("VIEWSHED_TIFF_INVALID");
    const image = await tiff.getImage();
    const directory = image.fileDirectory as unknown as FileDirectory;
    assertMaterializedMetadataBound(directory);

    if (
      directory.hasTag("TileOffsets") ||
      directory.hasTag("TileByteCounts") ||
      directory.hasTag("ModelTransformation") ||
      directory.hasTag(50844) ||
      directory.hasTag("ExtraSamples")
    ) {
      fail("VIEWSHED_TRANSFORM_UNSUPPORTED");
    }

    const width = image.getWidth();
    const height = image.getHeight();
    const samples = image.getSamplesPerPixel();
    const pixels = width * height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      !Number.isSafeInteger(pixels) ||
      pixels > VIEWSHED_MAX_PIXELS
    ) {
      fail("VIEWSHED_LIMIT_EXCEEDED");
    }

    const bits = (await optionalNumbers(directory, "BitsPerSample")) ?? [];
    const sampleFormat = (await optionalNumbers(directory, "SampleFormat")) ?? [
      1,
    ];
    const compression = (await optionalNumbers(directory, "Compression")) ?? [
      1,
    ];
    assertSampleContract(bits, sampleFormat, compression, samples);
    const photometric =
      (await optionalNumbers(directory, "PhotometricInterpretation")) ?? [];
    if (
      photometric.length !== 1 ||
      ![0, 1].includes(photometric[0]) ||
      directory.hasTag("ColorMap")
    ) {
      fail("VIEWSHED_SAMPLE_UNSUPPORTED");
    }
    const decodedBytes = pixels * (bits[0] / 8);
    if (
      !Number.isSafeInteger(decodedBytes) ||
      decodedBytes > MAX_DECODED_BYTES
    ) {
      fail("VIEWSHED_LIMIT_EXCEEDED");
    }
    ledger.resize("decoded", decodedBytes);

    const planar = (await optionalNumbers(
      directory,
      "PlanarConfiguration"
    )) ?? [1];
    if (planar.length !== 1 || planar[0] !== 1)
      fail("VIEWSHED_SAMPLE_UNSUPPORTED");
    const offsets = preflight.stripOffsets;
    const counts = preflight.stripByteCounts;
    const rowsPerStrip =
      (await optionalNumbers(directory, "RowsPerStrip")) ?? [];
    if (rowsPerStrip.length !== 1) fail("VIEWSHED_TIFF_INVALID");
    assertStripRanges(
      offsets,
      counts,
      bytes.byteLength,
      width,
      height,
      rowsPerStrip[0],
      bits[0] / 8
    );
    estimateViewshedWorkerPeakBytes(
      bytes.byteLength,
      decodedBytes,
      Math.max(...counts)
    );

    const pixelScale =
      (await optionalNumbers(directory, "ModelPixelScale")) ?? [];
    const tiepoint = (await optionalNumbers(directory, "ModelTiepoint")) ?? [];
    if (
      pixelScale.length !== 3 ||
      tiepoint.length !== 6 ||
      pixelScale[2] !== 0 ||
      tiepoint[2] !== 0 ||
      tiepoint[5] !== 0 ||
      pixelScale[0] < MIN_RESOLUTION ||
      pixelScale[0] > MAX_RESOLUTION ||
      pixelScale[1] < MIN_RESOLUTION ||
      pixelScale[1] > MAX_RESOLUTION
    ) {
      fail("VIEWSHED_TRANSFORM_UNSUPPORTED");
    }

    const geoKeys = (image.getGeoKeys() ?? {}) as Record<string, unknown>;
    const projectedCode = geoKeys.ProjectedCSTypeGeoKey;
    const rasterType = geoKeys.GTRasterTypeGeoKey;
    if (projectedCode !== 5179 && projectedCode !== 5186) {
      fail("VIEWSHED_CRS_UNSUPPORTED");
    }
    if (rasterType !== 1) {
      fail("VIEWSHED_TRANSFORM_UNSUPPORTED");
    }

    if (preflight.gdalMetadata !== null) {
      if (/name\s*=\s*["'](?:scale|offset)["']/i.test(preflight.gdalMetadata)) {
        fail("VIEWSHED_SAMPLE_UNSUPPORTED");
      }
    }
    const nodata = image.getGDALNoData();
    if (
      nodata !== null &&
      nodata !== undefined &&
      !isViewshedNoDataLossless(nodata, bits[0], sampleFormat[0])
    ) {
      fail("VIEWSHED_SAMPLE_UNSUPPORTED");
    }
    assertMaterializedMetadataBound(directory);

    const values = decodeUncompressedSamples(
      bytes,
      preflight,
      pixels,
      bits[0],
      sampleFormat[0]
    );
    return {
      values,
      width,
      height,
      tieI: tiepoint[0],
      tieJ: tiepoint[1],
      tieX: tiepoint[3],
      tieY: tiepoint[4],
      scaleX: pixelScale[0],
      scaleY: pixelScale[1],
      nodata: nodata ?? null,
      sourceCrs: projectedCode === 5179 ? "EPSG:5179" : "EPSG:5186",
    };
  } catch (error) {
    if (error instanceof Error && /^VIEWSHED_[A-Z_]+$/.test(error.message))
      throw error;
    fail("VIEWSHED_TIFF_INVALID");
  }
}
