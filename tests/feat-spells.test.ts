import { describe, expect, it } from "vitest";
import {
  fueledDamage,
  schoolCastEvents,
} from "../plugins/systems/dnd5.5e/core/combat/school.ts";
import { NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  choiceOptions,
  levelEntry,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import { completeDraft } from "../plugins/systems/dnd5.5e/core/character-sheet.ts";
import { ClassSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  deriveStats,
  evaluateFormula,
  lookup,
  type Stats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  type Answers,
  contextOf,
  hero,
  scripted,
  testRun,
} from "./feat-fixtures.ts";

const BURNING_HANDS = "srd52:spell/burning-hands";

// The save DC of a spell action the character has, as its formula works out.
const dcOf = (stats: Stats, actionId: string): number | undefined => {
  const resolution = stats.actions.find(({ id }) => id === actionId)?.activation
    .resolution;
  return resolution?.kind === "save"
    ? evaluateFormula(resolution.dc, stats)
    : undefined;
};

describe("spell-table feats", () => {
  it("casts a feat's spells with the ability chosen for it, the one it raised, or the one of the feat it follows", async () => {
    const run = await testRun();
    const statsOf = (answers: Answers, level = 1) =>
      deriveStats(hero([], { level, answers }), run);
    // A fighter has no Spellcasting, so feat spells use its best of Int, Wis or Cha (Wis 12): DC 8 + 2 + 1.
    const best = statsOf([
      { kind: "feats", values: ["test:feat/chosen"] },
      { kind: "spells", values: [BURNING_HANDS] },
    ]);
    expect(dcOf(best, `spell:${BURNING_HANDS}`)).toBe(11);
    // Charisma 10 chosen for the feat: DC 10, and the free cast too.
    const chosen = statsOf([
      { kind: "feats", values: ["test:feat/chosen"] },
      { kind: "spellAbility", ability: "cha", feat: "test:feat/chosen" },
      {
        kind: "spells",
        values: [BURNING_HANDS],
        freeCast: true,
        feat: "test:feat/chosen",
      },
    ]);
    expect(dcOf(chosen, `spell:${BURNING_HANDS}`)).toBe(10);
    expect(dcOf(chosen, `spell:${BURNING_HANDS}:free`)).toBe(10);
    // Intelligence raised to 9 by the feat that gives the spell: DC 9.
    const raised = statsOf(
      [
        { kind: "feats", values: ["test:feat/touched"] },
        { kind: "abilities", increases: { int: 1 } },
      ],
      4,
    );
    expect(dcOf(raised, `spell:${BURNING_HANDS}`)).toBe(9);
    // A feat that follows another casts with the ability chosen for that one.
    const levels = hero([], { level: 4 });
    const build =
      levels.source.kind === "character" ? levels.source.build : null;
    if (!build) throw new Error("no build");
    const connoisseur = deriveStats(
      {
        ...levels,
        source: {
          kind: "character",
          build: {
            ...build,
            levels: build.levels.map((entry, index) =>
              index === 0
                ? {
                    ...entry,
                    answers: [
                      { kind: "feats", values: ["test:feat/chosen"] },
                      {
                        kind: "spellAbility",
                        ability: "cha",
                        feat: "test:feat/chosen",
                      },
                    ],
                  }
                : index === 3
                  ? {
                      ...entry,
                      answers: [
                        { kind: "feats", values: ["test:feat/connoisseur"] },
                        {
                          kind: "spells",
                          values: [BURNING_HANDS],
                          feat: "test:feat/connoisseur",
                        },
                      ],
                    }
                  : entry,
            ),
          },
        },
      },
      run,
    );
    expect(dcOf(connoisseur, `spell:${BURNING_HANDS}`)).toBe(10);
    // A species' choice: its traits' spells take it.
    const own = hero([]);
    const speciesBuild =
      own.source.kind === "character" ? own.source.build : null;
    if (!speciesBuild) throw new Error("no build");
    const species = deriveStats(
      {
        ...own,
        source: {
          kind: "character",
          build: {
            ...speciesBuild,
            speciesId: "test:species/gifted",
            levels: speciesBuild.levels.map((entry) => ({
              ...entry,
              answers: [
                {
                  kind: "spellAbility",
                  ability: "int",
                  feat: "test:species/gifted",
                },
              ],
            })),
          },
        },
      },
      run,
    );
    expect(dcOf(species, `spell:${BURNING_HANDS}`)).toBe(9);
  });

  it("offers spells from the feat's own table, from the list of the version of a feat taken, and asks the ability", async () => {
    const run = await testRun();
    const fighter = lookup(run, ClassSchema, "srd52:class/fighter");
    const draft = (feats: readonly string[]) =>
      ({
        picks: { feat: [...feats] },
        backgroundId: "test:background/plain",
      }) as never;
    const offered = (feats: readonly string[]) =>
      choiceOptions(
        {
          kind: "spells",
          id: "spell",
          count: 1,
          maxLevel: 1,
          listOf: "test:feat/initiate",
          from: [BURNING_HANDS, "srd52:spell/cure-wounds"],
        },
        draft(feats),
        null,
        fighter,
        run,
      ).options.map((item) => item.id);
    // Magic Initiate (Cleric) gives the Cleric's list: Cure Wounds is on it, Burning Hands isn't.
    expect(offered(["test:feat/initiate-cleric"])).toEqual([
      "srd52:spell/cure-wounds",
    ]);
    // Without a version taken, any list's.
    expect(offered([])).toEqual([BURNING_HANDS, "srd52:spell/cure-wounds"]);

    const actor = hero([]);
    const ability = choiceOptions(
      { kind: "spellAbility", id: "ability", from: ["int", "wis", "cha"] },
      draft([]),
      actor.source.kind === "character" ? actor.source.build : null,
      fighter,
      run,
    );
    expect(ability.options.map((item) => item.id)).toEqual([
      "int",
      "wis",
      "cha",
    ]);
    // A companion takes the best: Wisdom 12.
    expect(ability.prefer).toEqual(["wis"]);
  });

  it("gives an adept's table spells for the slot levels the character has", async () => {
    const run = await testRun();
    const wizard = (level: number) => {
      const actor = hero(["adept-table"], { level });
      const build =
        actor.source.kind === "character" ? actor.source.build : null;
      if (!build) throw new Error("no build");
      return deriveStats(
        {
          ...actor,
          source: {
            kind: "character",
            build: {
              ...build,
              levels: build.levels.map((entry) => ({
                ...entry,
                classId: "srd52:class/wizard",
              })),
            },
          },
        },
        run,
      ).actions.map(({ id }) => id);
    };
    expect(wizard(1)).toContain(`spell:${BURNING_HANDS}`);
    expect(wizard(1)).not.toContain("spell:srd52:spell/fear");
    expect(wizard(3)).toContain("spell:srd52:spell/fear");
  });

  it("rides on casting a spell of the adept's school with a slot", async () => {
    const run = await testRun();
    const MAGE_ARMOR = {
      id: "spell:srd52:spell/mage-armor",
      name: "Mage Armor",
      activation: {
        cost: ["action" as const, "slot" as const],
        targeting: { self: true as const },
        resolution: { kind: "automatic" as const, damage: [], effects: [] },
      },
      spellLevel: 1,
    };
    const cast = (traits: readonly string[], slot?: number, hp = 10) => {
      const actor = { ...hero(traits, { level: 3 }), hp };
      const { dice } = scripted([4, 6]);
      return schoolCastEvents(
        actor,
        MAGE_ARMOR,
        slot,
        contextOf(run, [actor], dice),
      ).map((event) => [event.kind, "payload" in event ? event.payload : null]);
    };
    expect(cast(["warding"], 2)).toEqual([
      [`${NS}:tempHpGained`, { actor: "player", amount: 4 }],
    ]);
    expect(cast(["warding"])).toEqual([]); // cast without a slot
    expect(cast(["augmenting"], 2)[0]?.[1]).toMatchObject({
      effect: {
        modifier: { kind: "bonus", to: "speed" },
        ends: "casterTurnEnd",
      },
    });
    // Two Hit Point Dice of 4 and 6, plus the slot's level 2, healed while hurt.
    expect(cast(["life"], 2, 5).map(([kind]) => kind)).toEqual([
      `${NS}:resourceSpent`,
      `${NS}:resourceSpent`,
      `${NS}:healed`,
    ]);
    expect(cast(["life"], 2, 5)[2]?.[1]).toMatchObject({ amount: 12 });

    const FIREBALL = { ...MAGE_ARMOR, id: "spell:srd52:spell/fireball" };
    const fuel = (used: readonly string[]) => {
      const actor = {
        ...hero(["fueled"], { level: 3 }),
        usedThisTurn: [...used],
      };
      return fueledDamage(
        actor,
        FIREBALL,
        contextOf(run, [actor], scripted([7, 3]).dice),
      ).bonus;
    };
    expect(fuel([])).toBe(10);
    expect(fuel(["fueled"])).toBe(0);
  });

  it("fills the ability a background's feat asks when the sheet completes a hero", async () => {
    const run = await testRun();
    const draft = completeDraft(
      {
        classId: "srd52:class/fighter",
        speciesId: "test:species/plain",
        backgroundId: "test:background/gifted",
        scores: [],
        picks: {},
      },
      "standard",
      run,
    );
    const { answers } = levelEntry(draft, null, run);
    // A companion's pick: the best of Int, Wis or Cha.
    expect(answers).toContainEqual(
      expect.objectContaining({
        kind: "spellAbility",
        feat: "test:feat/chosen",
      }),
    );
    expect(answers).toContainEqual(
      expect.objectContaining({ kind: "spells", feat: "test:feat/chosen" }),
    );
  });

  it("offers a feat only to a character that meets its scores, Spellcasting and armor training", async () => {
    const run = await testRun();
    const offered = (classId: string) => {
      const actor = hero([], { level: 3 });
      const build =
        actor.source.kind === "character" ? actor.source.build : null;
      if (!build) throw new Error("no build");
      const levels = build.levels.map((entry) => ({ ...entry, classId }));
      return choiceOptions(
        { kind: "feat", id: "feat", category: "general" },
        { picks: {}, scores: [] },
        { ...build, levels },
        lookup(run, ClassSchema, classId),
        run,
      ).options.map(({ id }) => id);
    };
    // The hero has Str 17, Int 8 and Wis 12; a fighter has heavy armor, a wizard Spellcasting.
    const fighter = offered("srd52:class/fighter");
    expect(fighter).toContain("test:feat/strong");
    expect(fighter).not.toContain("test:feat/clever");
    expect(fighter).not.toContain("test:feat/caster");
    const wizard = offered("srd52:class/wizard");
    expect(wizard).toContain("test:feat/caster");
    expect(wizard).not.toContain("test:feat/strong");
  });
});
