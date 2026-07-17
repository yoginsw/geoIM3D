import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureHtmlFileName,
  ensureProjectFileName,
  isCanonicalProjectFileName,
  isCanonicalProjectReference,
  isLegacyProjectFileName,
} from "../apps/geolibre-desktop/src/lib/file-names";

describe("ensureHtmlFileName", () => {
  it("falls back to the slug-based name when blank", () => {
    assert.equal(ensureHtmlFileName("", "my-map"), "my-map.html");
    assert.equal(ensureHtmlFileName("   ", "my-map"), "my-map.html");
  });

  it("falls back to the slug-based name for a dots-only name", () => {
    // A bare "." would otherwise become "..html"; treat it as no usable base.
    assert.equal(ensureHtmlFileName(".", "my-map"), "my-map.html");
    assert.equal(ensureHtmlFileName("..", "my-map"), "my-map.html");
  });

  it("appends .html when no HTML extension is present", () => {
    assert.equal(ensureHtmlFileName("report", "map"), "report.html");
    assert.equal(ensureHtmlFileName("  report  ", "map"), "report.html");
  });

  it("keeps an existing .html or .htm extension as-is", () => {
    assert.equal(ensureHtmlFileName("page.html", "map"), "page.html");
    assert.equal(ensureHtmlFileName("page.htm", "map"), "page.htm");
  });

  it("treats the extension case-insensitively", () => {
    assert.equal(ensureHtmlFileName("PAGE.HTML", "map"), "PAGE.HTML");
    assert.equal(ensureHtmlFileName("Page.Htm", "map"), "Page.Htm");
  });

  it("appends .html when a non-HTML dot suffix is present", () => {
    assert.equal(ensureHtmlFileName("my.map", "fallback"), "my.map.html");
    assert.equal(ensureHtmlFileName("data.json", "fallback"), "data.json.html");
  });
});

describe("ensureProjectFileName", () => {
  it("defaults to the project name when blank", () => {
    assert.match(ensureProjectFileName(""), /\.geoim3d\.json$/);
    assert.match(ensureProjectFileName("   "), /\.geoim3d\.json$/);
  });

  it("appends .geoim3d.json when no recognized extension is present", () => {
    assert.equal(ensureProjectFileName("trip"), "trip.geoim3d.json");
  });

  it("keeps only the canonical extension as-is", () => {
    assert.equal(ensureProjectFileName("a.geoim3d.json"), "a.geoim3d.json");
    assert.equal(ensureProjectFileName("A.GEOIM3D.JSON"), "A.GEOIM3D.JSON");
  });

  it("replaces legacy and generic JSON suffixes with the canonical extension", () => {
    assert.equal(ensureProjectFileName("a.geolibre.json"), "a.geoim3d.json");
    assert.equal(ensureProjectFileName("a.geolibre"), "a.geoim3d.json");
    assert.equal(ensureProjectFileName("a.json"), "a.geoim3d.json");
  });

  it("recognizes canonical paths and rejects legacy project names", () => {
    assert.equal(isCanonicalProjectFileName("/tmp/a.geoim3d.json"), true);
    assert.equal(isCanonicalProjectFileName("C:\\Maps\\A.GEOIM3D.JSON"), true);
    assert.equal(isCanonicalProjectFileName("/tmp/a.json"), false);
    assert.equal(isLegacyProjectFileName("/tmp/a.geolibre.json"), true);
    assert.equal(isLegacyProjectFileName("/tmp/a.geolibre"), true);
    assert.equal(isLegacyProjectFileName("/tmp/a.geoim3d.json"), false);
  });

  it("accepts only canonical local and URL project references", () => {
    assert.equal(isCanonicalProjectReference("/tmp/a.geoim3d.json"), true);
    assert.equal(
      isCanonicalProjectReference(
        "https://example.com/a.geoim3d.json?download=1",
      ),
      true,
    );
    assert.equal(
      isCanonicalProjectReference("https://example.com/a.geolibre.json"),
      false,
    );
    assert.equal(
      isCanonicalProjectReference("https://example.com/api/projects/1"),
      false,
    );
  });
});
