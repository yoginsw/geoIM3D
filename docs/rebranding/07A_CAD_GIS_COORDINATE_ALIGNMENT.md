# Phase 7A — CAD/GIS 좌표 정합

## 1. 상태

- 단계: **완료 — 구현·Windows Runtime·Security/Windows/Geospatial 최종 독립 Review 승인**
- Branch: `feat/geoim3d-coordinate-alignment`
- 플랫폼: **Windows Desktop 전용 MVP**
- 입력: DXF
- 출력: 기존 `GeoLibreLayer` 호환 WGS84 GeoJSON Layer

## 2. 승인된 사용자 Workflow

1. 사용자가 **Processing → CAD/GIS 좌표 정합**을 연다.
2. Windows File Picker에서 `.dxf` 파일을 선택한다.
3. Source CRS를 선택한다.
4. 정합 방식을 선택한다.
   - **CRS 변환**: Source CRS 좌표를 WGS84로 변환한다.
   - **2점 Similarity**: CAD 제어점 2개와 대응 GIS 제어점 2개로 이동·회전·균일축척을 계산한 뒤 WGS84로 변환한다.
5. Preview Summary에서 Feature 수, 계산 축척, 회전각, 제어점 RMS 오차를 확인한다.
6. 적용하면 결과가 기존 GeoJSON Layer로 추가되고 2D/3D Map에서 동일 위치에 표시된다.

## 3. CRS Allowlist

| CRS | 용도 |
|---|---|
| `EPSG:4326` | WGS 84 경위도 |
| `EPSG:3857` | Web Mercator |
| `EPSG:5179` | Korea 2000 / Unified CS |
| `EPSG:5186` | Korea 2000 / Central Belt 2010 |

- 임의 PROJ 문자열과 Network EPSG 조회는 허용하지 않는다.
- 좌표 축 순서는 App 경계에서 항상 `x, y`로 고정한다.
- 결과 GeoJSON 좌표는 `longitude, latitude[, altitude]` 순서의 WGS84이다.

## 4. 2점 Similarity Contract

Source 제어점 `S1`, `S2`와 Target 제어점 `T1`, `T2`에 대해 다음을 계산한다.

- 균일축척: `|T2 - T1| / |S2 - S1|`
- 회전: `angle(T2 - T1) - angle(S2 - S1)`
- 이동: 회전·축척된 `S1`이 `T1`과 일치하도록 계산
- Z 값은 XY 정합으로 변경하지 않고 원래 값을 유지한다.

거부 조건:

- 같은 Source 제어점 두 개
- 같은 Target 제어점 두 개
- 비수치/무한대 좌표
- WGS84 경도 `[-180, 180]` 또는 위도 `[-90, 90]` 범위 밖의 Source Geometry/제어점
- 축척이 `0`이거나 비정상적으로 큰 값
- 지원하지 않는 CRS
- DXF 외 입력
- 빈 Geometry 또는 Feature 제한 초과

## 5. 저장·보안 정책

Project에 저장:

- 정합된 WGS84 GeoJSON 결과
- `metadata.coordinateAlignment`의 비민감 요약
  - `sourceFormat: "DXF"`
  - `sourceCrs`
  - `method`
  - `scale`
  - `rotationDegrees`
  - `rmsErrorMeters`

Project에 저장하지 않음:

- 원본 절대 파일 경로
- 원본 DXF Binary/Text
- 제어점 원본 좌표
- Credential 또는 Provider 설정

원본 파일명은 Layer 표시명 생성에만 사용하며 Metadata에는 저장하지 않는다.

Native DXF Reader는 Renderer로 전달하기 전에 다음 경계를 적용한다.

- 원본 DXF Feature Properties 제거
- Geometry Type Allowlist
- Feature `50,000`, GeoJSON `20 MiB`, Coordinate `1,000,000`, Geometry Depth `32` 제한
- 모든 Ordinates 유한값 검증

## 6. Acceptance Criteria

- [x] Windows Desktop에서 `.dxf`만 선택할 수 있다.
- [x] Web/PWA에는 메뉴, Dialog, Sidecar 요청 경로가 노출되지 않는다.
- [x] 4개 CRS Allowlist 외 입력을 거부한다.
- [x] CRS-only 변환 결과가 WGS84 유효 범위에 들어온다.
- [x] 2점 Similarity가 이동·회전·균일축척을 정확히 계산한다.
- [x] Exact 제어점과 알려진 Fixture의 결과 오차가 허용 범위 이내다.
- [x] Z 좌표가 저장 Geometry와 Cesium 3D 표시에서 보존된다. CAD Layer만 Ground Clamp를 해제한다.
- [x] 결과 Layer가 2D/3D에서 같은 지리 위치에 표시된다.
- [x] Project Round-trip 후 정합 결과와 비민감 Summary가 유지된다.
- [x] Project/로그/URL에 원본 절대 경로와 제어점이 저장되지 않는다.
- [x] 취소·오류 시 Layer와 Project Dirty State가 변경되지 않으며, 실행 중 Sidecar Job과
  Child Process도 종료된다.
- [x] 기존 DXF Conversion, GeoJSON Layer, Project Save/Open 기능에 신규 회귀가 없다.

## 7. 제외 범위

- DWG
- IFC/BIM
- 3점 이상 Affine/Polynomial/Rubber-sheet 변환
- 수직 Datum 변환
- 원본 DXF 편집/재저장
- Browser/PWA DXF Import
- 원본 파일 자동 감시·재연결

## 8. 구현 및 Runtime 증거

### 자동 검증

- 좌표 정합 Unit/Project Round-trip/Cancel Wiring: `11 passed`
- Cesium CAD Z 보존 포함 Layer Sync: `18 passed`
- Sidecar Conversion Target: `41 passed`
- Sidecar Conversion+Security Target: `52 passed`
- Packaging Resource Contract: `4 passed`
- Web/PWA Zero-path Playwright: `1 passed`
- Web Production Build와 CAD Bundle 경계 Scan: PASS
- Windows Native Rust: `39 passed`
- Windows Tauri Debug/No-bundle Build: PASS
- Frontend 전체 Test/Coverage: `2,946 passed`, `1 skipped`, `0 failed`
  (`lines 82.14%`, `branches 83.33%`, `functions 69.52%`)
- Backend 전체: `257 passed`, `16 skipped`, Coverage `64.19%`
- 전체 Playwright E2E: `26 passed`
- Brand Gate: PASS
- Lint: Error `0`, 기존 Warning `21`
- Worker TypeScript: PASS

### Windows Native Tauri

- Process/Window: title `geoIM3D`, `lang=ko`, Responsive, `1296x839`
- Native File Picker에서 `site-epsg5186.dxf` 선택
- Source CRS: `EPSG:5186`
- Preview: Feature `2`, Scale `1.000000`, Rotation `0.0000°`, RMS `0.0000 m`
- 결과 Layer: `site-epsg5186 정합`
- MapLibre 2D Pane와 Cesium 3D Globe 모두 활성 DOM/Canvas에서 결과 Layer 확인
- 외부 Tile Resource `135`개 관찰, OpenFreeMap/Cesium Attribution과 지도 Tile 표시 확인
- `.geoim3d.json` 실제 Save/Startup Argument Open 후 Layer 복원 확인
- 저장 Project: `9,118 bytes`, `sourceCrs=EPSG:5186`, `method=crs`
- 원본 DXF 경로·제어점 저장: 없음

Review Finding 수정 후 최종 Source를 새 Windows-local Tree
`C:\geoim3d-p7a-final-20260719T072645Z`에서 다시 Build했다.

- Windows Tauri Debug/No-bundle Exact Build: PASS
- 실제 Tauri Native IPC로 Sidecar 시작/종료: PASS
- 실제 DXF → Sanitized GeoJSON Job: `succeeded`
- Geometry: `Point`, `LineString`; Feature `2`; Z `5` 보존
- 모든 반환 Properties: 빈 객체
- Job Result에 원본 절대 경로: 없음
- 종료 후 App Process, Port `8765`, CDP Port `9333`: 모두 `0`
- Security Remediation 후 Windows Tauri Debug/No-bundle Exact Build: PASS
- Windows Tauri Release Build와 MSI/NSIS Bundle 생성: PASS
- 대형 DXF Job Warm Runtime 상태: `running`
- 실제 `DELETE /conversion/jobs/{id}`: HTTP `200`, 즉시/1초 후 모두 `cancelled`
- Cancel 후 Sidecar Direct Child Process: `0`

최종 재검증 시 Windows Session이 잠금 화면이어서 Native File Picker 재자동화는 수행하지
못했다. Native Picker와 전체 Preview/Layer/Save/Open은 아래 기존 Windows Native Evidence로
검증되어 있으며, Review Finding 수정 후 Exact Build에서는 Picker를 제외한 Native IPC,
Sidecar, 실제 DXF Parser/DTO 경계를 다시 실행했다.

Cold-start 중 Hatchling이 `pyproject.toml`의 `readme = "README.md"`를 요구하지만
Tauri Resource Allowlist에 README가 없던 기존 Packaging 결함을 발견했다. Resource에
해당 파일만 추가하고 RED/GREEN Packaging Contract 및 Windows Tauri 재빌드로 수정했다.

### 독립 Review Finding 수정

- Security: CAD Endpoint/Adapter를 공용 Processing/Web Graph에서 제거하고 Tauri-only
  Dialog Chunk로 분리했다. Web Production Artifact에서 Route, Adapter, Dialog 문자열과
  전용 Chunk가 모두 없음을 재검증했다.
- Security: Native DXF DTO에서 원본 Properties를 제거하고 좌표 수·Geometry 깊이·Type·
  유한값을 제한했다.
- Security: Renderer 경계에서도 Feature를 `type`·`geometry`·빈 `properties`만으로
  재구성해 변조되거나 향후 확장된 Sidecar DTO의 추가 필드가 Project/Map에 유입되지 않는다.
- Security: `DELETE /conversion/jobs/{job_id}`와 Active Process Registry를 추가했다.
  Dialog Close·Unmount·Timeout·Job 생성 응답 Race에서 Job을 idempotent 취소하고 실제 Child
  Process를 Kill한 뒤 Partial Output을 삭제한다.
- Security/Windows: Active Worker Finalizer가 완료되기 전 `cancelled` Job을 Retention
  Eviction에서 보호하고, Process/Partial-output 정리 후 보호를 해제해 Eviction과 Cleanup의
  `KeyError` Race를 차단한다.
- Security/Windows: POST 응답 생성 중인 Job도 Retention Eviction에서 보호하고 응답
  Snapshot 확보 후 보호를 해제한다. Stale Process Handle의 `poll`/`kill`/`wait` 예외와
  Partial-output 삭제를 독립적인 best-effort Cleanup 단계로 분리한다.
- Geospatial: EPSG:4326 Source Geometry와 WGS84 Source/Target 제어점 범위를 proj4 호출
  전에 fail-closed 검증한다.
- Geospatial/3D: CAD 정합 Metadata가 적용되면 Cesium DataSource를 재구성하고
  `clampToGround=false`로 Z를 보존한다. 일반 GeoJSON은 기존 Ground Clamp를 유지한다.

### Screenshot

| 증거 | 유형 | SHA-256 |
|---|---|---|
| `evidence/phase7a-windows-webview-preview-2026-07-19.png` | Windows Tauri WebView Preview | `8a1277eaceb05241eda656d244c6c545195e4da5bbfcbe1b2679826c5a8b25a1` |
| `evidence/phase7a-windows-native-layer-2026-07-19.png` | Windows Native Window `PrintWindow` | `ab06e61cf2c317a7570e683f0d1060b86a23ba1f097436b6e65441954c6abe0e` |
| `evidence/phase7a-windows-webview-reopen-2026-07-19.png` | Windows Tauri WebView Project 재오픈 | `8a924c84312bb9883115dbdf1fea5112ec9bc7a2a43fdc6900b151fc966abacb` |

모든 Screenshot은 `0644`이며 Browser Production Capture가 아니라 실제 Windows
Tauri Process의 WebView 또는 Native Window Capture다.
