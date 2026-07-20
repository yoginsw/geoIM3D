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
  buildEarthworkLayer,
  normalizeEarthworkBoundary,
  normalizeEarthworkResult,
  type EarthworkBoundary,
  type EarthworkResult,
} from "../../lib/earthwork-analysis";
import { pickAndReadEarthworkGeoTiff } from "../../lib/earthwork-native";

interface EarthworkAnalysisDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const WORKER_TIMEOUT_MS = 60_000;
const WORKER_ERRORS = new Set([
  "EARTHWORK_TIFF_INVALID",
  "EARTHWORK_CRS_UNSUPPORTED",
  "EARTHWORK_TRANSFORM_UNSUPPORTED",
  "EARTHWORK_SAMPLE_UNSUPPORTED",
  "EARTHWORK_BOUNDARY_INVALID",
  "EARTHWORK_VERTICAL_DATUM_UNCONFIRMED",
  "EARTHWORK_LIMIT_EXCEEDED",
  "EARTHWORK_EMPTY_SELECTION",
  "EARTHWORK_NUMERIC_INVALID",
]);

function boundaryFromLayer(layer: GeoLibreLayer | undefined): EarthworkBoundary {
  const features = layer?.geojson?.features;
  if (!features || features.length !== 1) throw new Error("EARTHWORK_BOUNDARY_INVALID");
  return normalizeEarthworkBoundary(features[0].geometry);
}

function errorMessage(code: string): string {
  if (code === "EARTHWORK_FILE_TOO_LARGE" || code === "EARTHWORK_LIMIT_EXCEEDED") {
    return "DEM 또는 작업 경계가 처리 한도를 초과했습니다.";
  }
  if (code === "EARTHWORK_CRS_UNSUPPORTED") {
    return "EPSG:5179 또는 EPSG:5186 단일 Band DEM을 선택하세요.";
  }
  if (code === "EARTHWORK_EMPTY_SELECTION") {
    return "작업 경계 안에 계산 가능한 DEM Pixel이 없습니다.";
  }
  if (code === "EARTHWORK_VERTICAL_DATUM_UNCONFIRMED") {
    return "DEM과 계획고의 수직 기준면 일치 여부를 확인하세요.";
  }
  if (code === "EARTHWORK_TIMEOUT") {
    return "토공량 계산이 60초 제한을 초과해 중단되었습니다.";
  }
  return "DEM을 읽거나 토공량을 계산하지 못했습니다. 입력 형식과 작업 경계를 확인하세요.";
}

export function EarthworkAnalysisDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: EarthworkAnalysisDialogProps) {
  const layers = useAppStore((state) => state.layers);
  const addLayer = useAppStore((state) => state.addLayer);
  const eligibleLayers = useMemo(
    () =>
      layers.filter((layer) => {
        try {
          boundaryFromLayer(layer);
          return true;
        } catch {
          return false;
        }
      }),
    [layers],
  );
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [designElevation, setDesignElevation] = useState("0");
  const [datumConfirmed, setDatumConfirmed] = useState(false);
  const [preview, setPreview] = useState<EarthworkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generationRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRejectRef = useRef<((error: Error) => void) | null>(null);

  useEffect(() => {
    if (!selectedLayerId && eligibleLayers[0]) setSelectedLayerId(eligibleLayers[0].id);
  }, [eligibleLayers, selectedLayerId]);

  const terminateWorker = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    const reject = pendingRejectRef.current;
    pendingRejectRef.current = null;
    reject?.(new Error("EARTHWORK_CANCELLED"));
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    terminateWorker();
    setBusy(false);
  }, [terminateWorker]);

  useEffect(() => () => cancel(), [cancel]);

  const calculate = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    terminateWorker();
    setPreview(null);
    setError("");
    setBusy(true);
    try {
      const boundary = boundaryFromLayer(
        layers.find((layer) => layer.id === selectedLayerId),
      );
      const designElevationMeters = Number(designElevation);
      if (!Number.isFinite(designElevationMeters)) throw new Error("EARTHWORK_NUMERIC_INVALID");
      if (!datumConfirmed) throw new Error("EARTHWORK_VERTICAL_DATUM_UNCONFIRMED");
      const bytes = await pickAndReadEarthworkGeoTiff();
      if (bytes === null || generationRef.current !== generation) return;
      const worker = new Worker(
        new URL("../../lib/earthwork-analysis.worker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current = worker;
      const result = await new Promise<EarthworkResult>((resolve, reject) => {
        pendingRejectRef.current = reject;
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          if (event.data.id !== generation || generationRef.current !== generation) return;
          if (!event.data.ok) {
            pendingRejectRef.current = null;
            reject(new Error(WORKER_ERRORS.has(event.data.error ?? "") ? event.data.error : "EARTHWORK_FAILED"));
            return;
          }
          try {
            pendingRejectRef.current = null;
            resolve(normalizeEarthworkResult(event.data.result));
          } catch {
            pendingRejectRef.current = null;
            reject(new Error("EARTHWORK_FAILED"));
          }
        };
        worker.onerror = () => {
          pendingRejectRef.current = null;
          reject(new Error("EARTHWORK_FAILED"));
        };
        timerRef.current = setTimeout(() => {
          pendingRejectRef.current = null;
          worker.terminate();
          reject(new Error("EARTHWORK_TIMEOUT"));
        }, WORKER_TIMEOUT_MS);
        worker.postMessage(
          {
            id: generation,
            bytes,
            boundary,
            designElevationMeters,
            verticalDatumConfirmed: true,
          },
          [bytes],
        );
      });
      if (generationRef.current === generation) setPreview(result);
    } catch (caught) {
      if (generationRef.current !== generation) return;
      const code = caught instanceof Error ? caught.message : "EARTHWORK_FAILED";
      setError(errorMessage(code));
    } finally {
      if (generationRef.current === generation) {
        terminateWorker();
        setBusy(false);
      }
    }
  }, [datumConfirmed, designElevation, layers, selectedLayerId, terminateWorker]);

  const apply = useCallback(() => {
    if (!preview) return;
    const layer = buildEarthworkLayer(preview);
    addLayer(layer);
    clearHistory();
    mapControllerRef.current?.fitLayer(layer);
    setPreview(null);
    onOpenChange(false);
  }, [addLayer, mapControllerRef, onOpenChange, preview]);

  const changeOpen = useCallback(
    (next: boolean) => {
      if (!next) cancel();
      onOpenChange(next);
    },
    [cancel, onOpenChange],
  );

  const summary = preview?.summary;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-xl" data-testid="earthwork-analysis-dialog">
        <DialogHeader>
          <DialogTitle>토공량/절성토</DialogTitle>
          <DialogDescription>
            로컬 단일 Band DEM과 작업 경계, 일정 계획고로 근사 절토·성토량을 계산합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="earthwork-boundary">작업 경계</Label>
            <select
              id="earthwork-boundary"
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
          <div className="space-y-2">
            <Label htmlFor="earthwork-grade">계획고 (m)</Label>
            <Input
              id="earthwork-grade"
              type="number"
              min={-1000}
              max={10000}
              step="0.01"
              value={designElevation}
              onChange={(event) => setDesignElevation(event.target.value)}
              disabled={busy}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={datumConfirmed}
              onChange={(event) => setDatumConfirmed(event.target.checked)}
              disabled={busy}
            />
            DEM 표고와 계획고가 동일한 meter 수직 기준면을 사용함을 확인합니다.
          </label>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {summary && (
            <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm" data-testid="earthwork-summary">
              <span>절토량</span><strong>{summary.cutCubicMeters.toLocaleString()} m³</strong>
              <span>성토량</span><strong>{summary.fillCubicMeters.toLocaleString()} m³</strong>
              <span>순물량</span><strong>{summary.netCubicMeters.toLocaleString()} m³</strong>
              <span>포함 면적</span><strong>{summary.includedAreaSquareMeters.toLocaleString()} m²</strong>
              <span>Pixel</span><strong>{summary.includedCells.toLocaleString()}</strong>
            </div>
          )}
          <div className="flex justify-end gap-2">
            {busy && <Button type="button" variant="outline" onClick={cancel}>취소</Button>}
            <Button
              type="button"
              variant="outline"
              disabled={busy || !selectedLayerId}
              onClick={() => void calculate()}
            >
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              DEM 선택 및 계산
            </Button>
            <Button type="button" disabled={!preview || busy} onClick={apply}>결과 Layer 추가</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
