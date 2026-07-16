# 보안·개인정보 Directive

## Credential 저장

| 환경 | 정책 |
|---|---|
| Windows Desktop | OS Credential Store |
| Web | Session Memory only |
| Project 파일 | 저장 금지 |
| 로그/Diagnostics | 저장 금지 및 Redaction |
| URL/Query String | 사용 금지 |

대상 Credential:

- VWorld API Key
- OpenAI API Key
- Anthropic API Key
- Gemini API Key
- 기타 외부 Service Token

Ollama/로컬 모델 Endpoint는 비밀이 아닐 수 있지만 기존 Credential Policy와 같은 Settings 계층으로 관리한다.

## AI 데이터 전송

허용 Provider:

- OpenAI
- Anthropic
- Gemini
- Ollama/Local Model

지도·도면·BIM 데이터를 외부 AI로 전송할 수 있다. 단, 실행 전에 다음을 명시한다.

- 선택된 Provider
- 전송 데이터 종류와 범위
- 파일 또는 Feature 수/크기
- 외부 전송 여부

사용자 승인 없이 Background에서 업로드하지 않는다.

## Plugin

- 사용자가 ZIP/URL Plugin을 설치할 수 있다.
- 자동 설치·자동 활성화 금지
- 출처, Version, Manifest, Trust 상태 표시
- Plugin 오류와 권한을 App 전체에서 격리
- Credential API는 Plugin에 기본 제공하지 않음

## 수집 금지

- Telemetry
- Crash Report 자동 전송
- 사용 통계
- 사용자 Project/경로/좌표의 외부 분석 전송

## 유지할 보안 경계

- Sidecar Token
- Trusted Host/CORS
- Conversion Root
- Archive/Path Traversal 방어
- Tauri CSP/Capability Allowlist
- HTML Sanitization
- External Plugin Trust Prompt
- AI Code Execution 승인
