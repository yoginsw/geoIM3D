# geoIM3D MSIX packaging (`build-msix.ps1`)

[`build-msix.ps1`](build-msix.ps1)은 완료된 Windows Tauri Release Binary에서
**서명되지 않은 MSIX**를 생성합니다. Binary, 정리된 Python Sidecar, Logo Asset을
Stage한 뒤 Windows SDK의 `MakeAppx.exe`를 실행합니다.

## 용도와 제한

> [!IMPORTANT]
> 생성된 MSIX는 공개 Release 또는 일반 Sideload 설치본이 아닙니다.
> Microsoft Store가 재서명하는 Partner Center 제출 Package의 입력물입니다.

- NSIS Installer와 Portable ZIP도 Phase 8 승인 전에는 공개 게시하지 않습니다.
- MSIX는 `.github/workflows/msix-store.yml`의 Manual Workflow로만 생성합니다.
- Workflow 실행 시 Partner Center의 Package Identity Name과 Publisher ID를 반드시
  입력해야 합니다.
- Artifact 이름은 `geoim3d-store-unsigned-msix`이며 7일 후 삭제됩니다.
- Enterprise Sideload 배포에는 Publisher와 정확히 일치하는 Code-signing Certificate로
  `SignTool.exe` 서명 후 설치·제거·Registry 검증이 필요합니다. 현재 Script는
  의도적으로 서명하지 않습니다.

## Prerequisites

- Windows
- Windows SDK (`MakeAppx.exe`)
- 완료된 `npm run tauri:build -- --no-sign`
- Store 제출 시 승인된 JBT Partner Center Identity

## Local package build

```powershell
pwsh ./packaging/msix/build-msix.ps1 `
  -Name "<Partner Center Package Identity Name>" `
  -Publisher "CN=<Partner Center Publisher ID>" `
  -PublisherDisplayName "JBT" `
  -DisplayName "geoIM3D"
```

기본 표시 Metadata는 다음과 같습니다. `Name`과 `Publisher` 기본값은 개발용이며
Store 제출에는 사용하지 않습니다.

| 항목 | 값 |
|---|---|
| Bundle identifier | `com.ejbt.geoim3d` |
| Product/Display name | `geoIM3D` |
| Product version | `1.0.0` |
| Development publisher | `CN=JBT` |
| Publisher display name | `JBT` |
| Language | `ko-KR` |
| Project format | `.geoim3d.json` (OS association intentionally omitted) |

결과:

```text
apps/geolibre-desktop/src-tauri/target/release/bundle/msix/
  geoIM3D-1.0.0-x64.msix
```

Backend의 `.env*`, Virtual Environment, Test, Cache, Coverage, Build Artifact,
`AGENTS.md`는 Package Stage에서 제거됩니다. geoIM3D에는 In-app Automatic
Updater가 없으며 Store Update는 Store 배포 채널이 담당합니다.
