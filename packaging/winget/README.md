# geoIM3D Winget status

geoIM3D에는 현재 승인된 Winget Package Identifier나 공개 Manifest가 없습니다.
Upstream `OpenGeos.GeoLibre` Identity는 geoIM3D 제품에 사용하지 않습니다.

공식 Winget 배포를 추가하려면 Phase 8에서 다음을 먼저 확정해야 합니다.

1. JBT 소유 Package Identifier
2. Code-signed NSIS Installer URL 및 SHA-256
3. Publisher/Display name/License Metadata
4. Clean Windows 설치·실행·앱 내부 `.geoim3d.json` Open·제거 검증
5. Independent Release Review 승인

그 전에는 Winget 제출 Workflow를 두지 않으며 이
Directory에 제출 가능한 Manifest를 두지 않습니다.
