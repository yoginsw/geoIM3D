import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { IfcAPI, type FlatMesh, type PlacedGeometry } from "web-ifc";
import webIfcWasmUrl from "web-ifc/web-ifc.wasm?url";
import {
  IFC_MAX_ELEMENTS,
  IFC_MAX_GEOMETRY_BYTES,
  IFC_MAX_INDICES,
  IFC_MAX_INPUT_BYTES,
  IFC_MAX_PLACED_MESHES,
  IFC_MAX_TRIANGLES,
  IFC_MAX_VERTICES,
  assertIfcRadiusMeters,
  createIfcImportSummary,
  validateGlb,
  validateIfcEnvelope,
  type IfcImportSummary,
} from "./ifc-contract";

export interface IfcConversionResult {
  glb: Uint8Array;
  radiusMeters: number;
  summary: IfcImportSummary;
}

function assertFiniteArray(values: ArrayLike<number>, code: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) throw new Error(code);
  }
}

function materialFor(placed: PlacedGeometry): MeshStandardMaterial {
  const color = placed.color;
  const opacity = Math.min(Math.max(color.w, 0), 1);
  return new MeshStandardMaterial({
    color: new Color(color.x, color.y, color.z),
    opacity,
    transparent: opacity < 1,
    roughness: 0.8,
    metalness: 0,
    side: 2,
  });
}

function meshFromGeometry(
  api: IfcAPI,
  modelId: number,
  placed: PlacedGeometry,
  budget: {
    vertices: number;
    indices: number;
    triangles: number;
    geometryBytes: number;
  },
): { mesh: Mesh; vertexCount: number; indexCount: number; geometryBytes: number } {
  if (
    placed.flatTransformation.length !== 16 ||
    !placed.flatTransformation.every(Number.isFinite)
  ) {
    throw new Error("IFC_GEOMETRY_INVALID");
  }
  const source = api.GetGeometry(modelId, placed.geometryExpressID);
  try {
    const vertexValues = source.GetVertexDataSize();
    const indexValues = source.GetIndexDataSize();
    if (
      !Number.isSafeInteger(vertexValues) ||
      !Number.isSafeInteger(indexValues) ||
      vertexValues <= 0 ||
      vertexValues % 6 !== 0 ||
      indexValues <= 0 ||
      indexValues % 3 !== 0
    ) {
      throw new Error("IFC_GEOMETRY_INVALID");
    }
    const vertexCount = vertexValues / 6;
    const geometryBytes = vertexCount * 24 + indexValues * 4;
    if (
      vertexCount > budget.vertices ||
      indexValues > budget.indices ||
      indexValues / 3 > budget.triangles ||
      geometryBytes > budget.geometryBytes
    ) {
      throw new Error("IFC_GEOMETRY_LIMIT");
    }
    const interleaved = api
      .GetVertexArray(source.GetVertexData(), vertexValues)
      .slice();
    const indices = api
      .GetIndexArray(source.GetIndexData(), indexValues)
      .slice();
    if (
      interleaved.length === 0 ||
      interleaved.length % 6 !== 0 ||
      indices.length === 0 ||
      indices.length % 3 !== 0
    ) {
      throw new Error("IFC_GEOMETRY_INVALID");
    }
    assertFiniteArray(interleaved, "IFC_GEOMETRY_INVALID");
    if (interleaved.length !== vertexValues || indices.length !== indexValues) {
      throw new Error("IFC_GEOMETRY_INVALID");
    }
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const sourceOffset = vertex * 6;
      const targetOffset = vertex * 3;
      positions[targetOffset] = interleaved[sourceOffset];
      positions[targetOffset + 1] = interleaved[sourceOffset + 1];
      positions[targetOffset + 2] = interleaved[sourceOffset + 2];
      normals[targetOffset] = interleaved[sourceOffset + 3];
      normals[targetOffset + 1] = interleaved[sourceOffset + 4];
      normals[targetOffset + 2] = interleaved[sourceOffset + 5];
    }
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= vertexCount) {
        throw new Error("IFC_GEOMETRY_INVALID");
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    const mesh = new Mesh(geometry, materialFor(placed));
    mesh.applyMatrix4(new Matrix4().fromArray(placed.flatTransformation));
    return { mesh, vertexCount, indexCount: indices.length, geometryBytes };
  } finally {
    if (typeof source.delete === "function") source.delete();
  }
}

function disposeGroup(group: Group): void {
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) material.dispose();
  });
}

function exportGlb(group: Group): Promise<Uint8Array> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
        else reject(new Error("IFC_GLB_INVALID"));
      },
      () => reject(new Error("IFC_GLB_INVALID")),
      { binary: true },
    );
  });
}

/** Convert bounded IFC bytes to a geometry-only self-contained GLB. */
export async function convertIfcToGlb(
  input: Uint8Array,
): Promise<IfcConversionResult> {
  if (input.byteLength === 0) throw new Error("IFC_INPUT_EMPTY");
  if (input.byteLength > IFC_MAX_INPUT_BYTES) {
    throw new Error("IFC_INPUT_TOO_LARGE");
  }

  const api = new IfcAPI();
  const group = new Group();
  let modelId: number | null = null;
  let elementCount = 0;
  let meshCount = 0;
  let triangleCount = 0;
  let vertexCount = 0;
  let indexCount = 0;
  let geometryBytes = 0;
  try {
    const declaredSchema = validateIfcEnvelope(input);
    await api.Init(
      (path) => (path.endsWith(".wasm") ? webIfcWasmUrl : path),
      true,
    );
    modelId = api.OpenModel(input, {
      COORDINATE_TO_ORIGIN: true,
      CIRCLE_SEGMENTS: 12,
      MEMORY_LIMIT: 256 * 1024 * 1024,
    });
    if (modelId < 0) throw new Error("IFC_PARSE_FAILED");
    const runtimeSchema = api.GetModelSchema(modelId).toUpperCase();
    if (runtimeSchema !== declaredSchema) throw new Error("IFC_PARSE_FAILED");
    api.StreamAllMeshes(modelId, (flatMesh: FlatMesh) => {
      elementCount += 1;
      if (elementCount > IFC_MAX_ELEMENTS) throw new Error("IFC_ELEMENT_LIMIT");
      try {
        for (let index = 0; index < flatMesh.geometries.size(); index += 1) {
          meshCount += 1;
          if (meshCount > IFC_MAX_PLACED_MESHES) {
            throw new Error("IFC_MESH_LIMIT");
          }
          const placed = flatMesh.geometries.get(index);
          const converted = meshFromGeometry(api, modelId as number, placed, {
            vertices: IFC_MAX_VERTICES - vertexCount,
            indices: IFC_MAX_INDICES - indexCount,
            triangles: IFC_MAX_TRIANGLES - triangleCount,
            geometryBytes: IFC_MAX_GEOMETRY_BYTES - geometryBytes,
          });
          const { mesh } = converted;
          vertexCount += converted.vertexCount;
          indexCount += converted.indexCount;
          geometryBytes += converted.geometryBytes;
          if (
            vertexCount > IFC_MAX_VERTICES ||
            indexCount > IFC_MAX_INDICES ||
            geometryBytes > IFC_MAX_GEOMETRY_BYTES
          ) {
            mesh.geometry.dispose();
            const material = mesh.material;
            if (Array.isArray(material)) material.forEach((item) => item.dispose());
            else material.dispose();
            throw new Error("IFC_GEOMETRY_LIMIT");
          }
          triangleCount += converted.indexCount / 3;
          if (
            !Number.isSafeInteger(triangleCount) ||
            triangleCount > IFC_MAX_TRIANGLES
          ) {
            mesh.geometry.dispose();
            const material = mesh.material;
            if (Array.isArray(material)) material.forEach((item) => item.dispose());
            else material.dispose();
            throw new Error("IFC_TRIANGLE_LIMIT");
          }
          group.add(mesh);
        }
      } finally {
        if (typeof flatMesh.delete === "function") flatMesh.delete();
      }
    });
    if (meshCount === 0 || triangleCount === 0) {
      throw new Error("IFC_GEOMETRY_EMPTY");
    }
    group.updateMatrixWorld(true);
    const box = new Box3().setFromObject(group);
    if (box.isEmpty()) throw new Error("IFC_GEOMETRY_EMPTY");
    const radiusMeters = assertIfcRadiusMeters(
      new Vector3(
        Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
        Math.max(Math.abs(box.min.y), Math.abs(box.max.y)),
        Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
      ).length(),
    );

    const glb = await exportGlb(group);
    validateGlb(glb);
    return {
      glb,
      radiusMeters,
      summary: createIfcImportSummary({
        schema: declaredSchema,
        elementCount,
        meshCount,
        triangleCount,
        glbBytes: glb.byteLength,
        radiusMeters,
      }),
    };
  } finally {
    disposeGroup(group);
    if (modelId !== null && modelId >= 0) {
      try {
        api.CloseModel(modelId);
      } catch {
        // Best-effort native/WASM cleanup; Dispose below remains independent.
      }
    }
    try {
      api.Dispose();
    } catch {
      // The worker is terminated after each conversion, so no WASM state survives.
    }
  }
}
