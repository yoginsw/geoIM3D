# geoIM3D Sprint 3A — Project Identity Contract

## 기준

- 완료일: 2026-07-17
- Branch: `feat/geoim3d-project-identity`
- Canonical Project Extension: `.geoim3d.json`
- Legacy Policy: 별도 승인 전 `.geolibre`/`.geolibre.json` Import 미제공

## 구현 결과

### 단일 Project Identity

다음 사용자 경계가 `.geoim3d.json`을 공통으로 사용한다.

- Browser/Tauri Open
- Save/Save As/In-place Save
- Recent Project 저장·재열기
- URL/Deep Link
- Browser/Tauri Drag-and-drop
- Share/Collaboration Snapshot 파일명

`ensureProjectFileName()`은 빈 이름과 일반 이름에 Canonical 확장자를 붙이고, 기존 `.json`, `.geolibre`, `.geolibre.json` 끝부분은 `.geoim3d.json`으로 교체한다. Windows·POSIX Path와 URL Path를 동일하게 검증한다.

### Open/Drop 방어

- Browser Picker의 MIME/확장자와 Fallback `<input accept>`를 Canonical로 제한한다.
- Tauri Dialog Filter와 선택 후 검증을 모두 적용한다.
- Rust `read_project_file`은 `.geoim3d.json` 이외의 Local Path를 거부하고, Symlink 해석 후에도 확장자를 재검증한다.
- Drag-drop은 전체 파일 목록을 읽기 전에 분류한다.
  - Canonical Project 1개: Project Open
  - Legacy Project: 명시적 거부
  - Project+Data 혼합 또는 Project 여러 개: 원자적 거부
  - Data만 존재: 기존 Layer Import 유지
- Persisted Legacy/Generic Recent 항목은 Hydration 시 제거한다.
- 사용자 Open URL/Deep Link는 Canonical 파일 URL만 허용한다.
- 숨겨진 Upstream Share Service API는 전용 Fetch Adapter로 분리하고 Recent/Writable Path로 저장하지 않는다.

### Credential-safe Serialization

Save, Share, Collaboration, Embed가 공유하는 Portable Project 경계에서 `preferences.environmentVariables`를 항상 비운다. Collaboration/Embed의 송신뿐 아니라 수신 Project도 Store 적용 전에 동일하게 정리하며, Collaboration Relay도 Storage/Broadcast 전에 다시 제거한다. Runtime의 기존 Live Store 값은 Local Save/Share 시 유지되며 외부 Project에는 기록·전송하지 않는다.

Round-trip Test에서 다음을 확인했다.

- Sentinel Credential 값 미포함
- Environment Variable 목록 제거
- Layer 보존
- Map View 보존
- Plugin Active ID/Settings 보존

Plugin Settings는 내부 Compatibility를 위해 Opaque State로 보존한다. Plugin이 자체 설정에 임의 Secret을 넣는 문제는 이번 Sprint에서 Schema를 파괴적으로 검사하지 않으며, Phase 4 Credential Adapter/Plugin Credential API에서 별도로 통제한다. 따라서 Sprint 3A 완료는 Release 보안 완료를 의미하지 않는다.

### Compatibility Boundary

변경하지 않은 항목:

- Project Schema Version
- `@geolibre/*` Package 이름
- GeoLibre Internal Type/API Identifier
- External Plugin API Identifier
- Upstream Share Service Protocol

## 검증 결과

| Gate | 결과 |
|---|---:|
| Project Identity/관련 Target | 92 passed |
| Frontend Coverage | Lines 82.16%, Branches 83.69%, Functions 68.66% |
| Backend | 246 passed, 16 skipped, Coverage 62.43% |
| Worker TypeScript | 3개 통과 |
| Playwright Full Suite | 24 passed |
| Product Profile 반복 E2E | 2 passed |
| Brand Gate | PASS |
| Staged Diff Gitleaks | Leak 0 |
| ESLint | Error 0, 기존 Warning 21 |
| Production Build | 통과 |
| Windows npm Audit | 1,402 packages, Vulnerability 0 |
| Windows Rust Canonical Guard | 1 passed |
| Windows MSVC Cargo Check | 통과 |
| Windows Tauri Debug No-bundle Build | 통과 |
| Windows Debug Tauri Runtime | 통과 |

WSL `npm run check:rust`는 Source 오류가 아니라 기존 환경 제한인 GTK3/GLib/WebKitGTK/DBus 계열 개발 Package 부재로 중단됐다. 동일 Source의 Windows MSVC Unit Test/Cargo Check/Tauri Build는 통과했다.

## Windows Native Runtime

Windows 전용 임시 Source Tree에서 Linux `node_modules`, Rust `target`, Build/Test Cache를 제외하고 다음을 수행했다.

1. Windows Node `22.14.0`, npm `11.18.0`, Rust/Cargo `1.97.0` 확인
2. Windows Native `npm ci`
3. Canonical Rust Guard Unit Test
4. Windows MSVC `cargo check`
5. Tauri CLI Debug `--no-bundle` Build
6. 최종 Debug Tauri Process 실행
7. WebView2 CDP로 3D→2D 전환과 DOM/Console 검증
8. Win32 `PrintWindow`로 Native Title Chrome 포함 전체 창 캡처
9. App Process 종료 및 Windows 임시 Source Tree 삭제

Runtime 확인:

- Main Window Title: `geoIM3D`
- Process: Responding
- Document Title: `geoIM3D`
- HTML Language: `ko`
- URL: `http://tauri.localhost/`
- Cesium 3D: Visible Canvas 1개
- MapLibre 2D: Visible Canvas 5개
- CDP Console/Page Error: 0
- 외부 OpenFreeMap/OpenMapTiles/OSM 지도와 Attribution 렌더링 확인
- 흰 화면 및 Error Modal 없음
- 종료 후 App Process 0건
- 임시 Windows Source Tree 제거 확인

증거:

- `docs/rebranding/evidence/sprint3a-windows-native-runtime-2026-07-17.png`
  - 실제 Windows Tauri 전체 Window, Native Title Chrome + Cesium 3D
  - SHA-256: `0c0ed15e153ea416d18571e0abbb3d9e1baae43ad0d812c87c0554c4d71c9a8f`
- `docs/rebranding/evidence/sprint3a-windows-webview-2d-2026-07-17.png`
  - 실제 Windows WebView2, MapLibre 2D 전환 상태
  - SHA-256: `ad1d080300aead80f581522bca480cd92a9ccc3828adc9d7ad2a73f16a486b5d`

두 파일은 Mode `0644`다. 외부 지도 타일은 두 Capture 모두 로딩됐다.

### 검증 범위 구분

App-level Project Contract는 다음 명령으로 검증했다.

```bash
node --import tsx --test \
  tests/file-names.test.ts \
  tests/project-identity.test.ts \
  tests/project-url.test.ts \
  tests/share-gallery.test.ts \
  tests/share-fetch.test.ts \
  tests/share-geolibre.test.ts \
  tests/onboarding-suppression.test.ts
npm run test:frontend:coverage
npm run test:e2e
```

Target 92건은 Canonical 이름/Open·Save 경계/Recent/Drop/Deep Link, Browser Save post-selection 검증, Share Fetch Adapter 및 Client/Relay Portable Snapshot Redaction을 포함한다. Playwright 24건에는 Browser Save→Reopen Round-trip이 포함된다.

Windows Native 증거는 최종 Desktop Source의 MSVC Compile, Rust Guard, Tauri Config/Build, App 기동, 20초 생존, 3D→2D Renderer 전환과 외부 지도 로딩을 검증한다. Windows Native File Dialog를 통한 Open/Save/Recent/Drop/Deep Link 상호작용은 이번 Screenshot 증거가 검증하지 않으며, File Association/Installer File Smoke와 함께 Sprint 6A에서 수행한다.

## 의도적으로 지연한 항목

`PLAN.md` Stop Gate에 따라 OS File Association/Open With/ProgID/Icon과 실제 Installer Open/Save Smoke는 Sprint 6A에서 수행한다. 이번 Tauri Release Bundle 생성은 Build 경로 검증 중 발생했지만 Release Artifact로 보관·배포하지 않았으며, 임시 Windows Tree와 함께 제거했다.

## 완료 판정

- Canonical Open/Save/Recent/Drop/Deep Link Contract 통과
- Legacy Import 미노출 및 명시적 거부
- Runtime Environment Credential 미직렬화
- Layer/Map/Plugin State Round-trip 보존
- Internal Schema/Plugin Compatibility Identifier 유지
- Browser Full Gate 및 Windows Native Runtime 통과

따라서 Sprint 3A Project Identity Contract는 완료다. 다음 보안 구현은 `PLAN.md` Decision Gate 4의 명시적 승인 후 진행한다.
