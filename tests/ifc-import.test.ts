import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  parseProject,
  serializeProject,
} from "../packages/core/src/index";
import {
  IFC_MAX_GLB_BYTES,
  IFC_MAX_RADIUS_METERS,
  assertIfcRadiusMeters,
  IFC_MAX_INPUT_BYTES,
  buildIfcModelLayer,
  createIfcImportSummary,
  parseIfcPlacement,
  validateGlb,
  validateIfcEnvelope,
} from "../apps/geolibre-desktop/src/lib/ifc-model";
import { sanitizeIncomingIfcProject } from "../apps/geolibre-desktop/src/lib/ifc-project";
import { assertProjectSafeForExternalTransfer } from "../apps/geolibre-desktop/src/lib/project-private-content";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

function minimalGlb(jsonValue: object): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(jsonValue));
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const glb = new Uint8Array(20 + jsonLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20);
  glb.set(encoded, 20);
  return glb;
}

function indexedTriangleGlb(indices: [number, number, number]): Uint8Array {
  const binLength = 44;
  const jsonValue = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(jsonValue));
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const glb = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(jsonBytes, 20);
  const binHeader = 20 + jsonLength;
  view.setUint32(binHeader, binLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  const indexOffset = binHeader + 8 + 36;
  indices.forEach((value, index) => view.setUint16(indexOffset + index * 2, value, true));
  return glb;
}

function sampleLayer() {
  const glb = minimalGlb({ asset: { version: "2.0" } });
  const layer = buildIfcModelLayer({
    glb,
    placement: {
      longitude: 127,
      latitude: 37,
      altitude: 10,
      bearing: 20,
      scale: 1,
    },
    radiusMeters: 50,
    summary: createIfcImportSummary({
      schema: "IFC4",
      elementCount: 1,
      meshCount: 1,
      triangleCount: 1,
      glbBytes: glb.byteLength,
      radiusMeters: 50,
    }),
  });
  return { glb, layer };
}

describe("geoIM3D BIM/IFC import", () => {
  it("enforces bounded input and output contracts", () => {
    assert.equal(IFC_MAX_INPUT_BYTES, 32 * 1024 * 1024);
    assert.equal(IFC_MAX_GLB_BYTES, 16 * 1024 * 1024);
  });

  it("accepts only bounded WGS84 placement", () => {
    assert.deepEqual(
      parseIfcPlacement({
        longitude: "127.0276",
        latitude: "37.4979",
        altitude: "12.5",
        bearing: "25",
        scale: "1",
      }),
      {
        longitude: 127.0276,
        latitude: 37.4979,
        altitude: 12.5,
        bearing: 25,
        scale: 1,
      },
    );
    for (const candidate of [
      { longitude: "181", latitude: "0", altitude: "0", bearing: "0", scale: "1" },
      { longitude: "0", latitude: "91", altitude: "0", bearing: "0", scale: "1" },
      { longitude: "0", latitude: "0", altitude: "100001", bearing: "0", scale: "1" },
      { longitude: "0", latitude: "0", altitude: "0", bearing: "361", scale: "1" },
      { longitude: "0", latitude: "0", altitude: "0", bearing: "0", scale: "0" },
      { longitude: "0", latitude: "0", altitude: "0", bearing: "0", scale: "10001" },
    ]) {
      assert.throws(() => parseIfcPlacement(candidate), /IFC_PLACEMENT_INVALID/);
    }
  });

  it("validates IFC STEP envelope and approved schema", () => {
    const valid = new TextEncoder().encode(
      "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
    );
    assert.equal(validateIfcEnvelope(valid), "IFC4");
    for (const invalid of [
      new TextEncoder().encode("not IFC"),
      new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC5'));\nDATA;\nEND-ISO-10303-21;"),
      new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nDATA;"),
      new Uint8Array([0, 1, 2, 3]),
    ]) {
      assert.throws(() => validateIfcEnvelope(invalid), /IFC_INPUT_INVALID/);
    }
    const deep = new TextEncoder().encode(
      `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCX(${"(".repeat(129)}0${")".repeat(129)});\nENDSEC;\nEND-ISO-10303-21;`,
    );
    assert.throws(() => validateIfcEnvelope(deep), /IFC_INPUT_INVALID/);
  });

  it("validates deep GLB structure and byte cap", () => {
    const valid = minimalGlb({ asset: { version: "2.0" } });
    assert.doesNotThrow(() => validateGlb(valid));
    const badMagic = valid.slice();
    new DataView(badMagic.buffer).setUint32(0, 0, true);
    assert.throws(() => validateGlb(badMagic), /IFC_GLB_INVALID/);
    const badLength = valid.slice();
    new DataView(badLength.buffer).setUint32(8, 12, true);
    assert.throws(() => validateGlb(badLength), /IFC_GLB_INVALID/);
    const overflow = valid.slice();
    new DataView(overflow.buffer).setUint32(12, 0x7fffffff, true);
    assert.throws(() => validateGlb(overflow), /IFC_GLB_INVALID/);
    for (const json of [
      { asset: { version: "2.0" }, buffers: [{ uri: "https://host/model.bin", byteLength: 1 }] },
      { asset: { version: "2.0" }, nodes: [{ name: "IfcWall-sensitive" }] },
      { asset: { version: "2.0" }, nodes: [{ extras: { GlobalId: "secret" } }] },
      { asset: { version: "2.0" }, extensions: { vendor: { uri: "https://host" } } },
      { asset: { version: "2.0" }, nodes: [{ uri: "https://host/model.bin" }] },
    ]) {
      assert.throws(() => validateGlb(minimalGlb(json)), /IFC_GLB_INVALID/);
    }
    assert.throws(
      () => validateGlb(new Uint8Array(IFC_MAX_GLB_BYTES + 1)),
      /IFC_GLB_TOO_LARGE/,
    );
    assert.doesNotThrow(() => validateGlb(indexedTriangleGlb([0, 1, 2])));
    assert.throws(
      () => validateGlb(indexedTriangleGlb([0, 1, 3])),
      /IFC_GLB_INVALID/,
    );
    let deepJson: Record<string, unknown> = { asset: { version: "2.0" } };
    for (let depth = 0; depth < 40; depth += 1) deepJson = { child: deepJson };
    assert.throws(() => validateGlb(minimalGlb(deepJson)), /IFC_GLB_INVALID/);
  });

  it("creates only allowlisted bounded IFC summary fields", () => {
    const summary = createIfcImportSummary({
      schema: "IFC4",
      elementCount: 12,
      meshCount: 15,
      triangleCount: 100,
      glbBytes: 4096,
      radiusMeters: 25,
      sourcePath: "C:\\private\\hospital.ifc",
      author: "secret author",
      globalId: "sensitive-guid",
    });
    assert.deepEqual(summary, {
      sourceFormat: "IFC",
      schema: "IFC4",
      elementCount: 12,
      meshCount: 15,
      triangleCount: 100,
      glbBytes: 4096,
      radiusMeters: 25,
      parser: "web-ifc",
    });
    assert.doesNotMatch(JSON.stringify(summary), /private|author|globalId|sensitive/i);
  });

  it("builds and round-trips a self-contained scenegraph without source path", () => {
    const { glb, layer } = sampleLayer();
    assert.equal(layer.type, "deckgl-viz");
    assert.equal(layer.name, "IFC Model");
    assert.equal(layer.sourcePath, undefined);
    assert.equal(layer.metadata.sourceKind, "deckgl-viz");
    assert.equal(layer.metadata.customLayerType, "scenegraph");
    assert.equal(
      (layer.metadata.ifcImport as { glbBytes: number }).glbBytes,
      glb.byteLength,
    );
    const config = layer.metadata.vizConfig as { scenegraph: { modelUrl: string } };
    assert.match(config.scenegraph.modelUrl, /^data:model\/gltf-binary;base64,/);
    const project = createEmptyProject("IFC");
    project.layers.push(layer);
    const serialized = serializeProject(project);
    assert.doesNotMatch(serialized, /hospital\.ifc|sourcePath|GlobalId|Author/i);
    const reopened = sanitizeIncomingIfcProject(parseProject(serialized));
    assert.deepEqual(reopened.layers[0].metadata.ifcImport, layer.metadata.ifcImport);
    assert.deepEqual(reopened.layers[0].metadata.bounds, layer.metadata.bounds);
  });

  it("rejects private scenegraphs at outbound and zero-radius boundaries", () => {
    const { glb, layer } = sampleLayer();
    const project = createEmptyProject("Private model");
    project.layers.push(layer);
    const summary = layer.metadata.ifcImport as ReturnType<typeof createIfcImportSummary>;
    const placement = parseIfcPlacement({
      longitude: "127",
      latitude: "37",
      altitude: "0",
      bearing: "0",
      scale: "1",
    });
    assert.throws(
      () => assertProjectSafeForExternalTransfer(project),
      /PROJECT_PRIVATE_CONTENT_REJECTED/,
    );
    const sourceSignalOnly = structuredClone(project);
    delete sourceSignalOnly.layers[0].metadata.customLayerType;
    delete sourceSignalOnly.layers[0].metadata.vizConfig;
    assert.throws(
      () => assertProjectSafeForExternalTransfer(sourceSignalOnly),
      /PROJECT_PRIVATE_CONTENT_REJECTED/,
    );
    const metadataSignalOnly = structuredClone(project);
    metadataSignalOnly.layers[0].source = {};
    delete metadataSignalOnly.layers[0].metadata.customLayerType;
    delete metadataSignalOnly.layers[0].metadata.vizConfig;
    assert.throws(
      () => assertProjectSafeForExternalTransfer(metadataSignalOnly),
      /PROJECT_PRIVATE_CONTENT_REJECTED/,
    );
    assert.doesNotThrow(() =>
      assertProjectSafeForExternalTransfer({ ...project, layers: [] }),
    );
    assert.throws(
      () => buildIfcModelLayer({
        glb,
        placement: {
          longitude: 127,
          latitude: 37,
          altitude: 0,
          bearing: 0,
          scale: 1,
        },
        radiusMeters: 0,
        summary: { ...summary, radiusMeters: 0 },
      }),
      /IFC_MODEL_INVALID/,
    );
    assert.equal(assertIfcRadiusMeters(IFC_MAX_RADIUS_METERS), IFC_MAX_RADIUS_METERS);
    assert.throws(() => assertIfcRadiusMeters(0), /IFC_RADIUS_INVALID/);
    assert.throws(
      () => assertIfcRadiusMeters(IFC_MAX_RADIUS_METERS + 1),
      /IFC_RADIUS_INVALID/,
    );
    assert.throws(
      () => createIfcImportSummary({ ...summary, radiusMeters: 0 }),
      /IFC_RADIUS_INVALID/,
    );
    assert.throws(
      () => createIfcImportSummary({
        ...summary,
        radiusMeters: IFC_MAX_RADIUS_METERS + 1,
      }),
      /IFC_RADIUS_INVALID/,
    );
    const maximumSummary = createIfcImportSummary({
      ...summary,
      radiusMeters: IFC_MAX_RADIUS_METERS,
    });
    const maximumLayer = buildIfcModelLayer({
      glb,
      placement,
      radiusMeters: IFC_MAX_RADIUS_METERS,
      summary: maximumSummary,
    });
    assert.throws(
      () => buildIfcModelLayer({
        glb,
        placement,
        radiusMeters: IFC_MAX_RADIUS_METERS + 1,
        summary: {
          ...maximumSummary,
          radiusMeters: IFC_MAX_RADIUS_METERS + 1,
        },
      }),
      /IFC_MODEL_INVALID/,
    );
    const maximumProject = { ...createEmptyProject(), layers: [maximumLayer] };
    assert.equal(
      sanitizeIncomingIfcProject(maximumProject).layers[0].metadata.bounds !== undefined,
      true,
    );
    const excessiveProject = structuredClone(maximumProject);
    (excessiveProject.layers[0].metadata.ifcImport as { radiusMeters: number })
      .radiusMeters = IFC_MAX_RADIUS_METERS + 1;
    assert.throws(
      () => sanitizeIncomingIfcProject(excessiveProject),
      /IFC_PROJECT_INVALID/,
    );
  });

  it("normalizes IFC layers at project ingress and strips foreign fields", () => {
    const { layer } = sampleLayer();
    layer.sourcePath = "C:\\private\\source.ifc";
    layer.metadata.author = "secret";
    (layer.metadata.ifcImport as Record<string, unknown>).globalId = "secret-guid";
    const project = createEmptyProject("Ingress");
    project.layers.push(layer);
    const sanitized = sanitizeIncomingIfcProject(project);
    assert.equal(sanitized.layers[0].sourcePath, undefined);
    assert.equal(sanitized.layers[0].metadata.author, undefined);
    assert.equal(
      (sanitized.layers[0].metadata.ifcImport as Record<string, unknown>).globalId,
      undefined,
    );
    const malicious = structuredClone(project);
    const config = malicious.layers[0].metadata.vizConfig as { scenegraph: { modelUrl: string } };
    config.scenegraph.modelUrl = "https://attacker.invalid/model.glb";
    assert.throws(() => sanitizeIncomingIfcProject(malicious), /IFC_PROJECT_INVALID/);
    const downgraded = structuredClone(project);
    delete downgraded.layers[0].metadata.ifcImport;
    assert.throws(() => sanitizeIncomingIfcProject(downgraded), /IFC_PROJECT_INVALID/);
  });

  it("keeps IFC implementation behind the Tauri compile-time boundary", () => {
    const shell = read("apps/geolibre-desktop/src/components/layout/DesktopShell.tsx");
    const menu = read("apps/geolibre-desktop/src/components/layout/toolbar/ProcessingMenu.tsx");
    const topToolbar = read("apps/geolibre-desktop/src/components/layout/TopToolbar.tsx");
    const hook = read("apps/geolibre-desktop/src/hooks/useProjectFileActions.ts");
    assert.match(shell, /IfcImportDialog\s*=\s*__TAURI_BUILD__/);
    assert.match(menu, /showIfcImport\s*=\s*__TAURI_BUILD__/);
    assert.doesNotMatch(`${shell}\n${menu}\n${topToolbar}`, /onOpenIfcImport/);
    assert.match(menu, /onOpenPrivateModelImport/);
    assert.match(hook, /sanitizeIncomingDesktopProject/);
    assert.match(
      hook,
      /openProjectFromShareUrl[\s\S]*sanitizeIncomingDesktopIfcProject\([\s\S]*"remote"/,
    );
    assert.match(
      hook,
      /buildEmbeddedProject[\s\S]*assertProjectSafeForExternalTransfer/,
    );
    const ingress = read("apps/geolibre-desktop/src/lib/desktop-project-ingress.ts");
    assert.match(ingress, /__TAURI_BUILD__[\s\S]*import\("\.\/ifc-project"\)/);
    assert.match(ingress, /assertProjectSafeForExternalTransfer/);
    for (const path of [
      "apps/geolibre-desktop/src/hooks/useProjectUrlLoader.ts",
      "apps/geolibre-desktop/src/hooks/useEmbedBridge.ts",
      "apps/geolibre-desktop/src/hooks/useCollaboration.ts",
    ]) {
      assert.match(read(path), /sanitizeIncomingDesktopProject[\s\S]*"remote"/);
    }
    assert.match(read("apps/geolibre-desktop/package.json"), /"web-ifc": "0\.0\.77"/);
    assert.doesNotMatch(read("packages/processing/src/index.ts"), /web-ifc|ifc-import|IfcImport/i);
  });

  it("terminates the worker on cancel, close, timeout, and unmount", () => {
    const dialog = read("apps/geolibre-desktop/src/components/processing/IfcImportDialog.tsx");
    assert.match(dialog, /new Worker/);
    assert.match(dialog, /workerRef/);
    assert.match(dialog, /terminate\(\)/);
    assert.match(dialog, /useEffect\(\(\) => \(\) =>/);
    assert.match(dialog, /IFC_WORKER_TIMEOUT_MS/);
    assert.match(dialog, /clearTimeout/);
    assert.doesNotMatch(dialog, /ifc-layer-name|setName\(/);
    assert.match(read("apps/geolibre-desktop/src/lib/ifc-model.ts"), /name:\s*"IFC Model"/);
    assert.match(
      read("apps/geolibre-desktop/src/hooks/useEmbedBridge.ts"),
      /assertProjectSafeForExternalTransfer/,
    );
    assert.match(
      read("apps/geolibre-desktop/src/hooks/useCollaboration.ts"),
      /assertProjectSafeForExternalTransfer/,
    );
  });

  it("ships MPL-2.0 notice and rejects GPL runtime inclusion", () => {
    const notice = read("THIRD_PARTY_NOTICES.md");
    const license = read("licenses/web-ifc-MPL-2.0.md");
    const tauriConfig = JSON.parse(
      read("apps/geolibre-desktop/src-tauri/tauri.conf.json"),
    ) as { bundle: { resources: string[] } };
    const packageJson = read("apps/geolibre-desktop/package.json");
    assert.match(notice, /web-ifc[\s\S]*MPL-2\.0/);
    assert.match(notice, /ThatOpen\/engine_web-ifc/);
    assert.match(license, /^Mozilla Public License Version 2\.0/);
    assert.ok(tauriConfig.bundle.resources.includes("../../../THIRD_PARTY_NOTICES.md"));
    assert.ok(tauriConfig.bundle.resources.includes("../../../licenses/web-ifc-MPL-2.0.md"));
    assert.doesNotMatch(packageJson, /ifcopenshell|IfcOpenShell/);
  });

  it("applies transforms, pre-export limits, and no raw parser logging", () => {
    const conversion = read("apps/geolibre-desktop/src/lib/ifc-conversion.ts");
    const worker = read("apps/geolibre-desktop/src/lib/ifc-conversion.worker.ts");
    assert.match(conversion, /COORDINATE_TO_ORIGIN:\s*true/);
    assert.match(conversion, /applyMatrix4/);
    assert.match(conversion, /IFC_MAX_(?:ELEMENTS|VERTICES|INDICES|GEOMETRY_BYTES)/);
    assert.match(
      conversion,
      /GetVertexDataSize\(\)[\s\S]*budget\.vertices[\s\S]*GetVertexArray/,
    );
    assert.match(conversion, /const radiusMeters = assertIfcRadiusMeters\(/);
    assert.match(worker, /ALLOWED_ERRORS/);
    assert.doesNotMatch(worker, /console\.(?:log|warn|error)|error\.stack/);
  });
});
