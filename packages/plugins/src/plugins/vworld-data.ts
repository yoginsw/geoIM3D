export type VWorldDataService =
  | "LP_PA_CBND_BUBUN"
  | "LT_C_UQ111"
  | "LT_C_UQ112"
  | "LT_C_UQ113"
  | "LT_C_UQ114";

export type VWorldZoningService = Exclude<VWorldDataService, "LP_PA_CBND_BUBUN">;

export type VWorldGeometryFilter =
  | { type: "POINT"; coordinates: readonly [number, number] }
  | { type: "BOX"; bounds: readonly [number, number, number, number] };

export interface VWorldFeatureRequest {
  service: VWorldDataService;
  size?: number;
  page?: number;
  pnu?: string;
  geometry?: VWorldGeometryFilter;
}

export interface VWorldDataResponse {
  status: "OK" | "NOT_FOUND" | "ERROR";
  result?: unknown;
}

export interface VWorldDataClient {
  getFeatures(request: VWorldFeatureRequest, signal?: AbortSignal): Promise<VWorldDataResponse>;
}

export interface EphemeralGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown[];
}

export interface EphemeralFeature {
  type: "Feature";
  id?: string | number;
  geometry: EphemeralGeometry;
  properties: Record<string, string | number>;
}

export interface EphemeralFeatureCollection {
  type: "FeatureCollection";
  features: EphemeralFeature[];
}

export type VWorldDataStatus = "idle" | "loading" | "success" | "empty" | "error";

export interface VWorldDataSnapshot {
  cadastralStatus: VWorldDataStatus;
  cadastralErrorCode: string | null;
  cadastral: EphemeralFeatureCollection | null;
  zoningStatus: VWorldDataStatus;
  zoningErrorCode: string | null;
  zoning: EphemeralFeatureCollection | null;
  zoningService: VWorldZoningService | null;
}

const ZONING_SERVICES = new Set<VWorldZoningService>([
  "LT_C_UQ111",
  "LT_C_UQ112",
  "LT_C_UQ113",
  "LT_C_UQ114",
]);
const CADASTRAL_FIELDS = [
  "pnu",
  "jibun",
  "bonbun",
  "bubun",
  "addr",
  "gosi_year",
  "gosi_month",
  "jiga",
] as const;
const ZONING_FIELDS = ["uname", "sido_name", "sigg_name", "dyear", "dnum"] as const;
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
  "vworld_request_failed",
  "vworld_timeout",
]);
const EMPTY_COLLECTION: EphemeralFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPoint(point: readonly number[]): boolean {
  return (
    point.length >= 2 &&
    finite(point[0]) &&
    finite(point[1]) &&
    point[0] >= -180 &&
    point[0] <= 180 &&
    point[1] >= -90 &&
    point[1] <= 90
  );
}

function bboxAreaKm2(bounds: readonly [number, number, number, number]): number {
  const [minX, minY, maxX, maxY] = bounds;
  const midLatitude = (minY + maxY) / 2;
  return (
    Math.abs(maxX - minX) *
    111.32 *
    Math.abs(Math.cos((midLatitude * Math.PI) / 180)) *
    Math.abs(maxY - minY) *
    110.57
  );
}

function validGeometryFilter(filter: VWorldGeometryFilter): boolean {
  if (filter.type === "POINT") return validPoint(filter.coordinates);
  const [minX, minY, maxX, maxY] = filter.bounds;
  return (
    validPoint([minX, minY]) &&
    validPoint([maxX, maxY]) &&
    minX < maxX &&
    minY < maxY &&
    bboxAreaKm2(filter.bounds) <= 2
  );
}

function validPage(size: number | undefined, page: number | undefined): boolean {
  return (
    (size === undefined || (Number.isInteger(size) && size >= 1 && size <= 1000)) &&
    (page === undefined || (Number.isInteger(page) && page >= 1))
  );
}

function propertyValue(value: unknown): string | number | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized.slice(0, 500) : null;
  }
  return finite(value) ? value : null;
}

function properties(
  value: unknown,
  fields: readonly string[],
): Record<string, string | number> {
  const source = record(value);
  if (!source) return {};
  const output: Record<string, string | number> = {};
  for (const field of fields) {
    const normalized = propertyValue(source[field]);
    if (normalized !== null) output[field] = normalized;
  }
  return output;
}

function coordinates(value: unknown, budget: { points: number }): unknown[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.every(finite)) {
    if (!validPoint(value)) return null;
    budget.points += 1;
    if (budget.points > 20_000) return null;
    return [value[0], value[1]];
  }
  const output: unknown[] = [];
  for (const child of value) {
    const normalized = coordinates(child, budget);
    if (!normalized) return null;
    output.push(normalized);
  }
  return output;
}

function geometry(value: unknown): EphemeralGeometry | null {
  const source = record(value);
  if (!source || (source.type !== "Polygon" && source.type !== "MultiPolygon")) return null;
  const normalized = coordinates(source.coordinates, { points: 0 });
  if (!normalized) return null;
  return { type: source.type, coordinates: normalized };
}

function featureCollection(
  result: unknown,
  fields: readonly string[],
): EphemeralFeatureCollection {
  const root = record(result);
  const candidate = record(root?.featureCollection) ?? root;
  const rawFeatures = candidate?.features;
  if (!Array.isArray(rawFeatures)) return EMPTY_COLLECTION;
  const features: EphemeralFeature[] = [];
  for (const value of rawFeatures.slice(0, 1000)) {
    const source = record(value);
    if (!source) continue;
    const normalizedGeometry = geometry(source.geometry);
    if (!normalizedGeometry) continue;
    const id =
      typeof source.id === "string" || typeof source.id === "number"
        ? source.id
        : undefined;
    features.push({
      type: "Feature",
      ...(id !== undefined ? { id } : {}),
      geometry: normalizedGeometry,
      properties: properties(source.properties, fields),
    });
  }
  return { type: "FeatureCollection", features };
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

type VWorldDataKind = "cadastral" | "zoning";

export class VWorldDataSession {
  private snapshot: VWorldDataSnapshot = {
    cadastralStatus: "idle",
    cadastralErrorCode: null,
    cadastral: null,
    zoningStatus: "idle",
    zoningErrorCode: null,
    zoning: null,
    zoningService: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly activeRequests: Record<VWorldDataKind, AbortController | null> = {
    cadastral: null,
    zoning: null,
  };
  private readonly generations: Record<VWorldDataKind, number> = {
    cadastral: 0,
    zoning: 0,
  };

  constructor(private readonly client: VWorldDataClient) {}

  getSnapshot = (): VWorldDataSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(snapshot: VWorldDataSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private withStatus(
    snapshot: VWorldDataSnapshot,
    kind: VWorldDataKind,
    status: VWorldDataStatus,
    error: string | null,
  ): VWorldDataSnapshot {
    return kind === "cadastral"
      ? { ...snapshot, cadastralStatus: status, cadastralErrorCode: error }
      : { ...snapshot, zoningStatus: status, zoningErrorCode: error };
  }

  private cancelKind(kind: VWorldDataKind): void {
    this.generations[kind] += 1;
    this.activeRequests[kind]?.abort();
    this.activeRequests[kind] = null;
  }

  private async run(
    kind: VWorldDataKind,
    request: VWorldFeatureRequest,
    apply: (collection: EphemeralFeatureCollection) => VWorldDataSnapshot,
  ): Promise<void> {
    this.cancelKind(kind);
    const controller = new AbortController();
    this.activeRequests[kind] = controller;
    const generation = ++this.generations[kind];
    this.update(this.withStatus(this.snapshot, kind, "loading", null));
    try {
      const response = await this.client.getFeatures(request, controller.signal);
      if (generation !== this.generations[kind] || controller.signal.aborted) return;
      if (response.status === "ERROR") {
        this.update(
          this.withStatus(this.snapshot, kind, "error", "vworld_request_failed"),
        );
        return;
      }
      const fields =
        request.service === "LP_PA_CBND_BUBUN" ? CADASTRAL_FIELDS : ZONING_FIELDS;
      const collection =
        response.status === "OK"
          ? featureCollection(response.result, fields)
          : EMPTY_COLLECTION;
      this.update(
        this.withStatus(
          apply(collection),
          kind,
          collection.features.length > 0 ? "success" : "empty",
          null,
        ),
      );
    } catch (error) {
      if (generation !== this.generations[kind] || controller.signal.aborted) return;
      this.update(this.withStatus(this.snapshot, kind, "error", errorCode(error)));
    } finally {
      if (generation === this.generations[kind]) this.activeRequests[kind] = null;
    }
  }

  async queryParcel(request: { pnu: string; size?: number; page?: number }): Promise<void> {
    const pnu = request.pnu.trim();
    if (!/^\d{19}$/.test(pnu) || !validPage(request.size, request.page)) {
      throw new Error("vworld_invalid_request");
    }
    await this.run(
      "cadastral",
      {
        service: "LP_PA_CBND_BUBUN",
        pnu,
        size: request.size ?? 10,
        page: request.page ?? 1,
      },
      (collection) => ({ ...this.snapshot, cadastral: collection }),
    );
  }

  async queryZoning(request: {
    service: VWorldZoningService;
    geometry: VWorldGeometryFilter;
    size?: number;
    page?: number;
  }): Promise<void> {
    if (
      !ZONING_SERVICES.has(request.service) ||
      !validGeometryFilter(request.geometry) ||
      !validPage(request.size, request.page)
    ) {
      throw new Error("vworld_invalid_request");
    }
    await this.run(
      "zoning",
      {
        service: request.service,
        geometry: request.geometry,
        size: request.size ?? 100,
        page: request.page ?? 1,
      },
      (collection) => ({
        ...this.snapshot,
        zoning: collection,
        zoningService: request.service,
      }),
    );
  }

  clearCadastral(): void {
    this.cancelKind("cadastral");
    this.update({
      ...this.snapshot,
      cadastralStatus: "idle",
      cadastralErrorCode: null,
      cadastral: null,
    });
  }

  clearZoning(): void {
    this.cancelKind("zoning");
    this.update({
      ...this.snapshot,
      zoningStatus: "idle",
      zoningErrorCode: null,
      zoning: null,
      zoningService: null,
    });
  }

  cancel(): void {
    const cadastralLoading = this.snapshot.cadastralStatus === "loading";
    const zoningLoading = this.snapshot.zoningStatus === "loading";
    this.cancelKind("cadastral");
    this.cancelKind("zoning");
    if (cadastralLoading || zoningLoading) {
      this.update({
        ...this.snapshot,
        ...(cadastralLoading
          ? { cadastralStatus: "idle" as const, cadastralErrorCode: null }
          : {}),
        ...(zoningLoading
          ? { zoningStatus: "idle" as const, zoningErrorCode: null }
          : {}),
      });
    }
  }

  clear(): void {
    this.cancelKind("cadastral");
    this.cancelKind("zoning");
    this.update({
      cadastralStatus: "idle",
      cadastralErrorCode: null,
      cadastral: null,
      zoningStatus: "idle",
      zoningErrorCode: null,
      zoning: null,
      zoningService: null,
    });
  }
}
