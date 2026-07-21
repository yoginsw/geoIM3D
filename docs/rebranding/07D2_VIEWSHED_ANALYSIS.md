# Phase 7D2 Bounded Viewshed Analysis — Acceptance

Status: ACCEPTANCE REVIEW v4
Date: 2026-07-20
Product: geoIM3D 1.0.0
Branch: `feat/geoim3d-viewshed-analysis`
Base: Phase 7D1 commit `843305a349fc84e2d198a29a0d8aa1f949298e26`

## 1. 목적과 범위

7D2는 Windows Tauri Desktop 전용 Local DEM 기반 **가시권 screening MVP**다.
법적·군사적·측량 설계 판정이나 대기 굴절 모델이 아니며, 승인된 Raster cell-column LOS 모델의 결정론적 결과만 제공한다.

입력:

- Native Picker로 사용자가 직접 선택한 Local DEM GeoTIFF
- Project의 WGS84 Polygon/MultiPolygon AOI 1개
- 사용자가 지도에서 지정하거나 WGS84 좌표로 입력한 Observer 1점
- Observer height above ground와 Target height above ground
- 최대 분석 반경

출력:

- visible / occluded / unknown cell count와 면적
- visible percentage와 분석 반경 Summary
- WGS84 AOI, Observer 및 bounded visible-cell run geometry
- Local canonical `.geoim3d.json`에서만 복원 가능한 private result layer

범위 밖:

- Earth curvature/refraction, Fresnel zone, vegetation/building DSM 분리
- multiple observer, cumulative viewshed, radio propagation
- remote URL/COG/cloud DEM, network CRS lookup
- raw per-cell Raster/Grid Export
- Screenshot/Clipboard/Print/HTML/Story Map/Share/Embed/Collaboration/AI/Plugin 전달

## 2. Platform과 Compile Boundary

- Windows Tauri Desktop에서만 실행한다.
- Vite의 `TAURI_ENV_PLATFORM === "windows"` 기반 `__WINDOWS_TAURI_BUILD__`로 Menu, Dialog, lazy import, Worker URL, decoder adapter를 gating한다.
- Rust module/command registration은 `#[cfg(target_os = "windows")]`로 제한한다.
- Web/PWA와 Linux/macOS Tauri artifact에는 7D2 label, Dialog, Worker, algorithm, decoder adapter, native command 및 실행 chunk가 없어야 한다.
- Remote private-project fail-closed detector marker는 Web/non-Windows guard chunk에 남아야 한다.
- `__TAURI_BUILD__`만으로 실행 기능을 노출하지 않는다.

## 3. Native Picker-only Input

고정 command:

```text
pick_and_read_viewshed_geotiff
```

고정 public 오류 allowlist:

```text
VIEWSHED_CANCELLED
VIEWSHED_FILE_TOO_LARGE
VIEWSHED_FILE_UNSUPPORTED
VIEWSHED_FILE_CHANGED
VIEWSHED_FILE_UNREADABLE
VIEWSHED_TIFF_INVALID
VIEWSHED_CRS_UNSUPPORTED
VIEWSHED_TRANSFORM_UNSUPPORTED
VIEWSHED_SAMPLE_UNSUPPORTED
VIEWSHED_BOUNDARY_INVALID
VIEWSHED_OBSERVER_INVALID
VIEWSHED_PARAMETER_INVALID
VIEWSHED_LIMIT_EXCEEDED
VIEWSHED_RESULT_TOO_COMPLEX
VIEWSHED_EMPTY_SELECTION
VIEWSHED_EMPTY_EVALUATION
VIEWSHED_NUMERIC_INVALID
VIEWSHED_TIMEOUT
VIEWSHED_PROJECT_INVALID
VIEWSHED_INTERNAL
```

Native→IPC adapter→Worker→UI는 위 code를 그대로 보존한다. Unknown OS/parser/Worker error는 값·길이·path·stack 없이 `VIEWSHED_INTERNAL`로만 축약한다. 7D2 public boundary에서 `TERRAIN_SAFETY_*`, `EARTHWORK_*` 또는 다른 feature code를 전달하지 않는다.

| Code suffix (all values are prefixed `VIEWSHED_`) | Fixed meaning                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CANCELLED`                                       | Native Picker `None` 또는 명시적 UI cancel/close/unmount; 정상 terminal control |
| `FILE_TOO_LARGE`                                  | initial size, accumulated max+1, final size가 48 MiB 초과                       |
| `FILE_UNSUPPORTED`                                | extension/magic/non-regular/zero-byte unsupported input                         |
| `FILE_CHANGED`                                    | growth/truncate/replacement/deletion/identity/short-read mismatch               |
| `FILE_UNREADABLE`                                 | open/metadata/read/locked failure의 value-free mapping                          |
| `TIFF_INVALID`                                    | malformed Classic TIFF/IFD/UTF-8/strip contract                                 |
| `CRS_UNSUPPORTED`                                 | EPSG/PixelIsArea contract failure                                               |
| `TRANSFORM_UNSUPPORTED`                           | scale/tiepoint/rotation/GCP/RPC/projection failure                              |
| `SAMPLE_UNSUPPORTED`                              | compression/band/type/NoData/scale-offset failure                               |
| `BOUNDARY_INVALID`                                | AOI geometry/topology/antimeridian/coordinate failure                           |
| `OBSERVER_INVALID`                                | Observer AOI/DEM/boundary/NoData failure                                        |
| `PARAMETER_INVALID`                               | height/radius numeric/range failure                                             |
| `LIMIT_EXCEEDED`                                  | pre-allocation parser/pixel/DDA/memory/count limit                              |
| `RESULT_TOO_COMPLEX`                              | run/coordinate/GeometryCollection/JSON output limit                             |
| `EMPTY_SELECTION` / `EMPTY_EVALUATION`            | candidate/evaluated count zero                                                  |
| `NUMERIC_INVALID`                                 | finite/range/invariant/algorithm failure                                        |
| `TIMEOUT`                                         | Worker operational 60-second timeout                                            |
| `PROJECT_INVALID`                                 | local canonical DTO/ingress/egress failure                                      |
| `INTERNAL`                                        | 모든 unknown implementation error fallback                                      |

Stale generation completion은 Project에 적용하지 않고 이미 종료된 handle을 다시 settle하지 않는다. Raw error object/message는 code mapping 전에 폐기한다.

- Renderer가 Path/Filename을 command 인자로 전달하지 않는다.
- Native command 내부에서 `.tif`/`.tiff` Picker를 연다.
- Path는 command 내부에서만 transient하게 사용한다.
- Renderer에는 raw binary IPC `ArrayBuffer`만 반환한다.
- Path, Filename, raw OS error, metadata, identity 및 stack을 Renderer/log/Project에 반환하지 않는다.
- Native Picker는 강제 abort할 수 없으므로 Cancel/Close/Unmount 시 generation을 무효화하고 늦은 bytes를 폐기한다.
- Worker timeout은 Picker 완료 후 Worker 생성 시점부터 시작한다.

Windows read:

- `FILE_FLAG_OPEN_REPARSE_POINT`
- 모든 reparse object 거부
- same-handle streaming `max + 1` read
- initial/final volume serial + file index + size 비교
- pathname identity-only reopen으로 replacement 확인
- growth/truncate/replacement/reparse/oversize를 stable value-free error로 거부
- directory/device/pipe 등 non-regular file을 거부
- 실제 누적 read bytes, initial size 및 final same-handle size가 모두 일치해야 한다.
- zero-byte/short-read/metadata failure/locked/deleted path는 allowlist code로만 매핑한다.

Native input maximum:

```text
48 * 2^20 bytes
```

7D1 public command/error/adapter identity를 7D2에 재사용하지 않는다. 공통화가 필요하면 외부 export가 없는 private bounded-file/TIFF primitive만 공유하고, 각 feature adapter가 자체 command/error/schema를 유지한다.

Native race test는 production reader core와 동일한 `read_bounded_after_metadata(path, hook)` internal flow를 사용한다. Hook은 initial same-handle metadata 확인 직후 한 번 실행하며 `#[cfg(test)]`에서만 주입 가능하다. Windows-native test는 hook으로 growth, truncate, pathname replacement, deletion 및 reparse replacement를 결정론적으로 만들고 각각 `VIEWSHED_FILE_CHANGED` 또는 고정 file error를 검증한다. Exact 48 MiB와 +1, directory/non-regular, zero-byte, short-read, metadata failure도 실제 Windows test executable에서 실행한다.

Contract test는 7D2 adapter/Worker/UI artifact에 7D1 command 문자열과 `TERRAIN_SAFETY_*`/`EARTHWORK_*`가 없고, shared primitive가 frontend/public barrel/Rust public command로 export되지 않음을 검증한다.

## 4. 승인 DEM Contract

7D1과 동일한 strict Classic TIFF subset만 허용한다.

- Classic TIFF, single image/IFD, single band
- strip, uncompressed
- UInt8/16/32, Int8/16/32, Float32/64
- EPSG:5179 또는 EPSG:5186
- PixelIsArea
- axis-aligned north-up
- ModelPixelScale + 단일 ModelTiepoint
- optional exact NoData scalar

거부:

- BigTIFF, Tile, LZW/Deflate/JPEG/PackBits
- Palette/ColorMap, ExtraSamples, multiple bands
- SubIFD, overview/mask, linked next IFD, non-zero NewSubfileType, OldSubfileType
- PixelIsPoint, ModelTransformation, rotation/shear, GCP/RPC
- unknown/private CRS, network CRS lookup
- scale/offset metadata

Preflight:

```text
maximum IFD entries:       256
maximum metadata bytes:    1 * 2^20
maximum strip entries:     100,000
maximum single strip:      8 * 2^20 bytes
maximum width/height:      10,000 / 10,000
maximum decoded pixels:    min(5,000,000, floor((20 * 2^20) / bytesPerSample))
maximum decoded band:      20 * 2^20 bytes
```

Tag type/count/offset/range, duplicate Tag, linked IFD, expected strip count, partial final strip, strip byte count와 overlap을 allocation 전에 검증한다. Deferred 배열과 UTF-8 metadata는 materialization 전 field byte/count를 제한하고 materialization 후 실제 count/byte length를 다시 검증한다. `loadValue`, `String`, `Array.from`, typed-array allocation/copy 직전에 descriptor count×typeBytes를 safe-integer checked하고 per-field/aggregate metadata/strip/peak ledger reservation을 통과해야 한다. Exact limit은 허용하고 +1은 materialization 전에 거부한다. `geotiff.js readRasters()`는 사용하지 않는다.

NoData metadata scalar는 finite이며 sample type으로 lossless representable해야 한다. NaN/±Infinity NoData는 거부한다. Integer는 exact integer, Float32는 `Math.fround(metadataValue) === metadataValue`, Float64는 binary64 finite를 요구한다. Decode 후 `-0`은 `+0`으로 canonicalize하고 numeric `===`로 NoData를 비교한다. Raw NaN sample은 NoData로 취급하지 않고 invalid sample로 거부한다.

모든 non-NoData elevation을 AOI 밖까지 전수 검증한다.

```text
-1,000m <= elevation <= 10,000m
```

## 5. CRS, AOI와 Observer

AOI:

- Project의 WGS84 Polygon/MultiPolygon만 허용한다.
- RFC 7946 Cartesian edge를 DEM CRS로 adaptive midpoint densification한다.
- projected midpoint deviation tolerance:
  `min(0.01m, min(scaleX, scaleY) * 0.01)`
- max input coordinates 20,000
- max projected coordinates 200,000
- max subdivision depth 20
- antimeridian edge, self-intersection, degenerate ring, invalid hole을 거부한다.
- hole-first precedence를 사용한다.
- MultiPolygon component overlap/touch를 거부한다.
- AOI가 DEM과 부분 교차하는 것은 허용한다.
- WGS84 input number는 먼저 `-0 → +0`, `-180 → +180`으로 canonicalize하고 그 외 decimal rounding/wrap은 하지 않는다.
- 각 ring에서 canonical numeric equality로 연속 중복 vertex를 제거하고 trailing closure vertex를 모두 제거한다. 3개 이상의 unique vertex와 non-zero area를 검증한 뒤 정확히 한 closure vertex를 추가한다. 비연속 중복/self-touch는 invalid다.
- Closure된 ring에서 binary64 Kahan shoelace signed area를 계산해 exterior는 CCW, hole은 CW로 맞춘다. 반전 시 closure를 제거하고 unique sequence를 reverse한 뒤 다시 닫는다.
- Orientation 후 closure를 제외한 cyclic sequence를 `[longitude,latitude]` lexicographic 비교해 가장 작은 rotation으로 돌린다. 동일 최소 vertex가 여러 개면 전체 cyclic sequence가 lexicographically smallest인 rotation을 선택한다.
- Hole은 canonical coordinate sequence로 정렬하고 Polygon은 exterior+sorted holes key로 정렬한다. MultiPolygon component도 canonical Polygon key로 정렬한다.
- 후보 point-in-polygon은 이 canonical ring을 densify한 **DEM projected CRS XY**에서 수행한다. Boundary는 exact orientation/on-segment predicate로 제외하고 hole을 exterior보다 먼저 검사한다. WGS84에서 별도 containment를 수행하지 않는다.
- EPSG:5179/5186 변환은 7D1과 동일한 repository-owned fixed Transverse Mercator 구현과 x/y axis order를 사용하며 network/runtime registry를 사용하지 않는다.
- projection 실패, non-finite 또는 projected coordinate abs `> 10,000,000m`를 거부한다.

Observer:

- WGS84 longitude `[-180, 180]`, latitude `[-90, 90]`, finite만 허용한다.
- DEM CRS로 투영한 절댓값은 `10,000,000m` 이하여야 한다.
- Observer는 AOI exterior 내부이며 hole/boundary 밖이어야 한다.
- Observer는 DEM extent 내부의 정확히 한 PixelIsArea cell에 속해야 한다.
- Observer cell elevation이 NoData이면 거부한다.
- AOI boundary와 Observer 좌표는 입력 precision을 보존하며 암묵적 decimal rounding을 하지 않는다.

Pixel transform:

```text
centerX(c) = tieX + ((c + 0.5) - tieI) * scaleX
centerY(r) = tieY - ((r + 0.5) - tieJ) * scaleY

observerColumn = floor(tieI + (observerX - tieX) / scaleX)
observerRow    = floor(tieJ + (tieY - observerY) / scaleY)
```

Raster boundary의 exact east/south edge는 half-open extent 밖으로 처리한다.
`scaleX`와 `scaleY`는 finite positive `[0.01, 100]m`여야 한다. `tieI/tieJ/tieX/tieY`는 finite이고 tiepoint 및 모든 derived center/boundary coordinate abs는 `10,000,000m` 이하여야 한다. Raster extent는 `[west,east) × (south,north]`로 고정한다.

## 6. User Parameters

```text
observerHeightMeters: 0.1 .. 100.0
 targetHeightMeters:  0.0 .. 100.0
 maximumRadiusMeters: max(scaleX, scaleY) .. 10,000.0
```

기본값:

```text
observerHeightMeters = 1.7
 targetHeightMeters  = 0.0
 maximumRadiusMeters = 5,000.0
```

반경은 DEM projected CRS의 center-to-center 2D Euclidean distance `sqrt(dx² + dy²)`다. Geodesic/scale-factor correction을 적용하지 않는다. 비교 순서는 `distanceSquared <= radiusSquared`이고 epsilon을 사용하지 않는다. `max(scaleX, scaleY) > 10,000`이면 parameter range가 성립하지 않으므로 `VIEWSHED_PARAMETER_INVALID`다.

UI에서는 meter 단위를 명시한다. 저장 Summary에는 validated binary64 값만 포함한다. NaN, Infinity, 음수, 범위 초과, locale-dependent parse를 거부한다.

## 7. Deterministic LOS Model

Raster cell은 PixelIsArea footprint 전체에서 해당 sample elevation을 갖는 수평 terrain column으로 해석한다.

후보 Target:

- row-major 순서로 scan한다.
- Pixel center가 AOI 내부(hole/boundary 제외)이고 Observer로부터 projected horizontal distance가 radius 이하인 cell만 후보이다.
- exact radius boundary는 포함한다.
- DEM edge/부분 교차는 허용한다.
- 후보가 0이면 `VIEWSHED_EMPTY_SELECTION`이다.

Observer eye:

```text
observerEyeZ = observerCellElevation + observerHeightMeters
```

Target top:

```text
targetTopZ = targetCellElevation + targetHeightMeters
```

각 Target에 대해 projected **cell center-to-cell center** segment를 2D Amanatides-Woo DDA로 traversal한다. Observer의 실제 point는 observer cell 선택에만 사용하고 ray origin은 observer cell center다.

- Observer cell과 Target cell은 blocker 검사에서 제외한다.
- epsilon을 사용하지 않는다. `dx === 0`이면 x step은 0이고 `tMaxX=tDeltaX=+Infinity`; y도 동일하다. Observer/Target center는 cell boundary가 아니므로 initial/final boundary ambiguity가 없다.
- non-zero x에서 `stepX=sign(dx)`, `tDeltaX=scaleX/abs(dx)`, `tMaxX=(nextVerticalBoundaryX-x0)/dx`다. y는 north-up row 방향을 반영한 next horizontal boundary로 같은 방식으로 계산한다. 현재 cell의 `tEnter`는 이전 crossing(초기 0), `tExit=min(tMaxX,tMaxY,1)`이다.
- `tMaxX < tMaxY`이면 x cell, `tMaxY < tMaxX`이면 y cell로 진행한다. `tMaxX === tMaxY`이면 diagonal cell로 한 번 진행한다.
- exact corner에서 orthogonal side cell은 segment와 positive-length intersection이 없으므로 blocker/NoData/visit 대상에서 제외한다. Method는 geometric supercover가 아니라 **positive-interval DDA**다.
- 각 visited cell은 `(row,column)` key로 최대 한 번만 검사한다. 순서는 DDA 진행 순서이며 Observer/Target cell은 제외한다.
- 중간 cell마다 segment가 footprint에 존재하는 `[tEnter, tExit]`를 binary64로 계산한다.
- `0 <= tEnter < tExit <= 1`인 positive-length interval만 검사한다. DDA budget counter는 검사 직전에 1 증가하며 exact maximum은 허용하고 다음 increment는 계산 전에 거부한다.
- LOS 높이가 상승 또는 수평이면 terrain column과 가장 불리한 비교점은 `tEnter`다.
- LOS 높이가 하강하면 가장 불리한 비교점은 `tExit`다.
- `terrainElevation >= losHeight(tWorst)`이면 blocked다. Exact tangent는 visible이 아니다.
- traversal한 positive-length 중간 cell 또는 Target cell이 NoData면 해당 Target은 unknown이다. Zero-length corner-touch side cell의 NoData는 무관하다.
- DDA는 blocker를 발견해도 Target까지 계속 진행한다. Positive-length 경로에 NoData가 하나라도 있으면 unknown이 blocked보다 우선하고, NoData가 없을 때만 blocker 존재 여부로 occluded/visible을 정한다.
- Observer cell NoData는 분석 전체 오류다.
- Target이 Observer cell과 같으면 visible이다.
- Earth curvature/refraction은 적용하지 않으며 UI/summary에서 planar screening임을 표시한다.

Target classification pseudocode:

```text
candidateCells를 증가
if target sample is NoData:
  unknownCells를 증가; DDA counter 변화 없음; continue
if target is observer cell:
  visibleCells를 증가; DDA counter 변화 없음; continue
targetTopZ 계산
positive-interval DDA 전체 traversal
if any intermediate NoData: unknown
else if any blocker: occluded
else: visible
```

`candidateCells`는 AOI projected containment와 radius를 모두 통과한 selected target cell 수이며 Observer cell과 Target NoData도 포함한다. Full raster scan visit는 decoded-pixel bound로 제한하며 candidate limit에 포함하지 않는다. Candidate 판정 직후, 결과/DDA mutation 전에 next count를 safe-integer 계산한다. `<=250,000`은 허용하고 `250,001`번째 selected cell은 counter/result를 변경하지 않고 전체 분석을 `VIEWSHED_LIMIT_EXCEEDED`로 폐기한다. 실패 시 partial summary/geometry를 반환하지 않는다.

결정론:

- row-major candidate order
- fixed DDA tie handling
- raw binary64 비교 후 display rounding
- visible/occluded/unknown count와 area는 integer count에서 계산
- percentage는 `visible / (visible + occluded) * 100`; evaluated가 0이면 `VIEWSHED_EMPTY_EVALUATION`
- 반복 실행에서 count/geometry/summary JSON이 byte-stable해야 한다.

## 8. Result Geometry

분석 중에는 bounded `Uint8Array` visibility state를 Worker 내부에 유지할 수 있다.
Raw state/raster는 Renderer Project API에 공개하지 않는다.

Visible cell을 각 row의 contiguous horizontal run으로 압축한다.

- 각 run은 DEM CRS PixelIsArea rectangle이다.
- rectangle edge를 WGS84로 inverse-project할 때 adaptive midpoint densification을 적용한다.
- result geometry는 FeatureCollection 안의 고정 순서다.
  1. exact normalized AOI Polygon/MultiPolygon, properties `{}`
  2. Observer Point, properties `{}`
  3. visible run Polygon들을 담는 GeometryCollection, properties `{}`
- occluded/unknown cell geometry는 저장하지 않고 summary count/area만 저장한다.
- cell-center classification과 full-cell footprint 표현임을 UI에서 명시한다.

Output bounds:

```text
maximum visible runs:          20,000
maximum output coordinates:   200,000
maximum output JSON bytes:     8 * 2^20
maximum GeometryCollection:    20,000 Polygon members
```

초과 시 단순화하거나 일부만 저장하지 않고 `VIEWSHED_RESULT_TOO_COMPLEX`로 fail-closed한다.

Canonical output:

- visible run은 row-major, 각 row에서 west→east 순서로 생성한다.
- GeometryCollection member 순서는 run 생성 순서와 동일하다.
- 각 rectangle ring은 WGS84 inverse-projected CCW, 첫 vertex는 projected north-west corner이며 `NW → SW → SE → NE → NW` 순서다.
- inverse edge subdivision은 `NW→SW`, `SW→SE`, `SE→NE`, `NE→NW` edge 순서의 depth-first left-before-right midpoint recursion, section 5와 동일 tolerance/depth를 사용한다.
- projection은 repository-owned fixed EPSG:5179/5186 implementation을 사용하고 non-finite/abs limit failure는 전체 분석을 거부한다.
- 모든 output `-0`은 `+0`으로 canonicalize한다. Decimal rounding은 하지 않는다.
- Object key insertion order와 Feature/geometry/ring/coordinate order를 builder에서 고정하고 number token은 ECMAScript `String(finiteNumber)`를 사용한다. Canonical two-pass UTF-8 token walker 외 serializer는 사용하지 않는다.
- 동일 normalized input bytes와 parameters의 summary/geometry JSON은 byte-identical이어야 한다.

## 9. Summary와 Invariants

고정 identity:

```text
customLayerType = viewshed-analysis
schema          = geoim3d-viewshed-v1
method          = grid-positive-interval-dda-los-v1
model           = planar-cell-column
areaModel       = selected-full-cell-footprint
```

Summary allowlist:

```text
schema
method
model
areaModel
sourceCrs
observerHeightMeters
targetHeightMeters
maximumRadiusMeters
cellAreaSquareMeters
candidateCells
visibleCells
occludedCells
unknownCells
evaluatedCells
visibleAreaSquareMeters
occludedAreaSquareMeters
unknownAreaSquareMeters
visiblePercentage
visibleRunCount
visibleRunLengths
```

모든 면적은 AOI-clipped 면적이 아니라 **AOI 내부에 center가 있는 selected full raster-cell footprint의 합**이다. 따라서 visible footprint가 AOI exterior 밖으로 최대 half-cell 연장되는 것은 정상이다. UI와 persisted `areaModel` 모두 이 의미를 표시한다.

Invariants:

```text
candidateCells = visibleCells + occludedCells + unknownCells
evaluatedCells = visibleCells + occludedCells
visibleArea = visibleCells * cellArea
occludedArea = occludedCells * cellArea
unknownArea = unknownCells * cellArea
visiblePercentage = visibleCells / evaluatedCells * 100
visibleRunCount = GeometryCollection.geometries.length
visibleRunLengths.length = visibleRunCount
sum(visibleRunLengths) = visibleCells
```

`visibleRunLengths`는 row-major run별 positive safe integer array이며 maximum 20,000 entries다. 모든 scalar/array 값은 finite이고 정수/범위를 exact 검증한다. foreign field는 거부한다. Reopen은 저장된 DEM 없이 geometry provenance를 재계산하지 않지만, canonical Worker output에서만 layer를 만들고 run/member/count/area/percentage invariant를 모두 재검증한다.

Project/Renderer/UI/Error/Log에는 다음을 저장·표시하지 않는다.

```text
DEM path
DEM filename
raw DEM bytes
pixel/elevation arrays
NoData value
strip offsets/counts
raw TIFF/GDAL metadata
raw native/parser error
stack
credential
```

## 10. Worker와 Memory Budget

Dedicated module Worker를 사용하고 input `ArrayBuffer` ownership을 transfer한다.

```text
Phase A decode: input 48 + decoded band 20 + strip/parser 8 + runtime 16       = 92 MiB
Phase B analyse: decoded 20 + visibility 5 + AOI/DDA/result 7 + runtime 16    = 48 MiB
Phase C Worker IPC: visibility 5 + geometry 10 + structured clone 10 + runtime 16 = 41 MiB
Phase D renderer save: canonical geometry/state 20 + UTF-8 output 8 + scratch 1 + runtime 32 = 61 MiB
Phase E local open: UTF-8 bytes 8 + decoded string 16 + parsed/canonical object 20 + runtime 32 = 76 MiB
-------------------------------------------------------------------------------------
design peak per phase                                                        = 92 MiB
headroom                                                                      = 36 MiB
hard incremental feature budget                                               = 128 MiB
```

Hard budget는 각 phase에서 이 feature가 동시에 추가 보유한 ArrayBuffer/typed-array/string/number-array/object-estimate byte의 보수적 합이며 Process RSS limit이 아니다. Phase 전환 전에 이전 phase의 raw input/parser/decoded/visibility 참조를 명시적으로 해제한다. Input ownership은 한 번 transfer하며 Worker 내부 input copy를 금지한다. 각 allocation 직전 safe-integer checked reservation을 수행하고 hard/per-allocation limit을 넘으면 allocation 전에 `VIEWSHED_LIMIT_EXCEEDED`다.

Viewshed canonical Local Save는 `JSON.stringify`와 full JS string을 사용하지 않는다. Fixed key/order canonical DTO를 동일 token walker로 두 번 순회한다.

1. **Measure pass:** object/array delimiter, fixed JSON key/string literal, boolean, null 및 ECMAScript `String(finiteNumber)` token을 순서대로 UTF-8 byte count한다. 문자열 escaping은 JSON RFC escaping을 적용한다. Token은 최대 256-byte scratch buffer 단위로 encode하며 전체 문자열을 만들지 않는다. Safe-integer counter가 `8 * 2^20`을 넘는 즉시 `VIEWSHED_LIMIT_EXCEEDED`다.
2. **Write pass:** exact measured byte length의 `Uint8Array`를 한 번만 allocation하고 동일 walker가 동일 token을 직접 채운다. 마지막 offset이 measured length와 다르면 `VIEWSHED_INTERNAL`로 폐기한다.
3. Native/project file writer는 이 UTF-8 `Uint8Array`를 binary write하고 중간 JS string/JSON clone을 만들지 않는다. Open은 bounded 8 MiB bytes를 UTF-8 fatal decode 후 strict JSON parse/canonical reconstruction한다.

Token walker의 입력 문자열은 fixed schema/method/model/areaModel/sourceCrs/layer label/key와 validated geometry 숫자뿐이며 arbitrary feature properties/name/metadata는 없다. `coordinatePositions` 같은 추정 변수를 사용하지 않으므로 Measure pass 결과가 실제 Write pass와 exact 동일하다. Measure와 Write의 token trace hash도 test seam에서 비교한다. Exact 8 MiB는 output allocation/write를 허용하고 8 MiB+1 fixture는 output `Uint8Array` allocation 및 native writer call-count가 모두 0임을 증명한다. Structured clone 10 MiB는 Phase C에 별도 포함한다.

Algorithm work budget:

```text
maximum candidate cells:        250,000
maximum DDA visited cells:   50,000,000
Worker timeout:                  60 sec
```

Budget 초과는 `VIEWSHED_LIMIT_EXCEEDED` 또는 `VIEWSHED_TIMEOUT`으로 종료한다. DDA visited-cell budget만 numerical deterministic budget이며 candidate scan은 별도 `candidateCells` counter로 제한한다. 60초 timeout은 hardware-dependent operational safety limit으로 numerical byte-stability 계약과 분리한다.

Promise와 cancel handle을 먼저 만들고 nullable Worker reference를 둔 뒤 Worker factory를 `try` 안에서 호출한다. Worker constructor, listener/timer 설치, schedule, postMessage, decode, algorithm, normalize 및 cleanup의 모든 synchronous throw를 동일 reject-and-quiesce path로 보낸다. Constructor 이전 실패에도 Promise는 한 번 reject되고, 생성된 Worker가 있으면 listener/timer를 제거한 뒤 `terminate()`를 한 번 시도한다. `clearSchedule()`/`terminate()` throw는 settlement를 방해하지 않는다. Worker factory, scheduler, clear hook 및 port는 unit-test injection seam으로 제공하되 production export에는 노출하지 않는다.

Cancel/Close/Unmount/Timeout/error/repeated run/stale completion마다:

- Promise exactly once settlement
- timer/listener 제거
- `Worker.terminate()` exactly once 시도
- generation invalidation
- transferred/output 참조 해제
- Project/dirty/history 불변

## 11. UI Flow

```text
처리 → geoIM3D → 가시권 분석
```

1. WGS84 Polygon/MultiPolygon AOI 선택
2. Observer map-pick 또는 longitude/latitude 입력
3. Observer/Target height와 radius 입력
4. planar screening 및 local-only privacy 고지 확인
5. `DEM 선택 및 계산`
6. Native Picker → Worker
7. Summary와 visible-cell preview
8. 명시적 `결과 Layer 추가`

- Native Picker cancel은 정상 terminal path다.
- 계산 전 Project mutation 0이다.
- Apply 전 preview는 memory-only다.
- Apply 후 private result layer에 `excludeFromHistory: true`를 설정하고 history를 clear한다.
- repeated Apply는 unique layer ID를 사용한다.
- close/unmount가 stale result를 적용하지 않는다.

## 12. Canonical Local Persistence

Local Windows `.geoim3d.json` Save/Open만 허용한다.

- incoming layer를 spread하여 저장하지 않는다.
- exact FeatureCollection/Geometry/Summary/Style allowlist로 canonical layer를 재구성한다.
- runtime transient `beforeId: undefined`만 input에서 허용하고 output에서 제거한다.
- 실제 값이 있는 `beforeId`, foreign style/source/metadata/feature/property를 거부한다.
- result geometry와 summary의 count/run/invariant를 상호 검증한다.
- remote/Web/non-Windows ingress에서는 viewshed private payload를 fail-closed한다.
- 모든 project ingress API는 default 없는 module-private opaque `IngressContext` object를 받는다. Module은 `WeakMap<IngressContext, {route, source, used}>`를 보유하며 context object 자체에는 caller-readable/settable source/route field를 두지 않는다. 일반 caller가 object literal/string/cast로 만든 context는 map lookup에 실패한다.
- Fixed route/source mapping:

```text
LOCAL_OPEN              -> local
LOCAL_RECENT            -> local
LOCAL_STARTUP_ARGUMENT  -> local
LOCAL_DRAG_DROP         -> local
REMOTE_URL              -> remote
REMOTE_HTTP_RECENT      -> remote
REMOTE_DEEP_LINK        -> remote
REMOTE_SHARE            -> remote
REMOTE_EMBED            -> remote
REMOTE_COLLABORATION    -> remote
OS_ASSOCIATION          -> unsupported; context 발급 금지
```

- 각 route wrapper는 자신의 private factory closure로 context를 생성하고 sanitizer를 같은 call stack에서 직접 호출한다. Context/factory를 return/export/parameter로 노출하지 않는다.
- Sanitizer는 WeakMap metadata가 wrapper의 compile-time expected route/source와 exact 일치하고 `used=false`인지 검사한 뒤 호출 시작 시 `used=true`로 소비한다. Cross-route/source 재사용, 두 번째 사용, caller-provided route/source 조합은 거부한다.
- URL/HTTP/Deep Link/Share/Embed/Collaboration wrapper는 remote mapping을 변경할 option을 받지 않는다. OS association은 등록하지 않고 entry 자체를 거부한다.
- Contract test는 forged object, local→remote 및 remote→local cross-route, 같은 source의 다른 route, replay, route/source metadata tampering과 위 10개 route를 각각 검증한다.
- autosave/recovery/session restore/browser cache는 canonical project file이 아니므로 viewshed payload를 저장·복원하지 않는다.
- local Save 직전 egress sanitizer로 memory-state tampering을 다시 검증한다.
- generic vector embed/materialization에 viewshed layer를 전달하지 않는다.
- Canonical viewshed layer object의 top-level field `excludeFromHistory`는 required literal boolean `true`이며 Local Save/Open allowlist에 포함한다. Missing/false/non-boolean은 `VIEWSHED_PROJECT_INVALID`다.
- 이 field는 보안 경계가 아닌 UI/history 보조 신호다. History/undo/redo/autosave/recovery/session serializer는 field만 제거해 downgrade하지 않고 viewshed layer 전체 serialization을 central detector로 거부한다.
- Marker/geometry detector는 `excludeFromHistory`가 제거·false·변조돼도 동일 payload를 탐지해야 한다. Local round-trip은 exact `true` 보존, tampering matrix는 missing/false/string/relocation과 history serializer 직접 호출을 검증한다.

## 13. Private-content Detection과 External Consumer Matrix

중앙 bounded recursive detector는 다음을 각각 탐지한다.

- `viewshedAnalysis` container key
- `customLayerType = viewshed-analysis`
- exact schema/method/model/areaModel tuple
- discriminator가 제거된 exact summary key signature
- marker가 전부 제거돼도 `FeatureCollection`의 고정 3-feature 구조: Polygon/MultiPolygon AOI + Point Observer + Polygon-only GeometryCollection, 모든 properties `{}`
- nested object/array relocation
- bounded JSON-string wrapping

Identity key set은 `{customLayerType,schema,method,model,areaModel}`이다. Summary payload signature는 다음 key의 **subtree-wide union**이다.

```text
sourceCrs, observerHeightMeters, targetHeightMeters, maximumRadiusMeters,
cellAreaSquareMeters, candidateCells, visibleCells, occludedCells, unknownCells,
evaluatedCells, visibleAreaSquareMeters, occludedAreaSquareMeters,
unknownAreaSquareMeters, visiblePercentage, visibleRunCount, visibleRunLengths
```

Detector는 한 object뿐 아니라 bounded subtree에서 split/reordered/array-wrapped key union을 계산한다. Signal precedence와 expected result는 다음과 같다.

```text
A. identity key가 1개 이상 존재                         => PRIVATE
B. canonical/variant 3-feature geometry signature 존재    => PRIVATE
C. high-signal summary key가 1개 이상 존재                => PRIVATE
D. low-signal summary key가 2개 이상 존재                 => PRIVATE
E. identity/geometry 없이 low-signal key 0~1개만 존재      => NOT ATTRIBUTABLE
```

High-signal set은 `{observerHeightMeters,targetHeightMeters,maximumRadiusMeters,occludedCells,unknownCells,visiblePercentage,visibleRunCount,visibleRunLengths}`다. Low-signal set은 나머지 payload signature key다. Value type/value 변조, foreign field, nesting 또는 relocation은 key signal을 제거하지 않는다. Rule E는 standalone generic object의 false positive를 피하기 위한 유일한 예외다. Canonical viewshed payload에서 Rule E DTO로 변환하는 것은 source layer를 generic builder에 넘기기 전 caller guard와 builder final guard가 원본 identity/geometry를 먼저 검사하므로 허용되지 않는다.

Adversarial expected matrix:

| Mutation                                                                | Expected                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 5 identity key의 모든 `2^5-1` removal, summary/geometry 유지            | PRIVATE                                                                            |
| identity/geometry 제거 후 full summary                                  | PRIVATE                                                                            |
| identity/geometry 제거 후 summary key one-at-a-time removal/replacement | PRIVATE (high key 또는 ≥2 low key 유지)                                            |
| summary key split/reorder/array/JSON wrapping                           | subtree union rule에 따라 PRIVATE                                                  |
| identity+summary 제거, geometry 유지/foreign field 추가                 | PRIVATE                                                                            |
| geometry+summary 제거, identity 1개 유지                                | PRIVATE                                                                            |
| identity+geometry 제거, high key 1개만 유지                             | PRIVATE                                                                            |
| identity+geometry 제거, low key 2개 유지                                | PRIVATE                                                                            |
| identity+geometry 제거, low key 0~1개만 standalone 입력                 | NOT ATTRIBUTABLE; canonical-source downgrade path는 pre-transform guard에서 REJECT |

Canonical 3-feature detector는 feature order/type을 확인하되 foreign feature/object field 또는 non-empty properties를 추가한 malformed variant도 탐지하고 local canonical validator가 거부한다.

어느 한 private 신호라도 존재하지만 canonical tuple/geometry가 불완전하면 downgrade로 간주해 local ingress도 `VIEWSHED_PROJECT_INVALID`, external transfer는 fail-closed한다. Canonical viewshed builder 외부에서 AOI/Observer/visible geometry를 plain generic GeoJSON으로 추출·복제하는 API를 제공하지 않는다. Generic builder/serializer는 caller guard뿐 아니라 최종 입력에서 geometry-only signature를 다시 검사한다.

Detector limit:

```text
maximum recursion depth:          12
maximum visited nodes:        10,000
maximum total string UTF-8: 1 * 2^20 bytes
maximum JSON-like parse attempts: 32
maximum one wrapped JSON UTF-8: 1 * 2^20 bytes
```

Cycle은 visited identity set으로 한 번만 센다. JSON-like (`{`/`[`) string이 malformed, oversized 또는 parse-attempt limit을 넘으면 local canonical load는 project invalid, external transfer는 private/unsafe로 fail-closed한다. Stable error 외 raw parse text를 반환하지 않는다.

다음 경로는 viewshed content가 있으면 fail-closed한다.

```text
Local file/Open/Recent path/Startup Argument/Drag-drop ingress
Remote URL/HTTP Recent/Deep Link/Share/Embed/Collaboration ingress
OS association ingress (unsupported/rejected)
Share/Gallery upload
Embed bridge/postMessage
Collaboration snapshot/sync/background sync
Story Map builder/panel
Standalone HTML
Print/PDF
Screenshot/Clipboard capture flow
clone/duplicate/backup/autosave/recovery/session restore/native recent snapshot
AI/Assistant
Notebook/Script/SQL
Plugin public map/data API
Statistics/Processing generic tools
Telemetry/diagnostics/crash report
Browser local/session storage/IndexedDB/cache/service worker
Direct `serializeProject`/`JSON.stringify` and inline HTML/JS serializers
```

Guard matrix:

| Boundary                                                 | Caller guard                                  | Final guard                                                     |
| -------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Local canonical Open/Recent/startup/drop                 | trusted wrapper-issued local `IngressContext` | capability+route validation, strict canonical reconstruction    |
| Remote/URL/HTTP/deep-link/Embed/Collaboration ingress    | wrapper-fixed remote `IngressContext`         | capability+route validation, central private detector rejection |
| Save/Save As                                             | local-only command/UI                         | pre-serialization canonical egress sanitizer                    |
| Share/Embed/Collaboration/background sync                | UI/bridge guard                               | immediately before send/postMessage/serialization               |
| Story Map/HTML/Print/PDF/Screenshot/Clipboard            | panel/filter guard                            | generic builder input guard                                     |
| AI/Notebook/Script/SQL/Plugin/Statistics/Processing      | tool selection guard                          | public API/data adapter guard                                   |
| clone/duplicate/backup/autosave/recovery/session restore | operation guard                               | serializer/storage guard; private payload forbidden             |
| telemetry/diagnostics/crash                              | collection disabled                           | payload sanitizer rejects coordinates/summary/raw errors        |
| browser storage/cache/service worker                     | registration/storage guard                    | private payload write rejected                                  |

UI filter만으로 승인하지 않는다. 모든 generic builder/transport/serializer는 직접 호출 adversarial test를 가지며 최종 serialization/send 직전에 central guard를 다시 실행한다.

## 14. Artifact and Target-runtime Gates

Web/PWA와 Linux/non-Windows Tauri는 각각 Repository 밖의 clean 별도 output directory에 build하고 다음 marker를 filename과 모든 text asset에서 재귀 scan한다.

```text
가시권 분석
ViewshedAnalysisDialog
viewshed-analysis.worker
viewshed-geotiff
pick_and_read_viewshed_geotiff
VIEWSHED_
grid-positive-interval-dda-los-v1
onOpenViewshed / showViewshed 및 feature-named callback/prop
viewshed feature chunk filename
```

허용 예외는 exact `project-private-content` guard chunk 안의 schema/method/model/areaModel detector marker뿐이다. Web build는 target env를 명시적으로 제거하고 build 직후 즉시 scan한다. Non-Windows Tauri scan은 별도 output을 사용한다. Windows artifact에는 Dialog/Worker/decoder/native marker와 worker chunk가 모두 있어야 한다.

Fake Worker lifecycle unit test와 별도로 실제 optimized **bundled module Worker** smoke를 수행한다. Production Worker URL로 load하고, raw `ArrayBuffer` transfer 후 sender detachment, success response, malformed input error, timeout/cancel/terminate, stale response 무적용을 Browser와 Windows Tauri WebView에서 확인한다. Native Picker→raw IPC `ArrayBuffer`→동일 bundled Worker 경로를 실제 Windows에서 실행한다.

Final evidence record:

- exact staged diff SHA-256와 Git tree/commit candidate
- 실행 command, target OS, capture type
- Web/Linux/Windows Debug/Release build output 경로
- Debug EXE, Release EXE, MSI, NSIS, Portable SHA-256
- Native Picker→Worker→Preview→Apply→Save As 실제 파일 생성→Exit→Open
- NSIS install/run/open/uninstall, Portable extract/run/open, registry/file-association residue
- MSI는 unsigned/installability/admin 결과를 NSIS와 별도 분류
- console/page/native error, external network request, worker/process/listener/temp cleanup count

WSL build/browser smoke는 Windows-native Tauri evidence를 대체하지 않는다. Public signed release는 Phase 8 전까지 보류한다.

## 15. Tests와 Runtime Evidence

### Geospatial/Numerical

- [x] flat DEM, ridge blocker, valley, ascending/descending LOS
- [x] exact tangent blocked, ±epsilon, exact radius 포함/+epsilon 제외
- [x] horizontal/vertical/diagonal/corner positive-interval DDA, zero-axis Infinity, no-epsilon tie
- [x] observer/target same cell
- [x] PixelIsArea center/boundary/east-south half-open
- [x] EPSG:5179/5186 axis order
- [x] adaptive AOI/output edge projection
- [x] hole/boundary/MultiPolygon/partial DEM
- [x] Observer outside AOI/DEM, Observer NoData
- [x] target/intermediate NoData unknown
- [x] Target NoData pre-DDA, unknown > blocked > visible precedence
- [x] all-elevation validation, count/area/percentage invariants
- [x] repeat byte-stability
- [x] equivalent ring rotation/winding/closure/duplicate/-0/-180 canonical byte identity
- [x] candidate exact 250,000/+1 and no partial result
- [x] sample-type별 decoded pixel, candidate/DDA/run/coordinate/JSON/executable-memory exact maximum와 +1
- [x] strict TIFF rejection/adversarial matrix

### Security/Privacy

- [x] picker-in-command, renderer Path argument 0
- [x] path/file/raw DEM/pixel/NoData/metadata/error/credential persistence 0
- [x] strict canonical local save/reopen and foreign-field rejection
- [x] nested/repacked/serialized marker detection
- [x] all-marker-stripped geometry-only downgrade detection
- [x] route/source-bound single-use ingress context across all fixed routes; forged/cross-route/replay rejection
- [x] all 31 identity-removal combinations and subtree-wide summary signature matrix
- [x] two-pass canonical UTF-8 token trace identity; exact 8 MiB/+1 with output allocation/native writer call-count 0 on rejection
- [x] top-level `excludeFromHistory: true` round-trip and missing/false/relocated tampering
- [x] exact public error allowlist and cross-feature identity negative tests
- [x] every remote/public/generic consumer fail-closed
- [x] history/recovery/storage/cache snapshot 0
- [x] feature runtime external network request 0

### Windows/Worker/Build

- [x] 48 MiB exact/+1, reparse/replacement/growth/truncate
- [x] Worker success/cancel/close/unmount/timeout/error/postMessage/schedule/clear/stale matrix
- [x] Worker constructor/listener/timer/terminate synchronous throw matrix
- [x] optimized bundled module Worker load/transfer-detach/terminate smoke
- [x] Web/PWA and non-Windows artifact execution marker 0
- [x] Windows EPSG:5179/5186 Picker→Worker→Preview→Apply
- [x] Apply→Save As→Exit→Open geometry/summary invariant
- [x] Debug/Release/MSI/NSIS/Portable generation and checksums
- [x] Release/NSIS/Portable runtime and cleanup
- [x] Console/Page Error 0, Viewshed feature external request 0

### 15.1 Final Implementation Evidence — 2026-07-21

검증 대상은 `feat/geoim3d-viewshed-analysis`의 staged source/test/docs 76개 파일이다. 이 절의 문서 갱신을 포함한 최종 exact-stage hash와 tree는 Section 16의 독립 Review 직전에 다시 고정한다.

Quality Gate:

- Frontend full coverage command: exit 0, 3,039 tests(3,038 passed, 1 skipped), coverage threshold 통과. All-files Lines 81.52%, Branches 82.17%, Functions 70.35%.
- Backend Repository venv: 257 passed, 16 skipped, Coverage 64.19%, `--cov-fail-under=55` 통과.
- Worker TypeScript 3개, ESLint error 0/기존 warning 21, TypeScript typecheck, Brand Guard, production build 통과.
- Playwright full E2E: 28 passed. Web/PWA VWorld 및 Windows-private analysis exclusion 포함.
- Windows native Rust full suite: 69 passed. Windows Credential Manager round-trip 포함.

Target Artifact Gate:

- Web/PWA clean output 708 files scan: 금지 marker 0.
- Linux/non-Windows Tauri clean output 722 files scan: 금지 marker 0.
- Windows Tauri clean output 747 files: Dialog, native command, strict decoder, DDA method와 optimized worker chunk 존재.
- Optimized module Worker `viewshed-analysis.worker-C1t6myG5.js`: transferable sender `ArrayBuffer` detached, candidate 4 success, malformed TIFF `VIEWSHED_TIFF_INVALID`, terminate lifecycle 통과.
- Windows debug EXE SHA-256: `b84931909330f1aa9928f69270b451e788a6703cc2e87a1b04dd3c1ae2ab01bd`.
- Windows release/Portable EXE SHA-256: `1be2297d80b472acc2d44a177d21d35a4a1b595da0166c15baf182747ff97130`.
- MSI SHA-256: `797bcb22ba8895e49cb684b3d273d13a38d74e463269057f75d457eaa139ac85`.
- NSIS SHA-256: `c0284a9a4915537b97f0974e0cf16e8c74e7e31b33eaac4182981b0591bfd9ce`.

Windows Native Runtime:

- EPSG:5186 Native Picker → raw bytes → bundled Worker → Preview → Apply 통과. 2×2 fixture 결과는 가시 4 m², 차폐/미평가 0 m², 가시율 100%였다.
- EPSG:5179도 별도 clean process에서 동일 Native Picker → Worker → Preview → Apply를 통과했고 Map/Cesium과 Layer panel 렌더링을 확인했다. 자동화 focus가 renderer input을 오염시킨 최초 시도는 즉시 폐기하고 process를 종료했으며, clean rerun에서 입력값 `1.7`과 native picker selection을 독립 확인했다.
- blocker 수정 후 재패키징한 EPSG:5186 Release에서도 Native Picker → Worker → Preview → Apply를 반복 통과했다. 결과는 가시 4 m²/100%, input `1.7`, Layer 2개, document `complete`였다.
- 해당 결과를 `viewshed-final-runtime-saved.geoim3d.json`으로 Save As 후 exit/open했다. 3,744 bytes, SHA-256 `d63b43fe40efa1f1ab6be7ead88370d1696eae7320ba873271cf866860bbfc9b`, Polygon/Point/GeometryCollection, empty properties, `excludeFromHistory: true`, summary invariant 보존, DEM path/file/NoData/credential marker 0.
- Release/Portable startup argument open은 window title `geoIM3D Desktop`, `Responding=true`, canonical 결과 Layer 복원으로 통과했다.
- Exact NSIS를 격리 설치한 뒤 canonical startup open을 확인하고 silent uninstall했다. Install directory, process, Uninstall key와 `.geoim3d`/`.geoim3d.json` association residue는 모두 0.
- Unsigned MSI는 일반 사용자 설치와 분리해 administrative extraction으로 분류했고, 추출 EXE의 canonical startup open과 `geoIM3D Desktop` runtime을 통과했다.

Independent Review Remediation:

- 첫 exact-stage Review는 Windows/Tauri/Worker 관점 APPROVE, Geospatial/Numerical 및 Security/Privacy 관점 REJECT였다. 따라서 Commit을 중단하고 기존 review hash를 stale 처리했다.
- AOI hole boundary는 ring tri-state(`inside`/`outside`/`boundary`)와 projected metre `1e-7` tolerance로 exterior/hole boundary를 모두 제외한다. 10 m pixel의 3×3 raster 내부 hole edge cell-center와 exterior exact/`0.5e-7`/`2e-7` threshold regression을 추가했다.
- TIFF parser 호출 전 모든 허용 tag의 type/count를 제한한다. GeoKeyDirectory 64개 초과와 unknown materialized tag를 parser 전에 거부하는 adversarial regression을 추가했다.
- Attribute Table은 draft 적용 후 `exportVectorLayer` 호출 직전에 중앙 `assertNoPrivateAnalysisContent` guard를 실행한다. marker/property를 제거하고 feature 순서를 역전한 geometry-only payload도 Desktop/Core detector가 순서 독립적으로 차단하며 guard ordering을 검증한다.
- 수정 후 Viewshed targeted 27/27, 관련 통합 80/80, full frontend coverage, TypeScript build/lint, optimized module Worker와 Windows Release runtime을 재검증했다.
- blocker-focused 재Review는 Windows/Tauri 관점 APPROVE였으나 Geospatial/Security 관점에서 위 regression 증명과 순서 독립 detector 강화를 요구해 이전 snapshot을 stale 처리했다.
- 이후 exact-commit Security Review에서 일반 Vector Export와 저수준 Binary Vector Writer가 marker-stripped Viewshed geometry를 최종 materialization 직전에 직접 차단하지 않는 우회 경로를 발견해 해당 snapshot을 BLOCK 처리했다. `exportVectorLayer`와 `exportBinaryVectorLayer` 진입점에 중앙 `assertNoPrivateAnalysisContent` guard를 추가했고 GeoJSON/CSV/GeoParquet/GeoPackage/Shapefile 전체 형식 및 직접 Binary Writer 호출의 geometry-only downgrade 거부 regression을 추가했다. 수정 후 Viewshed targeted 28/28, full frontend 3,039 tests, lint/build/Playwright 28/28을 재검증했다.

제한:

- OpenFreeMap basemap의 일반 tile request는 제품 공통 동작이다. Viewshed 기능 자체의 외부 endpoint/request, DEM 또는 결과 egress는 없다.
- MSI/NSIS/MSIX 서명과 Public Release는 Phase 8 승인 전까지 수행하지 않는다. MSI 결과는 unsigned administrative extraction evidence이며 signed installability 주장으로 사용하지 않는다.
- Runtime screenshot, fixture, build log와 extracted output은 `C:\geoim3d-d2-smoke`의 비Commit 임시 증거다.

## 16. Review Gates

Acceptance 승인과 Implementation 승인은 별개다.

1. 이 Acceptance snapshot을 Geospatial/Numerical, Security/Privacy, Windows/Tauri 세 관점에서 독립 검토한다.
2. 세 관점 모두 명시적 APPROVE일 때만 RED Test/구현을 시작한다.
3. 구현 후 exact-stage hash를 고정하고 동일 세 관점에서 다시 검토한다.
4. REJECT/timeout/unknown/stale review에서는 Commit/Push하지 않는다.
5. 사용자 요청 없이 `origin` Push, `fork/main` Merge, PR, Branch 삭제, Default Branch 변경 또는 Public Release를 수행하지 않는다.
6. 7D2 완료 후 3D Scene Project Preset Acceptance로 이동한다.
