# Phase 7E Windows Tauri runtime evidence

## Scope and identity

- Captured: `2026-07-22T16:13:29+09:00`
- Repository baseline HEAD: `5a0e911ea9cbdae4f585173e0ff42226bbeff958`
- Source state: **uncommitted Phase 7E working tree**; this is not immutable exact-commit release evidence.
- Windows debug artifact: `%LOCALAPPDATA%\Temp\geoim3d-phase7e-cdp-target\debug\geolibre-desktop.exe`
- Debug artifact SHA-256: `64379fa78ff37d1f495faa6f46c11a4781a01b88c06aafedaa9ef5b3514388a2`
- Windows release artifact: `%LOCALAPPDATA%\Temp\geoim3d-phase7e-cdp-target\release\geolibre-desktop.exe`
- Release artifact SHA-256: `d7b40fd4844de4f0f5261adab3162c18b72348a2cf19492a76b59b6813d29681`
- Artifact version: `1.0.0`
- Build mode: Windows MSVC binaries with production frontend assets embedded through `TAURI_CONFIG={"build":{"devUrl":null}}`.
- CDP scope: `GEOIM3D_ENABLE_CDP=1` activates a Windows `debug_assertions`-only fixed port and process-specific temporary WebView2 profile. Release builds do not compile this branch.
- Release smoke: the release executable started successfully. Even with `GEOIM3D_ENABLE_CDP=1`, it produced `0` remote-debug arguments, `0` listeners on port `9227`, and `0` CDP temporary profiles.

## Actual UI path

The following path was exercised in the Windows Tauri WebView2 application, not in a browser-only preview:

1. `프로젝트` menu
2. `3D 장면 Preset 가져오기...`
3. Windows native file picker
4. strict Worker parse
5. Project Store publication
6. native relative-resource materialization
7. Cesium layer synchronization and render

Fixture:

- Preset: `%LOCALAPPDATA%\Temp\geoim3d-phase7e-runtime\runtime.geoim3d-preset.json`
- Preset SHA-256: `0fe35ee060ef31f35aa707c7d8b85b9673d084801d95c59bfb18c59be9ec918d`
- GLB: `%LOCALAPPDATA%\Temp\geoim3d-phase7e-runtime\model.glb`
- GLB SHA-256: `b1aa80b228157a07b2cd3472df5fad46a286adeb34bab3f4e58f5a11d599dd29`
- GLB bytes: `744`
- GLB form: self-contained GLB 2.0 red triangle, no external URI
- Placement: longitude `-100`, latitude `40`, altitude `10000`, bearing `30`, scale `500000`

## Visual result

Final screenshot:

- File: `phase7e-runtime-placement-tauri-v2.png`
- SHA-256: `86cd2a82875d10381754415b6dbc4026a54ba11f83c2e6af11195c3c85508221`
- Capture mechanism: actual Windows Tauri WebView2 CDP `Page.captureScreenshot`
- Result: `Runtime Model` is present, Cesium is active, and the red triangle is visibly rendered over central North America.
- UI diagnostics shown: `0`
- No Scene Preset or Cesium load error was present in the visible UI.

Important disclosure:

- **External Cesium globe imagery/labels were loaded.** The screenshot shows labeled Cesium imagery and Cesium ion attribution.
- Therefore this screenshot proves native resource materialization and model placement/rendering, but it is **not** offline/no-egress evidence.
- `phase7e-runtime-tauri.png` and `phase7e-runtime-placement-tauri.png` are earlier diagnostic captures in which the test GLB had no visible mesh or used the wrong glTF plane orientation. They are not acceptance screenshots.
- Machine-readable classification: `phase7e-evidence-manifest.json`.

## Native protocol result

A fresh import capability was issued through `pick_and_read_scene_preset`, then `model.glb` was prepared with generation `777`.

| Operation | Actual result |
|---|---|
| HEAD | `200` |
| Content-Length | `744` |
| Content-Type | `model/gltf-binary` |
| X-Content-Type-Options | `nosniff` |
| Range request | `bytes=0-19` |
| Range status | `206` |
| Content-Range | `bytes 0-19/744` |
| Range Content-Length | `20` |
| Accept-Ranges | `bytes` |
| First bytes | `67 6c 54 46 02 00 00 00 e8 02 00 00 a0 02 00 00 4a 53 4f 4e` |
| After session close | `404` |

The first bytes decode to the GLB magic/version/header followed by the JSON chunk marker.

## Post-review source gates

- These gates were run after security-review fixes and therefore are **newer than the screenshot/debug artifact**. They do not bind that historical artifact to the latest source snapshot.
- Full frontend: `3,081 passed / 0 failed / 2 skipped`
- Targeted relative-materialization/project-round-trip: `4 passed / 0 failed`
- Windows Rust: `92 passed / 0 failed`
- Rust format: PASS
- ESLint: `0 errors / 21 pre-existing warnings`
- Production frontend build: PASS

## Acceptance boundary

This evidence supports:

- native Windows picker/import path;
- Worker-to-Store application;
- relative GLB materialization through an opaque URL;
- Earth-fixed placement and actual Cesium rendering;
- HEAD, strict single-range GET, MIME/nosniff headers, and close-to-404 lifecycle.

This evidence does **not** yet support:

- immutable exact-commit acceptance;
- Windows bundled installer/package smoke;
- Windows native memory thresholds and three-run recovery monotonicity;
- offline/no-external-egress operation;
- commit, push, PR, or public release approval.

## Owner-directed gate exception

- On `2026-07-22`, the product owner directed the team to skip executable-scenario testing and proceed to the remaining phases.
- The Windows native memory thresholds and three-run recovery gate are therefore **deferred, not passed**.
- No CSV, run manifest, calculation artifact, threshold result, or recovery-monotonicity result is claimed.
- Phase 8 may execute its remaining gates, but any final Release 1.0 decision must list this exception explicitly rather than presenting full §11.3 acceptance.
