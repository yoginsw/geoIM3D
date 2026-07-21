import { isTauri } from "./is-tauri";

export type VWorldSearchType = "PLACE" | "ADDRESS" | "DISTRICT" | "ROAD";
export type VWorldAddressType = "ROAD" | "PARCEL";
export type VWorldReverseAddressType = VWorldAddressType | "BOTH";
export type VWorldLayer =
  | "Base"
  | "white"
  | "midnight"
  | "Hybrid"
  | "Satellite";
export type VWorldDataService =
  | "LP_PA_CBND_BUBUN"
  | "LT_C_UQ111"
  | "LT_C_UQ112"
  | "LT_C_UQ113"
  | "LT_C_UQ114";

export interface VWorldSearchRequest {
  query: string;
  type: VWorldSearchType;
  category?: string;
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

export interface VWorldFeatureRequest {
  service: VWorldDataService;
  size?: number;
  page?: number;
  pnu?: string;
  geometry?:
    | { type: "POINT"; coordinates: readonly [number, number] }
    | { type: "BOX"; bounds: readonly [number, number, number, number] };
}

export interface VWorldTileRequest {
  layer: VWorldLayer;
  z: number;
  x: number;
  y: number;
}

export interface VWorldResponse {
  status: "OK" | "NOT_FOUND" | "ERROR";
  record?: Record<string, number>;
  page?: Record<string, number>;
  result?: unknown;
}

export interface VWorldTileResponse {
  contentType: "image/png" | "image/jpeg";
  bytes: number[];
}

type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>;

const ERROR_CODES = new Set([
  "vworld_cancelled",
  "vworld_credential_unavailable",
  "vworld_duplicate_request_id",
  "vworld_http_error",
  "vworld_invalid_request",
  "vworld_invalid_request_id",
  "vworld_invalid_response",
  "vworld_invalid_tile",
  "vworld_missing_api_key",
  "vworld_network_error",
  "vworld_rate_limit",
  "vworld_timeout",
]);

let requestSequence = 0;

function nextRequestId(): string {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `vw-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function errorCode(error: unknown): string {
  const candidate =
    typeof error === "string"
      ? error
      : error instanceof Error
      ? error.message
      : "";
  return ERROR_CODES.has(candidate) ? candidate : "vworld_request_failed";
}

export interface VWorldDesktopClient {
  search(
    request: VWorldSearchRequest,
    signal?: AbortSignal
  ): Promise<VWorldResponse>;
  geocode(
    request: VWorldGeocodeRequest,
    signal?: AbortSignal
  ): Promise<VWorldResponse>;
  reverseGeocode(
    request: VWorldReverseGeocodeRequest,
    signal?: AbortSignal
  ): Promise<VWorldResponse>;
  getFeatures(
    request: VWorldFeatureRequest,
    signal?: AbortSignal
  ): Promise<VWorldResponse>;
  tile(
    request: VWorldTileRequest,
    signal?: AbortSignal
  ): Promise<VWorldTileResponse>;
}

export function createVWorldDesktopClient(options: {
  desktop: boolean;
  invoke: Invoke;
}): VWorldDesktopClient {
  const invokeRequest = async <T>(
    command: string,
    request: unknown,
    signal?: AbortSignal
  ): Promise<T> => {
    if (!options.desktop) throw new Error("vworld_desktop_only");
    if (signal?.aborted) throw new Error("vworld_cancelled");

    const requestId = nextRequestId();
    const cancel = () => {
      void options.invoke<void>("vworld_cancel", { requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await options.invoke<T>(command, { requestId, request });
    } catch (error) {
      throw new Error(errorCode(error));
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };

  return {
    search: (request, signal) =>
      invokeRequest("vworld_search", request, signal),
    geocode: (request, signal) =>
      invokeRequest("vworld_geocode", request, signal),
    reverseGeocode: (request, signal) =>
      invokeRequest("vworld_reverse_geocode", request, signal),
    getFeatures: (request, signal) =>
      invokeRequest("vworld_get_features", request, signal),
    tile: (request, signal) => invokeRequest("vworld_tile", request, signal),
  };
}

async function invokeTauri<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const vworldDesktopClient = createVWorldDesktopClient({
  desktop: isTauri(),
  invoke: invokeTauri,
});
