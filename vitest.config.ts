import { configDefaults, defineConfig } from "vitest/config";

// unit: the fast suite over shipped content. soak: the same tests at full depth, with the books where present.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
    testTimeout: 60_000, // content over a real loopback server is slow when the machine is busy
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["{engine,plugins,app}/**/*.{ts,js}"],
      exclude: ["app/desktop/src-tauri/**"], // Rust build output, once the app is built
      reporter: ["text-summary", "html"],
      // Just under the numbers of November 2026. Raise them as coverage grows; CI's coverage job reports a miss.
      thresholds: {
        "engine/run/**": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "engine/kernel/**": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "plugins/systems/dnd5.5e/core/combat{.ts,/**}": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
    projects: [
      {
        extends: true,
        test: { name: "unit", env: { RE_ROLL_ROOTS: "plugins" } },
      },
      {
        extends: true,
        test: { name: "soak", env: { RE_ROLL_SOAK: "1" } },
      },
    ],
  },
});
