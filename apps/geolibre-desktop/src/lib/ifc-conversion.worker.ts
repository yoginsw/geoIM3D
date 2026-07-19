/// <reference lib="webworker" />

import { convertIfcToGlb } from "./ifc-conversion";

interface ConvertMessage {
  type: "convert";
  bytes: ArrayBuffer;
}

const ALLOWED_ERRORS = new Set([
  "IFC_INPUT_EMPTY",
  "IFC_INPUT_TOO_LARGE",
  "IFC_INPUT_INVALID",
  "IFC_PARSE_FAILED",
  "IFC_GEOMETRY_EMPTY",
  "IFC_GEOMETRY_INVALID",
  "IFC_ELEMENT_LIMIT",
  "IFC_MESH_LIMIT",
  "IFC_GEOMETRY_LIMIT",
  "IFC_TRIANGLE_LIMIT",
  "IFC_GLB_TOO_LARGE",
  "IFC_GLB_INVALID",
]);

self.onmessage = async (event: MessageEvent<ConvertMessage>) => {
  if (event.data?.type !== "convert" || !(event.data.bytes instanceof ArrayBuffer)) {
    self.postMessage({ type: "error", code: "IFC_CONVERSION_FAILED" });
    return;
  }
  try {
    const result = await convertIfcToGlb(new Uint8Array(event.data.bytes));
    const output = result.glb.slice();
    self.postMessage(
      {
        type: "success",
        glb: output.buffer,
        radiusMeters: result.radiusMeters,
        summary: result.summary,
      },
      { transfer: [output.buffer] },
    );
  } catch (error) {
    const code =
      error instanceof Error && ALLOWED_ERRORS.has(error.message)
        ? error.message
        : "IFC_CONVERSION_FAILED";
    self.postMessage({ type: "error", code });
  }
};
