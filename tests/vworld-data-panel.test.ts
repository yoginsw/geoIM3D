import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { vworldDataPanelStatus } from "../packages/plugins/src/plugins/vworld-data-panel.ts";
import type { VWorldDataSnapshot } from "../packages/plugins/src/plugins/vworld-data.ts";

const existing: VWorldDataSnapshot["cadastral"] = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[127, 37], [127.01, 37], [127.01, 37.01], [127, 37]]],
      },
      properties: { pnu: "1111010100100020001" },
    },
  ],
};

function snapshot(overrides: Partial<VWorldDataSnapshot> = {}): VWorldDataSnapshot {
  return {
    cadastralStatus: "idle",
    cadastralErrorCode: null,
    cadastral: null,
    zoningStatus: "idle",
    zoningErrorCode: null,
    zoning: null,
    zoningService: null,
    ...overrides,
  };
}

describe("VWorld data panel status", () => {
  it("shows a failed refresh instead of reporting the retained collection as success", () => {
    const failed = snapshot({
      cadastralStatus: "error",
      cadastralErrorCode: "vworld_timeout",
      cadastral: existing,
    });
    assert.equal(
      vworldDataPanelStatus(failed, "cadastral"),
      "VWorld 응답 시간이 초과되었습니다.",
    );
    assert.doesNotMatch(vworldDataPanelStatus(failed, "cadastral"), /1건/);
  });

  it("shows the retained collection count only for a successful state", () => {
    const successful = snapshot({
      cadastralStatus: "success",
      cadastral: existing,
    });
    assert.equal(
      vworldDataPanelStatus(successful, "cadastral"),
      "1건 · 현재 Session에만 표시",
    );
  });

  it("does not contaminate cadastral status with an unrelated zoning error", () => {
    const mixed = snapshot({
      cadastralStatus: "success",
      cadastral: existing,
      zoningStatus: "error",
      zoningErrorCode: "vworld_timeout",
    });
    assert.equal(
      vworldDataPanelStatus(mixed, "cadastral"),
      "1건 · 현재 Session에만 표시",
    );
    assert.equal(
      vworldDataPanelStatus(mixed, "zoning"),
      "VWorld 응답 시간이 초과되었습니다.",
    );
  });
});
