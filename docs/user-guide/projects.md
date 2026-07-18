# Projects

A geoIM3D project captures the portable workspace in a single `.geoim3d.json` file: the map view, basemap, layers, styles, map preferences, plugin state, and approved non-secret settings. Credentials are never written to the project. Everything in this section lives under the **Project** menu.


## New

**Project → New...** starts a fresh project. GeoLibre offers to save the current project first, then resets the layers, map view, controls, and plugin state to defaults.

## Open

**Project → Open From** has two sources:

- **File...** opens a `.geoim3d.json` file from disk (desktop app).
- **URL...** loads a public `.geoim3d.json` from an HTTP or HTTPS URL. This works in the browser too and adds the project to your recent list.

**Project → Open Recent** lists the projects you have opened before, each with its name, path, and the time you last opened it. Click an entry to reopen it, use the small remove button to drop a single entry, or choose **Clear Recent Projects** to empty the list. On the desktop app the recent list persists across sessions; in the browser it tracks URL-based projects.

!!! note "Loading a project at startup"
    You can open a project directly by passing its URL with the `url` query parameter, for example `?url=http://localhost:8788/you/project.geoim3d.json`. See [Embedding & Sharing](embedding.md).

## Save and Save As

- **Save** writes back to the project's existing file path.
- **Save As...** prompts for a new name and location.

Both capture the current map view, basemap, layers, styles, preferences, and plugin state at the moment you save. Projects that were opened from a URL have no writable local path, so both Save and Save As fall back to the save dialog. Saving requires the desktop app.

## Share

geoIM3D currently has no approved public Share service or Viewer hostname, so **Share**, **Gallery**, and hosted Viewer export are hidden. Local development can enable them only with the approved loopback endpoints. A future public deployment requires an exact JBT-approved hostname, CSP/capability review, and release approval. See the [Sharing & Embedding tutorial](../tutorials/sharing-embedding.md).

## Print

**Project → Print...** opens the Print panel, which exports the current map to a PDF or image. Choose the page size and orientation, then export. The Print panel is backed by the MapLibre components plugin.

## The project format

For the full schema of `.geoim3d.json`, including how layers, styles, and plugin state are serialized, see [Reference → Project Format](../project-format.md).
