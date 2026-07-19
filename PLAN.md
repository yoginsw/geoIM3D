# geoIM3D 개발 진행 및 재개 계획

> 이 문서는 개발 중단 후 가장 먼저 읽는 **진행 상태의 단일 Source of Truth**다.
> 제품 요구사항은 `docs/directives/`, 완료 증거는 `docs/rebranding/`을 따른다.

## 1. 프로젝트 목표

GeoLibre 2.1.0의 내부 Schema와 `@geolibre/*` Plugin API 호환성을 유지하면서 JBT의 **지오아임3D(geoIM3D)** 제품으로 특화한다.

핵심 목표:

- 한국어·Light 기반의 2D/3D 공간 업무 UX
- `.geoim3d.json` Project Identity와 Windows/Web 배포
- Secret-safe Credential 관리
- VWorld Built-in Plugin
- 건축·토목·부동산·환경·안전 분야의 3D 업무 기능

## 2. 현재 Repository 현실

| 항목 | 현재 상태 |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Root | `/home/nurig/projects/GeoLibre` |
| 작업 Branch | `main` |
| Main 반영 | Phase 0~4 통합, 독립 Review, Fork `main` Push 완료 |
| Git 상태 | 재개 직후 `git status --short --branch`로 확인하며 문서에 Clean 상태를 고정 기록하지 않음 |
| Node / npm | Node 24.x / npm 11.x (`package.json` 요구 Node >=22) |
| 구조 | npm Workspaces: `apps/*`, `packages/*`, `workers/*` |
| Frontend | React + TypeScript + Vite + MapLibre + Cesium |
| Desktop | Tauri 2 / Rust |
| Backend | Python Sidecar, 전용 `.venv` 사용 |
| 제품 표시 Version | `geoIM3D 1.0.0` (`apps/geolibre-desktop/src/config/brand.ts`) |
| 내부 Package Version | GeoLibre 호환을 위해 현재 `2.1.0` 유지 |

### 반드시 유지할 경계

- `@geolibre/core` Zustand Store가 Domain State의 단일 진실 공급원이다.
- 내부 `@geolibre/*` Namespace, Project Schema 구조, External Plugin API를 초기 버전에서 유지한다.
- 사용자 화면의 `GeoLibre`는 About/License/Third-party Attribution 외에는 노출하지 않는다.
- Secret은 Source, URL, 로그, Project, Local Storage에 저장하지 않는다.
- 보안, Credential, 비호환 Schema/API, History Rewrite, Release는 구현 전 승인받는다.

## 3. Phase 진행 현황

상태 정의:

- `완료`: Phase DoD와 Runtime 검증 완료
- `진행 중`: 작업 Branch와 승인된 Acceptance를 기준으로 구현 또는 검증 중
- `부분 완료`: 일부 산출물 또는 선행 기반만 존재
- `미착수`: 해당 Phase의 제품 구현과 Acceptance가 시작되지 않음

| Phase | 상태 | 완료/누락 요약 | 근거 |
| -------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 0. Baseline/Inventory | **완료** | Brand 회귀 Script/Contract, 사용자 노출 정리, Snapshot Runbook, Full Gate, Windows 2D/3D Runtime 증거 완료 | `docs/rebranding/00_PHASE0_CLOSURE.md` |
| 1. Brand Foundation | **완료** | 중앙 Brand Config, JBT Token/Icon, Page/PWA/Window/About, Attribution 적용 | `docs/rebranding/01_BRAND_INVENTORY.md` |
| 2. Feature Profile/기본 UX | **완료** | 한국어·Light, Cesium 기본, 2D/3D Tab, 숨김 기능 우회 차단, Browser 검증 | `docs/rebranding/02_DEFAULT_UX.md` |
| 3. Project Identity | **완료** | Canonical `.geoim3d.json`, Portable Credential Boundary, Open/Save/Recent/URL/Rust Path Guard 완료 | `docs/rebranding/03_PROJECT_IDENTITY.md` |
| 4. Credential/Settings | **완료** | Windows Credential Manager, Web Memory-only, Legacy 즉시 폐기, 활성 Consumer teardown, 통합 Finding 수정·재Review 및 Fork `main` 반영 완료 | `docs/rebranding/04_CREDENTIAL_ARCHITECTURE.md` |
| 5. VWorld Built-in Plugin | **진행 중** | Windows Desktop 전용 Private Transport 결정, 공식 API/약관·보안·저장·Attribution Acceptance 수정. 구현과 Contract Test 대기 | `docs/rebranding/05_VWORLD_ACCEPTANCE.md` |
| 6. Windows/Web Packaging | **진행 중** | Bundle ID/Update 제거/PWA/Installer·Portable Smoke 완료. OS Association·공개 자동 배포 제외, Plugin Registry Loopback-only 확정. Docker Runtime·MSIX Signing은 환경 Gate 대기 | `apps/geolibre-desktop/src-tauri/tauri.conf.json` |
| 7. 3D 업무 기능 강화 | **진행 중** | Phase 7A CAD/GIS 좌표 정합 완료 및 Security·Windows·Geospatial 최종 독립 Review 승인. BIM/IFC 등 나머지 업무 기능은 미착수 | `docs/rebranding/07A_CAD_GIS_COORDINATE_ALIGNMENT.md` |
| 8. Release 1.0 | **미착수** | 일부 Gate 통과 이력만 존재. 설치본·Offline·Security/License Audit·Release Artifact 없음 | `docs/directives/08_TESTING_RELEASE.md` |

## 4. 최신 검증 Baseline

기준일: **2026-07-19**, Phase 7A 최종 Exact Stage 독립 Review 승인 상태.

| Gate | 최신 확인 결과 |
| ------------------------------------- | ---------------------------------------------------------------------: |
| Brand Contract | PASS |
| Credential Architecture Target | 19 passed |
| Frontend Full Suite | 2,946 passed, 1 skipped |
| Frontend Coverage | Lines 82.14%, Branches 83.33%, Functions 69.52% |
| Backend | 257 passed, 16 skipped, Coverage 64.19% |
| CAD/Cesium/Packaging Target | 33 passed |
| Conversion/Security Target | 52 passed |
| Worker TypeScript | 3개 통과 |
| Playwright Full Suite | 26 passed |
| Product Tab E2E | 1 passed |
| ESLint | Error 0, 기존 Warning 21 |
| Production Build | 통과 |
| Credential Sentinel Production Bundle | Leak 0 |
| Windows MSVC Cargo Check | 통과 |
| Windows Rust Full Suite | 39 passed |
| Windows Credential Manager Round-trip | 통과 |
| Phase 7A Exact Stage Gitleaks | 27 files, Leak 0 |
| Windows Native Tauri | DXF Parse/Sanitize 및 Job `running → DELETE 200 → cancelled`, Child Process 0, App/Port Cleanup 0 |
| Windows Build/Bundle | Debug No-bundle, Release EXE, MSI, NSIS 통과 |
| Production Browser | 2D/3D Tab 및 Tile 정상, JavaScript Error 0 |

주의:

- Phase 7A Windows 증거는 Native Source Runtime과 Build/Bundle 생성 결과다. Installer 설치·제거 Smoke는 Phase 6 증거를 유지하며 Phase 7A에서 반복하지 않았다.
- JupyterLite Dependency가 없으면 Build가 기존 정책대로 Notebook Asset 생성을 건너뛴다. Product Profile에서는 숨김 상태다.
- Backend Coverage는 System Python 대신 Repository 전용 가상환경으로 실행한다.
- WSL Cargo Check는 Ubuntu GTK/WebKitGTK/DBus 개발 Package가 없어 환경 단계에서 중단된다. 동일 Source의 Windows MSVC Cargo Check와 Native Runtime은 통과했다.

## 5. 다음 권장 진행 순서

### 완료 — Sprint H0 / Phase 0 잔여 산출물 종료

**목적:** 이후 모든 Phase에서 자동으로 Brand 회귀와 안전한 Repository 이전 절차를 검증한다.

작업:

- [x] `scripts/check-geoim3d-brand.mjs` 추가
- [x] About/License/Attribution Allowlist를 제외한 사용자 노출 `GeoLibre` 검사
- [x] Source 내부 식별자와 사용자 노출 문자열을 구분한 Fixture/Test 추가
- [x] `docs/rebranding/PRIVATE_REPOSITORY_SNAPSHOT.md` 작성
- [x] Baseline 명령과 결과 갱신

Acceptance:

- [x] Script가 의도된 사용자 노출 위반 Fixture를 실패시킨다.
- [x] 현재 Source는 Allowlist 정책으로 통과한다.
- [x] Snapshot 절차가 `.git` 삭제/History Rewrite 없이 수행되도록 문서화된다.
- [x] Dependency 추가 없음.

검증:

```bash
npm run check:brand
npm run lint
npm run build
npm run test:frontend:coverage
backend/geolibre_server/.venv/bin/python -m pytest \
  backend/geolibre_server/tests \
  --cov=geolibre_server \
  --cov-report=term-missing \
  --cov-fail-under=55
npm run test:worker
npm run test:e2e
npm run check:rust
```

Windows Gate:

- [x] 실제 Windows Desktop에서 Source 실행 및 핵심 2D/3D 시작 Smoke를 재확인한다.
- [x] Linux/WSL 검증만으로 Phase 0 완료 처리하지 않는다.

**Stop Gate:** Script Allowlist가 About/License 외 제품 화면을 과도하게 허용하지 않는지 Review하고, Full Gate와 Windows Smoke 증거가 모두 있어야 Phase 0을 완료 처리한다.

### 완료 — Sprint 3A / Phase 3 Project Identity Contract

**승인된 기본 계약:** Canonical Save/Open Filter와 사용자 노출 확장자는 `.geoim3d.json`만 사용한다. 내부 Project Schema와 Plugin State는 변경하지 않는다.

**Legacy Import Gate:** `.geolibre`/`.geolibre.json` Import는 현재 범위에 포함하지 않는다. 필요 시 호환성·보안 영향과 별도 Import UX를 보고하고 보스의 명시적 승인을 받은 뒤 추가한다.

RED Contract:

- [x] `ensureProjectFileName()`이 신규 파일을 `.geoim3d.json`으로 생성한다.
- [x] Canonical Open/Save/Save As/Recent/Drag-and-drop가 `.geoim3d.json`만 노출·허용한다.
- [x] 승인 전 `.geolibre.json`/`.geolibre` Legacy Import가 노출되지 않는다.
- [x] 일반 `.json`은 Desktop 로컬 파일 읽기 Allowlist에서 계속 거부한다.
- [x] Malformed Project와 Credential 포함 Project 정책을 검증한다.
- [x] Round-trip 후 Layer/Map View/Plugin State가 보존된다.

구현 후보:

- `apps/geolibre-desktop/src/lib/file-names.ts`
- `apps/geolibre-desktop/src/lib/tauri-io.ts`
- `apps/geolibre-desktop/src/hooks/useProjectFileActions.ts`
- `apps/geolibre-desktop/src-tauri/src/lib.rs`
- 관련 Node/Rust Test

Acceptance:

- [x] Open/Save/Recent/Drag-and-drop가 `.geoim3d.json`에서 동작한다.
- [x] Legacy GeoLibre 확장자는 승인 전 Product Open Filter와 Import UX에 나타나지 않는다.
- [x] Project Schema Version과 External Plugin API는 변경되지 않는다.
- [x] Project 파일의 Runtime Environment Credential 값이 직렬화되지 않는다.

**Stop Gate:** `.geoim3d.json`은 유일 포맷으로 유지하되 OS Association은 등록하지 않는다. Package Smoke에서는 앱 내부 Open/Drop과 검증된 Startup Argument만 확인한다.

완료 증거: `docs/rebranding/03_PROJECT_IDENTITY.md`

### 완료 — Sprint 4A / Phase 4 Credential Architecture

**승인된 계약:** 기존 Browser Credential은 값을 읽어 Migration하지 않고 즉시 폐기하며 사용자가 다시 입력한다. Windows는 사용자별 geoIM3D App 전역 Credential Store, Web/PWA는 Memory-only를 사용한다.

완료 구현:

- [x] Share/Cesium/AI/VWorld/Geocoder Credential을 일반 Desktop Settings와 Project에서 분리
- [x] Windows Target-specific `keyring` Adapter와 고정 Credential ID Allowlist
- [x] Web Memory-only Backend와 Reload 폐기 정책
- [x] 저장된 값 미표시, 새 값 교체, 명시적 개별 삭제, 확인 후 전체 폐기
- [x] Project/URL/Public Runtime/Build-time Credential Sanitization
- [x] 값·길이·부분문자·Hash/Fingerprint Diagnostics 금지
- [x] Legacy `geolibre.desktopSettings` Credential Field 즉시 제거·덮어쓰기

확정 결정:

- [x] Windows Credential Backend: Windows Target 전용 Rust `keyring` Adapter
- [x] Legacy 정책: 자동 Migration 금지, 즉시 폐기 후 재입력
- [x] Scope: Windows 사용자별 App 전역, Project와 완전 분리
- [x] 삭제 UX: Provider별 개별 삭제 + 긴급 전체 폐기
- [x] Diagnostics: 설정 여부와 비민감 오류 Code만 허용

검증:

- [x] Credential Target 19 passed
- [x] Frontend Full/Coverage, Backend, Worker, Production Build, E2E 24 passed
- [x] Windows MSVC Cargo Check 및 Rust 19 passed
- [x] Windows Credential Manager 실제 write/read/delete Round-trip
- [x] 변경·신규 파일 Gitleaks Leak 0
- [x] 독립 Security Review Blocking Finding 0 또는 수정 완료

**Stop Gate 완료:** 통합 Finding 수정 후 최종 독립 Review Blocking Finding 0, Staged Gitleaks Leak 0, Merge Commit과 Fork `main` Remote SHA 일치를 확인했다.

완료 증거: `docs/rebranding/04_CREDENTIAL_ARCHITECTURE.md`

### Sprint 5A 이후 — VWorld Built-in Plugin

Phase 4 Credential Adapter 확정 후 진행한다.

공식 조사 및 구현 전 Acceptance: `docs/rebranding/05_VWORLD_ACCEPTANCE.md`

1차 Platform 범위: Windows Native Tauri 전용. Web/PWA는 Same-origin Relay가 별도 승인될 때까지 VWorld Plugin/Menu/Network Path를 등록하지 않는다.

순서:

1. 작업 시작 시 VWorld 공식 최신 문서 재확인
2. Client/DTO/Auth/Error/Rate-limit/Retry Adapter
3. Mock Contract와 오류 Test
4. VWorld 2D Layer
5. 통합 검색과 주소 ↔ 좌표 변환
6. 지적도·건물·용도지역
7. Attribution/약관 확인 후 허용 범위 Cache

금지:

- 비공식 Blog 기반 Endpoint/Parameter 사용
- API Key를 Query 전체 URL과 함께 로그 출력
- 약관 확인 전 영구 Tile Download 구현

## 6. 후속 Backlog

### Phase 6 — Packaging

- [x] Bundle ID `com.ejbt.geoim3d`
- [x] `.geoim3d.json` 유일 포맷 및 OS Association 부재
  - Windows Shell이 복합 확장자를 최종 `.json`으로 판정함을 실제 Smoke로 확인
  - Installer/MSIX/Portable은 File Association/ProgID/Open With를 등록하지 않음
  - 앱 내부 Open/Drop과 검증된 Startup Argument Loader만 지원
- [x] 자동 Update UI와 Background Check 제거
- [x] 승인 전 공개 배포 및 외부 Registry Egress 제거
  - Pages/Cloudflare Preview/Planetary Tile/Android/GitHub Release/Container/PyPI Publish Workflow 제거
  - Homebrew/AUR/COPR 자동 게시와 Credential 사용 경로 제거
  - Share/Viewer/Collaboration/Plugin Registry는 승인 Host 없이 Loopback-only
  - Docker Source Image는 Local/single-user 전용이며 공개 게시 금지
- [ ] Windows Installer/Portable Install·Run·Save·Open·Uninstall
  - Installer Install/Native Renderer/직접 Project Open/Uninstall 검증됨
  - Portable Extract/Run/Project Open/Registry 비변경 검증됨
  - 최종 Native Save Dialog Smoke는 미완료
- [x] Web PWA Offline
  - Production Build, 380-entry Precache, Manifest, 첫 방문 후 Offline Shell 검증됨
- [ ] Docker `geoim3d.docker`
  - Source/Build Contract는 검증됐으나 Docker Engine 부재로 Image Runtime Smoke 미완료

Phase 6 Packaging 완료 시점 자동 Gate(2026-07-19): Frontend `2,934 pass / 1 skip`, Windows Rust
`39 pass`, Python Scripting `30 pass / 2 skip`, Credential/Upstream-domain Bundle
Sentinel 부재. Unsigned MSIX는 일반 Release에서 게시하지 않으며 Windows SDK 및
Partner Center Identity가 준비된 Phase 8 환경에서 별도 검증한다.

최신 Windows Artifact Runtime 증거:

- NSIS: Install/Startup Argument Open/Launch/Uninstall PASS, File Association/ProgID 미등록
- Portable: Extract/Startup Argument Open/Launch PASS, Registry 비변경
- `geoIM3D_1.0.0_x64-setup.exe` SHA256:
  `E1EE58D03BA1B1C9E55F84F91ECC7424543988F8BB366577DA53345B4344DF1E`
- `geoIM3D-1.0.0-x64-portable.zip` SHA256:
  `406C659D4D270DADED21D5E10C136D2F99C131A7C7B82D1E1DFA730EE91CD012`

### Phase 7 — 3D 업무 기능

각 항목은 요구사항과 Acceptance 승인 후 별도 Sprint로 진행한다.

- [ ] BIM/IFC Import Adapter
- [x] CAD/GIS 좌표 정합 — **완료 / Security·Windows·Geospatial 최종 독립 Review 승인**
  - Branch: `feat/geoim3d-coordinate-alignment`
  - Windows Desktop 전용 DXF MVP
  - CRS Allowlist: `EPSG:4326`, `EPSG:3857`, `EPSG:5179`, `EPSG:5186`
  - CRS 직접 변환 + 2점 Similarity(이동·회전·균일축척)
  - 결과 WGS84 GeoJSON과 비민감 정합 Summary만 Project 저장
  - 요구사항/Acceptance: `docs/rebranding/07A_CAD_GIS_COORDINATE_ALIGNMENT.md`
- [ ] 토공량/절성토
- [ ] 경사·가시권·안전 분석
- [ ] 3D Scene Project Preset
- [ ] 환경·재난 Dashboard

### Phase 8 — Release 1.0

- [ ] Full Quality Gate
- [ ] Windows Package 실제 Smoke
- [ ] Offline Test
- [ ] License/Attribution Audit
- [ ] Brand 문자열 Audit
- [ ] npm/pip/cargo Security Audit
- [ ] Installer/Portable/Docker Artifact와 Checksum
- [ ] `geoIM3D 1.0.0` Release 승인

## 7. 재개 절차

새 Session 또는 다른 개발 Agent는 다음 순서로 시작한다.

```bash
cd /home/nurig/projects/GeoLibre

git status --short --branch
git log -5 --oneline
```

1. 가장 가까운 `AGENTS.md`와 루트 `AGENTS.md`를 읽는다.
2. 이 `PLAN.md`에서 첫 번째 미완료 Sprint와 Stop Gate를 확인한다.
3. 관련 `docs/directives/*.md`를 읽는다.
4. 현재 Branch가 이전 작업 Branch라면 새 작업별 Branch를 생성한다.
5. 변경 전 관련 Baseline을 실행하고 기존 실패와 신규 실패를 분리한다.
6. RED Contract → 최소 구현 → Target Test → Full Gate → 실제 Windows Runtime Smoke 순으로 진행한다.
7. 완료 시 아래 갱신 규칙에 따라 이 문서를 업데이트한다.

권장 다음 Branch:

```bash
git switch -c feat/geoim3d-bim-ifc-import
```

## 8. 검증 명령

기본 Gate:

```bash
npm run check:brand
npm run lint
npm run build
npm run test:frontend:coverage
backend/geolibre_server/.venv/bin/python -m pytest \
  backend/geolibre_server/tests \
  --cov=geolibre_server \
  --cov-report=term-missing \
  --cov-fail-under=55
```

변경 영역별 추가 Gate:

```bash
npm run test:worker
npm run test:e2e
npm run check:rust
```

모든 개발 Phase는 Linux/WSL Build만으로 완료 판정하지 않는다. 최소한 실제 Windows Desktop Source Runtime Smoke를 수행한다. Windows Identity, Startup Project Open, OS Association 부재, Credential, Offline 또는 Packaging 변경은 Installer/Portable까지 포함한 해당 기능의 실제 Windows Smoke를 추가한다.

## 9. 문서 갱신 규칙

각 Sprint 시작 시:

1. 해당 Phase를 `진행 중`으로 변경한다.
2. 작업 Branch와 승인된 Architecture 결정을 기록한다.
3. RED Test와 Acceptance Checklist를 확정한다.

각 Sprint 종료 시:

1. 완료 Checklist를 체크한다.
2. Phase 상태를 `완료` 또는 `부분 완료`로 갱신한다.
3. 최신 검증 결과와 알려진 제한을 갱신한다.
4. 다음 첫 작업과 Stop Gate를 갱신한다.
5. 상세 완료 증거는 `docs/rebranding/` 또는 해당 Phase 문서에 남긴다.

진행 중단 시 최소 Handoff:

```text
현재 Branch:
진행 중 Phase/Sprint:
마지막 완료 작업:
현재 실패/Blocker:
다음 실행할 명령:
변경 파일:
검증 결과:
승인이 필요한 결정:
```

## 10. Sprint Review 템플릿

```markdown
## Sprint Review — <Phase/Sprint>

- 상태: 완료 / 부분 완료 / Blocked
- 구현: <사용자 동작 기준>
- 주요 변경 파일: <paths>
- 검증: <commands and exact results>
- 기존 실패: <none or list>
- 신규 회귀: <none or list>
- 보안/호환성: <impact>
- 잔여 위험: <risks>
- 다음 권장 단계: <one concrete sprint>
- 승인 필요: <decision or none>
```
