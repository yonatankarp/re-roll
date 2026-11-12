import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { GameEvent } from "../engine/kernel/events.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { PluginManifestSchema } from "../engine/kernel/manifest.ts";
import { loadSave } from "../engine/run/save.ts";
import type { Storage } from "../engine/kernel/storage.ts";
import { createRunContext, startRun, step } from "../engine/run/turn.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { choiceOptions } from "../plugins/systems/dnd5.5e/core/character.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";
import { ClassSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { memoryStorage } from "./memory-storage.ts";

// Books here are stand-ins with the real books' ids. Their entries are copies of shipped SRD entries, so no book text is used.
const ADVENTURE = "goblin-ambush";

function manifest(
  id: string,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return stringify({
    id,
    kind: "rules",
    version: "1.0.0",
    sdk: "^1",
    system: "dnd5.5e@^1",
    distribution: "private",
    ...extra,
  });
}

const srdEntry = (folder: string, id: string): Record<string, unknown> => {
  const path = `plugins/rules/srd52/${folder}/core.yaml`;
  const entries = parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >[];
  const found = entries.find((entry) => entry.id === id);
  if (!found) throw new Error(`${id} isn't in ${path}`);
  return found;
};

// A book holding copies of the SRD's wizard and fire bolt under its own id.
function book(id: string, extra: Readonly<Record<string, unknown>> = {}) {
  const requires = [{ plugin: "srd52", version: "^1" }];
  return {
    [`plugins/rules/${id}/plugin.yaml`]: manifest(id, { requires, ...extra }),
    [`plugins/rules/${id}/classes/core.yaml`]: stringify([
      {
        ...srdEntry("classes", "srd52:class/wizard"),
        id: `${id}:class/wizard`,
      },
    ]),
    [`plugins/rules/${id}/spells/core.yaml`]: stringify([
      {
        ...srdEntry("spells", "srd52:spell/fire-bolt"),
        id: `${id}:spell/fire-bolt`,
      },
    ]),
  };
}

// The shipped plugins from disk, with the files given laid over them.
async function overlay(files: Readonly<Record<string, string>>) {
  const disk = await createNodeStorage(process.cwd());
  const memory = memoryStorage(files);
  const storage: Storage = {
    read: async (path) => (await memory.read(path)) ?? disk.read(path),
    replaceAtomically: () => Promise.reject(new Error("read-only")),
    list: async (prefix) => {
      const extra = await memory.list(prefix);
      const own = (await disk.list(prefix)).filter(
        (entry) => !extra.some((item) => item.path === entry.path),
      );
      return [...own, ...extra];
    },
  };
  return storage;
}

async function loadWith(
  books: Readonly<Record<string, string>>,
  adventure: Readonly<Record<string, unknown>> = {},
) {
  const requires = ["srd52", "phb", "basic-rules-2014"].map((plugin) => ({
    plugin,
    version: "^1",
  }));
  const storage = await overlay({
    ...books,
    [`plugins/adventures/${ADVENTURE}/plugin.yaml`]: stringify({
      id: ADVENTURE,
      kind: "adventure",
      version: "1.0.0",
      sdk: "^1",
      system: "dnd5.5e@^1",
      requires,
      distribution: "shipped",
      ...adventure,
    }),
  });
  const catalog = await scanPlugins(storage, ["plugins"]);
  return loadRun(storage, catalog, [dnd55e], [ADVENTURE]);
}

const BOOKS = { ...book("basic-rules-2014"), ...book("phb") };

async function winners(adventure: Readonly<Record<string, unknown>> = {}) {
  const loaded = await loadWith(BOOKS, adventure);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const { registry } = loaded;
  const run = createRunContext(registry, ADVENTURE);

  const answer = (decisionId: string, optionId: string) => ({
    kind: "answer" as const,
    decisionId,
    optionId,
  });
  const started = startRun(run, "precedence");
  const created = step(
    run,
    started.state,
    answer("dnd5.5e:chooseCharacter", "create"),
  );
  if (!created.ok) throw new Error(created.error);
  const classes = (created.pending?.options ?? [])
    .map((option) => option.id)
    .filter((id) => id.endsWith(":class/wizard"));

  const chosen = step(
    run,
    started.state,
    answer("dnd5.5e:chooseCharacter", "srd52:pregen/wizard"),
  );
  if (!chosen.ok) throw new Error(chosen.error);
  const event = chosen.events.find(
    (item: GameEvent) => item.kind === "dnd5.5e:characterChosen",
  );
  const payload = (event && "payload" in event ? event.payload : {}) as {
    readonly build?: { readonly levels: { readonly classId: string }[] };
  };

  const classDef = ClassSchema.parse(registry.content("srd52:class/wizard"));
  const { options } = choiceOptions(
    {
      kind: "spells",
      id: "cantrips",
      count: 1,
      list: classDef.id,
      maxLevel: 0,
    },
    { picks: {}, backgroundId: "srd52:background/sage" } as never,
    null,
    classDef,
    registry,
  );
  return {
    precedence: registry.precedence,
    classes,
    pregenClass: payload.build?.levels[0]?.classId,
    fireBolts: options
      .map((option) => option.id)
      .filter((id) => id.endsWith(":spell/fire-bolt")),
  };
}

describe("content precedence", () => {
  it("ranks the PHB over the SRD, and the SRD over a 2014 book", async () => {
    expect(await winners()).toEqual({
      precedence: [ADVENTURE, "phb", "srd52", "basic-rules-2014"],
      classes: ["phb:class/wizard"],
      pregenClass: "phb:class/wizard",
      fireBolts: ["phb:spell/fire-bolt"],
    });
  });

  it("lets an adventure's precedence win for its own run", async () => {
    expect(await winners({ precedence: ["srd52"] })).toEqual({
      precedence: [ADVENTURE, "srd52", "phb", "basic-rules-2014"],
      classes: ["srd52:class/wizard"],
      pregenClass: "srd52:class/wizard",
      fireBolts: ["srd52:spell/fire-bolt"],
    });
    const older = await winners({ precedence: ["basic-rules-2014"] });
    expect(older.classes).toEqual(["basic-rules-2014:class/wizard"]);
    expect(older.fireBolts).toEqual(["basic-rules-2014:spell/fire-bolt"]);
  });

  it("orders books by the system's default", () => {
    const rank = dnd55e.precedence;
    if (!rank) throw new Error("dnd5.5e sets no precedence");
    const ids = [
      "xanathars-guide",
      "srd52",
      "heroes-of-faerun",
      "dmg",
      "basic-rules-2014",
      "monster-manual",
      "phb",
    ];
    const order = (edition: Readonly<Record<string, string>> = {}) =>
      ids
        .map((id) =>
          PluginManifestSchema.parse(
            parse(manifest(id, edition[id] ? { edition: edition[id] } : {})),
          ),
        )
        .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1))
        .map((item) => item.id);
    expect(order()).toEqual([
      "phb",
      "monster-manual",
      "dmg",
      "heroes-of-faerun",
      "srd52",
      "basic-rules-2014",
      "xanathars-guide",
    ]);
    // A manifest's own edition wins over the system's guess.
    expect(
      order({ "heroes-of-faerun": "2014", "xanathars-guide": "2024" }),
    ).toEqual([
      "phb",
      "monster-manual",
      "dmg",
      "xanathars-guide",
      "srd52",
      "basic-rules-2014",
      "heroes-of-faerun",
    ]);
  });

  it("gives the same order whatever order the files are found in", async () => {
    const reversed = Object.fromEntries(Object.entries(BOOKS).reverse());
    const [first, second] = await Promise.all([
      loadWith(BOOKS),
      loadWith(reversed),
    ]);
    if (!first.ok || !second.ok) throw new Error("didn't load");
    expect(second.registry.contentIds()).toEqual(first.registry.contentIds());
    expect(second.registry.precedence).toEqual(first.registry.precedence);
  });

  it("reports a precedence that names an unloaded plugin, or sits on a rules plugin", async () => {
    const loaded = await loadWith(
      { ...BOOKS, ...book("phb", { precedence: ["srd52"] }) },
      { precedence: ["dmg"] },
    );
    expect(
      loaded.ok ? [] : loaded.issues.map((issue) => issue.message),
    ).toEqual([
      "only an adventure can set precedence",
      'precedence names "dmg", which this run doesn\'t load',
    ]);
  });

  it("still loads a save made before precedence", async () => {
    const storage = await createNodeStorage(process.cwd());
    const catalog = await scanPlugins(storage, ["plugins"]);
    const loaded = await loadRun(storage, catalog, [dnd55e], [ADVENTURE]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const run = createRunContext(loaded.registry, ADVENTURE);
    const text = readFileSync(
      "tests/fixtures/goblin-ambush-save-before-precedence.json",
      "utf8",
    );
    const result = loadSave(text, loaded.registry, run);
    expect(result.ok ? "" : result.error).toBe("");
  });

  // Shipped runs keep the alphabetical order they had before, so replaying their saves picks the same options.
  it.each(["goblin-ambush", "haunted-house"])(
    "keeps %s's content in id order",
    async (adventure) => {
      const storage = await createNodeStorage(process.cwd());
      const catalog = await scanPlugins(storage, ["plugins"]);
      const loaded = await loadRun(storage, catalog, [dnd55e], [adventure]);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      const ids = loaded.registry.contentIds();
      expect(ids).toEqual([...ids].sort());
    },
  );
});
