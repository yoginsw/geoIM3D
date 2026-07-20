import { expect, test } from "@playwright/test";

test("Web/PWA exposes no Earthwork UI, worker, TIFF decoder, or native command", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/earthwork|read_earthwork_geotiff|earthwork-analysis\.worker/i.test(request.url())) {
      requests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await page.getByRole("button", { name: /Processing|프로세싱/ }).click();

  await expect(page.getByRole("menuitem", { name: /토공량|절성토|Earthwork/i })).toHaveCount(0);
  await expect(page.getByTestId("earthwork-analysis-dialog")).toHaveCount(0);
  expect(requests).toEqual([]);
});
