import {
  resolveThreeDTilesRequestHeaders,
  type GeoLibreLayer,
} from "@geolibre/core";
import type {
  Cesium3DTileset,
  DataSource,
  ImageryLayer,
  Model,
  Viewer,
} from "cesium";
import { readMapGoogleMapsApiKey } from "./private-credential-runtime";

// Reconciles the store's `GeoLibreLayer[]` onto a Cesium globe, mirroring what
// MapController.syncLayers does for MapLibre. M3 covers the layer kinds where
// Cesium is the natural renderer: GeoJSON (as a draped GeoJsonDataSource), XYZ /
// WMS / WMTS / raster tiles (as ImageryLayers), and 3D Tiles (as a
// Cesium3DTileset). Other kinds are skipped on the globe (they still render in
// the 2D panes); the exported `isCesiumSupportedLayerType` lets the UI flag them.
//
// The engine is injected (the `Cesium` namespace + a `Viewer`) so this module
// carries only type-only Cesium imports and never pulls the engine into the
// build graph itself.

type CesiumNs = typeof import("cesium");

/** Layer kinds this pass renders on the globe. */
const IMAGERY_TYPES = new Set(["raster", "xyz", "wms", "wmts"]);

type EntryKind = "imagery" | "geojson" | "3dtiles" | "model";

export type CesiumLayerRuntimeState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "placeholder"; error: string }
  | { status: "error"; error: string };

interface LayerEntry {
  kind: EntryKind;
  /** The layer as last applied, for change detection. */
  layer: GeoLibreLayer;
  /** The Cesium object, or null while an async create is in flight. */
  handle: ImageryLayer | DataSource | Cesium3DTileset | Model | null;
  /** Set when the entry is removed mid-load so the resolved handle is discarded. */
  cancelled: boolean;
  /** Stable runtime state for the layer panel/placeholder seam. */
  runtimeState: CesiumLayerRuntimeState;
  /** Last opacity key applied in place to a geojson entry (skips redundant restyles). */
  appliedAlpha?: string;
}

const SCENE_PRESET_BLOCKED_STATUSES = new Set(["unresolved", "error"]);

function scenePresetRuntimeState(
  layer: GeoLibreLayer
): Extract<CesiumLayerRuntimeState, { status: "placeholder" | "error" }> | undefined {
  const sourceStatus = layer.source.scenePresetStatus;
  const metadataStatus = layer.metadata.scenePresetStatus;
  const status =
    typeof sourceStatus === "string"
      ? sourceStatus
      : typeof metadataStatus === "string"
        ? metadataStatus
        : undefined;
  if (!status || !SCENE_PRESET_BLOCKED_STATUSES.has(status)) return undefined;

  const error =
    (typeof layer.metadata.scenePresetError === "string" &&
      layer.metadata.scenePresetError) ||
    (status === "unresolved"
      ? "SCENE_PRESET_REMOTE_UNAVAILABLE"
      : "SCENE_PRESET_ERROR");
  return status === "unresolved"
    ? { status: "placeholder", error }
    : { status: "error", error };
}

/** True when a scene-preset layer is intentionally not materialized for Cesium. */
export function isCesiumScenePresetBlockedLayer(layer: GeoLibreLayer): boolean {
  return scenePresetRuntimeState(layer) !== undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function firstTile(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source.tiles;
  return Array.isArray(tiles) ? str(tiles[0]) : undefined;
}

function tilesetUrl(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

interface ScenePresetPlacement {
  longitude: number;
  latitude: number;
  altitudeMeters: number;
  bearingDegrees: number;
  scale: number;
}

function scenePresetPlacement(layer: GeoLibreLayer): ScenePresetPlacement | undefined {
  const value = layer.source.scenePresetPlacement;
  if (typeof value !== "object" || value === null) return undefined;
  const placement = value as Record<string, unknown>;
  const fields = [
    placement.longitude,
    placement.latitude,
    placement.altitudeMeters,
    placement.bearingDegrees,
    placement.scale,
  ];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field))) {
    return undefined;
  }
  return value as ScenePresetPlacement;
}

function placementSignature(layer: GeoLibreLayer): string {
  return JSON.stringify(scenePresetPlacement(layer) ?? null);
}

function preservesGeoJsonAltitude(layer: GeoLibreLayer): boolean {
  const alignment = layer.metadata.coordinateAlignment;
  return (
    typeof alignment === "object" &&
    alignment !== null &&
    "sourceFormat" in alignment &&
    alignment.sourceFormat === "DXF"
  );
}

/**
 * Whether the globe can render this layer *kind* at all (regardless of whether
 * its data has loaded yet). Exported so the UI can flag "2D only" layers on a
 * globe pane. See the module header for the supported kinds.
 */
export function isCesiumSupportedLayerType(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" ||
    layer.type === "3d-tiles" ||
    (layer.type === "gaussian-splat" && layer.source.assetType === "model") ||
    IMAGERY_TYPES.has(layer.type)
  );
}

/** Whether this layer can render on the globe now (kind supported + data ready). */
function isSupported(layer: GeoLibreLayer): boolean {
  if (!isCesiumSupportedLayerType(layer)) return false;
  if (layer.type === "geojson") return Boolean(layer.geojson?.features?.length);
  if (layer.type === "3d-tiles") return Boolean(tilesetUrl(layer));
  if (layer.type === "gaussian-splat") return Boolean(tilesetUrl(layer));
  // Mirror createImagery's real capability: WMS builds from source.url, but
  // xyz/raster/wmts need a tile template — a url alone would render nothing.
  return layer.type === "wms"
    ? Boolean(str(layer.source.url))
    : Boolean(firstTile(layer));
}

function entryKind(layer: GeoLibreLayer): EntryKind {
  if (layer.type === "geojson") return "geojson";
  if (layer.type === "3d-tiles") return "3dtiles";
  if (layer.type === "gaussian-splat") return "model";
  return "imagery";
}

// Fill/stroke *colours*, stroke width, and marker colour bake into the GeoJSON
// entities at load, so a change to any of them forces a rebuild. Opacity
// (layer.opacity × fill opacity) is deliberately excluded: it is re-applied in
// place by applyGeoJsonStyle, so dragging the opacity slider restyles the fill
// alpha instead of reloading the whole GeoJsonDataSource on every tick.
function styleSignature(layer: GeoLibreLayer): string {
  const style = layer.style ?? {};
  return [
    style.fillColor,
    style.strokeColor,
    style.strokeWidth,
    style.markerColor,
  ].join("|");
}

/**
 * Whether the Cesium object must be rebuilt (vs. just re-styled) for the change
 * from `prev` to `next`. Live-settable appearance (visibility, imagery alpha) is
 * excluded; only source/data/geometry changes force a rebuild. The GeoJSON
 * FeatureCollection is compared by reference (the store swaps it on edit) and
 * its fill/stroke colours bake into the Cesium colours at load, so a colour
 * change rebuilds; opacity is restyled in place (see styleSignature).
 */
function needsRebuild(prev: GeoLibreLayer, next: GeoLibreLayer): boolean {
  if (prev.type !== next.type) return true;
  switch (entryKind(next)) {
    case "geojson":
      return (
        prev.geojson !== next.geojson ||
        styleSignature(prev) !== styleSignature(next) ||
        preservesGeoJsonAltitude(prev) !== preservesGeoJsonAltitude(next)
      );
    case "imagery":
      return (
        firstTile(prev) !== firstTile(next) ||
        // min/maxzoom bake into UrlTemplateImageryProvider's min/maximumLevel.
        prev.source.maxzoom !== next.source.maxzoom ||
        prev.source.minzoom !== next.source.minzoom ||
        str(prev.source.url) !== str(next.source.url) ||
        str(prev.source.layers) !== str(next.source.layers) ||
        // WMS GetMap params baked into the provider at creation; a change must
        // rebuild it so the globe doesn't keep the stale WebMapServiceImageryProvider.
        str(prev.source.styles) !== str(next.source.styles) ||
        str(prev.source.format) !== str(next.source.format) ||
        str(prev.source.version) !== str(next.source.version) ||
        prev.source.transparent !== next.source.transparent
      );
    case "3dtiles":
    case "model":
      return (
        tilesetUrl(prev) !== tilesetUrl(next) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null) ||
        prev.source.altitudeOffset !== next.source.altitudeOffset ||
        placementSignature(prev) !== placementSignature(next)
      );
  }
}

export class CesiumLayerSync {
  private readonly entries = new Map<string, LayerEntry>();
  /** Imagery id order last asserted on the globe, to skip redundant reorders. */
  private lastImageryOrder = "";

  constructor(
    private readonly Cesium: CesiumNs,
    private readonly viewer: Viewer
  ) {}

  /** Reconcile the globe to `layers` (order preserved for imagery stacking). */
  sync(layers: GeoLibreLayer[]): void {
    const nextIds = new Set(layers.map((l) => l.id));
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this.destroyEntry(entry);
        this.entries.delete(id);
      }
    }

    // Tracks a create/rebuild of an imagery layer this pass (which re-appends it
    // to the top), so the reorder pass below runs even when the store id order
    // is unchanged.
    let imageryRebuilt = false;
    for (const layer of layers) {
      const blockedState = scenePresetRuntimeState(layer);
      if (blockedState) {
        const existing = this.entries.get(layer.id);
        if (existing) {
          this.destroyEntry(existing);
          this.entries.delete(layer.id);
        }
        // Use a fresh entry. Reusing the old entry would reset `cancelled` and
        // allow an in-flight async loader to attach after placeholder publish.
        this.createEntry(layer, blockedState);
        continue;
      }

      if (!isSupported(layer)) {
        // A previously-supported layer that became unrenderable (e.g. its data
        // was cleared) is torn down.
        const stale = this.entries.get(layer.id);
        if (stale) {
          this.destroyEntry(stale);
          this.entries.delete(layer.id);
        }
        continue;
      }

      const existing = this.entries.get(layer.id);
      if (!existing) {
        this.createEntry(layer);
        if (entryKind(layer) === "imagery") imageryRebuilt = true;
      } else if (needsRebuild(existing.layer, layer)) {
        this.destroyEntry(existing);
        this.entries.delete(layer.id);
        this.createEntry(layer);
        if (entryKind(layer) === "imagery") imageryRebuilt = true;
      } else {
        existing.layer = layer;
        this.applyAppearance(existing);
      }
    }

    // addImageryProvider always appends to the top, so a rebuild/create re-adds
    // imagery above its store neighbours, and a panel reorder (which doesn't
    // rebuild) changes the intended order without touching the globe. Re-assert
    // store order by raising each imagery layer to the top in turn (the base
    // imagery, never raised, stays at the bottom) — but only when the order
    // could actually have changed. sync() also runs on unrelated changes (e.g.
    // an opacity drag), and each raiseToTop is O(n), so reordering every time
    // would be a needless O(n²) on that hot path.
    const imageryOrder = layers
      .filter((l) => {
        const entry = this.entries.get(l.id);
        return entry?.kind === "imagery" && entry.handle !== null;
      })
      .map((l) => l.id)
      .join("\n");
    if (imageryRebuilt || imageryOrder !== this.lastImageryOrder) {
      for (const layer of layers) {
        const entry = this.entries.get(layer.id);
        if (entry?.kind === "imagery" && entry.handle) {
          this.viewer.imageryLayers.raiseToTop(entry.handle as ImageryLayer);
        }
      }
      this.lastImageryOrder = imageryOrder;
    }
  }

  /** Stable state for the layer-panel/placeholder runtime seam. */
  getLayerRuntimeState(id: string): CesiumLayerRuntimeState | undefined {
    return this.entries.get(id)?.runtimeState;
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
  }

  private createEntry(
    layer: GeoLibreLayer,
    blockedState = scenePresetRuntimeState(layer),
  ): void {
    const kind = entryKind(layer);
    const entry: LayerEntry = {
      kind,
      layer,
      handle: null,
      cancelled: false,
      runtimeState: blockedState ?? { status: "loading" },
    };
    this.entries.set(layer.id, entry);
    if (blockedState) return;
    if (kind === "imagery") this.createImagery(entry);
    else if (kind === "geojson") void this.createGeoJson(entry);
    else if (kind === "3dtiles") void this.createTileset(entry);
    else void this.createModel(entry);
  }

  private createImagery(entry: LayerEntry): void {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    try {
      let provider;
      if (layer.type === "wms" && str(layer.source.url)) {
        // Pass through the same GetMap params the 2D path records on the layer
        // (WmsSource.tsx), so a non-default style/format/version or an opaque
        // (transparent:false) overlay renders the same on the globe as on the map.
        provider = new Cesium.WebMapServiceImageryProvider({
          url: String(layer.source.url),
          layers: String(layer.source.layers ?? ""),
          parameters: {
            transparent: layer.source.transparent !== false,
            format: str(layer.source.format) ?? "image/png",
            styles: str(layer.source.styles) ?? "",
            version: str(layer.source.version) ?? "1.1.1",
          },
        });
      } else {
        const url = firstTile(layer);
        if (!url) return;
        const maxLevel = Number(layer.source.maxzoom);
        const minLevel = Number(layer.source.minzoom);
        provider = new Cesium.UrlTemplateImageryProvider({
          url,
          maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
          // Honour the service's min-zoom floor so the globe doesn't request
          // (and 404 on) tiles below the levels the service actually serves.
          minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
        });
      }
      // addImageryProvider appends above the base imagery (and earlier store
      // layers), so store order maps to Cesium's bottom-to-top stacking.
      const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      entry.handle = imageryLayer;
      entry.runtimeState = { status: "ready" };
      this.applyAppearance(entry);
    } catch {
      // A provider that throws synchronously (e.g. malformed WMS params) should
      // not abort the sync pass; mirror createGeoJson/createTileset's best-effort.
    }
  }

  private async createGeoJson(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    if (!layer.geojson) return;
    const style = layer.style ?? {};
    const fill = Cesium.Color.fromCssColorString(style.fillColor ?? "#3b82f6");
    const stroke = Cesium.Color.fromCssColorString(
      style.strokeColor ?? "#1e40af"
    );
    // Fold the layer + fill opacity into the fill colour (a GeoJsonDataSource has
    // no global alpha). A later opacity change re-applies this alpha in place
    // (applyGeoJsonStyle) rather than reloading the whole data source.
    const fillAlpha = (style.fillOpacity ?? 0.6) * layer.opacity;
    try {
      const dataSource = await Cesium.GeoJsonDataSource.load(layer.geojson, {
        stroke,
        strokeWidth: style.strokeWidth ?? 2,
        fill: fill.withAlpha(fillAlpha),
        markerColor: Cesium.Color.fromCssColorString(
          style.markerColor ?? "#3b82f6"
        ),
        clampToGround: !preservesGeoJsonAltitude(layer),
      });
      if (entry.cancelled) return;
      await viewer.dataSources.add(dataSource);
      if (entry.cancelled) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      entry.handle = dataSource;
      entry.runtimeState = { status: "ready" };
      // applyAppearance → applyGeoJsonStyle fades every entity kind (fill,
      // stroke, marker) by the layer opacity right after load, so points/lines
      // match the 2D map instead of rendering fully opaque.
      this.applyAppearance(entry);
    } catch {
      entry.runtimeState = { status: "error", error: "CESIUM_GEOJSON_LOAD_FAILED" };
      // A malformed FeatureCollection should not break the whole sync.
    }
  }

  private async createTileset(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    const url = tilesetUrl(layer);
    if (!url) return;
    // Google Photorealistic tiles strip their X-GOOG-API-KEY from the store, so
    // resolve it back (from runtime env) exactly as the 2D render path does —
    // otherwise the tileset would silently 401/403 and never render on the globe.
    const headers = resolveThreeDTilesRequestHeaders(
      url,
      layer.source.requestHeaders as Record<string, string> | undefined,
      readMapGoogleMapsApiKey()
    );
    const resource =
      headers && Object.keys(headers).length
        ? new Cesium.Resource({ url, headers })
        : url;
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {});
      if (entry.cancelled) {
        tileset.destroy();
        return;
      }
      const placementMatrix = this.createPlacementMatrix(layer);
      if (placementMatrix) tileset.modelMatrix = placementMatrix;
      viewer.scene.primitives.add(tileset);
      if (!placementMatrix) {
        this.applyTilesetAltitude(tileset, Number(layer.source.altitudeOffset));
      }
      entry.handle = tileset;
      entry.runtimeState = { status: "ready" };
      this.applyAppearance(entry);
    } catch {
      entry.runtimeState = { status: "error", error: "CESIUM_TILESET_LOAD_FAILED" };
      // A tileset that fails to load should not break the whole sync.
    }
  }

  private async createModel(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const url = tilesetUrl(entry.layer);
    if (!url) return;
    try {
      const modelMatrix = this.createPlacementMatrix(entry.layer);
      const model = await Cesium.Model.fromGltfAsync({
        url,
        ...(modelMatrix ? { modelMatrix } : {}),
      });
      if (entry.cancelled) {
        model.destroy();
        return;
      }
      viewer.scene.primitives.add(model);
      if (entry.cancelled) {
        viewer.scene.primitives.remove(model);
        return;
      }
      entry.handle = model;
      entry.runtimeState = { status: "ready" };
      this.applyAppearance(entry);
    } catch {
      entry.runtimeState = {
        status: "error",
        error: "CESIUM_MODEL_LOAD_FAILED",
      };
    }
  }

  private createPlacementMatrix(layer: GeoLibreLayer) {
    const placement = scenePresetPlacement(layer);
    if (!placement) return undefined;
    const { Cesium } = this;
    const origin = Cesium.Cartesian3.fromDegrees(
      placement.longitude,
      placement.latitude,
      placement.altitudeMeters
    );
    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(placement.bearingDegrees),
      0,
      0
    );
    const matrix = Cesium.Transforms.headingPitchRollToFixedFrame(origin, hpr);
    return Cesium.Matrix4.multiplyByUniformScale(
      matrix,
      placement.scale,
      matrix
    );
  }

  /** Raise/lower a tileset by an altitude offset (metres) at its centre. */
  private applyTilesetAltitude(tileset: Cesium3DTileset, offset: number): void {
    if (!Number.isFinite(offset) || offset === 0) return;
    const { Cesium } = this;
    const carto = Cesium.Cartographic.fromCartesian(
      tileset.boundingSphere.center
    );
    const surface = Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      0
    );
    const target = Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      offset
    );
    const translation = Cesium.Cartesian3.subtract(
      target,
      surface,
      new Cesium.Cartesian3()
    );
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
  }

  private applyAppearance(entry: LayerEntry): void {
    const { handle, layer } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      const imagery = handle as ImageryLayer;
      imagery.show = layer.visible;
      imagery.alpha = layer.opacity;
    } else if (entry.kind === "geojson") {
      (handle as DataSource).show = layer.visible;
      this.applyGeoJsonStyle(entry);
    } else if (entry.kind === "3dtiles") {
      (handle as Cesium3DTileset).show = layer.visible;
    } else {
      const model = handle as Model;
      model.show = layer.visible;
      model.color = this.Cesium.Color.WHITE.withAlpha(layer.opacity);
    }
  }

  /**
   * Re-apply a GeoJSON layer's opacity in place, so dragging the opacity slider
   * restyles the entities instead of reloading the whole GeoJsonDataSource.
   * Polygon fill uses layer opacity × fill opacity; polyline stroke and point
   * markers use the layer opacity alone (matching the 2D map, where opacity
   * fades lines and points too). Colours themselves bake in at load, so a colour
   * change still rebuilds; the `appliedAlpha` guard makes a no-op call cheap on
   * unrelated syncs.
   */
  private applyGeoJsonStyle(entry: LayerEntry): void {
    const dataSource = entry.handle as DataSource | null;
    if (!dataSource) return;
    const style = entry.layer.style ?? {};
    const opacity = entry.layer.opacity;
    const fillAlpha = (style.fillOpacity ?? 0.6) * opacity;
    // Key on both alphas so any opacity change is picked up (e.g. a lines-only
    // layer whose fill alpha never varies).
    const key = `${fillAlpha}|${opacity}`;
    if (entry.appliedAlpha === key) return;
    entry.appliedAlpha = key;
    const { Cesium } = this;
    const fill = Cesium.Color.fromCssColorString(
      style.fillColor ?? "#3b82f6"
    ).withAlpha(fillAlpha);
    const stroke = Cesium.Color.fromCssColorString(
      style.strokeColor ?? "#1e40af"
    ).withAlpha(opacity);
    // Point pins keep their baked-in colour; multiplying by white+alpha only
    // fades them.
    const marker = Cesium.Color.WHITE.withAlpha(opacity);
    for (const feature of dataSource.entities.values) {
      if (feature.polygon) {
        feature.polygon.material = new Cesium.ColorMaterialProperty(fill);
      }
      if (feature.polyline) {
        feature.polyline.material = new Cesium.ColorMaterialProperty(stroke);
      }
      if (feature.billboard) {
        feature.billboard.color = new Cesium.ConstantProperty(marker);
      }
    }
  }

  private destroyEntry(entry: LayerEntry): void {
    entry.cancelled = true;
    const { handle } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      this.viewer.imageryLayers.remove(handle as ImageryLayer, true);
    } else if (entry.kind === "geojson") {
      this.viewer.dataSources.remove(handle as DataSource, true);
    } else {
      this.viewer.scene.primitives.remove(handle as Cesium3DTileset);
    }
  }
}
