import type { GeoLibreProject } from "@geolibre/core";
import { buildCanonicalViewshedProjectDto } from "./viewshed-project";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface Sink {
  length: number;
  hash: number;
  bytes?: Uint8Array;
}

function pushByte(sink: Sink, byte: number): void {
  if (sink.length >= MAX_OUTPUT_BYTES)
    throw new Error("VIEWSHED_LIMIT_EXCEEDED");
  if (sink.bytes) sink.bytes[sink.length] = byte;
  sink.length += 1;
  sink.hash ^= byte;
  sink.hash = Math.imul(sink.hash, 0x01000193) >>> 0;
}

function ascii(sink: Sink, value: string): void {
  for (let index = 0; index < value.length; index += 1)
    pushByte(sink, value.charCodeAt(index));
}

function codePoint(sink: Sink, value: number): void {
  if (value <= 0x7f) return pushByte(sink, value);
  if (value <= 0x7ff) {
    pushByte(sink, 0xc0 | (value >> 6));
    pushByte(sink, 0x80 | (value & 0x3f));
    return;
  }
  if (value <= 0xffff) {
    pushByte(sink, 0xe0 | (value >> 12));
    pushByte(sink, 0x80 | ((value >> 6) & 0x3f));
    pushByte(sink, 0x80 | (value & 0x3f));
    return;
  }
  pushByte(sink, 0xf0 | (value >> 18));
  pushByte(sink, 0x80 | ((value >> 12) & 0x3f));
  pushByte(sink, 0x80 | ((value >> 6) & 0x3f));
  pushByte(sink, 0x80 | (value & 0x3f));
}

function hex4(value: number): string {
  return value.toString(16).padStart(4, "0");
}

function stringToken(sink: Sink, value: string): void {
  pushByte(sink, 0x22);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22) {
      ascii(sink, '\\"');
      continue;
    }
    if (unit === 0x5c) {
      ascii(sink, "\\\\");
      continue;
    }
    if (unit === 0x08) {
      ascii(sink, "\\b");
      continue;
    }
    if (unit === 0x09) {
      ascii(sink, "\\t");
      continue;
    }
    if (unit === 0x0a) {
      ascii(sink, "\\n");
      continue;
    }
    if (unit === 0x0c) {
      ascii(sink, "\\f");
      continue;
    }
    if (unit === 0x0d) {
      ascii(sink, "\\r");
      continue;
    }
    if (unit < 0x20) {
      ascii(sink, `\\u${hex4(unit)}`);
      continue;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint(sink, 0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00);
        index += 1;
      } else {
        ascii(sink, `\\u${hex4(unit)}`);
      }
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      ascii(sink, `\\u${hex4(unit)}`);
      continue;
    }
    codePoint(sink, unit);
  }
  pushByte(sink, 0x22);
}

function walk(sink: Sink, value: unknown, ancestors: Set<object>): void {
  if (value === null) return ascii(sink, "null");
  if (typeof value === "boolean") return ascii(sink, value ? "true" : "false");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("VIEWSHED_PROJECT_INVALID");
    return ascii(sink, Object.is(value, -0) ? "0" : String(value));
  }
  if (typeof value === "string") return stringToken(sink, value);
  if (typeof value !== "object" || value === undefined)
    throw new Error("VIEWSHED_PROJECT_INVALID");
  if (ancestors.has(value)) throw new Error("VIEWSHED_PROJECT_INVALID");
  ancestors.add(value);
  if (Array.isArray(value)) {
    pushByte(sink, 0x5b);
    value.forEach((child, index) => {
      if (index > 0) pushByte(sink, 0x2c);
      walk(sink, child, ancestors);
    });
    pushByte(sink, 0x5d);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("VIEWSHED_PROJECT_INVALID");
    pushByte(sink, 0x7b);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    keys.forEach((key, index) => {
      if (record[key] === undefined)
        throw new Error("VIEWSHED_PROJECT_INVALID");
      if (index > 0) pushByte(sink, 0x2c);
      stringToken(sink, key);
      pushByte(sink, 0x3a);
      walk(sink, record[key], ancestors);
    });
    pushByte(sink, 0x7d);
  }
  ancestors.delete(value);
}

/** @internal Exact writer boundary seam; production calls this after canonical reconstruction. */
export function serializeCanonicalJsonUtf8ForTest(value: unknown): Uint8Array {
  const measured: Sink = { length: 0, hash: 0x811c9dc5 };
  walk(measured, value, new Set());
  const bytes = new Uint8Array(measured.length);
  const written: Sink = { length: 0, hash: 0x811c9dc5, bytes };
  walk(written, value, new Set());
  if (written.length !== measured.length || written.hash !== measured.hash) {
    throw new Error("VIEWSHED_PROJECT_INVALID");
  }
  return bytes;
}

export function serializeViewshedProjectUtf8(
  value: GeoLibreProject
): Uint8Array {
  return serializeCanonicalJsonUtf8ForTest(
    buildCanonicalViewshedProjectDto(value)
  );
}

export const VIEWSHED_PROJECT_MAX_OUTPUT_BYTES = MAX_OUTPUT_BYTES;
