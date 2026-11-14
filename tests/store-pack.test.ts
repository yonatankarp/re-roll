import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planInstall } from "../engine/platform/tauri/install.ts";
import { StoreIndexSchema } from "../engine/shell/store-index.ts";
import { packStore } from "../engine/tools/store-pack.ts";

const manifest = (id: string, kind: string, requires = "") => `id: ${id}
kind: ${kind}
version: 1.2.0
sdk: ^1
system: dnd5.5e@^1
distribution: private
${requires}`;

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function store(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "re-roll-store-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const BOOK = {
  "rules/phb/plugin.yaml": manifest("phb", "rules"),
  "rules/phb/spells/fireball.yaml": "{}",
  "assets/phb/index.json": "{}",
  "assets/phb/p001.webp": "webp",
  "library/phb/0001-intro.md": "#",
  "library/glossary.json": "{}",
  "adventures/lost-mine/plugin.yaml": manifest(
    "lost-mine",
    "adventure",
    "requires:\n  - { plugin: phb, version: ^1 }\n",
  ),
  "assets/lost-mine/a.webp": "webp",
  "sources/phb.html": "the book's own text, never packed",
};

describe("packStore", () => {
  it("packs each package's folders into a zip the Store can install, and lists it", async () => {
    await store({
      ...BOOK,
      "store.yaml": `packages:
  - id: phb
    title: Player's Handbook
    parts: [rules/phb, assets/phb, library/phb, library/glossary.json]
  - id: lost-mine
    title: Lost Mine
    parts: [adventures/lost-mine]
`,
    });
    const { index, zips, unpacked } = await packStore(root);
    expect(StoreIndexSchema.parse(index)).toEqual(index);
    expect(
      index.packages.map(({ id, file, plugins }) => [id, file, plugins]),
    ).toEqual([
      [
        "phb",
        "phb.zip",
        [
          {
            id: "phb",
            kind: "rules",
            version: "1.2.0",
            distribution: "private",
            requires: [],
          },
        ],
      ],
      [
        "lost-mine",
        "lost-mine.zip",
        [
          {
            id: "lost-mine",
            kind: "adventure",
            version: "1.2.0",
            distribution: "private",
            requires: ["phb"],
          },
        ],
      ],
    ]);
    const phb = zips.get("phb.zip") ?? new Uint8Array();
    expect(index.packages[0]?.sha256).toBe(
      createHash("sha256").update(phb).digest("hex"),
    );
    expect(
      planInstall(phb, new Map()).parts.map(
        ({ folder, name }) => `${folder}/${name}`,
      ),
    ).toEqual([
      "rules/phb",
      "assets/phb",
      "library/phb",
      "library/glossary.json",
    ]);
    // The book's sources never leave, and the same files make the same zip.
    expect(unpacked).toEqual(["assets/lost-mine"]);
    expect((await packStore(root)).index).toEqual(index);
  });

  it("refuses a store.yaml whose packages overlap or name what isn't there", async () => {
    const yaml = (parts: string) =>
      `packages:\n  - { id: a, title: A, parts: [${parts}] }\n  - { id: b, title: B, parts: [rules/phb] }\n`;
    await store({ ...BOOK, "store.yaml": yaml("rules/phb") });
    await expect(packStore(root)).rejects.toThrow(/in both a and b/);
    await rm(root, { recursive: true });
    await store({ ...BOOK, "store.yaml": yaml("assets/nothing") });
    await expect(packStore(root)).rejects.toThrow(/isn't a folder/);
    await rm(root, { recursive: true });
    await store({ ...BOOK, "store.yaml": yaml("sources/phb") });
    await expect(packStore(root)).rejects.toThrow();
    await rm(root, { recursive: true });
    await store({
      ...BOOK,
      "assets/phb/notes.txt": "",
      "store.yaml": yaml("assets/phb"),
    });
    await expect(packStore(root)).rejects.toThrow(/a wouldn't install/);
  });

  it("refuses a symlink, which could reach outside the store", async () => {
    await store({
      ...BOOK,
      "store.yaml":
        "packages:\n  - { id: phb, title: P, parts: [assets/phb] }\n",
    });
    await symlink(join(root, "sources"), join(root, "assets/phb/link"));
    await expect(packStore(root)).rejects.toThrow(/symlink/);
  });
});
