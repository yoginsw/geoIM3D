import { expect, test } from "@playwright/test";

test("shows the approved geoIM3D brand and attribution", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("geoIM3D");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#0B365F",
  );

  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: "About" }).click();
  const dialog = page.getByRole("dialog");

  await expect(dialog.getByRole("heading", { name: "About geoIM3D" })).toBeVisible();
  await expect(dialog).toContainText("geoIM3D 1.0.0");
  await expect(dialog).toContainText("Copyright © 2026 JBT. All Rights Reserved");
  await expect(dialog).toContainText("Based on GeoLibre · MIT License");
  await expect(dialog.getByRole("link", { name: /JBT website/ })).toHaveAttribute(
    "href",
    "https://www.ejbt.co.kr/",
  );
  await expect(
    dialog.getByRole("link", { name: /Original GeoLibre project/ }),
  ).toHaveAttribute("href", "https://github.com/opengeos/GeoLibre");
});
