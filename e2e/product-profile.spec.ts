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
  const cesiumCanvas = page.getByTestId("cesium-canvas");
  await expect(page.getByTestId("map-canvas")).toHaveCount(1);
  await expect(cesiumCanvas).toHaveCount(1);
  await expect(cesiumTab).toHaveAttribute("aria-selected", "true");
  await expect(cesiumCanvas).toHaveAttribute("data-active", "true");
  await expect(cesiumCanvas).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("map-canvas")).toBeHidden();

  await mapLibreTab.click();
  await expect(mapLibreTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
  await expect(cesiumCanvas).toBeHidden();
  await expect(cesiumCanvas).toHaveAttribute("data-active", "false");

  await cesiumTab.click();
  await expect(cesiumCanvas).toBeVisible();
  await expect(cesiumCanvas).toHaveAttribute("data-active", "true");
  const workspaceBox = await page.getByTestId("map-view-tabs").boundingBox();
  const cesiumBox = await cesiumCanvas.boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(cesiumBox).not.toBeNull();
  expect(cesiumBox!.width).toBeGreaterThanOrEqual(workspaceBox!.width - 1);
  expect(cesiumBox!.height).toBeGreaterThanOrEqual(workspaceBox!.height - 1);

  const renderCanvas = cesiumCanvas.locator("canvas").first();
  const renderBox = await renderCanvas.boundingBox();
  expect(renderBox).not.toBeNull();
  await page.mouse.move(
    renderBox!.x + renderBox!.width / 2,
    renderBox!.y + renderBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    renderBox!.x + renderBox!.width / 2 + 120,
    renderBox!.y + renderBox!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.waitForTimeout(1_000);

  await cesiumTab.press("ArrowLeft");
  await expect(mapLibreTab).toHaveAttribute("aria-selected", "true");
  await expect(mapLibreTab).toBeFocused();

  // Make the unsaved-changes contract deterministic. A renderer camera drag is
  // not guaranteed to update project state on every engine/frame timing.
  await page
    .getByRole("textbox", { name: "프로젝트 이름" })
    .fill("작업 중 프로젝트");

  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "새로 만들기...", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "현재 프로젝트를 저장하시겠습니까?" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

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
