import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

// npm run test:ui builds the game and serves the build on a free port, with the desktop app's CSP
// (vite.config.ts's preview), so it runs beside npm run ui and other checkouts.
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") done(address.port);
        else fail(new Error("No port was given"));
      });
    });
  });
}

// Playwright loads this file again in each worker, so the port chosen first is handed down.
process.env.RE_ROLL_UI_PORT ??= String(await freePort());
const url = `http://127.0.0.1:${process.env.RE_ROLL_UI_PORT}`;

export default defineConfig({
  testDir: "tests/ui",
  testMatch: "*.e2e.ts", // not *.test.ts or *.spec.ts, which vitest would pick up
  forbidOnly: Boolean(process.env.CI),
  // A retry tells a flaky test from a broken one, and a test that passes only on its retry still fails the run.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: url, trace: "retain-on-failure" },
  // WebKit is the engine of the desktop app's webview on macOS and Linux; Chromium is Windows' WebView2.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `npm run ui:build && npx vite preview --config app/desktop/vite.config.ts --port ${process.env.RE_ROLL_UI_PORT}`,
    url,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
