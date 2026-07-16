import { getCesiumIonToken, useAppStore } from "@geolibre/core";
import {
  CesiumCanvas,
  isCesiumSupportedLayerType,
  SecondaryMapCanvas,
} from "@geolibre/map";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { Globe, Layers, Map as MapIcon, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  isGeoIm3dProductMapWorkspaceEnabled,
  PRODUCT_PROFILE,
} from "../../config/product-profile";

/**
 * The current Cesium Ion token, re-resolved whenever the runtime environment
 * changes. It can come from the build (the `CESIUM_TOKEN` env var) or from
 * Settings → Environment variables (`VITE_CESIUM_TOKEN`), so the 3D-globe view
 * can use premium Cesium World Imagery + Terrain with no rebuild. Without a
 * token, the globe remains available through Cesium's OpenStreetMap fallback.
 */
function useCesiumIonToken(): string | undefined {
  const [token, setToken] = useState<string | undefined>(() =>
    getCesiumIonToken(),
  );
  useEffect(() => {
    const refresh = () => setToken(getCesiumIonToken());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () =>
      window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return token;
}

/**
 * An editable label shown centered at the top of a map pane. Empty by default;
 * users type a custom name (e.g. a date or scenario) to tell panes apart.
 */
function PaneLabel({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  return (
    // The wrapper is click-through so it never blocks map interaction; only the
    // centered field itself is interactive. `max-w` keeps it clear of the
    // top-left and top-right control clusters.
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        placeholder={t("mapGrid.labelPlaceholder")}
        className="pointer-events-auto h-7 w-32 max-w-[40%] rounded-md border border-input bg-background/90 px-2 text-center text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none"
      />
    </div>
  );
}

interface MapGridProps {
  /** The primary map pane (MapCanvas plus its overlays), rendered in cell 0. */
  children: ReactNode;
}

/**
 * Lays out the workspace's map panes.
 *
 * With a single pane (the default) it renders the primary map untouched, so the
 * normal single-map DOM and behavior are unchanged. With a larger grid it tiles
 * the primary map plus one {@link SecondaryMapCanvas} per `secondaryMapViews`
 * entry into a CSS grid. Every pane shares the primary's basemap and layers;
 * each secondary pane carries a layer-visibility toggle so it can show a
 * different subset of the shared layers, plus a button to drop the pane. Camera
 * sync between panes is handled inside the canvases (via the shared global
 * `mapView`); this component only owns layout and chrome.
 */
export function MapGrid({ children }: MapGridProps) {
  const { t } = useTranslation();
  const rows = useAppStore((s) => s.mapLayout.rows);
  const cols = useAppStore((s) => s.mapLayout.cols);
  const secondaryMapViews = useAppStore((s) => s.secondaryMapViews);
  const primaryMapLabel = useAppStore((s) => s.primaryMapLabel);
  const setPrimaryMapLabel = useAppStore((s) => s.setPrimaryMapLabel);
  const cesiumToken = useCesiumIonToken();

  if (rows * cols <= 1) {
    if (!isGeoIm3dProductMapWorkspaceEnabled()) return <>{children}</>;
    return (
      <TabbedMapWorkspace cesiumToken={cesiumToken}>
        {children}
      </TabbedMapWorkspace>
    );
  }

  return (
    <div
      className="grid h-full w-full gap-0.5 bg-border"
      style={{
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
      data-testid="map-grid"
    >
      <div className="relative isolate min-h-0 min-w-0 overflow-hidden bg-background">
        {children}
        <PaneLabel
          value={primaryMapLabel}
          onChange={setPrimaryMapLabel}
          ariaLabel={t("mapGrid.labelLabel", { number: 1 })}
        />
      </div>
      {secondaryMapViews.map((pane, index) => (
        <SecondaryMapPane
          key={pane.id}
          viewId={pane.id}
          index={index}
          cesiumToken={cesiumToken}
        />
      ))}
    </div>
  );
}

type MapWorkspaceTab = "maplibre" | "cesium";

function TabbedMapWorkspace({
  children,
  cesiumToken,
}: {
  children: ReactNode;
  cesiumToken?: string;
}) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<MapWorkspaceTab>(
    PRODUCT_PROFILE.defaultMapTab,
  );
  const tabs: Array<{
    id: MapWorkspaceTab;
    label: string;
    icon: typeof MapIcon;
  }> = [
    { id: "maplibre", label: t("mapGrid.mapLibre2d"), icon: MapIcon },
    { id: "cesium", label: t("mapGrid.cesium3d"), icon: Globe },
  ];

  const selectTab = (tab: MapWorkspaceTab, focus = false) => {
    setActiveTab(tab);
    if (focus) {
      requestAnimationFrame(() =>
        document.getElementById(`map-view-tab-${tab}`)?.focus(),
      );
    }
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectTab(tabs[nextIndex].id, true);
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-testid="map-view-tabs"
    >
      <div
        role="tablist"
        aria-label={t("mapGrid.viewMode")}
        className="absolute left-1/2 top-2 z-30 flex -translate-x-1/2 rounded-lg border border-border bg-background/95 p-1 shadow-md backdrop-blur"
      >
        {tabs.map((tab, index) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`map-view-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`map-view-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
                selected
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id="map-view-panel-maplibre"
        role="tabpanel"
        aria-labelledby="map-view-tab-maplibre"
        aria-hidden={activeTab !== "maplibre"}
        className={`absolute inset-0 ${
          activeTab === "maplibre"
            ? "visible"
            : "invisible pointer-events-none"
        }`}
      >
        {children}
      </div>
      <div
        id="map-view-panel-cesium"
        role="tabpanel"
        aria-labelledby="map-view-tab-cesium"
        aria-hidden={activeTab !== "cesium"}
        className={`absolute inset-0 ${
          activeTab === "cesium"
            ? "visible"
            : "invisible pointer-events-none"
        }`}
      >
        <CesiumCanvas
          ionToken={cesiumToken}
          active={activeTab === "cesium"}
        />
      </div>
    </div>
  );
}

interface SecondaryMapPaneProps {
  viewId: string;
  /** Zero-based index among secondary panes, shown in the pane label. */
  index: number;
  /** Optional Cesium Ion token; tokenless views use Cesium's OSM fallback. */
  cesiumToken?: string;
}

function SecondaryMapPane({ viewId, index, cesiumToken }: SecondaryMapPaneProps) {
  const { t } = useTranslation();
  const removeSecondaryMapView = useAppStore((s) => s.removeSecondaryMapView);
  const setSecondaryMapLabel = useAppStore((s) => s.setSecondaryMapLabel);
  const setSecondaryViewKind = useAppStore((s) => s.setSecondaryViewKind);
  const label = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.label ?? "",
  );
  // Absent viewKind means the default 2D map (back-compat with older panes).
  const wantsCesium = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.viewKind === "cesium",
  );
  const is3d = wantsCesium;

  return (
    <div className="relative isolate min-h-0 min-w-0 overflow-hidden bg-background">
      {is3d ? (
        // Key on the token so changing the Cesium Ion token in Settings remounts
        // the globe: `Cesium.Ion.defaultAccessToken` is applied once at viewer
        // creation, so without a remount a swapped (e.g. corrected) token would
        // never take effect on an already-mounted pane.
        <CesiumCanvas key={cesiumToken} viewId={viewId} ionToken={cesiumToken} />
      ) : (
        <SecondaryMapCanvas viewId={viewId} />
      )}
      <PaneLabel
        value={label}
        onChange={(value) => setSecondaryMapLabel(viewId, value)}
        ariaLabel={t("mapGrid.labelLabel", { number: index + 2 })}
      />
      <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
        {/* Both the 2D map and the 3D globe render the shared layers, so the
            per-pane layer-visibility toggle applies to either. */}
        <PaneLayerToggle viewId={viewId} index={index} is3d={is3d} />
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
          aria-label={
            is3d
              ? t("mapGrid.show2d", { number: index + 2 })
              : t("mapGrid.show3d", { number: index + 2 })
          }
          aria-pressed={is3d}
          onClick={() =>
            setSecondaryViewKind(viewId, is3d ? "maplibre" : "cesium")
          }
        >
          {is3d ? (
            <MapIcon className="h-4 w-4" />
          ) : (
            <Globe className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t("mapGrid.removePane", { number: index + 2 })}
          onClick={() => removeSecondaryMapView(viewId)}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface PaneLayerToggleProps {
  viewId: string;
  index: number;
  /** When true this is a 3D-globe pane, so layers it can't render are flagged. */
  is3d: boolean;
}

/**
 * A dropdown of the shared layers with a checkbox each, controlling which layers
 * are visible in this pane. A layer's checkbox reflects its effective visibility
 * (the pane's override, or the primary map's visibility when not overridden). On
 * a 3D-globe pane, layer kinds the globe cannot render are tagged "2D only".
 */
function PaneLayerToggle({ viewId, index, is3d }: PaneLayerToggleProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const layerVisibility = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.layerVisibility,
  );
  const setSecondaryLayerVisibility = useAppStore(
    (s) => s.setSecondaryLayerVisibility,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 bg-background/90 px-2 shadow-sm"
          aria-label={t("mapGrid.layersLabel", { number: index + 2 })}
        >
          <Layers className="h-3.5 w-3.5" />
          {t("mapGrid.layers")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>{t("mapGrid.layers")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {layers.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {t("mapGrid.noLayers")}
          </div>
        ) : (
          layers.map((layer) => {
            const override = layerVisibility?.[layer.id];
            const visible = override === undefined ? layer.visible : override;
            const only2d = is3d && !isCesiumSupportedLayerType(layer);
            return (
              <DropdownMenuCheckboxItem
                key={layer.id}
                indicator="box"
                checked={visible}
                onCheckedChange={(checked: boolean) =>
                  setSecondaryLayerVisibility(viewId, layer.id, checked)
                }
                // Keep the menu open so several layers can be toggled at once.
                onSelect={(event: Event) => event.preventDefault()}
              >
                <span className="truncate">{layer.name}</span>
                {only2d ? (
                  <span className="ms-auto shrink-0 ps-2 text-xs text-muted-foreground">
                    {t("mapGrid.only2d")}
                  </span>
                ) : null}
              </DropdownMenuCheckboxItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
