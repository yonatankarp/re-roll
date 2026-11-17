import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import {
  choiceOptions,
  levelChoices,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  ClassSchema,
  SubclassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { type Actor } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type Stats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #166's and #176's entries as the books encode them.

const PLUGINS = [
  "phb",
  "eberron-forge-of-the-artificer",
  "heroes-of-faerun",
  "xanathars-guide",
  "arcana-unleashed",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

const action = (stats: Stats, id: string) =>
  stats.actions.find((item) => item.id === id);

describe.skipIf(!BOOKS)("the books' class spellcasting features", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "spell-features-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });
  const stats = (actor: Actor) => deriveStats(actor, run);

  it("casts Paladin's Smite's Divine Smite once without a slot", () => {
    const paladin = stats(levelTo(run, "phb:class/paladin", null, 2));
    const free = action(paladin, "spell:phb:spell/divine-smite:free");
    expect(free?.activation.trigger).toEqual({ afterHit: "meleeWeapon" });
    expect(free?.activation.cost).not.toContain("slot");
  });

  it("keeps a domain's spells prepared from the Cleric level in its table", () => {
    const life = "phb:subclass/cleric-life-domain";
    const at = (level: number) =>
      stats(levelTo(run, "phb:class/cleric", life, level)).actions.map(
        (item) => item.id,
      );
    expect(at(3)).toContain("spell:phb:spell/bless");
    expect(at(3)).not.toContain("spell:phb:spell/revivify");
    expect(at(5)).toContain("spell:phb:spell/revivify");
  });

  it("gives an Eldritch Knight Wizard spell slots cast with Intelligence", () => {
    const knight = stats(
      levelTo(
        run,
        "phb:class/fighter",
        "phb:subclass/fighter-eldritch-knight",
        7,
      ),
    );
    expect(knight.slots).toEqual([4, 2]);
    expect(knight.spellAbility).toBe("int");
  });

  it("offers a Hexblade's expanded spells beside the Warlock's own", () => {
    const warlock = ClassSchema.parse(run.content("phb:class/warlock"));
    const hexblade = SubclassSchema.parse(
      run.content("xanathars-guide:subclass/warlock-the-hexblade"),
    );
    const choice = levelChoices(warlock, 3, hexblade.id, run).find(
      (item) => item.id === "spells",
    );
    if (!choice) throw new Error("no spells choice");
    const offered = choiceOptions(
      choice,
      { scores: [], picks: {}, backgroundId: "phb:background/acolyte" },
      null,
      warlock,
      run,
    ).options.map((item) => item.id);
    expect(offered).toContain("phb:spell/wrathful-smite");
    expect(offered).toContain("phb:spell/blur");
  });

  it("reaches a second creature with Words of Creation's Power Word Heal", () => {
    const bard = stats(levelTo(run, "phb:class/bard", null, 20));
    expect(
      action(bard, "spell:phb:spell/power-word-heal")?.activation.targeting,
    ).toMatchObject({ creatures: 2 });
  });
});
