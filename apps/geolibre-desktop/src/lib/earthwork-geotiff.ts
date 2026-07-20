import { fromArrayBuffer } from "geotiff";
import {
  EARTHWORK_MAX_INPUT_BYTES,
  EARTHWORK_MAX_PIXELS,
  type EarthworkRaster,
} from "./earthwork-analysis";

const MAX_DECODED_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_STRIPS = 100_000;
const MAX_STRIP_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 10_000;
const MAX_RESOLUTION = 100;
const MIN_RESOLUTION = 0.01;
export const EARTHWORK_WORKER_PEAK_BUDGET_BYTES = 128 * 1024 * 1024;
const PROJECTED_GEOMETRY_AND_METADATA_RESERVE_BYTES = 8 * 1024 * 1024;
const PARSER_AND_RUNTIME_RESERVE_BYTES = 32 * 1024 * 1024;

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
    if (source.length > maxItems) fail("EARTHWORK_LIMIT_EXCEEDED");
    const result = new Array<number>(source.length);
    for (let index = 0; index < source.length; index += 1) {
      const item = source[index];
      if (!finite(item)) fail("EARTHWORK_TIFF_INVALID");
      result[index] = item;
    }
    return result;
  }
  fail("EARTHWORK_TIFF_INVALID");
}

async function optionalNumbers(
  directory: FileDirectory,
  tag: string | number,
  maxItems = 16,
): Promise<number[] | null> {
  if (!directory.hasTag(tag)) return null;
  return numbers(await directory.loadValue(tag), maxItems);
}

function metadataSize(directory: FileDirectory): number {
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
    if (count > 256) fail("EARTHWORK_LIMIT_EXCEEDED");
    for (const [key, value] of map) {
      size += String(key).length * 2;
      if (typeof value === "string") size += value.length * 2;
      else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        size += (value as ArrayLike<unknown>).length * 8;
      } else {
        size += 16;
      }
      if (size > MAX_METADATA_BYTES) fail("EARTHWORK_LIMIT_EXCEEDED");
    }
  }
  return size;
}

function assertClassicTiff(bytes: ArrayBuffer): void {
  if (bytes.byteLength < 8 || bytes.byteLength > EARTHWORK_MAX_INPUT_BYTES) {
    fail(bytes.byteLength > EARTHWORK_MAX_INPUT_BYTES
      ? "EARTHWORK_FILE_TOO_LARGE"
      : "EARTHWORK_TIFF_INVALID");
  }
  const magic = new Uint8Array(bytes, 0, 4);
  if (
    !(
      (magic[0] === 0x49 && magic[1] === 0x49 && magic[2] === 42 && magic[3] === 0) ||
      (magic[0] === 0x4d && magic[1] === 0x4d && magic[2] === 0 && magic[3] === 42)
    )
  ) {
    fail("EARTHWORK_TIFF_INVALID");
  }
}

const TIFF_TYPE_BYTES: Readonly<Record<number, number>> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1,
  7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

function checkedProduct(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) fail("EARTHWORK_LIMIT_EXCEEDED");
  return value;
}

/** Bound IFD-controlled allocations before geotiff.js constructs deferred arrays. */
function assertBoundedClassicIfd(bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  const littleEndian = view.getUint8(0) === 0x49;
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset < 8 || ifdOffset + 2 > bytes.byteLength) {
    fail("EARTHWORK_TIFF_INVALID");
  }
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  if (entryCount < 1 || entryCount > 256) fail("EARTHWORK_LIMIT_EXCEEDED");
  const directoryEnd = ifdOffset + 2 + entryCount * 12;
  if (!Number.isSafeInteger(directoryEnd) || directoryEnd + 4 > bytes.byteLength) {
    fail("EARTHWORK_TIFF_INVALID");
  }

  let metadataBytes = 0;
  let stripOffsetsCount: number | null = null;
  let stripByteCountsCount: number | null = null;
  const tags = new Set<number>();
  for (let index = 0; index < entryCount; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    const tag = view.getUint16(offset, littleEndian);
    const type = view.getUint16(offset + 2, littleEndian);
    const count = view.getUint32(offset + 4, littleEndian);
    const typeBytes = TIFF_TYPE_BYTES[type];
    if (tags.has(tag) || !typeBytes || count < 1) fail("EARTHWORK_TIFF_INVALID");
    tags.add(tag);
    const fieldBytes = checkedProduct(count, typeBytes);
    metadataBytes += fieldBytes;
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes > MAX_METADATA_BYTES) {
      fail("EARTHWORK_LIMIT_EXCEEDED");
    }
    if (fieldBytes > 4) {
      const valueOffset = view.getUint32(offset + 8, littleEndian);
      const valueEnd = valueOffset + fieldBytes;
      if (!Number.isSafeInteger(valueEnd) || valueOffset < 8 || valueEnd > bytes.byteLength) {
        fail("EARTHWORK_TIFF_INVALID");
      }
    }
    if (tag === 273) stripOffsetsCount = count;
    if (tag === 279) stripByteCountsCount = count;
    if ((tag === 273 || tag === 279) && count > MAX_STRIPS) {
      fail("EARTHWORK_LIMIT_EXCEEDED");
    }
    if (tag === 330) fail("EARTHWORK_TIFF_INVALID");
    if (tag === 254) {
      if (count !== 1 || (type !== 3 && type !== 4)) fail("EARTHWORK_TIFF_INVALID");
      const value = type === 3
        ? view.getUint16(offset + 8, littleEndian)
        : view.getUint32(offset + 8, littleEndian);
      if (value !== 0) fail("EARTHWORK_TIFF_INVALID");
    }
    if (tag === 255) fail("EARTHWORK_TIFF_INVALID");
  }
  if (
    stripOffsetsCount === null ||
    stripByteCountsCount === null ||
    stripOffsetsCount !== stripByteCountsCount
  ) {
    fail("EARTHWORK_TIFF_INVALID");
  }
  if (view.getUint32(directoryEnd, littleEndian) !== 0) {
    fail("EARTHWORK_TIFF_INVALID");
  }
}

function assertSampleContract(
  bits: number[],
  sampleFormat: number[],
  compression: number[],
  samples: number,
): void {
  if (
    samples !== 1 ||
    bits.length !== 1 ||
    sampleFormat.length !== 1 ||
    compression.length !== 1 ||
    compression[0] !== 1 ||
    ![1, 2, 3].includes(sampleFormat[0]) ||
    ![8, 16, 32].includes(bits[0]) ||
    (sampleFormat[0] === 3 && bits[0] !== 32)
  ) {
    fail("EARTHWORK_SAMPLE_UNSUPPORTED");
  }
}

function assertStripRanges(
  offsets: number[],
  counts: number[],
  fileBytes: number,
  width: number,
  height: number,
  rowsPerStrip: number,
  bytesPerSample: number,
): void {
  if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip < 1) {
    fail("EARTHWORK_TIFF_INVALID");
  }
  const expectedStrips = Math.ceil(height / rowsPerStrip);
  if (
    offsets.length === 0 ||
    offsets.length !== counts.length ||
    offsets.length !== expectedStrips ||
    offsets.length > MAX_STRIPS
  ) {
    fail("EARTHWORK_TIFF_INVALID");
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
      fail("EARTHWORK_TIFF_INVALID");
    }
    return [offset, offset + count] as const;
  });
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) fail("EARTHWORK_TIFF_INVALID");
  }
}

export function estimateEarthworkWorkerPeakBytes(
  inputBytes: number,
  decodedBytes: number,
  largestStripBytes: number,
): number {
  const values = [inputBytes, decodedBytes, largestStripBytes];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("EARTHWORK_LIMIT_EXCEEDED");
  }
  const peak =
    inputBytes +
    decodedBytes +
    largestStripBytes +
    PROJECTED_GEOMETRY_AND_METADATA_RESERVE_BYTES +
    PARSER_AND_RUNTIME_RESERVE_BYTES;
  if (!Number.isSafeInteger(peak) || peak > EARTHWORK_WORKER_PEAK_BUDGET_BYTES) {
    fail("EARTHWORK_LIMIT_EXCEEDED");
  }
  return peak;
}

export async function decodeEarthworkGeoTiff(
  bytes: ArrayBuffer,
): Promise<EarthworkRaster> {
  assertClassicTiff(bytes);
  assertBoundedClassicIfd(bytes);
  try {
    const tiff = await fromArrayBuffer(bytes);
    if ((await tiff.getImageCount()) !== 1) fail("EARTHWORK_TIFF_INVALID");
    const image = await tiff.getImage();
    const directory = image.fileDirectory as unknown as FileDirectory;
    metadataSize(directory);

    if (
      directory.hasTag("TileOffsets") ||
      directory.hasTag("TileByteCounts") ||
      directory.hasTag("ModelTransformation") ||
      directory.hasTag(50844) ||
      directory.hasTag("ExtraSamples")
    ) {
      fail("EARTHWORK_TRANSFORM_UNSUPPORTED");
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
      pixels > EARTHWORK_MAX_PIXELS
    ) {
      fail("EARTHWORK_LIMIT_EXCEEDED");
    }

    const bits = (await optionalNumbers(directory, "BitsPerSample")) ?? [];
    const sampleFormat = (await optionalNumbers(directory, "SampleFormat")) ?? [1];
    const compression = (await optionalNumbers(directory, "Compression")) ?? [1];
    assertSampleContract(bits, sampleFormat, compression, samples);
    const photometric = (await optionalNumbers(directory, "PhotometricInterpretation")) ?? [];
    if (
      photometric.length !== 1 ||
      ![0, 1].includes(photometric[0]) ||
      directory.hasTag("ColorMap")
    ) {
      fail("EARTHWORK_SAMPLE_UNSUPPORTED");
    }
    const decodedBytes = pixels * (bits[0] / 8);
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_DECODED_BYTES) {
      fail("EARTHWORK_LIMIT_EXCEEDED");
    }

    const planar = (await optionalNumbers(directory, "PlanarConfiguration")) ?? [1];
    if (planar.length !== 1 || planar[0] !== 1) fail("EARTHWORK_SAMPLE_UNSUPPORTED");
    const offsets = (await optionalNumbers(directory, "StripOffsets", MAX_STRIPS)) ?? [];
    const counts = (await optionalNumbers(directory, "StripByteCounts", MAX_STRIPS)) ?? [];
    const rowsPerStrip = (await optionalNumbers(directory, "RowsPerStrip")) ?? [];
    if (rowsPerStrip.length !== 1) fail("EARTHWORK_TIFF_INVALID");
    assertStripRanges(
      offsets,
      counts,
      bytes.byteLength,
      width,
      height,
      rowsPerStrip[0],
      bits[0] / 8,
    );
    estimateEarthworkWorkerPeakBytes(
      bytes.byteLength,
      decodedBytes,
      Math.max(...counts),
    );

    const pixelScale = (await optionalNumbers(directory, "ModelPixelScale")) ?? [];
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
      fail("EARTHWORK_TRANSFORM_UNSUPPORTED");
    }

    const geoKeys = (image.getGeoKeys() ?? {}) as Record<string, unknown>;
    const projectedCode = geoKeys.ProjectedCSTypeGeoKey;
    const rasterType = geoKeys.GTRasterTypeGeoKey;
    if ((projectedCode !== 5179 && projectedCode !== 5186) || rasterType !== 1) {
      fail("EARTHWORK_CRS_UNSUPPORTED");
    }

    if (directory.hasTag("GDAL_METADATA")) {
      const metadata = String(await directory.loadValue("GDAL_METADATA"));
      if (metadata.length > MAX_METADATA_BYTES) fail("EARTHWORK_LIMIT_EXCEEDED");
      if (/name\s*=\s*["'](?:scale|offset)["']/i.test(metadata)) {
        fail("EARTHWORK_SAMPLE_UNSUPPORTED");
      }
    }
    const nodata = image.getGDALNoData();
    if (nodata !== null && nodata !== undefined && !finite(nodata)) {
      fail("EARTHWORK_SAMPLE_UNSUPPORTED");
    }

    const decoded = await image.readRasters({ samples: [0], interleave: true });
    const values = decoded as unknown as ArrayLike<number>;
    if (values.length !== pixels) fail("EARTHWORK_TIFF_INVALID");
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
    if (error instanceof Error && /^EARTHWORK_[A-Z_]+$/.test(error.message)) throw error;
    fail("EARTHWORK_TIFF_INVALID");
  }
}
