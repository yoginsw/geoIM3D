import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseProject, serializeProject } from "@geolibre/core";
import {
  classifyProjectDrop,
  filterCanonicalRecentProjects,
  preparePortableProject,
  prepareProjectForFileSave,
  sanitizeIncomingProjectCredentials,
} from "../apps/geolibre-desktop/src/lib/project-file-contract";
import { isCanonicalProjectUrl } from "../apps/geolibre-desktop/src/lib/project-url";
import { sanitizePortableProjectSnapshot } from "../workers/collab/src/project-snapshot";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("classifyProjectDrop", () => {
  it("accepts exactly one canonical project", () => {
    assert.deepEqual(classifyProjectDrop(["/tmp/site.geoim3d.json"]), {
      kind: "project",
      reference: "/tmp/site.geoim3d.json",
    });
  });

  it("rejects legacy project extensions before the data import path", () => {
    assert.deepEqual(classifyProjectDrop(["/tmp/site.geolibre.json"]), {
      kind: "invalid-project",
      reason: "legacy",
    });
    assert.deepEqual(classifyProjectDrop(["/tmp/site.geolibre"]), {
      kind: "invalid-project",
      reason: "legacy",
    });
  });

  it("rejects mixed or multiple project drops", () => {
    assert.deepEqual(
      classifyProjectDrop(["/tmp/site.geoim3d.json", "/tmp/roads.geojson"]),
      { kind: "invalid-project", reason: "mixed" },
    );
    assert.deepEqual(
      classifyProjectDrop([
        "/tmp/one.geoim3d.json",
        "/tmp/two.geoim3d.json",
      ]),
      { kind: "invalid-project", reason: "mixed" },
    );
  });

  it("leaves ordinary data drops on the existing import path", () => {
    assert.deepEqual(classifyProjectDrop(["/tmp/roads.geojson"]), {
      kind: "data",
    });
  });
});

describe("prepareProjectForFileSave", () => {
  it("strips project environment values and preserves layer/map/plugin state", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Round trip",
        mapView: { center: [127.1, 37.4], zoom: 12, bearing: 5, pitch: 30 },
        layers: [
          {
            id: "layer-a",
            name: "Layer A",
            type: "geojson",
            source: { type: "geojson" },
            geojson: { type: "FeatureCollection", features: [] },
          },
        ],
        preferences: {
          environmentVariables: [
            { key: "API_TOKEN", value: "do-not-save", enabled: true },
          ],
          geocoding: {
            providerId: "mapbox",
            apiKeys: { mapbox: "geocoder-do-not-save" },
          },
        },
        plugins: {
          activePluginIds: ["maplibre-gl-swipe"],
          settings: { "maplibre-gl-swipe": { position: 35 } },
        },
      }),
    );

    const content = serializeProject(prepareProjectForFileSave(project));
    const reloaded = parseProject(content);

    assert.equal(content.includes("do-not-save"), false);
    assert.equal(content.includes("geocoder-do-not-save"), false);
    assert.deepEqual(reloaded.preferences.environmentVariables, []);
    assert.deepEqual(reloaded.preferences.geocoding.apiKeys, {});
    assert.equal(reloaded.layers[0]?.id, "layer-a");
    assert.deepEqual(reloaded.mapView, project.mapView);
    assert.deepEqual(reloaded.plugins?.activePluginIds, ["maplibre-gl-swipe"]);
    assert.deepEqual(reloaded.plugins?.settings, {
      "maplibre-gl-swipe": { position: 35 },
    });
  });
});

describe("incoming project credential boundary", () => {
  it("drops managed credentials while preserving non-secret environment rows", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Incoming",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        preferences: {
          environmentVariables: [
            { key: "OPENAI_API_KEY", value: "incoming-ai", enabled: true },
            { key: "SAFE_RENDER_OPTION", value: "1", enabled: true },
          ],
          geocoding: {
            providerId: "google",
            apiKeys: { google: "incoming-geocoder" },
          },
        },
      }),
    );

    const sanitized = sanitizeIncomingProjectCredentials(project);
    assert.deepEqual(sanitized.preferences.environmentVariables, [
      { key: "SAFE_RENDER_OPTION", value: "1", enabled: true },
    ]);
    assert.deepEqual(sanitized.preferences.geocoding.apiKeys, {});
    const content = serializeProject(sanitized);
    assert.equal(content.includes("incoming-ai"), false);
    assert.equal(content.includes("incoming-geocoder"), false);
  });
});

describe("portable project boundaries", () => {
  it("uses the same credential redaction for files, collaboration, and embed", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Portable",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        preferences: {
          environmentVariables: [
            { key: "PRIVATE_VALUE", value: "portable-secret", enabled: true },
          ],
        },
      }),
    );
    const portable = preparePortableProject(project);
    assert.deepEqual(portable.preferences.environmentVariables, []);
    assert.equal(serializeProject(portable).includes("portable-secret"), false);

    const collaboration = readFileSync(
      path.join(
        repoRoot,
        "apps/geolibre-desktop/src/hooks/useCollaboration.ts",
      ),
      "utf8",
    );
    const embed = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/src/hooks/useEmbedBridge.ts"),
      "utf8",
    );
    assert.match(collaboration, /preparePortableProject\(buildProjectSnapshot/);
    assert.match(embed, /preparePortableProject\(buildProjectSnapshot/);
  });

  it("strips environment values at the collaboration relay boundary", () => {
    const sanitized = sanitizePortableProjectSnapshot({
      version: "0.2.0",
      name: "Relay",
      preferences: {
        environmentVariables: [
          { key: "PRIVATE_VALUE", value: "relay-only-value", enabled: true },
        ],
        map: { projection: "globe" },
      },
      plugins: { settings: { sample: { enabled: true } } },
    }) as Record<string, unknown>;
    const preferences = sanitized.preferences as Record<string, unknown>;
    assert.deepEqual(preferences.environmentVariables, []);
    assert.deepEqual(preferences.map, { projection: "globe" });
    assert.deepEqual(sanitized.plugins, {
      settings: { sample: { enabled: true } },
    });

    const relay = readFileSync(
      path.join(repoRoot, "workers/collab/src/session.ts"),
      "utf8",
    );
    assert.match(
      relay,
      /snapshot:\s*sanitizePortableProjectSnapshot\(\s*parseStoredSnapshot\(snapshot\)/,
    );
  });
});

describe("filterCanonicalRecentProjects", () => {
  it("removes stale legacy, generic JSON, and service endpoint entries", () => {
    const openedAt = "2026-07-17T00:00:00.000Z";
    const entries = filterCanonicalRecentProjects([
      { path: "/tmp/local.geoim3d.json", name: "Local", openedAt },
      {
        path: "https://example.com/remote.geoim3d.json",
        name: "Remote",
        openedAt,
      },
      { path: "/tmp/legacy.geolibre.json", name: "Legacy", openedAt },
      { path: "/tmp/generic.json", name: "Generic", openedAt },
      { path: "https://example.com/api/projects/1", name: "API", openedAt },
    ]);

    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["Local", "Remote"],
    );
  });
});

describe("project identity platform boundaries", () => {
  it("accepts only canonical deep-link file URLs", () => {
    assert.equal(
      isCanonicalProjectUrl("https://example.com/site.geoim3d.json?download=1"),
      true,
    );
    assert.equal(
      isCanonicalProjectUrl("https://example.com/site.geolibre.json"),
      false,
    );
    assert.equal(isCanonicalProjectUrl("https://example.com/site.json"), false);
  });

  it("keeps dialogs and Rust reads canonical while deferring OS association", () => {
    const config = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          "apps/geolibre-desktop/src-tauri/tauri.conf.json",
        ),
        "utf8",
      ),
    ) as { bundle: { fileAssociations?: Array<{ ext: string[] }> } };
    assert.equal(config.bundle.fileAssociations, undefined);

    const io = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/src/lib/tauri-io.ts"),
      "utf8",
    );
    assert.match(io, /extensions: \[PROJECT_FILE_DIALOG_EXTENSION\]/);
    assert.doesNotMatch(io, /extensions: \["geolibre"/);

    const browserSave = io.slice(
      io.indexOf("async function saveProjectFileBrowser"),
      io.indexOf("async function saveTextFileBrowser"),
    );
    const validateIndex = browserSave.indexOf(
      "isCanonicalProjectFileName(handle.name)",
    );
    const writeIndex = browserSave.indexOf("handle.createWritable()");
    assert.ok(validateIndex >= 0, "browser save must validate the selected name");
    assert.ok(
      validateIndex < writeIndex,
      "browser save must reject before creating a writable handle",
    );

    const rust = readFileSync(
      path.join(repoRoot, "apps/geolibre-desktop/src-tauri/src/lib.rs"),
      "utf8",
    );
    assert.match(rust, /lower\.ends_with\("\.geoim3d\.json"\)/);
    assert.doesNotMatch(rust, /lower\.ends_with\("\.geolibre/);
  });

  it("routes manual and deep-link project URLs through the scoped share fetch", () => {
    const actions = readFileSync(
      path.join(
        repoRoot,
        "apps/geolibre-desktop/src/hooks/useProjectFileActions.ts",
      ),
      "utf8",
    );
    const deepLink = readFileSync(
      path.join(
        repoRoot,
        "apps/geolibre-desktop/src/hooks/useProjectUrlLoader.ts",
      ),
      "utf8",
    );
    assert.match(
      actions,
      /openRecentProjectFile\([\s\S]{0,160}getShareFetch\(\)/,
    );
    assert.match(
      deepLink,
      /fetchProjectFromUrl\([\s\S]{0,160}fetchImpl: getShareFetch\(\)/,
    );
  });
});
