import { expect, test, type Page } from "@playwright/test";

async function expectMenuItemHidden(page: Page, name: string) {
  await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
}

test("switches the geoIM3D Korean light workspace between 3D and 2D tabs", async ({ page }) => {
  await page.goto("/?locale=ko&geoim3dProfile=1");

  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(page.locator("html")).toHaveAttribute("style", /light/);
  await expect(page.getByRole("textbox", { name: "프로젝트 이름" })).toHaveValue(
    "제목 없는 프로젝트",
  );

  const mapLibreTab = page.getByRole("tab", { name: "MapLibre 2D Pane" });
  const cesiumTab = page.getByRole("tab", { name: "Cesium 3D Globe" });
  await expect(cesiumTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("cesium-canvas")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("map-canvas")).toBeHidden();

  await mapLibreTab.click();
  await expect(mapLibreTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("cesium-canvas")).toBeHidden();

  await cesiumTab.click();
  await expect(page.getByTestId("cesium-canvas")).toBeVisible();
  await cesiumTab.press("ArrowLeft");
  await expect(mapLibreTab).toHaveAttribute("aria-selected", "true");
  await expect(mapLibreTab).toBeFocused();

  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expectMenuItemHidden(page, "언어");
  await expectMenuItemHidden(page, "인터페이스");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await expectMenuItemHidden(page, "공동 작업…");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "처리", exact: true }).click();
  await expectMenuItemHidden(page, "Python 콘솔");
  await expectMenuItemHidden(page, "Jupyter Notebook");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "컨트롤", exact: true }).click();
  await expectMenuItemHidden(page, "현장 수집...");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "명령 검색…" });
  await expect(search).toBeVisible();
  await search.fill("Python 콘솔");
  await expect(
    page.getByText("일치하는 명령이 없습니다", { exact: true }),
  ).toBeVisible();
});
