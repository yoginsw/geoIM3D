import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createVWorld2DPlugin } from "../packages/plugins/src/plugins/vworld-2d.ts";
import {
  resetVWorldProtocolForTests,
  type VWorldMapLike,
  type VWorldProtocolRuntime,
} from "../packages/map/src/vworld-ephemeral-layer.ts";
import type {
  GeoLibreAppAPI,
  GeoLibreFloatingPanelRegistration,
  GeoLibreToolbarMenu,
} from "../packages/plugins/src/types.ts";

class FakeMap implements VWorldMapLike {
  readonly sources = new Map<string, Record<string, unknown>>();
  readonly layers = new Map<string, Record<string, unknown>>();
  readonly listeners = new Map<string, Set<() => void>>();
  addSource(id: string, source: Record<string, unknown>) {
    this.sources.set(id, source);
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  removeSource(id: string) {
    this.sources.delete(id);
  }
  addLayer(layer: Record<string, unknown>) {
    this.layers.set(String(layer.id), layer);
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  removeLayer(id: string) {
    this.layers.delete(id);
  }
  on(event: string, listener: () => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }
}

function setup(desktop: boolean, withSearch = false, withData = false) {
  resetVWorldProtocolForTests();
  const map = new FakeMap();
  const maps: VWorldMapLike[] = [map];
  let mapSubscription: (() => void) | null = null;
  const handlers = new Map<string, unknown>();
  const protocol: VWorldProtocolRuntime = {
    addProtocol(name, handler) {
      handlers.set(name, handler);
    },
    removeProtocol(name) {
      handlers.delete(name);
    },
  };
  let menu: GeoLibreToolbarMenu | null = null;
  let menuDisposed = 0;
  let floatingPanel: GeoLibreFloatingPanelRegistration | null = null;
  let floatingPanelDisposed = 0;
  let floatingPanelOpened = 0;
  let credentialDisposal: (() => void) | null = null;
  let credentialSubscriptionDisposed = 0;
  const app = {
    getMap: () => map,
    registerToolbarMenu(next: GeoLibreToolbarMenu) {
      menu = next;
      return () => {
        menuDisposed += 1;
        menu = null;
      };
    },
    registerFloatingPanel(next: GeoLibreFloatingPanelRegistration) {
      floatingPanel = next;
      return () => {
        floatingPanelDisposed += 1;
        floatingPanel = null;
      };
    },
    openFloatingPanel(id: string) {
      if (floatingPanel?.id !== id) return false;
      floatingPanelOpened += 1;
      return true;
    },
  } as unknown as GeoLibreAppAPI;
  const plugin = createVWorld2DPlugin({
    desktop,
    dataClient: withData
      ? {
          getFeatures: async () => ({
            status: "OK",
            result: { featureCollection: { type: "FeatureCollection", features: [] } },
          }),
        }
      : undefined,
    getMaps: () => maps,
    protocol,
    searchClient: withSearch
      ? {
          search: async () => ({ status: "OK", result: { items: [] } }),
          geocode: async () => ({ status: "OK", result: {} }),
          reverseGeocode: async () => ({ status: "OK", result: { item: [] } }),
        }
      : undefined,
    subscribeMaps(listener) {
      mapSubscription = listener;
      return () => {
        mapSubscription = null;
      };
    },
    subscribeCredentialDisposal(listener) {
      credentialDisposal = listener;
      return () => {
        credentialSubscriptionDisposed += 1;
        credentialDisposal = null;
      };
    },
    transport: async () => ({
      contentType: "image/png",
      bytes: [137, 80, 78, 71],
    }),
  });
  return {
    app,
    plugin,
    map,
    handlers,
    get menu() {
      return menu;
    },
    get menuDisposed() {
      return menuDisposed;
    },
    get floatingPanel() {
      return floatingPanel;
    },
    get floatingPanelDisposed() {
      return floatingPanelDisposed;
    },
    get floatingPanelOpened() {
      return floatingPanelOpened;
    },
    disposeCredential() {
      credentialDisposal?.();
    },
    addMap(next: VWorldMapLike) {
      maps.push(next);
      mapSubscription?.();
    },
    removeMap(target: VWorldMapLike) {
      const index = maps.indexOf(target);
      if (index >= 0) maps.splice(index, 1);
      mapSubscription?.();
    },
    get credentialSubscriptionDisposed() {
      return credentialSubscriptionDisposed;
    },
  };
}

describe("VWorld 2D built-in plugin", () => {
  it("refuses activation on Web/PWA without registering UI, data layers, or protocol", () => {
    const subject = setup(false, true, true);
    assert.equal(subject.plugin.activate(subject.app), false);
    assert.equal(subject.menu, null);
    assert.equal(subject.handlers.size, 0);
    assert.equal(subject.map.sources.size, 0);
  });

  it("registers only the four approved desktop layers", () => {
    const subject = setup(true);
    assert.equal(subject.plugin.activate(subject.app), true);
    assert.ok(subject.menu);
    const actions = subject.menu.items.filter((item) => item.type !== "separator");
    assert.deepEqual(
      actions.map((item) => item.id),
      ["base", "white", "midnight", "hybrid", "remove"],
    );
    assert.equal(JSON.stringify(subject.menu).includes("Satellite"), false);

    const hybrid = actions.find((item) => item.id === "hybrid");
    assert.ok(hybrid && "onSelect" in hybrid);
    hybrid.onSelect();
    assert.equal(subject.map.sources.size, 1);
    assert.equal(subject.map.layers.size, 1);
  });

  it("removes menu, source, layer, and protocol on deactivate", () => {
    const subject = setup(true);
    subject.plugin.activate(subject.app);
    const base = subject.menu?.items.find((item) => item.id === "base");
    assert.ok(base && "onSelect" in base);
    base.onSelect();

    subject.plugin.deactivate(subject.app);
    assert.equal(subject.menuDisposed, 1);
    assert.equal(subject.menu, null);
    assert.equal(subject.map.sources.size, 0);
    assert.equal(subject.map.layers.size, 0);
    assert.equal(subject.handlers.size, 0);
    assert.equal(subject.credentialSubscriptionDisposed, 1);
  });

  it("tears down the active consumer immediately on credential disposal", () => {
    const subject = setup(true);
    subject.plugin.activate(subject.app);
    const base = subject.menu?.items.find((item) => item.id === "base");
    assert.ok(base && "onSelect" in base);
    base.onSelect();

    subject.disposeCredential();
    assert.equal(subject.map.sources.size, 0);
    assert.equal(subject.map.layers.size, 0);
    assert.equal(subject.handlers.size, 0);
    assert.ok(subject.menu);
  });

  it("reconciles active VWorld layers across primary and secondary maps", () => {
    const subject = setup(true);
    subject.plugin.activate(subject.app);
    const base = subject.menu?.items.find((item) => item.id === "base");
    assert.ok(base && "onSelect" in base);
    base.onSelect();

    const secondary = new FakeMap();
    subject.addMap(secondary);
    assert.equal(subject.map.sources.size, 1);
    assert.equal(secondary.sources.size, 1);
    assert.equal(subject.handlers.size, 1);

    subject.removeMap(subject.map);
    assert.equal(subject.map.sources.size, 0);
    assert.equal(secondary.sources.size, 1);
    assert.equal(subject.handlers.size, 1);

    subject.plugin.deactivate(subject.app);
    assert.equal(secondary.sources.size, 0);
    assert.equal(subject.handlers.size, 0);
  });

  it("registers and cleans the desktop-only search/address panel", () => {
    const subject = setup(true, true);
    subject.plugin.activate(subject.app);
    assert.equal(subject.floatingPanel?.id, "geoim3d-vworld-search-panel");
    const search = subject.menu?.items.find((item) => item.id === "search-address");
    assert.ok(search && "onSelect" in search);
    search.onSelect();
    assert.equal(subject.floatingPanelOpened, 1);

    subject.plugin.deactivate(subject.app);
    assert.equal(subject.floatingPanel, null);
    assert.equal(subject.floatingPanelDisposed, 1);
  });

  it("registers and cleans the desktop-only cadastral/zoning panel and map controller", () => {
    const subject = setup(true, false, true);
    subject.plugin.activate(subject.app);
    assert.equal(subject.floatingPanel?.id, "geoim3d-vworld-data-panel");
    const data = subject.menu?.items.find((item) => item.id === "data-layers");
    assert.ok(data && "onSelect" in data);
    data.onSelect();
    assert.equal(subject.floatingPanelOpened, 1);
    assert.equal(subject.map.listeners.get("styledata")?.size, 1);

    subject.plugin.deactivate(subject.app);
    assert.equal(subject.floatingPanel, null);
    assert.equal(subject.floatingPanelDisposed, 1);
    assert.equal(subject.map.listeners.get("styledata")?.size, 0);
  });

  it("reconciles data controllers across dynamically added and removed MapLibre panes", () => {
    const subject = setup(true, false, true);
    subject.plugin.activate(subject.app);
    const secondary = new FakeMap();
    subject.addMap(secondary);
    assert.equal(subject.map.listeners.get("styledata")?.size, 1);
    assert.equal(secondary.listeners.get("styledata")?.size, 1);

    subject.removeMap(subject.map);
    assert.equal(subject.map.listeners.get("styledata")?.size, 0);
    assert.equal(secondary.listeners.get("styledata")?.size, 1);

    subject.plugin.deactivate(subject.app);
    assert.equal(secondary.listeners.get("styledata")?.size, 0);
  });
});
