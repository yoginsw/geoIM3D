# geoIM3D portable zip packaging (`build-portable.ps1`)

[`build-portable.ps1`](build-portable.ps1)은 완료된 Windows Tauri Release Build를
**Portable Windows ZIP**으로 패키징합니다. 사용자는 압축을 푼 뒤
`geolibre-desktop.exe`를 직접 실행합니다. 설치, 관리자 권한, Registry 변경이
필요하지 않습니다.

Executable 이름은 내부 Rust crate 호환성을 위해 유지되며 사용자에게 전달되는
Folder와 ZIP 이름은 `geoIM3D` Product Identity를 사용합니다.

## Build

```powershell
npm run tauri:build -- --no-sign
npm run portable:build
# 또는: pwsh ./packaging/portable/build-portable.ps1
```

결과:

```text
apps/geolibre-desktop/src-tauri/target/release/bundle/portable/
  geoIM3D-<version>-x64-portable.zip
```

## Layout

```text
geoIM3D-<version>-x64/
  geolibre-desktop.exe
  *.dll
  README.txt
  backend/geolibre_server/
```

Backend의 `.env*`, Virtual Environment, Cache, Test, Build Artifact는 패키징 중
제거됩니다. Credential 파일을 Release Payload에 넣으면 안 됩니다.

## End-user requirements

- **Microsoft Edge WebView2 Runtime**: Windows 11과 최신 Windows 10에 기본 제공
- **Python**: Whitebox/Raster/Conversion 등 선택적 Sidecar 기능에 필요

geoIM3D는 In-app Automatic Updater를 사용하지 않습니다. 승인을 거친 새 Installer
또는 Portable ZIP으로 교체해 Upgrade합니다.
