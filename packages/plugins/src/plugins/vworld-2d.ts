import {
  VWorldEphemeralLayerController,
  type VWorldMapLike,
  type VWorldProtocolRuntime,
  type VWorldRasterLayer,
  type VWorldTileTransport,
} from "@geolibre/map/vworld-ephemeral-layer";

import {
  VWorldDataLayerController,
  type VWorldDataMapLike,
} from "./vworld-data-layer";
import {
  mountVWorldDataPanel,
  type VWorldDataInteractiveMapLike,
} from "./vworld-data-panel";
import { VWorldDataSession, type VWorldDataClient } from "./vworld-data";
import {
  mountVWorldSearchPanel,
  type VWorldSearchMapLike,
} from "./vworld-search-panel";
import { VWorldSearchSession, type VWorldSearchClient } from "./vworld-search";

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const VWORLD_2D_PLUGIN_ID = "geoim3d-vworld-2d";

interface VWorld2DPluginOptions {
  desktop: boolean;
  transport: VWorldTileTransport;
  protocol?: VWorldProtocolRuntime;
  getMaps?: () => readonly VWorldMapLike[];
  subscribeMaps?: (listener: () => void) => () => void;
  subscribeCredentialDisposal?: (listener: () => void) => () => void;
  searchClient?: VWorldSearchClient;
  dataClient?: VWorldDataClient;
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
  { id: "satellite", label: "위성 지도", layer: "Satellite" },
];

export function createVWorld2DPlugin(
  options: VWorld2DPluginOptions
): GeoLibrePlugin {
  const controllers = new Map<VWorldMapLike, VWorldEphemeralLayerController>();
  const dataControllers = new Map<VWorldMapLike, VWorldDataLayerController>();
  let activated = false;
  let activeLayer: VWorldRasterLayer | null = null;
  let unregisterMenu: (() => void) | null = null;
  let unregisterSearchPanel: (() => void) | null = null;
  let unregisterDataPanel: (() => void) | null = null;
  let unsubscribeMaps: (() => void) | null = null;
  let unsubscribeDataSession: (() => void) | null = null;
  let unsubscribeCredentialDisposal: (() => void) | null = null;
  let searchSession: VWorldSearchSession | null = null;
  let dataSession: VWorldDataSession | null = null;

  const reconcileMaps = (app: GeoLibreAppAPI) => {
    const primary = app.getMap?.() as unknown as VWorldMapLike | undefined;
    const maps = options.getMaps?.() ?? (primary ? [primary] : []);
    const desired = new Set(maps);

    for (const [map, controller] of controllers) {
      if (desired.has(map)) continue;
      controller.dispose();
      controllers.delete(map);
    }
    for (const [map, controller] of dataControllers) {
      if (desired.has(map)) continue;
      controller.dispose();
      dataControllers.delete(map);
    }
    for (const map of desired) {
      if (!controllers.has(map)) {
        const controller = new VWorldEphemeralLayerController({
          desktop: true,
          map,
          protocol: options.protocol,
          transport: options.transport,
        });
        controllers.set(map, controller);
        if (activeLayer) controller.activate(activeLayer);
      }
      if (options.dataClient && !dataControllers.has(map)) {
        const controller = new VWorldDataLayerController(
          map as unknown as VWorldDataMapLike
        );
        dataControllers.set(map, controller);
        const snapshot = dataSession?.getSnapshot();
        if (snapshot?.cadastral) controller.setCadastral(snapshot.cadastral);
        if (snapshot?.zoning && snapshot.zoningService) {
          controller.setZoning(snapshot.zoning, snapshot.zoningService);
        }
      }
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

  const syncDataLayers = () => {
    const snapshot = dataSession?.getSnapshot();
    for (const controller of dataControllers.values()) {
      if (snapshot?.cadastral) controller.setCadastral(snapshot.cadastral);
      else controller.clearCadastral();
      if (snapshot?.zoning && snapshot.zoningService) {
        controller.setZoning(snapshot.zoning, snapshot.zoningService);
      } else {
        controller.clearZoning();
      }
    }
  };

  const clearConsumers = () => {
    clearLayer();
    searchSession?.clear();
    dataSession?.clear();
  };

  return {
    id: VWORLD_2D_PLUGIN_ID,
    name: "VWorld 2D 지도",
    version: "1.0.0",
    activate(app: GeoLibreAppAPI) {
      if (!options.desktop || activated || !app.registerToolbarMenu)
        return false;
      if (!options.getMaps && !app.getMap?.()) return false;

      activated = true;
      if (options.dataClient) {
        dataSession = new VWorldDataSession(options.dataClient);
        unsubscribeDataSession = dataSession.subscribe(syncDataLayers);
      }
      reconcileMaps(app);
      unsubscribeMaps =
        options.subscribeMaps?.(() => reconcileMaps(app)) ?? null;
      if (options.searchClient && app.registerFloatingPanel) {
        searchSession = new VWorldSearchSession(options.searchClient);
        unregisterSearchPanel = app.registerFloatingPanel({
          id: "geoim3d-vworld-search-panel",
          title: "VWorld 검색·주소 변환",
          defaultWidth: 360,
          defaultHeight: 520,
          position: "top-left",
          render: (container) =>
            mountVWorldSearchPanel(container, {
              session: searchSession!,
              getMaps: () => {
                const primary = app.getMap?.() as unknown as
                  | VWorldSearchMapLike
                  | undefined;
                return (options.getMaps?.() ??
                  (primary ? [primary] : [])) as readonly VWorldSearchMapLike[];
              },
            }),
        });
      }
      if (dataSession && app.registerFloatingPanel) {
        unregisterDataPanel = app.registerFloatingPanel({
          id: "geoim3d-vworld-data-panel",
          title: "VWorld 지적·용도지역",
          defaultWidth: 380,
          defaultHeight: 560,
          position: "top-left",
          render: (container) =>
            mountVWorldDataPanel(container, {
              session: dataSession!,
              getMaps: () => {
                const primary = app.getMap?.() as unknown as
                  | VWorldDataInteractiveMapLike
                  | undefined;
                return (options.getMaps?.() ??
                  (primary
                    ? [primary]
                    : [])) as readonly VWorldDataInteractiveMapLike[];
              },
            }),
        });
      }
      unsubscribeCredentialDisposal =
        options.subscribeCredentialDisposal?.(clearConsumers) ?? null;
      unregisterMenu = app.registerToolbarMenu({
        id: "geoim3d-vworld-map-menu",
        label: "VWorld 지도",
        items: [
          ...ACTIONS.map(({ id, label, layer }) => ({
            id,
            label,
            onSelect: () => selectLayer(app, layer),
          })),
          ...(searchSession || dataSession
            ? [
                { type: "separator" as const, id: "vworld-tools-separator" },
                ...(searchSession
                  ? [
                      {
                        id: "search-address",
                        label: "검색·주소 변환",
                        onSelect: () =>
                          app.openFloatingPanel?.(
                            "geoim3d-vworld-search-panel"
                          ),
                      },
                    ]
                  : []),
                ...(dataSession
                  ? [
                      {
                        id: "data-layers",
                        label: "지적·용도지역",
                        onSelect: () =>
                          app.openFloatingPanel?.("geoim3d-vworld-data-panel"),
                      },
                    ]
                  : []),
              ]
            : []),
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
      unregisterSearchPanel?.();
      unregisterSearchPanel = null;
      unregisterDataPanel?.();
      unregisterDataPanel = null;
      unregisterMenu?.();
      unregisterMenu = null;
      searchSession?.clear();
      searchSession = null;
      dataSession?.clear();
      dataSession = null;
      unsubscribeDataSession?.();
      unsubscribeDataSession = null;
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
      for (const controller of dataControllers.values()) controller.dispose();
      dataControllers.clear();
      activeLayer = null;
      activated = false;
    },
  };
}
