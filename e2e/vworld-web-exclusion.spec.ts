import { expect, test } from "@playwright/test";

test("keeps VWorld plugin, protocol, network, and storage absent on Web/PWA", async ({
  page,
}) => {
  const vworldRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/vworld|geoim3d-vworld/i.test(url)) vworldRequests.push(url);
  });

  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByText("VWorld 지도", { exact: true })).toHaveCount(0);

  const storage = await page.evaluate(async () => {
    const local = Object.entries(localStorage);
    const session = Object.entries(sessionStorage);
    const cacheNames = "caches" in window ? await caches.keys() : [];
    const databaseNames =
      "databases" in indexedDB
        ? (await indexedDB.databases()).map((database) => database.name ?? "")
        : [];
    return { local, session, cacheNames, databaseNames };
  });

  expect(vworldRequests).toEqual([]);
  expect(JSON.stringify(storage)).not.toMatch(/vworld|geoim3d-vworld/i);
});
