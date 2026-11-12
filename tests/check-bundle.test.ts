import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleProblems } from "../engine/tools/check-bundle.ts";

const manifest = (distribution: string): string =>
  `id: a\nkind: adventure\nversion: 1.0.0\nsdk: ^1\nsystem: d6@^1\ndistribution: ${distribution}\n`;

describe("bundleProblems", () => {
  let dir = "";
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(
    resources: readonly string[] | Record<string, string>,
  ): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "check-bundle-"));
    await mkdir(join(dir, "plugins/adventures/open"), { recursive: true });
    await writeFile(
      join(dir, "plugins/adventures/open/plugin.yaml"),
      manifest("shipped"),
    );
    await mkdir(join(dir, "app"));
    const conf = join(dir, "app/tauri.conf.json");
    await writeFile(conf, JSON.stringify({ bundle: { resources } }));
    return conf;
  }

  it("passes shipped plugins", async () => {
    const conf = await setup({ "../plugins/adventures/": "plugins/" });
    expect(await bundleProblems(conf)).toEqual([]);
  });

  it("refuses a private plugin, a books/ path, a symlink and a glob", async () => {
    const conf = await setup([
      "../plugins/adventures/",
      "../books/adventures/",
      "../plugins/**/*.yaml",
    ]);
    await mkdir(join(dir, "plugins/adventures/mine"));
    await writeFile(
      join(dir, "plugins/adventures/mine/plugin.yaml"),
      manifest("private"),
    );
    await mkdir(join(dir, "books/adventures"), { recursive: true });
    await symlink(
      resolve(dir, "books/adventures"),
      join(dir, "plugins/adventures/linked"),
    );
    expect(await bundleProblems(conf)).toEqual([
      "../plugins/adventures/linked is a symlink",
      "../plugins/adventures/mine/plugin.yaml isn't distribution: shipped",
      "../books/adventures/ is in a private folder",
      "../plugins/**/*.yaml is a glob",
    ]);
  });
});
