# geoIM3D

**geoIM3D(지오아임3D)**는 JBT의 **실감형 3D 플랫폼**입니다. 건축·토목·부동산·환경·안전·공간 분석 업무를 위한 Windows 중심 2D/3D 공간정보 기능을 제공합니다.

> geoIM3D는 [GeoLibre](https://github.com/opengeos/GeoLibre)의 MIT Fork입니다. 원본 Repository, License, 저작권 고지와 Attribution을 유지합니다.

## 현재 검증된 실행 범위

| 대상 | 상태 | 검증 범위 |
|---|---|---|
| Windows NSIS Installer | 검증됨 | 사용자별 설치, 실행, `.geoim3d.json` Startup Open, 제거 |
| Windows Portable ZIP | 검증됨 | 압축 해제, 실행, `.geoim3d.json` Startup Open, Registry 비변경 |
| Local Web/PWA | 검증됨 | Production Build, Manifest, Service Worker, 첫 방문 후 Offline Shell |
| MSIX | 제한적 | Partner Center 제출용 Unsigned 입력물 생성만 지원 |
| Docker | 미완료 | Source/Build Contract만 검증, Runtime Smoke 미완료 |

PWA의 Offline 검증은 **Application Shell**에 한정됩니다. 원격 지도 Tile, 외부 API, URL Dataset은 Network 연결과 각 Provider의 이용 조건이 필요합니다.

## 핵심 기능

- MapLibre 기반 2D 지도와 Cesium 기반 3D Globe
- Local File 및 URL 기반 공간 Dataset 시각화
- Layer, Style, Attribute Table, 공간 처리 도구
- Canonical Project 형식: `.geoim3d.json`
- Windows Credential Manager 기반 Desktop Credential 보관
- Web/PWA Credential의 Memory-only 처리
- Windows 전용 VWorld Private Transport와 Ephemeral Layer

기능별 상세 조건은 [사용자 가이드](user-guide/interface.md)와 [Architecture](architecture.md)를 확인하십시오. 외부 Provider 기능은 사용자가 발급받은 운영 승인 Key와 해당 Provider 약관을 전제로 합니다.

## Local source 실행

```bash
git clone https://github.com/yoginsw/geoIM3D.git
cd geoIM3D
npm install
npm run dev
```

Production Web/PWA Build:

```bash
npm run build
npx playwright test e2e/pwa.spec.ts
```

Windows Native Build와 Packaging은 [Getting Started](getting-started.md) 및 [Downloads](downloads.md)의 검증 범위를 따릅니다.

## Project 열기 정책

`.geoim3d.json`은 유일한 Project 형식이지만 Windows가 복합 확장자를 일반 `.json`으로 판정할 수 있으므로 OS File Association을 등록하지 않습니다.

지원 경로:

- Application 내부 **Open**
- Drag and Drop
- 검증된 절대 경로 Startup Argument

지원하지 않는 경로:

- Installer/MSIX의 File Association
- ProgID/Open With 등록
- Portable의 Registry 변경
- Legacy `.geolibre.json` Project

## 현재 비활성 또는 미승인 범위

다음 항목은 현재 geoIM3D 1.0 배포 채널이나 지원 기능으로 주장하지 않습니다.

- Public Share, Viewer, Collaboration Host
- Public Plugin Marketplace/Registry
- In-app Automatic Updater
- GitHub Pages 및 Cloudflare 자동 배포
- GitHub Release 자동 게시
- Microsoft Store/Winget 공개 Listing
- Homebrew/AUR/COPR/Flatpak/PyPI/Conda 배포
- Android Build/Release
- Public Docker Image 게시
- Public Viewer/Share/Collaboration Service

Share/Viewer/Collaboration/Plugin Registry 개발 경로는 승인된 Public Host 없이 Loopback-only로 제한됩니다.

## Credential 및 데이터 경계

- Secret은 공개 Getter 없이 App-private Write-only 경로로 주입합니다.
- Windows Desktop은 사용자별 Credential Manager를 사용합니다.
- Web/PWA는 Reload 시 폐기되는 Memory-only 상태를 사용합니다.
- Secret은 `.geoim3d.json`, Browser Storage, Export, Log에 저장하지 않습니다.
- VWorld Map Controller와 조회 결과는 Session Ephemeral이며 Project/History/Cache/Export에 저장하지 않습니다.
- `OLLAMA_HOST` 같은 Local Endpoint는 Secret이 아니지만 외부 LLM Egress는 별도 승인 없이는 허용하지 않습니다.

## 배포 전 확인 사항

- [ ] Windows Code Signing
- [ ] MSIX Publisher/Identity와 Partner Center 일치 검증
- [ ] 운영 Provider Key 및 상업 이용 승인
- [ ] Docker Runtime Smoke
- [ ] License/Attribution 및 Dependency Security Audit
- [ ] 승인된 공식 Download URL

## 문서

- [Getting Started](getting-started.md)
- [Downloads 및 Packaging 상태](downloads.md)
- [Project Format](project-format.md)
- [Architecture](architecture.md)
- [User Guide](user-guide/interface.md)
- [Plugin API와 Loopback Registry 정책](plugin-api.md)
- [Python/Jupyter Upstream 호환 참고](python.md)
- [Testing and Release](directives/08_TESTING_RELEASE.md)

## Upstream Attribution

geoIM3D는 [opengeos/GeoLibre](https://github.com/opengeos/GeoLibre)의 MIT Fork이며 원본 Attribution을 유지합니다.

GeoLibre Citation:

> Wu, Q. (2026). GeoLibre: A lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data. Zenodo. <https://doi.org/10.5281/zenodo.20785400>

## License

MIT
