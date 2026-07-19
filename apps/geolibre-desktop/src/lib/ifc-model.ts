import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  assertIfcRadiusMeters,
  createIfcImportSummary,
  validateGlb,
  type IfcImportSummary,
  type IfcPlacement,
} from "./ifc-contract";

export {
  IFC_MAX_ELEMENTS,
  IFC_MAX_GEOMETRY_BYTES,
  IFC_MAX_GLB_BYTES,
  IFC_MAX_INDICES,
  IFC_MAX_INPUT_BYTES,
  IFC_MAX_PLACED_MESHES,
  IFC_MAX_PROJECT_GLB_BYTES,
  IFC_MAX_RADIUS_METERS,
  IFC_MAX_TRIANGLES,
  IFC_MAX_VERTICES,
  assertIfcRadiusMeters,
  createIfcImportSummary,
  parseIfcPlacement,
  validateGlb,
  validateIfcEnvelope,
} from "./ifc-contract";
export type {
  IfcImportSummary,
  IfcPlacement,
  IfcPlacementDraft,
} from "./ifc-contract";

interface BuildIfcModelLayerInput {
  glb: Uint8Array;
  placement: IfcPlacement;
  radiusMeters: number;
  summary: IfcImportSummary;
}

function glbDataUrl(glb: Uint8Array): string {
  validateGlb(glb);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < glb.length; offset += chunkSize) {
    binary += String.fromCharCode(...glb.subarray(offset, offset + chunkSize));
  }
  return `data:model/gltf-binary;base64,${btoa(binary)}`;
}

function modelBounds(
  placement: IfcPlacement,
  radiusMeters: number,
): [number, number, number, number] {
  const metersPerDegree = 111_320;
  const radius =
    Number.isFinite(radiusMeters) && radiusMeters > 0
      ? radiusMeters * placement.scale * 1.1
      : 0;
  const latPad = Math.max(0.002, radius / metersPerDegree);
  const cosLat = Math.max(
    Math.cos((placement.latitude * Math.PI) / 180),
    1e-6,
  );
  const lngPad = Math.max(0.002, radius / (metersPerDegree * cosLat));
  return [
    Math.max(-180, placement.longitude - lngPad),
    Math.max(-90, placement.latitude - latPad),
    Math.min(180, placement.longitude + lngPad),
    Math.min(90, placement.latitude + latPad),
  ];
}

/** Build a portable, self-contained IFC scenegraph layer without source paths. */
export function buildIfcModelLayer(input: BuildIfcModelLayerInput): GeoLibreLayer {
  try {
    assertIfcRadiusMeters(input.radiusMeters);
  } catch {
    throw new Error("IFC_MODEL_INVALID");
  }
  if (
    input.summary.radiusMeters !== input.radiusMeters ||
    input.summary.glbBytes !== input.glb.byteLength ||
    input.summary.elementCount < 1 ||
    input.summary.meshCount < 1 ||
    input.summary.triangleCount < 1
  ) {
    throw new Error("IFC_MODEL_INVALID");
  }
  const config = {
    layerKind: "scenegraph",
    format: "csv-rows",
    fieldMapping: {
      lng: "lng",
      lat: "lat",
      altitude: "altitude",
      bearing: "bearing",
      scale: "scale",
    },
    style: {
      color: "#3b82f6",
      radius: 40,
      cellSize: 1000,
      lineWidth: 2,
      extruded: false,
      elevationScale: 30,
    },
    scenegraph: {
      modelUrl: glbDataUrl(input.glb),
      sizeScale: 1,
      sizeMinPixels: 0,
      bearing: 0,
      altitude: 0,
      translation: [0, 0, 0],
    },
  };
  const bounds = modelBounds(input.placement, input.radiusMeters);
  return {
    id: crypto.randomUUID(),
    name: "IFC Model",
    type: "deckgl-viz",
    source: {
      type: "deckgl-viz",
      data: [
      {
        lng: input.placement.longitude,
        lat: input.placement.latitude,
        altitude: input.placement.altitude,
        bearing: input.placement.bearing,
        scale: input.placement.scale,
        contract: "geoim3d-ifc-v1",
      },
    ],
    },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: config.style.color,
      strokeColor: config.style.color,
      circleRadius: config.style.radius,
      strokeWidth: config.style.lineWidth,
      fillOpacity: 1,
    },
    metadata: {
      sourceKind: "deckgl-viz",
      customLayerType: "scenegraph",
      externalDeckLayer: true,
      identifiable: false,
      vizConfig: config,
      bounds,
      ifcImport: createIfcImportSummary({
        ...input.summary,
        radiusMeters: input.radiusMeters,
      }),
    },
  };
}
