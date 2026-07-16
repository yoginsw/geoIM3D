import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_PROJECT_NAME, useAppStore } from "@geolibre/core";
import { PRODUCT_PROFILE } from "../apps/geolibre-desktop/src/config/product-profile";
import {
  createGeoIm3dNewProject,
  initializeGeoIm3dStartupProject,
} from "../apps/geolibre-desktop/src/lib/product-defaults";

const HIDDEN_FEATURES = [
  "project.collaborate",
  "processing.pythonConsole",
  "processing.notebook",
  "controls.fieldCollection",
] as const;

describe("geoIM3D product profile", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: DEFAULT_PROJECT_NAME });
  });

  it("fixes the product defaults", () => {
    assert.equal(PRODUCT_PROFILE.language, "ko");
    assert.equal(PRODUCT_PROFILE.theme, "light");
    assert.deepEqual(PRODUCT_PROFILE.mapGrid, { rows: 1, cols: 1 });
    assert.equal(PRODUCT_PROFILE.defaultMapTab, "cesium");
    assert.deepEqual(PRODUCT_PROFILE.hiddenMenuItems, HIDDEN_FEATURES);
  });

  it("creates a clean single-pane project for the 2D/3D tab workspace", () => {
    createGeoIm3dNewProject({ name: "제목 없는 프로젝트" });

    const state = useAppStore.getState();
    assert.equal(state.projectName, "제목 없는 프로젝트");
    assert.deepEqual(state.mapLayout, { rows: 1, cols: 1, syncView: true });
    assert.equal(state.secondaryMapViews.length, 0);
    assert.equal(state.isDirty, false);
  });

  it("does not mutate a loaded or user-edited project at startup", () => {
    const store = useAppStore.getState();
    store.newProject({ name: "Existing Project" });
    store.setMapGrid(2, 2);
    store.markSaved();
    const before = useAppStore.getState();
    const snapshot = {
      projectName: before.projectName,
      mapLayout: before.mapLayout,
      secondaryMapViews: before.secondaryMapViews,
      isDirty: before.isDirty,
    };

    assert.equal(
      initializeGeoIm3dStartupProject("제목 없는 프로젝트"),
      false,
    );

    const after = useAppStore.getState();
    assert.deepEqual(
      {
        projectName: after.projectName,
        mapLayout: after.mapLayout,
        secondaryMapViews: after.secondaryMapViews,
        isDirty: after.isDirty,
      },
      snapshot,
    );
  });
});
