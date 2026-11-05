import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanPlugins } from "../engine/kernel/loader.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";

describe("createNodeStorage", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "re-roll-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.yaml"), "stolen: true");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reads files and returns null for missing ones", async () => {
    await writeFile(join(root, "a.txt"), "hello");
    const storage = await createNodeStorage(root);
    expect(await storage.read("a.txt")).toBe("hello");
    expect(await storage.read("missing.txt")).toBeNull();
  });

  it("refuses paths that escape the root", async () => {
    const storage = await createNodeStorage(root);
    await expect(storage.read("../outside/secret.yaml")).rejects.toThrow(
      "escapes",
    );
    await expect(storage.replaceAtomically("../evil.txt", "x")).rejects.toThrow(
      "escapes",
    );
    await expect(storage.list("../outside")).rejects.toThrow("escapes");
  });

  it("refuses to read through a symlink that leaves the root", async () => {
    await symlink(join(outside, "secret.yaml"), join(root, "link.yaml"));
    const storage = await createNodeStorage(root);
    await expect(storage.read("link.yaml")).rejects.toThrow("escapes");
  });

  it("refuses to write through a linked folder that leaves the root", async () => {
    await symlink(outside, join(root, "linked"));
    const storage = await createNodeStorage(root);
    await expect(
      storage.replaceAtomically("linked/evil.txt", "x"),
    ).rejects.toThrow("escapes");
    expect(await readdir(outside)).toEqual(["secret.yaml"]);
  });

  it("reports symlinks without following them", async () => {
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "real.txt"), "real");
    await symlink(outside, join(root, "folder", "linked"));
    const storage = await createNodeStorage(root);
    expect(await storage.list("folder")).toEqual([
      { path: "folder/linked", symlink: true },
      { path: "folder/real.txt", symlink: false },
    ]);
  });

  it("returns an empty list for a missing folder", async () => {
    const storage = await createNodeStorage(root);
    expect(await storage.list("nowhere")).toEqual([]);
  });

  it("replaces files without leaving temporary files behind", async () => {
    const storage = await createNodeStorage(root);
    await storage.replaceAtomically("saves/run.json", "one");
    await storage.replaceAtomically("saves/run.json", "two");
    expect(await readFile(join(root, "saves", "run.json"), "utf8")).toBe("two");
    expect(await readdir(join(root, "saves"))).toEqual(["run.json"]);
  });

  it("makes the loader reject a real symlink inside a plugin", async () => {
    const plugin = join(root, "plugins", "rules", "linked");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, "plugin.yaml"),
      "id: linked\nkind: rules\nversion: 1.0.0\nsdk: ^1\nsystem: d6@^1\ndistribution: shipped\n",
    );
    await symlink(join(outside, "secret.yaml"), join(plugin, "stolen.yaml"));

    const catalog = await scanPlugins(await createNodeStorage(root), [
      "plugins",
    ]);
    expect(catalog.issues.map((issue) => issue.message)).toContain(
      "symlinks are not allowed",
    );
  });
});
