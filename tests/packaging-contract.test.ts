import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("geoIM3D Phase 6 packaging contract", () => {
  it("uses the approved Windows identity without claiming the compound project suffix", () => {
    const config = JSON.parse(
      read("apps/geolibre-desktop/src-tauri/tauri.conf.json"),
    ) as {
      productName: string;
      identifier: string;
      version: string;
      bundle: {
        icon: string[];
        resources: string[];
        fileAssociations?: Array<{
          ext: string[];
          name?: string;
          description?: string;
          mimeType?: string;
          role?: string;
        }>;
      };
    };

    assert.equal(config.productName, "geoIM3D");
    assert.equal(config.identifier, "com.ejbt.geoim3d");
    assert.equal(config.version, "1.0.0");
    assert.doesNotMatch(JSON.stringify(config.bundle.resources), /geolibre_server"\]/);
    assert.match(
      JSON.stringify(config.bundle.resources),
      /geolibre_server\/geolibre_server\/\*\*\/\*\.py/,
    );
    assert.equal(config.bundle.fileAssociations, undefined);
    assert.ok(config.bundle.icon.includes("icons/icon.ico"));
  });

  it("removes every in-app update UI and background network path", () => {
    const removed = [
      "apps/geolibre-desktop/src/hooks/useStartupUpdateCheck.ts",
      "apps/geolibre-desktop/src/lib/updates.ts",
      "apps/geolibre-desktop/src/components/layout/UpdateNotificationModal.tsx",
      "apps/geolibre-desktop/src/components/layout/UpdateInstructions.tsx",
      "apps/geolibre-desktop/src/components/layout/ReleaseNotes.tsx",
      "tests/updates.test.ts",
    ];
    for (const relative of removed) {
      assert.equal(existsSync(path.join(root, relative)), false, relative);
    }

    const activeSurfaces = [
      "apps/geolibre-desktop/src/App.tsx",
      "apps/geolibre-desktop/src/components/layout/AboutDialog.tsx",
      "apps/geolibre-desktop/src/components/layout/TopToolbar.tsx",
      "apps/geolibre-desktop/src/components/layout/SettingsDialog.tsx",
      "apps/geolibre-desktop/src/components/layout/toolbar/HelpMenu.tsx",
      "apps/geolibre-desktop/src/lib/ui-profile.ts",
      "apps/geolibre-desktop/vite.config.ts",
      "apps/geolibre-desktop/src/vite-env.d.ts",
    ].map(read).join("\n");
    assert.doesNotMatch(
      activeSurfaces,
      /useStartupUpdateCheck|fetchLatestRelease|checkForUpdatesRequest|help\.checkForUpdates|__GEOLIBRE_STORE_BUILD__|GEOLIBRE_STORE_BUILD|settings\.section\.updates|settings\.menu\.updates/,
    );

    const localeDirectory = path.join(
      root,
      "apps/geolibre-desktop/src/i18n/locales",
    );
    const locales = readdirSync(localeDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileSync(path.join(localeDirectory, name), "utf8"))
      .join("\n");
    assert.doesNotMatch(
      locales,
      /"updates"\s*:|"checkForUpdates"\s*:|"checkOnStartup"\s*:|"downloadUpdate"\s*:/,
    );
  });

  it("never injects credentials or upstream deployment domains into web artifacts", () => {
    const webPackaging = read("Dockerfile");
    assert.doesNotMatch(
      webPackaging,
      /VITE_(?:PROTOMAPS_API_KEY|GOOGLE_MAPS_API_KEY|MAPILLARY_ACCESS_TOKEN)|GOOGLE_MAPS_API_KEY/,
    );

    const runtimeConfiguration = [
      "apps/geolibre-desktop/src-tauri/tauri.conf.json",
      "apps/geolibre-desktop/src-tauri/capabilities/default.json",
      "apps/geolibre-desktop/src/components/layout/NoServiceWorkerBanner.tsx",
      "apps/geolibre-desktop/src/lib/share-geolibre.ts",
      "apps/geolibre-desktop/src/lib/share-gallery.ts",
      "apps/geolibre-desktop/src/lib/share-fetch.ts",
      "apps/geolibre-desktop/src/lib/html-export.ts",
      "apps/geolibre-desktop/src/lib/plugin-registry.ts",
      "apps/geolibre-desktop/src/components/layout/ManagePluginsDialog.tsx",
      "apps/geolibre-desktop/src/main.tsx",
      "python/src/geolibre/geolibre.py",
      "workers/viewer/src/index.ts",
      "workers/viewer/wrangler.toml",
      "workers/collab/wrangler.toml",
      "docker/nginx.conf",
    ].map(read).join("\n");
    assert.doesNotMatch(
      runtimeConfiguration,
      /(?:web|share|collab|plugins|data)\.geolibre\.app/,
    );
    assert.doesNotMatch(read("workers/viewer/wrangler.toml"), /\[\[routes\]\]/);
    assert.doesNotMatch(read("workers/collab/wrangler.toml"), /\[\[routes\]\]/);
    assert.doesNotMatch(read("workers/tiles/wrangler.toml"), /\[\[routes\]\]/);
    for (const worker of ["viewer", "collab", "tiles"]) {
      assert.match(read(`workers/${worker}/wrangler.toml`), /workers_dev\s*=\s*false/);
      const workerPackage = read(`workers/${worker}/package.json`);
      assert.doesNotMatch(workerPackage, /"deploy"\s*:/);
      assert.doesNotMatch(workerPackage, /wrangler deploy/);
    }
    for (const worker of ["collab", "tiles"]) {
      assert.match(read(`workers/${worker}/package.json`), /wrangler dev --local/);
    }
    assert.equal(existsSync(path.join(root, ".github/workflows/deploy-viewer.yml")), false);
    assert.equal(existsSync(path.join(root, ".github/workflows/deploy-collab.yml")), false);
    for (const workflow of [
      "android.yml",
      "cloudflare-preview.yml",
      "deploy-tiles.yml",
      "pages.yml",
      "publish-container.yml",
      "publish-python.yml",
      "release.yml",
    ]) {
      assert.equal(
        existsSync(path.join(root, ".github/workflows", workflow)),
        false,
        workflow,
      );
    }
    assert.match(read("apps/geolibre-desktop/src/lib/plugin-registry.ts"), /return null/);
    assert.doesNotMatch(
      read("apps/geolibre-desktop/src/lib/plugin-registry.ts"),
      /DEFAULT_REGISTRY_URL|plugins\.geolibre\.app/,
    );

    const activeProductDocs = [
      "README.md",
      "docs/index.md",
      "docs/getting-started.md",
      "docs/python.md",
      "python/README.md",
    ]
      .map(read)
      .join("\n");
    assert.doesNotMatch(
      activeProductDocs,
      /pip install (?:"?geolibre|geolibre)|conda install -c conda-forge geolibre|twine upload|GitHub Pages workflow reads/,
    );
    assert.doesNotMatch(
      activeProductDocs,
      /Google Colab|JupyterHub|Binder|server_proxy=True|jupyter-server-proxy|proxyPort/,
    );
    assert.doesNotMatch(
      activeProductDocs,
      /ghcr\.io\/opengeos\/geolibre|per-platform subfolders|web build embeds a self-hosted JupyterLite/i,
    );
    const docsIndex = read("docs/index.md");
    assert.match(docsIndex, /현재 비활성 또는 미승인 범위/);
    assert.doesNotMatch(
      docsIndex,
      /runs everywhere|plugins and marketplace|built-in marketplace|JupyterLite/i,
    );
    assert.match(read("python/src/geolibre/geolibre.py"), /_DEFAULT_HTML_APP_URL = ""/);
  });

  it("brands portable, MSIX, and container artifacts without an invented deployment domain", () => {
    const portable = read("packaging/portable/build-portable.ps1");
    assert.match(portable, /\$productName = \[string\] \$config\.productName/);
    assert.match(portable, /\$zipName = "\$productName-\$version-\$\{Architecture\}-portable\.zip"/);
    assert.match(portable, /geoIM3D/);
    assert.match(portable, /\.pytest_cache/);
    assert.match(portable, /AGENTS\.md/);
    assert.match(portable, /CARGO_TARGET_DIR/);
    assert.doesNotMatch(portable, /GeoLibre Desktop/);

    const msix = read("packaging/msix/build-msix.ps1");
    assert.match(msix, /\[string\] \$PublisherDisplayName = "JBT"/);

    assert.equal(
      existsSync(
        path.join(
          root,
          "apps/geolibre-desktop/src-tauri/windows/installer-hooks.nsh",
        ),
      ),
      false,
    );
    assert.match(msix, /\[string\] \$Language = "ko-KR"/);
    assert.doesNotMatch(msix, /windows\.fileTypeAssociation|uap:FileType/);
    assert.match(msix, /\.pytest_cache/);
    assert.match(msix, /AGENTS\.md/);
    assert.match(msix, /CARGO_TARGET_DIR/);
    assert.doesNotMatch(msix, /OpenGeospatialSolutions|GeoLibreDesktop/);

    const dockerfile = read("Dockerfile");
    assert.match(dockerfile, /org\.opencontainers\.image\.title="geoIM3D"/);
    assert.match(dockerfile, /intended for local\/single-user[\s#]*use/);
    assert.equal(
      existsSync(path.join(root, ".github/workflows/publish-container.yml")),
      false,
    );

    const msixStoreWorkflow = read(".github/workflows/msix-store.yml");
    assert.match(msixStoreWorkflow, /package_name:[\s\S]*required: true/);
    assert.match(msixStoreWorkflow, /publisher:[\s\S]*required: true/);
    assert.match(msixStoreWorkflow, /geoim3d-store-unsigned-msix/);

    const tauriBuild = read("scripts/tauri-build.mjs");
    assert.match(tauriBuild, /process\.execPath/);
    assert.match(tauriBuild, /@tauri-apps\/cli\/tauri\.js/);
    assert.doesNotMatch(tauriBuild, /spawnSync\(\s*"npm"/);
  });
});
