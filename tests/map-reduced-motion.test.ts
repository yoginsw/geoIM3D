import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("MapLibre reduced-motion constructor contract", () => {
  const constructors = [
    ["packages/map/src/map-controller.ts", 1],
    ["apps/geolibre-desktop/src/components/storymap/StoryMapPresenter.tsx", 1],
    ["apps/geolibre-desktop/src/lib/storymap-export.ts", 2],
  ] as const;

  for (const [path, expected] of constructors) {
    it(`sets reduceMotion=true for every Map constructor in ${path}`, () => {
      const source = readFileSync(path, "utf8");
      assert.equal(
        (source.match(/new maplibregl\.Map\s*\(/g) ?? []).length,
        expected
      );
      assert.equal(
        (source.match(/reduceMotion\s*:\s*true/g) ?? []).length,
        expected
      );
    });
  }
});
