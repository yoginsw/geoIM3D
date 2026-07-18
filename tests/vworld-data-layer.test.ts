import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VWorldDataLayerController,
  type VWorldDataMapLike,
} from "../packages/plugins/src/plugins/vworld-data-layer.ts";
import type { EphemeralFeatureCollection } from "../packages/plugins/src/plugins/vworld-data.ts";

class FakeSource {
  constructor(public data: EphemeralFeatureCollection) {}
  setData(data: EphemeralFeatureCollection) {
    this.data = data;
  }
}

class FakeMap implements VWorldDataMapLike {
  readonly sources = new Map<string, FakeSource>();
  readonly sourceSpecs = new Map<string, Record<string, unknown>>();
  readonly layers = new Map<string, Record<string, unknown>>();
  readonly handlers = new Set<() => void>();

  addSource(id: string, source: Record<string, unknown>) {
    this.sourceSpecs.set(id, source);
    this.sources.set(id, new FakeSource(source.data as EphemeralFeatureCollection));
  }
  getSource(id: string) { return this.sources.get(id); }
  removeSource(id: string) { this.sources.delete(id); this.sourceSpecs.delete(id); }
  addLayer(layer: Record<string, unknown>) { this.layers.set(String(layer.id), layer); }
  getLayer(id: string) { return this.layers.get(id); }
  removeLayer(id: string) { this.layers.delete(id); }
  on(event: "styledata", handler: () => void) { if (event === "styledata") this.handlers.add(handler); }
  off(event: "styledata", handler: () => void) { if (event === "styledata") this.handlers.delete(handler); }
}

function collection(label: string): EphemeralFeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [[[127, 37], [127.01, 37], [127.01, 37.01], [127, 37]]],
        },
        properties: { label },
      },
    ],
  };
}

describe("VWorld ephemeral data layer", () => {
  it("mounts cadastral and zoning sources with mandatory attribution and no persistence metadata", () => {
    const map = new FakeMap();
    const controller = new VWorldDataLayerController(map);
    controller.setCadastral(collection("parcel"));
    controller.setZoning(collection("zone"), "LT_C_UQ111");

    assert.equal(map.sources.size, 2);
    assert.equal(map.layers.size, 4);
    for (const spec of map.sourceSpecs.values()) {
      assert.equal(spec.type, "geojson");
      assert.equal(spec.attribution, '<a href="https://www.vworld.kr/">VWorld 디지털트윈국토</a>');
      assert.equal("url" in spec, false);
    }
    assert.equal(JSON.stringify([...map.layers.values()]).includes("export"), false);
  });

  it("updates memory data, restores after style reset, and removes everything on disposal", () => {
    const map = new FakeMap();
    const controller = new VWorldDataLayerController(map);
    controller.setCadastral(collection("first"));
    controller.setCadastral(collection("second"));
    assert.equal(map.sources.get("geoim3d-vworld-cadastral")?.data.features[0].properties.label, "second");

    map.sources.clear();
    map.layers.clear();
    for (const handler of map.handlers) handler();
    assert.equal(map.sources.size, 1);
    assert.equal(map.layers.size, 2);

    controller.dispose();
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.size, 0);
    assert.equal(map.handlers.size, 0);
  });
});
