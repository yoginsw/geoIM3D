import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createEmptyProject,
  projectFromStore,
  useAppStore,
} from "@geolibre/core";

const recent = {
  path: "/tmp/existing.geoim3d.json",
  name: "Existing",
  openedAt: "2026-07-22T00:00:00.000Z",
};

beforeEach(() => {
  useAppStore.getState().newProject({ name: "Before" });
  useAppStore.getState().setRecentProjects([recent]);
  useAppStore.getState().markSaved();
  useAppStore.temporal.getState().clear();
});

describe("scene preset Store application contract", () => {
  it("publishes one dirty pathless Cesium project without changing recents", () => {
    const before = useAppStore.getState();
    const generation = before.projectGeneration;
    const recents = before.recentProjects;
    let publishes = 0;
    const unsubscribe = useAppStore.subscribe(() => {
      publishes += 1;
    });

    try {
      useAppStore.getState().loadProject(createEmptyProject("From preset"), null, {
        rememberRecent: false,
        presenting: false,
        markDirty: true,
        workspaceTab: "cesium",
      });
    } finally {
      unsubscribe();
    }

    const after = useAppStore.getState();
    assert.equal(publishes, 1);
    assert.equal(after.projectGeneration, generation + 1);
    assert.equal(after.projectPath, null);
    assert.equal(after.isDirty, true);
    assert.equal(after.ui.mapWorkspaceTab, "cesium");
    assert.strictEqual(after.recentProjects, recents);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  });

  it("preserves generic load defaults and keeps workspace state ephemeral", () => {
    useAppStore.getState().loadProject(createEmptyProject("Generic"));
    const state = useAppStore.getState();
    assert.equal(state.isDirty, false);

    state.setMapWorkspaceTab("maplibre");
    const serialized = projectFromStore(useAppStore.getState());
    assert.equal("mapWorkspaceTab" in (serialized as unknown as Record<string, unknown>), false);
    assert.equal("ui" in (serialized as unknown as Record<string, unknown>), false);
  });
});
