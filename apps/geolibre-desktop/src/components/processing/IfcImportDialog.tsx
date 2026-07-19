import { useAppStore } from "@geolibre/core";
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
import { readFile } from "@tauri-apps/plugin-fs";
import { FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IFC_MAX_INPUT_BYTES,
  IFC_MAX_PROJECT_GLB_BYTES,
  buildIfcModelLayer,
  parseIfcPlacement,
  validateGlb,
  type IfcImportSummary,
  type IfcPlacementDraft,
} from "../../lib/ifc-model";
import { isTauri, pickLocalPathWithFallback } from "../../lib/tauri-io";

interface IfcImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

interface IfcPreview {
  glb: Uint8Array;
  radiusMeters: number;
  summary: IfcImportSummary;
}

interface WorkerSuccess {
  type: "success";
  glb: ArrayBuffer;
  radiusMeters: number;
  summary: IfcImportSummary;
}

interface WorkerFailure {
  type: "error";
  code: string;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

const IFC_WORKER_TIMEOUT_MS = 120_000;

const DEFAULT_PLACEMENT: IfcPlacementDraft = {
  longitude: "127.0276",
  latitude: "37.4979",
  altitude: "0",
  bearing: "0",
  scale: "1",
};


function workerErrorMessage(code: string): string {
  if (code === "IFC_GEOMETRY_EMPTY") return "표시할 IFC 형상이 없습니다.";
  if (code === "IFC_MESH_LIMIT" || code === "IFC_TRIANGLE_LIMIT") {
    return "IFC 형상이 MVP 처리 한도를 초과했습니다.";
  }
  if (code === "IFC_ELEMENT_LIMIT" || code === "IFC_GEOMETRY_LIMIT") {
    return "IFC 형상이 MVP 메모리 한도를 초과했습니다.";
  }
  if (code === "IFC_CONVERSION_TIMEOUT") {
    return "IFC 변환이 120초 제한을 초과해 중단되었습니다.";
  }
  if (code === "IFC_GLB_TOO_LARGE") {
    return "변환된 GLB가 16 MiB 저장 한도를 초과했습니다.";
  }
  return "IFC 형상을 변환하지 못했습니다. 파일 형식과 손상 여부를 확인하세요.";
}

export function IfcImportDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: IfcImportDialogProps) {
  const addLayer = useAppStore((state) => state.addLayer);
  const [inputPath, setInputPath] = useState("");
  const [placement, setPlacement] =
    useState<IfcPlacementDraft>(DEFAULT_PLACEMENT);
  const [preview, setPreview] = useState<IfcPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const workerRef = useRef<Worker | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const terminateWorker = useCallback(() => {
    generationRef.current += 1;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => () => terminateWorker(), [terminateWorker]);

  const chooseFile = useCallback(async () => {
    const selected = await pickLocalPathWithFallback({
      filters: [{ name: "IFC", extensions: ["ifc"] }],
    });
    if (!selected) return;
    if (!selected.toLowerCase().endsWith(".ifc")) {
      setError("IFC 파일을 선택하세요.");
      return;
    }
    terminateWorker();
    setInputPath(selected);
    setPreview(null);
    setError("");
    setLoading(false);
  }, [terminateWorker]);

  const updatePlacement = useCallback(
    (key: keyof IfcPlacementDraft, value: string) => {
      setPlacement((current) => ({ ...current, [key]: value }));
      setPreview(null);
      setError("");
    },
    [],
  );

  const convert = useCallback(async () => {
    if (!isTauri()) {
      setError("BIM/IFC 가져오기는 Windows Desktop에서만 사용할 수 있습니다.");
      return;
    }
    if (!/\.ifc$/i.test(inputPath)) {
      setError("IFC 파일을 선택하세요.");
      return;
    }
    try {
      parseIfcPlacement(placement);
    } catch {
      setError("유효한 WGS84 위치와 0보다 큰 축척을 입력하세요.");
      return;
    }

    terminateWorker();
    const generation = generationRef.current;
    setLoading(true);
    setPreview(null);
    setError("");
    try {
      const fileBytes = await readFile(inputPath);
      if (generationRef.current !== generation) return;
      if (fileBytes.byteLength === 0) {
        throw new Error("IFC_INPUT_EMPTY");
      }
      if (fileBytes.byteLength > IFC_MAX_INPUT_BYTES) {
        throw new Error("IFC_INPUT_TOO_LARGE");
      }
      const bytes = fileBytes.slice().buffer;
      const worker = new Worker(
        new URL("../../lib/ifc-conversion.worker.ts", import.meta.url),
        { type: "module", name: "geoim3d-ifc-conversion" },
      );
      workerRef.current = worker;
      const result = await new Promise<WorkerSuccess>((resolve, reject) => {
        timeoutRef.current = window.setTimeout(
          () => {
            timeoutRef.current = null;
            reject(new Error("IFC_CONVERSION_TIMEOUT"));
          },
          IFC_WORKER_TIMEOUT_MS,
        );
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
          if (event.data.type === "success") resolve(event.data);
          else reject(new Error(event.data.code));
        };
        worker.onerror = () => {
          if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
          reject(new Error("IFC_CONVERSION_FAILED"));
        };
        worker.postMessage({ type: "convert", bytes }, [bytes]);
      });
      if (generationRef.current !== generation) return;
      const glb = new Uint8Array(result.glb);
      validateGlb(glb);
      setPreview({
        glb,
        radiusMeters: result.radiusMeters,
        summary: result.summary,
      });
    } catch (conversionError) {
      if (generationRef.current !== generation) return;
      const code =
        conversionError instanceof Error
          ? conversionError.message
          : "IFC_CONVERSION_FAILED";
      if (code === "IFC_INPUT_EMPTY") setError("빈 IFC 파일은 가져올 수 없습니다.");
      else if (code === "IFC_INPUT_TOO_LARGE") {
        setError("IFC 파일은 최대 32 MiB까지 가져올 수 있습니다.");
      } else setError(workerErrorMessage(code));
    } finally {
      if (generationRef.current === generation) {
        workerRef.current?.terminate();
        workerRef.current = null;
        setLoading(false);
      }
    }
  }, [inputPath, placement, terminateWorker]);

  const addPreview = useCallback(() => {
    if (!preview) return;
    const currentIfcBytes = useAppStore
      .getState()
      .layers.reduce((total, layer) => {
        const summary = layer.metadata.ifcImport as
          | { glbBytes?: unknown }
          | undefined;
        return total +
          (typeof summary?.glbBytes === "number" ? summary.glbBytes : 0);
      }, 0);
    if (currentIfcBytes + preview.glb.byteLength > IFC_MAX_PROJECT_GLB_BYTES) {
      setError("Project의 IFC GLB 합계는 최대 64 MiB까지 저장할 수 있습니다.");
      return;
    }
    let parsedPlacement;
    try {
      parsedPlacement = parseIfcPlacement(placement);
    } catch {
      setError("유효한 WGS84 위치와 0보다 큰 축척을 입력하세요.");
      return;
    }
    const layer = buildIfcModelLayer({
      glb: preview.glb,
      placement: parsedPlacement,
      radiusMeters: preview.radiusMeters,
      summary: preview.summary,
    });
    addLayer(layer);
    mapControllerRef.current?.fitLayer(layer);
    onOpenChange(false);
  }, [addLayer, mapControllerRef, onOpenChange, placement, preview]);

  const close = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        terminateWorker();
        setLoading(false);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, terminateWorker],
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl" data-testid="ifc-import-dialog">
        <DialogHeader>
          <DialogTitle>BIM/IFC 가져오기</DialogTitle>
          <DialogDescription>
            IFC 형상, 배치 위치, Schema와 형상 수 집계는 Project에 저장되며 Project 파일 공유 시 함께 전달됩니다. 원본 경로·GUID·BIM 속성은 저장하지 않습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ifc-path">IFC 파일</Label>
            <div className="flex gap-2">
              <Input id="ifc-path" value={inputPath} readOnly placeholder=".ifc 파일 선택" />
              <Button type="button" variant="outline" onClick={chooseFile} disabled={loading}>
                <FolderOpen className="mr-2 h-4 w-4" />선택
              </Button>
            </div>
          </div>


          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {([
              ["longitude", "경도"],
              ["latitude", "위도"],
              ["altitude", "고도(m)"],
              ["bearing", "방위각(°)"],
              ["scale", "축척"],
            ] as const).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`ifc-${key}`}>{label}</Label>
                <Input
                  id={`ifc-${key}`}
                  inputMode="decimal"
                  value={placement[key]}
                  onChange={(event) => updatePlacement(key, event.target.value)}
                />
              </div>
            ))}
          </div>

          {preview && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="ifc-summary">
              <div>Schema: {preview.summary.schema}</div>
              <div>Elements: {preview.summary.elementCount.toLocaleString()}</div>
              <div>Meshes: {preview.summary.meshCount.toLocaleString()}</div>
              <div>Triangles: {preview.summary.triangleCount.toLocaleString()}</div>
              <div>GLB: {preview.summary.glbBytes.toLocaleString()} bytes</div>
            </div>
          )}

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              취소
            </Button>
            <Button type="button" variant="outline" onClick={convert} disabled={loading || !inputPath}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              변환
            </Button>
            <Button type="button" onClick={addPreview} disabled={!preview || loading}>
              Layer 추가
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
