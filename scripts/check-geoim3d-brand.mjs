#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = "GeoLibre";
const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".json", ".html"]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "dist",
  "dist-embed",
  "node_modules",
  "target",
  "test-results",
]);
const KO_ATTRIBUTION_VALUES = new Map([
  ["about.githubRepository", "원본 GeoLibre 프로젝트"],
  ["printLayout.element.attribution", "GeoLibre 저작권 표시 포함"],
]);
const UPSTREAM_URLS = new Set([
  "https://github.com/opengeos/GeoLibre",
  "https://github.com/opengeos/GeoLibre/issues",
  "https://api.github.com/repos/opengeos/GeoLibre/releases/latest",
]);
const PUBLIC_COMPATIBILITY_LITERALS = new Set([
  "Entry must export a GeoLibrePlugin as default or plugin.",
]);

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a directory path");
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { root };
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function productSurfaceFiles(root) {
  const app = resolve(root, "apps/geolibre-desktop");
  if (!statSafe(app)?.isDirectory()) return walk(root);

  const files = walk(resolve(app, "src")).filter((path) => {
    const extension = extname(path);
    return extension === ".ts" || extension === ".tsx" ||
      path.endsWith(`${sep}i18n${sep}locales${sep}ko.json`);
  });
  for (const relativePath of [
    "index.html",
    "vite.config.ts",
    "src-tauri/tauri.conf.json",
    "src-tauri/capabilities/default.json",
  ]) {
    const path = resolve(app, relativePath);
    if (statSafe(path)?.isFile()) files.push(path);
  }
  return files;
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isAllowedLiteral(relativePath, value) {
  if (UPSTREAM_URLS.has(value)) return true;
  if (
    relativePath.endsWith("apps/geolibre-desktop/src/config/brand.ts") ||
    relativePath === "src/config/brand.ts"
  ) {
    return value === "GeoLibre" || UPSTREAM_URLS.has(value);
  }
  // External plugins must continue to name this exact public compatibility contract.
  return PUBLIC_COMPATIBILITY_LITERALS.has(value);
}

function lineOf(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function scanTypeScript(path, relativePath, text) {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const violations = [];

  function check(value, node) {
    if (!value.includes(FORBIDDEN) || isAllowedLiteral(relativePath, value)) return;
    violations.push({
      path: relativePath,
      line: lineOf(source, node.getStart(source)),
      value: value.replace(/\s+/g, " ").trim(),
    });
  }

  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
      check(node.text, node);
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      check(node.text, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

function scanJson(relativePath, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse ${relativePath}: ${error.message}`);
  }
  const lines = text.split(/\r?\n/);
  const violations = [];

  function visit(current, keys) {
    if (typeof current === "string") {
      if (!current.includes(FORBIDDEN)) return;
      const jsonPath = keys.join(".");
      const koLocale = relativePath.endsWith("src/i18n/locales/ko.json");
      if (koLocale && KO_ATTRIBUTION_VALUES.get(jsonPath) === current) return;
      const serialized = JSON.stringify(current);
      const lineIndex = lines.findIndex((line) => line.includes(serialized));
      violations.push({
        path: relativePath,
        line: lineIndex >= 0 ? lineIndex + 1 : 1,
        value: current.replace(/\s+/g, " ").trim(),
      });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, [...keys, String(index)]));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) {
        visit(entry, [...keys, key]);
      }
    }
  }

  visit(value, []);
  return violations;
}

function scanHtml(relativePath, text) {
  return text.split(/\r?\n/).flatMap((line, index) =>
    line.includes(FORBIDDEN)
      ? [{ path: relativePath, line: index + 1, value: line.trim() }]
      : [],
  );
}

export function scanBrandSurfaces(root) {
  const absoluteRoot = resolve(root);
  const violations = [];
  for (const path of productSurfaceFiles(absoluteRoot)) {
    const relativePath = relative(absoluteRoot, path).split(sep).join("/");
    const text = readFileSync(path, "utf8");
    const extension = extname(path);
    if (extension === ".ts" || extension === ".tsx") {
      violations.push(...scanTypeScript(path, relativePath, text));
    } else if (extension === ".json") {
      violations.push(...scanJson(relativePath, text));
    } else if (extension === ".html") {
      violations.push(...scanHtml(relativePath, text));
    }
  }
  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line,
  );
}

function main() {
  let root;
  try {
    ({ root } = parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[check-geoim3d-brand] ${error.message}`);
    process.exit(2);
  }

  const violations = scanBrandSurfaces(root);
  if (violations.length > 0) {
    console.error(
      `[check-geoim3d-brand] Found ${violations.length} forbidden user-facing ${FORBIDDEN} string(s):`,
    );
    for (const violation of violations) {
      console.error(`${violation.path}:${violation.line}: ${violation.value}`);
    }
    process.exit(1);
  }

  console.log("[check-geoim3d-brand] PASS: no forbidden product-surface strings.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
