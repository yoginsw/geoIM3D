import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRAND } from "../apps/geolibre-desktop/src/config/brand";

describe("geoIM3D brand contract", () => {
  it("exposes the approved product identity", () => {
    assert.equal(BRAND.productName, "geoIM3D");
    assert.equal(BRAND.localizedName, "지오아임3D");
    assert.equal(BRAND.version, "1.0.0");
    assert.equal(BRAND.companyName, "JBT");
    assert.equal(BRAND.slogan, "실감형 3D 플랫폼");
    assert.equal(BRAND.copyright, "Copyright © 2026 JBT. All Rights Reserved");
    assert.equal(BRAND.website, "https://www.ejbt.co.kr/");
  });

  it("exposes the approved design colors", () => {
    assert.deepEqual(BRAND.colors, {
      primary: "#0B365F",
      accent: "#33CC27",
      surface: "#FFFFFF",
      secondary: "#1039BD",
    });
  });

  it("preserves the GeoLibre attribution contract", () => {
    assert.equal(BRAND.upstream.name, "GeoLibre");
    assert.equal(BRAND.upstream.url, "https://github.com/opengeos/GeoLibre");
    assert.equal(BRAND.upstream.license, "MIT");
    assert.equal(BRAND.upstream.copyright, "Copyright (c) 2026 Qiusheng Wu");
  });
});
