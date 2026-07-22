# Phase 7E — 3D Scene Project Preset MVP

- 제품: **지오아임3D(geoIM3D) 1.0.0**
- 상태: **Acceptance·Architecture Review Finding 수정 / 재Review 대기**
- 대상 Branch: `feat/geoim3d-3d-scene-preset`
- 기준 Commit: `8e84bfb584e38ad139103a567d300b4c76e8ca05` (Phase 7D2 Viewshed)

## 1. 확정 Intent

- Preset 선택은 현재 Project 병합이 아니라 표준 설정의 **새 Project 생성**이다.
- 1.0 기본 Preset은 **빈 3D Scene 기본형** 하나다.
- 사용자는 현재 Project를 Layer 데이터 포함 Custom Preset으로 저장할 수 있다.
- Preset 파일의 canonical 확장자는 **`.geoim3d-preset.json`**이다.
- 대형 모델은 embedded data URL로 저장하지 않고 HTTPS URL 또는 Preset 기준 상대경로만 저장한다.
- Credential, session 값, 절대 로컬경로는 저장하지 않는다.
- Cloud/팀 동기화, Marketplace, OS file association은 범위 밖이다.

`.geoim3d.json`은 계속 유일한 canonical Project 포맷이다. `.geoim3d-preset.json`은 Project가 아니라 새 Project를 생성하는 별도 canonical template 포맷이다.

## 2. 목표

사용자가 Project 메뉴에서 JBT 기본 또는 사용자 Custom Preset을 선택해 한국어 Light UI, 1×1 workspace, Cesium 3D tab과 안전한 기본 scene state를 가진 새 `.geoim3d.json` Project를 생성한다.

Custom Preset은 현재 Project의 허용된 scene/layer 상태를 재사용 가능하게 저장한다. 저장·가져오기에서 credential, private/session data, 절대경로, raw local source와 대형 embedded model을 fail-closed한다.

## 3. 포함 범위

### Built-in Preset

- ID: `geoim3d.blank-3d.v1`
- 표시명: `빈 3D Scene 기본형`
- 한국어/Light product profile 유지
- Map grid 1×1
- active workspace: Cesium
- 빈 Layer/Layer Group
- product default map view, basemap visibility/opacity, scene defaults
- 새 Project name은 i18n 기본값으로 생성
- Project path와 recent-project identity는 null

### Custom Preset

- `현재 Project를 Preset으로 저장...`
- `Preset 파일 가져오기...`
- 사용자가 저장한 Preset 파일을 선택해 새 Project 생성
- 현재 Project의 다음 허용 상태 포함
  - map view/camera
  - basemap style, visibility, opacity
  - Layer order/group/visibility/opacity/style
  - bounded embedded GeoJSON과 basic vector style
  - credential-free external model references
- 원본 Project path, dirty/history/selection/panel/transient worker/session state는 제외

### File Lifecycle

- Export: `.geoim3d-preset.json`
- Import: strict bounded binary read → fatal UTF-8 → strict schema parse → security validation → 새 Project DTO 재구축
- Apply: 현재 Project를 mutate/merge하지 않고 새 Project로 atomic replace
- Cancel/error: 기존 Project와 Store mutation 0
- OS file association, startup argument open, drag/drop generic Project open에는 연결하지 않는다.
- 1.0 MVP는 사용자 Preset 영구 Library/index를 만들지 않는다. Custom Preset은 사용자가 선택한 파일 위치에 저장하고 명시적으로 다시 Import한다.

## 4. 제외 범위

- 현재 Project에 Layer merge
- Preset에서 기존 Project path/recent entry 상속
- Cloud sync, team sharing service, collaboration relay
- Marketplace/plugin ZIP에 Preset 포함
- OS file association/deep link
- Preset 자동 실행 script, SQL, Notebook, AI prompt
- 사용자 Preset Library, recent-preset 목록, browser/native preset index DB
- Credential, token, password, connection string, cookie, request header
- Windows Credential Manager key 또는 VWorld session vault 참조
- 절대 Windows/POSIX path, UNC path, `file:` URL
- `..` traversal, symlink/reparse 탈출 relative reference
- embedded IFC/GLB/3D Tiles/I3S/Gaussian Splat/LiDAR 대형 payload
- private Earthwork/Terrain Safety/Viewshed result layer
- temporal history, recovery, browser storage snapshot

## 5. Canonical Preset Schema

```ts
interface GeoIm3dScenePresetV1 {
  schema: "geoim3d-scene-preset-v1";
  version: 1;
  kind: "3d-scene-project-template";
  name: string;
  description?: string;
  createdBy: "JBT" | "user";
  scene: {
    workspace: "cesium";
    mapGrid: { rows: 1; cols: 1 };
    project: StrictPortableProjectTemplateV1;
  };
}
```

Strict rules:

- top-level/scene/project/layer object는 exact-key allowlist
- prototype-bearing object, accessor, sparse array, non-finite number 거부
- string/array/object depth와 node/count bounds
- canonical UTF-8 JSON byte identity
- unknown version/kind/schema 거부
- import 후 일반 `GeoLibreProject` DTO를 새로 구성하고 Preset object reference를 Store에 보존하지 않음
- Preset 자체는 `projectPath`, recent-project identity, history 또는 session id를 갖지 않음

### Hard Bounds Summary

- Input/output: 정확히 8 MiB 허용, +1 byte 거부
- JSON depth 32
- object/array node 400,000
- layers 1,000
- layer groups 1,000
- total features 25,000
- total coordinates 250,000
- strings total UTF-8 2 MiB
- external references 1,000
- Worker/Main import ledger 128 MiB / 96 MiB

Reject는 parse/apply/store mutation 전에 일어난다.

## 6. Layer Data 계약

### Embedded 허용

- bounded GeoJSON FeatureCollection
- Section 11.1의 basic vector style exact allowlist
- source data가 이미 portable이며 private-analysis detector를 통과한 Layer

### External Model Reference 허용

1. HTTPS URL
   - scheme 정확히 `https:`
   - username/password/query/fragment 없음
   - normalized URL round-trip 동일
   - credential/header/cookie field 없음
2. Preset 기준 상대경로
   - `/` separator canonical form
   - 빈 segment, `.`, `..`, drive prefix, leading slash, backslash, NUL 거부
   - open 시 Preset parent 아래 canonical path만 허용
   - Windows에서는 same-handle open + reparse/identity/size 검증
   - Renderer에는 resolved absolute path를 반환하지 않고 opaque session id 기반 private resource protocol만 전달
   - private protocol은 session root 아래의 allowlisted model resource만 bounded streaming하며 credential/header 주입 기능이 없음
   - 누락 파일은 명시적 Relink UI 전까지 unresolved placeholder이며 자동 network fallback 금지

### Embedded 금지

- `data:model/*`, embedded GLB, IFC bytes
- raster/point-cloud/model binary blob
- private analysis geometry/summary
- raw source metadata 또는 filename/path

Custom Preset 저장 시 금지 Layer가 하나라도 있으면 silent omission하지 않고 전체 저장을 거부하며 offending Layer의 generic name과 해결 방법만 표시한다.

## 7. Security/Privacy 경계

- Preset export 직전 `assertNoPrivateAnalysisContent` 및 private scenegraph/credential detectors 실행
- marker-stripped/repacked/nested/stringified private payload 탐지
- Project environment values, managed credentials, plugin secret fields 삭제가 아니라 **존재 시 fail-closed**
- external URL은 credential-free exact allowlist
- local relative reference는 renderer에 resolved absolute path를 반환하지 않음
- import picker/native command가 base path와 file open을 소유
- raw parser/native errors, filename, path는 public error에 포함하지 않음
- browser localStorage/IndexedDB/CacheStorage/Service Worker cache에 Preset bytes 저장 금지
- recent Project 목록에 Preset path 저장 금지
- Web/Windows 간 동일 schema validation; native relative-reference open은 Windows Tauri 전용
- generic Project Open은 `.geoim3d-preset.json`을 거부하고 Preset Import command만 허용

Public error allowlist:

```text
SCENE_PRESET_CANCELLED
SCENE_PRESET_INVALID
SCENE_PRESET_TOO_LARGE
SCENE_PRESET_PRIVATE_CONTENT_BLOCKED
SCENE_PRESET_CREDENTIAL_BLOCKED
SCENE_PRESET_REFERENCE_INVALID
SCENE_PRESET_REFERENCE_MISSING
SCENE_PRESET_REMOTE_DENIED
SCENE_PRESET_REMOTE_UNAVAILABLE
SCENE_PRESET_SESSION_STALE
SCENE_PRESET_PROJECT_ROOT_MISMATCH
SCENE_PRESET_WRITE_FAILED
SCENE_PRESET_LIMIT_EXCEEDED
SCENE_PRESET_INTERNAL
```

## 8. Atomic Store/Application 계약

1. picker/read/parse/validate와 reference plan 준비가 끝날 때까지 현재 Store 변경 0
2. 새 Project DTO와 prepared resource/placeholder plan을 완성한 뒤 Section 11.2 generation coordinator가 하나의 Store `set`으로 교체
3. 기존 `loadProject` options에 explicit `markDirty`를 추가해 project path null, dirty true를 동일 Store mutation에서 적용
4. recent Project 항목 추가 0
5. Store publish 직후 새 `projectGeneration`을 기준으로 Renderer/Plugin이 reconcile하며, 이전 generation의 request/worker/session은 stale 처리 후 idempotent teardown
6. parse/validate/reference prepare 실패 시 기존 Project의 layers/map view/selection/history/path/dirty identity byte-equivalent 유지
7. publish 이후 개별 Renderer 초기화 실패는 Project 전체 rollback으로 위장하지 않고 해당 Layer를 value-safe 오류/placeholder 상태로 표시하며 다른 Layer와 App은 계속 동작
8. apply 중 중복 요청은 single-flight; cancel/unmount 후 stale completion 무시

## 9. UI

Project 메뉴:

- `새 Project` 하위
  - `빈 3D Scene 기본형`
  - `Preset 파일 가져오기...`
- `현재 Project를 Preset으로 저장...`

Save dialog는 포함/차단 항목과 외부 참조 정책을 사전 요약한다. 새 Project 생성 전 현재 unsaved Project가 있으면 기존 discard confirmation을 재사용한다.

## 10. 구현 접점

```text
ProjectMenu / TopToolbar
  ├─ existing NewProjectDialog unsaved-change confirmation 재사용
  └─ useScenePresetActions (new)
       ├─ scene-preset-contract.ts
       │    ├─ strict bounded parse/serialize
       │    ├─ Project → Preset allowlist conversion
       │    └─ Preset → fresh GeoLibreProject DTO
       ├─ tauri-io preset picker/save commands
       └─ optional Windows private relative-resource protocol
```

- Built-in blank Preset은 정적 JSON blob을 중복 보관하지 않고 `createGeoIm3dNewProject`/`createEmptyProject`의 product defaults로 결정론적으로 생성한다.
- Custom Preset export 입력은 `projectFromStore()`를 사용하되 일반 Project serializer를 그대로 재사용하지 않고 별도 allowlist builder를 통과한다.
- Preset import는 `useProjectFileActions`의 generic `.geoim3d.json` open/recent/startup/drop/url route에 연결하지 않는다.
- Store `loadProject`에 `markDirty?: boolean` option을 추가하고 기본값은 기존 `false`를 유지한다. Preset route만 `{ rememberRecent: false, presenting: false, markDirty: true }`를 사용한다.
- active 3D workspace tab은 현재 `MapGrid` local state에서 transient Store UI field로 이동한다. Preset apply의 동일 Store mutation에서 `Cesium`을 선택하며 canonical Project/Preset project DTO에는 이 UI state를 추가하지 않는다.

## 11. Normative Architecture Contract

이 절은 앞 절의 일반 표현을 구체화하는 구현 규범이며 충돌 시 이 절이 우선한다.

### 11.1 Preset 전용 Project DTO

`StrictPortableProjectTemplateV1`은 일반 `GeoLibreProject`의 부분 복사가 아니다. 다음
exact-key DTO를 새로 구축한다.

```ts
interface StrictPortableProjectTemplateV1 {
  projectName: string;
  mapView: {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  };
  basemap: {
    builtInId: BuiltInBasemapIdV1;
    visible: boolean;
    opacity: number;
  };
  mapPreferences: {
    restrictBounds: boolean;
    bounds: [number, number, number, number];
    minZoom: number;
    maxZoom: number;
    maxPitch: number;
    renderWorldCopies: boolean;
    projection: "globe" | "mercator";
    ellipsoidId: string;
    scaleUnit: "metric" | "imperial" | "nautical";
  };
  groups: PresetLayerGroupV1[];
  layers: PresetLayerV1[];
}

interface PresetLayerGroupV1 {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
}

type PresetLayerV1 = PresetGeoJsonLayerV1 | PresetExternalSceneLayerV1;

interface PresetGeoJsonLayerV1 {
  kind: "geojson";
  id: string;
  name: string;
  groupId?: string;
  visible: boolean;
  opacity: number;
  style: BasicVectorStyleV1;
  data: GeoJSON.FeatureCollection;
}

interface PresetExternalSceneLayerV1 {
  kind: "external-scene";
  id: string;
  name: string;
  groupId?: string;
  visible: boolean;
  opacity: number;
  format: "glb" | "3d-tiles" | "i3s";
  reference: ExternalSceneReferenceV1;
  placement?: {
    longitude: number;
    latitude: number;
    altitudeMeters: number;
    bearingDegrees: number;
    scale: number;
  };
}

type ExternalSceneReferenceV1 =
  | { type: "https"; url: string }
  | { type: "relative"; path: string };

type BuiltInBasemapIdV1 = "geoim3d-blank-v1" | "geoim3d-openfreemap-liberty-v1";
```

Project ID와 Group ID는 export 때 `layer-1`, `group-1`처럼 순서 기반으로 다시 만들며 원본
UUID를 저장하지 않는다. Import는 새 UUID를 생성하고 모든 group reference를 한 번에 remap한다.
이름은 사용자 데이터로 포함하되 UTF-8 128 bytes로 제한한다. Error에는 이름 대신 1-based
ordinal만 사용한다.

`BasicVectorStyleV1`은 다음 exact-key subset만 허용한다.

- zoom: `minZoom`, `maxZoom`
- fill/line/point: `fillColor`, `fillOpacity`, `strokeColor`, `strokeWidth`,
  `strokeWidthUnit`, `circleRadius`
- basic label: `enabled`, `field`, `placement`, `size`, `color`, `haloColor`,
  `haloWidth`, `minZoom`, `maxZoom`, `allowOverlap`
- basic extrusion: `enabled`, `color`, `opacity`, `heightProperty`, `heightScale`, `base`
- coordinate-Z 3D: `enabled`, `verticalScale`, `offsetMeters`

SVG/data URL, expression, rule, arbitrary MapLibre expression, marker SVG, fill-pattern SVG,
custom metadata 및 style foreign key는 거부한다. Number/color/enum/string은 별도 finite/range/length
validator를 통과한다.

GeoJSON은 `FeatureCollection`/`Feature`/표준 geometry와 JSON-scalar property만 허용한다.
`bbox`, foreign member, CRS member, accessor/prototype, sparse array, non-finite number를 거부한다.
Property key를 case-fold/구두점 제거한 값이 credential denylist와 일치하면 전체 export/import를
거부한다.

Preset에서 제외되는 일반 Project 필드는 다음과 같다.

- `metadata`, `plugins`, `legend`, `storymap`, `models`, `widgets`, `dashboardColumns`
- `secondaryMapViews`, pane label, arbitrary `source`, `sourcePath`, layer `metadata`
- `preferences.environmentVariables`, geocoding provider/keys/endpoints/email
- selection, filter, history, dirty, path, recent, UI panel, worker/session state

제외 필드가 source Project에 **존재한다는 사실만으로** 항상 거부하지는 않는다. 일반 Project의
기본 구조에는 해당 필드가 항상 존재할 수 있으므로 Preset builder는 위 exact allowlist만 읽는다.
다만 environment value/API key, managed credential alias, private-analysis discriminator/summary,
private IFC scenegraph, credential-bearing URL 및 external local path를 어느 깊이에서든 발견하면
silent stripping 없이 전체 export를 거부한다. Unknown key를 가진 Preset input은 항상 거부한다.

### 11.2 Basemap 및 camera/workspace

Preset에는 resolved style URL을 저장하지 않는다. `basemap.builtInId`는 compile-time registry에서
API key 없이 동일 style을 복원할 수 있는 built-in ID만 허용한다. Protomaps key 포함 URL,
custom URL, PMTiles/local path, VWorld session layer 또는 registry에서 credential-dependent로
분류한 basemap은 전체 export를 거부한다.

V1 registry는 위 union의 두 ID만 가지며 다음 immutable record를 source에 둔다.

| ID                               | style identity                                        | credential | Web/Windows |
| -------------------------------- | ----------------------------------------------------- | ---------- | ----------- |
| `geoim3d-blank-v1`               | empty style, basemap hidden                           | none       | both        |
| `geoim3d-openfreemap-liberty-v1` | bundled Liberty style snapshot + compile-time SHA-256 | none       | both        |

`geoim3d.blank-3d.v1`은 `geoim3d-blank-v1`, hidden, opacity 1을 사용한다. Registry version은
`geoim3d-basemap-registry-v1`이며 bundled style hash는 build 시 계산한 non-placeholder constant와
asset hash가 일치해야 한다. Unknown ID, missing entry, version/hash mismatch, runtime-resolved URL 또는
credential-required entry는 parser/Store mutation 전에 거부한다. Import/export repeatability test는
두 exact ID와 unknown/+case variant를 검증한다.

MVP camera는 canonical `MapViewState`의 WGS84 center/zoom/bearing/pitch만 의미한다. Cesium 전용
height/heading/roll DTO는 1.0에서 저장하지 않는다. 현재 MapLibre↔Cesium camera adapter가 이
공유 값을 결정론적으로 적용하며, 동일 입력은 동일 Cesium initial view를 생성해야 한다.

`MapGrid`의 local active tab은 transient Store field `ui.mapWorkspaceTab`으로 이동한다. 기본값은
`PRODUCT_PROFILE.defaultMapTab`이고 `loadProject`의 새 optional options는 다음과 같다.

```ts
{
  rememberRecent?: boolean; // 기존 default 유지
  presenting?: boolean;     // 기존 default 유지
  markDirty?: boolean;      // default false
  workspaceTab?: "maplibre" | "cesium"; // default: 현재 product default
}
```

Preset apply는 Store 밖의 generation coordinator가 소유하는 다음 transaction을 사용한다.

```text
prepare → validate references/placeholders → single Store publish → reconcile new generation → retire stale generation
```

1. 기존 Store/consumer/session generation은 prepare 동안 active 상태로 유지한다.
2. 새 DTO와 native resource/placeholder plan을 별도 pending generation에서 prepare한다. 각 reference 결과는 `ready`, `unresolved-allowed`, `hard-fail` 중 하나다. `ready`는 bounded preflight를 끝내고, `unresolved-allowed`는 session handle 없이 placeholder plan을 만든다. `hard-fail`은 pending 전체를 폐기한다.
3. Prepare 단계는 parser, schema/security validation, reference normalization, quota reservation과 native session 준비까지만 수행한다. MapLibre/Cesium/Plugin을 별도 offscreen tree에서 사전 mount하거나 기존 Zustand subscriber를 가로채지 않는다.
4. 모든 동기 validation과 reference plan 준비가 완료되면 coordinator는 하나의 `loadProject`/Store `set`으로 path null, recent unchanged, dirty true, history reset, workspace Cesium, `projectGeneration + 1`과 새 Project DTO를 함께 publish한다. Publish 전 Store mutation은 0이며 중간 pending field를 Store에 노출하지 않는다.
5. 기존 MapLibre/Cesium/Plugin React lifecycle은 새 generation을 구독해 정상 reconcile한다. Worker/request/session completion은 generation/request ID를 확인하고 stale completion을 폐기한다. 이전 generation의 request/worker/native session은 새 generation publish 후 idempotent teardown한다.
6. Publish 이후 Renderer 또는 external resource materialization이 실패하면 전체 Project를 이전 상태로 보상 rollback하지 않는다. 실패한 Layer만 stable value-safe error 또는 unresolved placeholder 상태로 전환하고 다른 Layer와 App은 계속 동작한다. Credential/path/URL/parser 원문은 Store/UI/log에 노출하지 않는다.

Parse, validation, reference prepare, timeout, cancel 또는 stale completion이 publish 전에 실패하면 pending resource/session/placeholder만 dispose하고 Store publish를 호출하지 않는다. 따라서 기존 Store와 active consumers는 변경되지 않는다. `disposePendingGeneration()`은 idempotent하며 각 worker/request/handle/session을 독립 `try/finally`로 정리하고 native registry entry를 마지막 `finally`에서 제거한다. Cleanup 실패는 stable counter만 기록하며 기존 Store와 active generation을 변경하지 않는다.

Acceptance test는 validation/reference hard-fail 전 Store mutation 0, 단일 publish, generation 증가, stale completion 폐기, old-session teardown, cleanup throw/중복 dispose, publish 후 단일 Layer renderer 실패 격리를 검증한다. 제품 전체 Store subscriber notification을 정지시키는 enhancer와 모든 Renderer/Plugin의 detached pre-activation은 1.0 MVP 범위에 포함하지 않는다.

이미 어느 tab이 mounted돼 있어도 새 generation의 Store 값이 우선한다. Publish 전 cancel/error/stale request는
workspace, Store, existing worker/plugin/native session을 포함한 active generation 전체를 변경하지 않는다.
Old teardown은 새 generation의 단일 Store publish 전에 절대 실행하지 않는다.

### 11.3 Parser 및 memory ledger

Input과 output cap은 각각 canonical UTF-8 bytes `<= 8 MiB`이며 `8 MiB + 1`을 거부한다.
Native read는 같은 file handle에서 `max + 1`만 읽고 size/identity/reparse 검증 후 bytes를
transfer한다.

Import는 일반 `JSON.parse`를 직접 호출하지 않는다. Main은 raw `ArrayBuffer` ownership을 Dedicated
Worker로 transfer한다. Worker의 byte-level single-pass preflight tokenizer는 DTO object graph를 만들지
않고 fatal UTF-8, duplicate key, exact schema/token, string bytes, number length, depth, node, array 및
semantic count를 검사한다. Limit은 해당 tokenizer bookkeeping allocation 전에 ledger에서 예약하며
실패 시 allocation 전에 종료한다.

Hard bounds:

| 항목                        |               상한 |
| --------------------------- | -----------------: |
| raw input/output            |              8 MiB |
| Worker logical ledger       |            128 MiB |
| Main logical apply ledger   |             96 MiB |
| JSON depth                  |                 32 |
| object/array nodes          |            400,000 |
| layers/groups               |      1,000 / 1,000 |
| features                    |             25,000 |
| coordinates                 |            250,000 |
| total string UTF-8          |              2 MiB |
| single string/property name | 64 KiB / 256 bytes |
| external references         |              1,000 |

Node는 Preset root부터 GeoJSON position/GeometryCollection container까지 raw JSON의 모든 `{`와 `[`
token을 각각 1개로 센다. `400,000`은 exact `25,000` Point Feature fixture와 exact `250,000`
MultiPoint position fixture를 각각 허용한다. 각 hard bound는 독립 ceiling이며 모든 semantic maximum의
동시 수용을 보장하지 않는다. 어느 ceiling이든 먼저 도달하면 allocation 전에 fail-closed한다.

Worker 128 MiB logical reservation은 transferred raw 8, tokenizer state/duplicate bookkeeping 32,
decoded key/string accounting 24, semantic index/reference state 16, scratch 16, margin 32 MiB다. Request
시작 시 fixed-slot ledger가 이 여섯 reservation을 먼저 원자적으로 획득한 뒤에만 bookkeeping memory를
할당한다. Token stack은 depth 33 fixed TypedArray, duplicate tracking은 object-scope ID와 decoded-key
span/hash를 담는 fixed open-addressed TypedArray table, decoded key/string은 2 MiB fixed byte arena,
group/layer/reference는 fixed-capacity TypedArray index, number token은 128-byte scratch를 사용한다.
Build-time immutable schema table 외에 request 경로에서 `Map`, `Set`, dynamic array growth, string
concatenation 또는 capacity resize를 금지한다. Table/arena full과 reservation/preallocation 실패는
해당 추가 allocation 전에 `SCENE_PRESET_LIMIT_EXCEEDED`로 끝난다.

Worker는 일반 JS DTO나 generic parser tree를 만들지 않는다. 성공 시 검증한 동일 raw `ArrayBuffer`를
transfer list로 Main에 돌려보내므로 backing store는 복제되지 않고 Worker 쪽 buffer는 즉시
detached된다. 성공 send, malformed, reservation failure, cancel 및 postMessage throw의 모든
`finally`에서 table/arena/scratch reference와 ledger slot을 동기 release하고 stable redacted error만
반환한다.

Main의 Worker client는 전송되는 object brand를 신뢰하지 않는다. `crypto.getRandomValues`로 만든
128-bit nonce, request ID, generation ID와 정확한 Worker instance의 closure-bound event handler를
결합한다. Worker는 세 값을 그대로 echo하고 Main은 해당 instance의 응답에서 모두 일치할 때만
반환된 transferred bytes를 받는다. 외부 `window.postMessage`, 다른 Worker, stale generation 및 이미
settled된 응답은 capability를 만들 수 없다.

Main은 Worker request를 capability와 분리해 다음 lifecycle로 관리한다.

```text
request: created -> in-flight -> response-accepted
request: created|in-flight -> invalidated
```

`response-accepted`는 exact Worker instance, nonce, request ID, generation ID 및 transferred buffer를
동기 검증한 뒤 listener/timer를 제거하고 Worker를 terminate한 terminal request state다. 검증 전에는
capability가 존재하지 않는다. Invalidated 또는 terminal request의 completion은 duplicate/stale counter만
올리고 Promise나 payload를 다시 settle하지 않는다.

`response-accepted` 이후에만 Main은 module-private `WeakMap`에 bytes와 상태를 등록하고 Main-local
opaque one-shot capability를 생성한다. Capability 자체는 IPC·Store·Project·파일에 직렬화하지 않는다.
상태 전이는 다음만 허용한다.

```text
capability: ready -> consuming -> consumed
capability: ready|consuming -> invalidated
```

Consuming API는 synchronous check-and-set으로 `ready -> consuming`을 먼저 수행한다. Main decoder가
성공하면 `consuming -> consumed`, internal mismatch/allocation/exception이면
`consuming -> invalidated`로 전이한다. User cancel은 `ready`까지만 interrupt할 수 있다. Decoder는 Main
event loop에서 synchronous라 `consuming` 중 외부 cancel callback이 interleave하지 않으며, reentrant
failure injection은 `invalidated` path를 사용한다. `invalidated` terminal은 `finally`에서 bytes reference,
WeakMap entry, wrapper와 모든 Main ledger slot을 동기 release한다. `consumed` terminal은 raw/scratch,
bytes reference, WeakMap entry와 wrapper를 release하되 exact DTO 80 MiB reservation을 candidate generation
account로 원자적으로 re-key한다. 이 reservation은 publish 후 active generation이 소유하고 해당 generation
retire 시 release한다. Publish 전 failure는 candidate reservation을 release하며 old generation account를
변경하지 않는다. Replay, stale completion, duplicate response, cancel/consume race 및 double-consume은
Promise를 정확히 한 번 settle하고 payload를 재사용하지 않은 채 stable counter만 남긴다.

Main decoder는 capability가 소유한 preflight-complete bytes에서 allowlisted exact DTO를 직접 한 번만
구축한다. 일반 `JSON.parse`, generic object tree 또는 DTO deep clone을 만들지 않는다. Worker와 Main
parser의 token/schema decision table은 하나의 생성된 immutable table을 공유하고 divergence fixture를
테스트한다. Main decoder의 unexpected mismatch도 mutation 전에 internal-invalid로 종료한다. Fresh
Project는 구축된 GeoJSON/reference subtree의 유일한 live reference를 사용하며 wrapper를 즉시
release한다. Main 96 MiB logical reservation은 raw 8, exact DTO 80, decode/apply scratch 8 MiB다.

Logical ledger는 RSS 주장과 구분한다. Windows Release gate는 production Tauri/WebView2 build에서 native
50 ms sampler로 app process tree의 private working set을 CSV로 기록한다. Deterministic generator는
`tests/fixtures/generate-scene-preset-memory-fixtures.mjs`의
`phase7e-memory-fixtures-v1`이며 다음 명령 외 생성 경로를 허용하지 않는다.

```text
node tests/fixtures/generate-scene-preset-memory-fixtures.mjs --verify
node tests/fixtures/generate-scene-preset-memory-fixtures.mjs --out <empty-directory>
```

Expected output identity는 다음과 같다.

```text
phase7e-feature-25000-v1.geoim3d-preset.json
  bytes: 2076286
  sha256: 77707a2c850ffdf89af45e909157cb3c7fc32fdb8a622e3dc656966cdae34dd2
phase7e-coordinate-250000-v1.geoim3d-preset.json
  bytes: 1501374
  sha256: 0c75b2a145efcfbc87cbb12ab0d6825ac9eea0a6238a3b8cc72a811732aea5f5
```

`--verify`와 generated file의 independent `sha256sum`이 모두 expected identity와 일치해야 sampler를
시작할 수 있다. Generator source SHA-256, generator version, Node version, command, fixture byte length와
file SHA-256을 run manifest에 기록한다. CSV schema는 다음 exact columns다.

```text
utc_ns,run_id,fixture_id,phase,pid,parent_pid,process_creation_time,process_role,private_working_set_bytes
```

Process tree는 sampler 시작 시 Tauri root PID와 creation time을 고정하고 parent chain이 해당 root에
도달하는 모든 live descendant를 포함한다. PID 재사용은 creation time 불일치로 제외한다. Role은
`tauri-root|webview-renderer|webview-utility|other-child` 폐쇄형이며 Web Worker가 renderer process 내부면
별도 PID를 만들지 않는다. Phase는 `idle|worker-scan|transfer-handoff|main-decode|store-apply|recovery`다.

30초 idle 중 마지막 5초의 50 ms sample median을 PID별 baseline으로 하고 합계를 tree baseline으로
사용한다. Fixture별 3회 run에서 `max(sample - matching PID baseline, 0)`의 renderer 합계 peak는
`<= 160 MiB`, `max(tree sample sum - tree baseline, 0)`은 `<= 192 MiB`여야 한다. 각 run 완료 60초 후
5초 median tree delta는 `<= 32 MiB`여야 하며 recovery delta가 `run1 < run2 < run3`으로 strict
monotonic increase하면 실패한다. 새 child의 baseline은 0이며 종료된 child는 이후 sample에서 0이다.
Exact fixture는 같은 fresh-start build/configuration에서 순차 실행한다. CSV, run manifest, hashes,
baseline/peak/recovery 계산 JSON이 모두 없으면 Release Gate는 fail이다. Linux/Node RSS는 개발 참고값일
뿐 승인 근거가 아니다.

Export는 Store에서 allowlist DTO를 먼저 구축하고 fixed-order canonical writer로 byte length를 two-pass
measure한다. 별도 output 8 MiB reservation을 사용하며 `max + 1`은 native picker/write 호출 전에
거부한다.

### 11.4 External scene resource transport

**현재 1.0 executable Runtime 범위(2026-07-22):** relative self-contained `.glb`만 활성화한다.
HTTPS reference는 URL 문법·credential 검사를 통과하더라도 direct peer-pinned TLS adapter가 연결되지
않았으므로 import prepare 중 `SCENE_PRESET_REMOTE_UNAVAILABLE`로 hard-fail하며 Store mutation은 0이다.
Relative `3d-tiles`와 `i3s`도 nested URI의 native rewrite가 구현되기 전까지 strict parser/materializer에서
`SCENE_PRESET_REFERENCE_INVALID`로 거부한다. 아래 HTTPS·3D Tiles/I3S transport 절은 승인된 목표
아키텍처이며, 해당 adapter/rewrite와 consent Runtime·tests가 구현되기 전에는 Release 지원으로 주장하지
않는다.

External resource는 모두 Windows Tauri의 native-owned transport를 사용한다. Renderer가 HTTPS를
직접 fetch하거나 absolute path를 받는 경로는 없다.

HTTPS 정책:

- `https`, port 443, userinfo/query/fragment 없음
- host는 DNS name만 허용하고 IP literal, localhost, `.local`, private/reserved destination 거부
- 매 request DNS resolution 후 모든 address와 IPv4-mapped IPv6를 global-unicast로 검증하고, 검증된
  IP 하나에 TCP 연결을 직접 고정한다. Hostname은 TLS SNI/인증서 hostname 검증에만 사용하며 HTTP
  client가 hostname을 다시 resolve하지 못하게 한다.
- redirect 0, cookie/credential/referrer/header injection 0
- root와 subresource는 exact same origin; path normalization 및 traversal 거부
- import apply 전에 origin·format·remote request 사실을 사용자에게 표시하고 명시적 동의
- timeout 30초, concurrent 8, cancel propagation, stable error code

Preset transport는 기존 native HTTP/client-certificate client를 재사용하지 않는 전용 client다.
OS/root trust store와 hostname verification을 강제하고 invalid/expired/untrusted certificate를
거부한다. Ambient cookie jar, Authorization, proxy, proxy credential, system/user client certificate,
mTLS auto-selection 및 custom root override는 모두 비활성화한다. Connection pool entry는
`origin + verified IP + certificate identity`에 binding하고 재사용 전 global-address와 host binding을
다시 확인한다. Proxy 환경변수와 OS proxy는 무시한다. DNS 검증 IP와 실제 socket peer IP 불일치,
proxy 우회, invalid certificate, client-cert request를 mock transport test에서 거부한다.

Relative 정책:

- Import picker가 Preset file handle과 parent directory root capability를 함께 생성한다.
- root capability는 volume/file identity와 모든 ancestor의 no-reparse/no-symlink 상태를 캡처한다.
- canonicalize 후 pathname 재개방을 금지한다. 모든 resource/subresource는 root handle에 상대적인
  no-follow open으로 열고 같은 handle에서 identity, type, size, final path containment를 검증한다.
- open-to-stream 동안 handle을 유지하여 validation/use TOCTOU를 막는다.

허용 format/resource:

- GLB: `.glb`, `model/gltf-binary`
- 3D Tiles: `.json`, `.subtree`, `.b3dm`, `.i3dm`, `.pnts`, `.cmpt`, `.glb`, `.bin`,
  `.png`, `.jpg`, `.jpeg`, `.webp`
- I3S root reference는 HTTPS same-origin만 허용하고 Preset의 relative I3S root는 1.0에서 거부
- sniffed signature와 extension/MIME가 모두 일치해야 하며 HTML/XML/login response를 거부

Native는 URI-bearing content를 Renderer에 전달하기 전에 검사한다. Self-contained GLB만 허용하며
GLB JSON chunk의 external `buffers[].uri`/`images[].uri`와 extension URI는 거부한다. 3D Tiles 및
I3S JSON, b3dm/i3dm/cmpt 내부 glTF JSON의 `content.uri`, `contents[].uri`, subtree, buffer, image,
schema URI를 strict parse한다. Relative-root 3D Tiles nested URI는 normalized same-root relative만,
HTTPS-root 3D Tiles/I3S nested URI는 normalized relative 또는 canonicalized exact same-origin HTTPS만
허용한다. Native가 모두 session resource ID로 등록하고 `geoim3d-preset-resource` URL로 rewrite한다.
그 외 absolute/network/data/blob/file URI, unknown URI-bearing extension 및 parse할 수 없는 container는
거부한다. Renderer network spy에서 custom native protocol 외 HTTP(S)/file/blob request가 0이어야 한다.

Limits: resource files 4,096, single resource 256 MiB, cumulative transferred 1 GiB/session,
single range 16 MiB, streaming chunk 1 MiB, concurrent 8. Root JSON 16 MiB를 넘으면 거부한다.
Range는 valid single byte-range만 허용하고 multipart/overlap/negative range를 거부한다.

Session registry는 request 시작 전에 resource slot, concurrent slot 및 declared/range bytes를 하나의
mutex transaction으로 reserve한다. 다음 식이 참일 때만 reserve한다.

```text
committedCumulativeBytes + inFlightReservedBytes + currentDeclaredBytes
  <= 1 GiB session quota
```

Reserve 실패 시 socket/file open 전에 거부한다. 실제 전송량은 chunk마다 reservation에서 정산하고
초과 전 cancel한다. 성공 시 전송 bytes를 committed cumulative로 이동하고 concurrent slot을
release한다. 실패/cancel/timeout/stale completion은 `finally`에서 미전송 reservation과 slot을
원자적으로 rollback하되 이미 전송한 bytes는 committed cumulative에 남긴다. Retry는 새 전송량
전체를 다시 reserve/과금한다. Overlapping range는 항상 거부한다. 두 동시 요청의 합계 exact
1 GiB/+1, cancel-race, retry, overlap, stale generation tests를 수행한다.

Native session state:

```text
created → consented → active → revoked/closed
```

Session ID는 CSPRNG 128-bit memory-only capability이며 preset/project generation, route, root/origin,
resource allowlist 및 quotas에 binding한다. Cross-route, replay, stale generation을 거부한다.
Renderer URL은 `geoim3d-preset-resource://<opaque-session>/<resource-id>/<subpath>` 형태지만
로그/diagnostics/error에 원문을 기록하지 않는다. Cancel, failed parse/apply, Relink, Project replace,
unmount, window close 및 process exit에서 handle/request를 cancel하고 registry에서 즉시 폐기한다.

Missing resource는 network fallback 없이 unresolved placeholder가 된다. Relink는 새 picker/root
session에서 모든 references를 다시 검증한 뒤 한 Store mutation으로 교체한다. 실패하면 기존
placeholder/session state를 보존한다.

Reference별 상태기계:

```text
relative:
  declared → verified → active
           ↘ missing → unresolved → relative-relink-picker → verified → active
                                ↘ teardown

https:
  declared → consented → verified → active
                    ↘ unavailable → unresolved → explicit-retry-or-url-relink → verified → active
                                             ↘ teardown
                    ↘ denied/invalid → hard-failed
```

Relative invalid/traversal/reparse/identity failure와 HTTPS private DNS, TLS, redirect, credential,
cross-origin failure는 hard-fail이며 unresolved import를 허용하지 않는다. Relative missing 및 HTTPS
404/timeout/temporary 5xx만 사용자의 명시적 선택으로 unresolved placeholder import를 허용한다.
Relative Relink는 native file/root picker, HTTPS Relink는 새 URL 입력·consent·native preflight를
사용한다. Import/apply 전 hard failure는 Store mutation 0이다. Runtime operational failure는 active
Project를 유지하고 해당 Layer만 unresolved로 전환한다.

Unresolved placeholder는 original normalized reference, format, ordinal 및 stable error code만 prepared
plan에 보존하고 native file/network handle과 active session ID는 갖지 않는다. Placeholder 준비 완료는
“network/file request 0, publish 후 placeholder로 reconcile 가능”을 뜻한다. Placeholder는
Project generation이 유지되는 동안 보존되며 Relink/retry 성공 시 새 pending generation transaction으로
active layer와 교체한다. Remove/Project replace/unmount/exit에서는 request 없이 teardown한다.

Project reopen에서 HTTPS reference는 사용자 consent record를 disk에 저장하지 않고 새 memory-only
session을 `declared` 상태로 만든다. 사용자가 Layer load/retry를 승인하면 DNS/TLS/native preflight 후
active가 된다. `REMOTE_DENIED`는 hard-failed, `REMOTE_UNAVAILABLE`은 retry 가능한 unresolved,
`REFERENCE_MISSING`은 relative missing, `SESSION_STALE`은 old generation request로만 매핑한다.
Project replace/unmount/exit는 relative/HTTPS session을 동일하게 teardown한다.

### 11.5 Preset-derived Project 저장 및 재오픈

HTTPS reference는 credential-free canonical reference로 `.geoim3d.json`에 저장할 수 있다.
Relative reference는 다음 조건에서만 canonical Project에 저장한다.

1. 최초 Project Save As 대상 parent가 active Preset root와 동일 directory identity다.
2. 모든 relative path가 새 Project parent 아래에서 같은 handle/identity로 다시 검증된다.
3. Project에는 relative 문자열만 저장하고 root/session/path identity는 저장하지 않는다.

다른 directory로 Save As하려 하면 silent copy/rewrite 없이 `SCENE_PRESET_PROJECT_ROOT_MISMATCH`로
전체 저장을 거부한다. 사용자는 동일 root를 선택하거나 relative Layer를 제거/HTTPS로 Relink해야
한다. Project reopen 시 Windows native opener가 Project parent를 새 root capability로 만들고 새
ephemeral session을 생성한다. Web/non-Windows에서 relative-reference Project는 fail-closed한다.

### 11.6 Native route 및 atomic file contract

```text
pick_and_read_scene_preset() -> { importCapability, bytes }
pick_scene_preset_save_target() -> { saveCapability }
write_scene_preset(saveCapability, bytes) -> ()
close_scene_preset_session(importCapability) -> ()
```

Capability는 memory-only, route-bound, generation-bound이며 path/filename을 Renderer에 반환하지
않는다. Import picker filter는 `.geoim3d-preset.json`, Project picker filter는
`.geoim3d.json`만 허용한다. Generic Open/Recent/Startup/Drop/URL/Deep-link는 suffix와 top-level
schema/kind 양쪽에서 Preset을 거부한다.

Export는 DTO validation과 byte measure가 끝날 때까지 picker/write를 호출하지 않는다. Native
writer는 target directory의 exclusive temporary file에 bounded write, flush, close 후 atomic
replace한다. Cancel/error/+1에서 target create/truncate 0이며 실패한 temp file은 삭제한다.
Export 전후 Store, dirty, history, selection, resource session은 byte-equivalent해야 한다.

### 11.7 Error, private-content 및 egress

Native/Worker/adapter/hook/UI는 앞 절의 stable code union만 교환한다. Unknown exception은 모든
layer에서 `SCENE_PRESET_INTERNAL`로 downgrade한다. OS/parser/network text, stack, path, filename,
raw URL/session ID 및 user layer name은 UI, console, diagnostics, telemetry, log에 기록하지 않는다.
Offending item은 `Layer 3` 같은 ordinal로만 표시한다.

Credential denylist는 기존 managed environment alias, provider API key/token/password/cookie/header,
VWorld/Protomaps/Cesium/geocoder key alias를 단일 shared registry에서 가져온다. Preset exact DTO가
primary defense이고 기존 Earthwork/Terrain/Viewshed/IFC detector는 defense-in-depth다. Identity key
단독, summary field 재배치, nested array/object, JSON-string wrapping, split/repacked payload를
adversarial test한다.

External scene Layer와 Preset content는 history/recovery/autosave/browser storage/cache/service
worker에 기록하지 않는다. Raw reference/session/resource는 generic serializer/export, clipboard,
print/video/tour/story map/HTML, plugin SDK, AI/notebook/statistics/SQL, embed/share/collaboration에서
최종 payload 생성 직전에 중앙 guard로 차단한다. 사용자가 명시적으로 수행하는 map screenshot은
rendered pixels만 허용하며 reference/session metadata는 포함하지 않는다.

Web/PWA 및 non-Windows build는 relative picker/command/protocol/session module과 문자열 marker 0을
보장한다. HTTPS external scene Preset도 1.0에서는 Windows Tauri만 활성화하며 Web import는 external
reference가 하나라도 있으면 거부한다. Web과 Windows build를 별도 clean output으로 만들고 route,
command, protocol, Worker chunk, storage write 및 endpoint marker를 scan한다.

### 11.8 Packaging/Release matrix

| Artifact                  | 계약                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Windows Debug/Release EXE | Native picker/resource/runtime smoke                                                  |
| Portable ZIP              | clean machine launch, Save/Import/Relink                                              |
| NSIS                      | install/run/open/uninstall, registry residue 0                                        |
| MSI                       | unsigned administrative extraction evidence; signed installability 주장 금지          |
| Store-unsigned MSIX       | Partner Center submission input으로만 분류                                            |
| Signed enterprise MSIX    | Publisher subject 일치 certificate + SignTool + install/remove evidence 없으면 미완료 |

모든 manifest/registry scan에서 `.geoim3d-preset.json` association, ProgID, Open-With, startup handler가
0이어야 한다. Store Identity/Publisher 주입, MakeAppx availability 및 signing certificate가 없으면
Phase 8 Release blocker로 명시하며 fabricated/sideload-success 주장으로 대체하지 않는다.

## 12. Test Matrix

### Schema/Bounds

- native/Worker/output 각각 exact 8 MiB/+1, malformed/fatal UTF-8
- tokenizer allocation 전 unknown/missing/duplicate key, depth, node 400,000 exact/+1,
  layer/feature/coordinate exact max/+1
- generic parser tree/DTO 재복제 0, transferred backing-store identity와 Worker-side detach 검증
- exact Worker/Main decision-table divergence 0
- Main-local capability 위조, 다른 Worker/nonce/request/generation, replay·stale·double-consume 거부
- request created/in-flight/response-accepted/invalidated 및 capability
  ready/consuming/consumed/invalidated exact 전이와 cancel/consume race single settlement
- fixed TypedArray/table/arena preallocation failure와 full/+1에서 동적 growth 없이 allocation 전 거부
- NaN/Infinity/-0 normalization, sparse/prototype/accessor object
- canonical byte repeatability와 key-order independence
- Worker 128 MiB/Main 96 MiB logical ledger exact max/+1, invalidated release 및 consumed generation re-key
- Windows exact fixture/hash/CSV schema와 renderer 160 MiB/process-tree 192 MiB/recovery 32 MiB 계산 gate

### Preset Semantics

- Built-in blank 3D → Cesium, 1×1, Layer 0, path null
- exact basemap V1 union/hash, blank ID default, unknown/case/hash mismatch 거부
- Custom save/import → map view/style/group/layer data identity
- current Project에 merge 0
- cancel/error before mutation, apply atomic one-shot
- publish 전 Store mutation 0, 단일 Store publish와 `projectGeneration` 정확히 1 증가
- generation/request ID 기반 stale completion 폐기 및 publish 후 old session/request idempotent teardown
- cleanup throw/duplicate dispose가 active generation을 변경하지 않음
- publish 후 단일 Layer renderer 실패는 value-safe error/placeholder로 격리하고 다른 Layer/App 정상 유지
- imported project dirty/new identity and recent entry 0
- existing MapLibre/Cesium mounted state에서 workspace Cesium과 shared camera 결정론 적용
- relative Project same-root Save/Open 성공, 다른-root Save As 전체 거부

### Security

- every credential/session/environment alias
- nested/repacked/stringified private Earthwork/Terrain/Viewshed/IFC scenegraph
- absolute/UNC/file URL/traversal/backslash/symlink/reparse
- HTTPS userinfo/query/fragment/signed token rejection
- HTTPS redirect/private DNS/rebinding/cross-origin subresource/cookie/referrer 거부
- DNS-validated IP/socket-peer binding, proxy/client-cert/invalid TLS 거부
- GLB/3D Tiles/I3S nested URI native rewrite와 Renderer direct network 0
- session replay/cross-route/stale generation/quota/range/teardown
- concurrent quota reserve/rollback/retry/overlap/cancel race
- generic Project Open, URL/deep-link/embed/collaboration/plugin/AI/notebook/export boundary
- localStorage/IndexedDB/CacheStorage/history/recovery snapshot 0
- export writer 호출 전 +1 거부와 temp-file atomic replace/cleanup
- native/IPC/Worker/UI/console/diagnostics error redaction

### Windows/Runtime

- Native Save/Import picker
- relative model same-handle bounded open
- missing reference + Relink
- Save preset → exit → import → new Project
- Release/Portable/NSIS/MSI extraction/Store-unsigned MSIX runtime·manifest 경계
- Web/non-Windows에서 Windows path command marker 0
- console/page error 0, Preset 기능 external request 0(HTTPS model load는 사용자가 Apply 후 명시적으로 허용한 reference만)

## 13. Acceptance

- [ ] 사용자 Intent와 canonical extension 승인
- [ ] Schema/bounds Architecture Review 승인
- [ ] Preset exact DTO와 Project 변환표/unknown-key fail-closed
- [ ] byte-level tokenizer 및 Worker/Main memory ledger
- [ ] Built-in blank 3D Preset 생성
- [ ] Custom data-inclusive save/import
- [ ] external model HTTPS/relative-only validation
- [ ] native opaque resource session/range/quota/teardown
- [ ] relative-reference same-root Project Save/Open 및 other-root 거부
- [ ] credential/private/absolute-path fail-closed
- [ ] atomic temp-file export 및 stable redacted error union
- [ ] exact bounds와 atomic mutation tests
- [ ] full frontend/backend/worker/lint/build/E2E
- [ ] Web/non-Windows/Windows artifact separation
- [ ] Windows Native Save/Import/Apply/Restart runtime
- [ ] NSIS/Portable/MSI extraction/MSIX manifest association 0
- [ ] Gitleaks
- [ ] Geospatial/3D, Security/Privacy, Windows/Tauri/Packaging 독립 Review

> 2026-07-22 Product Owner 지시: 실행 가능한 scenario 기반 Windows Memory 3회 Gate는
> 이번 진행 범위에서 제외한다. 이 항목은 PASS가 아니라 deferred이며 CSV/manifest/calculations와
> threshold/recovery 결과를 주장하지 않는다. Phase 8 최종 Release 판단에는 예외로 명시한다.

### 13.1 Independent Review Remediation

첫 Acceptance snapshot은 Product/3D, Security/Privacy, Windows/Tauri 세 관점 모두 REJECT였다.
구현은 시작하지 않았고 해당 patch/tree를 stale 처리했다. Section 11은 다음 blocker를 해결하기
위해 추가한 규범 계약이다.

- undefined Project template을 exact Preset DTO와 변환 경계로 교체
- resolved basemap credential URL 저장 차단
- 폐쇄형 basemap ID registry와 bundled-style hash identity
- shared camera와 단일 Store publish, generation 기반 stale consumer/session 정리
- byte-level parser와 실행 가능한 memory ledger
- external model DTO, HTTPS native transport, relative root capability/session/Relink lifecycle
- HTTPS/relative별 unavailable·hard-fail·Relink·reopen 상태기계
- DNS socket pinning, isolated TLS client, nested URI rewrite, atomic quota accounting
- relative resource의 canonical Project save/reopen 정책
- picker/import/save route signatures와 atomic writer
- stable error redaction 및 모든 generic/remote/storage egress guard
- Web/non-Windows zero-path와 NSIS/Portable/MSI/MSIX packaging matrix

## 14. Review/Delivery Gate

1. Acceptance와 Architecture를 세 관점에서 독립 검토한다.
2. 세 관점 모두 명시적 APPROVE일 때만 RED test/구현을 시작한다.
3. 구현 후 exact-stage hash를 고정하고 동일 세 관점의 Implementation Review를 반복한다.
4. REJECT/timeout/stale review에서는 Commit하지 않는다.
5. 사용자 요청 없이 Push/Merge/PR/Public Release하지 않는다.
