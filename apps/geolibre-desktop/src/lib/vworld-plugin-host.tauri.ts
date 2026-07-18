import { createVWorld2DPlugin } from "@geolibre/plugins";
import {
  getMapInstances,
  subscribeMapInstances,
} from "@geolibre/map/map-instance-registry";
import type { VWorldMapLike } from "@geolibre/map/vworld-ephemeral-layer";

import { vworldDesktopClient } from "./vworld-desktop-client";

const VWORLD_CREDENTIAL_ID = "vworld:api-key";

function getVWorldMaps(): readonly VWorldMapLike[] {
  return getMapInstances() as unknown as readonly VWorldMapLike[];
}

function subscribeCredentialDisposal(listener: () => void): () => void {
  const onCredential = (event: Event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id === VWORLD_CREDENTIAL_ID) listener();
  };
  const onClear = () => listener();
  window.addEventListener("geoim3d:credential-deleted", onCredential);
  window.addEventListener("geoim3d:credential-replaced", onCredential);
  window.addEventListener("geoim3d:credentials-cleared", onClear);
  return () => {
    window.removeEventListener("geoim3d:credential-deleted", onCredential);
    window.removeEventListener("geoim3d:credential-replaced", onCredential);
    window.removeEventListener("geoim3d:credentials-cleared", onClear);
  };
}

export const vworldBuiltInPlugin = createVWorld2DPlugin({
  desktop: true,
  dataClient: vworldDesktopClient,
  getMaps: getVWorldMaps,
  searchClient: vworldDesktopClient,
  subscribeMaps: subscribeMapInstances,
  subscribeCredentialDisposal,
  transport: (request, signal) => vworldDesktopClient.tile(request, signal),
});
