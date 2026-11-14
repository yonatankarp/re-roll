import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  type InstallPlan,
  describePlan,
  installPlan,
  planInstall,
} from "../engine/platform/tauri/install.ts";

const manifest = (id: string, kind = "adventure") => `id: ${id}
kind: ${kind}
version: 1.0.0
sdk: ^1
system: dnd5.5e@^1
distribution: private
`;
const MANIFEST = manifest("lost-mine");

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );

const none = new Map<string, string>();

// Each part as "<folder>/<name>" and its files' paths inside it, by name in the zip.
const shape = (plan: InstallPlan) =>
  plan.parts.map(({ folder, name, files }) => [
    `${folder}/${name}`,
    [...files],
  ]);

describe("planInstall", () => {
  it("places a plugin by its manifest, whether zipped flat or in its own folder", () => {
    const flat = planInstall(
      zip({ "plugin.yaml": MANIFEST, "scenes.yaml": "[]" }),
      none,
    );
    expect(shape(flat)).toEqual([
      [
        "adventures/lost-mine",
        [
          ["plugin.yaml", "plugin.yaml"],
          ["scenes.yaml", "scenes.yaml"],
        ],
      ],
    ]);

    // As macOS's Compress makes it: one top folder, named anything, with Finder's extras.
    const folded = planInstall(
      zip({
        "Lost Mine copy/plugin.yaml": MANIFEST,
        "Lost Mine copy/art/cave.png": "png",
        "Lost Mine copy/.DS_Store": "",
        "__MACOSX/Lost Mine copy/._plugin.yaml": "",
      }),
      none,
    );
    expect(shape(folded)).toEqual([
      [
        "adventures/lost-mine",
        [
          ["Lost Mine copy/plugin.yaml", "plugin.yaml"],
          ["Lost Mine copy/art/cave.png", "art/cave.png"],
        ],
      ],
    ]);
  });

  it("reads a zip whose folders are split by backslashes, as Windows PowerShell 5.1 makes them", () => {
    const plan = planInstall(
      zip({ "x\\plugin.yaml": MANIFEST, "x\\art\\cave.png": "png" }),
      none,
    );
    expect([...(plan.parts[0]?.files ?? [])]).toEqual([
      ["x\\plugin.yaml", "plugin.yaml"],
      ["x\\art\\cave.png", "art/cave.png"],
    ]);
  });

  it("installs a whole book laid out like the content folder, with the shared glossary", () => {
    const book = {
      "rules/phb/plugin.yaml": manifest("phb", "rules"),
      "rules/phb/spells/fireball.yaml": "{}",
      "assets/phb/index.json": "{}",
      "assets/phb/p001-0.webp": "webp",
      "library/phb/0001-intro.md": "#",
      "library/glossary.json": "{}",
    };
    const plan = planInstall(zip(book), none);
    expect(shape(plan)).toEqual([
      [
        "rules/phb",
        [
          ["rules/phb/plugin.yaml", "plugin.yaml"],
          ["rules/phb/spells/fireball.yaml", "spells/fireball.yaml"],
        ],
      ],
      [
        "assets/phb",
        [
          ["assets/phb/index.json", "index.json"],
          ["assets/phb/p001-0.webp", "p001-0.webp"],
        ],
      ],
      ["library/phb", [["library/phb/0001-intro.md", "0001-intro.md"]]],
      ["library/glossary.json", [["library/glossary.json", ""]]],
    ]);
    expect(describePlan(plan)).toBe("phb");

    // Zipping the content folder itself puts it all in one folder.
    const wrapped = planInstall(
      zip(
        Object.fromEntries(
          Object.entries(book).map(([name, text]) => [`plugins/${name}`, text]),
        ),
      ),
      none,
    );
    expect(wrapped.parts.map(({ name }) => name)).toEqual([
      "phb",
      "phb",
      "phb",
      "glossary.json",
    ]);
    expect(
      describePlan(planInstall(zip({ "assets/phb/a.webp": "" }), none)),
    ).toBe("phb");
  });

  it("replaces its own copy, but not a plugin of the same name elsewhere", () => {
    const archive = zip({ "plugin.yaml": MANIFEST });
    const at = (root: string) => () =>
      planInstall(archive, new Map([["lost-mine", root]]));
    expect(at("books/adventures/lost-mine")).not.toThrow();
    expect(at("books/rules/lost-mine")).toThrow(/already have/);
  });

  it("puts rules in rules/", () => {
    const rules = manifest("lost-mine", "rules");
    expect(
      planInstall(zip({ "plugin.yaml": rules }), none).parts[0]?.folder,
    ).toBe("rules");
  });

  it("refuses a zip that isn't valid game data", () => {
    const refused =
      (files: Record<string, string>, known = none) =>
      () =>
        planInstall(zip(files), known);
    expect(() => planInstall(strToU8("not a zip"), none)).toThrow(
      /isn't a zip/,
    );
    expect(refused({})).toThrow(/empty/);
    expect(refused({ "scenes.yaml": "[]" })).toThrow(/no plugin.yaml/);
    expect(
      refused({ "a/plugin.yaml": MANIFEST, "b/plugin.yaml": MANIFEST }),
    ).toThrow(/2 plugins/);
    expect(refused({ "a/b/plugin.yaml": MANIFEST })).toThrow(/too deep/);
    expect(refused({ "plugin.yaml": "id: [" })).toThrow(/valid YAML/);
    expect(refused({ "plugin.yaml": "id: lost-mine\n" })).toThrow(
      /valid plugin manifest/,
    );
    expect(
      refused(
        { "plugin.yaml": MANIFEST },
        new Map([["lost-mine", "plugins/adventures/lost-mine"]]),
      ),
    ).toThrow(/already ships/);
    expect(refused({ "plugin.yaml": MANIFEST, "run.sh": "" })).toThrow(
      /file type/,
    );
    expect(refused({ "plugin.yaml": MANIFEST, "page.svg": "" })).toThrow(
      /file type/,
    );
    expect(refused({ "a/plugin.yaml": MANIFEST, "b/x.yaml": "" })).toThrow(
      /outside the plugin's folder/,
    );
    expect(
      refused({ "plugin.yaml": MANIFEST, "art/../../../escape.yaml": "" }),
    ).toThrow(/isn't a path/);
    // A book's folders hold only their own kind of data, under names the game can use.
    expect(refused({ "assets/phb/notes.md": "" })).toThrow(/file type/);
    expect(refused({ "library/phb/cover.webp": "" })).toThrow(/file type/);
    expect(refused({ "assets/Big Book/a.webp": "" })).toThrow(/folder name/);
    expect(refused({ "assets/index.json": "" })).toThrow(/stray file/);
    expect(refused({ "rules/phb/spells.yaml": "" })).toThrow(/no plugin.yaml/);
    expect(
      refused({ "rules/phb/plugin.yaml": manifest("dmg", "rules") }),
    ).toThrow(/names rules\/dmg/);
    expect(
      refused({ "adventures/phb/plugin.yaml": manifest("phb", "rules") }),
    ).toThrow(/names rules\/phb/);
  });
});

describe("installPlan", () => {
  it("writes every part under a hidden name, then swaps them all in", async () => {
    const archive = zip({
      "adventures/lost-mine/plugin.yaml": MANIFEST,
      "assets/lost-mine/a.webp": "webp",
      "library/glossary.json": "{}",
    });
    const calls: [string, unknown][] = [];
    const call = (command: string, args?: unknown) => {
      calls.push([
        command,
        args instanceof Uint8Array ? new TextDecoder().decode(args) : args,
      ]);
      return Promise.resolve(
        command === "content_install_commit" &&
          (args as { folder: string }).folder === "assets",
      );
    };
    const replaced = await installPlan(
      archive,
      planInstall(archive, none),
      call as Parameters<typeof installPlan>[2],
    );
    expect(replaced).toBe(true);
    const plugin = { folder: "adventures", name: "lost-mine" };
    const art = { folder: "assets", name: "lost-mine" };
    const glossary = { folder: "library", name: "glossary.json" };
    expect(calls).toEqual([
      ["content_install_begin", plugin],
      ["content_install_begin", art],
      ["content_install_begin", glossary],
      ["content_install_file", `adventures/lost-mine/plugin.yaml\n${MANIFEST}`],
      ["content_install_file", "assets/lost-mine/a.webp\nwebp"],
      ["content_install_file", "library/glossary.json\n{}"],
      ["content_install_commit", plugin],
      ["content_install_commit", art],
      ["content_install_commit", glossary],
    ]);
  });
});
