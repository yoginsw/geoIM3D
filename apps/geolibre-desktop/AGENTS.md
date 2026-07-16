# geoIM3D Desktop/Web App Directives

이 파일은 `apps/geolibre-desktop` 아래 작업에 적용된다. 루트 `AGENTS.md`도 함께 따른다.

## 사용자 경험

- 기본 언어는 한국어이며 언어 선택 UI를 노출하지 않는다. 기존 Locale Source는 삭제하지 않아도 된다.
- 기본 Theme는 Light이다.
- 기본 시작 View는 Cesium 3D Globe이다.
- 기존 Basemap, Sidebar, Menu 구조는 유지한다.
- Splash, Welcome Wizard, Sample Project는 기본 노출하지 않는다.
- 사용자 화면에서 GeoLibre 명칭은 About/License 이외에 표시하지 않는다.
- 사용자 노출 Project 확장자는 `.geoim3d.json`이다.
- Canonical Save/Open Filter는 `.geoim3d.json`만 사용한다. Legacy `.geolibre.json` Import는 별도 승인 전 추가하지 않는다.

## Brand 구현

- Brand 문자열과 URL을 Component마다 하드코딩하지 말고 중앙 Brand Config/Token을 사용한다.
- 색상 Token: `#0B365F`, `#33CC27`, `#FFFFFF`, `#1039BD`.
- Logo가 없는 동안 텍스트 Wordmark `geoIM3D`를 사용한다.
- JBT favicon은 Build Asset으로 내려받아 저장하고 Runtime Remote 의존성을 만들지 않는다.
- About에는 `geoIM3D 1.0.0`, JBT Copyright, 회사 URL, GeoLibre 원본 링크와 MIT License를 표시한다.

## 기능 노출

숨김 대상:

- Jupyter Notebook
- Python Console
- Collaboration/Chat
- Field Collection

코드는 삭제하지 말고 UI Profile/Feature Flag로 숨긴다. Command Palette, Shortcut, Deep Link를 통해 우회 노출되지 않는지 Test한다.

## Credential

- Desktop: Tauri Command를 통해 OS Credential Store에 저장한다.
- Web: React State 또는 전용 Memory Store만 사용한다.
- `localStorage`, IndexedDB, Project JSON, Query String에 Credential을 넣지 않는다.

## 검증

App 변경 시 최소 실행:

```bash
npm run lint
npm run build
npm run test:frontend:coverage
npm run test:e2e
```

Windows Identity, File Association, Credential, Offline 기능 변경은 실제 Windows Desktop Smoke가 필요하다.
