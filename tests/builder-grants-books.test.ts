import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import {
  choiceOptions,
  classStep,
  type Draft,
  levelChoices,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import { hitFits } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  type ChoiceDef,
  ClassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import type { Actor } from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";
import type { Answers } from "./feat-fixtures.ts";

const PLUGINS = [
  "phb",
  "xanathars-guide",
  "heroes-of-faerun",
  "eberron-forge-of-the-artificer",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

// A built character with these answers added to its first level, as a sample of #168's entries plays.
function withAnswers(actor: Actor, answers: Answers): Actor {
  const build = actor.source.kind === "character" ? actor.source.build : null;
  if (!build) throw new Error("No build");
  return {
    ...actor,
    source: {
      kind: "character",
      build: {
        ...build,
        levels: build.levels.map((entry, index) =>
          index === 0
            ? { ...entry, answers: [...entry.answers, ...answers] }
            : entry,
        ),
      },
    },
  };
}

describe.skipIf(!BOOKS)("the books' builder grants and passives", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "builder-grants-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  const classOf = (id: string) => lookup(run, ClassSchema, id);
  const ids = (choices: readonly ChoiceDef[]) => choices.map(({ id }) => id);

  it("asks Expertise of a Bard at levels 2 and 9 and a Rogue at 1 and 6, and Scholar of a Wizard", () => {
    const bard = classOf("phb:class/bard");
    expect(ids(levelChoices(bard, 2, undefined, run))).toContain("expertise");
    expect(ids(levelChoices(bard, 9, undefined, run))).toContain("expertise");
    const rogue = classOf("phb:class/rogue");
    expect(ids(levelChoices(rogue, 1, undefined, run))).toContain("expertise");
    expect(ids(levelChoices(rogue, 6, undefined, run))).toContain("expertise");
    expect(
      ids(levelChoices(classOf("phb:class/wizard"), 2, undefined, run)),
    ).toContain("scholar");
  });

  it("offers a Paladin a Fighting Style feat or Blessed Warrior's Cleric cantrips", () => {
    const paladin = classOf("phb:class/paladin");
    const asked = levelChoices(paladin, 2, undefined, run);
    const style = "variant:phb:feature/paladin-fighting-style";
    expect(ids(asked)).toContain(style);
    expect(ids(asked)).not.toContain("fighting-style");
    const base = levelTo(run, "phb:class/paladin", null, 1);
    const built = base.source.kind === "character" ? base.source.build : null;
    const draft: Draft = {
      classId: "phb:class/paladin",
      scores: [],
      picks: { [style]: ["blessed-warrior"] },
    };
    // The level's other picks first, then the variant's own.
    const stepTo = (start: Draft, slot: string) => {
      let current = start;
      for (let guard = 0; guard < 40; guard += 1) {
        const step = classStep(current, built, run);
        if (!step || step.slot === slot) return step;
        current = step.apply(current, step.options[0]?.id ?? "");
      }
      return null;
    };
    const cantrips = stepTo(draft, `${style}:blessed-warrior-cantrips`);
    expect(cantrips?.options.map((option) => option.id)).toContain(
      "phb:spell/sacred-flame",
    );
    const feat = stepTo(
      { ...draft, picks: { [style]: ["feat"] } },
      `${style}:feat-fighting-style`,
    );
    expect(feat?.options.map((option) => option.id)).toContain(
      "phb:feat/archery",
    );
  });

  it("masters only melee weapons as a Barbarian", () => {
    const barbarian = classOf("phb:class/barbarian");
    const mastery = levelChoices(barbarian, 1, undefined, run).find(
      (choice) => choice.kind === "weaponMastery",
    );
    if (!mastery) throw new Error("No Weapon Mastery choice");
    const offered = choiceOptions(
      mastery,
      {
        classId: barbarian.id,
        speciesId: "phb:species/human",
        backgroundId: "phb:background/acolyte",
        scores: ["str", "con", "dex", "wis", "int", "cha"],
        increase: "str:2,wis:1",
        picks: {},
      },
      null,
      barbarian,
      run,
    ).options.map((option) => option.id);
    expect(offered).toContain("phb:item/greataxe");
    expect(offered).not.toContain("phb:item/longbow");
  });

  it("raises a level 20 Barbarian's Strength and Constitution past 20", () => {
    const scores = (level: number) =>
      deriveStats(levelTo(run, "phb:class/barbarian", null, level), run)
        .abilities;
    const [before, after] = [scores(19), scores(20)];
    expect(after.str).toBe(Math.min(25, before.str + 4));
    expect(after.con).toBe(Math.min(25, before.con + 4));
    expect(after.dex).toBe(before.dex);
  });

  it("gives a Monk Evasion and an Assassin its kits", () => {
    const monk = deriveStats(levelTo(run, "phb:class/monk", null, 7), run);
    expect(monk.passives).toContainEqual({ kind: "evasion", anySave: false });
    const assassin = levelTo(
      run,
      "phb:class/rogue",
      "phb:subclass/rogue-assassin",
      3,
    );
    expect(assassin.inventory).toEqual(
      expect.arrayContaining([
        "phb:item/disguise-kit",
        "phb:item/poisoner-s-kit",
      ]),
    );
  });

  it("makes a Kensei's longbow a Monk weapon", () => {
    const monk = levelTo(run, "phb:class/monk", null, 3);
    const kensei = withAnswers({ ...monk, inventory: ["phb:item/longbow"] }, [
      { kind: "weapons", values: ["phb:item/longbow"], monk: true },
    ]);
    const shot = deriveStats(kensei, run).actions.find(
      (action) => action.id === "weapon:phb:item/longbow",
    );
    if (!shot) throw new Error("No longbow attack");
    expect(hitFits("monkWeapon", shot, kensei, run)).toBe(true);
    expect(hitFits("monkWeapon", shot, monk, run)).toBe(false);
  });
});
