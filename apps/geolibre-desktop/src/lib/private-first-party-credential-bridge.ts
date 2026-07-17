import { setMapGoogleMapsApiKey } from "../../../../packages/map/src/private-credential-runtime";
import { setBuiltInPluginCredentials } from "../../../../packages/plugins/src/built-in-credential-runtime";

export interface FirstPartyCredentialEnvironment {
  VITE_GEOCODER_API_KEY?: string;
  VITE_GOOGLE_MAPS_API_KEY?: string;
  VITE_MAPILLARY_ACCESS_TOKEN?: string;
  VITE_TOMTOM_API_KEY?: string;
  VITE_HERE_API_KEY?: string;
  VITE_AMAZON_LOCATION_API_KEY?: string;
}

/** App-private, write-only injection for bundled first-party consumers. */
export function setFirstPartyCredentialEnvironment(
  env: FirstPartyCredentialEnvironment
): void {
  setBuiltInPluginCredentials(env);
  setMapGoogleMapsApiKey(env.VITE_GOOGLE_MAPS_API_KEY);
}
