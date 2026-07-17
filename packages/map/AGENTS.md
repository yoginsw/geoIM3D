# geoIM3D Map Directives

이 파일은 `packages/map` 아래 작업에 적용된다.

- Store → MapCanvas → MapController → MapLibre/Cesium 단방향 흐름을 유지한다.
- UI 또는 VWorld Plugin이 MapLibre 내부 상태를 직접 영구 변경하지 않도록 한다.
- 기본 시작 View는 3D Globe이나 2D MapLibre와 Multi-map 기능을 유지한다.
- 3D Tiles, I3S, glTF, Gaussian Splat, LiDAR, Terrain 기능의 기존 렌더 경로를 보존한다.
- Brand 문자열과 VWorld API Key를 Map Package에 하드코딩하지 않는다.
- `layer-sync.ts`, `map-controller.ts`, `MapCanvas.tsx`에 새 기능을 직접 누적하기 전에 Adapter 분리를 우선한다.
- Frame 성능, Layer 정리, Event Listener Cleanup, WebGL Context 해제를 검증한다.
- 2D/3D Camera 동기화와 Project Open/Save 회귀 Test를 유지한다.
