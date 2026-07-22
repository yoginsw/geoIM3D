import { getBuiltInScenePreset, BLANK_3D_SCENE_PRESET_ID } from "../../apps/geolibre-desktop/src/lib/scene-preset-builtins";
import { serializeScenePreset } from "../../apps/geolibre-desktop/src/lib/scene-preset-contract";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("missing output directory");
mkdirSync(out, { recursive: true });

const preset = structuredClone(
  getBuiltInScenePreset(BLANK_3D_SCENE_PRESET_ID, "Runtime GLB"),
);
preset.scene.project.layers.push({
  kind: "external-scene",
  id: "layer-1",
  name: "Runtime Model",
  visible: true,
  opacity: 1,
  format: "glb",
  reference: { type: "relative", path: "model.glb" },
  placement: {
    longitude: -100,
    latitude: 40,
    altitudeMeters: 10_000,
    bearingDegrees: 0,
    scale: 500_000,
  },
});
writeFileSync(
  join(out, "runtime.geoim3d-preset.json"),
  serializeScenePreset(preset),
);

const gltf = {
  asset: { version: "2.0", generator: "geoIM3D Phase 7E runtime fixture" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
  materials: [{
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: [1, 0, 0, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
  }],
  buffers: [{ byteLength: 42 }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
    { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [0, 0, 0],
      max: [1, 0, 1],
    },
    { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
  ],
};
const jsonBytes = Buffer.from(JSON.stringify(gltf), "utf8");
const paddedJsonLength = Math.ceil(jsonBytes.length / 4) * 4;
const binaryLength = 44;
const totalLength = 12 + 8 + paddedJsonLength + 8 + binaryLength;
const glb = Buffer.alloc(totalLength, 0);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(totalLength, 8);
glb.writeUInt32LE(paddedJsonLength, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
jsonBytes.copy(glb, 20);
glb.fill(0x20, 20 + jsonBytes.length, 20 + paddedJsonLength);
const binaryHeader = 20 + paddedJsonLength;
glb.writeUInt32LE(binaryLength, binaryHeader);
glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
const binaryOffset = binaryHeader + 8;
const positions = [0, 0, 0, 1, 0, 0, 0, 0, 1];
positions.forEach((value, index) => glb.writeFloatLE(value, binaryOffset + index * 4));
glb.writeUInt16LE(0, binaryOffset + 36);
glb.writeUInt16LE(1, binaryOffset + 38);
glb.writeUInt16LE(2, binaryOffset + 40);
writeFileSync(join(out, "model.glb"), glb);
