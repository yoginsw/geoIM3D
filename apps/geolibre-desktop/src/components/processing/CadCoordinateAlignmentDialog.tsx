import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  cancelConversionJob,
  fetchConversionJob,
  type ConversionJob,
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SUPPORTED_CAD_CRS,
  alignCadFeatureCollection,
  createCoordinateAlignmentMetadata,
  type CadAlignmentMethod,
  type CadAlignmentResult,
  type Point2D,
  type SupportedCadCrs,
} from "../../lib/cad-coordinate-alignment";
import {
  isTauri,
  pickLocalPathWithFallback,
} from "../../lib/tauri-io";
import { runCadReadDxf } from "../../lib/cad-dxf-sidecar";
import { startGeoLibreSidecar } from "../../lib/sidecar";

const RUNNING = new Set(["pending", "running"]);
const POLL_INTERVAL_MS = 250;
const MAX_POLLS = 2_400;

interface CadCoordinateAlignmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

interface CadDxfJobResult {
  geojson: FeatureCollection;
  feature_count: number;
}

interface ControlPointDraft {
  sourceX: string;
  sourceY: string;
  targetLongitude: string;
  targetLatitude: string;
}

const EMPTY_POINT: ControlPointDraft = {
  sourceX: "",
  sourceY: "",
  targetLongitude: "",
  targetLatitude: "",
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function leafName(path: string): string {
  return path.split(/[\\/]/).pop() || "CAD";
}

function layerName(path: string): string {
  return `${leafName(path).replace(/\.dxf$/i, "")} 정합`;
}

function isCadDxfJobResult(value: unknown): value is CadDxfJobResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CadDxfJobResult>;
  return (
    candidate.geojson?.type === "FeatureCollection" &&
    Array.isArray(candidate.geojson.features) &&
    typeof candidate.feature_count === "number"
  );
}

function parsePoint(
  draft: ControlPointDraft,
  kind: "source" | "target",
  index: number,
): Point2D {
  const raw =
    kind === "source"
      ? [draft.sourceX, draft.sourceY]
      : [draft.targetLongitude, draft.targetLatitude];
  const point = raw.map((value) => Number(value.trim())) as [number, number];
  if (!raw.every((value) => value.trim() !== "") || !point.every(Number.isFinite)) {
    throw new Error(
      `${kind === "source" ? "CAD" : "GIS"} 제어점 ${index}의 좌표를 확인하세요.`,
    );
  }
  if (
    kind === "target" &&
    (point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90)
  ) {
    throw new Error(`GIS 제어점 ${index}는 유효한 경위도 범위여야 합니다.`);
  }
  return point;
}

async function waitForJob(
  initial: ConversionJob,
  isCurrent: () => boolean,
): Promise<ConversionJob> {
  let job = initial;
  for (let poll = 0; RUNNING.has(job.status) && poll < MAX_POLLS; poll += 1) {
    if (!isCurrent()) throw new Error("CANCELLED");
    await delay(POLL_INTERVAL_MS);
    job = await fetchConversionJob(job.id);
  }
  if (RUNNING.has(job.status)) throw new Error("DXF_TIMEOUT");
  return job;
}

export function CadCoordinateAlignmentDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: CadCoordinateAlignmentDialogProps) {
  const addGeoJsonLayer = useAppStore((state) => state.addGeoJsonLayer);
  const updateLayer = useAppStore((state) => state.updateLayer);
  const [inputPath, setInputPath] = useState("");
  const [sourceCrs, setSourceCrs] =
    useState<SupportedCadCrs>("EPSG:5186");
  const [method, setMethod] = useState<CadAlignmentMethod>("crs");
  const [points, setPoints] = useState<[ControlPointDraft, ControlPointDraft]>([
    { ...EMPTY_POINT },
    { ...EMPTY_POINT },
  ]);
  const [preview, setPreview] = useState<CadAlignmentResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const runGeneration = useRef(0);
  const activeJobIdRef = useRef<string | null>(null);

  const cancelActiveJob = useCallback(() => {
    const jobId = activeJobIdRef.current;
    activeJobIdRef.current = null;
    if (jobId) {
      void cancelConversionJob(jobId).catch(() => undefined);
    }
  }, []);

  useEffect(() => () => cancelActiveJob(), [cancelActiveJob]);

  const invalidatePreview = useCallback(() => {
    setPreview(null);
    setError("");
  }, []);

  const chooseFile = useCallback(async () => {
    const selected = await pickLocalPathWithFallback({
      filters: [{ name: "DXF", extensions: ["dxf"] }],
    });
    if (!selected) return;
    setInputPath(selected);
    invalidatePreview();
  }, [invalidatePreview]);

  const updatePoint = useCallback(
    (index: 0 | 1, key: keyof ControlPointDraft, value: string) => {
      setPoints((current) => {
        const next: [ControlPointDraft, ControlPointDraft] = [
          { ...current[0] },
          { ...current[1] },
        ];
        next[index][key] = value;
        return next;
      });
      invalidatePreview();
    },
    [invalidatePreview],
  );

  const handlePreview = useCallback(async () => {
    if (!isTauri()) {
      setError("CAD/GIS 좌표 정합은 Windows Desktop에서만 사용할 수 있습니다.");
      return;
    }
    if (!/\.dxf$/i.test(inputPath)) {
      setError("DXF 파일을 선택하세요.");
      return;
    }

    let sourceControlPoints: [Point2D, Point2D] | undefined;
    let targetControlPointsWgs84: [Point2D, Point2D] | undefined;
    try {
      if (method === "similarity-2-point") {
        sourceControlPoints = [
          parsePoint(points[0], "source", 1),
          parsePoint(points[1], "source", 2),
        ];
        targetControlPointsWgs84 = [
          parsePoint(points[0], "target", 1),
          parsePoint(points[1], "target", 2),
        ];
      }
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "제어점 좌표를 확인하세요.",
      );
      return;
    }

    const generation = runGeneration.current + 1;
    runGeneration.current = generation;
    setLoading(true);
    setError("");
    setPreview(null);
    let jobId: string | null = null;
    try {
      const sidecar = await startGeoLibreSidecar();
      const initial = await runCadReadDxf(sidecar, inputPath);
      jobId = initial.id;
      activeJobIdRef.current = jobId;
      if (runGeneration.current !== generation) {
        activeJobIdRef.current = null;
        await cancelConversionJob(jobId).catch(() => undefined);
        return;
      }
      const job = await waitForJob(
        initial,
        () => runGeneration.current === generation,
      );
      if (activeJobIdRef.current === jobId) activeJobIdRef.current = null;
      if (runGeneration.current !== generation) return;
      if (job.status !== "succeeded" || !isCadDxfJobResult(job.result)) {
        throw new Error("DXF_IMPORT_FAILED");
      }
      const aligned = alignCadFeatureCollection(job.result.geojson, {
        sourceCrs,
        method,
        sourceControlPoints,
        targetControlPointsWgs84,
      });
      if (runGeneration.current === generation) setPreview(aligned);
    } catch (previewError) {
      if (jobId && activeJobIdRef.current === jobId) {
        activeJobIdRef.current = null;
        await cancelConversionJob(jobId).catch(() => undefined);
      }
      if (
        previewError instanceof Error &&
        previewError.message === "CANCELLED"
      ) {
        return;
      }
      setError(
        previewError instanceof Error &&
          !["DXF_IMPORT_FAILED", "DXF_TIMEOUT"].includes(previewError.message)
          ? previewError.message
          : "DXF를 읽거나 좌표를 정합하지 못했습니다. 파일과 좌표계를 확인하세요.",
      );
    } finally {
      if (runGeneration.current === generation) setLoading(false);
    }
  }, [inputPath, method, points, sourceCrs]);

  const applyPreview = useCallback(() => {
    if (!preview) return;
    const id = addGeoJsonLayer(layerName(inputPath), preview.geojson);
    updateLayer(id, {
      metadata: {
        coordinateAlignment: createCoordinateAlignmentMetadata({
          sourceCrs: preview.summary.sourceCrs,
          method: preview.summary.method,
          scale: preview.summary.scale,
          rotationDegrees: preview.summary.rotationDegrees,
          rmsErrorMeters: preview.summary.rmsErrorMeters,
        }),
      },
    });
    const layer = useAppStore
      .getState()
      .layers.find((candidate) => candidate.id === id);
    if (layer) mapControllerRef.current?.fitLayer(layer);
    onOpenChange(false);
  }, [
    addGeoJsonLayer,
    inputPath,
    mapControllerRef,
    onOpenChange,
    preview,
    updateLayer,
  ]);

  const close = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        runGeneration.current += 1;
        cancelActiveJob();
        setLoading(false);
      }
      onOpenChange(nextOpen);
    },
    [cancelActiveJob, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl" data-testid="cad-alignment-dialog">
        <DialogHeader>
          <DialogTitle>CAD/GIS 좌표 정합</DialogTitle>
          <DialogDescription>
            Windows DXF를 WGS84 Layer로 변환합니다. 원본 경로와 제어점은 Project에 저장하지 않습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="cad-alignment-file">DXF 파일</Label>
            <div className="flex gap-2">
              <Input
                id="cad-alignment-file"
                value={inputPath ? leafName(inputPath) : ""}
                placeholder=".dxf 파일을 선택하세요"
                readOnly
              />
              <Button type="button" variant="outline" onClick={chooseFile}>
                <FolderOpen className="mr-2 h-4 w-4" />
                선택
              </Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Source CRS</Label>
              <Select
                aria-label="Source CRS"
                value={sourceCrs}
                onChange={(event) => {
                  setSourceCrs(event.target.value as SupportedCadCrs);
                  invalidatePreview();
                }}
              >
                {SUPPORTED_CAD_CRS.map((crs) => (
                  <option key={crs} value={crs}>
                    {crs}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>정합 방식</Label>
              <Select
                aria-label="정합 방식"
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value as CadAlignmentMethod);
                  invalidatePreview();
                }}
              >
                <option value="crs">CRS 직접 변환</option>
                <option value="similarity-2-point">2점 Similarity</option>
              </Select>
            </div>
          </div>

          {method === "similarity-2-point" ? (
            <div className="grid gap-3 rounded-md border p-3">
              <div className="text-sm font-medium">
                CAD Source 좌표 ↔ GIS WGS84 경위도
              </div>
              {([0, 1] as const).map((index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-4">
                  <Input
                    aria-label={`CAD X ${index + 1}`}
                    inputMode="decimal"
                    placeholder={`CAD X${index + 1}`}
                    value={points[index].sourceX}
                    onChange={(event) =>
                      updatePoint(index, "sourceX", event.target.value)
                    }
                  />
                  <Input
                    aria-label={`CAD Y ${index + 1}`}
                    inputMode="decimal"
                    placeholder={`CAD Y${index + 1}`}
                    value={points[index].sourceY}
                    onChange={(event) =>
                      updatePoint(index, "sourceY", event.target.value)
                    }
                  />
                  <Input
                    aria-label={`GIS 경도 ${index + 1}`}
                    inputMode="decimal"
                    placeholder={`경도 ${index + 1}`}
                    value={points[index].targetLongitude}
                    onChange={(event) =>
                      updatePoint(index, "targetLongitude", event.target.value)
                    }
                  />
                  <Input
                    aria-label={`GIS 위도 ${index + 1}`}
                    inputMode="decimal"
                    placeholder={`위도 ${index + 1}`}
                    value={points[index].targetLatitude}
                    onChange={(event) =>
                      updatePoint(index, "targetLatitude", event.target.value)
                    }
                  />
                </div>
              ))}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {preview ? (
            <div
              className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4"
              data-testid="cad-alignment-preview"
            >
              <span>Feature {preview.summary.featureCount.toLocaleString()}</span>
              <span>축척 {preview.summary.scale.toFixed(6)}</span>
              <span>회전 {preview.summary.rotationDegrees.toFixed(4)}°</span>
              <span>RMS {preview.summary.rmsErrorMeters.toFixed(4)} m</span>
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            취소
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={loading || !inputPath}
            onClick={handlePreview}
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            미리보기
          </Button>
          <Button type="button" disabled={!preview || loading} onClick={applyPreview}>
            Layer 추가
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
