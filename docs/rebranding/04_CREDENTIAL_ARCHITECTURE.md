# geoIM3D Phase 4 — Credential Architecture Closure

## 기준

- 완료일: 2026-07-17
- Branch: `feat/geoim3d-credential-architecture`
- 승인 계약:
  - 기존 `localStorage` Credential은 값을 읽어 Migration하지 않고 즉시 폐기
  - Windows Desktop은 Windows 사용자별 geoIM3D App 전역 OS Credential Store 사용
  - Web/PWA는 Memory-only이며 Reload/Browser 종료 시 폐기
  - Credential은 Project, URL, 일반 Desktop Settings, 공개 Runtime Env, 로그와 Diagnostics에 저장·노출하지 않음
  - Provider별 개별 삭제와 긴급 대응용 전체 폐기 제공
  - 저장된 값, 길이, Prefix/Suffix, 마지막 문자, Hash/Fingerprint를 UI·오류·Diagnostics에 표시하지 않음

## 구현 결과

### Credential 범위와 Allowlist

Frontend와 Rust가 고정 Credential ID Allowlist를 사용한다.

- Share Token
- Cesium Ion Token
- VWorld API Key
- AI Provider Credential
- Geocoder Provider API Key
- Google Maps, Mapillary, Protomaps, TomTom, HERE, Amazon Location Service Credential

임의 Credential ID, 임의 Windows Credential 항목, Shell/PID/파일 경로 입력은 허용하지 않는다.

### Windows Desktop

- Tauri Command:
  - `credential_load`
  - `credential_set`
  - `credential_delete`
  - `credential_clear`
- Rust `keyring` Dependency는 Windows Target에만 적용한다.
- Service Namespace와 Credential ID를 geoIM3D 범위로 고정한다.
- Credential 값은 Rust 오류 문자열이나 App Diagnostics로 전달하지 않는다.
- 전체 폐기는 Allowlist를 순회하며 실패 시 비민감 오류 Code만 반환한다.
- Cesium Package의 Public Default Token은 Runtime에서 사용자 Token 또는 빈 값으로 항상 Override하여 무승인 Ion 사용을 차단한다.

### Web/PWA

- Module/Store Memory-only Backend를 사용한다.
- `localStorage`, `sessionStorage`, IndexedDB에 Credential을 저장하지 않는다.
- Reload 또는 Browser 종료 후 값이 유지되지 않는다.
- 공개 `window.__GEOLIBRE_RUNTIME_ENV__`와 `geolibre:runtime-env-change` Event에는 비Credential Runtime 값만 둔다.
- OS Environment Credential Snapshot도 공개 `window`가 아닌 Module-private Memory에 둔다.
- Vite의 일반 `VITE_*`/`TAURI_*` Client 자동 노출을 비활성화하고 검토된 비민감 배포 변수만 고정 Allowlist로 Bundle에 제공한다.
- 공개 `@geolibre/core` Runtime API는 Credential을 반환하거나 설정하지 않는다.
- Credential은 Build-time Client Allowlist에 포함하지 않으며 Desktop App-private Adapter에 보관한다.
- `@geolibre/map`과 Built-in Plugin에는 Host가 write-only Setter로 필요한 Service 값만 주입한다. External Plugin API에는 Credential Getter를 제공하지 않는다.

### Legacy Credential 폐기

`geolibre.desktopSettings`의 과거 Credential Field는 App 시작 시 Runtime Store로 전달하지 않는다.

- `shareToken`
- `cesiumIonToken`
- `aiProviderEnv`
- 관리 대상 Geocoder/Environment Credential

Legacy Blob은 Parse 직후 Secret Field가 제거된 Settings로 덮어쓴다. 손상된 Blob도 기본 Settings로 덮어써 잔존 값을 폐기한다.
과거 Mapillary Plugin의 별도 `localStorage` Token Key도 값을 읽지 않고 Bootstrap 시 즉시 삭제한다.

### Settings UX

- 저장된 Credential을 Input `value`에 다시 채우지 않는다.
- Input은 교체용 신규 Draft이며 Dialog를 열 때 빈 값으로 시작한다.
- 빈 Draft 저장은 기존 Credential 삭제가 아니다.
- 새 값이 입력된 Credential만 교체한다.
- 개별 삭제는 명시적 삭제 Button으로 수행한다.
- 전체 폐기는 사용자 확인 후 수행한다.
- UI 상태는 설정 여부와 Backend 종류, 비민감 오류 Code만 표시한다.

### Project 및 외부 경계

관리 대상 Credential은 다음 경계에서 제거한다.

- Project Save/Open/Recent
- URL/Deep Link Project Load
- Project `preferences.environmentVariables`
- Project `geocoding.apiKeys`
- Share/Collaboration/Embed/Relay Portable Snapshot
- 공개 Runtime Environment와 Build-time Credential Bridge

Legacy Project가 Device Credential Store를 덮어쓰지 못한다. 내부 `GeoLibreProject`, Project Schema Version, `@geolibre/*`, `GeoLibreAppAPI` 및 Plugin Compatibility Identifier는 유지한다.

## 검증 결과

| Gate | 결과 |
| -------------------------------------------- | ----------------------------------------------: |
| Credential Architecture Target | 15 passed |
| Frontend Full Suite | 2,873 passed, 1 skipped |
| Frontend Coverage | Lines 82.44%, Branches 83.61%, Functions 68.79% |
| TypeScript | PASS |
| Brand Gate | PASS |
| ESLint | Error 0, 기존 Warning 21 |
| Production Build | PASS |
| Credential Sentinel Production Bundle | Leak 0 |
| Worker TypeScript | 3개 PASS |
| Backend | 246 passed, 16 skipped |
| Playwright Production E2E | 24 passed |
| Windows MSVC Cargo Check | PASS |
| Windows Rust Full Suite | 19 passed |
| Windows Credential Manager Native Round-trip | 1 passed |
| 변경·신규 파일 Gitleaks | Leak 0 |
| `git diff --check` | PASS |

Windows Credential Manager Round-trip은 제품 Credential ID와 분리된 Test Service/일회성 Account로 실제 write/read/delete를 수행했다. Cleanup 성공을 Assertion으로 검증했으며 Credential 값은 출력하지 않았다.

Windows MSVC Compile/Test는 WSL UNC 경로에서 Tauri Packaging Resource가 Unix Sidecar 경로를 해석하지 못하는 기존 환경 제약을 분리하기 위해 Compile-only `TAURI_CONFIG`에서 Bundle Resource를 비웠다. 제품 Packaging 설정은 변경하지 않았다. Installer/Portable Runtime은 Phase 6 Gate다.

Repository 전체 Working Directory Gitleaks의 6건은 모두 Untracked Generated Output으로 분류됐다. Production `dist`의 Third-party Bundle Pattern 3건과 Windows Rust `target` Metadata Pattern 3건이며, Tracked 또는 Phase 4 변경 파일 Finding은 0건이다. Phase 4 변경·신규 파일만 격리한 Scan도 Leak 0이다. Finding 값은 출력하거나 문서화하지 않았다.

Credential Sentinel Build는 실제 Secret이 아닌 식별 가능한 Test Fixture를 관리 대상 `VITE_*` Credential Alias에 주입해 Production Build한 뒤 `dist` 전체를 검색했다. Vite Client Env Prefix 제한과 Public Allowlist 적용 후 Finding 0을 확인했다.

## 독립 Security Review Closure

| Finding | 조치 | Regression Evidence | 잔여 위험 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Project/Public Runtime/Build에서 추가 Credential Alias 우회 가능 | 공유 Alias Allowlist, Project/Public Runtime Sanitizer, App-private Credential Adapter, Vite Public Build Allowlist 적용                   | Alias Adversarial Contract, Sentinel Bundle Leak 0                     | 새 외부 Service 추가 시 두 Allowlist와 Contract 갱신 필요        |
| 공개 Core Runtime API가 전체 Credential Overlay를 반환·설정 가능 | Core Overlay/Setter 제거, App-private Adapter와 Map/Built-in Plugin write-only 최소 주입점으로 분리                                        | Public Core Credential 0 Adversarial Contract, Package Export Contract | Built-in Consumer 추가 시 최소 Getter와 Host Allowlist 갱신 필요 |
| Windows Credential 하나의 읽기 실패가 전체 Load를 실패시킴 | 성공 값과 비민감 `credential_read_failed`를 함께 반환하는 Partial Load Result 적용 | Frontend Partial Load Contract, Windows Rust 19/19 | 손상 항목은 사용자가 개별 삭제/교체 후 재시도 |
| 빈 Credential Setter 입력이 암묵적 삭제로 처리됨 | Frontend Memory/Desktop Backend와 Rust Command가 `credential_invalid_value`로 거절하고 Store/UI Error Code까지 보존하며 명시적 Delete 경로만 삭제 허용 | Empty-set Non-deletion/Code-preservation Contract, Windows Rust 19/19 | UI 빈 Draft는 기존대로 No-op이며 Backend 직접 호출도 기존 값을 유지 |
| 삭제된 Plugin Session Credential이 활성 Network Consumer에 잔류 | Google 3D Tiles Deck Layer/Projection, Mapillary Source/Viewer, Street View Control을 삭제 Event에서 즉시 teardown | Plugin Active-consumer Disposal Contract | 새 Plugin Consumer는 값 삭제와 활성 요청 객체 teardown을 함께 구현해야 함 |
| 삭제·교체된 AI Credential이 materialized Assistant Agent에 잔류 | 개별/전체 폐기와 Runtime 변경 시 Agent reset/cancel, Stream Generation 무효화, 대기 Code 승인 Queue 거절 | Assistant Active-consumer Disposal Contract | 새 AI Provider Consumer는 Credential 변경 시 SDK Client와 진행 중 요청을 함께 teardown해야 함 |
| Bedrock `AWS_REGION`이 저장되지만 Private Runtime Allowlist에서 제거됨 | `AWS_REGION`/`AWS_DEFAULT_REGION`을 Managed Environment Alias로 등록하고 Settings→Private Runtime 경로 검증 | Bedrock Region Private Runtime Contract | Region은 비Secret 설정이지만 AI Provider 설정 계약에 따라 Project/Public Runtime과 분리 |
| Map/Plugin Credential Setter가 `@geolibre/*` Public Index에 노출됨 | Public Export를 제거하고 Desktop Source 전용 App-private write-only Bridge로 제한 | Public Package Adversarial Export Contract | External Plugin API에는 Credential Getter/Setter를 추가하지 않음 |
| `VITE_PYODIDE_INDEX_URL`/`VITE_SIDECAR_URL` Build Override가 제한 Allowlist에서 누락됨 | 검토된 Non-secret Public Build Allowlist에 복구 | Production Bundle Override/Sentinel Contract | 일반 `VITE_*` 노출은 계속 금지 |
| Core Credential Getter의 Optional `env` Signature와 구현이 불일치 | Credential Environment를 필수 인자로 변경하고 no-argument Public Runtime 접근 제거 | Explicit Credential Environment Contract | App-private Resolver만 실제 Credential 값을 주입 |
| `OLLAMA_HOST`가 Credential Alias로 분류돼 Project Import에서 제거됨 | 비Secret 로컬 Endpoint Alias로 재분류해 Project/Public Runtime에서 보존 | OLLAMA_HOST Project/Public Runtime Compatibility Contract | Google API Alias는 Secret이므로 Legacy Project에서 제거 후 사용자 재입력 유지 |
| 전체 Credential 폐기가 첫 오류에서 중단될 가능성 | Rust가 전체 ID 삭제를 Best-effort로 계속하고 Frontend가 부분 실패 후 Status 재조회 | Credential Store Partial Failure Test, Windows Rust 19/19 | OS Store 자체 장애 시 비민감 오류 Code로 사용자 재시도 필요 |
| Credential Load 전 Plugin/Shell 초기화 가능 | 명시적 `loaded` Startup Gate 추가 | Startup Contract | 실제 Windows GUI 재시작 Scenario는 Phase 6에서 추가 |
| 기존 Plugin Browser Storage/Public Window 우회                   | Mapillary Legacy Storage 즉시 폐기, OS Env와 Plugin Credential을 Module-private로 전환, Built-in Panel Session Key를 전체/개별 폐기에 연결 | Plugin/OS Env/Disposal Contract                                        | Third-party Plugin에는 Credential API를 기본 제공하지 않음       |

Review Blocking Finding은 모두 수정·회귀 검증되었다.

## Runtime Evidence

### Web Production Preview

- Production Build를 Desktop 해상도 Browser에서 실행
- Share/Cesium/VWorld Input이 빈 값으로 표시됨
- Backend가 `Web memory-only`로 표시됨
- Credential 값·길이·부분문자·Hash/Fingerprint가 표시되지 않음
- 일반 Environment Variable의 잘못된 Project 평문 저장 경고를 제거함
- Browser Console은 최종 Origin에서 Error 0

증거:

- `docs/rebranding/evidence/phase4-web-credentials-upper-2026-07-17.png`
  - Share/Cesium Credential 교체 Input
  - SHA-256: `f093803f64c636c01d105e00b2fc0ab42f6c907f73ac5b3c2cfb2c006ba54860`
- `docs/rebranding/evidence/phase4-web-credentials-lower-2026-07-17.png`
  - VWorld Input, `Web memory-only`, 전체 폐기 UI
  - SHA-256: `5eece2115ffdac9ce639c302fc2ace718767877e8e683c51f59e54b333b793b6`

두 Capture는 **Windows Tauri Capture가 아닌 Desktop 해상도 Web Production Preview**다. Credential UI 검증용이며 외부 지도 Tile 로딩 증거로 사용하지 않는다. Windows OS Credential Store는 별도 Native Rust Round-trip으로 검증했다.

실제 Windows Tauri GUI에서 Credential 저장 → App 완전 종료 → 재시작 → 설정 상태 유지/Input 빈 상태 → 개별 삭제/전체 폐기를 연속 수행한 UI 증거는 이번 Phase에 없다. Rust-level Windows Credential Manager Round-trip과 Web Settings DOM Evidence는 통과했지만 동일한 검증은 아니며, Native Installer/GUI 재시작 Scenario는 Phase 6 Gate로 남긴다.

## Phase 4 완료 판정

- Legacy Browser Credential을 Migration 없이 폐기한다.
- Windows는 사용자별 OS Credential Store, Web은 Memory-only를 사용한다.
- Project/URL/Public Runtime/Build Bundle로 관리 대상 Credential이 유출되지 않는다.
- UI는 저장된 값과 값에서 파생된 정보를 재표시하지 않는다.
- 개별 삭제와 전체 폐기를 제공한다.
- Frontend/Backend/Worker/E2E/Windows Rust/Secret Scan Gate를 통과한다.
- 독립 Security Review Finding을 반영하고 전체 Gate를 재검증했다.
- 최종 Staged Secret Scan 후 Commit/Push한다.

독립 Review Blocking Finding은 수정 완료되었다. 최종 Staged Secret Scan, Commit, Fork Push 및 Local/Remote SHA 일치 확인 후 Phase 4를 완료 처리한다.
