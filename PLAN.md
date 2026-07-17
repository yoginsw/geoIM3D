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
|---|---|
| Root | `/home/nurig/projects/GeoLibre` |
| 작업 Branch | `feat/geoim3d-project-identity` |
| Main 반영 | 아직 미병합 |
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
|---|---|---|---|
| 0. Baseline/Inventory | **완료** | Brand 회귀 Script/Contract, 사용자 노출 정리, Snapshot Runbook, Full Gate, Windows 2D/3D Runtime 증거 완료 | `docs/rebranding/00_PHASE0_CLOSURE.md` |
| 1. Brand Foundation | **완료** | 중앙 Brand Config, JBT Token/Icon, Page/PWA/Window/About, Attribution 적용 | `docs/rebranding/01_BRAND_INVENTORY.md` |
| 2. Feature Profile/기본 UX | **완료** | 한국어·Light, Cesium 기본, 2D/3D Tab, 숨김 기능 우회 차단, Browser 검증 | `docs/rebranding/02_DEFAULT_UX.md` |
| 3. Project Identity | **미착수** | 현재 `.geolibre(.json)`만 지원. `.geoim3d.json`과 File Association 없음 | `apps/geolibre-desktop/src/lib/file-names.ts` |
| 4. Credential/Settings | **미착수** | OS Credential Store/Web Memory-only 미구현. 기존 Share/AI/Cesium Credential은 localStorage 사용 | `apps/geolibre-desktop/src/hooks/useDesktopSettings.ts` |
| 5. VWorld Built-in Plugin | **미착수** | Plugin, Menu, Client, API 호출, Contract Test 없음 | `docs/directives/05_VWORLD_INTEGRATION.md` |
| 6. Windows/Web Packaging | **부분 완료** | Product Name/Icon만 적용. Bundle ID, File Association, Update 제거, Docker, Offline Smoke 누락 | `apps/geolibre-desktop/src-tauri/tauri.conf.json` |
| 7. 3D 업무 기능 강화 | **미착수** | 기존 Upstream 3D 기반은 있으나 geoIM3D 요구사항/Acceptance 없음 | `docs/directives/10_IMPLEMENTATION_PLAN.md` |
| 8. Release 1.0 | **미착수** | 일부 Gate 통과 이력만 존재. 설치본·Offline·Security/License Audit·Release Artifact 없음 | `docs/directives/08_TESTING_RELEASE.md` |

## 4. 최신 검증 Baseline

기준일: **2026-07-17**, Phase 0~2 완료 상태.

| Gate | 최신 확인 결과 |
|---|---:|
| Brand Contract | 8 passed |
| Product/Target Contract | 71 passed |
| Frontend Coverage | Lines 82.30%, Branches 83.66%, Functions 68.58% |
| Backend | 246 passed, 16 skipped, Coverage 62.43% |
| Worker TypeScript | 3개 통과 |
| Playwright Full Suite | 24 passed |
| Product Tab E2E | 1 passed |
| ESLint | Error 0, 기존 Warning 23 |
| Production Build | 통과 |
| Windows MSVC Cargo Check | 통과 |
| Windows Native Tauri | Title `geoIM3D`, `lang=ko`, Cesium 3D 시작/MapLibre 2D 전환, Tile 정상 |
| Production Browser | 2D/3D Tab 및 Tile 정상, JavaScript Error 0 |

주의:

- 이 Baseline은 Source/Browser와 Windows Native Tauri Source Smoke 증거다. Windows 설치 Package Smoke 증거는 Phase 6에서 추가한다.
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

**Stop Gate:** App-level Round-trip 통과 후 Windows File Association은 Sprint 6A에서 Package Smoke와 함께 적용한다.

완료 증거: `docs/rebranding/03_PROJECT_IDENTITY.md`

### Decision Gate 4 — Credential Architecture

Phase 4는 보안 변경이므로 구현 전에 보스 승인이 필요하다.

권장 방향:

- Desktop: Share/Cesium/AI/VWorld Secret을 Tauri/Rust Credential Adapter를 통해 Windows Credential Manager에 저장
- Web: Share/Cesium/AI/VWorld Secret을 Module/Store Memory-only로 유지하고 Reload 시 제거
- 공통 UI: Provider별 입력/삭제/상태만 제공하고 실제 Secret 값을 다시 표시하지 않음
- Project/Plugin State/Local Storage/IndexedDB/URL/로그: 저장 금지
- 기존 `geolibre.desktopSettings` localStorage Blob에서 Secret Field를 제거하고, 승인된 Migration/폐기 정책에 따라 잔존 값을 정리

결정이 필요한 항목:

- [ ] Windows Credential Backend/Library 선정
- [ ] 기존 localStorage `shareToken`/AI/Cesium Credential의 Migration 또는 즉시 폐기 정책
- [ ] Desktop OS Credential 이전·삭제와 Web Reload 제거 Test 범위
- [ ] VWorld Key의 이름·Scope·삭제 UX
- [ ] Credential Diagnostic Redaction 범위

**보안 위험:** 현재 Upstream AI/Cesium Credential은 localStorage에 남는다. Phase 4 완료 전 Release 대상으로 간주하지 않는다.

### Sprint 5A 이후 — VWorld Built-in Plugin

Phase 4 Credential Adapter 확정 후 진행한다.

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

- [ ] Bundle ID `com.ejbt.geoim3d`
- [ ] `.geoim3d.json` File Association/ProgID/Icon
- [ ] 자동 Update UI와 Background Check 제거
- [ ] Windows Installer/Portable Install·Run·Save·Open·Uninstall
- [ ] Web PWA Offline
- [ ] Docker `geoim3d.docker`

### Phase 7 — 3D 업무 기능

각 항목은 요구사항과 Acceptance 승인 후 별도 Sprint로 진행한다.

- [ ] BIM/IFC Import Adapter
- [ ] CAD/GIS 좌표 정합
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
git switch -c feat/geoim3d-project-identity
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

모든 개발 Phase는 Linux/WSL Build만으로 완료 판정하지 않는다. 최소한 실제 Windows Desktop Source Runtime Smoke를 수행한다. Windows Identity, File Association, Credential, Offline 또는 Packaging 변경은 Installer/Portable까지 포함한 해당 기능의 실제 Windows Smoke를 추가한다.

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
