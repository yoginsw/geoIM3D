export type VWorldSearchType = "PLACE" | "ADDRESS" | "DISTRICT" | "ROAD";
export type VWorldSearchCategory = "ROAD" | "PARCEL" | "L1" | "L2" | "L3" | "L4";
export type VWorldAddressType = "ROAD" | "PARCEL";
export type VWorldReverseAddressType = VWorldAddressType | "BOTH";

export interface VWorldSearchRequest {
  query: string;
  type: VWorldSearchType;
  category?: VWorldSearchCategory;
  size?: number;
  page?: number;
  bbox?: readonly [number, number, number, number];
}

export interface VWorldGeocodeRequest {
  address: string;
  type: VWorldAddressType;
  refine?: boolean;
  simple?: boolean;
}

export interface VWorldReverseGeocodeRequest {
  point: readonly [number, number];
  type?: VWorldReverseAddressType;
  zipcode?: boolean;
  simple?: boolean;
}

export interface VWorldResponse {
  status: "OK" | "NOT_FOUND" | "ERROR";
  record?: Record<string, number>;
  page?: Record<string, number>;
  result?: unknown;
}

export interface VWorldSearchClient {
  search(request: VWorldSearchRequest, signal?: AbortSignal): Promise<VWorldResponse>;
  geocode(request: VWorldGeocodeRequest, signal?: AbortSignal): Promise<VWorldResponse>;
  reverseGeocode(
    request: VWorldReverseGeocodeRequest,
    signal?: AbortSignal,
  ): Promise<VWorldResponse>;
}

export interface VWorldSessionResult {
  id: string;
  kind: "search" | "geocode" | "reverse";
  title: string;
  subtitle: string;
  point?: readonly [number, number];
}

export interface VWorldSearchSnapshot {
  status: "idle" | "loading" | "success" | "empty" | "error";
  results: VWorldSessionResult[];
  errorCode: string | null;
}

const KNOWN_ERRORS = new Set([
  "vworld_cancelled",
  "vworld_credential_unavailable",
  "vworld_duplicate_request_id",
  "vworld_http_error",
  "vworld_invalid_request",
  "vworld_invalid_request_id",
  "vworld_invalid_response",
  "vworld_missing_api_key",
  "vworld_network_error",
  "vworld_rate_limit",
  "vworld_request_failed",
  "vworld_timeout",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coordinate(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function point(value: unknown): readonly [number, number] | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const x = coordinate(candidate.x);
  const y = coordinate(candidate.y);
  if (x === null || y === null || x < -180 || x > 180 || y < -90 || y > 90) {
    return undefined;
  }
  return [x, y];
}

function addressText(value: unknown): string {
  if (typeof value === "string") return text(value);
  const candidate = record(value);
  if (!candidate) return "";
  return (
    text(candidate.road) ||
    text(candidate.parcel) ||
    text(candidate.text)
  );
}

function searchResults(result: unknown): VWorldSessionResult[] {
  const items = record(result)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((value, index) => {
    const item = record(value);
    if (!item) return [];
    const title = text(item.title);
    const itemPoint = point(item.point);
    if (!title || !itemPoint) return [];
    return [
      {
        id: text(item.id) || `search-${index}`,
        kind: "search" as const,
        title,
        subtitle: addressText(item.address) || text(item.category),
        point: itemPoint,
      },
    ];
  });
}

function geocodeResults(result: unknown): VWorldSessionResult[] {
  const candidate = record(result);
  if (!candidate) return [];
  const resultPoint = point(candidate.point);
  if (!resultPoint) return [];
  const refined = record(candidate.refined);
  return [
    {
      id: "geocode-0",
      kind: "geocode",
      title: text(refined?.text) || "주소 좌표",
      subtitle: `${resultPoint[0]}, ${resultPoint[1]}`,
      point: resultPoint,
    },
  ];
}

function reverseResults(
  result: unknown,
  sourcePoint: readonly [number, number],
): VWorldSessionResult[] {
  const rawItems = record(result)?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  return items.flatMap((value, index) => {
    const item = record(value);
    if (!item) return [];
    const title = text(item.text);
    if (!title) return [];
    const itemType = text(item.type);
    const zipcode = text(item.zipcode);
    return [
      {
        id: `reverse-${index}`,
        kind: "reverse" as const,
        title,
        subtitle: [itemType, zipcode].filter(Boolean).join(" · "),
        point: sourcePoint,
      },
    ];
  });
}

function errorCode(error: unknown): string {
  const candidate =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return KNOWN_ERRORS.has(candidate) ? candidate : "vworld_request_failed";
}

function validSearch(request: VWorldSearchRequest): boolean {
  const query = request.query.trim();
  if (!query || [...query].length > 200) return false;
  if (!(["PLACE", "ADDRESS", "DISTRICT", "ROAD"] as const).includes(request.type)) {
    return false;
  }
  if (request.type === "ADDRESS") {
    if (request.category !== "ROAD" && request.category !== "PARCEL") return false;
  } else if (request.type === "DISTRICT") {
    if (!(["L1", "L2", "L3", "L4"] as const).includes(request.category as never)) {
      return false;
    }
  } else if (request.category !== undefined) {
    return false;
  }
  if (request.size !== undefined && (!Number.isInteger(request.size) || request.size < 1 || request.size > 1000)) {
    return false;
  }
  if (request.page !== undefined && (!Number.isInteger(request.page) || request.page < 1)) {
    return false;
  }
  if (request.bbox) {
    const [minX, minY, maxX, maxY] = request.bbox;
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX >= maxX || minY >= maxY) {
      return false;
    }
  }
  return true;
}

function validGeocode(request: VWorldGeocodeRequest): boolean {
  const address = request.address.trim();
  return (
    Boolean(address) &&
    [...address].length <= 300 &&
    (request.type === "ROAD" || request.type === "PARCEL")
  );
}

function validReverse(request: VWorldReverseGeocodeRequest): boolean {
  const [x, y] = request.point;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= -180 &&
    x <= 180 &&
    y >= -90 &&
    y <= 90 &&
    (request.type === undefined ||
      request.type === "ROAD" ||
      request.type === "PARCEL" ||
      request.type === "BOTH")
  );
}

export class VWorldSearchSession {
  private snapshot: VWorldSearchSnapshot = {
    status: "idle",
    results: [],
    errorCode: null,
  };
  private readonly listeners = new Set<() => void>();
  private activeRequest: AbortController | null = null;
  private generation = 0;

  constructor(private readonly client: VWorldSearchClient) {}

  getSnapshot = (): VWorldSearchSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(snapshot: VWorldSearchSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private async run(
    operation: (signal: AbortSignal) => Promise<VWorldResponse>,
    mapResults: (result: unknown) => VWorldSessionResult[],
  ): Promise<void> {
    this.activeRequest?.abort();
    const controller = new AbortController();
    this.activeRequest = controller;
    const generation = ++this.generation;
    this.update({ status: "loading", results: [], errorCode: null });
    try {
      const response = await operation(controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      const results = response.status === "OK" ? mapResults(response.result) : [];
      this.update({
        status: results.length > 0 ? "success" : response.status === "ERROR" ? "error" : "empty",
        results,
        errorCode: response.status === "ERROR" ? "vworld_request_failed" : null,
      });
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.update({ status: "error", results: [], errorCode: errorCode(error) });
    } finally {
      if (generation === this.generation) this.activeRequest = null;
    }
  }

  async search(request: VWorldSearchRequest): Promise<void> {
    if (!validSearch(request)) throw new Error("vworld_invalid_request");
    const normalized = { ...request, query: request.query.trim() };
    await this.run(
      (signal) => this.client.search(normalized, signal),
      searchResults,
    );
  }

  async geocode(request: VWorldGeocodeRequest): Promise<void> {
    if (!validGeocode(request)) throw new Error("vworld_invalid_request");
    const normalized = { ...request, address: request.address.trim() };
    await this.run(
      (signal) => this.client.geocode(normalized, signal),
      geocodeResults,
    );
  }

  async reverseGeocode(request: VWorldReverseGeocodeRequest): Promise<void> {
    if (!validReverse(request)) throw new Error("vworld_invalid_request");
    await this.run(
      (signal) => this.client.reverseGeocode(request, signal),
      (result) => reverseResults(result, request.point),
    );
  }

  cancel(): void {
    this.generation += 1;
    this.activeRequest?.abort();
    this.activeRequest = null;
    if (this.snapshot.status === "loading") {
      this.update({ ...this.snapshot, status: "idle", errorCode: null });
    }
  }

  clear(): void {
    this.generation += 1;
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.update({ status: "idle", results: [], errorCode: null });
  }
}
