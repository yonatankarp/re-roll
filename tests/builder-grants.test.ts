import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { abilityCheck } from "../plugins/systems/dnd5.5e/core/actions.ts";
import {
  choiceOptions,
  classStep,
  type Draft,
  finishedCharacter,
  levelChoices,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import { startCombat } from "../plugins/systems/dnd5.5e/core/combat/start.ts";
import { toolProficiencies } from "../plugins/systems/dnd5.5e/core/explore.ts";
import { ClassSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { type Actor, NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  checkBonus,
  deriveStats,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { swappable } from "../plugins/systems/dnd5.5e/core/swap.ts";
import { type Answers, hero, testRun, trait } from "./feat-fixtures.ts";

// Made-up features for #168's builder grants and passives: ids and mechanics only.
const FIXTURES = [
  trait("champion", [
    { kind: "scoreIncrease", abilities: ["str", "con"], amount: 4, max: 25 },
  ]),
  trait("scout", [
    {
      kind: "skillProficiency",
      skills: ["nature", "survival"],
      expertise: true,
    },
  ]),
  trait("forge", [{ kind: "armorTraining", armor: ["heavy"] }]),
  trait("swords", [{ kind: "weaponTraining", weapons: ["longsword"] }]),
  trait("bladesong", [
    { kind: "martialTraining", melee: true, without: ["twoHanded", "heavy"] },
  ]),
  trait("primal", [
    {
      kind: "checkAbility",
      ability: "str",
      skills: ["stealth"],
      while: ["test:feature/rage"],
    },
  ]),
  trait("rook", [{ kind: "initiativeRally", resource: "rally" }], {
    resources: [
      {
        id: "rally",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  }),
  {
    id: "test:item/maul",
    name: "Maul",
    type: "weapon",
    category: "martial",
    damage: { dice: "2d6", type: "bludgeoning" },
    properties: ["heavy", "twoHanded"],
    mastery: "topple",
  },
  {
    id: "test:subclass/dwarves-only",
    name: "Dwarves Only",
    class: "srd52:class/fighter",
    requires: ["srd52:species/dwarf"],
    levels: [{ level: 3, grants: [] }],
  },
];

async function grantsRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

// Picks through a level-1 draft's steps, taking `prefer`'s answer for a slot, else the first option, and the slots
// asked in order.
function fill(
  run: RunContext,
  start: Draft,
  prefer: Readonly<Record<string, string>> = {},
): { draft: Draft; slots: string[] } {
  let draft = start;
  const slots: string[] = [];
  for (let guard = 0; guard < 60; guard += 1) {
    const step = classStep(draft, null, run);
    if (!step) return { draft, slots };
    const slot = step.slot ?? step.key;
    slots.push(slot);
    const wanted = prefer[slot];
    const answer =
      wanted && step.options.some((option) => option.id === wanted)
        ? wanted
        : (step.options[0]?.id ?? "");
    draft = step.apply(draft, answer);
  }
  throw new Error("Too many steps");
}

const origin = (classId: string, speciesId = "srd52:species/dwarf"): Draft => ({
  classId,
  speciesId,
  backgroundId: "srd52:background/criminal",
  scores: ["dex", "con", "str", "wis", "int", "cha"],
  increase: "dex:2,con:1",
  picks: {},
});

let run: RunContext;
beforeAll(async () => {
  run = await grantsRun();
});

describe("builder grants (#168)", () => {
  it("asks a Rogue for Expertise among its skills, which doubles their bonus", () => {
    const rogue = lookup(run, ClassSchema, "srd52:class/rogue");
    const expertise = levelChoices(rogue, 1, undefined, run).find(
      (choice) => choice.id === "expertise",
    );
    expect(expertise).toMatchObject({
      kind: "skills",
      expertise: "proficient",
    });
    const { draft, slots } = fill(run, origin("srd52:class/rogue"), {
      expertise: "stealth",
    });
    expect(slots.indexOf("expertise")).toBeGreaterThan(slots.indexOf("skills"));
    // Only skills the Rogue is proficient in, from its class or its background.
    if (!expertise) throw new Error("No Expertise choice");
    const offered = choiceOptions(
      expertise,
      { ...draft, picks: { ...draft.picks, expertise: [] } },
      null,
      rogue,
      run,
    ).options.map((option) => option.id);
    const proficient = new Set([
      ...(draft.picks.skills ?? []),
      "sleightOfHand", // the Criminal's
      "stealth",
    ]);
    expect(offered.filter((skill) => !proficient.has(skill))).toEqual([]);
    const actor = finishedCharacter(PLAYER_ACTOR, "Rogue", draft, run);
    const stats = deriveStats(actor, run);
    expect(stats.expertise).toContain("stealth");
    expect(checkBonus(stats, actor, { ability: "dex", skill: "stealth" })).toBe(
      3 + 2 * stats.proficiency,
    );
  });

  it("asks a Cleric's Divine Order, and the Thaumaturge's own cantrip after it", () => {
    const { draft, slots } = fill(run, origin("srd52:class/cleric"), {
      "variant:srd52:feature/divine-order": "thaumaturge",
    });
    const cantrip = "variant:srd52:feature/divine-order:thaumaturge-cantrip";
    expect(slots).toContain(cantrip);
    const actor = finishedCharacter(PLAYER_ACTOR, "Cleric", draft, run);
    const stats = deriveStats(actor, run);
    const [extra = ""] = draft.picks[cantrip] ?? [];
    expect(stats.actions.some((action) => action.id.includes(extra))).toBe(
      true,
    );
    // The Wisdom modifier, at least 1, on Religion checks, which the Protector doesn't get.
    const protector = finishedCharacter(
      PLAYER_ACTOR,
      "Cleric",
      fill(run, origin("srd52:class/cleric"), {
        "variant:srd52:feature/divine-order": "protector",
      }).draft,
      run,
    );
    const religion = (who: Actor) =>
      abilityCheck(who, "religion", "int", 30, () => "", {
        state: { actors: { [who.id]: who }, combat: null },
        dice: { below: () => 0, roll: () => 10 },
        content: run.content,
        contentIds: run.contentIds,
      }).total;
    expect(religion(actor) - religion(protector)).toBeGreaterThanOrEqual(1);

    // The Protector trains with Heavy armor.
    const armored = {
      ...protector,
      inventory: [...protector.inventory, "srd52:item/chain-mail"],
    };
    expect(deriveStats(armored, run).untrainedArmor).toBe(false);
  });

  it("asks a Human for Skillful's skill and Versatile's origin feat", () => {
    const { slots } = fill(
      run,
      origin("srd52:class/fighter", "srd52:species/human"),
    );
    expect(slots).toEqual(
      expect.arrayContaining(["species-skillful", "species-versatile"]),
    );
  });

  it("offers a subclass only to the species it requires", () => {
    const fighter = lookup(run, ClassSchema, "srd52:class/fighter");
    const offered = (speciesId: string) =>
      choiceOptions(
        { kind: "subclass", id: "subclass" },
        origin("srd52:class/fighter", speciesId),
        null,
        fighter,
        run,
      ).options.map((option) => option.id);
    expect(offered("srd52:species/dwarf")).toContain(
      "test:subclass/dwarves-only",
    );
    expect(offered("srd52:species/human")).not.toContain(
      "test:subclass/dwarves-only",
    );
  });

  it("lets a Fighter change a weapon mastery after a Long Rest", () => {
    const answers: Answers = [
      {
        kind: "weaponMastery",
        values: [
          "srd52:item/longsword",
          "srd52:item/shortsword",
          "srd52:item/dagger",
        ],
      },
    ];
    const fighter = { ...hero([], { answers }), swaps: {}, swapped: [] };
    const picks = swappable(fighter, run).filter((item) =>
      item.owner.includes("weapon masteries"),
    );
    expect(picks.map((item) => item.values)).toEqual([
      ["srd52:item/longsword", "srd52:item/shortsword", "srd52:item/dagger"],
    ]);
    expect(picks[0]?.open).toBe(true);
  });
});

describe("passives for granted proficiencies (#168)", () => {
  it("raises scores past 20 to the feature's maximum", () => {
    const strong = {
      ...hero(["champion"]),
      raised: { str: 4 }, // 21 before the feature
    };
    const { abilities } = deriveStats(strong, run);
    expect(abilities.str).toBe(25);
    expect(abilities.con).toBe(18);
  });

  it("gives skills with Expertise, armor and weapon training, and scoped Martial training", () => {
    const scout = deriveStats(hero(["scout"]), run);
    expect(scout.skills).toEqual(expect.arrayContaining(["nature"]));
    expect(scout.expertise).toEqual(
      expect.arrayContaining(["nature", "survival"]),
    );
    // As a Wizard, who has no armor or Martial weapon training of its own.
    const wizard = (
      traits: readonly string[],
      inventory: readonly string[],
    ) => {
      const actor = hero(traits);
      const build =
        actor.source.kind === "character" ? actor.source.build : null;
      if (!build) throw new Error("No build");
      return {
        ...actor,
        inventory: [...inventory],
        source: {
          kind: "character" as const,
          build: {
            ...build,
            levels: build.levels.map((entry) => ({
              ...entry,
              classId: "srd52:class/wizard",
            })),
          },
        },
      };
    };
    const mail = ["srd52:item/chain-mail"];
    expect(deriveStats(wizard([], mail), run).untrainedArmor).toBe(true);
    expect(deriveStats(wizard(["forge"], mail), run).untrainedArmor).toBe(
      false,
    );
    // Proficiency adds to the attack roll's bonus.
    const toHit = (traits: readonly string[], weapon: string) => {
      const resolution = deriveStats(
        wizard(traits, [weapon]),
        run,
      ).actions.find((action) => action.id === `weapon:${weapon}`)?.activation
        .resolution;
      return resolution?.kind === "attack"
        ? resolution.attack.proficient !== false
        : undefined;
    };
    expect(toHit([], "srd52:item/longsword")).toBe(false);
    expect(toHit(["swords"], "srd52:item/longsword")).toBe(true);
    expect(toHit(["bladesong"], "srd52:item/longsword")).toBe(true);
    expect(toHit(["bladesong"], "test:item/maul")).toBe(false);
  });

  it("makes a check with Strength while raging, when it's better", () => {
    const sneak = {
      ...hero(["primal"]),
      activeEffects: [
        {
          sourceId: "feature:test:feature/rage:0",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "mark" as const },
          ends: "spellDuration" as const,
        },
      ],
    };
    const dice = { below: () => 0, roll: () => 10 };
    const context = {
      state: { actors: { [PLAYER_ACTOR]: sneak }, combat: null },
      dice,
      content: run.content,
      contentIds: run.contentIds,
    };
    // Strength 17 (+3) beats Dexterity 14 (+2) while the Rage lasts.
    expect(
      abilityCheck(sneak as Actor, "stealth", "dex", 30, () => "", context)
        .total,
    ).toBe(13);
    const calm = { ...sneak, activeEffects: [] };
    expect(
      abilityCheck(calm as Actor, "stealth", "dex", 30, () => "", {
        ...context,
        state: { actors: { [PLAYER_ACTOR]: calm }, combat: null },
      }).total,
    ).toBe(12);
  });

  it("gives the party Heroic Inspiration as a fight starts, once a Long Rest", () => {
    const rook = hero(["rook"]);
    const ally = hero([], { id: "companion-1" });
    const context = {
      state: {
        actors: { [rook.id]: rook, [ally.id]: ally },
        combat: null,
      },
      dice: createDice(rngFromSeed("rally")),
      content: run.content,
      contentIds: run.contentIds,
    };
    const started = startCombat(
      {
        id: "e",
        monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
      },
      context,
      { canFlee: false, defeatContinues: false },
    );
    const kinds = (started.events ?? []).map((event) =>
      "payload" in event
        ? `${event.kind}:${String((event.payload as { actor?: string }).actor)}`
        : event.kind,
    );
    expect(kinds).toContain(`${NS}:resourceSpent:${PLAYER_ACTOR}`);
    expect(kinds).toContain(`${NS}:inspirationGranted:${PLAYER_ACTOR}`);
    expect(kinds).toContain(`${NS}:inspirationGranted:companion-1`);
    const spent = { ...rook, resourcesSpent: { rally: 1 } };
    const again = startCombat(
      {
        id: "e",
        monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
      },
      {
        ...context,
        state: {
          ...context.state,
          actors: { [rook.id]: spent, [ally.id]: ally },
        },
      },
      { canFlee: false, defeatContinues: false },
    );
    expect(
      (again.events ?? []).some(
        (event) => event.kind === `${NS}:inspirationGranted`,
      ),
    ).toBe(false);
  });

  it("counts a tool picked as a proficiency", () => {
    const answers: Answers = [
      { kind: "tools", values: ["srd52:item/thieves-tools", "history"] },
    ];
    const actor = hero([], { answers });
    expect(deriveStats(actor, run).skills).toContain("history");
    expect(toolProficiencies(actor, run).size).toBeGreaterThan(0);
  });
});
