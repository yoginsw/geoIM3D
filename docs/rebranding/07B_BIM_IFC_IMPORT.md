# Phase 7B — BIM/IFC Import MVP

- 제품: **지오아임3D(geoIM3D) 1.0.0**
- 단계: **Linux/Web/Windows Native Gate 완료, 독립 Review 대기**
- 대상 Branch: `feat/geoim3d-bim-ifc-import`
- 기준 Commit: `03352fec2a568d9be8ac6b3b73e8c59ce176e93a`

## 1. 목표

Windows Desktop에서 로컬 `.ifc` 파일의 형상만 self-contained GLB로 변환하고,
사용자가 지정한 WGS84 Anchor에 기존 deck.gl Scenegraph Layer로 배치한다.

MVP는 BIM 편집기나 속성 Browser가 아니다. 원본 IFC의 이름, GUID, Property Set,
문서 작성자, 조직, 주소 등 업무·개인 Metadata는 Project로 전파하지 않는다.

## 2. 확정 범위

### 포함

- Windows Tauri Desktop 전용 메뉴와 Dialog
- `.ifc` 단일 파일 선택
- WGS84 경도·위도, 고도, 방위각, 균일축척 입력
- IFC2X3/IFC4 계열 중 `web-ifc`가 실제 Parse하는 Schema
- 형상 Stream → self-contained GLB 변환
- 기존 `deckgl-viz` Scenegraph Layer 재사용
- 다음 비민감 Summary만 Layer Metadata에 저장
  - Source Format (`IFC`)
  - IFC Schema
  - Element 수
  - Placed Mesh 수
  - Triangle 수
  - GLB Byte 수
  - Model Radius(m)
  - Parser (`web-ifc`)
- GLB `data:` URL을 `.geoim3d.json` 안에 저장하여 같은 파일로 Save/Open
- 변환 취소 시 Web Worker 실제 종료

### 제외

- Web/PWA/Embed IFC 메뉴, Worker, WASM, 전용 Chunk
- IfcOpenShell/IfcConvert 포함 또는 Runtime Download
- IFC 원문 저장
- 원본 절대 경로 저장
- IFC GUID, Entity Name, Property Set, 재료명, 조직·작성자·주소 저장
- BIM 속성 조회/검색/편집
- IFC 쓰기/Export
- DWG/Revit/RVT
- Cloud Upload, Relay, Collaboration, Share/Viewer 전달
- 자동 Georeferencing 또는 IFC MapConversion 해석
- 여러 IFC의 Federation

## 3. License 결정

### 채택

- `web-ifc` `0.0.77`
- License: **MPL-2.0**
- Windows Tauri 전용 Worker에서 원본 Package를 수정하지 않고 사용
- 배포물에는 Package License와 Source Repository URL을 Third-party Notice로 제공

### 기각

- IfcOpenShell Python Wheel은 기능 Spike에서 GLTF Serializer를 확인했으나 공식
  `COPYING`이 GPL-3.0이므로 이번 비공개 제품 Sidecar Runtime에는 포함하지 않는다.
- 별도 법무 승인 없는 GPL Runtime Bundle/Download/Import는 금지한다.

## 4. 데이터 및 보안 경계

| 항목 | 정책 |
|---|---|
| IFC Input | Renderer Memory → 전용 Worker Transfer, 최대 32 MiB |
| Parser 사전 경계 | 전체 UTF-8, Entity/line/token/number/nesting 제한 후 WASM Init/Open |
| GLB Output | 최대 16 MiB, Chunk/JSON/BIN/Accessor/외부 URI Deep Validation |
| Project IFC GLB | 합계 최대 64 MiB, 재오픈 시 동일 Deep Validation과 DTO 재구축 |
| Worker Memory | 단일 활성 변환, 120초 Timeout, 종료 시 Worker terminate |
| Project | GLB Data URL + Allowlist Summary + Anchor만 저장 |
| 저장 금지 | IFC bytes/path/GUID/Property/Raw Error/Author/Organization/Address |
| Network | 변환 중 외부 요청 0, WASM은 App Bundle에서만 Load |
| Error | 고정된 사용자 메시지, Raw Parser Error/경로 비노출 |

Schema와 Element/Mesh/Triangle 수는 원문 속성보다 제한된 집계값이지만 운영상 민감할 수
있다. Dialog는 IFC 형상·Anchor·집계 Summary가 Project에 포함되며 Project 파일을 공유하면
함께 전달된다는 점을 Import 전에 명시한다. 승인되지 않은 Share/Collaboration 경로에는 IFC
Project를 전파하지 않는다.

GLB는 기존 KML Model과 동일하게 `data:model/gltf-binary;base64,...`로 저장한다.
`sourcePath`는 설정하지 않는다. Project Version `0.2.0`과 내부
`@geolibre/*` Identifier는 변경하지 않는다. 원본 IFC filename도 Layer 이름에
사용하지 않고 generic 이름 `IFC Model`만 사용한다.

URL deep-link, Embed 및 Collaboration Project ingress는 persisted scenegraph를
전부 거부한다. Web/PWA의 Local Project ingress도 persisted scenegraph를
거부한다. Windows Local `.geoim3d.json` ingress만 IFC 계약 marker, GLB,
summary, strictly-positive bounded radius, aggregate budget을 재검증해 허용한다.
Embed state emission, Collaboration session/snapshot, Share Gallery upload 및 Standalone
HTML export outbound도 동일한 Web-safe private-scenegraph guard에서 전송/생성 전에
차단한다. Guard는 metadata, scenegraph config, source row뿐 아니라 metadata-only
`*Import` discriminator도 검사해 discriminator 일부 삭제 우회를 거부한다.

## 5. 좌표·표시 계약

- `COORDINATE_TO_ORIGIN=true`로 IFC 로컬 형상을 원점 기준으로 변환한다.
- 사용자가 입력한 Anchor만 WGS84 위치로 사용한다.
- 경도 `[-180, 180]`, 위도 `[-90, 90]`, 고도 `[-10000, 100000]`,
  방위각 `[-360, 360]`이어야 한다.
- 축척은 `(0, 10000]` 범위의 균일축척만 허용한다.
- Element 50,000, Placed Mesh 100,000, Vertex 1,000,000,
  Index 6,000,000, Triangle 2,000,000 및 Pre-export Geometry 14 MiB 상한을 적용한다.
- `web-ifc`의 `flatTransformation`을 각 Placed Geometry에 적용한다.
- Vertex Position/Normal과 Triangle Index만 GLB로 전달한다.
- BIN의 실제 Triangle Index 값을 디코딩해 각 값이 POSITION accessor count보다
  작은지 확인한다.
- IFC Entity/GUID/Property는 GLB Node Name/Extras에도 기록하지 않는다.
- 2D에서는 기존 deck.gl Scenegraph Overlay, 3D Project Pane에서는 기존 Model
  경로와 호환되는 동일 Project Layer를 사용한다.

## 6. 구현 구조

```text
ProcessingMenu / TopToolbar / DesktopShell
  └─ lazy IFC Import Dialog (__TAURI_BUILD__ only)
       ├─ Tauri local file picker
       ├─ readFile (Renderer memory only)
       └─ dedicated module Worker
            ├─ bundled web-ifc.wasm
            ├─ geometry-only streaming
            └─ Three GLTFExporter → GLB
                 └─ existing deckgl-viz Scenegraph Layer
```

순수 Validation/Summary/Layer DTO는 React와 Worker에서 분리한다.
Worker Protocol은 Request ID별 `convert`, `cancel`이 아니라 MVP 단일 변환을 사용하며,
Dialog Close/Cancel/Unmount는 Worker를 즉시 `terminate()`한다.

## 7. Acceptance

- [x] 확장자, STEP Header/Footer/Schema, 0-byte, 32 MiB 초과 입력 Fail-closed
- [x] WGS84/고도/방위각/축척 Validation
- [x] 413,681-byte IFC Fixture → 1,024,392-byte GLB v2 실제 Worker 변환
- [x] Transformation/Color/Normal/Index와 14,694 Triangle 출력
- [x] Empty Geometry, Element/Mesh/Vertex/Index/Triangle/GLB 한도와 malformed IFC 거부
- [x] Dialog Close/Cancel/Timeout/Unmount가 Worker 실제 종료
- [x] Layer/GLB에 원본 경로·IFC 원문·GUID·속성 없음
- [x] GLB JSON depth/node/array와 extension/URI 및 실제 index 범위 Fail-closed
- [x] Local/URL/Embed/Collaboration 중앙 Desktop Project ingress 적용
- [x] `.geoim3d.json` Save/Open 시 GLB Deep Validation과 Summary DTO 재구축
- [x] 일반 Web Production Bundle에 IFC 문자열·Worker·WASM·Chunk 0
- [x] Tauri Production Frontend Bundle에 `web-ifc.wasm` 포함
- [x] MPL-2.0 License와 Source URL 제공
- [x] Frontend Target/Full Coverage, Lint, Worker, Build Gate
- [x] Windows Native 실제 IFC Import, 2D/3D 표시, Save/Open Runtime
- [ ] Gitleaks 및 독립 Security/Windows/3D/Documentation Review 승인

### Windows Native Evidence — 2026-07-20

- Exact Windows tree: `C:\geoim3d-p7b-final-20260719T170753Z`
- Rust: `39 passed`
- Tauri debug/no-bundle와 release MSI/NSIS build: PASS
- Tauri native dialog plugin의 실제 IFC 경로 반환: PASS
- IFC2X3 `413,681` bytes → elements `115`, placed meshes `119`,
  triangles `14,694`, GLB `1,024,392` bytes
- App Layer 추가 후 MapLibre 2D, Cesium 3D 및 Canvas 표시: PASS
- `.geoim3d.json` 저장: `1,375,063` bytes, Project version `0.2.0`
- self-contained GLB data URL, bounded radius `23.67493738136494` m, allowlist
  summary 및 `IFC Model` generic name: PASS
- 절대 IFC path, source filename, `.ifc`, GUID, `sourcePath`, author 및
  organization 문자열 부재: PASS
- Startup argument 재오픈 후 Layer 복원 및 Project ingress validation: PASS
- Runtime 종료 후 App/CDP/sidecar listener: 0
- Debug/Release Resource에 Third-party Notice와 MPL-2.0 License 포함: PASS
- installed `web-ifc 0.0.77` License와 bundled License SHA-256 일치: PASS

### Independent Review Remediation

- URL, Embed, Collaboration 및 Local File Actions를 compile-time Desktop 중앙
  ingress gate로 통합
- Remote 및 Web/PWA persisted scenegraph Project reject; Windows Local IFC
  marker/DTO/aggregate 검증
- Embed outbound state와 Collaboration session/snapshot private model 전파 차단
- WASM Init/Open 전 전체 UTF-8 STEP lexical/entity complexity scan
- Parser memory limit `256 MiB`
- per-mesh size를 Array copy 전에 검사
- GLB JSON iterative depth/node/array bound와 extension/URI 전면 거부
- BIN의 실제 unsigned index를 POSITION count와 대조
- 공통 Radius Validator로 summary/conversion/build/reopen 모두에서
  `0 < radius <= 100,000m`를 동일하게 강제하고
  allowlist summary로 저장해 reopen bounds 재구축
- Layer 이름을 사용자 입력 없이 `IFC Model`로 고정
- Hardened official IFC Worker runtime: PASS
- IFC/CAD/Cesium/Packaging target: `45 passed`
- Frontend: `2,958 passed`, `1 skipped`, `0 failed`
- Frontend coverage: lines `82.20%`, branches `83.14%`, functions `69.64%`
- E2E: `27 passed`

Evidence:

- `evidence/phase7b-windows-ifc-preview-2026-07-20.png`
- `evidence/phase7b-windows-ifc-layer-2026-07-20.png`
- `evidence/phase7b-windows-ifc-reopen-2026-07-20.png`

## 8. Release 경계

Phase 7B Artifact는 기능 Branch 검증용이며 Phase 8 Release Gate 전 Public Release하지
않는다. Installer/MSIX/Portable의 File Association 정책은 변경하지 않는다.
