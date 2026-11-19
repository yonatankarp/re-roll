import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The book tools' command lines, run as `npm run` runs them, on made-up input and with no books/.
// Their logic is tested in import, store-pack and narration tests; these check the scripts around it.

const repo = resolve(import.meta.dirname, "..");
interface Ran {
  code: number;
  out: string;
}

function run(script: string, args: string[], cwd = repo): Promise<Ran> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(repo, "app/cli", script), ...args],
      { cwd, env: { ...process.env, RE_ROLL_ROOTS: "plugins" } },
      (error, stdout, stderr) => {
        done({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          out: `${stdout}${stderr}`,
        });
      },
    );
  });
}

let temp = "";
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = "";
});
async function folder(files: Record<string, string> = {}): Promise<string> {
  temp = await mkdtemp(join(tmpdir(), "re-roll-cli-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(temp, path)), { recursive: true });
    await writeFile(join(temp, path), text);
  }
  return temp;
}

describe("book tool command lines", () => {
  it("import shows its usage, and splits a source into entries", async () => {
    const usage = await run("import.ts", []);
    expect(usage.out).toMatch(/^Usage:/);
    const entry =
      "Twin\nLevel 2 Illusion (Wizard)\nCasting Time: Action\nRange: Self\nComponents: V\nDuration: Instantaneous\nText.\n";
    const dir = await folder({ "spells.txt": `${entry}${entry}` });
    const split = await run("import.ts", [
      "split",
      "--kind",
      "spells",
      "--input",
      join(dir, "spells.txt"),
    ]);
    expect(split.code).toBe(0);
    expect(split.out).toContain("Found 1 entries.");
    expect(split.out).toContain("Duplicates: 1.");
  });

  it("import:world writes nothing where there are no books", async () => {
    const dir = await folder();
    const ran = await run("import-world.ts", [], dir);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("Wrote nothing");
  });

  it("narrate lists the adventures, and refuses a voice it hasn't", async () => {
    const list = await run("narrate.ts", []);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/Adventures: .*goblin-ambush/);
    const voice = await run("narrate.ts", ["goblin-ambush", "--voice=nope"]);
    expect(voice).toEqual({ code: 1, out: "Unknown voice nope\n" });
  });

  it("store:pack writes a package's zip and the store's index", async () => {
    const root = await folder({
      "store.yaml":
        "packages:\n  - { id: fixture, title: Fixture, parts: [rules/fixture] }\n",
      "rules/fixture/plugin.yaml":
        "id: fixture\nkind: rules\nversion: 1.0.0\nsdk: ^1\nsystem: dnd5.5e@^1\ndistribution: private\n",
    });
    const out = join(root, "out");
    const usage = await run("store-pack.ts", [root]);
    expect(usage.code).toBe(1);
    expect(usage.out).toMatch(/^Usage:/);
    const ran = await run("store-pack.ts", [root, "--out", out]);
    expect(ran.code).toBe(0);
    expect((await readdir(out)).sort()).toEqual(["fixture.zip", "store.json"]);
    const index = JSON.parse(
      await readFile(join(out, "store.json"), "utf8"),
    ) as {
      packages: { id: string; plugins: { id: string }[] }[];
    };
    expect(index.packages.map((pkg) => pkg.id)).toEqual(["fixture"]);
    expect(index.packages[0]?.plugins.map((plugin) => plugin.id)).toEqual([
      "fixture",
    ]);
  });
});
