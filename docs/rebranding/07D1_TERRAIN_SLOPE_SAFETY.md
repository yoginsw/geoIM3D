# Phase 7D1 Terrain Slope/Safety Analysis — Acceptance

Status: FINAL EXACT-STAGE REVIEW CANDIDATE
Date: 2026-07-20
Product: geoIM3D 1.0.0

## 1. Sprint와 범위

Phase 7D는 별도 exact-stage/Review/Commit인 두 Sprint로 나눈다.

1. **7D1 경사·안전 Screening MVP**
   - Local DEM + WGS84 Polygon/MultiPolygon AOI
   - Horn 3×3 경사
   - 사용자 임계값 기준 safe/warning/danger/unknown Summary
   - Geometry-only AOI Result Layer
2. **7D2 가시권 MVP**
   - 7D1 완료 후 별도 Branch/Acceptance
   - Observer/target height와 bounded deterministic LOS

7D1은 법적 지반 안정성 판정이나 설계 인증이 아니라 사용자 정의 경사 기준에 따른 screening이다.
Per-cell 경사 Raster/Grid Export와 7D2 LOS는 7D1 범위 밖이다.

## 2. Platform과 Compile Boundary

- Windows Tauri Desktop 전용이다.
- Vite는 `TAURI_ENV_PLATFORM === "windows"`로 `__WINDOWS_TAURI_BUILD__`를 정의한다.
- Menu, Dialog, dynamic import, Worker URL 및 Native Adapter는 모두 이 marker로 gating한다.
- Web/PWA와 Linux/macOS Tauri bundle에는 7D1 UI/Worker/algorithm/native adapter가 없어야 한다.
- Rust module과 command registration은 `#[cfg(target_os = "windows")]`로 제한한다.
- `__TAURI_BUILD__`만으로 7D1을 gating하지 않는다.

## 3. Native Picker-only Input

Renderer가 Path를 Native command에 전달하는 방식을 금지한다.

고정 IPC command:

```text
pick_and_read_terrain_safety_geotiff
```

- Command가 `tauri_plugin_dialog::DialogExt` Native File Picker를 직접 연다.
- Filter는 `.tif`, `.tiff`만 허용한다.
- 사용자가 선택한 Path를 같은 command 내부에서 즉시 same-handle로 연다.
- Path/filename은 Renderer, Worker, React State, Project, Recent, Error, Log에 반환하지 않는다.
- 임의 Path argument를 받는 7D1 command는 등록하지 않는다.
- Plugin/Script가 command를 호출해도 사용자에게 Native Picker가 반드시 표시되어야 한다.
- Picker Cancel은 `TERRAIN_SAFETY_PICK_CANCELLED`만 반환한다.
- Native Picker phase는 사용자 modal interaction이므로 자동 timeout을 두지 않는다. Native Cancel 또는 App 종료로만 끝난다.
- Picker 완료 후 stale generation이면 Renderer는 bytes를 Worker에 전달하지 않고 참조를 해제한다.

공통화는 내부 private `bounded_local_dem` same-handle helper와 TIFF preflight primitive에 한정한다.
Earthwork public command, adapter, decoder 또는 `EARTHWORK_*` 오류를 7D1에서 호출·노출하지 않는다.

## 4. Native File/TOCTOU Contract

- Classic TIFF magic과 확장자를 확인한다.
- 최대 파일 크기: `48 * 2^20` bytes. Reader는 `max + 1` bounded streaming을 사용한다.
- `FILE_FLAG_OPEN_REPARSE_POINT`로 열고 모든 reparse object를 거부한다.
- initial/final same-handle volume/file identity와 size를 비교한다.
- 완료 후 pathname을 identity-only 재개방해 최초 Handle identity와 비교한다.
- replace/truncate/growth race를 fail-closed한다.
- raw OS error/path는 반환·기록하지 않는다.

## 5. GeoTIFF Contract

허용:

- classic TIFF, single image/IFD, single band
- uncompressed strip-only
- unsigned 8/16/32, signed 8/16/32, float32
- EPSG:5179 또는 EPSG:5186
- PixelIsArea
- axis-aligned north-up

거부:

- BigTIFF, tile, compression, palette/ColorMap, mask, ExtraSamples
- SubIFD, non-zero NewSubfileType, OldSubfileType, overview/multi-page
- ModelTransformation, GCP, RPC, rotation, shear, south-up, negative scale
- Scale/Offset/GDAL scale-offset metadata
- multi-band, float64, unsupported sample type

`geotiff.js` 전에 Classic IFD를 직접 preflight한다.

```text
maximum IFD entries:       256
maximum metadata bytes:    1 * 2^20
maximum strip entries:     100,000
maximum single strip:      8 * 2^20 bytes
maximum width/height:      10,000 / 10,000
maximum pixels:            5,000,000
maximum decoded band:      20 * 2^20 bytes
```

Tag type/count/offset/range, duplicate Tag, linked IFD, expected strip count,
각 uncompressed strip byte count, 마지막 partial strip 및 strip overlap을 parser allocation 전에 검증한다.
Deferred `GDAL_METADATA` byte count와 StripOffsets/StripByteCounts count를 materialization/copy 전에 검증하고,
materialization 후 실제 길이를 다시 확인한다.

7D1은 `geotiff.js readRasters()`를 사용하지 않는다. Bounded Classic IFD preflight가 전체 tag count/type/range와
deferred byte budget을 먼저 확정한 뒤, StripOffsets/StripByteCounts와 최대 1 MiB GDAL metadata만 직접 materialize한다.
허용된 uncompressed strip sample은 원본 transferred `ArrayBuffer`의 `DataView`에서 output typed array로 직접 decode하며
strip payload copy나 full slope raster를 만들지 않는다.

7D1 decoder는 `decodeTerrainSafetyGeoTiff`라는 별도 domain adapter와 `TERRAIN_SAFETY_*` error mapping을 갖는다.

## 6. CRS, WGS84 Edge와 Pixel

AOI는 Project의 WGS84 Polygon/MultiPolygon만 허용한다.

- RFC 7946 Cartesian WGS84 edge midpoint를 adaptive subdivision한다.
- midpoint를 DEM CRS로 투영한 값과 projected endpoint midpoint의 편차가 tolerance 이하일 때 종료한다.
- 최대 subdivision depth: 20
- 최대 input coordinates: 20,000
- 최대 projected coordinates: 200,000
- antimeridian edge, projection failure, non-finite/abs >10,000,000 projected coordinate를 거부한다.

```text
projectionToleranceMeters = min(0.01, min(scaleX, scaleY) * 0.01)
boundaryEpsilonMeters = max(1e-8, min(scaleX, scaleY) * 1e-7)

x = tieX + ((column + 0.5) - tieI) * scaleX
y = tieY - ((row    + 0.5) - tieJ) * scaleY
```

- row 0은 최북단이며 row가 증가하면 CRS Y가 감소한다.
- column이 증가하면 CRS X가 증가한다.
- DEM extent와 AOI가 겹치지 않거나 AOI candidate cell이 0이면 `TERRAIN_SAFETY_EMPTY_SELECTION`이다.
- projected point 판정은 hole-first다. Hole boundary/내부를 먼저 제외하고 exterior boundary/내부를 포함한다.
- Polygon ring closure, adjacent duplicate, self-intersection, zero area를 거부한다.
- MultiPolygon component overlap/touch를 거부하고 cell은 최대 한 번만 집계한다.

## 7. Elevation/NoData

- NoData Tag가 있으면 원 Sample과 exact 비교한다.
- NoData Tag가 없으면 어떤 finite 값도 임의로 NoData로 간주하지 않는다.
- NoData는 unknown window를 만들지만 input error는 아니다.
- 모든 non-NoData Sample은 AOI 밖을 포함해 decode 후 전수 검증한다.
- 허용 elevation: `-1,000 <= value <= 10,000` meter.
- non-NoData NaN/Infinity/range violation은 `TERRAIN_SAFETY_SAMPLE_UNSUPPORTED`로 거부한다.
- 유효 non-NoData Sample이 0이면 `TERRAIN_SAFETY_EMPTY_EVALUATION`이다.
- 사용자에게 DEM horizontal/vertical 단위가 meter이며 동일 datum이라는 확인을 요구한다.

## 8. Horn 3×3 Formula

North-up row 규칙:

```text
zNW(row-1,col-1)  zN(row-1,col)  zNE(row-1,col+1)
zW (row,  col-1)  zC(row,  col)  zE (row,  col+1)
zSW(row+1,col-1)  zS(row+1,col)  zSE(row+1,col+1)
```

```text
dzdx = ((zNE + 2*zE + zSE) - (zNW + 2*zW + zSW))
        / (8 * scaleX)

dzdy = ((zSW + 2*zS + zSE) - (zNW + 2*zN + zNE))
        / (8 * scaleY)

slopeDegrees = atan(sqrt(dzdx*dzdx + dzdy*dzdy)) * 180 / PI
```

- slope 크기만 사용하므로 north/south gradient 부호는 slope 결과를 바꾸지 않지만 synthetic 방향 fixture로 row 규칙을 검증한다.
- 중앙 Cell의 8-neighbor가 모두 DEM 내부이며 non-NoData일 때만 evaluated다.
- Border Cell과 하나라도 NoData인 3×3 window는 unknown이다. Edge replication은 금지한다.
- Pixel center가 AOI에 포함된 중앙 Cell만 candidate다.

## 9. Safety Classification와 Numeric Contract

입력:

```text
warningThresholdDegrees: default 15, finite, 0.1 <= warning < 89
dangerThresholdDegrees:  default 30, finite, warning < danger <= 89
```

raw binary64 slope 값으로 반올림 전에 분류한다.

```text
safe:    slope < warning
warning: warning <= slope < danger
danger:  slope >= danger
unknown: selected candidate이나 3x3 계산 불가
```

집계 불변식:

```text
aoiCandidateCells = evaluatedCells + unknownCells
evaluatedCells = safeCells + warningCells + dangerCells
cellAreaSquareMeters = scaleX * scaleY
safeAreaSquareMeters = safeCells * cellAreaSquareMeters
warningAreaSquareMeters = warningCells * cellAreaSquareMeters
dangerAreaSquareMeters = dangerCells * cellAreaSquareMeters
unknownAreaSquareMeters = unknownCells * cellAreaSquareMeters
```

- min/max/meanSlopeDegrees는 evaluated Cell만 대상이다.
- evaluatedCells가 0이면 `TERRAIN_SAFETY_EMPTY_EVALUATION`로 거부하고 NaN/null Summary를 만들지 않는다.
- 계산은 row-major 고정, ECMAScript IEEE-754 binary64를 사용한다.
- mean slope 합계는 Kahan summation을 사용한다.
- 면적은 floating accumulation이 아니라 integer count × exact cell area로 계산한다.
- finite/range/invariant/overflow를 검사한다.
- Golden fixture tolerance는 analytic slope/mean `1e-10 degree`, area `1e-8 m²`다.

## 10. Exact Result DTO

Layer 고정 구조:

```text
type: "geojson"
source: { type: "geojson" }
geojson: FeatureCollection with exactly one AOI Polygon/MultiPolygon Feature
feature.properties: {}
metadata.customLayerType: "terrain-slope-safety"
metadata.excludeFromHistory: true
metadata.terrainSafetyAnalysis: exact summary below
```

Summary exact allowlist:

```text
schema: "geoim3d-terrain-slope-safety-v1"
sourceFormat: "GeoTIFF DEM"
sourceCrs: "EPSG:5179" | "EPSG:5186"
verticalDatumPolicy: "user-confirmed-same-meter-datum-v1"
method: "horn-3x3-pixel-center-v1"
warningThresholdDegrees
dangerThresholdDegrees
cellAreaSquareMeters
aoiCandidateCells
evaluatedCells
unknownCells
safeCells
warningCells
dangerCells
safeAreaSquareMeters
warningAreaSquareMeters
dangerAreaSquareMeters
unknownAreaSquareMeters
minSlopeDegrees
maxSlopeDegrees
meanSlopeDegrees
```

모든 foreign key, 누락 key, wrong type/value/range/invariant는 local reopen에서도 거부한다.
Canonical local `.geoim3d.json` Save/Open만 허용한다.

저장 금지:

- DEM bytes/path/filename/URL
- per-cell elevation/slope/class
- NoData value, raw TIFF metadata/tag/strip
- raw error/stack, credential/provider/network data

## 11. Private-content Detection와 Consumer Matrix

중앙 detector가 다음을 단독 또는 조합으로 인식한다.

- key `terrainSafetyAnalysis`
- `customLayerType === "terrain-slope-safety"`
- schema/method exact marker
- `safeCells + warningCells + dangerCells + unknownCells + meanSlopeDegrees` key 조합
- 위 payload의 nested relocation, array, discriminator stripping 및 JSON string

허용:

- local MapLibre/Cesium render
- canonical local Save/Open
- live in-memory Layer

차단:

- remote/URL/Share/HTTP Recent/Web ingress
- Share/Embed/Collaboration/Story Map/HTML
- Export/Print/Screenshot/Clipboard/clone/duplicate/backup
- AI/Notebook/Script/Plugin public API/SQL/Statistics/Processing
- autosave/recovery/session restore/browser storage/cache/service worker

모든 Project ingress API는 `source: "local" | "remote"`를 필수로 받는다.
Guard는 payload 구성 전과 실제 전송/직렬화 직전에 적용한다.

Layer Apply 시 `excludeFromHistory: true`를 고정하고 기존 history를 clear한다.
Core history partialize, add/delete/mutation, undo/redo, failed Apply, repeated run에서 7D1 snapshot 복제는 0이어야 한다.

## 12. Error Allowlist

```text
TERRAIN_SAFETY_PICK_CANCELLED
TERRAIN_SAFETY_FILE_INVALID
TERRAIN_SAFETY_FILE_TOO_LARGE
TERRAIN_SAFETY_FILE_READ_FAILED
TERRAIN_SAFETY_TIFF_INVALID
TERRAIN_SAFETY_SAMPLE_UNSUPPORTED
TERRAIN_SAFETY_TRANSFORM_UNSUPPORTED
TERRAIN_SAFETY_CRS_UNSUPPORTED
TERRAIN_SAFETY_BOUNDARY_INVALID
TERRAIN_SAFETY_VERTICAL_DATUM_UNCONFIRMED
TERRAIN_SAFETY_NUMERIC_INVALID
TERRAIN_SAFETY_LIMIT_EXCEEDED
TERRAIN_SAFETY_EMPTY_SELECTION
TERRAIN_SAFETY_EMPTY_EVALUATION
TERRAIN_SAFETY_TIMEOUT
TERRAIN_SAFETY_CANCELLED
TERRAIN_SAFETY_PROJECT_INVALID
TERRAIN_SAFETY_PRIVATE_CONTENT_BLOCKED
```

UI/Worker/Native 경계는 이 code만 전달하며 raw Error/OS Error/Stack을 저장·출력하지 않는다.

## 13. Worker Memory와 Lifecycle

MiB는 `2^20` bytes다. 모든 항목을 동시 peak로 보수적으로 합산한다.

| Allocation | Maximum | Lifetime |
| --- | ---: | --- |
| transferred input ArrayBuffer | 48 MiB | decode 시작부터 Worker 종료 |
| decoded elevation band | 20 MiB | decode 완료부터 Worker 종료 |
| conservative strip/parser allowance | 8 MiB | direct strip decode는 별도 strip payload copy를 만들지 않음 |
| Horn scalar/result work | 1 MiB | decoded elevation band 직접 접근; full slope raster 금지 |
| projected AOI/metadata/result | 8 MiB | projection부터 response 생성 |
| parser/runtime reserve | 32 MiB | Worker lifetime |
| **design peak** | **117 MiB** | hard limit 아래 |
| explicit headroom | 11 MiB | runtime overhead |
| **hard budget** | **128 MiB** | 초과 시 거부 |

Worker timeout은 60 seconds다. Native Picker interaction에는 적용하지 않고 Worker 생성 시점부터 적용한다.
Input transfer 후 Renderer ArrayBuffer는 detached여야 한다.
Worker는 전체 decoded elevation band에서 3×3 neighborhood를 직접 읽되, 별도 full slope output raster를 만들지 않고 scalar accumulator만 사용한다.

Lifecycle state:

```text
idle -> native-picking -> worker-running -> terminal -> quiescent
```

Cancel/Close/Unmount/Timeout/Worker error/repeated run/stale completion 각각에서:

- Promise는 정확히 한 번 settle
- 실제 `Worker.terminate()`
- timer/listener/pending reject/worker reference 제거
- generation invalidation으로 stale result 폐기
- Buffer 참조 해제
- Project/dirty/history 불변

Native command completion이 stale이면 Worker를 만들지 않는다. Native Picker Cancel은 정상 terminal path다.

## 14. Network/Build/Artifact Gates

Desktop feature 실행 중 network request는 0이다.

- source에는 URL/endpoint/fetch/http registration이 없어야 한다.
- Desktop runtime은 feature 시작부터 quiescent까지 request instrumentation 0을 증명한다.
- Web/PWA clean build는 별도 output directory에서 먼저 만들고 즉시 scan한다.
- Tauri build는 다른 output directory를 사용해 Web evidence를 덮어쓰지 않는다.
- Web/PWA 및 non-Windows Tauri에서 Dialog/Worker/algorithm/native command/execution chunk 0을 검증한다.
- 단, remote project fail-closed를 위해 `project-private-content` guard chunk의 exact schema/method detector marker는 Web/PWA에도 반드시 남아야 하며 실행 기능으로 분류하지 않는다.

동일 exact-stage source hash에서 다음을 생성·기록한다.

1. Pure geospatial/numerical test
2. Native Windows command/adversarial test
3. Worker lifecycle test
4. Web/PWA zero-path build/scan
5. non-Windows Tauri compile/registration boundary
6. Windows Debug no-bundle
7. Release EXE, MSI, NSIS, Portable
8. Worker/license/resource 포함 scan
9. Windows Picker→Worker→Preview→Apply→Save→Exit→Open
10. artifact checksums와 staged source hash reconciliation

WSL Build/Browser Smoke는 Windows-native evidence를 대체하지 않는다.
Public Release와 signed MSIX는 Phase 8 승인 전 보류한다.

## 15. Acceptance Tests

### Geospatial/Numerical

- [x] constant plane 0° 및 east/west/north/south analytic plane
- [x] Horn 각 coefficient, row 방향, non-square resolution
- [x] RFC7946 adaptive projected edge densification tolerance/depth/count
- [x] Pixel center/exterior/hole/epsilon/MultiPolygon no-double-count
- [x] PixelIsPoint/transform/GCP/RPC/unsupported TIFF 거부
- [x] NoData exact, edge/neighbor unknown, 전체 invalid sample 거부
- [x] threshold exact/전후 classification
- [x] evaluated/unknown/class/area/statistics invariant
- [x] zero candidate와 zero evaluated 고정 오류
- [x] row-major/Kahan repeat 및 cross-worker tolerance
- [x] exact maximum과 +1 resource/ledger rejection

### Security/Privacy

- [x] Native picker-in-command; arbitrary Path command/argument 부재
- [x] fixed DTO/summary allowlist와 foreign-field local reopen rejection
- [x] path/file/DEM/pixel/NoData/raw metadata/error/credential 저장 0
- [x] nested/partial/discriminator-stripped/serialized detection
- [x] all ingress source mandatory; remote/repacked payload rejection
- [x] 모든 public/generic consumer fail-closed, local render/save/open만 허용
- [x] history/recovery/storage/cache snapshot 0
- [x] Desktop feature runtime network request 0

### Windows/Worker/Build

- [x] dedicated command/error identity와 `#[cfg(target_os = "windows")]`
- [x] Web/PWA와 non-Windows Tauri artifact zero-path
- [x] 48 MiB max+1/reparse/path replace/truncate/growth
- [x] parser pre-materialization metadata/strip/SubIFD bounds
- [x] Cancel/Close/Unmount/Timeout/error/repeat/stale lifecycle matrix
- [x] EPSG:5179/5186 Native Picker→Worker→Preview→Apply
- [x] Save→Exit→Open invariant
- [x] exact-stage Debug/Release/MSI/NSIS/Portable worker/license/checksum
- [x] Console/Page Error 0, temp/worker/listener/process cleanup 0

## 16. Implementation Evidence

- Frontend full suite: **3006 total / 3005 pass / 0 fail / 1 intentional skip**.
- 7D1 + Story Map targeted suite: **38/38 pass**.
- TypeScript, Brand, targeted ESLint: **pass**.
- Full ESLint: **0 errors / 21 pre-existing hook warnings**.
- Windows-native Rust: **57/57 pass**.
- Clean Web/PWA and Linux Tauri builds: **pass**; execution marker **0**, bounded `project-private-content` guard only.
- Windows Debug no-bundle, Release EXE, MSI, NSIS, Portable ZIP: **generated successfully**.
- Windows Release Native Picker runtime: EPSG:5179 and EPSG:5186 each **Picker → Worker → Preview pass**, external egress **0**, console/page error **0**.
- Canonical local flow: **Apply → Save As → Exit → Open pass**; saved DTO has two layers, exact private-layer key/summary allowlist, and prohibited path/file/DEM/pixel/NoData/error/credential fields **0**.
- NSIS: isolated silent install → renderer/project restore → uninstall **pass**, install directory/uninstall registry residue **0**.
- Portable: extract → renderer/project restore **pass**, geoIM3D file-association registry creation **0**.
- MSI package was built and checksummed; install smoke was not elevated and correctly rolled back with Windows Installer `Error 1925` (administrator privilege required). Public release/signing remains Phase 8 hold.

Artifact SHA-256:

```text
58fb3a6d4c8659088361dc027e6e4e37ebb229e5cda836b5f9bb0c4ec5825630  debug/geolibre-desktop.exe
dde9cde04abd7fecbc5ee40ab3e2b33f6cb9ecb0a72ad7d81fb1d8b9cf95691b  release/geolibre-desktop.exe
cc7e1d31823e91f93b668af3fa4d6f8ef0c2aa7500de85123e1d98e7b18404ad  geoIM3D_1.0.0_x64_en-US.msi
0713a5f1518eb3a7aea1ef3e3ab542e84d3d4e7ba0893ec6e77366d4a9a73cbe  geoIM3D_1.0.0_x64-setup.exe
fd46970988480641411ce8597083528e7161108ef1025f06bf6eb781e57b9d68  geoIM3D-1.0.0-x64-portable.zip
```

## 17. Stop Gate

Geospatial/Numerical, Security/Privacy, Windows/Tauri Acceptance가 승인된 뒤 RED Test와 구현을 시작한다.
동일 exact-stage 구현이 세 관점 APPROVE일 때만 Commit/Push한다. 7D2는 7D1 완료 후 별도 Acceptance로 시작한다.
