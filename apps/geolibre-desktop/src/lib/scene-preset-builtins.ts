import { createEmptyProject } from "@geolibre/core";
import {
  buildScenePresetFromProject,
  type GeoIm3dScenePresetV1,
} from "./scene-preset-contract";

export const BLANK_3D_SCENE_PRESET_ID = "geoim3d.blank-3d.v1" as const;

export interface BuiltInScenePresetDefinition {
  id: typeof BLANK_3D_SCENE_PRESET_ID;
  create: (name: string) => GeoIm3dScenePresetV1;
}

function createBlank3dScenePreset(name: string): GeoIm3dScenePresetV1 {
  const project = createEmptyProject(name, { basemapStyleUrl: "" });
  project.basemapVisible = false;
  project.basemapOpacity = 1;
  const preset = buildScenePresetFromProject(project, name);
  preset.createdBy = "JBT";
  return preset;
}

export const BUILT_IN_SCENE_PRESETS: readonly BuiltInScenePresetDefinition[] = [
  {
    id: BLANK_3D_SCENE_PRESET_ID,
    create: createBlank3dScenePreset,
  },
];

export function getBuiltInScenePreset(
  id: string,
  name: string,
): GeoIm3dScenePresetV1 {
  const definition = BUILT_IN_SCENE_PRESETS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error("SCENE_PRESET_INVALID");
  return definition.create(name);
}
