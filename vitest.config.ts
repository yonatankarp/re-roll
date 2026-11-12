import { configDefaults, defineConfig } from "vitest/config";

// unit: the fast suite over shipped content. soak: the same tests at full depth, with the books where present.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
    testTimeout: 60_000, // content over a real loopback server is slow when the machine is busy
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
