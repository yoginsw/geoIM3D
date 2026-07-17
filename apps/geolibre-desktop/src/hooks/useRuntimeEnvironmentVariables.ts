import { normalizeGeocodingProviderId, useAppStore } from "@geolibre/core";
import { setMapGoogleMapsApiKey } from "@geolibre/map";
import { setBuiltInPluginCredentials } from "@geolibre/plugins";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { mergeRuntimeEnv, type RuntimeEnv } from "../lib/assistant/provider";
import { loadOsEnvVars, readOsEnv } from "../lib/assistant/os-env";
import {
  credentialRuntimeValues,
  removeManagedCredentialsFromEnvironment,
} from "../lib/credentials";
import { setPrivateCredentialEnvironment } from "../lib/private-credential-runtime";
import { useCredentialStore } from "./useCredentials";

export function useRuntimeEnvironmentVariables() {
  const environmentVariables = useAppStore(
    (s) => s.preferences.environmentVariables
  );
  const geocoding = useAppStore((s) => s.preferences.geocoding);
  // Device-local Cesium Ion token (Settings → Environment). Projected below so
  // getCesiumIonToken() picks it up as a runtime override without a rebuild.
  const credentialValues = useCredentialStore(
    useShallow((state) => state.values)
  );
  const {
    cesiumIonToken,
    aiProviderEnv,
    vworldApiKey,
    geocodingApiKeys,
    serviceEnv,
  } = credentialRuntimeValues(credentialValues);
  // Device-local AI Assistant provider credentials (Settings → AI Providers).
  // Projected below so the assistant picks them up after a restart without the
  // keys ever living in the shared project file. See useDesktopSettings.ts.
  // useShallow keeps the reference stable across unrelated setDesktopSettings
  // updates (e.g. dragging the accent-color picker), which normalizeDesktopSettings
  // would otherwise churn into a fresh object every time — needlessly re-running
  // this effect and re-rendering the host.

  const lastSerializedEnv = useRef<string | null>(null);
  const lastCredentialValues = useRef(credentialValues);
  const isFirstRender = useRef(true);

  // AI provider keys sourced from the user's OS environment (desktop only).
  // Loaded once at startup; feeding it through state re-runs the merge below so
  // the runtime env picks up the values once the async read resolves.
  const [osEnv, setOsEnv] = useState<RuntimeEnv>(() => readOsEnv());
  useEffect(() => {
    let cancelled = false;
    loadOsEnvVars().then((env) => {
      if (!cancelled) setOsEnv(env);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Derive the VITE_GEOCODER_* vars from the structured geocoding preference
    // so the reverse-geocode plugin (which reads runtime env, not the store)
    // honors the selected provider. Explicit user-defined env vars below win,
    // preserving the documented endpoint override escape hatch.
    const providerId = normalizeGeocodingProviderId(geocoding.providerId);
    const geocoderEnv: Record<string, string> = {
      VITE_GEOCODER_PROVIDER: providerId,
    };
    const geocoderCredentialEnv: Record<string, string> = {};
    const apiKey = geocodingApiKeys[providerId]?.trim();
    if (apiKey) geocoderCredentialEnv.VITE_GEOCODER_API_KEY = apiKey;
    if (geocoding.forwardEndpoint?.trim())
      geocoderEnv.VITE_GEOCODER_ENDPOINT = geocoding.forwardEndpoint.trim();
    if (geocoding.reverseEndpoint?.trim())
      geocoderEnv.VITE_GEOCODER_REVERSE_ENDPOINT =
        geocoding.reverseEndpoint.trim();
    if (geocoding.email?.trim())
      geocoderEnv.VITE_GEOCODER_EMAIL = geocoding.email.trim();

    const projectEnv = Object.fromEntries(
      removeManagedCredentialsFromEnvironment(environmentVariables)
        .filter((variable) => variable.enabled && variable.key.trim())
        .map((variable) => [variable.key.trim(), variable.value])
    );

    // Device-local AI provider credentials, keyed by env var name. Empty values
    // are dropped so a blank entry never blanks out a build-time or OS value.
    const aiEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(aiProviderEnv)) {
      const name = key.trim();
      if (name && value) aiEnv[name] = value;
    }

    // Inject only non-empty values into the module-scoped credential overlay.
    // Managed credential rows in the project environment are removed.
    const cesiumEnv: Record<string, string> = cesiumIonToken.trim()
      ? { VITE_CESIUM_TOKEN: cesiumIonToken.trim() }
      : {};
    const vworldEnv: Record<string, string> = vworldApiKey.trim()
      ? { VWORLD_API_KEY: vworldApiKey.trim() }
      : {};

    // Precedence (low -> high): OS env < device AI keys < geocoder < device
    // product credentials < non-credential project Environment variables.
    const credentialEnv = mergeRuntimeEnv({
      osEnv,
      aiEnv: { ...aiEnv, ...serviceEnv },
      geocoderEnv: geocoderCredentialEnv,
      cesiumEnv: { ...cesiumEnv, ...vworldEnv },
      projectEnv: {},
    });
    setPrivateCredentialEnvironment(credentialEnv);
    setBuiltInPluginCredentials({
      VITE_GEOCODER_API_KEY: credentialEnv.VITE_GEOCODER_API_KEY,
      VITE_GOOGLE_MAPS_API_KEY: credentialEnv.VITE_GOOGLE_MAPS_API_KEY,
      VITE_MAPILLARY_ACCESS_TOKEN: credentialEnv.VITE_MAPILLARY_ACCESS_TOKEN,
      VITE_TOMTOM_API_KEY: credentialEnv.VITE_TOMTOM_API_KEY,
      VITE_HERE_API_KEY: credentialEnv.VITE_HERE_API_KEY,
      VITE_AMAZON_LOCATION_API_KEY: credentialEnv.VITE_AMAZON_LOCATION_API_KEY,
    });
    setMapGoogleMapsApiKey(credentialEnv.VITE_GOOGLE_MAPS_API_KEY);

    const runtimeEnv = mergeRuntimeEnv({
      osEnv: {},
      aiEnv: {},
      geocoderEnv,
      cesiumEnv: {},
      projectEnv,
    });

    // Always keep the global env in sync so plugins can read it when they
    // activate, even before the first change event.
    window.__GEOLIBRE_RUNTIME_ENV__ = runtimeEnv;

    // Skip the change event on the initial mount: plugins read the global
    // directly when they activate, so dispatching here would only trigger a
    // spurious Street View control remove/re-add on startup.
    const serializedEnv = JSON.stringify(runtimeEnv);
    if (isFirstRender.current) {
      isFirstRender.current = false;
      lastSerializedEnv.current = serializedEnv;
      lastCredentialValues.current = credentialValues;
      return;
    }

    // Skip the dispatch when the derived env is unchanged. Saving unrelated
    // settings (e.g. map preferences) recreates the array reference without
    // changing its contents, and a redundant dispatch needlessly reinitializes
    // plugins such as Street View.
    const credentialsChanged =
      lastCredentialValues.current !== credentialValues;
    if (serializedEnv === lastSerializedEnv.current && !credentialsChanged)
      return;
    lastSerializedEnv.current = serializedEnv;
    lastCredentialValues.current = credentialValues;

    window.dispatchEvent(
      new CustomEvent("geolibre:runtime-env-change", { detail: runtimeEnv })
    );
  }, [
    environmentVariables,
    geocoding,
    credentialValues,
    cesiumIonToken,
    vworldApiKey,
    aiProviderEnv,
    geocodingApiKeys,
    serviceEnv,
    osEnv,
  ]);
}
