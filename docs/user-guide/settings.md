# Settings & Preferences

The **Settings** menu holds the workspace preferences: how the map behaves, which panels are visible, runtime environment variables, project settings, and the entry point to [Manage Plugins](plugins.md).

## Map Preferences

**Settings → Map Preferences** controls how the map can be navigated:


| Setting | Description |
| --- | --- |
| **Restrict map bounds** | Limit panning to a bounding box. |
| **Bounds** | The west, south, east, and north limits of that box. |
| **Min zoom / Max zoom** | The allowed zoom range (0 to 24). |
| **Max pitch** | The maximum tilt angle (0 to 85 degrees). |
| **Render world copies** | Show repeated copies of the world when zoomed out. |

Use **Use Current View** to set the bounds from where the map is now, or **Reset** to restore the defaults. These preferences are saved in the project file.

## Layout

**Settings → Layout** toggles the chrome around the map:

- **Show toolbar labels**: text labels next to toolbar buttons, or icon-only.
- **Show project info**: the project name and path in the toolbar.
- **Show Layers panel**, **Show Style panel**, **Show Attribute panel**: per-panel visibility.

Panels also auto-hide on small screens for a responsive layout.

## Environment Variables

**Settings → Environment Variables** manages runtime settings and approved credentials used by geoIM3D integrations.

- **Share token**: hidden while no approved Share deployment exists. It is shown only for an approved local development endpoint.
- **Environment variables**: named key-value pairs (for example, API keys for Earth Engine, Street View, and other integrations). You can enable or disable individual variables, and secret values are masked. Variable names must start with a letter or underscore and contain only letters, numbers, and underscores.

!!! tip "Where credentials go"
    Windows stores approved credentials per user in Windows Credential Manager. Web/PWA keeps them in memory only and removes them on reload or browser close. Credentials are not saved in projects, URLs, logs, static bundles, or browser persistence.

!!! tip "Reading AI keys from your system environment (desktop)"
    On the desktop app, the [AI Assistant](ai-assistant.md) also reads its own allowlisted keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and the other provider variables) straight from your operating system's environment variables — so you can keep API keys out of the saved project file entirely. A value entered here always takes precedence over the OS environment. See [AI Assistant → Reading keys from your system environment](ai-assistant.md#reading-keys-from-your-system-environment-desktop) for the full list.

!!! tip "No credential build injection"
    API keys and tokens must be entered through the runtime credential UI. Do not inject credential-like `VITE_*` values through Docker build arguments, CI environment variables, or static hosting builds.

## Project Settings

**Settings → Project Settings** (the **Project** tab) holds project-level options saved with the `.geoim3d.json` file:

- **Project name**: the name shown in the toolbar and saved in the project file.
- **Project file**: the read-only path the project was opened from or last saved to.
- **Project format**: the read-only project format version.

## Manage Plugins

**Settings → Manage Plugins** opens the plugin marketplace. See [Plugins & Marketplace](plugins.md).
