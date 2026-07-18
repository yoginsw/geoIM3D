# Embedding & Sharing

GeoLibre's browser build can be embedded in any web page and configured through URL query parameters. This is how you turn a shared project into a live, focused map for a website, a report, or a dashboard.

## The live viewer

No public geoIM3D Viewer hostname is approved. The examples below use the local production preview at `http://localhost:4173/`; replace it only with an exact JBT-approved deployment URL. The browser build processes local data client-side, while explicitly configured remote sources still make network requests.

Open a public project by passing its `.geoim3d.json` URL with the `url` parameter:

```text
http://localhost:4173/?url=http://localhost:8788/giswqs/3d-tiles.geoim3d.json
```

A project URL like this comes from **Project → Share**. See [Projects](projects.md#share).

A chrome-free `maponly` embed shows only the map, as in this shared 3D Tiles project:


## URL parameters

| Parameter | Example | Description |
| --- | --- | --- |
| `url` | `url=http://localhost:8788/you/project.geoim3d.json` | Loads a `.geoim3d.json` project from a public URL. |
| `layout` | `layout=compact` | Compact embed layout: icon-only toolbar buttons and hidden project metadata. `embed` and `iframe` are aliases. |
| `toolbar` | `toolbar=icons` | Icon-only toolbar buttons without the full compact layout. `icon` and `icon-only` are aliases. |
| `panels` | `panels=none` | Hides the Layers, Style, and Attribute table panels. `hidden`, `hide`, and `off` are aliases. |
| `hidePanels` | `hidePanels=true` | Alternative way to hide those panels. |
| `maponly` | `maponly` | Hides all chrome (toolbar, panels, and status bar), leaving only the map. The bare flag or `true`, `1`, `yes`, `on` enable it. |
| `welcome` | `welcome=0` | Hides the first-launch welcome wizard. Accepts `0`, `false`, `off`, or `no`. A `url=` deep link already suppresses it automatically. |
| `theme` | `theme=dark` | Sets the initial color theme, overriding the OS preference. Accepts `dark` or `light`; the in-app toggle still works afterward. |

Parameters combine. For a narrow, chrome-free, dark embed of a shared project:

```text
http://localhost:4173/?url=http://localhost:8788/you/project.geoim3d.json&maponly&theme=dark
```

## Embedding in a page

Drop the viewer into an `<iframe>`:

```html
<iframe
  src="http://localhost:4173/?url=http://localhost:8788/you/project.geoim3d.json&amp;maponly"
  title="GeoLibre map"
  width="100%"
  height="600"
  style="border: 0;"
  loading="lazy"
  allow="fullscreen; geolocation"
></iframe>
```

Use `layout=compact` when you want a slim toolbar to remain (for example, so viewers can switch basemaps), or `maponly` for a pure map.

## What works in an embed

The browser build supports map navigation, browser-selected and URL-based data, styling, the SQL Workspace, and most plugins. Desktop-only features (local file dialogs, local MBTiles and raster reads, project save/open, and the Python sidecar tools) are not available in an embed. See [Getting Started](../getting-started.md).

See the [Sharing & Embedding tutorial](../tutorials/sharing-embedding.md) for a full walkthrough.
