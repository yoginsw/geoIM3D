import { clearHistory, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTerrainSafetyLayer,
  normalizeTerrainSafetyBoundary,
  type TerrainSafetyBoundary,
  type TerrainSafetyResult,
} from "../../lib/terrain-safety-analysis";
import { pickAndReadTerrainSafetyGeoTiff } from "../../lib/terrain-safety-native";
import {
  runTerrainSafetyWorker,
  type TerrainSafetyWorkerHandle,
} from "../../lib/terrain-safety-worker-client";

interface TerrainSafetyAnalysisDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}


function boundaryFromLayer(layer: GeoLibreLayer | undefined): TerrainSafetyBoundary {
  const features = layer?.geojson?.features;
  if (!features || features.length !== 1) throw new Error("TERRAIN_SAFETY_BOUNDARY_INVALID");
  return normalizeTerrainSafetyBoundary(features[0].geometry);
}

function errorMessage(code: string): string {
  if (code === "TERRAIN_SAFETY_FILE_TOO_LARGE" || code === "TERRAIN_SAFETY_LIMIT_EXCEEDED") {
    return "DEM 또는 분석 경계가 처리 한도를 초과했습니다.";
  }
  if (code === "TERRAIN_SAFETY_CRS_UNSUPPORTED") {
    return "EPSG:5179 또는 EPSG:5186 단일 Band DEM을 선택하세요.";
  }
  if (code === "TERRAIN_SAFETY_EMPTY_SELECTION") {
    return "분석 경계 안에 DEM Pixel center가 없습니다.";
  }
  if (code === "TERRAIN_SAFETY_EMPTY_EVALUATION") {
    return "경계 안에 3×3 경사를 계산할 수 있는 Pixel이 없습니다.";
  }
  if (code === "TERRAIN_SAFETY_VERTICAL_DATUM_UNCONFIRMED") {
    return "DEM의 수평·수직 단위와 기준면을 확인하세요.";
  }
  if (code === "TERRAIN_SAFETY_TIMEOUT") {
    return "경사 계산이 60초 제한을 초과해 중단되었습니다.";
  }
  return "DEM을 읽거나 경사·안전 분석을 수행하지 못했습니다.";
}

export function TerrainSafetyAnalysisDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: TerrainSafetyAnalysisDialogProps) {
  const layers = useAppStore((state) => state.layers);
  const addLayer = useAppStore((state) => state.addLayer);
  const eligibleLayers = useMemo(
    () => layers.filter((layer) => {
      try {
        boundaryFromLayer(layer);
        return layer.metadata?.customLayerType !== "terrain-slope-safety";
      } catch {
        return false;
      }
    }),
    [layers],
  );
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [warningThreshold, setWarningThreshold] = useState("15");
  const [dangerThreshold, setDangerThreshold] = useState("30");
  const [datumConfirmed, setDatumConfirmed] = useState(false);
  const [preview, setPreview] = useState<TerrainSafetyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generationRef = useRef(0);
  const workerHandleRef = useRef<TerrainSafetyWorkerHandle | null>(null);

  useEffect(() => {
    if (!selectedLayerId && eligibleLayers[0]) setSelectedLayerId(eligibleLayers[0].id);
  }, [eligibleLayers, selectedLayerId]);

  const quiesce = useCallback((code?: string) => {
    const handle = workerHandleRef.current;
    workerHandleRef.current = null;
    if (handle && !handle.isQuiescent()) handle.cancel(code);
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    quiesce("TERRAIN_SAFETY_CANCELLED");
    setBusy(false);
  }, [quiesce]);

  useEffect(() => () => cancel(), [cancel]);

  const calculate = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    quiesce("TERRAIN_SAFETY_CANCELLED");
    setPreview(null);
    setError("");
    setBusy(true);
    try {
      const boundary = boundaryFromLayer(layers.find((layer) => layer.id === selectedLayerId));
      const warningThresholdDegrees = Number(warningThreshold);
      const dangerThresholdDegrees = Number(dangerThreshold);
      if (
        !Number.isFinite(warningThresholdDegrees) ||
        !Number.isFinite(dangerThresholdDegrees) ||
        warningThresholdDegrees < 0.1 ||
        warningThresholdDegrees >= 89 ||
        dangerThresholdDegrees <= warningThresholdDegrees ||
        dangerThresholdDegrees > 89
      ) throw new Error("TERRAIN_SAFETY_NUMERIC_INVALID");
      if (!datumConfirmed) throw new Error("TERRAIN_SAFETY_VERTICAL_DATUM_UNCONFIRMED");

      const bytes = await pickAndReadTerrainSafetyGeoTiff();
      if (bytes === null || generationRef.current !== generation) return;
      const handle = runTerrainSafetyWorker({
        id: generation,
        bytes,
        boundary,
        warningThresholdDegrees,
        dangerThresholdDegrees,
        verticalDatumConfirmed: true,
      });
      workerHandleRef.current = handle;
      const result = await handle.promise;
      if (generationRef.current === generation) setPreview(result);
    } catch (caught) {
      if (generationRef.current !== generation) return;
      setError(errorMessage(caught instanceof Error ? caught.message : ""));
    } finally {
      if (generationRef.current === generation) {
        quiesce();
        setBusy(false);
      }
    }
  }, [
    dangerThreshold,
    datumConfirmed,
    layers,
    quiesce,
    selectedLayerId,
    warningThreshold,
  ]);

  const apply = useCallback(() => {
    if (!preview) return;
    const layer = buildTerrainSafetyLayer(preview);
    addLayer(layer);
    clearHistory();
    mapControllerRef.current?.fitLayer(layer);
    setPreview(null);
    onOpenChange(false);
  }, [addLayer, mapControllerRef, onOpenChange, preview]);

  const changeOpen = useCallback((next: boolean) => {
    if (!next) cancel();
    onOpenChange(next);
  }, [cancel, onOpenChange]);

  const summary = preview?.summary;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-xl" data-testid="terrain-safety-analysis-dialog">
        <DialogHeader>
          <DialogTitle>경사·안전 분석</DialogTitle>
          <DialogDescription>
            로컬 DEM과 분석 경계로 경사를 계산해 사용자 기준에 따라 안전·주의·위험을 집계합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="terrain-safety-boundary">분석 경계</Label>
            <select
              id="terrain-safety-boundary"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={selectedLayerId}
              onChange={(event) => setSelectedLayerId(event.target.value)}
              disabled={busy}
            >
              <option value="">Polygon Layer 선택</option>
              {eligibleLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>{layer.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="terrain-warning">주의 기준 (°)</Label>
              <Input id="terrain-warning" type="number" min={0.1} max={88.9} step="0.1"
                value={warningThreshold} onChange={(event) => setWarningThreshold(event.target.value)} disabled={busy} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="terrain-danger">위험 기준 (°)</Label>
              <Input id="terrain-danger" type="number" min={0.2} max={89} step="0.1"
                value={dangerThreshold} onChange={(event) => setDangerThreshold(event.target.value)} disabled={busy} />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={datumConfirmed}
              onChange={(event) => setDatumConfirmed(event.target.checked)} disabled={busy} />
            DEM의 수평·수직 단위가 meter이고 동일한 수직 기준면을 사용함을 확인합니다.
          </label>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {summary && (
            <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm" data-testid="terrain-safety-summary">
              <span>안전 면적</span><strong>{summary.safeAreaSquareMeters.toLocaleString()} m²</strong>
              <span>주의 면적</span><strong>{summary.warningAreaSquareMeters.toLocaleString()} m²</strong>
              <span>위험 면적</span><strong>{summary.dangerAreaSquareMeters.toLocaleString()} m²</strong>
              <span>미평가 면적</span><strong>{summary.unknownAreaSquareMeters.toLocaleString()} m²</strong>
              <span>평균 경사</span><strong>{summary.meanSlopeDegrees.toFixed(2)}°</strong>
              <span>평가 Pixel</span><strong>{summary.evaluatedCells.toLocaleString()}</strong>
            </div>
          )}
          <div className="flex justify-end gap-2">
            {busy && <Button type="button" variant="outline" onClick={cancel}>취소</Button>}
            <Button type="button" variant="outline" disabled={busy || !selectedLayerId}
              onClick={() => void calculate()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              DEM 선택 및 계산
            </Button>
            <Button type="button" disabled={!preview || busy} onClick={apply}>결과 Layer 추가</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
