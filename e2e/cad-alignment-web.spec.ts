import { expect, test } from "@playwright/test";

test("Web/PWA exposes no CAD alignment UI or sidecar request path", async ({
  page,
}) => {
  const cadRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/conversion/cad/read-dxf")) {
      cadRequests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await page.getByRole("button", { name: /Processing|프로세싱/ }).click();

  await expect(
    page.getByRole("menuitem", {
      name: /CAD\/GIS (Coordinate Alignment|좌표 정합)/,
    }),
  ).toHaveCount(0);
  await expect(page.getByTestId("cad-alignment-dialog")).toHaveCount(0);
  expect(cadRequests).toEqual([]);
});
