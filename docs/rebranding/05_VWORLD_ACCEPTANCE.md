# Phase 5 — VWorld Built-in Plugin Acceptance

기준일: **2026-07-18**
상태: **Sprint 5D 구현·Runtime Gate 완료, Exact Staged Review 대기**
결정: **1차 구현은 Windows Desktop 전용이며 Web/PWA에서는 VWorld 기능을 등록·노출하지 않는다.**

## 1. 목적과 범위

geoIM3D Windows Desktop에 VWorld 2D 지도, 검색, 주소 변환, 지적도·용도지역 조회를 First-party Built-in Plugin으로 추가한다.

초기 구현은 기존 `@geolibre/*` Project Schema와 External Plugin API를 변경하지 않는다. 최종 운영 Transport에서는 VWorld 인증키를 Rust에서만 읽고 VWorld API Command/DTO/MapLibre URL/Project/Public Runtime/로그에 전달하거나 저장하지 않는다. 사용자 최초 입력·교체 시에는 고정 `credential_set` Provisioning Command로 한 번만 전달하고 저장 성공 즉시 Frontend Draft를 폐기한다.

현재 Phase 4 호환 기반에는 `vworldApiKey`를 `VWORLD_API_KEY`로 변환해 Frontend module-private runtime overlay에 주입하는 선행 경로가 있다. Sprint 5A에서 Rust Transport가 Credential Manager를 직접 읽도록 전환할 때 이 Projection을 제거하고, Frontend Runtime에 `VWORLD_API_KEY` 이름과 값이 모두 존재하지 않는 것을 Contract로 검증한다.

Browser 직접 호출은 VWorld가 인증키를 URL Path 또는 Query Parameter에 요구하므로 Root 보안 정책과 양립할 수 없다. 따라서 Web/PWA 지원은 Same-origin Relay가 별도로 승인·설계될 때까지 제외한다.

## 2. 공식 근거와 요구사항 추적

비공식 Blog나 예제는 Contract 근거로 사용하지 않는다.

| 공식 Source                                                                                        |     확인일 | 확인한 Contract                                                    | 적용 요구사항                            |
| -------------------------------------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ | ---------------------------------------- |
| [API Reference](https://www.vworld.kr/dev/v4apiRefer.do)                                           | 2026-07-18 | 지원 API와 Version                                                 | 최신 Version 재확인 Gate                 |
| [검색 API v2.0](https://www.vworld.kr/dev/v4dv_search2_s001.do)                                    | 2026-07-18 | `/req/search`, Parameter, Page, DTO                                | Search Allowlist/Mock Contract           |
| [Geocoder 정지오코딩 v2.0](https://www.vworld.kr/dev/v4dv_geocoderguide2_s001.do)                  | 2026-07-18 | `/req/address`, `GetCoord`, 저장 금지                              | Forward Geocoder Contract/No Persistence |
| [Geocoder 역지오코딩 v2.0](https://www.vworld.kr/dev/v4dv_geocoderguide2_s002.do)                  | 2026-07-18 | `/req/address`, `GetAddress`, `point`/`type`/응답 Field, 저장 금지 | Reverse Geocoder Contract/No Persistence |
| [2D 데이터 API v2.0](https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do)                          | 2026-07-18 | `/req/data`, Service ID, 공간 제한                                 | Data Allowlist/Area Guard                |
| [WMTS](https://www.vworld.kr/dev/v4dv_wmtsguide_s001.do)                                           | 2026-07-18 | Key-in-path URL, Layer/Zoom/Format                                 | Desktop Tile Transport                   |
| [이용약관](https://www.vworld.kr/v4po_prcint_a001.do) 제13조                                       | 2026-07-18 | 호출 제한, 인증키 본인 사용·양도 금지, 결과물 표시                 | Runtime Guard/Attribution                |
| 같은 약관 제14조                                                                                   | 2026-07-18 | 인증키 이용계약 성립·해지, 해지 시 서비스 중지                     | 삭제·해지 Lifecycle                      |
| 같은 약관 제15~16조                                                                                | 2026-07-18 | 개발키 신청과 운영키 신청·심사                                     | Release Stop Gate                        |
| 같은 약관 제17조                                                                                   | 2026-07-18 | 인증키 정보 관리와 도용 방지                                       | Credential 관리                          |
| 같은 약관 제19조                                                                                   | 2026-07-18 | 저작권, 무단 저장 금지, 제3자 권리                                 | No Persistence/Export 제한               |
| [저작권정책](https://www.vworld.kr/v4po_prcint_a006.do)                                            | 2026-07-18 | 공공누리 표시 확인, 구체적 출처표시, 제3자 권리                    | Attribution/Export 제한                  |
| [연속지적도 상세](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=cadastral)            | 2026-07-18 | `LP_PA_CBND_BUBUN`, PNU/Properties, `GetFeature`, 2km² 제한        | Cadastral DTO/Area Guard                 |
| [도시지역 상세](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=uq111&apiVer=2)         | 2026-07-18 | `LT_C_UQ111`, 아래 공통 Field                                      | Service/Property Allowlist               |
| [관리지역 상세](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=uq112&apiVer=2)         | 2026-07-18 | `LT_C_UQ112`, 아래 공통 Field                                      | Service/Property Allowlist               |
| [농림지역 상세](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=uq113&apiVer=2)         | 2026-07-18 | `LT_C_UQ113`, 아래 공통 Field                                      | Service/Property Allowlist               |
| [자연환경보전지역 상세](https://www.vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=uq114&apiVer=2) | 2026-07-18 | `LT_C_UQ114`, 아래 공통 Field                                      | Service/Property Allowlist               |

공식 문서 또는 약관이 변경되면 구현 Contract보다 최신 공식 문서를 우선한다. Source 변경 여부는 Phase 종료와 Release 전에 다시 확인한다.

## 3. API별 고정 Contract

공통 규칙:

- `format=json`, `errorFormat=json`만 허용한다.
- 실제 `key`는 Frontend DTO에 존재하지 않으며 Rust Transport가 Windows Credential Manager에서 읽어 마지막 단계에 추가한다.
- Callback/XML/임의 Endpoint/임의 Operation/임의 Service ID는 허용하지 않는다.
- Rust는 전체 VWorld 응답을 Frontend에 그대로 전달하지 않고 아래 Allowlist DTO로 변환한다.
- 응답 `status`는 `OK`, `NOT_FOUND`, `ERROR`로 분류하고 VWorld 원문 오류·전체 URL은 외부에 전달하지 않는다.

### 3.1 검색 API v2.0

| 구분          | Parameter/Field | Contract                                                                                                       |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| Endpoint      | 고정            | `https://api.vworld.kr/req/search`                                                                             |
| 필수          | `request`       | `search`                                                                                                       |
| 필수          | `query`         | Trim 후 비어 있지 않은 문자열, 길이 상한은 구현 RED Test에서 고정                                              |
| 필수          | `type`          | `PLACE`, `ADDRESS`, `DISTRICT`, `ROAD`                                                                         |
| 조건부        | `category`      | `ADDRESS`: `ROAD`/`PARCEL`; `DISTRICT`: `L1`/`L2`/`L3`/`L4`; `PLACE`: 공식 장소분류코드 Allowlist 확인 후 지원 |
| 선택          | `size`          | 1~1000, 기본 10                                                                                                |
| 선택          | `page`          | 1 이상, 기본 1                                                                                                 |
| 선택          | `bbox`          | `minx,miny,maxx,maxy`, 유한수·순서 검증                                                                        |
| 선택          | `crs`           | 1차 구현 `EPSG:4326`만 허용                                                                                    |
| 응답 Envelope | Allowlist       | `status`, `record`, `page`, `result.type`, `result.items`                                                      |
| 응답 Item     | Allowlist       | `id`, `title`, `category`, `address`, `point` 중 공식 Type별 존재 필드만 DTO로 변환                            |

`service=search`, `version=2.0`, `format=json`, `errorFormat=json`은 Rust가 고정한다.

### 3.2 Geocoder API v2.0

#### 주소 → 좌표

| 구분     | Parameter/Field | Contract                                                  |
| -------- | --------------- | --------------------------------------------------------- |
| Endpoint | 고정            | `https://api.vworld.kr/req/address`                       |
| 필수     | `request`       | `GetCoord`                                                |
| 필수     | `type`          | `ROAD`, `PARCEL`                                          |
| 필수     | `address`       | Trim 후 비어 있지 않은 문자열, 길이 상한 고정             |
| 선택     | `refine`        | Boolean, 기본 `true`                                      |
| 선택     | `simple`        | Boolean, 기본 `false`                                     |
| 선택     | `crs`           | 1차 구현 `EPSG:4326`만 허용                               |
| 응답     | Allowlist       | `status`, 정제 주소의 허용 필드, 결과 `point.x`/`point.y` |

#### 좌표 → 주소

| 구분 | Parameter/Field | Contract                                                               |
| ---- | --------------- | ---------------------------------------------------------------------- |
| 필수 | `request`       | `GetAddress`                                                           |
| 필수 | `point`         | `x,y`, 유한수 및 EPSG:4326 경도·위도 범위 검증                         |
| 선택 | `type`          | `ROAD`, `PARCEL`, `BOTH`(기본)                                         |
| 선택 | `zipcode`       | Boolean, 기본 `true`                                                   |
| 선택 | `simple`        | Boolean, 기본 `false`                                                  |
| 선택 | `crs`           | 1차 구현 `EPSG:4326`만 허용                                            |
| 응답 | Allowlist       | `status`, `result.item[].zipcode/type/text/structure`의 공식 허용 필드 |

공통 고정값은 `service=address`, `version=2.0`, `format=json`, `errorFormat=json`이다.

정·역지오코딩의 제품 합산 상한은 일일 40,000건으로 고정한다. 두 결과 모두 실시간 표시만 허용하고 저장장치·DB·Project에 저장하지 않는다.

### 3.3 WMTS

| 구분                | Contract                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| 공식 URL            | `https://api.vworld.kr/req/wmts/1.0.0/{key}/{layer}/{z}/{y}/{x}.{tileType}` |
| 1차 Layer Allowlist | `Base`, `white`, `midnight`, `Hybrid`, `Satellite`                          |
| Zoom                | `Base`/`Hybrid`/`Satellite`: 6~19, `white`/`midnight`: 6~18                 |
| Format              | `Base`/`white`/`midnight`/`Hybrid`: PNG, `Satellite`: JPEG                  |
| Frontend URL        | `geoim3d-vworld://tile/{layer}/{z}/{x}/{y}` — 실제 Key 없음                 |
| 응답                | Rust가 Layer별 PNG/JPEG signature와 Media Type을 검증한 Byte만 반환         |

일반 국내 `Satellite` 배경지도는 위 기본 WMTS 경로에서 `{layer}=Satellite`, `{tileType}=jpeg`로 요청한다. 제품에서 `Satellite`를 선택하면 동일한 Ephemeral MapLibre controller가 `Satellite` raster를 먼저 추가하고 `Hybrid` raster를 그 위에 추가해 도로·라벨을 함께 표시한다. 두 source/layer는 style reload 시 함께 복원하며 다른 VWorld 지도 선택, Credential 폐기 또는 Plugin 종료 시 함께 제거한다. 해외위성영상은 `Satellite/themes/{category}/{year}/{city}/{tileMatrix}/{tileRow}/{tileCol}.{tileType}`라는 별도 계약이므로 `category`/`year`/`city` 공식 Metadata Allowlist와 운영 이용 범위가 승인되기 전까지 Menu, Layer Allowlist, Command에서 제외한다.

### 3.4 2D 데이터 API v2.0

| 구분     | Parameter/Field | Contract                                                                                     |
| -------- | --------------- | -------------------------------------------------------------------------------------------- |
| Endpoint | 고정            | `https://api.vworld.kr/req/data`                                                             |
| 필수     | `request`       | `GetFeature`만 허용                                                                          |
| 필수     | `data`          | 아래 Service ID Allowlist                                                                    |
| 선택     | `size`          | 1~1000, 기본 10                                                                              |
| 선택     | `page`          | 1 이상, 기본 1                                                                               |
| 조건부   | `geomFilter`    | 공식 POINT/LINESTRING/POLYGON/MULTIPOLYGON/BOX 형식; Polygon/MultiPolygon/Box 면적 2km² 이하 |
| 조건부   | `attrFilter`    | Service별 허용 Field/Operator Builder로만 생성; 임의 문자열 입력 금지                        |
| 선택     | `crs`           | 1차 구현 `EPSG:4326`만 허용                                                                  |
| 응답     | Allowlist       | `status`, `record`, `page`, GeoJSON FeatureCollection의 geometry와 Service별 허용 properties |

고정값은 `service=data`, `version=2.0`, `format=json`, `errorFormat=json`이다.

Service ID Allowlist:

- 연속지적도: `LP_PA_CBND_BUBUN`
  - 단일 필지: 19자리 `pnu`
  - 허용 Properties: `pnu`, `jibun`, `bonbun`, `bubun`, `addr`, `gosi_year`, `gosi_month`, `jiga`
- 도시지역: `LT_C_UQ111`
- 관리지역: `LT_C_UQ112`
- 농림지역: `LT_C_UQ113`
- 자연환경보전지역: `LT_C_UQ114`

4개 용도지역의 공식 상세 Reference가 공통으로 정의한 허용 Properties는 `uname`(용도지역명), `sido_name`(시도명), `sigg_name`(시군구명), `dyear`(고시년도), `dnum`(고시번호)다. `ag_geom`은 Raw Property로 반환하지 않고 공식 GeoJSON `geometry`만 사용한다. 건물 Service ID와 Field Contract는 **공식 Reference에서 추가 확인 필요**이며 확인 전에는 구현하지 않는다.

## 4. Desktop-only Private Transport

### 4.1 플랫폼 범위

| 플랫폼               | 1차 동작                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| Windows Native Tauri | VWorld Plugin/Menu/MapLibre Protocol과 고정 Tauri Command 등록                         |
| Web/PWA              | Plugin/Menu/Protocol/Command Adapter 미등록, VWorld UI 미노출, VWorld Network 요청 0건 |
| 일반 Browser Preview | Web/PWA와 동일. Runtime Test에서 기능 미노출 확인                                      |

단순 CSS 숨김이 아니라 Plugin 등록, Command 실행, Deep Link, Project Restore, Background Hook, Network Path를 모두 차단한다.

### 4.2 요청 흐름

WMTS:

```text
MapLibre Source (key 없음)
  → Desktop에서만 등록한 MapLibre addProtocol("geoim3d-vworld", handler)
  → handler가 invoke("vworld_tile", typed coordinates)
  → Rust가 Fixed Allowlist 검증
  → Rust가 Windows Credential Manager에서 vworld:api-key 읽기
  → Rust가 VWorld HTTPS URL 조립·요청
  → 검증된 PNG/JPEG bytes 반환
```

Search/Geocoder/Data:

```text
Desktop UI (key/URL 없음)
  → fixed Tauri command + typed DTO
  → Rust Endpoint/Operation/Parameter Allowlist
  → Rust Credential Manager read
  → Rust에서만 Query + key 조립
  → Rust Response parse/redaction
  → Allowlist DTO 반환
```

고정 Command 후보:

- `vworld_search`
- `vworld_geocode`
- `vworld_reverse_geocode`
- `vworld_get_features`
- `vworld_tile`
- `vworld_cancel`

Command는 임의 URL, Header, Raw Query, Credential ID, File Path를 입력받지 않는다. Rust는 Raw VWorld Payload를 로그·Diagnostics·Frontend Error에 전달하지 않는다.

### 4.3 Credential·Lifecycle 경계

- Public `@geolibre/core`, `@geolibre/map`, `@geolibre/plugins` API에 Credential Getter/Setter를 추가하지 않는다.
- External Plugin과 동일 WebView 소비자는 Key를 읽거나 Transport에 임의 URL을 전달할 수 없어야 한다.
- Frontend는 `vworld:api-key` 값 자체를 VWorld 운영 Command에 전달하지 않는다.
- Rust Transport가 Windows Credential Manager에서 고정 ID를 직접 읽는다.
- 위 규칙의 유일한 예외는 사용자 입력을 저장하는 기존 고정 `credential_set("vworld:api-key", value)` Provisioning 경로다. 저장 성공 또는 실패 후 Frontend Draft와 Error Context에서 값을 즉시 폐기하고, VWorld 운영 Command에는 절대 재전달하지 않는다.
- `credential_load`는 `vworld:api-key`의 실제 값을 WebView에 반환하지 않고 configured 상태만 반환한다. Settings의 configured mark와 삭제 기능은 값 재조회 없이 이 상태를 사용한다.
- Sprint 5A에서 기존 `vworldApiKey → VWORLD_API_KEY → Frontend private overlay` Projection을 제거한다.
- Project, Public Runtime, Build, Local/Session Storage, IndexedDB, CacheStorage에 Key 또는 Key 포함 URL을 저장하지 않는다.
- Rust HTTP Client는 Disk Cache를 사용하지 않고 Response를 Memory에서만 처리한다.
- 오류는 Value-free Allowlist Code로 변환하며 전체 URL·Query·Key·Raw Body를 포함하지 않는다.
- 개별 삭제, 전체 폐기, Key 교체 시 활성 Layer, MapLibre Protocol Request, Search/Data Request를 취소하고 Consumer를 teardown한다.
- Request ID와 Cancellation Token으로 오래된 Response가 최신 UI를 덮어쓰지 못하게 한다.
- Protocol Handler와 Event Listener는 Deactivate/Unmount에서 제거한다.

## 5. 약관·Attribution·Export 경계

### 5.1 Runtime Attribution

1차 Runtime 표시는 다음 Product Contract로 고정한다.

- 문구: `VWorld 디지털트윈국토`
- 링크: `https://www.vworld.kr/`
- 위치: MapLibre 우하단 기존 Attribution 영역
- 표시 조건: VWorld Base/white/midnight/Hybrid 또는 VWorld Data Layer가 하나 이상 활성 상태일 때 항상 표시
- Layer가 숨김 상태라도 Source/Feature가 화면에 남아 있으면 제거하지 않는다.

이 문구는 최소 Product 표시 계약이다. 약관 제13조의 “운영기관이 별도로 정하는 방법”에 해당하는 정확한 Logo/문구/배치가 별도로 확인되면 Release 전 그 기준으로 교체한다.

### 5.2 저장·Export

- Geocoder/Search/Data 결과는 현재 Session Memory에서만 표시한다.
- 결과를 Project JSON, Recent Metadata, History Snapshot, Browser Storage, Local DB에 넣지 않는다.
- VWorld Tile/Data/Geocoder Export, Offline Download, Bulk Mirror, Print/PDF/StoryMap 포함을 1차 범위에서 차단한다.
- Export 경로를 추가하려면 데이터별 공공누리 유형, 제3자 권리, 운영기관 표시 방법을 확인하고 별도 승인을 받는다.
- 개발키는 개발 검증에만 사용하고 Release 전 운영키 발급·심사와 상업적 이용 허용 근거를 기록한다.
- 3D 공개제한 공간정보 복제·Offline 기능은 Phase 5 범위에서 제외한다.

## 6. 구현 순서 — RED/GREEN

### Sprint 5A — Desktop Transport Contract

RED:

- Web/PWA에서 VWorld Menu/Plugin/Protocol이 등록되지 않고 Network 요청이 0건이다.
- 각 Tauri Command가 임의 URL/Query/Key/Path 입력을 거부한다.
- Key 누락 시 Network 요청 전에 Value-free Error Code를 반환한다.
- `credential_load`가 VWorld 실제 값을 반환하지 않고 configured 상태만 제공하는지 검증한다.
- `credential_set` 저장 후 Draft가 즉시 비워지고 VWorld 운영 Command DTO에 Key Field가 없는지 검증한다.
- Search/Geocoder/Data/WMTS의 Endpoint·Operation·Parameter·Service ID Allowlist를 검증한다.
- Error/Diagnostics에 Key, 전체 URL, Query, Raw Body가 없다.
- Timeout/Abort/HTTP/VWorld 오류가 안정적 Code로 변환된다.
- 삭제·전체 폐기·교체 시 진행 중 Rust 요청과 Frontend Consumer가 취소된다.

GREEN:

- Windows-target Rust Transport와 Fixed Tauri Commands
- DTO/Validator/Error Mapper/Cancellation Registry
- Mock HTTP Contract; 실제 Key 없이 Request Shape 검증

### Sprint 5B — Desktop 2D 지도

RED:

- Project/Map Source에 실제 Key와 VWorld HTTPS URL이 없다.
- Web Build에는 VWorld Protocol/Network Path가 없다.
- Layer/Zoom/Format/Coordinate를 Command 전·Rust에서 이중 검증한다.
- Deactivate/Delete/Clear/Replace에서 Layer/Protocol/Request가 teardown된다.
- Attribution 표시·숨김 조건이 고정된다.

GREEN:

- Desktop-only MapLibre Protocol Handler
- Built-in VWorld Menu와 Layer Lifecycle
- Runtime Attribution

### Sprint 5C — Desktop 검색·주소 변환

RED:

- 표에 정의한 Search/GetCoord/GetAddress Parameter와 DTO만 허용한다.
- Geocoder 결과가 Project/History/Storage/Export로 이동하지 않는다.
- 새 요청이 이전 요청을 취소하고 오래된 결과를 폐기한다.

GREEN:

- Desktop 통합 검색 UI
- 주소 ↔ 좌표 UI
- Memory-only Session Result

### Sprint 5D — Desktop 지적도·용도지역

RED:

- PNU 19자리, Service ID, Property Allowlist를 검증한다.
- 공간 조회 2km²와 Page Size 1~1000을 Command 전·Rust에서 검사한다.
- Raw `attrFilter` 입력과 데이터 Export/영구 Cache가 없다.

GREEN:

- 연속지적도
- 공식 Field Contract가 고정된 용도지역 Layer
- 건물은 공식 Service ID/Field 확인 후 별도 RED Test와 함께 추가

검증(2026-07-18): Phase 5 관련 Frontend Target Test 66/66, Windows MSVC Native Test 38/38, TypeScript/Production Build, Browser Production Web Zero-path, 지적·용도지역 Panel Runtime Harness를 통과했다. Full Tauri Windows Cross-build는 WSL GNU C compiler가 MSVC용 `ring`/`sqlite` Native Library를 생성하지 못해 차단되었으며, 대체 Windows Target Gate로 `cargo xwin check`, Test Build, 생성된 Windows Test EXE Runtime을 통과했다. Phase 5 전체 Stop Gate와 운영키/상업 이용 승인은 별도 미완료 상태다.

## 7. Phase 5 Acceptance

- [ ] 공식 API Reference/약관/저작권정책의 URL·확인일·요구사항 매핑이 최신이다.
- [ ] Web/PWA에서는 VWorld 기능 미노출, Plugin/Protocol 미등록, Network 요청 0건이다.
- [ ] Windows Rust만 `vworld:api-key`를 읽고 Frontend Command/DTO에는 Key가 없다.
- [ ] Provisioning `credential_set`을 제외한 모든 Frontend Command/DTO에 Key Field가 없고, 저장 직후 Draft가 폐기된다.
- [ ] `credential_load`는 VWorld 값 대신 configured 상태만 반환한다.
- [ ] 기존 Frontend `VWORLD_API_KEY` Projection이 제거되고 Runtime 이름·값이 모두 존재하지 않는다.
- [ ] Public Core/Map/Plugin API에 Credential Getter/Setter가 없다.
- [ ] Project/Public Runtime/Build/Storage/Diagnostics에 Key 또는 Key 포함 URL이 없다.
- [ ] Search/Geocoder/WMTS/Data Parameter·DTO·Error Mock Contract가 통과한다.
- [ ] Key 삭제·전체 폐기·교체가 Layer/Protocol/Rust Request/UI Generation을 즉시 teardown한다.
- [ ] Windows Native Tauri에서 2D Layer, 검색, 주소 변환, Data, Attribution을 확인한다.
- [ ] Browser Production에서 VWorld UI 미노출과 Network 요청 0건을 확인한다.
- [ ] Geocoder/Search/Data 결과와 Tile이 영구 저장·Export되지 않는다.
- [ ] Public/Secret Sentinel Production Build와 Staged Gitleaks가 통과한다.
- [ ] Full Frontend/Backend/Worker/Build/E2E/Windows Rust Gate가 통과한다.
- [ ] 독립 Security/Compatibility Review Blocking Finding이 0이다.

## 8. Stop Gate

다음 조건 전에는 Phase 5 완료·Release 가능으로 표시하지 않는다.

1. 용도지역/건물 Service별 Field와 응답 DTO를 공식 상세 Reference로 고정한다.
2. 운영키, 상업적 이용, 정확한 Attribution 표시 방법의 운영기관 근거를 확인한다.
3. Rust Request/Crash/Diagnostics와 WebView Memory에서 Key 또는 Key 포함 URL 잔류가 없는지 Windows Runtime으로 검증한다.
4. Windows Native Tauri에서 Layer/API, 삭제·교체 teardown, Network 오류 Redaction을 검증한다.
5. Browser Production에서 VWorld 코드 경로 미등록과 Network 요청 0건을 검증한다.
6. Exact Staged Index 독립 Review와 Secret Scan을 통과한다.
