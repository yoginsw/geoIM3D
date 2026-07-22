# Phase 7E Windows memory evidence

These scripts capture **Windows-native** Tauri process-tree evidence. They do not simulate RSS or claim a runtime result.

## Prerequisites

- Windows PowerShell 7 (`pwsh`), Node.js, and the production Tauri/WebView2 build.
- A scenario executable that drives the app and accepts `--phase`, `--fixture`, and `--run-id`. It must return non-zero on a failed UI/runtime action.
- The same fresh-start app build/configuration for all three runs of each fixture.

## One-command harness

From the repository root in PowerShell, use an empty output directory:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/phase7e-runtime-evidence.ps1 `
  -LaunchPath 'C:\path\to\geoim3d.exe' `
  -ScenarioPath 'C:\path\to\phase7e-scenario.exe' `
  -OutputDirectory 'C:\path\to\empty\phase7e-evidence'
```

The harness creates fixtures only through the approved generator, runs `--verify`, then invokes the sampler. The sampler launches the exact supplied app path for each run, binds the root PID to its creation time, walks live descendants through `Win32_Process`, samples `Private Working Set` every 50 ms, and writes one CSV per run. Use `-RootPid` instead of `-LaunchPath` for attach mode; attach mode intentionally supports one run only.

Artifacts are written to the output directory:

- `*.csv` — exact columns from §11.3.
- `*.markers.json` — phase marker timestamps.
- `run-manifest.json` — generator/source/file identities and run records.
- `calculations.json` — baseline, renderer peak, tree peak, recovery, and pass/fail calculations.
- `fixtures/` — generated fixture files (the output root must be empty before start).

A missing artifact, fixture identity mismatch, failed scenario, threshold failure, or strict recovery increase across the three runs for a fixture makes the sampler fail. Linux/WSL/Node RSS is not acceptance evidence. Preserve the raw output and record the Windows/PowerShell/Node/build identities alongside any release evidence; do not edit the measurements.
