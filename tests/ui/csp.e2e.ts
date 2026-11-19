import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures.ts";

const { csp } = (
  JSON.parse(readFileSync("app/desktop/src-tauri/tauri.conf.json", "utf8")) as {
    app: { security: { csp: string } };
  }
).app.security;

// The watch every test relies on: the page carries the app's CSP, and what it blocks is reported.
test("serves the app's CSP and reports what it blocks", async ({
  page,
  problems,
}) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(csp);
  await expect(page.getByRole("heading").first()).toBeVisible();
  await page.evaluate(`(async () => {
    const style = document.createElement("style");
    style.textContent = "body { color: red }";
    document.head.append(style);
    await fetch("https://example.com/").catch(() => {});
  })()`);
  await expect
    .poll(() => problems.filter((text) => text.startsWith("CSP:")).length)
    .toBeGreaterThanOrEqual(2);
  expect(problems.join("\n")).toMatch(/style-src/);
  expect(problems.join("\n")).toMatch(/connect-src/);
  problems.length = 0; // expected here; any other test fails on one
});
