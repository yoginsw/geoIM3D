import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(repoRoot, "scripts/check-geoim3d-brand.mjs");
const temporaryRoots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), "geoim3d-brand-"));
  temporaryRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const path = resolve(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("geoIM3D forbidden brand surface check", () => {
  it("fails with file and line evidence for a forbidden source literal", () => {
    const root = fixture({
      "src/components/Welcome.tsx":
        'export const Welcome = () => <h1>Welcome to GeoLibre</h1>;\n',
    });

    const result = run(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /src\/components\/Welcome\.tsx:1/);
    assert.match(result.stderr, /Welcome to GeoLibre/);
  });

  it("allows the explicit upstream attribution contract", () => {
    const root = fixture({
      "src/config/brand.ts": [
        'export const upstream = {',
        '  name: "GeoLibre",',
        '  url: "https://github.com/opengeos/GeoLibre",',
        '  license: "MIT",',
        '};',
        "",
      ].join("\n"),
      "src/i18n/locales/ko.json": JSON.stringify({
        about: {
          githubRepository: "원본 GeoLibre 프로젝트",
          upstreamNotice: "{{name}} 기반 · {{license}} 라이선스",
        },
        printLayout: { attribution: "GeoLibre 저작권 표시 포함" },
      }),
    });

    const result = run(root);

    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects product prose disguised as an upstream URL or plugin identifier", () => {
    const root = fixture({
      "src/components/Unsafe.tsx": [
        'export const url = "https://github.com/opengeos/GeoLibre — restart GeoLibre";',
        'export const plugin = "GeoLibrePlugin runs inside GeoLibre";',
        "",
      ].join("\n"),
    });

    const result = run(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe\.tsx:1/);
    assert.match(result.stderr, /Unsafe\.tsx:2/);
  });

  it("passes a clean product surface", () => {
    const root = fixture({
      "src/components/Welcome.tsx":
        'export const Welcome = () => <h1>geoIM3D</h1>;\n',
      "src/i18n/locales/ko.json": JSON.stringify({ title: "지오아임3D" }),
      "index.html": "<title>geoIM3D</title>\n",
    });

    const result = run(root);

    assert.equal(result.status, 0, result.stderr);
  });

  it("passes the current repository product surfaces", () => {
    const result = run(repoRoot);

    assert.equal(result.status, 0, result.stderr);
  });
});
