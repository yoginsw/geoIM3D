import type { VWorldDataMapLike } from "./vworld-data-layer";
import {
  VWorldDataSession,
  type EphemeralFeature,
  type VWorldDataSnapshot,
  type VWorldZoningService,
} from "./vworld-data";

interface BoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

export interface VWorldDataInteractiveMapLike extends VWorldDataMapLike {
  getCenter?(): { lng: number; lat: number };
  getBounds?(): BoundsLike;
  fitBounds?(
    bounds: readonly [readonly [number, number], readonly [number, number]],
    options?: { padding?: number; maxZoom?: number },
  ): void;
}

interface PanelOptions {
  session: VWorldDataSession;
  getMaps: () => readonly VWorldDataInteractiveMapLike[];
}

export type VWorldDataPanelMode = "cadastral" | "zoning";
type SpatialMode = "center" | "extent";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = element("option", label);
  node.value = value;
  return node;
}

function styleControl(control: HTMLElement): void {
  control.style.cssText =
    "box-sizing:border-box;width:100%;min-height:34px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));padding:6px 8px;";
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = element("label");
  wrapper.style.cssText = "display:grid;gap:4px;font-size:12px;";
  const caption = element("span", label);
  caption.style.cssText = "font-weight:600;color:hsl(var(--foreground));";
  wrapper.append(caption, control);
  return wrapper;
}

function selectedState(
  snapshot: VWorldDataSnapshot,
  mode: VWorldDataPanelMode,
): { status: VWorldDataSnapshot["cadastralStatus"]; errorCode: string | null } {
  return mode === "cadastral"
    ? { status: snapshot.cadastralStatus, errorCode: snapshot.cadastralErrorCode }
    : { status: snapshot.zoningStatus, errorCode: snapshot.zoningErrorCode };
}

function message(snapshot: VWorldDataSnapshot, mode: VWorldDataPanelMode): string {
  const selected = selectedState(snapshot, mode);
  if (selected.status === "loading") return "VWorld 공간정보 조회 중…";
  if (selected.status === "empty") return "조회 결과가 없습니다.";
  if (selected.status === "error") {
    const labels: Record<string, string> = {
      vworld_missing_api_key: "설정에서 VWorld API Key를 먼저 저장해 주세요.",
      vworld_timeout: "VWorld 응답 시간이 초과되었습니다.",
      vworld_network_error: "VWorld 네트워크 요청에 실패했습니다.",
      vworld_invalid_request: "입력값 또는 조회 범위를 확인해 주세요.",
    };
    return labels[selected.errorCode ?? ""] ?? "VWorld 공간정보 요청을 완료하지 못했습니다.";
  }
  return "";
}

export function vworldDataPanelStatus(
  snapshot: VWorldDataSnapshot,
  mode: VWorldDataPanelMode,
): string {
  if (selectedState(snapshot, mode).status === "success") {
    const collection =
      mode === "cadastral" ? snapshot.cadastral : snapshot.zoning;
    if (collection) {
      return `${collection.features.length}건 · 현재 Session에만 표시`;
    }
  }
  return message(snapshot, mode);
}

function value(properties: Record<string, string | number>, key: string): string {
  const candidate = properties[key];
  return candidate === undefined ? "" : String(candidate);
}

function featureLabel(feature: EphemeralFeature, mode: VWorldDataPanelMode): [string, string] {
  if (mode === "cadastral") {
    return [
      value(feature.properties, "addr") || value(feature.properties, "jibun") || "필지",
      [value(feature.properties, "pnu"), value(feature.properties, "jiga")]
        .filter(Boolean)
        .join(" · "),
    ];
  }
  return [
    value(feature.properties, "uname") || "용도지역",
    [
      value(feature.properties, "sido_name"),
      value(feature.properties, "sigg_name"),
      value(feature.properties, "dyear"),
      value(feature.properties, "dnum"),
    ]
      .filter(Boolean)
      .join(" · "),
  ];
}

function geometryBounds(
  feature: EphemeralFeature,
): readonly [readonly [number, number], readonly [number, number]] | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const visit = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    if (
      candidate.length >= 2 &&
      typeof candidate[0] === "number" &&
      typeof candidate[1] === "number"
    ) {
      minX = Math.min(minX, candidate[0]);
      minY = Math.min(minY, candidate[1]);
      maxX = Math.max(maxX, candidate[0]);
      maxY = Math.max(maxY, candidate[1]);
      return;
    }
    for (const child of candidate) visit(child);
  };
  visit(feature.geometry.coordinates);
  return [minX, minY, maxX, maxY].every(Number.isFinite)
    ? [[minX, minY], [maxX, maxY]]
    : null;
}

export function mountVWorldDataPanel(
  container: HTMLElement,
  options: PanelOptions,
): () => void {
  const root = element("div");
  root.dataset.testid = "vworld-data-panel";
  root.style.cssText =
    "display:grid;grid-template-rows:auto auto 1fr;gap:10px;height:100%;padding:10px;overflow:hidden;";

  const mode = element("select");
  styleControl(mode);
  mode.append(option("cadastral", "연속지적도"), option("zoning", "용도지역"));

  const form = element("form");
  form.style.cssText = "display:grid;gap:8px;";
  const fields = element("div");
  fields.style.cssText = "display:grid;gap:8px;";
  const buttons = element("div");
  buttons.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:6px;";
  const submit = element("button", "현재 지도에서 조회");
  submit.type = "submit";
  submit.style.cssText =
    "min-height:34px;border:0;border-radius:6px;background:#0B365F;color:#fff;font-weight:700;cursor:pointer;";
  const clear = element("button", "제거");
  clear.type = "button";
  clear.style.cssText =
    "min-height:34px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--muted));padding:0 12px;cursor:pointer;";
  buttons.append(submit, clear);
  form.append(fields, buttons);

  const output = element("div");
  output.style.cssText = "display:grid;grid-template-rows:auto 1fr;gap:6px;min-height:0;";
  const status = element("div");
  status.setAttribute("role", "status");
  status.style.cssText = "min-height:18px;font-size:12px;color:hsl(var(--muted-foreground));";
  const results = element("div");
  results.style.cssText = "display:grid;align-content:start;gap:6px;overflow:auto;min-height:0;";
  output.append(status, results);
  root.append(field("데이터", mode), form, output);
  container.replaceChildren(root);

  let controls: Record<string, HTMLInputElement | HTMLSelectElement> = {};

  const renderFields = () => {
    fields.replaceChildren();
    controls = {};
    if (mode.value === "cadastral") {
      const pnu = element("input");
      pnu.required = true;
      pnu.inputMode = "numeric";
      pnu.minLength = 19;
      pnu.maxLength = 19;
      pnu.pattern = "[0-9]{19}";
      pnu.placeholder = "19자리 PNU";
      styleControl(pnu);
      controls = { pnu };
      fields.append(field("필지고유번호(PNU)", pnu));
      submit.textContent = "필지 조회";
    } else {
      const service = element("select");
      service.append(
        option("LT_C_UQ111", "도시지역"),
        option("LT_C_UQ112", "관리지역"),
        option("LT_C_UQ113", "농림지역"),
        option("LT_C_UQ114", "자연환경보전지역"),
      );
      styleControl(service);
      const spatial = element("select");
      spatial.append(
        option("center", "현재 지도 중심점"),
        option("extent", "현재 화면 범위 (최대 2㎢)"),
      );
      styleControl(spatial);
      const size = element("input");
      size.type = "number";
      size.min = "1";
      size.max = "1000";
      size.value = "100";
      size.required = true;
      styleControl(size);
      controls = { service, spatial, size };
      fields.append(
        field("용도지역", service),
        field("공간 조건", spatial),
        field("최대 결과 수", size),
      );
      submit.textContent = "현재 지도에서 조회";
    }
    renderSnapshot();
  };

  const renderSnapshot = () => {
    const snapshot = options.session.getSnapshot();
    const selected = mode.value as VWorldDataPanelMode;
    submit.disabled = selectedState(snapshot, selected).status === "loading";
    status.textContent = vworldDataPanelStatus(snapshot, selected);
    const collection =
      selected === "cadastral" ? snapshot.cadastral : snapshot.zoning;
    results.replaceChildren();
    for (const feature of collection?.features ?? []) {
      const [titleText, subtitleText] = featureLabel(feature, selected);
      const button = element("button");
      button.type = "button";
      button.style.cssText =
        "display:grid;gap:3px;text-align:left;border:1px solid hsl(var(--border));border-radius:6px;" +
        "background:hsl(var(--background));color:hsl(var(--foreground));padding:8px;cursor:pointer;";
      const title = element("strong", titleText);
      const subtitle = element("span", subtitleText);
      subtitle.style.cssText = "font-size:11px;color:hsl(var(--muted-foreground));";
      button.append(title, subtitle);
      button.addEventListener("click", () => {
        const bounds = geometryBounds(feature);
        if (!bounds) return;
        for (const map of options.getMaps()) {
          map.fitBounds?.(bounds, { padding: 48, maxZoom: 17 });
        }
      });
      results.append(button);
    }
  };

  mode.addEventListener("change", renderFields);
  clear.addEventListener("click", () => {
    if (mode.value === "cadastral") options.session.clearCadastral();
    else options.session.clearZoning();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let request: Promise<void>;
    if (mode.value === "cadastral") {
      request = options.session.queryParcel({
        pnu: (controls.pnu as HTMLInputElement).value,
      });
    } else {
      const map = options.getMaps()[0];
      if (!map) {
        status.textContent = "활성 MapLibre 지도가 없습니다.";
        return;
      }
      const spatial = (controls.spatial as HTMLSelectElement).value as SpatialMode;
      if (spatial === "center") {
        const center = map.getCenter?.();
        if (!center) {
          status.textContent = "지도 중심 좌표를 읽을 수 없습니다.";
          return;
        }
        request = options.session.queryZoning({
          service: (controls.service as HTMLSelectElement).value as VWorldZoningService,
          geometry: { type: "POINT", coordinates: [center.lng, center.lat] },
          size: Number((controls.size as HTMLInputElement).value),
        });
      } else {
        const bounds = map.getBounds?.();
        if (!bounds) {
          status.textContent = "지도 화면 범위를 읽을 수 없습니다.";
          return;
        }
        request = options.session.queryZoning({
          service: (controls.service as HTMLSelectElement).value as VWorldZoningService,
          geometry: {
            type: "BOX",
            bounds: [
              bounds.getWest(),
              bounds.getSouth(),
              bounds.getEast(),
              bounds.getNorth(),
            ],
          },
          size: Number((controls.size as HTMLInputElement).value),
        });
      }
    }
    void request.catch(() => {
      status.textContent = "PNU, 결과 수 또는 조회 범위(최대 2㎢)를 확인해 주세요.";
    });
  });

  renderFields();
  const unsubscribe = options.session.subscribe(renderSnapshot);
  return () => {
    unsubscribe();
    options.session.cancel();
    container.replaceChildren();
  };
}
