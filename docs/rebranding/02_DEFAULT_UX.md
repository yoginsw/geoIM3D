# geoIM3D Phase 2 — Default UX

## 기준

- 완료일: 2026-07-16
- Branch: `feat/geoim3d-default-ux`
- 기반 Commit: `0a95d10 feat: establish geoIM3D brand foundation`

## 제품 기본 계약

| 항목 | Production 동작 |
|---|---|
| 언어 | 한국어(`ko`) 고정, 언어 선택 UI 미노출 |
| Theme | Light 기본, 수동 Dark 전환 및 `?theme=` Override 유지 |
| 프로젝트 이름 | 신규 프로젝트에 `제목 없는 프로젝트` 표시 |
| 지도 화면 | `1×2` MapLibre 2D + Cesium 3D Globe |
| Cesium Credential | Token이 없어도 OSM Imagery Fallback으로 Globe 표시 |
| Welcome/Onboarding | Product Profile에서 비노출 |
| UI Profile | 잠금 상태, 기존 Beginner/Custom Profile을 Product Profile로 Clamp |

기존 프로젝트를 열 때 Project Schema, Layer, Map View 및 내부 식별자를 변경하지 않는다. 제품 지도 기본값은 신규 또는 초기 Clean Project에만 적용하며 적용 직후 `markSaved()`로 Dirty 상태를 남기지 않는다.

## 숨김 기능과 우회 차단

다음 기능은 삭제하지 않고 Product Profile에서 숨긴다.

- `project.collaborate`
- `processing.pythonConsole`
- `processing.notebook`
- `controls.fieldCollection`

적용 표면:

- Toolbar Menu
- Command Palette
- Global Shortcut
- Keyboard Shortcut 안내
- Collaboration Deep Link와 Background Hook
- Python Console/Jupyter Notebook의 DesktopShell 렌더 Guard
- Field Collection Dialog 실행 Guard
- Settings Interface Editor와 관련 Deep Link Section

향후 재활성화를 위해 구현 코드, Plugin/API Identifier와 Project Compatibility는 유지한다.

## E2E Compatibility Build

기존 Upstream E2E는 영어 Locator와 단일 MapLibre 화면을 사용한다. Playwright Build에만 `VITE_E2E_EXPOSE_ALL_LOCALES=true`를 주입한다.

- 기존 E2E: 영어 Locale과 단일 MapLibre 기본 화면으로 실행
- Product E2E: `?locale=ko&geoim3dProfile=1`로 실제 한국어·Light·2D+3D 계약 검증
- Production Build: 위 환경 변수가 없으므로 항상 한국어·`1×2` 2D+3D 제품 기본값 적용

이 분리는 전체 Suite에서 매 Test마다 Cesium WebGL Context를 생성해 발생한 Browser 자원 누적을 방지한다.

## 검증 결과

- Target Contract: 71 passed
- Frontend Full Coverage:
  - Lines: 82.56%
  - Branches: 83.62%
  - Functions: 68.51%
- ESLint: Error 0, 기존 Warning 23
- Worker TypeScript: 3개 통과
- Backend: 246 passed, 16 skipped, 62.43% coverage
- Production Build: 통과
- Playwright Full Suite: 24 passed
- Production Browser Smoke:
  - 한국어·Light·MapLibre 2D + Cesium 3D 확인
  - JavaScript Error 0
  - 기존 Three.js 중복 Import Warning 8
- Windows MSVC:
  - Cargo 1.97.0 / Rustc 1.97.0
  - `cargo check` 통과
- 신규 Runtime Dependency: 없음
- Project Schema/API/Storage Key 변경: 없음
- Credential/Secret 추가: 없음

## 알려진 제한

- JupyterLite Build Dependency가 설치되지 않은 환경에서는 기존 Build Script가 Notebook Asset 생성을 건너뛴다. Notebook은 Product Profile에서 숨김 상태다.
- MapLibre/Cesium Basemap 내부 Label은 외부 지도 공급자 데이터 언어를 따를 수 있다.
- Browser Console의 Three.js 중복 Import Warning은 기존 Dependency Graph 경고이며 이번 Phase의 신규 오류는 아니다.
