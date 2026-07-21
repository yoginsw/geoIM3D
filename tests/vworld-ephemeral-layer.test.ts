import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VWORLD_ATTRIBUTION_HTML,
  VWORLD_PROTOCOL,
  VWorldEphemeralLayerController,
  parseVWorldTileUrl,
  resetVWorldProtocolForTests,
  type VWorldMapLike,
  type VWorldProtocolRuntime,
} from "../packages/map/src/vworld-ephemeral-layer.ts";

class FakeMap implements VWorldMapLike {
  readonly sources = new Map<string, Record<string, unknown>>();
  readonly layers = new Map<string, Record<string, unknown>>();
  readonly listeners = new Map<string, Set<() => void>>();

  addSource(id: string, source: Record<string, unknown>): void {
    this.sources.set(id, source);
  }

  getSource(id: string): unknown {
    return this.sources.get(id);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  addLayer(layer: Record<string, unknown>): void {
    this.layers.set(String(layer.id), layer);
  }

  getLayer(id: string): unknown {
    return this.layers.get(id);
  }

  removeLayer(id: string): void {
    this.layers.delete(id);
  }

  on(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function fakeProtocolRuntime() {
  const handlers = new Map<
    string,
    (
      request: { url: string },
      abortController: AbortController
    ) => Promise<{ data: ArrayBuffer }>
  >();
  let addCount = 0;
  let removeCount = 0;
  const runtime: VWorldProtocolRuntime = {
    addProtocol(protocol, handler) {
      addCount += 1;
      handlers.set(protocol, handler);
    },
    removeProtocol(protocol) {
      removeCount += 1;
      handlers.delete(protocol);
    },
  };
  return {
    runtime,
    handlers,
    get addCount() {
      return addCount;
    },
    get removeCount() {
      return removeCount;
    },
  };
}

describe("VWorld ephemeral raster layer", () => {
  it("accepts only fixed keyless tile URLs", () => {
    assert.deepEqual(
      parseVWorldTileUrl("geoim3d-vworld://tile/Base/10/12/34"),
      { layer: "Base", z: 10, x: 12, y: 34 }
    );
    assert.deepEqual(
      parseVWorldTileUrl("geoim3d-vworld://tile/Satellite/10/12/34"),
      { layer: "Satellite", z: 10, x: 12, y: 34 }
    );
    assert.equal(parseVWorldTileUrl("geoim3d-vworld://tile/Base/5/0/0"), null);
    assert.equal(
      parseVWorldTileUrl("geoim3d-vworld://tile/Satellite/20/0/0"),
      null
    );
    assert.deepEqual(
      parseVWorldTileUrl("geoim3d-vworld://tile/Hybrid/19/0/0"),
      { layer: "Hybrid", z: 19, x: 0, y: 0 }
    );
    assert.equal(
      parseVWorldTileUrl("https://api.vworld.kr/req/wmts/key/Base/10/0/0.png"),
      null
    );
  });

  it("registers no protocol, source, or transport on Web/PWA", () => {
    resetVWorldProtocolForTests();
    const protocol = fakeProtocolRuntime();
    const map = new FakeMap();
    let calls = 0;
    const controller = new VWorldEphemeralLayerController({
      desktop: false,
      map,
      protocol: protocol.runtime,
      transport: async () => {
        calls += 1;
        return { contentType: "image/png", bytes: [137, 80, 78, 71] };
      },
    });

    assert.equal(controller.activate("Base"), false);
    assert.equal(protocol.addCount, 0);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.size, 0);
    assert.equal(calls, 0);
  });

  it("mounts an ephemeral source with mandatory attribution and keyless URL", () => {
    resetVWorldProtocolForTests();
    const protocol = fakeProtocolRuntime();
    const map = new FakeMap();
    const controller = new VWorldEphemeralLayerController({
      desktop: true,
      map,
      protocol: protocol.runtime,
      transport: async () => ({
        contentType: "image/png",
        bytes: [137, 80, 78, 71],
      }),
    });

    assert.equal(controller.activate("white"), true);
    assert.equal(protocol.addCount, 1);
    assert.equal(map.sources.size, 1);
    assert.equal(map.layers.size, 1);
    const source = [...map.sources.values()][0];
    assert.deepEqual(source.tiles, [
      `${VWORLD_PROTOCOL}://tile/white/{z}/{x}/{y}`,
    ]);
    assert.equal(source.attribution, VWORLD_ATTRIBUTION_HTML);
    assert.equal(source.minzoom, 6);
    assert.equal(source.maxzoom, 18);
    assert.equal(JSON.stringify(source).includes("api.vworld.kr"), false);
    assert.equal(JSON.stringify(source).includes("key"), false);
  });

  it("routes tile bytes through the injected transport and propagates abort", async () => {
    resetVWorldProtocolForTests();
    const protocol = fakeProtocolRuntime();
    const map = new FakeMap();
    let seenSignal: AbortSignal | undefined;
    const controller = new VWorldEphemeralLayerController({
      desktop: true,
      map,
      protocol: protocol.runtime,
      transport: async (request, signal) => {
        assert.deepEqual(request, { layer: "Hybrid", z: 10, x: 12, y: 34 });
        seenSignal = signal;
        return { contentType: "image/png", bytes: [1, 2, 3, 4] };
      },
    });
    controller.activate("Hybrid");

    const abortController = new AbortController();
    const response = await protocol.handlers.get(VWORLD_PROTOCOL)!(
      { url: `${VWORLD_PROTOCOL}://tile/Hybrid/10/12/34` },
      abortController
    );
    assert.deepEqual([...new Uint8Array(response.data)], [1, 2, 3, 4]);
    assert.equal(seenSignal, abortController.signal);
  });

  it("routes Satellite as JPEG and rejects a mismatched response type", async () => {
    resetVWorldProtocolForTests();
    const protocol = fakeProtocolRuntime();
    const map = new FakeMap();
    const controller = new VWorldEphemeralLayerController({
      desktop: true,
      map,
      protocol: protocol.runtime,
      transport: async (request) => {
        assert.deepEqual(request, { layer: "Satellite", z: 19, x: 0, y: 0 });
        return { contentType: "image/jpeg", bytes: [255, 216, 255, 217] };
      },
    });
    assert.equal(controller.activate("Satellite"), true);
    assert.equal(map.sources.size, 2);
    assert.equal(map.layers.size, 2);
    const sources = [...map.sources.values()];
    assert.deepEqual(sources[0].tiles, [
      `${VWORLD_PROTOCOL}://tile/Satellite/{z}/{x}/{y}`,
    ]);
    assert.deepEqual(sources[1].tiles, [
      `${VWORLD_PROTOCOL}://tile/Hybrid/{z}/{x}/{y}`,
    ]);
    assert.equal(sources[0].maxzoom, 19);
    assert.equal(sources[1].maxzoom, 19);
    assert.deepEqual(
      [...map.layers.values()].map((layer) => layer.source),
      ["geoim3d-vworld-source", "geoim3d-vworld-hybrid-source"]
    );

    const response = await protocol.handlers.get(VWORLD_PROTOCOL)!(
      { url: `${VWORLD_PROTOCOL}://tile/Satellite/19/0/0` },
      new AbortController()
    );
    assert.deepEqual([...new Uint8Array(response.data)], [255, 216, 255, 217]);

    controller.dispose();
    resetVWorldProtocolForTests();
    const mismatchProtocol = fakeProtocolRuntime();
    const mismatch = new VWorldEphemeralLayerController({
      desktop: true,
      map: new FakeMap(),
      protocol: mismatchProtocol.runtime,
      transport: async () => ({
        contentType: "image/png",
        bytes: [137, 80, 78, 71],
      }),
    });
    mismatch.activate("Satellite");
    await assert.rejects(
      mismatchProtocol.handlers.get(VWORLD_PROTOCOL)!(
        { url: `${VWORLD_PROTOCOL}://tile/Satellite/10/0/0` },
        new AbortController()
      ),
      /vworld_invalid_response/
    );
  });

  it("restores and removes the Satellite Hybrid overlay with map lifecycle", () => {
    resetVWorldProtocolForTests();
    const map = new FakeMap();
    const controller = new VWorldEphemeralLayerController({
      desktop: true,
      map,
      protocol: fakeProtocolRuntime().runtime,
      transport: async () => ({
        contentType: "image/png",
        bytes: [137, 80, 78, 71],
      }),
    });
    controller.activate("Satellite");
    assert.equal(map.sources.size, 2);
    assert.equal(map.layers.size, 2);

    map.sources.clear();
    map.layers.clear();
    map.emit("style.load");
    assert.equal(map.sources.size, 2);
    assert.equal(map.layers.size, 2);

    controller.activate("Base");
    assert.equal(map.sources.size, 1);
    assert.equal(map.layers.size, 1);
    assert.deepEqual([...map.sources.values()][0].tiles, [
      `${VWORLD_PROTOCOL}://tile/Base/{z}/{x}/{y}`,
    ]);
    controller.dispose();
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.size, 0);
  });

  it("reference-counts the global protocol and cleans map-local state", () => {
    resetVWorldProtocolForTests();
    const protocol = fakeProtocolRuntime();
    const transport = async () => ({
      contentType: "image/png" as const,
      bytes: [137, 80, 78, 71],
    });
    const firstMap = new FakeMap();
    const secondMap = new FakeMap();
    const first = new VWorldEphemeralLayerController({
      desktop: true,
      map: firstMap,
      protocol: protocol.runtime,
      transport,
    });
    const second = new VWorldEphemeralLayerController({
      desktop: true,
      map: secondMap,
      protocol: protocol.runtime,
      transport,
    });

    first.activate("Base");
    second.activate("midnight");
    assert.equal(protocol.addCount, 1);

    first.dispose();
    assert.equal(protocol.removeCount, 0);
    assert.equal(firstMap.sources.size, 0);
    assert.equal(firstMap.layers.size, 0);

    secondMap.sources.clear();
    secondMap.layers.clear();
    secondMap.emit("style.load");
    assert.equal(secondMap.sources.size, 1);
    assert.equal(secondMap.layers.size, 1);

    second.dispose();
    assert.equal(protocol.removeCount, 1);
    assert.equal(protocol.handlers.size, 0);
  });
});
