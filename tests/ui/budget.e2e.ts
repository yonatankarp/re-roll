import { expect, test } from "./fixtures.ts";

// What the menu costs to open: the code, styles and fonts it loads (1.6 MB in November 2026), and
// how long until it can be used. The narrator's worker and WASM (over 20 MB) load only when asked for.
const MAX_BYTES = 2.5 * 1024 ** 2;
const MAX_MS = 10_000; // loose, for a busy CI runner; a slow start is several times this

test("opens the menu within its size and time budget", async ({ page }) => {
  const sizes: Promise<number>[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/assets/"))
      sizes.push(response.body().then((body) => body.length));
  });
  const started = Date.now();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Ambush on the Old Road" }),
  ).toBeVisible({ timeout: MAX_MS });
  expect(Date.now() - started).toBeLessThan(MAX_MS);
  await page.waitForLoadState("networkidle");
  const total = (await Promise.all(sizes)).reduce((sum, size) => sum + size, 0);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThan(MAX_BYTES);
});
