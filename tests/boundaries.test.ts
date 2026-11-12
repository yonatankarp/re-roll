import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const IMPORT_PATTERN = /(?:from\s+|import\s*\(?\s*)["'](\.[^"']*)["']/g;

// Lint matches an import's text, so it can't tell whether "../../x" leaves the plugin's folder.
async function findEscapingImports(pluginRoot: string): Promise<string[]> {
  const root = resolve(pluginRoot);
  const escaping: string[] = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = join(entry.parentPath, entry.name);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? "";
      const target = resolve(dirname(file), specifier);
      if (target !== root && !target.startsWith(root + sep)) {
        escaping.push(`${file}: ${specifier}`);
      }
    }
  }
  return escaping;
}

async function systemPluginRoots(): Promise<string[]> {
  const systems = await readdir("plugins/systems", {
    withFileTypes: true,
  }).catch(() => []);
  return [
    "tests/fixtures/system-d6",
    ...systems
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("plugins/systems", entry.name)),
  ];
}

describe("system plugin boundaries", () => {
  it("keeps every system plugin's relative imports inside its own folder", async () => {
    for (const root of await systemPluginRoots()) {
      expect(await findEscapingImports(root)).toEqual([]);
    }
  });

  // Story and run build on the kernel, so the kernel importing either would make a cycle.
  it("keeps engine/kernel's imports inside engine/kernel", async () => {
    expect(await findEscapingImports("engine/kernel")).toEqual([]);
  });

  it("catches a relative import into another plugin", async () => {
    const base = await mkdtemp(join(tmpdir(), "re-roll-"));
    try {
      const core = join(base, "one", "core");
      await mkdir(core, { recursive: true });
      await writeFile(
        join(core, "a.ts"),
        'import { b } from "./b.ts";\nimport { other } from "../../two/core/x.ts";\nexport const v = [b, other];\n',
      );
      const escaping = await findEscapingImports(join(base, "one"));
      expect(escaping).toHaveLength(1);
      expect(escaping[0]).toContain("../../two/core/x.ts");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
