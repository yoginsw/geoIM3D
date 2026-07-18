import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VWorldDataSession,
  type VWorldDataClient,
} from "../packages/plugins/src/plugins/vworld-data.ts";

function response(result: unknown) {
  return { status: "OK" as const, result };
}

function client(overrides: Partial<VWorldDataClient> = {}): VWorldDataClient {
  return {
    getFeatures: async () => response({ featureCollection: { type: "FeatureCollection", features: [] } }),
    ...overrides,
  };
}

const cadastralPayload = {
  featureCollection: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "parcel-1",
        geometry: {
          type: "Polygon",
          coordinates: [[[126.97, 37.56], [126.98, 37.56], [126.98, 37.57], [126.97, 37.56]]],
        },
        properties: {
          pnu: "1111010100100020001",
          jibun: "2-1대",
          bonbun: "2",
          bubun: "1",
          addr: "서울특별시 종로구 청운동 2-1",
          gosi_year: "2026",
          gosi_month: "07",
          jiga: "100000",
          ag_geom: "must-drop",
          credential: "must-drop",
        },
      },
    ],
  },
};

const zoningPayload = {
  featureCollection: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "MultiPolygon",
          coordinates: [[[[127.1, 37.4], [127.11, 37.4], [127.11, 37.41], [127.1, 37.4]]]],
        },
        properties: {
          uname: "제1종일반주거지역",
          sido_name: "경기도",
          sigg_name: "성남시",
          dyear: "2026",
          dnum: "제1호",
          ag_geom: "must-drop",
          unknown: "must-drop",
        },
      },
    ],
  },
};

describe("VWorld data session", () => {
  it("validates PNU, service, page size, and maximum 2 km² bbox before transport", async () => {
    let calls = 0;
    const session = new VWorldDataSession(client({ getFeatures: async () => { calls += 1; return response({}); } }));
    await assert.rejects(() => session.queryParcel({ pnu: "123" }), /vworld_invalid_request/);
    await assert.rejects(
      () => session.queryZoning({ service: "LT_C_UQ999" as never, geometry: { type: "POINT", coordinates: [127, 37] } }),
      /vworld_invalid_request/,
    );
    await assert.rejects(
      () => session.queryZoning({ service: "LT_C_UQ111", size: 1001, geometry: { type: "POINT", coordinates: [127, 37] } }),
      /vworld_invalid_request/,
    );
    await assert.rejects(
      () => session.queryZoning({ service: "LT_C_UQ111", geometry: { type: "BOX", bounds: [126, 36, 128, 38] } }),
      /vworld_invalid_request/,
    );
    assert.equal(calls, 0);
  });

  it("keeps only official cadastral properties and bounded geometry in session memory", async () => {
    const session = new VWorldDataSession(client({ getFeatures: async () => response(cadastralPayload) }));
    await session.queryParcel({ pnu: "1111010100100020001" });
    const feature = session.getSnapshot().cadastral?.features[0];
    assert.deepEqual(feature?.properties, {
      pnu: "1111010100100020001",
      jibun: "2-1대",
      bonbun: "2",
      bubun: "1",
      addr: "서울특별시 종로구 청운동 2-1",
      gosi_year: "2026",
      gosi_month: "07",
      jiga: "100000",
    });
    assert.equal(feature?.geometry.type, "Polygon");
    assert.equal(JSON.stringify(feature).includes("must-drop"), false);
  });

  it("keeps only the official common zoning fields for all four allowlisted services", async () => {
    const services = ["LT_C_UQ111", "LT_C_UQ112", "LT_C_UQ113", "LT_C_UQ114"] as const;
    for (const service of services) {
      const session = new VWorldDataSession(client({ getFeatures: async () => response(zoningPayload) }));
      await session.queryZoning({ service, geometry: { type: "POINT", coordinates: [127.1, 37.4] } });
      const feature = session.getSnapshot().zoning?.features[0];
      assert.deepEqual(feature?.properties, {
        uname: "제1종일반주거지역",
        sido_name: "경기도",
        sigg_name: "성남시",
        dyear: "2026",
        dnum: "제1호",
      });
      assert.equal(session.getSnapshot().zoningService, service);
    }
  });

  it("aborts only a previous request for the same dataset and discards stale completion", async () => {
    let firstResolve!: (value: ReturnType<typeof response>) => void;
    const first = new Promise<ReturnType<typeof response>>((resolve) => { firstResolve = resolve; });
    const signals: AbortSignal[] = [];
    let call = 0;
    const session = new VWorldDataSession(client({
      getFeatures: (_request, signal) => {
        signals.push(signal!);
        call += 1;
        return call === 1 ? first : Promise.resolve(response(cadastralPayload));
      },
    }));
    const stale = session.queryParcel({ pnu: "1111010100100020001" });
    await session.queryParcel({ pnu: "1111010100100020002" });
    assert.equal(signals[0].aborted, true);
    firstResolve(response({ featureCollection: { type: "FeatureCollection", features: [] } }));
    await stale;
    assert.equal(session.getSnapshot().cadastral?.features.length, 1);
    assert.equal(session.getSnapshot().cadastralStatus, "success");
  });

  it("clearing one dataset does not cancel the unrelated in-flight request", async () => {
    let zoningResolve!: (value: ReturnType<typeof response>) => void;
    let zoningSignal!: AbortSignal;
    const zoningPending = new Promise<ReturnType<typeof response>>((resolve) => { zoningResolve = resolve; });
    const zoningSession = new VWorldDataSession(client({
      getFeatures: (_request, signal) => {
        zoningSignal = signal!;
        return zoningPending;
      },
    }));
    const zoning = zoningSession.queryZoning({
      service: "LT_C_UQ111",
      geometry: { type: "POINT", coordinates: [127.1, 37.4] },
    });
    zoningSession.clearCadastral();
    assert.equal(zoningSignal.aborted, false);
    assert.equal(zoningSession.getSnapshot().zoningStatus, "loading");
    zoningResolve(response(zoningPayload));
    await zoning;
    assert.equal(zoningSession.getSnapshot().zoningStatus, "success");

    let parcelResolve!: (value: ReturnType<typeof response>) => void;
    let parcelSignal!: AbortSignal;
    const parcelPending = new Promise<ReturnType<typeof response>>((resolve) => { parcelResolve = resolve; });
    const parcelSession = new VWorldDataSession(client({
      getFeatures: (_request, signal) => {
        parcelSignal = signal!;
        return parcelPending;
      },
    }));
    const parcel = parcelSession.queryParcel({ pnu: "1111010100100020001" });
    parcelSession.clearZoning();
    assert.equal(parcelSignal.aborted, false);
    assert.equal(parcelSession.getSnapshot().cadastralStatus, "loading");
    parcelResolve(response(cadastralPayload));
    await parcel;
    assert.equal(parcelSession.getSnapshot().cadastralStatus, "success");
  });

  it("keeps success and error state isolated across datasets and clears both on disposal", async () => {
    const session = new VWorldDataSession(client({
      getFeatures: async (request) => {
        if (request.service === "LP_PA_CBND_BUBUN") return response(cadastralPayload);
        throw new Error("vworld_timeout");
      },
    }));
    await session.queryParcel({ pnu: "1111010100100020001" });
    await session.queryZoning({
      service: "LT_C_UQ111",
      geometry: { type: "POINT", coordinates: [127.1, 37.4] },
    });
    assert.equal(session.getSnapshot().cadastralStatus, "success");
    assert.equal(session.getSnapshot().cadastralErrorCode, null);
    assert.equal(session.getSnapshot().zoningStatus, "error");
    assert.equal(session.getSnapshot().zoningErrorCode, "vworld_timeout");
    session.clear();
    assert.equal(session.getSnapshot().cadastral, null);
    assert.equal(session.getSnapshot().zoning, null);
  });

  it("has no Core Store, raw filter, browser storage, cache, database, or export path", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = ["vworld-data.ts", "vworld-data-panel.ts", "vworld-data-layer.ts"]
      .map((file) =>
        readFileSync(
          path.join(repoRoot, "packages/plugins/src/plugins", file),
          "utf8",
        ),
      )
      .join("\n");
    assert.doesNotMatch(
      source,
      /@geolibre\/core|useAppStore|attrFilter|localStorage|sessionStorage|indexedDB|CacheStorage|exportTextFile|download/i,
    );
  });
});
