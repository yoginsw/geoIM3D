import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repo = resolve(import.meta.dirname, "..");
const sampler = readFileSync(join(repo, "scripts/phase7e-memory-sampler.ps1"), "utf8");
const harness = readFileSync(join(repo, "scripts/phase7e-runtime-evidence.ps1"), "utf8");
const projectMenu = readFileSync(
  join(repo, "apps/geolibre-desktop/src/components/layout/toolbar/ProjectMenu.tsx"),
  "utf8",
);
const topToolbar = readFileSync(
  join(repo, "apps/geolibre-desktop/src/components/layout/TopToolbar.tsx"),
  "utf8",
);
const generator = join(repo, "tests/fixtures/generate-scene-preset-memory-fixtures.mjs");

const expected = new Map([
  ["phase7e-feature-25000-v1.geoim3d-preset.json", [2076286, "77707a2c850ffdf89af45e909157cb3c7fc32fdb8a622e3dc656966cdae34dd2"]],
  ["phase7e-coordinate-250000-v1.geoim3d-preset.json", [1501374, "0c75b2a145efcfbc87cbb12ab0d6825ac9eea0a6238a3b8cc72a811732aea5f5"]],
]);

test("Phase 7E generator verifies the normative fixture identities", () => {
  const output = execFileSync("node", [generator, "--verify"], { cwd: repo, encoding: "utf8" });
  for (const [filename, [bytes, hash]] of expected) {
    const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(`${filename} `));
    assert.ok(line, `generator did not report ${filename}`);
    assert.equal(line, `${filename} ${bytes} ${hash}`);
  }
});

test("Phase 7E sampler declares the exact CSV and closed classification contract", () => {
  assert.match(sampler, /\$CsvColumns = @\("utc_ns", "run_id", "fixture_id", "phase", "pid", "parent_pid", "process_creation_time", "process_role", "private_working_set_bytes"\)/);
  assert.match(sampler, /"tauri-root"/);
  assert.match(sampler, /"webview-renderer"/);
  assert.match(sampler, /--type=renderer/);
  assert.match(sampler, /command_line = \[string\]\$candidate\.CommandLine/);
  assert.match(sampler, /"webview-utility"/);
  assert.match(sampler, /"other-child"/);
  assert.match(sampler, /\$Phases = @\("idle", "worker-scan", "transfer-handoff", "main-decode", "store-apply", "recovery"\)/);
  assert.match(sampler, /Win32_Process/);
  assert.match(sampler, /CreationDate/);
  assert.match(sampler, /PrivateWorkingSetSize/);
  assert.match(sampler, /GetProcessMemoryInfo/);
  assert.doesNotMatch(sampler, /private_working_set_bytes\s*=\s*\[int64\]\$process\.WorkingSet64/);
  assert.match(sampler, /\.ProviderPath/);
  assert.doesNotMatch(sampler, /(?:=|utc_ns\s*=)\s*UtcNs\(\)/);
  assert.doesNotMatch(sampler, /\[int\]\s*\$Pid\b/i);
  assert.match(sampler, /160MB/);
  assert.match(sampler, /192MB/);
  assert.match(sampler, /32MB/);
});

test("Phase 7E harness is evidence-first and cannot substitute runtime results", () => {
  assert.match(harness, /--out/);
  assert.match(harness, /--verify/);
  assert.match(harness, /phase7e-memory-sampler\.ps1/);
  assert.match(harness, /run-manifest\.json/);
  assert.match(harness, /calculations\.json/);
  assert.match(sampler, /if \(-not \$manifest\.pass\) \{ Fail/);
  assert.doesNotMatch(sampler, /simulation|synthetic|fabricat/i);
  assert.doesNotMatch(harness, /simulation|synthetic|fabricat/i);
});

test("Phase 7E native preset actions are absent from Web/PWA menus and commands", () => {
  assert.match(projectMenu, /desktop && show\("project\.importScenePreset"\)/);
  assert.match(projectMenu, /desktop && show\("project\.exportScenePreset"\)/);
  assert.match(
    topToolbar,
    /\.\.\.\(desktop[\s\S]*id: "project\.import-scene-preset"[\s\S]*id: "project\.export-scene-preset"[\s\S]*: \[\]\)/,
  );
});

test("generated fixture files independently match bytes and SHA-256", () => {
  const out = mkdtempSync(join(tmpdir(), "phase7e-fixtures-"));
  try {
    execFileSync("node", [generator, "--out", out], { cwd: repo, stdio: "pipe" });
    for (const [filename, [bytes, hash]] of expected) {
      const path = join(out, filename);
      const content = readFileSync(path);
      assert.equal(statSync(path).size, bytes);
      assert.equal(createHash("sha256").update(content).digest("hex"), hash);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("PowerShell is available for native harness execution when installed", { skip: !process.env.PHASE7E_RUN_PWSH }, () => {
  execFileSync("pwsh", ["-NoProfile", "-Command", "'$PSVersionTable.PSVersion.ToString()'"], { encoding: "utf8" });
});
