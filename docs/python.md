# Upstream Python/Jupyter compatibility reference

> This workspace is retained for local source compatibility and testing. It is
> not an approved geoIM3D distribution channel. This fork does not publish it
> to PyPI, Conda, Colab, or a hosted Jupyter service.

GeoLibre ships a Python package, **`geolibre`**, that embeds the full GeoLibre
app inside a Jupyter notebook cell as an [anywidget](https://anywidget.dev),
with a [leafmap](https://leafmap.org)-style API.

The widget loads the complete GeoLibre app (menus, panels, processing tools) in
an iframe. State syncs both ways through a single `.geoim3d.json` project, so
data you add from Python appears in the UI, and edits you make in the UI
(panning, zooming, adding layers) are readable back from Python.

## Local source setup

```bash
uv sync --project python --extra dev
uv run --project python pytest python/tests
```

Optional extras for `add_geojson()` from a GeoDataFrame and for reading **local**
vector files with `add_vector()` / `add_geoparquet()` / `add_flatgeobuf()` /
`add_shp()` (remote URLs for those formats need no extras):

Use `uv sync --project python --extra all --extra dev` when local GeoPandas and
Shapely compatibility coverage is needed.

## Quickstart

```python
from geolibre import Map

m = Map(center=(-100, 40), zoom=4)
m.add_geojson("https://example.com/data.geojson", name="Data")
m
```

The full GeoLibre UI renders in the cell. Add more data and drive the view:

```python
m.add_tile_layer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    name="OpenStreetMap",
    attribution="(c) OpenStreetMap contributors",
)
m.add_cog("https://example.com/dem.tif", name="DEM", colormap="terrain")
m.add_basemap("dark")
m.set_center(-120, 47, zoom=8)
```

`add_raster` / `add_cog` also accept a **local** GeoTIFF path on the kernel host:
the file is served by the bundled localhost server so the app can read it. This
is supported only when the browser and kernel share the same machine, such as
local Jupyter or VS Code. The served URL is session-scoped, so a saved project
does not restore that local raster in a later session.

Add markers and data-driven symbology without precomputing styles:

```python
m.add_marker(-122.4, 37.8, properties={"name": "San Francisco"})
m.add_marker_cluster([(-122.4, 37.8), (-122.3, 37.9), (-122.5, 37.7)])
m.add_choropleth(
    "https://example.com/counties.geojson",
    column="population",
    colormap="blues",
    scheme="quantile",
)
```

Add a legend, a colorbar, and a swipe (split-map) comparison:

```python
# A built-in land-cover legend, or your own {label: color} dict.
m.add_legend(builtin="nlcd")
m.add_legend(legend_dict={"Water": "#0000ff", "Land": "#00ff00"})

# A colorbar for a continuous raster.
m.add_colorbar(colormap="terrain", vmin=0, vmax=4000, label="Elevation", units="m")

# Compare two layers (or a layer against the basemap) with a swipe slider.
before = m.add_cog("https://example.com/before.tif", name="Before")
after = m.add_cog("https://example.com/after.tif", name="After")
m.split_map(before, after)
```

## Two-way sync

Because the project syncs both ways, you can pan or zoom the map in the UI and
then read the live state back from Python:

```python
proj = m.to_project()
proj["mapView"]["center"]              # reflects the live UI view
[layer["name"] for layer in proj["layers"]]
```

Save and reload projects, fully interchangeable with the desktop and web apps:

```python
m.save_project("my-map.geoim3d.json")

m2 = Map()
m2.load_project("my-map.geoim3d.json")
m2
```

## Map options

```python
Map(
    center=(-100, 40),   # [lng, lat]
    zoom=4,
    basemap="dark",      # a basemap name or a MapLibre style URL
    height="800px",
    layout="embed",      # "embed" (compact UI), "full" (desktop UI), or "maponly"
    theme="light",       # "light" or "dark"
)
```

## Interactive scripting

Beyond adding data, the widget can **query the live app and react to it** — the
same surface as the in-app [Python Console](user-guide/python-console.md). These
calls round-trip to the running map, so the map must be displayed first (show
`m` in a cell), then run the queries in a later cell.

```python
m.get_center()                 # live [lng, lat], reflecting UI pans/zooms
m.get_bounds()                 # [west, south, east, north]
m.fly_to(-122.4, 37.8, zoom=10)
m.identify(-122.4, 37.8)       # features at a point, like clicking the map

# Layer objects: read and mutate layers, read their features
for layer in m.layers:
    layer.opacity = 0.6
features = m.layers[0].get_features()   # list of GeoJSON Feature objects

# Run a processing algorithm; result layers are added to the map
m.list_algorithms()
m.run_algorithm("buffer", {"layer": layer_id, "distance": 1000})

# Read back what the user selected or drew on the map
m.get_selected_features()      # the clicked feature(s) as Feature objects
m.get_drawn_features()         # features sketched with the Geo Editor
m.user_rois                    # the drawn ROIs as a GeoJSON FeatureCollection
m.get_drawn_features(as_gdf=True)   # the same, as a GeoDataFrame (needs GeoPandas)

png = m.to_image()             # PNG bytes (or m.to_image("map.png"))
m.to_html("map.html")          # standalone HTML embedding the live project
```

React to user interaction with event callbacks:

```python
m.on_click(lambda e: print("clicked", e["lngLat"]))
m.on_selection_change(lambda e: print("selected", e))
m.on_layer_change(lambda e: print("layers", e["layerIds"]))
```

!!! note "Blocking queries"
    Interactive queries block the kernel until the app replies (via
    `jupyter_ui_poll`, installed automatically). Pass `timeout=` for slow calls,
    e.g. `m.run_algorithm(..., timeout=300)`.

## API reference

### Interactive queries, events & processing

| Method | Description |
| --- | --- |
| `get_view()` / `get_center()` / `get_bounds()` | Read the live camera / center / viewport bounds. |
| `fly_to(lng, lat, zoom=, bearing=, pitch=, duration=)` | Animate the camera. |
| `fit_bounds([w, s, e, n])` | Fit the camera to a bounding box. |
| `identify(lng, lat, layer_id=None)` | Query rendered features at a point. |
| `get_features(layer_id)` | A layer's features as `Feature` objects. |
| `get_selected_features(as_gdf=False)` | The feature(s) selected in the app, as `Feature` objects (or a GeoDataFrame). |
| `get_drawn_features(as_gdf=False)` / `user_rois` | Features drawn with the Geo Editor; `user_rois` returns them as a FeatureCollection. |
| `layers` / `get_layer(id)` | `Layer` handles (read state; set `name`/`visible`/`opacity`, `set_style`, `get_features`, `zoom_to`, `remove`). |
| `list_algorithms()` | Available processing algorithms (`id`, `parameters`, …). |
| `run_algorithm(id, parameters=None, timeout=)` | Run an algorithm; returns `{logs, resultLayerIds}`. |
| `to_image(path=None, timeout=)` | Capture the map as PNG bytes, or write to `path`. |
| `to_html(path=None, title=, width=, height=, app_url=)` | Export a standalone HTML page that embeds the current project; returns the HTML or writes to `path`. |
| `on(event, cb)` / `on_click` / `on_selection_change` / `on_layer_change` | Register event callbacks; returns an unsubscribe function. |
| `request(method, params=None, timeout=)` | Low-level command primitive behind the methods above. |

### Data, view & projects

| Method | Description |
| --- | --- |
| `Map(center, zoom, basemap=, height=, layout=, theme=)` | Create a map. |
| `add_geojson(data, name=, **style)` | Add GeoJSON from a dict, file path, URL, JSON string, or GeoDataFrame. |
| `add_marker(lng, lat, name=, properties=, **style)` | Add a single point marker (shown as a circle; `properties` appear on click). |
| `add_markers(points, name=, **style)` | Add point markers from `(lng, lat)` pairs, `{lng/lon/x, lat/y, …}` dicts, GeoJSON, or a GeoDataFrame. |
| `add_circle_markers(points, name=, radius=, **style)` | Add circle markers with an explicit `radius`. |
| `add_marker_cluster(points, name=, cluster_radius=, cluster_max_zoom=, **style)` | Add clustered point markers. |
| `add_choropleth(data, column, name=, class_count=, colormap=, scheme=, **style)` | Add a GeoJSON layer with graduated symbology computed from a numeric `column`. |
| `add_data(data, column=None, name=, **kwargs)` | Add data; a choropleth when `column` is given, else a plain GeoJSON layer (leafmap parity). |
| `add_vector(data, name=, render_mode=, data_format=, source_layer=, **style)` | Add a vector dataset from a URL (GeoParquet, FlatGeobuf, zipped Shapefile, GeoJSON, …) or a local file (read via GeoPandas and inlined). |
| `add_geoparquet(data, name=, **style)` | Add a GeoParquet dataset (URL or local file). |
| `add_flatgeobuf(data, name=, **style)` | Add a FlatGeobuf dataset (URL or local file). |
| `add_shp(data, name=, **style)` | Add a Shapefile (zipped URL or local `.shp`). |
| `add_vector_tiles(url, name=, source_layers=, source_layer=, **style)` | Add a vector tile layer from a TileJSON endpoint. |
| `add_pmtiles(url, name=, tile_type=, source_layers=, **style)` | Add a PMTiles archive (vector or raster). |
| `add_tile_layer(url, name=, tile_size=, attribution=)` | Add a raster XYZ tile layer. |
| `add_wms(endpoint, layers, name=, styles=, image_format=, transparent=, tile_size=, **style)` | Add a WMS layer (GetMap, tiled raster). |
| `add_wmts(url, name=, tile_size=, **style)` | Add a WMTS layer from a tile URL template. |
| `add_wfs(endpoint, type_name, name=, version=, output_format=, srs_name=, max_features=, **style)` | Add a WFS layer (GetFeature GeoJSON, fetched and inlined). |
| `add_cog(url, name=, bands=, colormap=, rescale=, **style)` | Add a Cloud Optimized GeoTIFF (URL or a kernel-side local GeoTIFF path). |
| `add_raster(url, name=, bands=, colormap=, rescale=, **style)` | Add a raster (COG/GeoTIFF), URL or local path; alias of `add_cog`. |
| `add_3d_tiles(url, name=, altitude_offset=, request_headers=, **style)` | Add a 3D Tiles `tileset.json`. |
| `add_video(urls, coordinates, name=, **style)` | Add a georeferenced video (four `[lng, lat]` corners). |
| `add_basemap(basemap)` | Set the background basemap. |
| `split_map(left_layers=None, right_layers=None, orientation=, position=, control_position=)` | Add a swipe (split-map) comparison slider between two layer sets. |
| `add_legend(title=None, legend_dict=, labels=, colors=, builtin=, position=, shape=)` | Add a legend from a `{label: color}` dict, parallel `labels`/`colors`, or a `builtin` preset (`"nlcd"`, `"esa_worldcover"`). |
| `add_colorbar(colormap=, vmin=, vmax=, label=, units=, colors=, orientation=, position=)` | Add a colorbar for a continuous raster, from a named colormap or custom `colors`. |
| `add_colormap(colormap, vmin=, vmax=, label=, **kwargs)` | Add a colorbar from a named colormap (leafmap-style alias of `add_colorbar`). |
| `set_center(lng, lat, zoom=None)` | Center (and optionally zoom) the map. |
| `set_center_zoom(lng, lat, zoom=None)` | Alias of `set_center` (leafmap compatibility). |
| `remove_layer(layer_id)` / `clear_layers()` | Remove layers. |
| `to_project()` | Return the current project as a dict. |
| `load_project(src)` | Replace the project from a dict, JSON string, or `.geoim3d.json` path. |
| `save_project(path)` | Write the current project to a `.geoim3d.json` file. |

Style keyword arguments (for example `fillColor`, `strokeColor`, `strokeWidth`,
`circleRadius`) map to the GeoLibre [layer style fields](project-format.md).

## How it works

The wheel bundles the GeoLibre web build. At import time the package starts a
small localhost static server that serves the bundled app; the widget renders
that app in an iframe and exchanges the project over `window.postMessage`.
Adding data from Python rewrites the synced project and pushes it into the app;
UI edits flow back the same way.

!!! note "Environment support"

    geoIM3D validates this compatibility workspace only with same-machine local
    Jupyter or VS Code. Hosted and remote notebook environments are inherited
    upstream paths but are unsupported, unverified, and not geoIM3D distribution
    channels. No remote activation or troubleshooting procedure is provided.

!!! warning "URL fetching"

    `add_geojson(url)` fetches the URL from the **kernel**, following redirects,
    so a notebook can reach any host the kernel can (including private and
    link-local addresses such as cloud metadata endpoints). This is intended for
    single-user local notebooks, where you already control the kernel. Private
    and localhost URLs are intentionally allowed so you can load from a local
    tile server. Do not load untrusted `.geoim3d.json` projects or URLs on a
    shared/multi-tenant kernel.

## Building from source

The package lives in [`python/`](https://github.com/opengeos/GeoLibre/tree/main/python).
The bundled app is produced from the monorepo with:

```bash
npm run build:embed      # builds the app and stages it into the wheel
python -m build          # builds the wheel
uv sync --project python --extra dev
```

Changes to the Python code are picked up on kernel restart. Changes to the app
(TypeScript) require re-running `npm run build:embed` and restarting the kernel.
