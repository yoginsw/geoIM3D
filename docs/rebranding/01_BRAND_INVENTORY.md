# geoIM3D Brand Inventory

## 기준

- 조사일: 2026-07-16
- 기준 Branch: `feat/geoim3d-brand-foundation`
- 전체 `GeoLibre|geolibre` 검색 결과: 1,879건
- 전역 Search/Replace 금지
- Phase 0 완료 결과: [`00_PHASE0_CLOSURE.md`](00_PHASE0_CLOSURE.md)
- 자동 회귀 Gate: `npm run check:brand`

## A. Phase 1 — 즉시 변경할 사용자 노출 표면

| 표면 | 현재 위치 | 목표 |
|---|---|---|
| HTML Title/Description/Theme | `apps/geolibre-desktop/index.html` | geoIM3D, 실감형 3D 플랫폼, JBT 색상 |
| PWA Manifest | `apps/geolibre-desktop/vite.config.ts` | geoIM3D 이름·설명·색상 |
| About | `AboutDialog.tsx`, `ko.json`, `en.json` | geoIM3D/JBT 및 원본 GeoLibre MIT 링크 |
| App Error | `error-boundaries.tsx`, `main.tsx` | 사용자 노출 제품명을 geoIM3D로 변경 |
| Favicon | `apps/geolibre-desktop/public/*icon*` | JBT favicon을 Local Asset으로 포함 |
| Window Title | `src-tauri/tauri.conf.json` | geoIM3D 표시명; Bundle ID는 Phase 6 |
| Design Token | `packages/ui/src/globals.css` | JBT Primary/Accent를 기존 CSS 변수에 반영 |

## B. Phase 2 — 제품 Profile

- 기본 언어 한국어 및 언어 선택 UI 숨김
- Light Theme
- Cesium 3D Globe 기본 시작
- Splash/Welcome/Sample 비노출
- Jupyter/Python Console, Collaboration/Chat, Field Collection 숨김

## C. Phase 3/6 — Identity와 Packaging

- `.geoim3d.json` Open/Save/File Association
- Windows Bundle ID `com.ejbt.geoim3d`
- Product/Installer/Shortcut/MSIX/Portable 이름
- Docker Image `geoim3d.docker`
- 자동 업데이트 제거

## D. 유지할 내부 식별자

- npm Namespace `@geolibre/*`
- Type 이름 `GeoLibreLayer`, `GeoLibreProject`, `GeoLibreAppAPI`
- Project Schema의 호환 가능한 내부 구조
- Storage/Protocol/API 식별자는 별도 Migration 결정 전 유지
- 기존 Plugin API와 Manifest
- Python Package·Sidecar 내부 이름
- 원본 GeoLibre MIT License와 `Copyright (c) 2026 Qiusheng Wu`
- `https://github.com/opengeos/GeoLibre` Attribution

## Phase 1 완료 조건

- 중앙 Brand Config가 제품명·회사·슬로건·URL·색상·원본 Attribution을 제공한다.
- Page Title, PWA Manifest, About, Window Title에 geoIM3D가 표시된다.
- favicon이 Runtime Remote Fetch 없이 Local Asset으로 제공된다.
- 기존 내부 Namespace와 Plugin API는 변경되지 않는다.
- Frontend Coverage, Build, 관련 E2E가 통과한다.

## Phase 1 실행 결과

- 중앙 Brand Config: `apps/geolibre-desktop/src/config/brand.ts`
- 사용자 노출: Page/PWA/Header/Window/About/Error Boundary
- Design Token: Navy Primary와 Green Accent를 기존 CSS 변수 구조에 적용
- Asset: JBT favicon 원본을 Local ICO/PNG/PWA Asset으로 파생
- License: About에 원본 GeoLibre Repository와 MIT Attribution 유지
- 신규 Runtime Dependency: 없음
- 내부 `@geolibre/*`, Schema, Plugin API: 변경 없음

검증 결과:

- `npm run lint`: 통과
- `npm run build`: 통과
- `npm run test:frontend:coverage`: 82.21% lines, 83.65% branches, 68.42% functions
- Backend Full Suite: 246 passed, 16 skipped, 62.43% coverage
- Playwright Brand/PWA: 통과
- Production Browser Smoke: Console error 없음
- Windows MSVC `cargo check`: 통과

후속 Phase로 유지:

- 한국어 기본 Locale과 `html[lang=ko]`
- Light Theme 및 3D 기본 화면
- Feature Profile 기반 메뉴 숨김
- Package Version, Bundle Identifier, Installer Identity
