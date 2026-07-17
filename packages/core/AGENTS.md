# geoIM3D Core Directives

이 파일은 `packages/core` 아래 작업에 적용된다.

- `@geolibre/core` Package 이름은 유지한다.
- Zustand Store와 Project Schema의 기존 책임을 유지한다.
- Brand Config가 Domain State에 섞이지 않도록 한다. Project에 필요한 제품 Metadata만 명시적으로 추가한다.
- `.geoim3d.json`은 사용자 파일 확장자이며 내부 Schema를 무조건 전면 Rename하는 근거가 아니다.
- Project Schema 변경 시 Version, Migration, Round-trip, Malformed Input Test를 추가한다.
- 기존 GeoLibre Plugin API가 읽는 Layer/Style/Plugin 구조를 깨지 않는다.
- API Key, AI Key, VWorld Key를 Project State 또는 Serialization 대상에 넣지 않는다.
- Feature Profile의 영속 여부와 UI-only 여부를 분리한다.
- `store.ts`, `types.ts`, `project.ts`를 더 비대하게 만들기보다 Slice/Normalizer/Migration 모듈을 분리한다.

필수 검증:

```bash
npm run test:frontend:coverage
npm run build
```
