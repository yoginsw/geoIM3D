import { useEffect } from "react";
import { create } from "zustand";
import {
  CREDENTIAL_IDS,
  createCredentialBackend,
  discardLegacyCredentialStorage,
  isWriteOnlyCredentialId,
  type CredentialBackend,
  type CredentialBackendKind,
  type CredentialErrorCode,
  type CredentialId,
  type CredentialValues,
} from "../lib/credentials";
import { isTauri } from "../lib/is-tauri";

async function invokeCredential<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

const credentialBackend: CredentialBackend = createCredentialBackend({
  desktop: isTauri(),
  invoke: invokeCredential,
});

const CREDENTIAL_ERROR_CODES = new Set<CredentialErrorCode>([
  "credential_backend_unavailable",
  "credential_invalid_id",
  "credential_invalid_value",
  "credential_read_failed",
  "credential_write_failed",
  "credential_delete_failed",
]);

function errorCode(
  error: unknown,
  fallback: CredentialErrorCode
): CredentialErrorCode {
  const candidate =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : null;
  return candidate &&
    CREDENTIAL_ERROR_CODES.has(candidate as CredentialErrorCode)
    ? (candidate as CredentialErrorCode)
    : fallback;
}

function dispatchCredentialDisposalEvent(
  type:
    | "geoim3d:credential-deleted"
    | "geoim3d:credential-replaced"
    | "geoim3d:credentials-cleared",
  id?: CredentialId
): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function"
  ) {
    return;
  }
  window.dispatchEvent(
    id ? new CustomEvent(type, { detail: { id } }) : new Event(type)
  );
}

export interface CredentialState {
  backend: CredentialBackendKind;
  values: CredentialValues;
  configuredIds: CredentialId[];
  loaded: boolean;
  errorCode: CredentialErrorCode | null;
  loadCredentials(): Promise<void>;
  setCredential(id: CredentialId, value: string): Promise<void>;
  deleteCredential(id: CredentialId): Promise<void>;
  clearCredentials(): Promise<void>;
}

export function createCredentialStore(backend: CredentialBackend) {
  return create<CredentialState>((set, get) => ({
    backend: backend.kind,
    values: {},
    configuredIds: [],
    loaded: false,
    errorCode: null,
    async loadCredentials() {
      try {
        const result = await backend.load();
        set({
          values: result.values,
          configuredIds: result.configuredIds,
          loaded: true,
          errorCode: result.errorCode,
        });
      } catch (error) {
        set({
          values: {},
          configuredIds: [],
          loaded: true,
          errorCode: errorCode(error, "credential_read_failed"),
        });
      }
    },
    async setCredential(id, value) {
      const replacesConfiguredCredential = get().configuredIds.includes(id);
      try {
        await backend.set(id, value);
        if (replacesConfiguredCredential) {
          dispatchCredentialDisposalEvent("geoim3d:credential-replaced", id);
        }
        const normalized = value.trim();
        set((state) => {
          const values = { ...state.values };
          if (normalized && !isWriteOnlyCredentialId(id)) values[id] = normalized;
          else delete values[id];
          const configured = new Set(state.configuredIds);
          configured.add(id);
          return {
            values,
            configuredIds: CREDENTIAL_IDS.filter((candidate) => configured.has(candidate)),
            errorCode: null,
          };
        });
      } catch (error) {
        const code = errorCode(error, "credential_write_failed");
        set({ errorCode: code });
        throw new Error(code);
      }
    },
    async deleteCredential(id) {
      try {
        await backend.delete(id);
        dispatchCredentialDisposalEvent("geoim3d:credential-deleted", id);
        set((state) => {
          const values = { ...state.values };
          delete values[id];
          return {
            values,
            configuredIds: state.configuredIds.filter((candidate) => candidate !== id),
            errorCode: null,
          };
        });
      } catch (error) {
        set({ errorCode: errorCode(error, "credential_delete_failed") });
        throw new Error("credential_delete_failed");
      }
    },
    async clearCredentials() {
      dispatchCredentialDisposalEvent("geoim3d:credentials-cleared");
      try {
        await backend.clear();
        set({ values: {}, configuredIds: [], errorCode: null });
      } catch (error) {
        const deleteErrorCode = errorCode(error, "credential_delete_failed");
        try {
          const result = await backend.load();
          set({
            values: result.values,
            configuredIds: result.configuredIds,
            errorCode: deleteErrorCode,
          });
        } catch {
          set({ errorCode: deleteErrorCode });
        }
        throw new Error("credential_delete_failed");
      }
    },
  }));
}

export const useCredentialStore = createCredentialStore(credentialBackend);

export function useCredentialBootstrap(): void {
  useEffect(() => {
    discardLegacyCredentialStorage();
    void useCredentialStore.getState().loadCredentials();
  }, []);
}

export function configuredCredentialIds(
  values: CredentialValues
): CredentialId[] {
  return CREDENTIAL_IDS.filter((id) => Boolean(values[id]));
}
