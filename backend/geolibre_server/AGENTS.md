# geoIM3D Python Sidecar Directives

이 파일은 `backend/geolibre_server` 아래 작업에 적용된다.

- Sidecar는 `127.0.0.1` Loopback 경계를 유지한다.
- `GEOLIBRE_SIDECAR_TOKEN`, Trusted Host, CORS, Conversion Root 제한을 약화하지 않는다.
- API Key, DSN Password, 로컬 경로의 민감정보를 오류 응답이나 로그에 노출하지 않는다.
- VWorld와 AI Credential의 영속 저장을 Sidecar에 추가하지 않는다.
- 요청 크기, 파일 수, Feature 수, Raster 크기 제한을 유지하거나 더 엄격하게 한다.
- Path Traversal, Symlink Escape, SSRF, Archive Traversal Test를 유지한다.
- Optional Engine이 없을 때 명확한 Status와 안전한 Fallback을 제공한다.
- Backend 변경 시 `test` Extra가 설치된 전체 Suite를 기준으로 검증한다.

필수 검증:

```bash
python -m pytest backend/geolibre_server/tests --cov=geolibre_server --cov-report=term-missing --cov-fail-under=55
```
