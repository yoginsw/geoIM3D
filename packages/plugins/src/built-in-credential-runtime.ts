export interface BuiltInPluginCredentialEnvironment {
  VITE_GEOCODER_API_KEY?: string;
  VITE_GOOGLE_MAPS_API_KEY?: string;
  VITE_MAPILLARY_ACCESS_TOKEN?: string;
  VITE_TOMTOM_API_KEY?: string;
  VITE_HERE_API_KEY?: string;
  VITE_AMAZON_LOCATION_API_KEY?: string;
}

let credentials: BuiltInPluginCredentialEnvironment = {};

/** Write-only package entry point used by the desktop host. */
export function setBuiltInPluginCredentials(
  next: BuiltInPluginCredentialEnvironment
): void {
  const value = (candidate: string | undefined) =>
    candidate?.trim() || undefined;
  credentials = {
    VITE_GEOCODER_API_KEY: value(next.VITE_GEOCODER_API_KEY),
    VITE_GOOGLE_MAPS_API_KEY: value(next.VITE_GOOGLE_MAPS_API_KEY),
    VITE_MAPILLARY_ACCESS_TOKEN: value(next.VITE_MAPILLARY_ACCESS_TOKEN),
    VITE_TOMTOM_API_KEY: value(next.VITE_TOMTOM_API_KEY),
    VITE_HERE_API_KEY: value(next.VITE_HERE_API_KEY),
    VITE_AMAZON_LOCATION_API_KEY: value(next.VITE_AMAZON_LOCATION_API_KEY),
  };
}

export function readBasemapCredentials(): BuiltInPluginCredentialEnvironment {
  return {
    VITE_GOOGLE_MAPS_API_KEY: credentials.VITE_GOOGLE_MAPS_API_KEY,
    VITE_TOMTOM_API_KEY: credentials.VITE_TOMTOM_API_KEY,
    VITE_HERE_API_KEY: credentials.VITE_HERE_API_KEY,
    VITE_AMAZON_LOCATION_API_KEY: credentials.VITE_AMAZON_LOCATION_API_KEY,
  };
}

export function readStreetViewCredentials(): BuiltInPluginCredentialEnvironment {
  return {
    VITE_GOOGLE_MAPS_API_KEY: credentials.VITE_GOOGLE_MAPS_API_KEY,
    VITE_MAPILLARY_ACCESS_TOKEN: credentials.VITE_MAPILLARY_ACCESS_TOKEN,
  };
}

export function readMapillaryAccessToken(): string | undefined {
  return credentials.VITE_MAPILLARY_ACCESS_TOKEN;
}

export function readGoogleMapsApiKey(): string | undefined {
  return credentials.VITE_GOOGLE_MAPS_API_KEY;
}

export function readGeocoderApiKey(): string | undefined {
  return credentials.VITE_GEOCODER_API_KEY;
}
