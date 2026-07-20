# Phase 7C — 토공량/절성토 MVP

## 1. 목적과 한계

지오아임3D Windows Desktop에서 사용자가 직접 선택한 로컬 DEM GeoTIFF와 Project의
WGS84 작업 경계, 일정 계획고를 이용해 절토량·성토량을 계산한다.

본 기능은 Pixel-center midpoint 근사 물량 산정이다. 측량·설계·시공 확정 성과를 대체하지
않으며 수직 Datum 변환을 수행하지 않는다. 사용자는 계산 전에 **DEM 표고와 계획고가 동일한
meter 수직 기준면을 사용한다**는 확인 항목에 명시적으로 동의해야 한다. 확인하지 않으면
계산하지 않는다. 임의 Datum 이름이나 설명은 입력·저장하지 않고 다음 고정 정책 Marker만
저장한다.

```text
verticalDatumPolicy: "user-confirmed-same-meter-datum-v1"
```

## 2. 플랫폼과 의존성

- 플랫폼: Windows Desktop Tauri 전용
- Compile-time 경계: `__TAURI_BUILD__`
- 일반 Web/PWA: 메뉴, Dialog, Callback/Prop, Worker, GeoTIFF 계산 Module, Parser/WASM,
  Endpoint, Marker 및 전용 Chunk 없음
- GeoTIFF Decode: Repository의 기존 `geotiff` Dependency 재사용
- CRS 변환: Phase 7A의 기존 `proj4`와 EPSG:5179/5186 정의 재사용
- 새 Parser, CRS Package 또는 Runtime EPSG Network Lookup을 추가하지 않는다.

Web Build는 `TAURI_ENV_*`를 명시적으로 제거하고 `dist`를 삭제한 Clean Build 직후 검사한다.
그 뒤 Tauri Build를 별도로 실행해 Worker/GeoTIFF 코드가 Desktop Artifact에만 존재하고 실제
실행되는지 확인한다.

## 3. 입력

### 3.1 DEM

- Native Tauri Open Dialog에서 현재 사용자가 직접 선택한 `.tif` 또는 `.tiff` 하나
- Remote URL, COG URL, Project에 저장된 Path, Drag/Drop Path, Clipboard Path 및
  Credential 기반 Raster는 입력으로 사용하지 않는다.
- TIFF Magic과 선택 확장자를 모두 확인한다.
- 단일 Image/IFD, 단일 Band, Pixel-interleaved DEM만 허용한다.
- 허용 Compression: uncompressed(`Compression=1`)만. LZW/Deflate 등 압축 TIFF는
  Decoder 내부 Peak Allocation을 엄밀히 제한할 수 있을 때까지 MVP에서 거부한다.
- 허용 Sample:
  - unsigned integer: 8/16/32 bit
  - signed integer: 8/16/32 bit
  - IEEE float: 32 bit
- TIFF Mask, ExtraSamples, Palette(`PhotometricInterpretation=3` 또는 `ColorMap`),
  `SubIFDs`, non-zero `NewSubfileType`, OldSubfileType, Scale/Offset, GDAL scale/offset
  metadata, Overview, Multi-page, NaN/Infinity elevation은 지원하지 않고 거부한다.
- `geotiff.js` 호출 전에 Classic TIFF IFD를 직접 bounded preflight한다. IFD Entry는 최대
  256개, 전체 IFD-controlled metadata payload는 1 MiB이며 Tag type/count/offset/range,
  duplicate Tag, linked next IFD 및 Strip 배열 count를 검증한 뒤에만 Library Parser를 호출한다.
- Strip-only 입력이며 `RowsPerStrip`은 양의 정수여야 한다. Strip 개수는
  `ceil(height / RowsPerStrip)`과 정확히 일치하고, 각 `StripByteCounts`는 해당 Strip의
  실제 Row 수 × Width × BytesPerSample과 정확히 일치해야 한다. 마지막 Partial Strip,
  File 범위, Offset overflow 및 Strip overlap도 fail-closed로 거부한다.
- NoData Tag가 있으면 원 Sample 값과 exact 비교하여 제외한다. NoData Tag가 없으면 모든
  유한 Sample을 유효 값으로 취급한다. 선택 경계 밖을 포함한 전체 DEM의 Non-NoData
  Sample을 검증하며 NaN/Infinity/허용 표고 범위 초과가 하나라도 있으면 거부한다.
  유효 Pixel이 하나도 없으면 거부한다.

### 3.2 CRS와 GeoTransform

- `ProjectedCSTypeGeoKey`는 고정 Enum `EPSG:5179` 또는 `EPSG:5186`만 허용한다.
- `GTRasterTypeGeoKey`는 `PixelIsArea`만 허용하며 `PixelIsPoint`는 거부한다.
- `ModelPixelScaleTag + ModelTiepointTag` 기반 north-up axis-aligned Transform만 허용한다.
- Tiepoint는 정확히 하나이며 Raster `(tieI, tieJ, 0)`와 World `(tieX, tieY, 0)`를 연결한다.
- `ModelTransformationTag`, GCP, RPC, negative axis scale, rotation, shear, south-up,
  east-to-west 및 비선형 Geolocation은 거부한다.
- `scaleX`, `scaleY`는 유한한 양수이고 `0.01 <= scale <= 100` meter이다.
- Pixel-center 좌표:

```text
x = tieX + ((column + 0.5) - tieI) * scaleX
y = tieY - ((row    + 0.5) - tieJ) * scaleY
```

- Raster width/height 방향과 위 식의 extent가 일치해야 하고 각 축 extent는 100 km를
  초과하지 않는다.

### 3.3 작업 경계

- Project의 Geometry-only WGS84 `Polygon` 또는 `MultiPolygon`
- GeoJSON Coordinate 순서: `[longitude, latitude]`
- 허용 WGS84 범위: longitude `[-180, 180]`, latitude `[-90, 90]`
- Antimeridian 교차는 MVP에서 거부한다.
- 모든 Ring은 닫혀 있고 최소 4 Coordinate이며 non-zero area이다.
- Self-intersection, malformed nesting, 빈 Geometry 및 비유한 Coordinate를 거부한다.
- Winding 입력에는 의존하지 않으며 저장 시 exterior CCW, hole CW로 정규화한다.
- MultiPolygon Polygon끼리 겹치거나 서로 접하면 중복 집계를 피하기 위해 거부한다.
- 입력 Coordinate 수는 전체 20,000개 이하이다.
- 저장 좌표는 소수점 8자리로 정규화하고 정규화 후 Geometry를 재검증한다.

GeoJSON Edge는 RFC 7946의 longitude/latitude Cartesian segment로 해석한다. 각 Edge는
WGS84 midpoint를 투영한 점과 투영된 양 끝점의 chord midpoint 사이 거리가 다음 이하가 될
때까지 재귀적으로 이등분한 후 기존 Local `proj4` 정의로 WGS84 → DEM CRS 변환한다.

```text
projectionToleranceMeters = min(0.01, min(scaleX, scaleY) * 0.01)
maximum subdivision depth = 20
maximum projected coordinates after densification = 200,000
```

축 순서는 항상 `x,y`이다. 변환 결과는 유한하고 절댓값 10,000,000m 이하이어야 하며 모든
작업 경계 Coordinate는 DEM extent 내부에 있어야 한다. 오차 기준을 만족하지 못하거나
한도·범위·CRS가 맞지 않으면 Fail-closed 처리한다. 계산에는 densified projected geometry를
사용하고 Project에는 정규화한 원래 WGS84 geometry만 저장한다.

Boundary Predicate는 projected meter 단위 다음 Tolerance를 사용한다.

```text
boundaryEpsilonMeters = max(1e-8, min(scaleX, scaleY) * 1e-7)
```

점과 Segment의 최소 거리가 epsilon 이하이고 Segment projection parameter가 epsilon을
반영한 `[0,1]` 안이면 boundary로 본다. 먼저 모든 hole boundary를 검사해 즉시 제외하고,
그 다음 exterior boundary면 포함하며, 마지막으로 winding-independent ray crossing을 적용한다.
유효 Geometry 계약상 exterior와 hole은 서로 접할 수 없다. Acceptance는 exact boundary와
`±2 * epsilon` fixture를 포함한다. Hole 내부와 Polygon 외부 Pixel은 제외하며 각 Pixel은
최대 한 번만 집계한다.

### 3.4 계획고

- `Number.isFinite(designElevationMeters)`
- `-1,000 <= designElevationMeters <= 10,000`
- DEM의 모든 유효 Elevation도 동일 범위만 허용한다.
- 계획고와 DEM은 사용자가 확인한 동일 수직 기준면의 meter 값으로 취급한다.

## 4. 계산 계약

유효 Pixel 중심이 작업 경계 안에 있을 때:

```text
cellArea = scaleX * scaleY
delta    = terrainElevation - designElevation
cut      = max(delta, 0)  * cellArea
fill     = max(-delta, 0) * cellArea
net      = cut - fill
```

- Row-major deterministic 순서와 Kahan compensated summation을 사용한다.
- `includedCells`는 Safe Integer이고 `1..5,000,000` 범위이다.
- `cellArea`: `0.0001..10,000 m²`
- `includedArea`: 양수이며 최대 `100,000,000,000 m²`
- `abs(delta) <= 11,000m`
- `cut`, `fill`: 유한한 비음수이며 각각 최대 `1,000,000,000,000,000 m³`
- `net`: 유한하고 `net = cut - fill`
- 누적 전후 Checked Arithmetic을 수행하고 한도를 넘으면 거부한다.
- Reference Fixture 허용 오차:
  `max(1e-6 m³, abs(expected) * 1e-12)`
- 선택된 유효 Pixel이 하나도 없으면 거부한다.
- UI 표시만 반올림하고 계산 및 Project DTO 값은 반올림하지 않는다.

## 5. 크기·메모리 Preflight

```text
Maximum input GeoTIFF bytes:  48 MiB
Maximum width:                10,000
Maximum height:               10,000
Maximum pixels:               5,000,000
Maximum decoded sample bytes: 20 MiB
Maximum metadata bytes:       1 MiB
Maximum strip entries:        100,000
Maximum single strip bytes:   8 MiB
Enforced worker peak budget:  128 MiB
Design ledger maximum:         116 MiB
  native/transferred input:     48 MiB
  decoded samples:              20 MiB
  largest strip:                 8 MiB
  projected geometry/metadata:   8 MiB
  parser/runtime reserve:        32 MiB
Maximum input polygon coords: 20,000
Maximum projected coords:     200,000
Worker timeout:               60 seconds
```

- 모든 곱셈·덧셈은 allocation 전에 Safe Integer Checked Arithmetic으로 검증한다.
- Header/IFD와 Strip/Tile offset·byte-count 배열의 길이, 범위, 합계를 Decode 전에 검증한다.
- Strip/Tile byte range는 입력 Buffer 범위 안에 있어야 한다.
- Band/Sample/decoded bytes를 확인한 뒤에만 Pixel TypedArray를 할당한다.
- 압축 TIFF와 Tile storage는 거부하고 uncompressed Strip byte range만 허용한다.
- Peak Budget Ledger는 transferred input 48 MiB + decoded band 20 MiB + single strip 8 MiB
  + projected geometry/metadata 8 MiB + parser/runtime reserve 32 MiB = 116 MiB이며, 그 외
  전체-size TypedArray/복사본을 만들지 않는다. ArrayBuffer는 Worker로 transfer하고 clone하지
  않으며 Pixel loop는 Decoder가 반환한 단일 Band Buffer를 직접 순회한다.
- Partial Buffer, Decoder State 및 Transfer Buffer는 실패·취소 후 참조를 해제한다.

## 6. Windows 파일 접근

- Native Dialog Filter는 `.tif`, `.tiff`만 표시한다.
- 선택 취소는 오류가 아니며 Project/dirty state를 변경하지 않는다.
- 현재 Picker가 반환한 Path만 transient local 변수로 유지한다.
- Earthwork 전용 Native Tauri Command가 Windows `OpenOptionsExt`의 no-follow/open-reparse
  flag로 파일을 한 번 열고 **동일 Handle**에서만 검사·읽는다. Command 내부 상한은 Caller가
  바꿀 수 없는 48 MiB 상수이다.
- 열린 Handle의 `FILE_ATTRIBUTE_REPARSE_POINT (0x400)`를 검사해 symlink, junction,
  mount-point 및 다른 reparse object를 거부하고 일반 파일만 허용한다. Picker Path에 허용
  Root 경계를 두지 않으므로 parent junction을 통한 root escape 개념은 없지만, 최종 열린
  object가 reparse point이면 항상 거부한다.
- 동일 Handle Metadata의 초기 크기를 확인한 뒤 `max + 1` bounded streaming read를 수행한다.
  48 MiB를 넘는 즉시 중단하고, truncate/growth/replace race에서도 48 MiB 초과 Buffer를
  할당하지 않는다. 동일 Handle의 initial/final identity와 size를 비교하고, 읽기 완료 후
  Path를 `OPEN_REPARSE_POINT`로 identity-only 재개방하여 현재 pathname identity도 최초
  Handle과 일치해야 한다. Path replacement는 원본 Handle read를 바꾸지 못하며 최종 비교에서
  fail-closed로 거부된다.
- Native Command는 extension, TIFF Magic, regular-file/reparse, initial/final size를 확인하고
  고정 Code 또는 bounded Bytes만 반환한다. Path 또는 OS Error는 반환·기록하지 않는다.
- Project-supplied Path, 일반 `read_local_file` fallback 또는 `plugin-fs readFile`은 사용하지
  않는다.
- Path는 Worker Message, React State, Project, Recent Cache, Log 또는 Error에 전달하지 않는다.
- Worker에는 크기 검증된 `ArrayBuffer`와 정규화된 Boundary/Plan 값만 Transfer한다.
- Read 후에도 동일 Handle Metadata와 실제 Byte Length를 재검증한다.
- 삭제·잠금·권한 오류, 잘못된 확장자/Magic, symlink/reparse, 48 MiB 초과는 고정 Error Code로만
  표시한다.

## 7. Worker와 Lifecycle

- GeoTIFF Decode와 Pixel Loop는 Tauri-only Dedicated Worker에서 실행한다.
- Dialog는 계산별 monotonic generation/job ID를 사용한다.
- 새 계산, Cancel, Close, Unmount 및 60초 Timeout은 Worker를 실제 `terminate()`한다.
- Terminal UI state와 Worker quiescence를 구분하고 종료 전/후 늦은 Message는 generation으로
  무시한다.
- Cancel/실패/Timeout에서는 Project와 dirty state가 변하지 않는다.
- Timeout은 Worker에 요청을 전송한 시점부터 계산한다.
- Explicit Apply 전에는 결과를 Project에 추가하지 않는다.

승인 Error Code Allowlist:

```text
EARTHWORK_FILE_INVALID
EARTHWORK_FILE_TOO_LARGE
EARTHWORK_FILE_READ_FAILED
EARTHWORK_TIFF_INVALID
EARTHWORK_CRS_UNSUPPORTED
EARTHWORK_TRANSFORM_UNSUPPORTED
EARTHWORK_SAMPLE_UNSUPPORTED
EARTHWORK_BOUNDARY_INVALID
EARTHWORK_VERTICAL_DATUM_UNCONFIRMED
EARTHWORK_LIMIT_EXCEEDED
EARTHWORK_EMPTY_SELECTION
EARTHWORK_NUMERIC_INVALID
EARTHWORK_TIMEOUT
EARTHWORK_CANCELLED
EARTHWORK_REMOTE_INGRESS_REJECTED
EARTHWORK_PRIVATE_CONTENT_BLOCKED
EARTHWORK_FAILED
```

Raw `Error.message`, Parser Exception, Stack, Path, Filename, Pixel, NoData 값은 UI, console,
Worker DTO, Exception Boundary, Telemetry, Crash Report, Diagnostics, Test Artifact 및 Network
Payload에 전달하지 않는다.

## 8. Result Layer와 Project Round-trip

Result Layer:

```text
name: "토공량 분석"
type: "geojson"
geometry: normalized WGS84 Polygon | MultiPolygon
properties: {}
metadata.customLayerType: "earthwork-analysis"
metadata.earthworkAnalysis: EarthworkSummary
```

Summary Allowlist:

```text
schema: "geoim3d-earthwork-v1"
sourceFormat: "GeoTIFF DEM"
sourceCrs: "EPSG:5179" | "EPSG:5186"
verticalDatumPolicy: "user-confirmed-same-meter-datum-v1"
designElevationMeters
cellAreaSquareMeters
includedCells
includedAreaSquareMeters
cutCubicMeters
fillCubicMeters
netCubicMeters
method: "pixel-center-constant-grade-v1"
```

원본 DEM Path/Filename/URL/Bytes/Pixel, NoData 원값, Credential, Raw GeoTIFF Metadata,
Boundary Source Layer ID, Raw Error 및 Foreign Field는 저장하지 않는다.

Local canonical `.geoim3d.json` Save만 허용한다. Project Open/Reopen은 Result Layer를 신뢰하지
않고 중앙 Desktop ingress에서 다음을 재검증·정규화한다.

- 고정 Layer name/type/discriminator/schema/method/enum
- Geometry-only, `properties: {}`, normalized valid geometry
- Summary의 exact key allowlist, finite/range/type
- `includedArea ≈ includedCells * cellArea`
- `net ≈ cut - fill`
- cut/fill 비음수 및 모든 상한

불변식 허용 오차는 계산 Fixture와 동일하다. 추가 Field, NaN/Infinity, 불일치 또는 과도한
값은 거부한다. 각 Apply는 새 Result Layer를 추가하며 자동 덮어쓰지 않는다.

## 9. Privacy Ingress/Outbound

WGS84 현장 경계, 면적 및 물량은 **Private Analysis Content**이다. Local Project 저장 외 외부
전파를 허용하지 않는다.

모든 Desktop Project ingress는 `local`/`remote` Source를 중앙 Gate에 전달한다.

- local 허용: Native Picker/Startup Argument/Local Recent/Browser-local file의 canonical
  `.geoim3d.json`을 Tauri Desktop에서 여는 경우
- remote 거부: URL/Deep Link, HTTP Recent, Share, Embed, Collaboration, Clipboard 및
  Network/Remote Drag-Drop Payload
- 일반 Web/PWA: local/remote와 관계없이 persisted Earthwork Layer를 거부

모든 Project Loader API는 `(project, source: "local" | "remote")`를 요구한다. Native
Picker, Browser-local Picker, Startup Argument, Local Recent는 `local`; URL/Deep-link,
HTTP Recent, Share, Embed, Collaboration, Clipboard, Plugin 및 Network/Remote Drag-Drop은
`remote`를 명시한다. Source 생략은 Compile Error 또는 Runtime rejection이다.

Generic private-content guard는 전체 Object Graph를 depth/node/key/string-size 제한 아래
순회한다. `metadata.customLayerType`, `metadata.earthworkAnalysis`, fixed schema/method 또는
`cutCubicMeters + fillCubicMeters + netCubicMeters + includedCells` 조합이 어느 깊이에 하나라도
남아 있으면 Fail-closed로 탐지한다. Summary를 다른 Nested Field로 이동하거나 discriminator
일부를 삭제한 재포장도 거부한다. 모든 Earthwork Marker와 Summary Key를 제거한 일반
Geometry는 다른 GeoJSON과 의미론적으로 구분할 수 없으므로 Earthwork persisted content로
간주하지 않지만, Earthwork 기능은 그런 downgrade DTO를 생성하지 않는다.

외부 전송 직전 공통 Guard로 다음을 거부한다.

- Share Gallery, Embed state, Collaboration session/snapshot
- Standalone HTML, 일반 Data Export, Print, Clipboard
- Deep Link, Background Upload/Sync, Offline Sync, Backup/History snapshot
- AI Provider/Assistant Prompt·Tool Context, Notebook/Jupyter/Python/Script/Code 실행 입력
- Public/External Plugin API, Plugin Project Snapshot 및 Module Cache
- Layer Statistics/Analysis consumer, Screenshot/Canvas/Image export
- Project clone/duplicate/import helper와 일반 serializer의 canonical local-save 이외 Mode

각 Consumer Adapter는 payload를 구성하기 **직전**과 실제 send/export/invoke **직전**에
Guard를 호출하며 adversarial test를 둔다. Private Layer가 허용되는 Consumer는 MapLibre/Cesium
local rendering, Layer delete, 현재 in-memory state 및 canonical local Project Save/Open뿐이다.

Telemetry, Diagnostics, Crash Report 및 console은 Layer Content를 받지 않는다. Local Recent는
Project 경로만 유지하며 Snapshot/Summary를 Cache하지 않는다. Autosave, crash recovery,
session restore file, app-exit recovery, IndexedDB/localStorage/sessionStorage, Service Worker,
plugin/module cache 및 persistent undo/history에는 Private Content를 저장하지 않는다. Undo/redo
등 현재 Process의 휘발성 Memory도 해당 Layer Snapshot을 복제하지 않고 Layer add/delete를
non-undoable action으로 취급한다. Canonical local Project Save만 허용하며 다른 형식 Export,
Backup, clone 또는 duplicate를 허용하지 않는다.

Credential 입력 UI, Alias, Provider Endpoint, URL/query/header, Worker 전달, Project 저장,
Browser Storage, Event 및 Network Request는 존재하지 않는다. Feature 실행 중 Network 요청은
0이어야 한다.

## 10. UX와 표시

1. Polygon/MultiPolygon Layer 선택
2. 계획고 입력
3. 동일 수직 기준면 확인
4. Native DEM File 선택
5. Preview/계산
6. 절토량·성토량·순물량·면적·Pixel 수 확인
7. Explicit Apply

- Apply 전 Cancel/Close/실패는 Project와 dirty state를 변경하지 않는다.
- Apply 후 MapLibre 2D와 Cesium 3D는 동일 WGS84 Geometry-only Layer를 표시한다.
- Save → 앱 종료 → Startup Argument/Open → Layer와 Summary가 복원되어야 한다.
- 원본 DEM 전체 또는 per-cell 차분 Raster는 표시·저장하지 않는다.

## 11. Acceptance Test

### 계산/지오메트리

- [x] EPSG:5179/5186 WGS84 → projected fixture와 axis order
- [x] Adaptive edge densification tolerance/depth/count 및 curved-edge quantity fixture
- [x] PixelIsArea 중심 좌표 및 north-up row/column 식
- [x] PixelIsPoint/rotation/shear/negative scale/GCP/RPC 거부
- [x] Exterior boundary 포함, hole boundary 제외
- [x] Boundary exact/±2epsilon과 hole-first precedence
- [x] Ring closure/self-intersection/zero-area/antimeridian 거부
- [x] 겹치거나 접하는 MultiPolygon 거부 및 중복 집계 0
- [x] NoData exact 제외, NaN/Infinity/Scale/Offset/Mask/Multi-band/compressed/tiled 거부
- [x] signed/unsigned/float32 Sample fixture
- [x] 수직 기준 미확인 거부
- [x] 단일 선택 Pixel 수작업 Cut/Fill 기준값과 허용 오차
- [x] Kahan deterministic 합계와 volume/area overflow 거부

### Resource/Lifecycle

- [x] File/metadata/IFD/strip/tile/pixel/decoded/logical memory exact boundary
- [x] Unsafe multiplication, malformed offset/count 및 decompression bomb 거부
- [x] Native same-handle max+1 read와 path replace/truncate/growth race
- [x] Picker 취소, 확장자/Magic 오류, symlink/junction/reparse, 삭제/잠금, oversize
- [x] Cancel/Close/Unmount/Timeout terminate 및 stale result 차단
- [x] 실패·취소 후 Buffer/Worker 참조 해제와 Project/dirty 불변

### Project/Privacy

- [x] Geometry-only 고정 Result DTO와 Summary Allowlist
- [x] Save/Open invariant 및 Foreign Field adversarial rejection
- [x] Path/Filename/DEM/Pixel/NoData/Credential/Error/Stack 비저장
- [x] URL/Share/HTTP Recent/Embed/Collaboration/Web ingress 차단
- [x] 모든 Loader의 필수 source 분류와 nested/partial discriminator recursive scan
- [x] Share/Embed/Collaboration/HTML/Export/Print/Clipboard outbound 차단
- [x] AI/Notebook/Script/Plugin/Statistics/Screenshot/clone/duplicate consumer 차단
- [x] Autosave/recovery/session/storage/cache/undo/history persistent copy 0
- [x] Diagnostics/Telemetry/console/network content 0

### Build/Windows

- [x] Clean Web/PWA menu/dialog/callback/worker/parser/chunk/marker/network/credential 0
- [x] Tauri Artifact에는 Worker가 포함되고 실제 계산
- [x] Windows Debug/no-bundle, Release MSI/NSIS 및 Portable 각각 Worker/License 경계
- [x] 실제 작은 EPSG:5179 및 EPSG:5186 GeoTIFF Native Decode
- [x] Windows Native Dialog → Worker → Preview → Apply
- [x] MapLibre 2D/Cesium 3D 동일 위치
- [x] Save → 종료 → Open/relaunch → 복원
- [x] Native Cancel/Close/Timeout과 App/Worker/Temp/Listener cleanup 0
- [x] WebView console error 0
- [x] WSL Build/Browser Smoke는 Windows Native Evidence를 대체하지 않음

### 완료 증거 — 2026-07-20

- Earthwork target: `15 passed / 0 failed`
- Earthwork + CAD + IFC + Core: `60 passed / 0 failed`
- Frontend full: `2,973 passed / 0 failed / 1 skipped`
- TypeScript: PASS, targeted ESLint: error 0, npm audit: vulnerability 0
- Web/PWA production build 및 Earthwork UI/Worker/Decoder/Native marker recursive scan: 0
- Web/PWA Playwright zero-path: `1 passed`
- Windows Rust native: `9 passed / 0 failed` (exact 48 MiB, +1, reparse,
  path replacement, growth, truncate 포함)
- Windows Debug no-bundle 및 Release MSI/NSIS: PASS
- Tauri Bundle Earthwork Worker 및 `THIRD_PARTY_NOTICES.md`/web-ifc MPL resource: PASS
- 실제 Native EPSG:5179와 EPSG:5186 각각 Picker→Worker 계산:
  `cut 2 / fill 2 / net 0 / area 4 / cells 4`
- Native Save As `15,516 bytes`, 종료→Open/relaunch Layer/Summary 복원: PASS
- NSIS 격리 Install→Open→Native Save As→Uninstall: PASS, 최종 관련 HKCU Classes Key 0
- WebView reload Console/Page Error: 0
- Runtime TIFF, Project, Screenshot, Installer, Portable 및 Automation Script는 Repository에
  포함하지 않는다. Artifact Hash는 Phase 8 Release Gate에서 최종 Source로 다시 생성한다.

## 12. Stop Gate

Security/Privacy, Windows/Tauri 및 Geospatial/Quantity 독립 Review가 동일 Exact-stage를
승인하기 전 Commit/Push하지 않는다. Public Release와 Signed MSIX는 Phase 8 승인 전 보류한다.
