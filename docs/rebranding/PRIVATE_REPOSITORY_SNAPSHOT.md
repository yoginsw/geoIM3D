# geoIM3D 비공개 저장소 Snapshot Runbook

> 목적: 승인된 geoIM3D Source를 **기존 Git 이력 없이** 새 비공개 저장소의 최초 Commit으로 이전한다.
>
> 이 문서는 절차만 정의한다. 저장소 생성, Remote 등록, Push는 Repository Owner의 명시적 승인 후 수행한다.

## 1. 필수 원칙

- Snapshot은 승인된 **Commit**에서 `git archive`로 생성한다.
- `.git/`, 기존 Remote, Branch, Tag, Commit History는 복사하지 않는다.
- Working Tree의 미추적 파일, `.env`, Credential, Build Artifact는 포함하지 않는다.
- `LICENSE`, 원본 GeoLibre Attribution, Third-party Notice를 유지한다.
- 내부 `@geolibre/*` Package Namespace와 Plugin API Identifier는 Migration 승인 전 변경하지 않는다.
- Snapshot 생성과 비공개 저장소 Push는 서로 다른 승인 단계로 처리한다.

## 2. 사전 승인 입력값

작업 전에 다음 값을 Ticket 또는 승인 기록에 남긴다.

| 항목 | 예시 | 필수 |
|---|---|---:|
| Source Repository | `https://github.com/opengeos/GeoLibre` | 예 |
| Source Version | `2.1.0` | 예 |
| 승인된 Source Commit | 40자리 Commit SHA | 예 |
| Snapshot 담당자 | 이름 또는 사내 계정 | 예 |
| 비공개 Repository URL | 승인 후 입력 | Push 시 |
| 승인자·승인 시각 | Ticket/전자결재 링크 | Push 시 |

Branch 이름만으로 Snapshot을 만들지 않는다. Branch Head가 바뀌어도 재현 가능하도록 Commit SHA를 사용한다.

3~8절의 Bash 명령은 `SOURCE_REF`, `SNAPSHOT_ROOT`, `SNAPSHOT_DIR` 변수가 유지되는 **동일한 Shell Session**에서 순서대로 실행한다. Session이 끊기면 기존 임시 Snapshot을 재사용하지 말고 3절부터 다시 시작한다.

## 3. Source 상태 확인

Repository Root에서 실행한다.

```bash
set -euo pipefail
cd /home/nurig/projects/GeoLibre

SOURCE_REF="<approved-40-character-commit-sha>"
SOURCE_VERSION="2.1.0"
if ! [[ "$SOURCE_REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "STOP: SOURCE_REF must be a full 40-character commit SHA" >&2
  exit 1
fi
SOURCE_COMMIT="$(git rev-parse --verify "${SOURCE_REF}^{commit}")"
if [ "${SOURCE_COMMIT,,}" != "${SOURCE_REF,,}" ]; then
  echo "STOP: SOURCE_REF did not resolve to the approved commit" >&2
  exit 1
fi
WORKTREE_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
if [ -n "$WORKTREE_STATUS" ]; then
  printf 'STOP: working tree is not clean:\n%s\n' "$WORKTREE_STATUS" >&2
  exit 1
fi
git show --no-patch --format='commit=%H%ncommit_date=%cI%nsubject=%s' "$SOURCE_REF"
```

확인 조건:

- `git rev-parse` 결과가 승인된 Commit과 정확히 일치한다.
- 승인된 변경이 모두 Commit되어 있다.
- Snapshot에 포함할 내용을 Working Tree 수정본에 의존하지 않는다.
- `.gitmodules`가 존재하면 중단한다. `git archive`는 Submodule 내용을 포함하지 않으므로 별도 승인 절차가 필요하다.
- Git LFS Pointer가 존재하면 실제 Object 포함 방법을 별도로 승인받는다.

```bash
if git cat-file -e "${SOURCE_REF}:.gitmodules" 2>/dev/null; then
  echo "STOP: submodule snapshot policy is required" >&2
  exit 1
fi

LFS_FILTERS="$(git grep -n 'filter=lfs' "$SOURCE_REF" -- .gitattributes 2>/dev/null || true)"
if [ -n "$LFS_FILTERS" ]; then
  printf 'STOP: Git LFS snapshot policy is required:\n%s\n' "$LFS_FILTERS" >&2
  exit 1
fi
```

## 4. Source Gate 실행

승인된 Commit을 Checkout한 Clean Worktree에서 실행한다.

```bash
npm ci
npm run check:brand
npm run lint
npm run build
npm run test:frontend:coverage
npm run test:worker
backend/geolibre_server/.venv/bin/python -m pytest \
  backend/geolibre_server/tests \
  --cov=geolibre_server \
  --cov-report=term-missing \
  --cov-fail-under=55
npm run check:rust
npm run test:e2e
```

Windows Source Runtime Smoke도 완료하고 다음 증거를 보존한다.

- 실행 Command와 시각
- `geoIM3D` Window Title 또는 화면 Capture
- 기본 한국어 UI 확인
- App 종료 후 잔존 Process 확인

Gate 실패 상태로 Snapshot을 만들지 않는다.

## 5. History 없는 Snapshot 생성

임시 경로는 암호화된 사내 Disk 또는 승인된 Workspace를 사용한다.

```bash
SNAPSHOT_ROOT="$(mktemp -d)"
SNAPSHOT_DIR="$SNAPSHOT_ROOT/geoIM3D"
SOURCE_ARCHIVE_PATH="$SNAPSHOT_ROOT/geoIM3D-approved-source.tar"

mkdir -p "$SNAPSHOT_DIR"
git archive \
  --format=tar \
  --prefix=geoIM3D/ \
  "$SOURCE_REF" > "$SOURCE_ARCHIVE_PATH"
tar -xf "$SOURCE_ARCHIVE_PATH" -C "$SNAPSHOT_ROOT"
```

포함 여부를 확인한다.

```bash
test -f "$SNAPSHOT_DIR/LICENSE"
test -f "$SNAPSHOT_DIR/docs/directives/01_REBRANDING_SCOPE.md"
test -f "$SNAPSHOT_DIR/apps/geolibre-desktop/src/config/brand.ts"
test ! -e "$SNAPSHOT_DIR/.git"
SENSITIVE_FILES="$(find "$SNAPSHOT_DIR" -type f \
  \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
     -o -name '*.p12' -o -name '*.pfx' \) -print)"
if [ -n "$SENSITIVE_FILES" ]; then
  printf 'STOP: sensitive file candidates found:\n%s\n' "$SENSITIVE_FILES" >&2
  exit 1
fi
```

위 명령은 민감 파일 후보가 하나라도 있으면 중단한다. 예외 파일이 필요하면 내용과 포함 사유를 승인 기록에 남기고 새 Snapshot을 생성한다.

## 6. Provenance 기록

Snapshot 안에 실제 승인 값으로 `docs/rebranding/UPSTREAM_SOURCE.md`를 생성한다.

```bash
SNAPSHOT_DATE_UTC="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
cat > "$SNAPSHOT_DIR/docs/rebranding/UPSTREAM_SOURCE.md" <<EOF
# Upstream Source Provenance

- Product: geoIM3D 1.0.0
- Upstream: https://github.com/opengeos/GeoLibre
- Upstream version: $SOURCE_VERSION
- Source commit: $SOURCE_COMMIT
- Snapshot date (UTC): $SNAPSHOT_DATE_UTC
- License: MIT (LICENSE 유지)
- Modifications: geoIM3D rebranding and product customization
EOF

grep -F -- "- Source commit: $SOURCE_COMMIT" \
  "$SNAPSHOT_DIR/docs/rebranding/UPSTREAM_SOURCE.md"
grep -F -- "- Snapshot date (UTC): $SNAPSHOT_DATE_UTC" \
  "$SNAPSHOT_DIR/docs/rebranding/UPSTREAM_SOURCE.md"
if grep -Eq '<approved-|<ISO-' "$SNAPSHOT_DIR/docs/rebranding/UPSTREAM_SOURCE.md"; then
  echo "STOP: unresolved provenance placeholder" >&2
  exit 1
fi
```

## 7. Secret 및 License 검증

승인된 사내 Secret Scanner가 있으면 Snapshot Directory 전체에 실행한다. 예시는 Gitleaks다.

```bash
gitleaks dir "$SNAPSHOT_DIR" --redact
```

Gitleaks를 사용할 수 없으면 임의로 통과 처리하지 않는다. 사용한 대체 Scanner, Version, 규칙, 결과를 승인 기록에 남긴다.

License/Attribution 확인:

```bash
test -s "$SNAPSHOT_DIR/LICENSE"
rg -n 'GeoLibre|MIT|opengeos/GeoLibre' \
  "$SNAPSHOT_DIR/LICENSE" \
  "$SNAPSHOT_DIR/docs/rebranding" \
  "$SNAPSHOT_DIR/apps/geolibre-desktop/src/config/brand.ts"
```

## 8. Snapshot Checksum과 Manifest

```bash
(
  cd "$SNAPSHOT_DIR"
  find . -type f ! -name 'SOURCE_MANIFEST.sha256' -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > SOURCE_MANIFEST.sha256
  sha256sum -c SOURCE_MANIFEST.sha256
)

FINAL_ARCHIVE_PATH="$SNAPSHOT_ROOT/geoIM3D-private-import.tar"
tar -cf "$FINAL_ARCHIVE_PATH" -C "$SNAPSHOT_ROOT" geoIM3D
(
  cd "$SNAPSHOT_ROOT"
  sha256sum "$(basename "$FINAL_ARCHIVE_PATH")" \
    > "$(basename "$FINAL_ARCHIVE_PATH").sha256"
  sha256sum -c "$(basename "$FINAL_ARCHIVE_PATH").sha256"
)
```

`SOURCE_MANIFEST.sha256`는 최초 Import Commit에 포함한다. 최종 Archive에는 Provenance와 Manifest가 모두 포함되며, Archive Checksum은 승인 기록 또는 Artifact 저장소에 보관한다. `SOURCE_ARCHIVE_PATH`는 승인된 Commit 추출용 중간 Artifact이므로 Private Import Artifact로 배포하지 않는다.

## 9. 새 비공개 저장소 초기화 — 별도 승인 후

다음 조건이 모두 충족된 경우에만 실행한다.

- 비공개 Repository URL과 접근 권한 확인
- Repository Owner의 Push 승인
- Secret Scan 통과
- License/Attribution 검토 통과
- Snapshot Manifest 검증 통과

```bash
set -euo pipefail
APPROVED_ARCHIVE_PATH="<approved-absolute-path>/geoIM3D-private-import.tar"
APPROVED_ARCHIVE_CHECKSUM_PATH="$APPROVED_ARCHIVE_PATH.sha256"
test -f "$APPROVED_ARCHIVE_PATH"
test -f "$APPROVED_ARCHIVE_CHECKSUM_PATH"
(
  cd "$(dirname "$APPROVED_ARCHIVE_PATH")"
  sha256sum -c "$(basename "$APPROVED_ARCHIVE_CHECKSUM_PATH")"
)

IMPORT_ROOT="$(mktemp -d)"
tar -xf "$APPROVED_ARCHIVE_PATH" -C "$IMPORT_ROOT"
SNAPSHOT_DIR="$IMPORT_ROOT/geoIM3D"
cd "$SNAPSHOT_DIR"
sha256sum -c SOURCE_MANIFEST.sha256
gitleaks dir . --redact
git init -b main
git add -A
git diff --cached --check
git commit -m "geoIM3D initial import"
git remote add origin "<approved-private-repository-url>"
git remote -v
git push -u origin main
```

Push 후 검증:

```bash
git ls-remote --heads origin main
git rev-list --count main
git log --oneline --decorate -1
```

Acceptance:

- `git rev-list --count main` 결과가 `1`
- Remote가 승인된 비공개 URL과 정확히 일치
- 최초 Commit Message가 `geoIM3D initial import`
- Remote UI에서 Repository Visibility가 `Private`
- `LICENSE`, Attribution, `UPSTREAM_SOURCE.md`, `SOURCE_MANIFEST.sha256` 존재

## 10. 실패·중단 처리

- 승인 전에는 `git remote add`, Repository 생성, Push를 수행하지 않는다.
- Secret 또는 License 문제가 발견되면 Snapshot 전체를 폐기하고 승인된 Source Commit부터 다시 생성한다.
- 기존 Archive를 직접 수정하여 재사용하지 않는다.
- 실패한 임시 Snapshot은 조직의 Secure Deletion 정책에 따라 제거한다.
- Token, Password, Private Repository URL의 Credential을 Console Log나 문서에 기록하지 않는다.

## 11. 실행 증거 Checklist

- [ ] Source Repository/Version/Commit 승인 기록
- [ ] Clean Worktree와 Full Gate 결과
- [ ] Windows Runtime Smoke 증거
- [ ] `.git`, 미추적 파일, Secret 미포함 확인
- [ ] MIT License 및 원본 Attribution 확인
- [ ] `UPSTREAM_SOURCE.md` 생성
- [ ] Secret Scanner 결과
- [ ] Source Manifest와 Archive SHA-256
- [ ] Private Repository Push 승인
- [ ] Remote Visibility와 단일 Initial Commit 확인
