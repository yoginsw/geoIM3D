# geolibre — upstream compatibility workspace

> Local source compatibility and testing only. This is not an approved
> geoIM3D distribution channel and this fork does not publish it to PyPI,
> Conda, Colab, or hosted Jupyter services.

GeoLibre in Jupyter: the upstream [GeoLibre](https://github.com/opengeos/GeoLibre) GIS app as an
[anywidget](https://anywidget.dev), with a leafmap-style Python API.

The widget embeds the complete GeoLibre app (menus, panels, processing tools)
inside a notebook cell. State syncs both ways through a single
`.geoim3d.json` project, so data you add from Python appears in the UI, and
edits you make in the UI are readable back from Python.

## Local source setup

```bash
uv sync --project python --extra dev
uv run --project python pytest python/tests
```

## Quickstart

```python
from geolibre import Map

m = Map(center=(-100, 40), zoom=4)
m.add_geojson("https://example.com/data.geojson", name="Data")
m
```

Add more data and drive the view:

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

Round-trip the project:

```python
m.save_project("my-map.geoim3d.json")

m2 = Map()
m2.load_project("my-map.geoim3d.json")

# Read state edited in the UI (e.g. after panning/zooming):
m.to_project()["mapView"]["center"]
```

## API

| Method | Description |
| --- | --- |
| `Map(center, zoom, basemap=, height=, layout=, theme=)` | Create a map. `layout` is `"embed"`, `"full"`, or `"maponly"`. |
| `add_geojson(data, name=, **style)` | Add GeoJSON (dict, path, URL, JSON, or GeoDataFrame). |
| `add_vector(data, name=, render_mode=, data_format=, source_layer=, **style)` | Add a vector dataset from a URL (GeoParquet, FlatGeobuf, zipped Shapefile, GeoJSON) or a local file (read via GeoPandas, inlined). |
| `add_geoparquet` / `add_flatgeobuf` / `add_shp` `(data, name=, **style)` | Format-specific wrappers over `add_vector`. |
| `add_vector_tiles(url, name=, source_layers=, source_layer=, **style)` | Add vector tiles from a TileJSON endpoint. |
| `add_pmtiles(url, name=, tile_type=, source_layers=, **style)` | Add a PMTiles archive (vector or raster). |
| `add_tile_layer(url, name=, tile_size=, attribution=)` | Add a raster XYZ tile layer. |
| `add_wms(endpoint, layers, name=, styles=, image_format=, transparent=, tile_size=, **style)` | Add a WMS (GetMap) tiled raster layer. |
| `add_wmts(url, name=, tile_size=, **style)` | Add a WMTS tile URL template. |
| `add_wfs(endpoint, type_name, name=, version=, output_format=, srs_name=, max_features=, **style)` | Add a WFS layer (GeoJSON, fetched and inlined). |
| `add_cog(url, name=, bands=, colormap=, rescale=)` | Add a Cloud Optimized GeoTIFF. |
| `add_raster(url, name=, bands=, colormap=, rescale=)` | Add a raster (alias of `add_cog`). |
| `add_3d_tiles(url, name=, altitude_offset=, request_headers=, **style)` | Add a 3D Tiles `tileset.json`. |
| `add_video(urls, coordinates, name=, **style)` | Add a georeferenced video (four `[lng, lat]` corners). |
| `add_basemap(basemap)` | Set the background basemap. |
| `set_center(lng, lat, zoom=None)` | Center (and optionally zoom) the map. |
| `set_center_zoom(lng, lat, zoom=None)` | Alias of `set_center` (leafmap compatibility). |
| `remove_layer(layer_id)` / `clear_layers()` | Remove layers. |
| `to_project()` / `load_project(src)` / `save_project(path)` | Project I/O. |

## Notes

- The bundled app is served from localhost. geoIM3D validates this workspace
  only with same-machine local Jupyter or VS Code. Hosted and remote notebook
  environments are inherited upstream paths but are unsupported, unverified,
  and not geoIM3D distribution channels.
- The local `all` extra adds GeoPandas/Shapely support
  for `add_geojson(geodataframe)` and for reading **local** vector files
  (`add_vector`/`add_geoparquet`/`add_flatgeobuf`/`add_shp`), which the kernel
  reads and inlines as GeoJSON. Remote URLs for the same formats stream through
  the in-browser vector control and need no extras.
- `add_geojson` inlines file/URL data into the project (up to 50 MB), so a large
  dataset is held in memory and re-synced on every project update. For very large
  layers, prefer a tile or COG source (`add_tile_layer`/`add_cog`) the app fetches
  directly.
