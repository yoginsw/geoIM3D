import type { GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { clearHistory, useAppStore } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  buildViewshedLayer,
  normalizeViewshedBoundary,
  type ViewshedBoundary,
  type ViewshedResult,
} from "../../lib/viewshed-analysis";
import { pickAndReadViewshedGeoTiff } from "../../lib/viewshed-native";
import {
  runViewshedWorker,
  type ViewshedWorkerHandle,
} from "../../lib/viewshed-worker-client";

interface ViewshedAnalysisDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: RefObject<MapController | null>;
}

const PREVIEW_SOURCE_ID = "geoim3d-viewshed-memory-preview";
const PREVIEW_LAYER_ID = "geoim3d-viewshed-memory-preview-fill";

function boundaryFromLayer(layer: GeoLibreLayer | undefined): ViewshedBoundary {
  const features = layer?.geojson?.features;
  if (!features || features.length !== 1)
    throw new Error("VIEWSHED_BOUNDARY_INVALID");
  return normalizeViewshedBoundary(features[0].geometry);
}

function message(code: string): string {
  if (code === "VIEWSHED_CRS_UNSUPPORTED")
    return "EPSG:5179 또는 EPSG:5186 DEM을 선택하세요.";
  if (code === "VIEWSHED_OBSERVER_INVALID")
    return "관측점이 경계와 DEM 내부인지 확인하세요.";
  if (code === "VIEWSHED_EMPTY_SELECTION")
    return "경계와 반경 안에 분석할 Pixel center가 없습니다.";
  if (code === "VIEWSHED_EMPTY_EVALUATION")
    return "평가 가능한 Pixel이 없습니다.";
  if (code === "VIEWSHED_TIMEOUT")
    return "가시권 계산이 60초 제한을 초과했습니다.";
  if (
    code === "VIEWSHED_LIMIT_EXCEEDED" ||
    code === "VIEWSHED_RESULT_TOO_COMPLEX"
  ) {
    return "DEM 또는 결과가 안전 처리 한도를 초과했습니다.";
  }
  return "가시권 분석을 완료하지 못했습니다.";
}

export function ViewshedAnalysisDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: ViewshedAnalysisDialogProps) {
  const layers = useAppStore((state) => state.layers);
  const addLayer = useAppStore((state) => state.addLayer);
  const candidates = useMemo(
    () =>
      layers.filter((layer) => {
        const geometry = layer.geojson?.features?.[0]?.geometry;
        return (
          layer.geojson?.features?.length === 1 &&
          (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon")
        );
      }),
    [layers]
  );
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [longitude, setLongitude] = useState("127");
  const [latitude, setLatitude] = useState("37");
  const [observerHeight, setObserverHeight] = useState("1.7");
  const [targetHeight, setTargetHeight] = useState("0");
  const [radius, setRadius] = useState("5000");
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [preview, setPreview] = useState<ViewshedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generationRef = useRef(0);
  const workerRef = useRef<ViewshedWorkerHandle | null>(null);

  const removePreview = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    try {
      if (map.getLayer(PREVIEW_LAYER_ID)) map.removeLayer(PREVIEW_LAYER_ID);
      if (map.getSource(PREVIEW_SOURCE_ID)) map.removeSource(PREVIEW_SOURCE_ID);
    } catch {
      // Map/style teardown already discarded the memory-only preview.
    }
  }, [mapControllerRef]);

  const showPreview = useCallback(
    (result: ViewshedResult) => {
      removePreview();
      const map = mapControllerRef.current?.getMap();
      if (!map) return;
      map.addSource(PREVIEW_SOURCE_ID, {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: result.visibleRuns,
        },
      });
      map.addLayer({
        id: PREVIEW_LAYER_ID,
        type: "fill",
        source: PREVIEW_SOURCE_ID,
        paint: { "fill-color": "#22c55e", "fill-opacity": 0.3 },
      });
    },
    [mapControllerRef, removePreview]
  );

  const quiesce = useCallback(
    (code = "VIEWSHED_CANCELLED") => {
      workerRef.current?.cancel(code);
      workerRef.current = null;
      removePreview();
    },
    [removePreview]
  );

  useEffect(
    () => () => {
      generationRef.current += 1;
      quiesce();
    },
    [quiesce]
  );

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      quiesce();
      setBusy(false);
      setPreview(null);
      setError("");
    }
  }, [open, quiesce]);

  const calculate = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    quiesce();
    setPreview(null);
    setError("");
    setBusy(true);
    try {
      const boundary = boundaryFromLayer(
        layers.find((layer) => layer.id === selectedLayerId)
      );
      const observer: [number, number] = [Number(longitude), Number(latitude)];
      const observerHeightMeters = Number(observerHeight);
      const targetHeightMeters = Number(targetHeight);
      const maximumRadiusMeters = Number(radius);
      if (
        !privacyConfirmed ||
        [
          observer[0],
          observer[1],
          observerHeightMeters,
          targetHeightMeters,
          maximumRadiusMeters,
        ].some((value) => !Number.isFinite(value))
      )
        throw new Error("VIEWSHED_PARAMETER_INVALID");
      const bytes = await pickAndReadViewshedGeoTiff();
      if (bytes === null || generationRef.current !== generation) return;
      const handle = runViewshedWorker({
        id: generation,
        bytes,
        boundary,
        observer,
        observerHeightMeters,
        targetHeightMeters,
        maximumRadiusMeters,
      });
      workerRef.current = handle;
      const result = await handle.promise;
      if (generationRef.current !== generation) return;
      workerRef.current = null;
      showPreview(result);
      setPreview(result);
    } catch (caught) {
      if (generationRef.current === generation) {
        workerRef.current = null;
        removePreview();
        setPreview(null);
        setError(
          message(
            caught instanceof Error ? caught.message : "VIEWSHED_INTERNAL"
          )
        );
      }
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [
    layers,
    selectedLayerId,
    longitude,
    latitude,
    observerHeight,
    targetHeight,
    radius,
    privacyConfirmed,
    quiesce,
    removePreview,
    showPreview,
  ]);

  const apply = useCallback(() => {
    if (!preview) return;
    addLayer(buildViewshedLayer(preview));
    clearHistory();
    removePreview();
    setPreview(null);
    onOpenChange(false);
  }, [addLayer, onOpenChange, preview, removePreview]);

  const summary = preview?.summary;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl"
        data-testid="viewshed-analysis-dialog"
      >
        <DialogHeader>
          <DialogTitle>가시권 분석</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="viewshed-boundary">분석 경계</Label>
            <select
              id="viewshed-boundary"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={selectedLayerId}
              onChange={(event) => setSelectedLayerId(event.target.value)}
            >
              <option value="">Polygon Layer 선택</option>
              {candidates.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="viewshed-longitude">관측점 경도</Label>
              <Input
                id="viewshed-longitude"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="viewshed-latitude">관측점 위도</Label>
              <Input
                id="viewshed-latitude"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="viewshed-observer-height">관측 높이(m)</Label>
              <Input
                id="viewshed-observer-height"
                value={observerHeight}
                onChange={(e) => setObserverHeight(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="viewshed-target-height">대상 높이(m)</Label>
              <Input
                id="viewshed-target-height"
                value={targetHeight}
                onChange={(e) => setTargetHeight(e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="viewshed-radius">최대 반경(m)</Label>
              <Input
                id="viewshed-radius"
                value={radius}
                onChange={(e) => setRadius(e.target.value)}
              />
            </div>
          </div>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={privacyConfirmed}
              onChange={(e) => setPrivacyConfirmed(e.target.checked)}
            />
            Local-only planar cell-column screening이며 Project 외부 전송이
            차단됨을 확인했습니다.
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {summary && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p className="text-xs text-muted-foreground">
                셀 중심 기준 분류이며 면적은 선택된 전체 raster-cell footprint
                합계입니다.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <span>가시 면적</span>
                <strong>
                  {summary.visibleAreaSquareMeters.toLocaleString()} m²
                </strong>
                <span>차폐 면적</span>
                <strong>
                  {summary.occludedAreaSquareMeters.toLocaleString()} m²
                </strong>
                <span>미평가 면적</span>
                <strong>
                  {summary.unknownAreaSquareMeters.toLocaleString()} m²
                </strong>
                <span>가시율</span>
                <strong>{summary.visiblePercentage.toFixed(2)}%</strong>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
          <Button onClick={calculate} disabled={busy}>
            {busy ? "계산 중…" : "DEM 선택 및 계산"}
          </Button>
          <Button onClick={apply} disabled={!preview || busy}>
            결과 Layer 추가
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
