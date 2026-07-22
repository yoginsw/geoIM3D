# Phase 8 Release 1.0 Gate Evidence

- Date: `2026-07-22`
- Product: `geoIM3D 1.0.0`
- Version mapping: Tauri/product/package artifacts use end-user version `1.0.0`; workspace/npm/Cargo
  `2.1.0` is retained only as upstream GeoLibre source-compatibility/developer metadata and is not a
  geoIM3D release-version claim
- Branch: `feat/geoim3d-3d-scene-preset`
- Source state: immutable alternate-index Git tree created after evidence freeze; tree ID is recorded in the external review handoff, with no commit and no mutation of the user's real index
- Public release / main merge / upstream push: not authorized

## Owner-directed exception

The product owner directed the team to skip executable-scenario testing and proceed to the remaining phases.
The Phase 7E Windows memory three-run gate is therefore **deferred, not passed**. No memory CSV,
calculation, threshold, or recovery result is claimed.

## Verified gates

| Gate | Result | Evidence |
|---|---:|---|
| Brand surface | PASS | `npm run check:brand`; forbidden product-surface strings 0 |
| ESLint | PASS | 0 errors; 21 pre-existing warnings |
| Worker typecheck | PASS | viewer/collab/tiles |
| Frontend tests | PASS | 3,083 passed, 0 failed, 2 skipped |
| Frontend coverage | PASS | lines 81.92%, branches 82.02%, functions 70.68% |
| Backend coverage | PASS | 257 passed, 16 skipped; 64.19% >= 55% |
| E2E | PASS | 28 passed; includes Brand, PWA offline, and Web exclusion cases |
| Windows Rust tests | PASS | 92 passed, 0 failed |
| Phase 7E targeted contracts | PASS | broader 10 passed, 1 PowerShell availability skip; HTTPS/relative resource contracts 11 passed |
| Source Gitleaks | PASS | 1,107 tracked/untracked source files, 13.69 MB, findings 0 |
| Python dependency audit | PASS | `pip-audit` exit 0; no known vulnerabilities; local package skipped as non-PyPI |
| Rust vulnerabilities | PASS | `cargo audit`: vulnerabilities 0 after lock updates |
| Diff whitespace | PASS | `git diff --check` |

## Dependency remediation

- `fast-xml-parser`: `5.10.0 -> 5.10.1`
- `fast-uri`: `3.1.3 -> 3.1.4`
- vulnerable nested `brace-expansion`: `2.1.1 -> 2.1.2`
- `wrangler`: `4.110.0 -> 4.113.0`
- `@cloudflare/workers-types`: `^5.20260714.1 -> ^5.20260721.1`
- `plist`: `1.9.0 -> 1.10.0`
- `quick-xml`: `0.39.4 -> 0.41.0`
- `quinn-proto`: `0.11.14 -> 0.11.15`
- `anyhow`: `1.0.102 -> 1.0.103`

## Open blockers / warnings

1. **npm High blocker**: current upstream `miniflare 4.20260721.0` exact-pins `sharp 0.34.5`.
   npm reports the same chain as High entries for `sharp`, `miniflare`, and `wrangler`.
   `sharp >=0.35.0` is patched, but force-overriding an exact transitive runtime is not accepted without
   an upstream compatible Miniflare/Wrangler release. This tooling is development-only, but it remains
   a repository Release Gate blocker rather than being silently exempted.
2. **npm Moderate blocker**: five MCP/agent dependency advisories have no non-breaking fixed graph at
   the audited versions. `npm audit --force` proposes downgrading `@strands-agents/sdk` to `0.1.6`, which
   is not accepted without compatibility work.
3. **Rust warnings**: vulnerability count is zero. Remaining warnings are 17 unmaintained transitive
   crates and one `glib 0.18.5` unsound warning from the Linux GTK3/Tauri stack. `anyhow` unsoundness was
   remediated. These warnings must remain visible in final review.
4. **Offline scope**: the PASS result is the standalone Web/PWA cached-shell gate. It is not a claim that
   every Desktop feature works without a network; external map services and CDN-backed engines can still
   require first-use or live network access.
5. **Scene Preset transport scope**: Release 1.0 activates only relative self-contained GLB. HTTPS references
   fail closed with `SCENE_PRESET_REMOTE_UNAVAILABLE` until the peer-pinned native TLS/consent adapter exists;
   relative 3D Tiles/I3S fail strict validation until nested-resource rewrite is implemented.
6. **Windows package status**:
   - latest-source Windows Release EXE: PASS (`46,615,040` bytes, SHA-256
     `22ab45d69afcdd776332b3fd6617d93e56d4c974f9404a654499103e84061000`, unsigned as expected)
   - latest-source NSIS bundle: PASS (`41,730,548` bytes, SHA-256
     `341534c882866c169e77963426775603fe5d1dfed4361e05b7be2c3f14986d70`, unsigned as expected)
   - portable ZIP: PASS (`42,504,877` bytes, SHA-256
     `2fc2143fa29067e9bfa319cfe794c30b9cd4dadba472c52dbc37ca1418e7017c`); branded `geoIM3D.exe`,
     MIT `LICENSE`, `THIRD_PARTY_NOTICES.md`, and MPL license are present; extracted launch remained alive after 12 seconds
     with window title `geoIM3D Desktop`; forbidden venv/secret/test/cache entries 0
   - NSIS install/uninstall smoke: **not run** because an existing owner installation at
     `C:\geoim3d-d2-final-install` and a running product process were detected; reusing the same ProductCode
     could mutate that installation
   - MSI: PASS (`42,528,768` bytes, SHA-256
     `6630d2df5ec3a7a96c9134a20e0bf6384ba113dd2e31e60bfa943cbbfd89a798`, unsigned as expected) after staging
     the identical source/resources on a Windows-local path; the initial WSL UNC build failed because WiX
     cabinet creation cannot consume UNC resource paths (`LGHT0001 / DirectoryNotFoundException`).
     `msiexec /a` administrative extraction exited 0, produced the expected `46,615,040`-byte EXE, and that
     payload remained alive for 12 seconds with window title `geoIM3D Desktop`; MIT `LICENSE`, third-party
     notice, and MPL license were present.
   - MSIX: blocked by missing MakeAppx/Partner Center identity/signing inputs
7. Exact alternate-index tree `6c626441da020ae1c6b9246c5be8ce9ce3548a7c` received independent
   Security, Packaging, and Brand/Documentation approval with no new source defects.

## Release decision

**APPROVED FOR FEATURE-BRANCH COMMIT AND PUSH WITH OWNER EXCEPTIONS (2026-07-22).** The owner explicitly
accepted the following as release exceptions rather than technical PASS results: the deferred executable
Memory scenarios, eight unresolved upstream npm advisories, unsigned Windows artifacts, NSIS
install/uninstall smoke skipped to protect an existing owner installation, and unavailable MSIX
MakeAppx/Publisher identity/signing inputs. This approval does not authorize a `main` merge, public Release,
or publication of unsigned artifacts.
