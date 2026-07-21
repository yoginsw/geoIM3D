import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import type { GeoLibreProject } from "@geolibre/core";
import {
  MAX_LOCAL_PROJECT_BYTES,
  parseBoundedLocalProjectBytes,
} from "../apps/geolibre-desktop/src/lib/project-file-bytes";
import { verifyIngressCapabilityIsolationForTest } from "../apps/geolibre-desktop/src/lib/desktop-project-ingress";
import {
  calculateViewshed,
  transformViewshedPoint,
  type ViewshedRaster,
} from "../apps/geolibre-desktop/src/lib/viewshed-analysis";
import {
  decodeViewshedGeoTiff,
  estimateViewshedWorkerPeakBytes,
  isViewshedNoDataLossless,
} from "../apps/geolibre-desktop/src/lib/viewshed-geotiff";
import {
  runViewshedWorker,
  type ViewshedWorkerPort,
} from "../apps/geolibre-desktop/src/lib/viewshed-worker-client";

function sampleGeoTiff(
  bits: 8 | 16 | 32 | 64 = 32,
  sampleFormat: 1 | 2 | 3 = 3
): ArrayBuffer {
  const entryCount = 14;
  const ifdOffset = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const scaleOffset = ifdOffset + ifdBytes;
  const tieOffset = scaleOffset + 24;
  const geoKeyOffset = tieOffset + 48;
  const pixelOffset = geoKeyOffset + 32;
  const sampleBytes = bits / 8;
  const bytes = new ArrayBuffer(pixelOffset + 4 * sampleBytes);
  const view = new DataView(bytes);
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);
  let entry = ifdOffset + 2;
  const add = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
    entry += 12;
  };
  add(256, 4, 1, 2);
  add(257, 4, 1, 2);
  add(258, 3, 1, bits);
  add(259, 3, 1, 1);
  add(262, 3, 1, 1);
  add(273, 4, 1, pixelOffset);
  add(277, 3, 1, 1);
  add(278, 4, 1, 2);
  add(279, 4, 1, 4 * sampleBytes);
  add(284, 3, 1, 1);
  add(339, 3, 1, sampleFormat);
  add(33550, 12, 3, scaleOffset);
  add(33922, 12, 6, tieOffset);
  add(34735, 3, 16, geoKeyOffset);
  view.setUint32(entry, 0, true);
  [1, 1, 0].forEach((value, index) =>
    view.setFloat64(scaleOffset + index * 8, value, true)
  );
  [0, 0, 0, 200000, 489014.9556910066, 0].forEach((value, index) =>
    view.setFloat64(tieOffset + index * 8, value, true)
  );
  [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 5186].forEach(
    (value, index) => view.setUint16(geoKeyOffset + index * 2, value, true)
  );
  [12, 8, 10, 10].forEach((value, index) => {
    const offset = pixelOffset + index * sampleBytes;
    if (sampleFormat === 3 && bits === 32) view.setFloat32(offset, value, true);
    else if (sampleFormat === 3 && bits === 64)
      view.setFloat64(offset, value, true);
    else if (sampleFormat === 1 && bits === 8) view.setUint8(offset, value);
    else if (sampleFormat === 1 && bits === 16)
      view.setUint16(offset, value, true);
    else if (sampleFormat === 1 && bits === 32)
      view.setUint32(offset, value, true);
    else if (sampleFormat === 2 && bits === 8) view.setInt8(offset, value);
    else if (sampleFormat === 2 && bits === 16)
      view.setInt16(offset, value, true);
    else if (sampleFormat === 2 && bits === 32)
      view.setInt32(offset, value, true);
  });
  return bytes;
}

function validResult() {
  const raster: ViewshedRaster = {
    values: new Float64Array([10, 10, 10, 10]),
    width: 2,
    height: 2,
    tieI: 0,
    tieJ: 0,
    tieX: 200000,
    tieY: 489014.9556910066,
    scaleX: 1,
    scaleY: 1,
    nodata: null,
    sourceCrs: "EPSG:5186",
  };
  const point = (x: number, y: number) =>
    transformViewshedPoint([x, y], "EPSG:5186", "EPSG:4326");
  const boundary = {
    type: "Polygon" as const,
    coordinates: [
      [
        point(199999, 489011),
        point(200003, 489011),
        point(200003, 489016),
        point(199999, 489016),
        point(199999, 489011),
      ],
    ],
  };
  return calculateViewshed({
    raster,
    boundary,
    observer: point(200000.5, 489014.4556910066),
    observerHeightMeters: 1.7,
    targetHeightMeters: 0,
    maximumRadiusMeters: 100,
  });
}

class FakeWorker implements ViewshedWorkerPort {
  onmessage: ViewshedWorkerPort["onmessage"] = null;
  onerror: ViewshedWorkerPort["onerror"] = null;
  terminateCount = 0;
  throwOnPost = false;
  throwOnTerminate = false;
  postMessage(): void {
    if (this.throwOnPost) throw new DOMException("clone", "DataCloneError");
  }
  terminate(): void {
    this.terminateCount += 1;
    if (this.throwOnTerminate) throw new Error("terminate");
  }
}

const request = () => ({
  id: 1,
  bytes: new ArrayBuffer(8),
  boundary: validResult().boundary,
  observer: validResult().observer.coordinates as [number, number],
  observerHeightMeters: 1.7,
  targetHeightMeters: 0,
  maximumRadiusMeters: 100,
});

describe("viewshed TIFF and worker boundary", () => {
  it("accounts the exact Phase A design peak before parser allocation", () => {
    const mib = 1024 * 1024;
    assert.equal(
      estimateViewshedWorkerPeakBytes(48 * mib, 20 * mib, 8 * mib),
      92 * mib
    );
    assert.throws(
      () => estimateViewshedWorkerPeakBytes(48 * mib + 1, 20 * mib, 8 * mib),
      /VIEWSHED_LIMIT_EXCEEDED/
    );
  });

  it("bounds drag/drop bytes and rejects malformed UTF-8 before project parse", async () => {
    const valid = new TextEncoder().encode(
      JSON.stringify({
        version: "0.2.0",
        name: "bounded",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      })
    );
    assert.equal(
      (await parseBoundedLocalProjectBytes(valid.buffer)).name,
      "bounded"
    );
    await assert.rejects(
      () => parseBoundedLocalProjectBytes(new Uint8Array([0xc3, 0x28]).buffer),
      /PROJECT_FILE_INVALID/
    );
    await assert.rejects(
      () =>
        parseBoundedLocalProjectBytes(
          new ArrayBuffer(MAX_LOCAL_PROJECT_BYTES + 1)
        ),
      /PROJECT_FILE_TOO_LARGE/
    );
    const actionsSource = readFileSync(
      "apps/geolibre-desktop/src/hooks/useProjectFileActions.ts",
      "utf8"
    );
    assert.match(actionsSource, /file\.size > MAX_LOCAL_PROJECT_BYTES/);
    assert.match(
      actionsSource,
      /parseBoundedLocalProjectBytes\(\s*await file\.arrayBuffer\(\)\s*\)/
    );
    assert.doesNotMatch(actionsSource, /parseProject\(await file\.text\(\)\)/);
  });

  it("rejects forged, replayed and cross-route ingress capabilities", async () => {
    const project = {
      version: "1.0.0",
      metadata: {},
      layers: [],
      layerGroups: [],
      preferences: {},
    } as unknown as GeoLibreProject;
    assert.deepEqual(await verifyIngressCapabilityIsolationForTest(project), {
      forged: true,
      replay: true,
      crossRoute: true,
    });
  });

  it("stubs strict Viewshed project modules outside Windows Tauri builds", () => {
    const config = readFileSync("apps/geolibre-desktop/vite.config.ts", "utf8");
    assert.match(config, /privateAnalysisTargetStubPlugin/);
    assert.match(config, /viewshed-project-serializer/);
    assert.match(
      config,
      /!IS_WINDOWS_TAURI_BUILD \? \[privateAnalysisTargetStubPlugin\(\)\] : \[\]/
    );
    assert.match(config, /geoim3d-private-analysis-disabled/);
    assert.match(config, /geoim3d-private-serializer-disabled/);
    const webUiSources = [
      "apps/geolibre-desktop/src/components/layout/TopToolbar.tsx",
      "apps/geolibre-desktop/src/components/layout/toolbar/ProcessingMenu.tsx",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    assert.doesNotMatch(webUiSources, /onOpenWindowsPrivateAnalysisSecondary/);
  });

  it("opens canonical local projects through raw binary IPC and fatal UTF-8", () => {
    const frontend = readFileSync(
      "apps/geolibre-desktop/src/lib/tauri-io.ts",
      "utf8"
    );
    const assistantSource = readFileSync(
      "apps/geolibre-desktop/src/lib/assistant/tools.ts",
      "utf8"
    );
    assert.match(
      assistantSource,
      /function describeLayers[\s\S]*assertAssistantLayerContextSafe\(layers\)/
    );
    const boundedParser = readFileSync(
      "apps/geolibre-desktop/src/lib/project-file-bytes.ts",
      "utf8"
    );
    const native = readFileSync(
      "apps/geolibre-desktop/src-tauri/src/lib.rs",
      "utf8"
    );
    const nativeCore = readFileSync(
      "apps/geolibre-desktop/src-tauri/src/project_file.rs",
      "utf8"
    );
    assert.match(frontend, /invoke<ArrayBuffer>\("read_project_file"/);
    assert.match(boundedParser, /MAX_LOCAL_PROJECT_BYTES = 8 \* 1024 \* 1024/);
    assert.match(boundedParser, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
    assert.match(
      native,
      /fn read_project_file[\s\S]*Result<tauri::ipc::Response, String>/
    );
    assert.match(nativeCore, /MAX_PROJECT_FILE_BYTES: u64 = 8 \* 1024 \* 1024/);
    assert.match(
      nativeCore,
      /fn read_project_file_bytes[\s\S]*MAX_PROJECT_FILE_BYTES/
    );
    assert.match(
      nativeCore,
      /\.take\(MAX_PROJECT_FILE_BYTES \+ 1\)[\s\S]*read_to_end/
    );
    assert.match(
      native,
      /fn read_project_file\([\s\S]*Response::new\(read_project_file_bytes\(&path\)\?\)/
    );
  });

  it("guards notebook, statistics, print, video, tour and AI consumers", () => {
    const read = (path: string) => readFileSync(path, "utf8");
    assert.match(
      read("apps/geolibre-desktop/src/hooks/useNotebookBridge.ts"),
      /handleCommand[\s\S]*assertNoPrivateAnalysisContent[\s\S]*const emit[\s\S]*assertNoPrivateAnalysisContent/
    );
    assert.match(
      read(
        "apps/geolibre-desktop/src/components/processing/StatisticsToolsDialog.tsx"
      ),
      /selectLayersWithoutPrivateEarthwork/
    );
    for (const path of [
      "apps/geolibre-desktop/src/components/layout/PrintLayoutDialog.tsx",
      "apps/geolibre-desktop/src/components/layout/RecordVideoDialog.tsx",
      "apps/geolibre-desktop/src/components/layout/RecordTourDialog.tsx",
    ])
      assert.match(read(path), /assertNoPrivateAnalysisContent/);
    assert.match(
      read("apps/geolibre-desktop/src/lib/assistant/tools.ts"),
      /const viewBbox[\s\S]*assistantLayers\(\)/
    );
    assert.match(
      read(
        "apps/geolibre-desktop/src/components/processing/ViewshedAnalysisDialog.tsx"
      ),
      /geoim3d-viewshed-memory-preview[\s\S]*removePreview[\s\S]*showPreview/
    );
    assert.match(
      read("apps/geolibre-desktop/src/lib/viewshed-analysis.worker.ts"),
      /request\.bytes = new ArrayBuffer\(0\)[\s\S]*raster\.values = new Float64Array\(0\)/
    );
  });

  it("decodes every approved integer and float classic TIFF sample type", async () => {
    for (const [bits, sampleFormat] of [
      [8, 1],
      [16, 1],
      [32, 1],
      [8, 2],
      [16, 2],
      [32, 2],
      [32, 3],
      [64, 3],
    ] as const) {
      assert.deepEqual(
        Array.from(
          (await decodeViewshedGeoTiff(sampleGeoTiff(bits, sampleFormat)))
            .values
        ),
        [12, 8, 10, 10]
      );
    }
  });

  it("accepts only lossless NoData values for the approved sample type", () => {
    assert.equal(isViewshedNoDataLossless(255, 8, 1), true);
    assert.equal(isViewshedNoDataLossless(-128, 8, 2), true);
    assert.equal(isViewshedNoDataLossless(-1, 8, 1), false);
    assert.equal(isViewshedNoDataLossless(1.5, 16, 2), false);
    assert.equal(isViewshedNoDataLossless(0.5, 32, 3), true);
    assert.equal(isViewshedNoDataLossless(0.1, 32, 3), false);
    assert.equal(isViewshedNoDataLossless(0.1, 64, 3), true);
    assert.equal(isViewshedNoDataLossless(Number.NaN, 64, 3), false);
  });

  it("rejects BigTIFF, oversized deferred tag counts, PixelIsPoint and hidden SubIFD", async () => {
    const big = sampleGeoTiff();
    new DataView(big).setUint16(2, 43, true);
    await assert.rejects(
      () => decodeViewshedGeoTiff(big),
      /VIEWSHED_TIFF_INVALID/
    );
    const oversizedBits = sampleGeoTiff();
    new DataView(oversizedBits).setUint32(8 + 2 + 2 * 12 + 4, 2, true);
    await assert.rejects(
      () => decodeViewshedGeoTiff(oversizedBits),
      /VIEWSHED_LIMIT_EXCEEDED/
    );
    const oversizedGeoKeys = new ArrayBuffer(512);
    new Uint8Array(oversizedGeoKeys).set(new Uint8Array(sampleGeoTiff()));
    new DataView(oversizedGeoKeys).setUint32(8 + 2 + 13 * 12 + 4, 65, true);
    await assert.rejects(
      () => decodeViewshedGeoTiff(oversizedGeoKeys),
      /VIEWSHED_LIMIT_EXCEEDED/
    );
    const unknownMaterializedTag = sampleGeoTiff();
    new DataView(unknownMaterializedTag).setUint16(
      8 + 2 + 9 * 12,
      65_000,
      true
    );
    await assert.rejects(
      () => decodeViewshedGeoTiff(unknownMaterializedTag),
      /VIEWSHED_TIFF_INVALID/
    );
    const point = sampleGeoTiff();
    const geoKeyOffset = new DataView(point).getUint32(
      8 + 2 + 13 * 12 + 8,
      true
    );
    new DataView(point).setUint16(geoKeyOffset + 11 * 2, 2, true);
    await assert.rejects(
      () => decodeViewshedGeoTiff(point),
      /VIEWSHED_TRANSFORM_UNSUPPORTED/
    );
    const subIfd = sampleGeoTiff();
    new DataView(subIfd).setUint16(8 + 2 + 9 * 12, 330, true);
    await assert.rejects(
      () => decodeViewshedGeoTiff(subIfd),
      /VIEWSHED_TIFF_INVALID/
    );
  });

  it("rejects and quiesces on constructor and postMessage synchronous failures", async () => {
    const constructorFailure = runViewshedWorker(request(), {
      createWorker: () => {
        throw new Error("ctor");
      },
    });
    await assert.rejects(constructorFailure.promise, /VIEWSHED_INTERNAL/);
    assert.equal(constructorFailure.isQuiescent(), true);

    const worker = new FakeWorker();
    worker.throwOnPost = true;
    const postFailure = runViewshedWorker(request(), {
      createWorker: () => worker,
    });
    await assert.rejects(postFailure.promise, /VIEWSHED_INTERNAL/);
    assert.equal(worker.terminateCount, 1);
    assert.equal(postFailure.isQuiescent(), true);
  });

  it("settles a valid response once and ignores stale responses", async () => {
    const worker = new FakeWorker();
    const handle = runViewshedWorker(request(), {
      createWorker: () => worker,
      schedule: () => 1,
      clearSchedule: () => {},
    });
    worker.onmessage?.({
      data: { id: 999, ok: true, result: validResult() },
    } as MessageEvent);
    assert.equal(handle.isQuiescent(), false);
    worker.onmessage?.({
      data: { id: 1, ok: true, result: validResult() },
    } as MessageEvent);
    assert.equal((await handle.promise).summary.schema, "geoim3d-viewshed-v1");
    assert.equal(worker.terminateCount, 1);
  });

  it("settles through scheduler and cleanup failures exactly once", async () => {
    const scheduleWorker = new FakeWorker();
    const scheduleFailure = runViewshedWorker(request(), {
      createWorker: () => scheduleWorker,
      schedule: () => {
        throw new Error("schedule");
      },
    });
    await assert.rejects(scheduleFailure.promise, /VIEWSHED_INTERNAL/);
    assert.equal(scheduleWorker.terminateCount, 1);

    const synchronousWorker = new FakeWorker();
    synchronousWorker.throwOnTerminate = true;
    let clearCount = 0;
    const synchronousTimeout = runViewshedWorker(request(), {
      createWorker: () => synchronousWorker,
      schedule: (callback) => {
        callback();
        return 9;
      },
      clearSchedule: () => {
        clearCount += 1;
        throw new Error("clear");
      },
    });
    synchronousTimeout.cancel();
    synchronousTimeout.cancel();
    await assert.rejects(synchronousTimeout.promise, /VIEWSHED_TIMEOUT/);
    assert.equal(synchronousTimeout.isQuiescent(), true);
    assert.equal(synchronousWorker.terminateCount, 1);
    assert.equal(clearCount, 1);
  });
});
