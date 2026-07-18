import {
  VWorldEphemeralLayerController,
  type VWorldMapLike,
  type VWorldProtocolRuntime,
  type VWorldRasterLayer,
  type VWorldTileTransport,
} from "@geolibre/map/vworld-ephemeral-layer";

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const VWORLD_2D_PLUGIN_ID = "geoim3d-vworld-2d";

interface VWorld2DPluginOptions {
  desktop: boolean;
  transport: VWorldTileTransport;
  protocol?: VWorldProtocolRuntime;
  getMaps?: () => readonly VWorldMapLike[];
  subscribeMaps?: (listener: () => void) => () => void;
  subscribeCredentialDisposal?: (listener: () => void) => () => void;
}

const ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  layer: VWorldRasterLayer;
}> = [
  { id: "base", label: "기본 지도", layer: "Base" },
  { id: "white", label: "백지도", layer: "white" },
  { id: "midnight", label: "야간 지도", layer: "midnight" },
  { id: "hybrid", label: "하이브리드", layer: "Hybrid" },
];

export function createVWorld2DPlugin(
  options: VWorld2DPluginOptions,
): GeoLibrePlugin {
  const controllers = new Map<VWorldMapLike, VWorldEphemeralLayerController>();
  let activated = false;
  let activeLayer: VWorldRasterLayer | null = null;
  let unregisterMenu: (() => void) | null = null;
  let unsubscribeMaps: (() => void) | null = null;
  let unsubscribeCredentialDisposal: (() => void) | null = null;

  const reconcileMaps = (app: GeoLibreAppAPI) => {
    const primary = app.getMap?.() as unknown as VWorldMapLike | undefined;
    const maps = options.getMaps?.() ?? (primary ? [primary] : []);
    const desired = new Set(maps);

    for (const [map, controller] of controllers) {
      if (desired.has(map)) continue;
      controller.dispose();
      controllers.delete(map);
    }
    for (const map of desired) {
      if (controllers.has(map)) continue;
      const controller = new VWorldEphemeralLayerController({
        desktop: true,
        map,
        protocol: options.protocol,
        transport: options.transport,
      });
      controllers.set(map, controller);
      if (activeLayer) controller.activate(activeLayer);
    }
  };

  const selectLayer = (app: GeoLibreAppAPI, layer: VWorldRasterLayer) => {
    activeLayer = layer;
    reconcileMaps(app);
    for (const controller of controllers.values()) controller.activate(layer);
  };

  const clearLayer = () => {
    activeLayer = null;
    for (const controller of controllers.values()) controller.deactivate();
  };

  return {
    id: VWORLD_2D_PLUGIN_ID,
    name: "VWorld 2D 지도",
    version: "1.0.0",
    activate(app: GeoLibreAppAPI) {
      if (!options.desktop || activated || !app.registerToolbarMenu) return false;
      if (!options.getMaps && !app.getMap?.()) return false;

      activated = true;
      reconcileMaps(app);
      unsubscribeMaps = options.subscribeMaps?.(() => reconcileMaps(app)) ?? null;
      unsubscribeCredentialDisposal =
        options.subscribeCredentialDisposal?.(clearLayer) ?? null;
      unregisterMenu = app.registerToolbarMenu({
        id: "geoim3d-vworld-map-menu",
        label: "VWorld 지도",
        items: [
          ...ACTIONS.map(({ id, label, layer }) => ({
            id,
            label,
            onSelect: () => selectLayer(app, layer),
          })),
          { type: "separator" as const, id: "vworld-remove-separator" },
          {
            id: "remove",
            label: "VWorld 지도 제거",
            onSelect: clearLayer,
          },
        ],
      });
      return true;
    },
    deactivate() {
      unsubscribeCredentialDisposal?.();
      unsubscribeCredentialDisposal = null;
      unsubscribeMaps?.();
      unsubscribeMaps = null;
      unregisterMenu?.();
      unregisterMenu = null;
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
      activeLayer = null;
      activated = false;
    },
  };
}
