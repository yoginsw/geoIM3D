import {
  CREDENTIAL_ENV_NAMES,
  isCredentialEnvironmentName,
} from "@geolibre/core";

export const CREDENTIAL_IDS = [
  "share:token",
  "cesium:ion-token",
  "vworld:api-key",
  "geocoder:nominatim:api-key",
  "geocoder:pelias:api-key",
  "geocoder:arcgis:api-key",
  "geocoder:mapbox:api-key",
  "geocoder:google:api-key",
  "ai:GEMINI_API_KEY",
  "ai:ANTHROPIC_API_KEY",
  "ai:OPENAI_API_KEY",
  "ai:TAVILY_API_KEY",
  "ai:OLLAMA_BASE_URL",
  "ai:OLLAMA_MODEL",
  "ai:AWS_ACCESS_KEY_ID",
  "ai:AWS_SECRET_ACCESS_KEY",
  "ai:AWS_REGION",
  "ai:AWS_SESSION_TOKEN",
  "ai:OPENAI_COMPATIBLE_BASE_URL",
  "ai:OPENAI_COMPATIBLE_MODEL",
  "ai:OPENAI_COMPATIBLE_API_KEY",
  "map:google-maps-api-key",
  "map:mapillary-access-token",
  "map:protomaps-api-key",
  "map:tomtom-api-key",
  "map:here-api-key",
  "map:amazon-location-api-key",
] as const;

export type CredentialId = (typeof CREDENTIAL_IDS)[number];
export type CredentialValues = Partial<Record<CredentialId, string>>;
export const WRITE_ONLY_CREDENTIAL_IDS = ["vworld:api-key"] as const satisfies readonly CredentialId[];
export type CredentialBackendKind = "memory" | "windows";
export const LEGACY_CREDENTIAL_STORAGE_KEYS = [
  "geolibre:mapillary-access-token",
] as const;
export type CredentialErrorCode =
  | "credential_backend_unavailable"
  | "credential_invalid_id"
  | "credential_invalid_value"
  | "credential_read_failed"
  | "credential_write_failed"
  | "credential_delete_failed";

const CREDENTIAL_ID_SET = new Set<string>(CREDENTIAL_IDS);
const AI_CREDENTIAL_PREFIX = "ai:";
const GEOCODER_CREDENTIAL_PREFIX = "geocoder:";
const GEOCODER_CREDENTIAL_SUFFIX = ":api-key";

export interface CredentialBackend {
  readonly kind: CredentialBackendKind;
  load(): Promise<CredentialLoadResult>;
  set(id: CredentialId, value: string): Promise<void>;
  delete(id: CredentialId): Promise<void>;
  clear(): Promise<void>;
}

export interface CredentialLoadResult {
  values: CredentialValues;
  configuredIds: CredentialId[];
  errorCode: CredentialErrorCode | null;
}

export interface CredentialInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

interface CredentialBackendOptions {
  desktop: boolean;
  invoke: CredentialInvoke;
}

function normalizeCredentialValues(value: unknown): CredentialValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: CredentialValues = {};
  for (const [id, candidate] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (!isCredentialId(id) || typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized) result[id] = normalized;
  }
  return result;
}

export function isWriteOnlyCredentialId(id: CredentialId): boolean {
  return (WRITE_ONLY_CREDENTIAL_IDS as readonly CredentialId[]).includes(id);
}

function normalizeConfiguredIds(
  configuredIds: unknown,
  rawValues: CredentialValues
): CredentialId[] {
  const configured = new Set<CredentialId>(Object.keys(rawValues).filter(isCredentialId));
  if (Array.isArray(configuredIds)) {
    for (const id of configuredIds) {
      if (typeof id === "string" && isCredentialId(id)) configured.add(id);
    }
  }
  return CREDENTIAL_IDS.filter((id) => configured.has(id));
}

function normalizeCredentialLoadResult(value: unknown): CredentialLoadResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("values" in record) {
      const values = normalizeCredentialValues(record.values);
      const configuredIds = normalizeConfiguredIds(record.configuredIds, values);
      for (const id of WRITE_ONLY_CREDENTIAL_IDS) delete values[id];
      return {
        values,
        configuredIds,
        errorCode:
          record.errorCode === "credential_read_failed"
            ? "credential_read_failed"
            : null,
      };
    }
  }
  const values = normalizeCredentialValues(value);
  const configuredIds = normalizeConfiguredIds(undefined, values);
  for (const id of WRITE_ONLY_CREDENTIAL_IDS) delete values[id];
  return { values, configuredIds, errorCode: null };
}

export function isCredentialId(value: string): value is CredentialId {
  return CREDENTIAL_ID_SET.has(value);
}

export function createCredentialBackend(
  options: CredentialBackendOptions
): CredentialBackend {
  if (!options.desktop) {
    let values: CredentialValues = {};
    return {
      kind: "memory",
      async load() {
        return {
          values: { ...values },
          configuredIds: CREDENTIAL_IDS.filter((id) => Boolean(values[id])),
          errorCode: null,
        };
      },
      async set(id, value) {
        const normalized = value.trim();
        if (!normalized) throw new Error("credential_invalid_value");
        values = { ...values, [id]: normalized };
      },
      async delete(id) {
        const next = { ...values };
        delete next[id];
        values = next;
      },
      async clear() {
        values = {};
      },
    };
  }

  return {
    kind: "windows",
    async load() {
      return normalizeCredentialLoadResult(
        await options.invoke<unknown>("credential_load")
      );
    },
    async set(id, value) {
      const normalized = value.trim();
      if (!normalized) throw new Error("credential_invalid_value");
      await options.invoke<void>("credential_set", {
        credentialId: id,
        value: normalized,
      });
    },
    async delete(id) {
      await options.invoke<void>("credential_delete", { credentialId: id });
    },
    async clear() {
      await options.invoke<void>("credential_clear");
    },
  };
}

export interface CredentialRuntimeValues {
  shareToken: string;
  cesiumIonToken: string;
  aiProviderEnv: Record<string, string>;
  geocodingApiKeys: Record<string, string>;
  serviceEnv: Record<string, string>;
}

export function credentialRuntimeValues(
  values: CredentialValues
): CredentialRuntimeValues {
  const aiProviderEnv: Record<string, string> = {};
  const geocodingApiKeys: Record<string, string> = {};
  const serviceEnv: Record<string, string> = {};
  for (const [id, value] of Object.entries(values)) {
    if (id.startsWith(AI_CREDENTIAL_PREFIX) && value) {
      aiProviderEnv[id.slice(AI_CREDENTIAL_PREFIX.length)] = value;
    }
    if (
      id.startsWith(GEOCODER_CREDENTIAL_PREFIX) &&
      id.endsWith(GEOCODER_CREDENTIAL_SUFFIX) &&
      value
    ) {
      geocodingApiKeys[
        id.slice(
          GEOCODER_CREDENTIAL_PREFIX.length,
          -GEOCODER_CREDENTIAL_SUFFIX.length
        )
      ] = value;
    }
  }
  const serviceMappings: ReadonlyArray<readonly [CredentialId, string]> = [
    ["map:google-maps-api-key", "VITE_GOOGLE_MAPS_API_KEY"],
    ["map:mapillary-access-token", "VITE_MAPILLARY_ACCESS_TOKEN"],
    ["map:protomaps-api-key", "VITE_PROTOMAPS_API_KEY"],
    ["map:tomtom-api-key", "VITE_TOMTOM_API_KEY"],
    ["map:here-api-key", "VITE_HERE_API_KEY"],
    ["map:amazon-location-api-key", "VITE_AMAZON_LOCATION_API_KEY"],
  ];
  for (const [id, envName] of serviceMappings) {
    const value = values[id]?.trim();
    if (value) serviceEnv[envName] = value;
  }
  return {
    shareToken: values["share:token"] ?? "",
    cesiumIonToken: values["cesium:ion-token"] ?? "",
    aiProviderEnv,
    geocodingApiKeys,
    serviceEnv,
  };
}

export function credentialIdForAiEnv(envName: string): CredentialId | null {
  const id = `${AI_CREDENTIAL_PREFIX}${envName}`;
  return isCredentialId(id) ? id : null;
}

export function credentialIdForGeocoder(
  providerId: string
): CredentialId | null {
  const id = `${GEOCODER_CREDENTIAL_PREFIX}${providerId}${GEOCODER_CREDENTIAL_SUFFIX}`;
  return isCredentialId(id) ? id : null;
}

export function removeManagedCredentialsFromEnvironment<
  T extends { key: string }
>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isCredentialEnvironmentName(row.key));
}

export { CREDENTIAL_ENV_NAMES };

export function discardLegacyCredentialStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of LEGACY_CREDENTIAL_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; never read or surface a legacy value.
  }
}

interface CredentialDiagnosticInput {
  backend: CredentialBackendKind;
  loaded: boolean;
  values: CredentialValues;
  errorCode: CredentialErrorCode | null;
}

export interface CredentialDiagnosticReport {
  backend: CredentialBackendKind;
  loaded: boolean;
  configuredIds: CredentialId[];
  errorCode: CredentialErrorCode | null;
}

export function credentialDiagnostics(
  input: CredentialDiagnosticInput
): CredentialDiagnosticReport {
  return {
    backend: input.backend,
    loaded: input.loaded,
    configuredIds: Object.keys(input.values)
      .filter(isCredentialId)
      .sort() as CredentialId[],
    errorCode: input.errorCode,
  };
}
