# Getting Started

[![image](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20785400.svg)](https://doi.org/10.5281/zenodo.20785400)

geoIM3D is JBT's Windows-focused 2D/3D spatial platform and an MIT fork of GeoLibre. The currently verified targets are Windows NSIS/Portable and a locally built Web/PWA shell.

This page covers the verified geoIM3D startup paths. Contributors can jump to [Run from source](#run-from-source) or read the [Contributing](contributing.md) guide.

## Use geoIM3D

Use the Windows desktop build for native file access. Use the local Web/PWA build for browser validation; remote data still requires network access.

### On the web

The local Web/PWA build runs in a browser and keeps credentials in memory only. Offline verification covers the application shell, not remote tiles or APIs.

[Open the local Web build](http://localhost:4173/){ .md-button .md-button--primary }

Browser-selected data and approved URL services can be loaded in the local Web build. Desktop-only file dialogs, local MBTiles, local raster reads, Credential Manager, and native project save/open require the Windows app.

### On the desktop

The geoIM3D desktop app targets Windows x64 and adds local filesystem dialogs, local MBTiles, local raster file reads, and canonical `.geoim3d.json` project save/open. The approved channels are an NSIS Installer and Portable ZIP; official URLs are published only after the Phase 8 signing and runtime gate. There is currently no geoIM3D Store or Winget listing.

[Download the desktop app](downloads.md){ .md-button .md-button--primary }

### Upstream compatibility in Jupyter

The [`python/`](python.md) workspace is retained for local source compatibility
testing. It is not an approved geoIM3D 1.0 distribution channel, and this fork
does not provide PyPI, Conda, Colab, or hosted Jupyter installation paths.


## Run from source

This section is for contributors and developers who want to clone GeoLibre and run it locally. Most users do not need it. For the full development workflow, project layout, and quality gate, see the [Contributing](contributing.md) guide. GeoLibre is an npm workspaces monorepo: the main app lives in `apps/geolibre-desktop` and is built with Tauri, React, TypeScript, and MapLibre GL JS.

### Prerequisites

- Node.js 22 or newer
- Rust toolchain for desktop builds
- Linux desktop build dependencies from the Tauri v2 prerequisites

### Install

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
```

Bun users can run `bun install`. The root `trustedDependencies` list allows the known install scripts for `core-js`, `@google/genai`, and `protobufjs`.

### Update

To update an existing source checkout to the latest version, pull the changes, reinstall dependencies (in case `package.json` changed), and rebuild:

```bash
cd /path/to/GeoLibre   # your GeoLibre checkout
git pull origin main
npm install            # or: bun install
```

If you run a production build, rebuild afterwards with `npm run build` (web) or `npm run tauri:build` (desktop). If you work from the dev servers (`npm run dev` or `npm run tauri:dev`), the `git pull` and `npm install` above are enough — just restart the dev server to pick up the changes.

### Run the browser UI

```bash
npm run dev
```

Open `http://localhost:5173`. The map and browser vector import support local vector files that DuckDB-WASM Spatial can read, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives. Use Add Vector Layer or drag files onto the app; GeoTIFF/COG rasters can also be dragged onto the map to add them as raster layers. The browser UI can also add URL-based services and datasets such as XYZ, WMS, GeoJSON URLs, vector tiles, COG rasters, ArcGIS services, FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats.

Desktop filesystem dialogs, local MBTiles, local raster file reads, project save/open, and other filesystem operations require Tauri.

### Run with Docker

The repository includes a local-development Dockerfile for geoIM3D. It builds the Vite app and serves the production files with nginx:

```bash
docker build -t geoim3d.docker .
docker run --rm -p 8080:80 geoim3d.docker
```

Open `http://localhost:8080`. The containerized browser UI supports web-capable workflows, but desktop filesystem dialogs, local MBTiles, local raster file reads, project save/open, and other Tauri-only features require the desktop app.

No public container image or publication workflow is approved. Keep the
container on loopback or another trusted local development network.

To require a username and password, set `GEOLIBRE_AUTH_USER` and
`GEOLIBRE_AUTH_PASSWORD`; nginx then protects the app and the `/sidecar` API
with HTTP Basic Auth (a single shared credential). This remains a trusted local
development path and must not be exposed publicly:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_AUTH_USER=admin \
  -e GEOLIBRE_AUTH_PASSWORD='change-me' \
  geoim3d.docker
```

### Run the desktop app

```bash
npm run tauri:dev
```

### Build

```bash
npm run build
npm run tauri:build
```

Where to find the output:

- **Web build** — local static files in `apps/geolibre-desktop/dist/`.
- **Windows artifacts** — verified NSIS and Portable outputs under the configured Cargo target `release/bundle/` directory. Linux/macOS installers are not approved geoIM3D outputs.

## Optional imagery credentials

The Street View plugin can use Google Street View and Mapillary imagery. The 3D Tiles panel can also load Google Photorealistic 3D Tiles with the same Google Maps key. Enter approved provider credentials at runtime through **Settings → Credentials**. Do not place them in `.env.local`, CI variables, or Web/PWA build arguments.

For Google Street View, enable the Maps Embed API for the key in Google Cloud. For Google Photorealistic 3D Tiles, enable the Map Tiles API. For Mapillary, create an app and use its client access token subject to the provider's terms.

## Optional basemap credentials

The **New map** dialog offers [Protomaps](https://protomaps.com) basemaps (Light, Dark, White, Grayscale, Black) when a Protomaps API key is configured. Without a key these options are hidden, and you can still use the OpenFreeMap basemaps or a custom style URL.

Use your own key from the [Protomaps dashboard](https://protomaps.com). Enter it
at runtime through **Settings → Credentials**. geoIM3D does not accept this key
through a public CI/CD workflow or bake it into Web/PWA artifacts.

## Optional traffic overlays

The **Basemaps** control includes a **Traffic** category with real-time traffic overlays that stack on top of any basemap (enable the panel's add/multiple toggle). Each provider authenticates with your own API key entered at runtime through **Settings → Credentials**:

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key   # Google Traffic (Map Tiles API)
VITE_TOMTOM_API_KEY=your_tomtom_api_key             # TomTom Traffic Flow
VITE_HERE_API_KEY=your_here_api_key                 # HERE Traffic Flow
```

Google Traffic and Google Photorealistic 3D Tiles reuse the same `VITE_GOOGLE_MAPS_API_KEY` as Street View; enable the **Map Tiles API** for that key in Google Cloud. A newly entered key takes effect immediately, without reopening the project. Until a provider's key is set, its overlay reports a missing-key error instead of loading tiles.

## Optional Amazon Location styles

The **Amazon Location** entries in the Basemaps control are *style basemaps* (they replace the whole map style, unlike the traffic overlays above). They authenticate with your own Amazon Location API key, set in **Settings → Environment Variables** (or baked into `apps/geolibre-desktop/.env.local`):

```env
VITE_AMAZON_LOCATION_API_KEY=your_amazon_location_api_key   # Amazon Location styles
VITE_AMAZON_LOCATION_AWS_REGION=us-east-1                   # optional; omit to use the control's built-in default region
```

Keys set via **Settings → Environment Variables**, or typed directly into the panel's **API keys** view (the key button in the panel header), apply at runtime without reopening the project. A key baked into `apps/geolibre-desktop/.env.local` is read at build time and needs a dev server restart. When `VITE_AMAZON_LOCATION_API_KEY` is set in the environment it takes precedence over a key typed in the panel; removing it from the environment clears it on the next page reload.

## Optional Python sidecar

The optional FastAPI sidecar is reserved for heavier processing workflows and is not required for the desktop UI.

```bash
cd backend/geolibre_server
python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```
