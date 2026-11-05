import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const deterministicFiles = [
  "engine/kernel/**/*.ts",
  "engine/story/**/*.ts",
  "plugins/systems/*/core/**/*.ts",
  "tests/fixtures/system-d6/**/*.ts",
];

const nodeImports = {
  group: ["node:*", "fs", "fs/*", "path", "crypto", "os", "child_process"],
  message:
    "Deterministic code can't touch Node APIs. Use the Storage interface.",
};
const engineMustNotImport = {
  group: ["**/plugins/**", "**/app/**", "**/tests/**"],
  message: "The engine must not know about plugins or the app.",
};
const coreMustNotImportPlatform = {
  group: ["**/platform/**", "**/tools/**"],
  message: "Core engine code can't depend on platform code or tools.",
};
const systemMustNotImport = {
  group: ["**/engine/**", "**/plugins/**", "**/app/**"],
  message: "System plugins import only #sdk and their own folder.",
};

const restrictImports = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

export default defineConfig([
  globalIgnores([
    "node_modules/",
    "out/",
    "app/desktop/src-tauri/target/",
    "app/desktop/src-tauri/gen/",
    "eslint.config.js",
  ]),
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // projectService only finds files named tsconfig.json, so the configs are listed by name.
        project: [
          "./tsconfig.core.json",
          "./tsconfig.tools.json",
          "./tsconfig.test.json",
          "./tsconfig.ui.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: false },
      ],
    },
  },
  {
    files: ["engine/**/*.ts"],
    rules: restrictImports(engineMustNotImport),
  },
  {
    files: [
      "engine/kernel/**/*.ts",
      "engine/story/**/*.ts",
      "engine/sdk/**/*.ts",
      "engine/prep/**/*.ts",
      "engine/shell/**/*.ts",
    ],
    rules: restrictImports(
      engineMustNotImport,
      coreMustNotImportPlatform,
      nodeImports,
    ),
  },
  {
    files: [
      "plugins/systems/*/core/**/*.ts",
      "plugins/systems/*/ui/**/*.ts",
      "tests/fixtures/system-d6/**/*.ts",
    ],
    rules: restrictImports(systemMustNotImport, nodeImports),
  },
  {
    files: deterministicFiles,
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "Deterministic code can't read the clock." },
        { name: "fetch", message: "Deterministic code can't use the network." },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Use the seeded dice in game state.",
        },
        {
          property: "localeCompare",
          message: "Sort order can differ between JavaScript engines.",
        },
      ],
    },
  },
]);
