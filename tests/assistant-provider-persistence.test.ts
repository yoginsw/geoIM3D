import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { mergeRuntimeEnv } from "../apps/geolibre-desktop/src/lib/assistant/provider";

const NO_SOURCES = {
  osEnv: {},
  aiEnv: {},
  geocoderEnv: {},
  cesiumEnv: {},
  projectEnv: {},
};

// Credential material is intentionally absent from DesktopSettings. Legacy
// fields are discarded rather than migrated so localStorage remains non-secret.
describe("DesktopSettings credential disposal", () => {
  it("does not expose credential fields in defaults", () => {
    const defaults = normalizeDesktopSettings(undefined) as unknown as Record<
      string,
      unknown
    >;
    assert.equal("shareToken" in defaults, false);
    assert.equal("cesiumIonToken" in defaults, false);
    assert.equal("aiProviderEnv" in defaults, false);
  });

  it("drops valid, malformed, and legacy credential payloads", () => {
    for (const candidate of [
      {
        shareToken: "legacy-share",
        cesiumIonToken: "legacy-cesium",
        aiProviderEnv: {
          ANTHROPIC_API_KEY: "legacy-anthropic",
          OLLAMA_BASE_URL: "http://localhost:11434",
        },
      },
      { aiProviderEnv: null },
      { aiProviderEnv: ["legacy-array"] },
    ]) {
      const normalized = normalizeDesktopSettings(candidate) as unknown as Record<
        string,
        unknown
      >;
      const serialized = JSON.stringify(normalized);
      assert.equal("shareToken" in normalized, false);
      assert.equal("cesiumIonToken" in normalized, false);
      assert.equal("aiProviderEnv" in normalized, false);
      assert.equal(serialized.includes("legacy-"), false);
      assert.equal(serialized.includes("localhost:11434"), false);
    }
  });

  it("preserves ordinary settings while dropping legacy credentials", () => {
    const normalized = normalizeDesktopSettings({
      shareToken: "discard-me",
      cesiumIonToken: "discard-me-too",
      layout: { toolbarLabels: false },
    }) as unknown as Record<string, unknown>;
    assert.equal(
      (normalized.layout as { toolbarLabels: boolean }).toolbarLabels,
      false,
    );
    assert.equal(JSON.stringify(normalized).includes("discard-me"), false);
  });
});

// The precedence order in mergeRuntimeEnv is the part most likely to regress
// silently (swapping two spreads). Pin the guarantees the app relies on:
// OS env < device AI keys < project Environment variables, with OS aliases
// dropped when a project or device credential covers the same credential group.
describe("mergeRuntimeEnv precedence", () => {
  it("lets device AI keys override the OS environment", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { ANTHROPIC_API_KEY: "from-os" },
      aiEnv: { ANTHROPIC_API_KEY: "from-device" },
    });
    assert.equal(merged.ANTHROPIC_API_KEY, "from-device");
  });

  it("lets an explicit project Environment variable override a device AI key", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { ANTHROPIC_API_KEY: "from-os" },
      aiEnv: { ANTHROPIC_API_KEY: "from-device" },
      projectEnv: { ANTHROPIC_API_KEY: "from-project" },
    });
    assert.equal(merged.ANTHROPIC_API_KEY, "from-project");
  });

  it("falls back to the OS value when nothing else provides the key", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { OPENAI_API_KEY: "from-os" },
    });
    assert.equal(merged.OPENAI_API_KEY, "from-os");
  });

  it("drops an OS alias when a device key covers the same credential group", () => {
    // Device sets the canonical GEMINI_API_KEY; the OS-provided GOOGLE_API_KEY
    // alias must not survive to shadow it via firstValue's alias ordering.
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { GOOGLE_API_KEY: "from-os-alias" },
      aiEnv: { GEMINI_API_KEY: "from-device" },
    });
    assert.equal(merged.GEMINI_API_KEY, "from-device");
    assert.equal(merged.GOOGLE_API_KEY, undefined);
  });

  it("drops an OS alias when a project key covers the same credential group", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      osEnv: { GEMINI_API_KEY: "from-os" },
      projectEnv: { GOOGLE_API_KEY: "from-project-alias" },
    });
    assert.equal(merged.GOOGLE_API_KEY, "from-project-alias");
    assert.equal(merged.GEMINI_API_KEY, undefined);
  });

  it("includes derived geocoder and cesium values", () => {
    const merged = mergeRuntimeEnv({
      ...NO_SOURCES,
      geocoderEnv: { VITE_GEOCODER_PROVIDER: "nominatim" },
      cesiumEnv: { VITE_CESIUM_TOKEN: "tok" },
    });
    assert.equal(merged.VITE_GEOCODER_PROVIDER, "nominatim");
    assert.equal(merged.VITE_CESIUM_TOKEN, "tok");
  });
});
