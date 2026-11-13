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
      reporter: ["text-summary", "html"],
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
