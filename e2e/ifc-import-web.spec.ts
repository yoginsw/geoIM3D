import { expect, test } from "@playwright/test";

test("Web/PWA exposes no IFC UI, worker, or WASM request path", async ({ page }) => {
  const ifcRequests: string[] = [];
  page.on("request", (request) => {
    if (/web-ifc|ifc-conversion|IfcImportDialog/i.test(request.url())) {
      ifcRequests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await page.getByRole("button", { name: /Processing|프로세싱/ }).click();

  await expect(
    page.getByRole("menuitem", { name: /BIM\/IFC (Import|가져오기)/ }),
  ).toHaveCount(0);
  await expect(page.getByTestId("ifc-import-dialog")).toHaveCount(0);
  expect(ifcRequests).toEqual([]);
});
