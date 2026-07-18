# geoIM3D Downloads

> geoIM3D 1.0 공식 Download URL은 Phase 8 Release Gate에서 Code signing,
> Checksum, Clean-machine Runtime 검증을 통과한 뒤 게시합니다.

## Windows x64

승인 대상 Artifact는 다음 두 가지입니다.

| 형식 | 파일명 | 특성 |
|---|---|---|
| NSIS Installer | `geoIM3D_1.0.0_x64-setup.exe` | 사용자별 설치; OS File Association 없음 |
| Portable ZIP | `geoIM3D-1.0.0-x64-portable.zip` | Registry 변경 없이 압축 해제 후 실행 |

geoIM3D에는 In-app Automatic Updater가 없습니다. 새 버전은 승인된 Installer를
통해 수동으로 설치합니다.

`.geoim3d.json`은 유일한 프로젝트 저장 포맷입니다. Windows가 복합 확장자를
최종 `.json`으로 판정하므로 Installer/MSIX/Portable은 Explorer 기본 연결을
등록하지 않습니다. 프로젝트는 앱 내부 열기, 드래그앤드롭 또는 검증된 Startup
Argument 경로로 엽니다. `.json` 전체 기본 앱을 geoIM3D로 변경하지 마십시오.

### Runtime requirement

Windows 11 및 최신 Windows 10에 기본 포함된 Microsoft Edge WebView2 Runtime이
필요합니다. 실행되지 않으면 Microsoft의
[Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)을
설치합니다.

### MSIX / Microsoft Store

현재 공개 geoIM3D Microsoft Store 또는 Winget Package는 없습니다.
`.github/workflows/msix-store.yml`은 승인된 Partner Center Identity를 입력해
**서명되지 않은 Store 제출용 MSIX**를 만드는 Maintainer Workflow입니다.
이 Artifact는 일반 Sideload 설치본이나 GitHub Release Asset으로 배포하지 않습니다.
Enterprise Sideload에는 Publisher와 일치하는 Certificate 서명 및 별도 설치 검증이
필요합니다.

## Web / PWA

Web Build는 `npm run build`로 생성하며 `apps/geolibre-desktop/dist/`를 정적
Hosting하거나 Docker Image로 배포합니다.

```bash
docker build -t geoim3d.docker .
docker run --rm -p 8080:80 geoim3d.docker
```

첫 방문 후 App Shell은 Offline으로 실행됩니다. Pyodide, PGlite/PostGIS,
CereusDB와 원격 지도 자료는 각 Asset을 Online에서 처음 사용한 뒤 Runtime Cache가
채워져야 Offline에서 재사용할 수 있습니다.

## Source and upstream attribution

geoIM3D는 MIT License의
[GeoLibre](https://github.com/opengeos/GeoLibre)를 기반으로 한 JBT 제품 특화 Fork입니다.
원본 GeoLibre의 Store, Winget, Homebrew, Linux/macOS Download는 geoIM3D 배포 채널이
아니며 원본 Project에서 별도로 관리됩니다.
