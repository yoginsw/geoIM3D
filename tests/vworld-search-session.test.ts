import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VWorldSearchSession,
  type VWorldSearchClient,
  type VWorldSessionResult,
} from "../packages/plugins/src/plugins/vworld-search.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(result: unknown) {
  return { status: "OK" as const, result };
}

function client(overrides: Partial<VWorldSearchClient> = {}): VWorldSearchClient {
  return {
    search: async () => response({ items: [] }),
    geocode: async () => response({}),
    reverseGeocode: async () => response({ item: [] }),
    ...overrides,
  };
}

function snapshotResults(session: VWorldSearchSession): VWorldSessionResult[] {
  return session.getSnapshot().results;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("VWorld search session", () => {
  it("maps only allowlisted search fields into memory results", async () => {
    const session = new VWorldSearchSession(
      client({
        search: async () =>
          response({
            items: [
              {
                id: "place-1",
                title: "판교역",
                category: "교통",
                address: { road: "경기도 성남시 판교역로", secret: "drop" },
                point: { x: "127.111", y: "37.394" },
                rawPayload: "drop",
              },
            ],
          }),
      }),
    );

    await session.search({ query: " 판교역 ", type: "PLACE" });
    assert.deepEqual(snapshotResults(session), [
      {
        id: "place-1",
        kind: "search",
        title: "판교역",
        subtitle: "경기도 성남시 판교역로",
        point: [127.111, 37.394],
      },
    ]);
    assert.equal(JSON.stringify(session.getSnapshot()).includes("secret"), false);
    assert.equal(JSON.stringify(session.getSnapshot()).includes("rawPayload"), false);
  });

  it("requires official categories and rejects invalid coordinates before transport", async () => {
    let calls = 0;
    const session = new VWorldSearchSession(
      client({
        search: async () => {
          calls += 1;
          return response({ items: [] });
        },
        reverseGeocode: async () => {
          calls += 1;
          return response({ item: [] });
        },
      }),
    );

    await assert.rejects(
      session.search({ query: "판교", type: "ADDRESS" }),
      /vworld_invalid_request/,
    );
    await assert.rejects(
      session.reverseGeocode({ point: [181, 37], type: "BOTH" }),
      /vworld_invalid_request/,
    );
    assert.equal(calls, 0);
  });

  it("aborts the previous request and discards stale completion", async () => {
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const session = new VWorldSearchSession(
      client({
        search: (_request, signal) => {
          signals.push(signal ?? new AbortController().signal);
          call += 1;
          return call === 1 ? first.promise : second.promise;
        },
      }),
    );

    const oldRequest = session.search({ query: "이전", type: "PLACE" });
    const newRequest = session.search({ query: "최신", type: "PLACE" });
    assert.equal(signals[0]?.aborted, true);

    second.resolve(
      response({ items: [{ id: "new", title: "최신", point: { x: 127, y: 37 } }] }),
    );
    await newRequest;
    first.resolve(
      response({ items: [{ id: "old", title: "이전", point: { x: 128, y: 38 } }] }),
    );
    await oldRequest;

    assert.equal(snapshotResults(session)[0]?.id, "new");
  });

  it("maps forward and reverse geocoder responses without persistence fields", async () => {
    const session = new VWorldSearchSession(
      client({
        geocode: async () =>
          response({
            refined: { text: "서울특별시 중구 세종대로 110" },
            point: { x: "126.978", y: "37.5665" },
          }),
        reverseGeocode: async () =>
          response({
            item: [
              { type: "ROAD", text: "서울특별시 중구 세종대로 110", zipcode: "04524" },
              { type: "PARCEL", text: "서울특별시 중구 태평로1가 31" },
            ],
          }),
      }),
    );

    await session.geocode({ address: "세종대로 110", type: "ROAD" });
    assert.equal(snapshotResults(session)[0]?.point?.[0], 126.978);
    await session.reverseGeocode({ point: [126.978, 37.5665], type: "BOTH" });
    assert.deepEqual(
      snapshotResults(session).map((item) => item.title),
      ["서울특별시 중구 세종대로 110", "서울특별시 중구 태평로1가 31"],
    );
  });

  it("clears results and aborts active work on credential disposal", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    let signal: AbortSignal | undefined;
    const session = new VWorldSearchSession(
      client({
        search: (_request, nextSignal) => {
          signal = nextSignal;
          return pending.promise;
        },
      }),
    );

    const request = session.search({ query: "진행중", type: "PLACE" });
    session.clear();
    assert.equal(signal?.aborted, true);
    assert.deepEqual(snapshotResults(session), []);
    pending.resolve(response({ items: [] }));
    await request;
    assert.deepEqual(snapshotResults(session), []);
  });

  it("has no Core Store, browser storage, database, cache, or export path", () => {
    const source = ["vworld-search.ts", "vworld-search-panel.ts"]
      .map((file) =>
        readFileSync(
          path.join(repoRoot, "packages/plugins/src/plugins", file),
          "utf8",
        ),
      )
      .join("\n");
    assert.doesNotMatch(
      source,
      /@geolibre\/core|useAppStore|localStorage|sessionStorage|indexedDB|CacheStorage|exportTextFile|download/i,
    );
  });
});
