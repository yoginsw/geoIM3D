import type { GeoLibreProject } from "@geolibre/core";
import type { GeoIm3dScenePresetV1 } from "./scene-preset-contract";

export interface RelativeResourcePreparer {
  prepareRelativeResource(
    importCapability: string,
    generation: number,
    relativeReference: string,
  ): Promise<{ url: string }>;
}

export interface RelativeResourceMaterializeOptions {
  importCapability?: string;
  generation: number;
  signal: AbortSignal;
  native: RelativeResourcePreparer;
}

/**
 * Materializes the currently supported safe vertical slice: self-contained GLB.
 * The project is still pending and unpublished while this function runs.
 */
export async function materializeRelativeSceneResources(
  preset: GeoIm3dScenePresetV1,
  project: GeoLibreProject,
  options: RelativeResourceMaterializeOptions,
): Promise<boolean> {
  const layers = preset.scene.project.layers;
  const hasHttpsLayer = layers.some(
    (layer) =>
      layer.kind === "external-scene" && layer.reference.type === "https",
  );
  // The approved peer-pinned native TLS adapter is not wired yet. Never publish
  // an unresolved HTTPS placeholder that could later bypass consent/preflight.
  if (hasHttpsLayer) {
    throw new Error("SCENE_PRESET_REMOTE_UNAVAILABLE");
  }
  const hasUnsupportedRelativeLayer = layers.some(
    (layer) =>
      layer.kind === "external-scene" &&
      layer.reference.type === "relative" &&
      layer.format !== "glb",
  );
  if (hasUnsupportedRelativeLayer) {
    throw new Error("SCENE_PRESET_REFERENCE_INVALID");
  }
  const needsNativeSession = layers.some(
    (layer) =>
      layer.kind === "external-scene" && layer.reference.type === "relative",
  );
  if (needsNativeSession && !options.importCapability) {
    throw new Error("SCENE_PRESET_SESSION_STALE");
  }

  for (const [index, presetLayer] of layers.entries()) {
    if (
      presetLayer.kind !== "external-scene" ||
      presetLayer.reference.type !== "relative"
    ) {
      continue;
    }
    if (options.signal.aborted || !options.importCapability) {
      throw new Error("SCENE_PRESET_SESSION_STALE");
    }
    const prepared = await options.native.prepareRelativeResource(
      options.importCapability,
      options.generation,
      presetLayer.reference.path,
    );
    if (options.signal.aborted) {
      throw new Error("SCENE_PRESET_SESSION_STALE");
    }
    const layer = project.layers[index];
    if (!layer) {
      throw new Error("SCENE_PRESET_INTERNAL");
    }
    const { scenePresetError: _scenePresetError, ...safeMetadata } =
      layer.metadata;
    project.layers[index] = {
      ...layer,
      source: {
        ...layer.source,
        referenceType: "relative",
        reference: presetLayer.reference.path,
        assetType: "model",
        format: "glb",
        url: prepared.url,
        scenePresetStatus: "active",
      },
      metadata: {
        ...safeMetadata,
        scenePresetExternal: true,
        scenePresetStatus: "active",
      },
    };
  }
  return needsNativeSession;
}
