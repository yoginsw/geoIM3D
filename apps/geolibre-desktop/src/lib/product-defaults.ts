import { DEFAULT_PROJECT_NAME, useAppStore } from "@geolibre/core";
import { PRODUCT_PROFILE } from "../config/product-profile";

function shouldApplyProductMapDefaults(): boolean {
  if (import.meta.env?.VITE_E2E_EXPOSE_ALL_LOCALES !== "true") return true;
  if (typeof window === "undefined") return true;
  return (
    new URLSearchParams(window.location.search).get("geoim3dProfile") === "1"
  );
}

type NewProjectOptions = NonNullable<
  Parameters<ReturnType<typeof useAppStore.getState>["newProject"]>[0]
> & { name: string };

function applyGeoIm3dProjectDefaults(localizedProjectName: string): void {
  // Production always uses the product layout. The E2E compatibility build
  // opts into Cesium only in the dedicated product test to avoid WebGL buildup.
  if (!shouldApplyProductMapDefaults()) return;

  const initial = useAppStore.getState();
  let changed = false;

  if (initial.projectName === DEFAULT_PROJECT_NAME) {
    initial.setProjectName(localizedProjectName);
    changed = true;
  }

  if (
    initial.mapLayout.rows !== PRODUCT_PROFILE.mapGrid.rows ||
    initial.mapLayout.cols !== PRODUCT_PROFILE.mapGrid.cols
  ) {
    initial.setMapGrid(
      PRODUCT_PROFILE.mapGrid.rows,
      PRODUCT_PROFILE.mapGrid.cols,
    );
    changed = true;
  }

  const secondary = useAppStore.getState().secondaryMapViews[0];
  if (secondary && secondary.viewKind !== "cesium") {
    useAppStore.getState().setSecondaryViewKind(secondary.id, "cesium");
    changed = true;
  }

  if (changed) useAppStore.getState().markSaved();
}

/** Initialize only the untouched in-memory project present before React mounts. */
export function initializeGeoIm3dStartupProject(
  localizedProjectName: string,
): boolean {
  const state = useAppStore.getState();
  const isPristineStartupProject =
    state.projectName === DEFAULT_PROJECT_NAME &&
    !state.isDirty &&
    state.layers.length === 0 &&
    state.secondaryMapViews.length === 0 &&
    state.mapLayout.rows === 1 &&
    state.mapLayout.cols === 1;
  if (!isPristineStartupProject) return false;

  applyGeoIm3dProjectDefaults(localizedProjectName);
  return true;
}

/** Reset through the existing store API, then apply the product defaults. */
export function createGeoIm3dNewProject(options: NewProjectOptions): void {
  useAppStore.getState().newProject(options);
  applyGeoIm3dProjectDefaults(options.name);
}
