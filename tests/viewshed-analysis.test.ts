import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  serializeProject,
  undo,
  useAppStore,
} from "../packages/core/src/index";
import {
  VIEWSHED_AREA_MODEL,
  VIEWSHED_METHOD,
  VIEWSHED_SCHEMA,
  buildViewshedLayer,
  calculateViewshed,
  classifyViewshedTarget,
  normalizeViewshedBoundary,
  normalizeViewshedResult,
  transformViewshedPoint,
  type ViewshedRaster,
} from "../apps/geolibre-desktop/src/lib/viewshed-analysis";
import {
  assertNoPrivateAnalysisContent,
  containsPersistedViewshedAnalysis,
} from "../apps/geolibre-desktop/src/lib/project-private-content";
import {
  parseCanonicalViewshedProjectDto,
  sanitizeIncomingViewshedProject,
  sanitizeViewshedProjectForLocalSave,
} from "../apps/geolibre-desktop/src/lib/viewshed-project";
import { ViewshedMemoryLedger } from "../apps/geolibre-desktop/src/lib/viewshed-memory";
import {
  sanitizeLocalDropProject,
  sanitizeLocalOpenProject,
  sanitizeLocalRecentProject,
  sanitizeLocalStartupProject,
  sanitizeRemoteCollaborationProject,
  sanitizeRemoteDeepLinkProject,
  sanitizeRemoteEmbedProject,
  sanitizeRemoteHttpRecentProject,
  sanitizeRemoteShareProject,
  sanitizeRemoteUrlProject,
} from "../apps/geolibre-desktop/src/lib/desktop-project-ingress";
import {
  serializeCanonicalJsonUtf8ForTest,
  serializeViewshedProjectUtf8,
  VIEWSHED_PROJECT_MAX_OUTPUT_BYTES,
} from "../apps/geolibre-desktop/src/lib/viewshed-project-serializer";
import { assertAssistantLayerContextSafe } from "../apps/geolibre-desktop/src/lib/assistant/private-layer-guard";

const CRS = "EPSG:5186" as const;

function rasterFromPlane(
  width: number,
  height: number,
  value: (row: number, column: number) => number
): ViewshedRaster {
  const values = new Float64Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      values[row * width + column] = value(row, column);
    }
  }
  return {
    values,
    width,
    height,
    tieI: 0,
    tieJ: 0,
    tieX: 200_000,
    tieY: 600_000,
    scaleX: 10,
    scaleY: 10,
    nodata: null,
    sourceCrs: CRS,
  };
}

function wgs(point: [number, number], sourceCrs = CRS): [number, number] {
  return transformViewshedPoint(point, sourceCrs, "EPSG:4326");
}

function boundaryForRaster(raster: ViewshedRaster) {
  const west = raster.tieX - raster.tieI * raster.scaleX - 1;
  const north = raster.tieY + raster.tieJ * raster.scaleY + 1;
  const east = west + raster.width * raster.scaleX + 2;
  const south = north - raster.height * raster.scaleY - 2;
  return normalizeViewshedBoundary({
    type: "Polygon",
    coordinates: [
      [
        wgs([west, north], raster.sourceCrs),
        wgs([west, south], raster.sourceCrs),
        wgs([east, south], raster.sourceCrs),
        wgs([east, north], raster.sourceCrs),
        wgs([west, north], raster.sourceCrs),
      ],
    ],
  });
}

function observerAt(
  raster: ViewshedRaster,
  row: number,
  column: number
): [number, number] {
  return wgs(
    [
      raster.tieX + (column + 0.5 - raster.tieI) * raster.scaleX,
      raster.tieY - (row + 0.5 - raster.tieJ) * raster.scaleY,
    ],
    raster.sourceCrs
  );
}

describe("viewshed numerical core", () => {
  it("classifies a flat DEM deterministically and builds CCW visible runs", () => {
    const raster = rasterFromPlane(5, 5, () => 10);
    const result = calculateViewshed({
      raster,
      boundary: boundaryForRaster(raster),
      observer: observerAt(raster, 2, 2),
      observerHeightMeters: 1.7,
      targetHeightMeters: 0,
      maximumRadiusMeters: 1_000,
    });
    assert.equal(result.summary.schema, VIEWSHED_SCHEMA);
    assert.equal(result.summary.method, VIEWSHED_METHOD);
    assert.equal(result.summary.areaModel, VIEWSHED_AREA_MODEL);
    assert.equal(result.summary.candidateCells, 25);
    assert.equal(result.summary.visibleCells, 25);
    assert.equal(result.summary.occludedCells, 0);
    assert.equal(result.summary.unknownCells, 0);
    assert.deepEqual(result.summary.visibleRunLengths, [5, 5, 5, 5, 5]);
    assert.equal(result.visibleRuns.geometries.length, 5);
    for (const geometry of result.visibleRuns.geometries) {
      assert.equal(geometry.type, "Polygon");
      const ring = geometry.coordinates[0];
      let twiceArea = 0;
      for (let index = 0; index < ring.length - 1; index += 1) {
        twiceArea +=
          ring[index][0] * ring[index + 1][1] -
          ring[index + 1][0] * ring[index][1];
      }
      assert.ok(twiceArea > 0, "visible run must be WGS84 CCW");
    }
  });

  it("uses positive-interval DDA with target NoData precedence", () => {
    const raster = rasterFromPlane(5, 5, () => 10);
    (raster.values as Float64Array)[2 * 5 + 2] = 100;
    assert.equal(
      classifyViewshedTarget(raster, 2, 0, 2, 4, 1.7, 0).classification,
      "occluded"
    );
    (raster.values as Float64Array)[2 * 5 + 4] = -9999;
    raster.nodata = -9999;
    const targetNoData = classifyViewshedTarget(raster, 2, 0, 2, 4, 1.7, 0);
    assert.equal(targetNoData.classification, "unknown");
    assert.equal(targetNoData.visitedCells, 0);
  });

  it("ignores zero-length corner-touch side cells", () => {
    const raster = rasterFromPlane(3, 3, () => 10);
    (raster.values as Float64Array)[0 * 3 + 1] = 1_000;
    (raster.values as Float64Array)[1 * 3 + 0] = 1_000;
    const result = classifyViewshedTarget(raster, 0, 0, 2, 2, 1.7, 0);
    assert.equal(result.classification, "visible");
    assert.equal(result.visitedCells, 1);
  });

  it("blocks an exact horizontal tangent and gives intermediate NoData priority", () => {
    const raster = rasterFromPlane(5, 1, () => 10);
    const values = raster.values as Float64Array;
    values[2] = 10.6375;
    assert.equal(
      classifyViewshedTarget(raster, 0, 0, 0, 4, 1.7, 0).classification,
      "occluded"
    );
    values[2] = 10.6374;
    assert.equal(
      classifyViewshedTarget(raster, 0, 0, 0, 4, 1.7, 0).classification,
      "visible"
    );
    values[1] = 100;
    values[2] = -9999;
    raster.nodata = -9999;
    assert.equal(
      classifyViewshedTarget(raster, 0, 0, 0, 4, 1.7, 0).classification,
      "unknown"
    );
  });

  it("allows the exact DDA visit budget and rejects before the next cell inspection", () => {
    const raster = rasterFromPlane(5, 1, () => 10);
    assert.equal(
      classifyViewshedTarget(raster, 0, 0, 0, 4, 1.7, 0, 3).visitedCells,
      3
    );
    assert.throws(
      () => classifyViewshedTarget(raster, 0, 0, 0, 4, 1.7, 0, 2),
      /VIEWSHED_LIMIT_EXCEEDED/
    );
  });

  it("canonicalizes equivalent ring rotation and winding", () => {
    const a = normalizeViewshedBoundary({
      type: "Polygon",
      coordinates: [
        [
          [127, 37],
          [127, 37.01],
          [127.01, 37.01],
          [127.01, 37],
          [127, 37],
        ],
      ],
    });
    const b = normalizeViewshedBoundary({
      type: "Polygon",
      coordinates: [
        [
          [127.01, 37.01],
          [127, 37.01],
          [127, 37],
          [127.01, 37],
          [127.01, 37.01],
        ],
      ],
    });
    assert.deepEqual(a, b);
    assert.throws(
      () =>
        normalizeViewshedBoundary({
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [127, 37],
                [127, 37.01],
                [127.01, 37.01],
                [127.01, 37],
                [127, 37],
              ],
            ],
            [
              [
                [127.01, 37],
                [127.01, 37.01],
                [127.02, 37.01],
                [127.02, 37],
                [127.01, 37],
              ],
            ],
          ],
        }),
      /VIEWSHED_BOUNDARY_INVALID/
    );
    assert.throws(
      () =>
        normalizeViewshedBoundary({
          type: "Polygon",
          coordinates: [
            [
              [179, 10],
              [-179, 10],
              [-179, 11],
              [179, 11],
              [179, 10],
            ],
          ],
        }),
      /VIEWSHED_BOUNDARY_INVALID/
    );
  });

  it("excludes hole cells with boundary-excluded semantics", () => {
    const raster = rasterFromPlane(3, 3, () => 10);
    // scaleX/scaleY are 10m, so the 3×3 raster covers projected
    // x=200000..200030 and y=599970..600000. Both holes below are inside it.
    const outer = boundaryForRaster(raster).coordinates[0];
    const holeProjected: [number, number][] = [
      [200_010, 599_990],
      [200_010, 599_980],
      [200_020, 599_980],
      [200_020, 599_990],
      [200_010, 599_990],
    ];
    const boundary = normalizeViewshedBoundary({
      type: "Polygon",
      coordinates: [outer, holeProjected.map((point) => wgs(point))],
    });
    const result = calculateViewshed({
      raster,
      boundary,
      observer: observerAt(raster, 0, 0),
      observerHeightMeters: 1.7,
      targetHeightMeters: 0,
      maximumRadiusMeters: 1_000,
    });
    assert.equal(result.summary.candidateCells, 8);

    const boundaryOnHoleEdge = normalizeViewshedBoundary({
      type: "Polygon",
      coordinates: [
        outer,
        [
          [200_015, 599_990],
          [200_015, 599_980],
          [200_020, 599_980],
          [200_020, 599_990],
          [200_015, 599_990],
        ].map((point) => wgs(point as [number, number])),
      ],
    });
    const edgeResult = calculateViewshed({
      raster,
      boundary: boundaryOnHoleEdge,
      observer: observerAt(raster, 0, 0),
      observerHeightMeters: 1.7,
      targetHeightMeters: 0,
      maximumRadiusMeters: 1_000,
    });
    assert.equal(edgeResult.summary.candidateCells, 8);
  });

  it("excludes exterior cell centers on and within the projected boundary tolerance", () => {
    const raster = rasterFromPlane(3, 3, () => 10);
    const leftCellCenterX = 200_005;
    const observer = observerAt(raster, 1, 1);
    const candidatesForInset = (insetMeters: number): number => {
      const west = leftCellCenterX - insetMeters;
      const boundary = normalizeViewshedBoundary({
        type: "Polygon",
        coordinates: [
          [
            wgs([west, 600_001]),
            wgs([west, 599_969]),
            wgs([200_031, 599_969]),
            wgs([200_031, 600_001]),
            wgs([west, 600_001]),
          ],
        ],
      });
      return calculateViewshed({
        raster,
        boundary,
        observer,
        observerHeightMeters: 1.7,
        targetHeightMeters: 0,
        maximumRadiusMeters: 1_000,
      }).summary.candidateCells;
    };

    assert.equal(candidatesForInset(0), 6);
    assert.equal(candidatesForInset(0.5e-7), 6);
    assert.equal(candidatesForInset(2e-7), 9);
  });

  it("allows exactly 250,000 candidates and rejects the 250,001st", () => {
    const makeNoDataRaster = (
      width: number,
      height: number
    ): ViewshedRaster => {
      const values = new Float64Array(width * height);
      values.fill(-9999);
      values[Math.floor(height / 2) * width + Math.floor(width / 2)] = 10;
      return {
        sourceCrs: CRS,
        width,
        height,
        values,
        nodata: -9999,
        tieI: 0,
        tieJ: 0,
        tieX: 200_000,
        tieY: 600_000,
        scaleX: 1,
        scaleY: 1,
      };
    };
    const exact = makeNoDataRaster(500, 500);
    const exactResult = calculateViewshed({
      raster: exact,
      boundary: boundaryForRaster(exact),
      observer: observerAt(exact, 250, 250),
      observerHeightMeters: 1.7,
      targetHeightMeters: 0,
      maximumRadiusMeters: 5_000,
    });
    assert.equal(exactResult.summary.candidateCells, 250_000);
    assert.equal(exactResult.summary.unknownCells, 249_999);

    const over = makeNoDataRaster(501, 500);
    assert.throws(
      () =>
        calculateViewshed({
          raster: over,
          boundary: boundaryForRaster(over),
          observer: observerAt(over, 250, 250),
          observerHeightMeters: 1.7,
          targetHeightMeters: 0,
          maximumRadiusMeters: 5_000,
        }),
      /VIEWSHED_LIMIT_EXCEEDED/
    );
  });

  it("builds a strict private layer and detects marker-stripped geometry", async () => {
    const raster = rasterFromPlane(5, 5, () => 10);
    const result = calculateViewshed({
      raster,
      boundary: boundaryForRaster(raster),
      observer: observerAt(raster, 2, 2),
      observerHeightMeters: 1.7,
      targetHeightMeters: 0,
      maximumRadiusMeters: 1_000,
    });
    const layer = buildViewshedLayer(result);
    assert.equal(layer.metadata.customLayerType, "viewshed-analysis");
    assert.equal(layer.excludeFromHistory, true);
    assert.equal(containsPersistedViewshedAnalysis(layer), true);
    assert.throws(
      () => assertAssistantLayerContextSafe([layer]),
      /PROJECT_PRIVATE_CONTENT_REJECTED/
    );
    const geometryOnly = {
      type: "FeatureCollection" as const,
      features: [...layer.geojson.features].reverse().map((feature) => ({
        type: "Feature" as const,
        geometry: structuredClone(feature.geometry),
        properties: {},
      })),
    };
    assert.equal(containsPersistedViewshedAnalysis(geometryOnly), true);
    assert.throws(
      () => assertNoPrivateAnalysisContent(geometryOnly),
      /PROJECT_PRIVATE_CONTENT_REJECTED/
    );
    const attributeTableSource = readFileSync(
      "apps/geolibre-desktop/src/components/panels/AttributeTable.tsx",
      "utf8"
    );
    assert.match(
      attributeTableSource,
      /const exportGeojson = geojsonWithDrafts\(\)[\s\S]*assertNoPrivateAnalysisContent\(exportGeojson\)[\s\S]*exportVectorLayer\(\s*exportGeojson/
    );

    const project = {
      version: "1.0.0",
      metadata: {},
      layers: [layer],
      layerGroups: [],
      preferences: { environmentVariables: [], geocoding: { apiKeys: {} } },
    } as unknown as import("@geolibre/core").GeoLibreProject;
    const canonical = sanitizeViewshedProjectForLocalSave(project);
    const sanitized = sanitizeIncomingViewshedProject(canonical);
    assert.equal(sanitized.layers.length, 1);
    assert.throws(
      () => serializeProject(project),
      /PRIVATE_ANALYSIS_CONTENT_BLOCKED/
    );
    assert.throws(
      () =>
        serializeProject({
          ...project,
          layers: [],
          metadata: { nested: geometryOnly },
        }),
      /PRIVATE_ANALYSIS_CONTENT_BLOCKED/
    );
    const tampered = structuredClone(canonical);
    tampered.metadata.foreign = true;
    assert.throws(
      () => sanitizeIncomingViewshedProject(tampered),
      /VIEWSHED_PROJECT_INVALID/
    );

    Object.assign(globalThis, {
      __TAURI_BUILD__: true,
      __WINDOWS_TAURI_BUILD__: true,
    });
    for (const local of [
      sanitizeLocalOpenProject,
      sanitizeLocalRecentProject,
      sanitizeLocalStartupProject,
      sanitizeLocalDropProject,
    ])
      await assert.doesNotReject(() => local(canonical));
    for (const remote of [
      sanitizeRemoteUrlProject,
      sanitizeRemoteHttpRecentProject,
      sanitizeRemoteDeepLinkProject,
      sanitizeRemoteShareProject,
      sanitizeRemoteEmbedProject,
      sanitizeRemoteCollaborationProject,
    ])
      await assert.rejects(
        () => remote(canonical),
        /PROJECT_PRIVATE_CONTENT_REJECTED/
      );
    delete (globalThis as Record<string, unknown>).__TAURI_BUILD__;
    delete (globalThis as Record<string, unknown>).__WINDOWS_TAURI_BUILD__;
  });

  it("reopens canonical long runs in both approved projected CRSs", () => {
    for (const [sourceCrs, tieX, tieY] of [
      ["EPSG:5179", 1_000_000, 2_000_000],
      ["EPSG:5186", 200_000, 500_000],
    ] as const) {
      const raster: ViewshedRaster = {
        ...rasterFromPlane(100, 3, () => 10),
        sourceCrs,
        tieX,
        tieY,
        scaleX: 100,
        scaleY: 100,
      };
      const result = calculateViewshed({
        raster,
        boundary: boundaryForRaster(raster),
        observer: observerAt(raster, 1, 50),
        observerHeightMeters: 1.7,
        targetHeightMeters: 0,
        maximumRadiusMeters: 10_000,
      });
      assert.doesNotThrow(() =>
        normalizeViewshedResult(structuredClone(result))
      );
    }
  });

  it("rejects reopened summaries outside the approved parameter and count bounds", () => {
    const raster = rasterFromPlane(5, 5, () => 10);
    const original = calculateViewshed({
      raster,
      boundary: boundaryForRaster(raster),
      observer: observerAt(raster, 2, 2),
      observerHeightMeters: 1.7,
      targetHeightMeters: 0,
      maximumRadiusMeters: 1_000,
    });
    const zeroArea = structuredClone(original);
    zeroArea.summary.cellAreaSquareMeters = 0;
    zeroArea.summary.visibleAreaSquareMeters = 0;
    zeroArea.summary.occludedAreaSquareMeters = 0;
    zeroArea.summary.unknownAreaSquareMeters = 0;
    assert.throws(
      () => normalizeViewshedResult(zeroArea),
      /VIEWSHED_PROJECT_INVALID/
    );
    const badHeight = structuredClone(original);
    badHeight.summary.observerHeightMeters = 0;
    assert.throws(
      () => normalizeViewshedResult(badHeight),
      /VIEWSHED_PROJECT_INVALID/
    );
    const malformedRun = structuredClone(original);
    const firstRing = malformedRun.visibleRuns.geometries[0].coordinates[0];
    firstRing[1] = [
      (firstRing[0][0] + firstRing[2][0]) / 2,
      (firstRing[0][1] + firstRing[2][1]) / 2,
    ];
    assert.throws(
      () => normalizeViewshedResult(malformedRun),
      /VIEWSHED_PROJECT_INVALID/
    );
    const tooMany = structuredClone(original);
    const extra = 250_001 - tooMany.summary.candidateCells;
    tooMany.summary.candidateCells += extra;
    tooMany.summary.occludedCells += extra;
    tooMany.summary.evaluatedCells += extra;
    tooMany.summary.occludedAreaSquareMeters =
      tooMany.summary.occludedCells * tooMany.summary.cellAreaSquareMeters;
    tooMany.summary.visiblePercentage =
      (tooMany.summary.visibleCells / tooMany.summary.evaluatedCells) * 100;
    assert.throws(
      () => normalizeViewshedResult(tooMany),
      /VIEWSHED_PROJECT_INVALID/
    );
  });

  it("detects downgraded, split and JSON-wrapped private summaries within bounds", () => {
    const identity = {
      schema: "geoim3d-viewshed-v1",
      method: "grid-positive-interval-dda-los-v1",
      model: "planar-cell-column",
      areaModel: "selected-full-cell-footprint",
      observerHeightMeters: 1.7,
      candidateCells: 4,
      visibleCells: 4,
    };
    for (const key of ["schema", "method", "model", "areaModel"] as const) {
      const downgraded = { ...identity };
      delete downgraded[key];
      assert.equal(containsPersistedViewshedAnalysis(downgraded), true);
    }
    for (const key of [
      "customLayerType",
      "schema",
      "method",
      "model",
      "areaModel",
    ]) {
      assert.equal(
        containsPersistedViewshedAnalysis({ [key]: "tampered" }),
        true
      );
    }
    assert.equal(
      containsPersistedViewshedAnalysis([
        { candidateCells: 1 },
        { visibleCells: 1 },
      ]),
      true
    );
    assert.equal(
      containsPersistedViewshedAnalysis({ candidateCells: 1 }),
      false
    );
    assert.equal(
      containsPersistedViewshedAnalysis(
        '{"nested":{"method":"grid-positive-interval-dda-los-v1"}}'
      ),
      true
    );
    assert.throws(
      () => containsPersistedViewshedAnalysis("x".repeat(1024 * 1024 + 1)),
      /PROJECT_PRIVATE_CONTENT_REJECTED/
    );
  });

  it("writes canonical Viewshed Project JSON directly to exact bounded UTF-8 bytes", () => {
    const raster = rasterFromPlane(2, 2, () => 10);
    const layer = buildViewshedLayer(
      calculateViewshed({
        raster,
        boundary: boundaryForRaster(raster),
        observer: observerAt(raster, 0, 0),
        observerHeightMeters: 1.7,
        targetHeightMeters: 0,
        maximumRadiusMeters: 1_000,
      })
    );
    const makeProject = (
      name: string,
      metadata: Record<string, unknown> = {}
    ) =>
      ({
        version: "1.0.0",
        name,
        metadata,
        layers: [structuredClone(layer)],
        layerGroups: [],
        preferences: { environmentVariables: [], geocoding: { apiKeys: {} } },
      } as unknown as import("@geolibre/core").GeoLibreProject);
    const firstProject = makeProject("한글😀", { z: true, a: 0 });
    const reorderedProject = makeProject("한글😀", { z: true, a: -0 });
    reorderedProject.layers[0].metadata = Object.fromEntries(
      Object.entries(reorderedProject.layers[0].metadata).reverse()
    );
    const first = serializeViewshedProjectUtf8(firstProject);
    const second = serializeViewshedProjectUtf8(reorderedProject);
    assert.deepEqual(first, second);
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(first)
    );
    assert.equal(parsed.name, "geoIM3D Viewshed Project");
    assert.deepEqual(parsed.metadata, {});
    assert.equal(parsed.preferences, undefined);
    assert.deepEqual(Object.keys(parsed), [
      "version",
      "name",
      "mapView",
      "basemapStyleUrl",
      "basemapVisible",
      "basemapOpacity",
      "layers",
      "layerGroups",
      "styles",
      "metadata",
    ]);
    const reopened = parseCanonicalViewshedProjectDto(parsed);
    assert.equal(reopened.layers.length, 1);
    assert.doesNotThrow(() => sanitizeIncomingViewshedProject(reopened));
    assert.throws(
      () => parseCanonicalViewshedProjectDto({ ...parsed, foreign: true }),
      /VIEWSHED_PROJECT_INVALID/
    );

    assert.equal(
      serializeCanonicalJsonUtf8ForTest(
        "x".repeat(VIEWSHED_PROJECT_MAX_OUTPUT_BYTES - 2)
      ).byteLength,
      VIEWSHED_PROJECT_MAX_OUTPUT_BYTES
    );
    const NativeUint8Array = Uint8Array;
    let outputAllocations = 0;
    const CountingUint8Array = new Proxy(NativeUint8Array, {
      construct(target, args) {
        outputAllocations += 1;
        return Reflect.construct(target, args);
      },
    });
    Object.assign(globalThis, { Uint8Array: CountingUint8Array });
    try {
      assert.throws(
        () =>
          serializeCanonicalJsonUtf8ForTest(
            "x".repeat(VIEWSHED_PROJECT_MAX_OUTPUT_BYTES - 1)
          ),
        /VIEWSHED_LIMIT_EXCEEDED/
      );
      assert.equal(outputAllocations, 0);
    } finally {
      Object.assign(globalThis, { Uint8Array: NativeUint8Array });
    }
    assert.deepEqual(
      serializeViewshedProjectUtf8(makeProject("valid", { bad: Number.NaN })),
      first
    );
    const surrogate = serializeViewshedProjectUtf8(makeProject("한글\ud800"));
    assert.equal(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(surrogate))
        .name,
      "geoIM3D Viewshed Project"
    );
    assert.throws(
      () =>
        serializeViewshedProjectUtf8({ ...makeProject("missing"), layers: [] }),
      /VIEWSHED_PROJECT_INVALID/
    );

    const ledger = new ViewshedMemoryLedger(10);
    ledger.reserve("exact", 10);
    assert.equal(ledger.usedBytes, 10);
    assert.throws(
      () => ledger.reserve("plus-one", 1),
      /VIEWSHED_LIMIT_EXCEEDED/
    );
    ledger.resize("exact", 4);
    ledger.release("exact");
    assert.equal(ledger.usedBytes, 0);
  });

  it("keeps the top-level history-excluded layer live but out of temporal snapshots", () => {
    useAppStore.getState().newProject({ name: "Viewshed history" });
    const raster = rasterFromPlane(5, 5, () => 10);
    const privateLayer = buildViewshedLayer(
      calculateViewshed({
        raster,
        boundary: boundaryForRaster(raster),
        observer: observerAt(raster, 2, 2),
        observerHeightMeters: 1.7,
        targetHeightMeters: 0,
        maximumRadiusMeters: 1_000,
      })
    );
    Object.defineProperty(privateLayer, "excludeFromHistory", {
      configurable: true,
      enumerable: true,
      value: false,
      writable: true,
    });
    (privateLayer.metadata as Record<string, unknown>).excludeFromHistory =
      false;
    useAppStore.getState().addLayer(privateLayer);
    const publicId = useAppStore
      .getState()
      .addGeoJsonLayer("Public", { type: "FeatureCollection", features: [] });
    useAppStore.temporal.getState().clear();
    useAppStore.getState().setLayerOpacity(publicId, 0.5);
    assert.equal(
      useAppStore.temporal
        .getState()
        .pastStates.some(
          (state) =>
            state.layers?.some((layer) => layer.id === privateLayer.id) === true
        ),
      false
    );
    undo();
    assert.equal(
      useAppStore
        .getState()
        .layers.some((layer) => layer.id === privateLayer.id),
      true
    );
    useAppStore.getState().newProject({ name: "Cleanup" });
  });
});
