import {
  VWorldSearchSession,
  type VWorldAddressType,
  type VWorldReverseAddressType,
  type VWorldSearchCategory,
  type VWorldSearchSnapshot,
  type VWorldSearchType,
} from "./vworld-search";

export interface VWorldSearchMapLike {
  flyTo?(options: { center: readonly [number, number]; zoom?: number }): void;
  getCenter?(): { lng: number; lat: number };
  getZoom?(): number;
}

interface PanelOptions {
  session: VWorldSearchSession;
  getMaps: () => readonly VWorldSearchMapLike[];
}

type Mode = "search" | "geocode" | "reverse";

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

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = element("label");
  wrapper.style.cssText = "display:grid;gap:4px;font-size:12px;";
  const caption = element("span", label);
  caption.style.cssText = "font-weight:600;color:hsl(var(--foreground));";
  wrapper.append(caption, control);
  return wrapper;
}

function styleControl(control: HTMLElement): void {
  control.style.cssText =
    "box-sizing:border-box;width:100%;min-height:34px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));padding:6px 8px;";
}

function message(snapshot: VWorldSearchSnapshot): string {
  if (snapshot.status === "loading") return "VWorld 조회 중…";
  if (snapshot.status === "empty") return "조회 결과가 없습니다.";
  if (snapshot.status === "error") {
    const labels: Record<string, string> = {
      vworld_missing_api_key: "설정에서 VWorld API Key를 먼저 저장해 주세요.",
      vworld_rate_limit: "일일 주소 변환 요청 한도에 도달했습니다.",
      vworld_timeout: "VWorld 응답 시간이 초과되었습니다.",
      vworld_network_error: "VWorld 네트워크 요청에 실패했습니다.",
      vworld_invalid_request: "입력값을 확인해 주세요.",
    };
    return labels[snapshot.errorCode ?? ""] ?? "VWorld 요청을 완료하지 못했습니다.";
  }
  return snapshot.results.length > 0 ? `${snapshot.results.length}건` : "";
}

export function mountVWorldSearchPanel(
  container: HTMLElement,
  options: PanelOptions,
): () => void {
  const root = element("div");
  root.dataset.testid = "vworld-search-panel";
  root.style.cssText =
    "display:grid;grid-template-rows:auto auto 1fr;gap:10px;height:100%;padding:10px;overflow:hidden;";

  const mode = element("select");
  styleControl(mode);
  mode.append(
    option("search", "통합 검색"),
    option("geocode", "주소 → 좌표"),
    option("reverse", "좌표 → 주소"),
  );

  const form = element("form");
  form.style.cssText = "display:grid;gap:8px;";
  const fields = element("div");
  fields.style.cssText = "display:grid;gap:8px;";
  const submit = element("button", "조회");
  submit.type = "submit";
  submit.style.cssText =
    "min-height:34px;border:0;border-radius:6px;background:#0B365F;color:#fff;font-weight:700;cursor:pointer;";
  form.append(fields, submit);

  const output = element("div");
  output.style.cssText = "display:grid;grid-template-rows:auto 1fr;gap:6px;min-height:0;";
  const status = element("div");
  status.setAttribute("role", "status");
  status.style.cssText = "min-height:18px;font-size:12px;color:hsl(var(--muted-foreground));";
  const results = element("div");
  results.style.cssText = "display:grid;align-content:start;gap:6px;overflow:auto;min-height:0;";
  output.append(status, results);
  root.append(field("작업", mode), form, output);
  container.replaceChildren(root);

  let controls: Record<string, HTMLInputElement | HTMLSelectElement> = {};

  const renderFields = () => {
    fields.replaceChildren();
    controls = {};
    const selected = mode.value as Mode;
    if (selected === "search") {
      const query = element("input");
      query.name = "query";
      query.maxLength = 200;
      query.required = true;
      query.placeholder = "장소, 주소, 행정구역, 도로명";
      styleControl(query);
      const type = element("select");
      type.name = "type";
      type.append(
        option("PLACE", "장소"),
        option("ADDRESS", "주소"),
        option("DISTRICT", "행정구역"),
        option("ROAD", "도로명"),
      );
      styleControl(type);
      const category = element("select");
      category.name = "category";
      styleControl(category);
      const categoryField = field("세부 유형", category);
      const syncCategory = () => {
        category.replaceChildren();
        if (type.value === "ADDRESS") {
          category.append(option("ROAD", "도로명주소"), option("PARCEL", "지번주소"));
          categoryField.hidden = false;
          categoryField.style.display = "grid";
        } else if (type.value === "DISTRICT") {
          category.append(
            option("L1", "시·도"),
            option("L2", "시·군·구"),
            option("L3", "일반구"),
            option("L4", "읍·면·동"),
          );
          categoryField.hidden = false;
          categoryField.style.display = "grid";
        } else {
          categoryField.hidden = true;
          categoryField.style.display = "none";
        }
      };
      type.addEventListener("change", syncCategory);
      syncCategory();
      controls = { query, type, category };
      fields.append(field("검색어", query), field("검색 대상", type), categoryField);
    } else if (selected === "geocode") {
      const address = element("input");
      address.maxLength = 300;
      address.required = true;
      address.placeholder = "도로명 또는 지번주소";
      styleControl(address);
      const type = element("select");
      type.append(option("ROAD", "도로명주소"), option("PARCEL", "지번주소"));
      styleControl(type);
      controls = { address, type };
      fields.append(field("주소", address), field("주소 유형", type));
    } else {
      const longitude = element("input");
      longitude.type = "number";
      longitude.step = "any";
      longitude.required = true;
      longitude.placeholder = "경도 (x)";
      styleControl(longitude);
      const latitude = element("input");
      latitude.type = "number";
      latitude.step = "any";
      latitude.required = true;
      latitude.placeholder = "위도 (y)";
      styleControl(latitude);
      const type = element("select");
      type.append(
        option("BOTH", "도로명 + 지번"),
        option("ROAD", "도로명주소"),
        option("PARCEL", "지번주소"),
      );
      styleControl(type);
      const center = element("button", "현재 지도 중심 사용");
      center.type = "button";
      center.style.cssText =
        "min-height:30px;border:1px solid hsl(var(--border));border-radius:6px;background:hsl(var(--muted));cursor:pointer;";
      center.addEventListener("click", () => {
        const value = options.getMaps()[0]?.getCenter?.();
        if (!value) return;
        longitude.value = String(value.lng);
        latitude.value = String(value.lat);
      });
      controls = { longitude, latitude, type };
      fields.append(
        field("경도", longitude),
        field("위도", latitude),
        field("주소 유형", type),
        center,
      );
    }
  };

  const renderSnapshot = () => {
    const snapshot = options.session.getSnapshot();
    submit.disabled = snapshot.status === "loading";
    status.textContent = message(snapshot);
    results.replaceChildren();
    for (const result of snapshot.results) {
      const button = element("button");
      button.type = "button";
      button.style.cssText =
        "display:grid;gap:3px;text-align:left;border:1px solid hsl(var(--border));border-radius:6px;" +
        "background:hsl(var(--background));color:hsl(var(--foreground));padding:8px;cursor:pointer;";
      const title = element("strong", result.title);
      const subtitle = element("span", result.subtitle);
      subtitle.style.cssText = "font-size:11px;color:hsl(var(--muted-foreground));";
      button.append(title, subtitle);
      button.disabled = !result.point;
      button.addEventListener("click", () => {
        if (!result.point) return;
        for (const map of options.getMaps()) {
          map.flyTo?.({
            center: result.point,
            zoom: Math.max(map.getZoom?.() ?? 0, 15),
          });
        }
      });
      results.append(button);
    }
  };

  mode.addEventListener("change", renderFields);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = mode.value as Mode;
    let request: Promise<void>;
    if (selected === "search") {
      const type = (controls.type as HTMLSelectElement).value as VWorldSearchType;
      const category = controls.category as HTMLSelectElement;
      request = options.session.search({
        query: (controls.query as HTMLInputElement).value,
        type,
        category:
          type === "ADDRESS" || type === "DISTRICT"
            ? (category.value as VWorldSearchCategory)
            : undefined,
      });
    } else if (selected === "geocode") {
      request = options.session.geocode({
        address: (controls.address as HTMLInputElement).value,
        type: (controls.type as HTMLSelectElement).value as VWorldAddressType,
      });
    } else {
      request = options.session.reverseGeocode({
        point: [
          Number((controls.longitude as HTMLInputElement).value),
          Number((controls.latitude as HTMLInputElement).value),
        ],
        type: (controls.type as HTMLSelectElement).value as VWorldReverseAddressType,
      });
    }
    void request.catch(() => {
      status.textContent = "입력값을 확인해 주세요.";
    });
  });

  renderFields();
  renderSnapshot();
  const unsubscribe = options.session.subscribe(renderSnapshot);
  return () => {
    unsubscribe();
    options.session.cancel();
    container.replaceChildren();
  };
}
