import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

// npm run test:ui serves the game on a free port, so it runs beside npm run ui and other checkouts.
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
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: url, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run ui -- --port ${process.env.RE_ROLL_UI_PORT}`,
    url,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
