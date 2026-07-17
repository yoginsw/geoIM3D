let googleMapsApiKey: string | undefined;

/** Write-only package entry point used by the desktop host. */
export function setMapGoogleMapsApiKey(value: string | undefined): void {
  googleMapsApiKey = value?.trim() || undefined;
}

/** Internal renderer accessor; intentionally not exported from the package. */
export function readMapGoogleMapsApiKey(): string | undefined {
  return googleMapsApiKey;
}
