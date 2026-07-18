# Sharing & Embedding

geoIM3D has no approved public Share or Viewer deployment. This tutorial is a local development exercise using loopback services; do not treat these URLs as production endpoints. See [Embedding & Sharing](../user-guide/embedding.md) for the full reference.

## 1. Set your share token

Sharing uploads to `administrator-configured Share service` using a personal API token.

1. Open **Settings → Environment Variables**.
2. Paste your token into the **Share API token** field. For loopback development, create one under Settings → API tokens at the [administrator-configured Share service settings](http://localhost:8788/settings).

On Web/PWA the token is memory-only and must be entered again after reload. Windows stores it in the per-user credential store.

## 2. Share the project

1. Build your map: add layers, style them, and set the map view you want viewers to land on.
2. Open **Project → Share...**.
3. Confirm the project title and upload. GeoLibre returns a public URL to a `.geoim3d.json` file, for example:
   ```text
   http://localhost:8788/you/my-map.geoim3d.json
   ```

The shared file captures the same layers, styles, plugin state, and map view as a local save.

## 3. Open the shared map

Anyone can open the shared project in the live viewer by passing it as the `url` parameter:

```text
http://localhost:4173/?url=http://localhost:8788/you/my-map.geoim3d.json
```

## 4. Embed it in a page

Use an `<iframe>` and the embed parameters to control the chrome. For a clean, map-only embed:

```html
<iframe
  src="http://localhost:4173/?url=http://localhost:8788/you/my-map.geoim3d.json&amp;maponly"
  title="GeoLibre map"
  width="100%"
  height="600"
  style="border: 0;"
  loading="lazy"
  allow="fullscreen; geolocation"
></iframe>
```

Adjust the look with parameters (they combine):

- `maponly` hides all chrome, leaving only the map.
- `layout=compact` keeps a slim, icon-only toolbar.
- `panels=none` hides the side and bottom panels but keeps the toolbar.
- `theme=dark` forces the dark theme on load.

See the full [parameter table](../user-guide/embedding.md#url-parameters).

## Next steps

- Tune which controls appear before sharing with the [Controls menu](../user-guide/map-controls.md).
- Revisit [Your First Map](first-map.md) to build the map you want to share.
