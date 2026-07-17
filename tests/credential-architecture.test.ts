import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  loadDesktopSettings,
  normalizeDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { createCredentialStore } from "../apps/geolibre-desktop/src/hooks/useCredentials";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";
import {
  readPrivateCredentialEnvironment,
  setPrivateCredentialEnvironment,
} from "../apps/geolibre-desktop/src/lib/private-credential-runtime";
import { getRuntimeEnvironment } from "../packages/core/src/runtime-env";
import {
  CREDENTIAL_IDS,
  CREDENTIAL_ENV_NAMES,
  createCredentialBackend,
  credentialDiagnostics,
  credentialRuntimeValues,
  discardLegacyCredentialStorage,
  removeManagedCredentialsFromEnvironment,
  type CredentialBackend,
} from "../apps/geolibre-desktop/src/lib/credentials";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("legacy credential disposal", () => {
  it("drops every legacy secret field from persisted desktop settings", () => {
    const normalized = normalizeDesktopSettings({
      shareToken: "legacy-share-value",
      cesiumIonToken: "legacy-cesium-value",
      aiProviderEnv: {
        OPENAI_API_KEY: "legacy-ai-value",
      },
      layout: { toolbarLabels: false },
    }) as unknown as Record<string, unknown>;

    assert.equal("shareToken" in normalized, false);
    assert.equal("cesiumIonToken" in normalized, false);
    assert.equal("aiProviderEnv" in normalized, false);
    const serialized = JSON.stringify(normalized);
    assert.equal(serialized.includes("legacy-share-value"), false);
    assert.equal(serialized.includes("legacy-cesium-value"), false);
    assert.equal(serialized.includes("legacy-ai-value"), false);
  });

  it("overwrites the legacy localStorage blob before React effects run", () => {
    let stored = JSON.stringify({
      shareToken: "legacy-storage-value",
      layout: { toolbarLabels: false },
    });
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) =>
            key === DESKTOP_SETTINGS_STORAGE_KEY ? stored : null,
          setItem: (key: string, value: string) => {
            if (key === DESKTOP_SETTINGS_STORAGE_KEY) stored = value;
          },
        },
      },
    });
    try {
      const loaded = loadDesktopSettings();
      assert.equal(loaded.layout.toolbarLabels, false);
      assert.equal(stored.includes("legacy-storage-value"), false);
      assert.equal(stored.includes("shareToken"), false);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      }
    }
  });

  it("deletes standalone legacy plugin credentials without reading them", () => {
    const removed: string[] = [];
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => {
            throw new Error("legacy credential must not be read");
          },
          removeItem: (key: string) => removed.push(key),
        },
      },
    });
    try {
      discardLegacyCredentialStorage();
      assert.deepEqual(removed, ["geolibre:mapillary-access-token"]);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      }
    }
  });
});

describe("credential backend", () => {
  it("keeps web credentials in memory without invoking desktop IPC", async () => {
    let invokeCount = 0;
    const backend = createCredentialBackend({
      desktop: false,
      invoke: async () => {
        invokeCount += 1;
        throw new Error("web must not invoke desktop IPC");
      },
    });

    await backend.set("share:token", "memory-share-value");
    await backend.set("ai:OPENAI_API_KEY", "memory-ai-value");
    await assert.rejects(
      backend.set("share:token", "   "),
      /credential_invalid_value/
    );
    assert.deepEqual(await backend.load(), {
      values: {
      "share:token": "memory-share-value",
      "ai:OPENAI_API_KEY": "memory-ai-value",
      },
      errorCode: null,
    });
    await backend.delete("share:token");
    assert.deepEqual(await backend.load(), {
      values: { "ai:OPENAI_API_KEY": "memory-ai-value" },
      errorCode: null,
    });
    await backend.clear();
    assert.deepEqual(await backend.load(), { values: {}, errorCode: null });
    assert.equal(invokeCount, 0);
  });

  it("routes desktop operations through fixed Tauri commands", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const backend = createCredentialBackend({
      desktop: true,
      invoke: async <T>(command: string, args?: unknown) => {
        calls.push({ command, args });
        if (command === "credential_load") {
          return {
            values: { "cesium:ion-token": "desktop-value" },
            errorCode: "credential_read_failed",
          } as T;
        }
        return undefined as T;
      },
    });

    assert.deepEqual(await backend.load(), {
      values: { "cesium:ion-token": "desktop-value" },
      errorCode: "credential_read_failed",
    });
    await backend.set("cesium:ion-token", "replacement-value");
    await assert.rejects(
      backend.set("cesium:ion-token", ""),
      /credential_invalid_value/
    );
    await backend.delete("cesium:ion-token");
    await backend.clear();
    assert.deepEqual(
      calls.map((call) => call.command),
      [
        "credential_load",
        "credential_set",
        "credential_delete",
        "credential_clear",
      ]
    );
  });

  it("uses an explicit unique allowlist including future VWorld", () => {
    assert.equal(new Set(CREDENTIAL_IDS).size, CREDENTIAL_IDS.length);
    assert.ok(CREDENTIAL_IDS.includes("share:token"));
    assert.ok(CREDENTIAL_IDS.includes("cesium:ion-token"));
    assert.ok(CREDENTIAL_IDS.includes("vworld:api-key"));
    assert.ok(CREDENTIAL_IDS.includes("geocoder:mapbox:api-key"));
    assert.ok(CREDENTIAL_IDS.includes("ai:OPENAI_API_KEY"));
  });

  it("preserves invalid-value errors without deleting store state", async () => {
    const backend = createCredentialBackend({
      desktop: false,
      invoke: async () => {
        throw new Error("web must not invoke desktop IPC");
      },
    });
    const store = createCredentialStore(backend);
    await store.getState().setCredential("share:token", "existing-value");

    await assert.rejects(
      store.getState().setCredential("share:token", "  "),
      /credential_invalid_value/
    );
    assert.equal(store.getState().values["share:token"], "existing-value");
    assert.equal(store.getState().errorCode, "credential_invalid_value");
  });

  it("reloads remaining state when purge-all partially fails", async () => {
    const backend: CredentialBackend = {
      kind: "windows",
      async load() {
        return {
          values: { "cesium:ion-token": "remaining-value" },
          errorCode: null,
        };
      },
      async set() {},
      async delete() {},
      async clear() {
        throw "credential_delete_failed";
      },
    };
    const store = createCredentialStore(backend);
    store.setState({
      values: {
        "share:token": "removed-value",
        "cesium:ion-token": "remaining-value",
      },
    });

    await assert.rejects(
      store.getState().clearCredentials(),
      /credential_delete_failed/
    );
    assert.deepEqual(store.getState().values, {
      "cesium:ion-token": "remaining-value",
    });
    assert.equal(store.getState().errorCode, "credential_delete_failed");
  });
});

describe("credential runtime boundaries", () => {
  it("keeps every credential out of the public Core runtime API", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __GEOLIBRE_RUNTIME_ENV__: {
          PUBLIC_SETTING: "public-value",
          OLLAMA_HOST: "http://127.0.0.1:11434",
          ...Object.fromEntries(
            CREDENTIAL_ENV_NAMES.map((name) => [name, "project-value"])
          ),
        },
      },
    });
    try {
      const resolved = getRuntimeEnvironment();
      assert.equal(resolved.PUBLIC_SETTING, "public-value");
      assert.equal(resolved.OLLAMA_HOST, "http://127.0.0.1:11434");
      for (const name of CREDENTIAL_ENV_NAMES) {
        assert.equal(resolved[name], undefined);
      }
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      }
    }
  });

  it("does not bake Cesium credentials into the client or public runtime map", () => {
    const vite = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/vite.config.ts"),
      "utf8"
    );
    const runtimeHook = readFileSync(
      path.join(
        repoRoot,
        "apps/geolibre-desktop/src/hooks/useRuntimeEnvironmentVariables.ts"
      ),
      "utf8"
    );
    const cesiumCanvas = readFileSync(
      path.join(repoRoot, "packages/map/src/CesiumCanvas.tsx"),
      "utf8"
    );
    assert.doesNotMatch(vite, /process\.env\.VITE_CESIUM_TOKEN\s*=/);
    assert.doesNotMatch(vite, /process\.env\.VITE_GOOGLE_MAPS_API_KEY\s*=/);
    assert.match(vite, /envPrefix:\s*\["GEOIM3D_PUBLIC_"\]/);
    assert.doesNotMatch(vite, /envPrefix:\s*\[[^\]]*"VITE_"/);
    const publicAllowlist = vite.match(
      /const PUBLIC_CLIENT_ENV_NAMES = \[([\s\S]*?)\] as const;/
    )?.[1];
    assert.ok(publicAllowlist);
    for (const credentialName of CREDENTIAL_ENV_NAMES) {
      assert.doesNotMatch(publicAllowlist, new RegExp(`"${credentialName}"`));
    }
    assert.match(publicAllowlist, /"VITE_PYODIDE_INDEX_URL"/);
    assert.match(publicAllowlist, /"VITE_SIDECAR_URL"/);
    assert.doesNotMatch(runtimeHook, /setRuntimeCredentialEnvironment/);
    assert.match(
      runtimeHook,
      /setPrivateCredentialEnvironment\(credentialEnv\)/
    );
    assert.match(runtimeHook, /setFirstPartyCredentialEnvironment\(\{/);
    assert.doesNotMatch(
      runtimeHook,
      /window\.__GEOLIBRE_RUNTIME_ENV__\s*=\s*credentialEnv/
    );
    assert.doesNotMatch(
      runtimeHook,
      /CustomEvent\([^)]*detail:\s*credentialEnv/s
    );
    assert.match(
      cesiumCanvas,
      /Cesium\.Ion\.defaultAccessToken\s*=\s*token\s*\?\?\s*""/
    );
  });

  it("derives runtime values without changing credential ids", () => {
    assert.deepEqual(
      credentialRuntimeValues({
        "share:token": "share-value",
        "cesium:ion-token": "cesium-value",
        "vworld:api-key": "vworld-value",
        "map:google-maps-api-key": "google-value",
        "geocoder:mapbox:api-key": "geocoder-value",
        "ai:OPENAI_API_KEY": "ai-value",
      }),
      {
        shareToken: "share-value",
        cesiumIonToken: "cesium-value",
        vworldApiKey: "vworld-value",
        aiProviderEnv: { OPENAI_API_KEY: "ai-value" },
        geocodingApiKeys: { mapbox: "geocoder-value" },
        serviceEnv: { VITE_GOOGLE_MAPS_API_KEY: "google-value" },
      }
    );
  });

  it("preserves the configured Bedrock region through the private runtime", () => {
    const runtime = credentialRuntimeValues({
      "ai:AWS_REGION": "eu-west-1",
    });
    setPrivateCredentialEnvironment(runtime.aiProviderEnv ?? {});
    try {
      assert.equal(readPrivateCredentialEnvironment().AWS_REGION, "eu-west-1");
      assert.ok(CREDENTIAL_ENV_NAMES.includes("AWS_REGION"));
      assert.ok(CREDENTIAL_ENV_NAMES.includes("AWS_DEFAULT_REGION"));
    } finally {
      setPrivateCredentialEnvironment({});
    }
  });

  it("requires explicit credential environments in the public Core helpers", () => {
    const runtimeEnv = readFileSync(
      path.join(repoRoot, "packages/core/src/runtime-env.ts"),
      "utf8"
    );
    for (const helper of [
      "getProtomapsApiKey",
      "getGoogleMapsApiKey",
      "getCesiumIonToken",
    ]) {
      const signature = runtimeEnv.match(
        new RegExp(`export function ${helper}\\([\\s\\S]*?\\): string \\| undefined \\{`)
      )?.[0];
      assert.ok(signature);
      assert.doesNotMatch(signature, /env\?\s*:/);
      assert.doesNotMatch(signature, /getRuntimeEnvironment\(\)/);
    }
  });

  it("removes managed credential rows from project environment state", () => {
    const rows = removeManagedCredentialsFromEnvironment([
      ...CREDENTIAL_ENV_NAMES.map((key) => ({
        key,
        value: "project-credential",
        enabled: true,
      })),
      { key: "SAFE_RENDER_OPTION", value: "1", enabled: true },
      { key: "OLLAMA_HOST", value: "http://127.0.0.1:11434", enabled: true },
    ]);
    assert.deepEqual(rows, [
      { key: "SAFE_RENDER_OPTION", value: "1", enabled: true },
      { key: "OLLAMA_HOST", value: "http://127.0.0.1:11434", enabled: true },
    ]);
  });

  it("reports status and error codes without value-derived metadata", () => {
    const report = credentialDiagnostics({
      backend: "windows",
      loaded: true,
      values: {
        "share:token": "diagnostic-private-value",
        "ai:OPENAI_API_KEY": "another-private-value",
      },
      errorCode: "credential_read_failed",
    });
    assert.deepEqual(report, {
      backend: "windows",
      loaded: true,
      configuredIds: ["ai:OPENAI_API_KEY", "share:token"],
      errorCode: "credential_read_failed",
    });
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("diagnostic-private-value"), false);
    assert.equal(serialized.includes("another-private-value"), false);
    assert.equal("lengths" in report, false);
    assert.equal("hashes" in report, false);
  });
});

describe("Windows credential command contract", () => {
  it("keeps keyring Windows-only and registers allowlisted commands", () => {
    const cargo = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/src-tauri/Cargo.toml"),
      "utf8"
    );
    const rust = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/src-tauri/src/lib.rs"),
      "utf8"
    );
    const credentialRust = readFileSync(
      path.join(
        repoRoot,
        "apps/geolibre-desktop/src-tauri/src/credential_store.rs"
      ),
      "utf8"
    );

    assert.match(
      cargo,
      /target\.\"cfg\(target_os = \\"windows\\"\)\"\.dependencies/
    );
    assert.match(cargo, /keyring\s*=.*windows-native-keyring-store/);
    for (const command of [
      "credential_load",
      "credential_set",
      "credential_delete",
      "credential_clear",
    ]) {
      assert.match(rust, new RegExp(`credential_store::${command}`));
    }
    assert.match(credentialRust, /const ALLOWED_CREDENTIAL_IDS/);
    const rustSetCommand = credentialRust.match(
      /pub fn credential_set[\s\S]*?\n}\n\n#\[tauri::command\]/
    )?.[0];
    assert.ok(rustSetCommand);
    assert.match(rustSetCommand, /credential_invalid_value|INVALID_VALUE/);
    assert.doesNotMatch(rustSetCommand, /credential_delete\(/);
    const rustAllowlist = [
      ...credentialRust.matchAll(/^\s{4}"([^"]+)",$/gm),
    ].map((match) => match[1]);
    assert.deepEqual(rustAllowlist, [...CREDENTIAL_IDS]);
    assert.doesNotMatch(credentialRust, /format!\([^\n]*error/);
  });
});

describe("credential-aware plugin and startup contract", () => {
  it("keeps first-party map plugins on the private resolver", () => {
    const pluginResolvers = [
      [
      "packages/plugins/src/plugins/maplibre-basemap-control.ts",
        "readBasemapCredentials",
      ],
      [
      "packages/plugins/src/plugins/maplibre-streetview.ts",
        "readStreetViewCredentials",
      ],
      [
      "packages/plugins/src/plugins/maplibre-mapillary.ts",
        "readMapillaryAccessToken",
      ],
    ] as const;
    for (const [relativePath, resolver] of pluginResolvers) {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      assert.match(source, new RegExp(resolver));
      assert.doesNotMatch(source, /__GEOLIBRE_RUNTIME_ENV__/);
    }
    const streetView = readFileSync(
      path.join(repoRoot, pluginResolvers[1][0]),
      "utf8"
    );
    assert.match(streetView, /geoim3d:credentials-cleared/);
    assert.match(streetView, /geoim3d:credential-deleted/);
    assert.match(streetView, /removeMapControl\(streetViewControl\)/);
    const mapillary = readFileSync(
      path.join(repoRoot, pluginResolvers[2][0]),
      "utf8"
    );
    assert.doesNotMatch(mapillary, /localStorage|sessionStorage/);
    assert.match(mapillary, /geoim3d:credentials-cleared/);
    assert.match(mapillary, /map:mapillary-access-token/);
    assert.match(mapillary, /if \(map\) removeCoverage\(map\)/);
    assert.match(mapillary, /destroyViewer\(\)/);
    const googleThreeDTiles = readFileSync(
      path.join(
        repoRoot,
        "packages/plugins/src/plugins/maplibre-3d-tiles.ts"
      ),
      "utf8"
    );
    assert.match(
      googleThreeDTiles,
      /setSharedDeckLayers\("google-3d-tiles", \[\]\)/
    );
    assert.match(
      googleThreeDTiles,
      /lastGoogleTilesLayerSignature = null/
    );
    const pluginIndex = readFileSync(
      path.join(repoRoot, "packages/plugins/src/index.ts"),
      "utf8"
    );
    const mapIndex = readFileSync(
      path.join(repoRoot, "packages/map/src/index.ts"),
      "utf8"
    );
    const privateBridge = readFileSync(
      path.join(
        repoRoot,
        "apps/geolibre-desktop/src/lib/private-first-party-credential-bridge.ts"
      ),
      "utf8"
    );
    assert.doesNotMatch(pluginIndex, /setBuiltInPluginCredentials/);
    assert.doesNotMatch(mapIndex, /setMapGoogleMapsApiKey/);
    assert.match(privateBridge, /setBuiltInPluginCredentials/);
    assert.match(privateBridge, /setMapGoogleMapsApiKey/);
    assert.doesNotMatch(
      pluginIndex,
      /readBasemapCredentials|readStreetViewCredentials|readMapillaryAccessToken/
    );
  });

  it("gates the desktop shell and keeps OS credentials module-private", () => {
    const app = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/src/App.tsx"),
      "utf8"
    );
    const osEnv = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/src/lib/assistant/os-env.ts"),
      "utf8"
    );
    assert.match(app, /if \(!credentialsLoaded\)/);
    assert.ok(
      app.indexOf("if (!credentialsLoaded)") < app.indexOf("<DesktopShell")
    );
    assert.doesNotMatch(osEnv, /__GEOLIBRE_OS_ENV__/);
    assert.doesNotMatch(osEnv, /console\.warn\([^)]*,\s*error/);
  });

  it("tears down the active assistant on credential disposal and replacement", () => {
    const assistantPanel = readFileSync(
      path.join(
        repoRoot,
        "apps/geolibre-desktop/src/components/panels/AssistantPanel.tsx"
      ),
      "utf8"
    );
    assert.match(assistantPanel, /const invalidateSession = \(\) => \{/);
    assert.match(assistantPanel, /session\.reset\(\)/);
    assert.match(
      assistantPanel,
      /cancelledGenerationRef\.current = sendGenerationRef\.current/
    );
    assert.match(assistantPanel, /"geoim3d:credential-deleted"/);
    assert.match(assistantPanel, /"geoim3d:credentials-cleared"/);
    assert.match(
      assistantPanel,
      /const onEnvChange = \(\) => \{\s*invalidateSession\(\)/
    );
    assert.match(
      assistantPanel,
      /removeEventListener\([\s\S]*?"geoim3d:credential-deleted"/
    );
    assert.match(
      assistantPanel,
      /removeEventListener\([\s\S]*?"geoim3d:credentials-cleared"/
    );
  });
});
