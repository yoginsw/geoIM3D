# geoIM3D Phase 0 — Baseline/Inventory Closure

## 기준

- 완료일: 2026-07-17
- Branch: `chore/geoim3d-phase0-closure`
- 목표: Brand 회귀 자동 차단, 안전한 비공개 저장소 Snapshot 절차, 최신 Full Gate와 Windows Runtime 증거 확보

## 완료 산출물

### Brand 자동 검사

- CLI: `scripts/check-geoim3d-brand.mjs`
- Contract Test: `tests/brand-surface-check.test.ts`
- npm Script: `npm run check:brand`
- Root `ci`의 첫 Gate로 연결

검사 대상:

- Production App의 TypeScript/TSX 문자열 Literal과 JSX Text
- 한국어 Product Locale
- HTML, Tauri 사용자 노출 Metadata

명시적 허용:

- About의 원본 GeoLibre Repository Attribution
- MIT/저작권 Attribution
- 공개 External Plugin API의 `GeoLibrePlugin` Compatibility Identifier
- 원본 `https://github.com/opengeos/GeoLibre` URL

내부 `@geolibre/*`, Type 이름, Project Schema, Storage/API Identifier는 변경하지 않았다.

### 사용자 노출 Brand 정리

Scanner가 검출한 기존 사용자 노출 문자열을 다음 표면에서 `geoIM3D`로 정리했다.

- 한국어 UI와 안내 문구
- Error/Diagnostic Prefix
- Plugin 관리 화면
- Sidecar/Desktop 안내
- Project File Dialog 표시명
- Assistant System Prompt
- Print Attribution 기본값
- Whitebox 제품 도구 그룹 Label과 Generator
- Windows Tauri Capability 설명

원본 GeoLibre Attribution과 내부 Compatibility Identifier는 유지했다.

### Private Repository Snapshot

- Runbook: `docs/rebranding/PRIVATE_REPOSITORY_SNAPSHOT.md`
- Directive 연결: `docs/directives/01_REBRANDING_SCOPE.md`

Runbook은 승인된 Commit에서 `git archive`로 Snapshot을 만들고 기존 `.git` History, Remote, 미추적 파일, Secret을 복사하지 않도록 정의한다. License/Attribution, Provenance, Secret Scan, SHA-256 Manifest, 별도 Push 승인과 단일 Initial Commit 검증을 포함한다.

실제 Private Repository 생성이나 Push는 이번 Phase에서 수행하지 않았다.

## 검증 결과

| Gate | 결과 |
|---|---:|
| Brand CLI | PASS |
| Brand Contract | 5 passed |
| 관련 Target Regression | 41 passed |
| ESLint | Error 0, 기존 Warning 23 |
| Production Build | 통과 |
| Frontend Coverage | Lines 82.12%, Branches 83.65%, Functions 68.56% |
| Backend Coverage | 246 passed, 16 skipped, 62.43% |
| Worker TypeScript | 3개 통과 |
| Playwright Full Suite | 24 passed |
| Snapshot Runbook Bash Syntax | 11 blocks passed |
| Snapshot/Manifest/Final Archive Dry-run | 통과 |
| Gitleaks Staged Snapshot | 16.50 MB scanned, Leak 0 |
| Windows npm Install Audit | 1,402 packages audited, Vulnerability 0 |
| Windows Production Build | 통과 |
| Windows MSVC Cargo Check | 통과 |
| Windows Tauri Runtime | 통과 |

## Windows Native Runtime Smoke

임시 Windows 전용 Source Tree에서 Linux `node_modules`와 Build Artifact를 제외하고 다음 순서로 수행했다.

1. Windows Node 22.14.0 / npm 11.18.0 / Rust 1.97.0 확인
2. `npm ci`
3. `npm run check:brand`
4. `npm run build`
5. Windows MSVC `cargo check`
6. Windows Native `npm run tauri:dev`
7. WebView2 CDP로 2D/3D Tab과 DOM 상태 검증
8. App/Build Process 종료와 임시 Source 정리

Runtime 확인:

- Main Window Title: `geoIM3D`
- Process: Responding
- Document Title: `geoIM3D`
- HTML Language: `ko`
- Cesium 3D 기본 시작 확인
- MapLibre 2D 전환 확인
- 2D 전환 후 Visible Canvas 5개
- 한국어 Workspace Label 확인
- 외부 지도 Tile 렌더링 확인
- Error Modal, 흰 화면, 명백한 Rendering 장애 없음
- 종료 후 geoIM3D/임시 Build Process 0건

증거:

- `docs/rebranding/evidence/phase0-windows-smoke-2026-07-17.png`
  - Windows Tauri 전체 Window, Cesium 3D 기본 상태
  - SHA-256: `a07690264390dea05ed98d0e2d8c878c1df748763a192c4d8c8de9e0542c049d`
- `docs/rebranding/evidence/phase0-windows-smoke-2d-2026-07-17.png`
  - Windows WebView2, MapLibre 2D Tab 전환 상태
  - SHA-256: `87fca2b60bacdba368638fe08ce08170ed9c41fc0542d0589f692fb9615c4d3f`

두 Capture 모두 실제 Windows Tauri/WebView2 실행본이다. 외부 지도 Tile도 로딩된 상태다.

## 알려진 환경 제한

WSL `npm run check:rust`는 Source 오류가 아니라 Ubuntu Desktop 개발 Package 부재로 완료되지 않았다.

- 최초 누락: `dbus-1.pc`
- DBus를 임시 Package Root로 제공한 뒤 확인된 추가 누락: GTK3, GLib, WebKitGTK/JavaScriptCoreGTK, Soup, Cairo, Pango 계열 `pkg-config` 개발 Metadata
- `sudo` 비대화형 권한 없음
- System Package는 변경하지 않음

동일 Source의 Windows MSVC `cargo check`와 실제 Tauri Runtime은 모두 통과했다. Linux Desktop Package가 Release Target이 되면 CI Image 또는 운영 Build Host에 Tauri Linux 필수 System Package를 선언하고 별도 Linux Runtime Gate를 수행해야 한다.

## Phase 0 완료 판정

- Brand 위반 Fixture가 실패한다.
- 현재 Product Surface는 명시적 Attribution Allowlist로 통과한다.
- Allowlist는 About/Attribution과 공개 Plugin Compatibility Contract로 제한된다.
- Snapshot Runbook은 History Rewrite 없이 승인 기반으로 수행된다.
- 신규 Runtime Dependency가 없다.
- Browser Full Gate와 Windows Native Runtime Smoke가 통과한다.

따라서 Phase 0 Baseline/Inventory는 완료다. 다음 작업은 Phase 3 Project Identity Contract다.
