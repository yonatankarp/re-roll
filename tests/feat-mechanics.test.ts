import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { choiceOptions } from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  DEATH_SAVE,
  DECLINE,
} from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { rollSave } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { restFrames } from "../plugins/systems/dnd5.5e/core/rest.ts";
import { rollD20 } from "../plugins/systems/dnd5.5e/core/rules.ts";
import {
  type CharacterBuild,
  ClassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  canAfford,
  findAction,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { weaponDamageDice } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";

// Made-up traits and feats for the shared mechanics feats and species use: ids and mechanics only.
const trait = (id: string, passives: readonly object[], extra = {}) => ({
  id: `test:feature/${id}`,
  name: id,
  text: "Test.",
  automation: "full",
  passives,
  ...extra,
});
const FIXTURES = [
  {
    id: "test:species/plain",
    name: "Plain",
    text: "A test species.",
    creatureType: "Humanoid",
    size: "medium",
    speed: 30,
    traits: [],
  },
  trait("luck", [{ kind: "rerollOnes" }]),
  trait("savage", [{ kind: "savageAttacker" }]),
  trait("defy-death", [{ kind: "deathSaveAdvantage" }]),
  trait("great-weapon", [{ kind: "greatWeaponFighting" }]),
  trait("adept", [{ kind: "energyMastery", damage: "fire" }]),
  trait("overcome", [
    {
      kind: "overcomeResistance",
      damage: ["bludgeoning", "piercing", "slashing"],
    },
  ]),
  trait("slashproof", [
    { kind: "modifier", modifier: { kind: "resistance", damage: "slashing" } },
  ]),
  trait("armored", [
    {
      kind: "armoredReduction",
      armor: "heavy",
      damage: ["bludgeoning", "piercing", "slashing"],
      amount: { add: [{ kind: "proficiency" }] },
    },
  ]),
  trait("hamstring", [
    {
      kind: "damageRider",
      damage: "slashing",
      oncePerTurn: true,
      effects: [
        {
          kind: "modifier",
          duration: { until: "yourNextTurnStart" },
          modifier: {
            kind: "bonus",
            to: "speed",
            amount: { bonus: { base: 10 } },
            subtract: true,
          },
        },
      ],
    },
  ]),
  trait("sharpshooter", [
    { kind: "firingInMelee", attack: "weapon", bypassCover: true },
  ]),
  trait("protector", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { allyAttacked: true, holding: "shield" },
        targeting: { creatures: 1, range: 5, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              duration: { until: "yourNextTurnStart" },
              modifier: { kind: "disadvantage", on: "attacksAgainst" },
            },
          ],
        },
      },
    ],
  }),
  trait("interceptor", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { allyHit: true, holding: "shieldOrWeapon" },
        targeting: { creatures: 1, range: 5, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "reduceDamage",
              amount: {
                dice: "1d10",
                bonus: { add: [{ kind: "proficiency" }] },
              },
            },
          ],
        },
      },
    ],
  }),
  trait("fireproof", [
    { kind: "modifier", modifier: { kind: "resistance", damage: "fire" } },
  ]),
  {
    id: "test:item/maul",
    name: "Maul",
    type: "weapon",
    category: "martial",
    damage: { dice: "2d6", type: "bludgeoning" },
    properties: ["heavy", "twoHanded"],
    mastery: "push",
  },
  trait("rally", [
    {
      kind: "restTempHp",
      rests: ["short"],
      amount: { add: [{ kind: "level" }] },
      allies: true,
    },
  ]),
  trait("gift", [], {
    spells: { 1: ["srd52:spell/burning-hands"] },
    freeCast: true,
  }),
  trait("sturdy", [{ kind: "saveProficiency", increased: true }]),
  trait("blessed", [], {
    spells: { 1: ["srd52:spell/bless"] },
    freeCast: true,
  }),
  {
    id: "test:feat/sturdy",
    name: "Sturdy",
    category: "general",
    text: "Test.",
    grants: ["test:feature/sturdy"],
    abilityIncrease: ["wis", "cha"],
  },
  ...(
    [
      ["test:feat/initiate", "Initiate"],
      ["test:feat/initiate-cleric", "Initiate (Cleric)"],
      ["test:feat/initiated", "Initiated"],
    ] as const
  ).map(([id, name]) => ({
    id,
    name,
    category: "origin",
    text: "Test.",
  })),
  ...(
    [
      ["test:feat/gift", "Gift", "darkGift", { grants: ["test:feature/luck"] }],
      ["test:feat/kin", "Kin", "racial", { requires: ["test:species/plain"] }],
      ["test:feat/far", "Far", "racial", { requires: ["test:species/far"] }],
      ["test:feat/mark", "Mark", "dragonmark", {}],
      ["test:feat/other-mark", "Other Mark", "dragonmark", {}],
      [
        "test:feat/greater",
        "Greater",
        "general",
        { requires: ["test:feat/mark"] },
      ],
      [
        "test:feat/steady",
        "Steady",
        "origin",
        { grants: ["test:feature/savage"] },
      ],
    ] as const
  ).map(([id, name, category, extra]) => ({
    id,
    name,
    category,
    text: "Test.",
    ...extra,
  })),
  {
    id: "test:background/haunted",
    name: "Haunted",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/steady",
    skills: ["athletics", "survival"],
    tool: "Test Tools",
    featOr: "darkGift",
  },
  {
    id: "test:background/plain",
    name: "Plain",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/initiated",
    skills: ["athletics", "survival"],
    tool: "Test Tools",
  },
];

async function testRun(): Promise<RunContext> {
  const { run } = await loadAdventure("goblin-ambush");
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

type Answers = CharacterBuild["levels"][number]["answers"];

function hero(
  traits: readonly string[],
  {
    level = 1,
    answers = [] as Answers,
    id = PLAYER_ACTOR,
    background = "test:background/plain",
  } = {},
): Actor {
  const build: CharacterBuild = {
    baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    speciesId: "test:species/plain",
    backgroundId: background,
    backgroundIncrease: { str: 2, con: 1 },
    levels: Array.from({ length: level }, (_, index) => ({
      classId: "srd52:class/fighter",
      hitPointGain: 10,
      answers: [
        ...(index === 0
          ? [
              {
                kind: "features" as const,
                values: traits.map((name) => `test:feature/${name}`),
              },
            ]
          : []),
        ...(index === level - 1 ? answers : []),
      ],
    })),
  };
  return freshActor({
    id,
    name: "Hero",
    side: "party",
    source: { kind: "character", build },
    hp: 10,
    inventory: ["srd52:item/longsword"],
  });
}

// Dice that give these rolls in turn, then 10s, and count how often each die is rolled.
function scripted(rolls: readonly number[]) {
  const queue = [...rolls];
  const counts: Record<number, number> = {};
  const dice: Dice = {
    below: () => 0,
    roll: (sides) => {
      counts[sides] = (counts[sides] ?? 0) + 1;
      return queue.shift() ?? 10;
    },
  };
  return { dice, counts };
}

function contextOf(run: RunContext, actors: readonly Actor[], dice: Dice) {
  const state: DndState = {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
    },
  };
  return { state, dice, content: run.content, contentIds: run.contentIds };
}

describe("shared feat and species mechanics", () => {
  it("rolls a 1 on the d20 again when a trait says so, and the new roll stands", async () => {
    expect(rollD20(scripted([1, 15]).dice, NO_EDGE).natural).toBe(1);
    expect(
      rollD20(scripted([1, 15]).dice, { ...NO_EDGE, rerollOnes: true }).natural,
    ).toBe(15);
    const run = await testRun();
    const saves = (traits: readonly string[]) => {
      const actor = hero(traits);
      const { dice } = scripted([1, 15]);
      return rollSave(actor, "dex", 12, contextOf(run, [actor], dice)).saved;
    };
    expect(saves(["luck"])).toBe(true);
    expect(saves([])).toBe(false);
  });

  it("rolls a weapon's damage dice twice once a turn with Savage Attacker", async () => {
    const run = await testRun();
    const d8s = (traits: readonly string[], used: readonly string[] = []) => {
      const attacker = { ...hero(traits), usedThisTurn: [...used] };
      const target = { ...hero([], { id: "foe" }), side: "enemy" as const };
      const { dice, counts } = scripted([]);
      run.system.frames[`${NS}:applyHit`]?.run(
        {
          attacker: PLAYER_ACTOR,
          actionId: "weapon:srd52:item/longsword",
          target: "foe",
          critical: false,
          hadAdvantage: false,
          total: 20,
          natural: 15,
        },
        contextOf(run, [attacker, target], dice),
      );
      return counts[8] ?? 0;
    };
    expect(d8s([])).toBe(1);
    expect(d8s(["savage"])).toBe(2);
    expect(d8s(["savage"], ["savage-attacker"])).toBe(1);
  });

  it("counts a 1 or 2 on a Two-Handed weapon's damage die as a 3 with Great Weapon Fighting", async () => {
    const run = await testRun();
    const ones: Dice = { below: () => 0, roll: () => 1 };
    const rolled = (traits: readonly string[], weapon: string) =>
      weaponDamageDice(
        ones,
        `weapon:${weapon}`,
        deriveStats(hero(traits), run),
        run,
      ).roll(6);
    expect(rolled(["great-weapon"], "test:item/maul")).toBe(3);
    expect(rolled(["great-weapon"], "srd52:item/longsword")).toBe(1);
    expect(rolled([], "test:item/maul")).toBe(1);
  });

  it("lets a spell of the mastered type ignore Resistance and count a 1 as a 2, as Elemental Adept does", async () => {
    const run = await testRun();
    const dealt = (traits: readonly string[]) => {
      const caster = hero(traits, {
        answers: [{ kind: "spells", values: ["srd52:spell/fire-bolt"] }],
      });
      const target = {
        ...hero(["fireproof"], { id: "foe" }),
        side: "enemy" as const,
        hp: 30,
      };
      const ones: Dice = { below: () => 0, roll: () => 1 };
      const events =
        run.system.frames[`${NS}:applyHit`]?.run(
          {
            attacker: PLAYER_ACTOR,
            actionId: "spell:srd52:spell/fire-bolt",
            target: "foe",
            critical: false,
            hadAdvantage: false,
            total: 20,
            natural: 15,
          },
          contextOf(run, [caster, target], ones),
        ).events ?? [];
      return events.flatMap((event) =>
        event.kind === `${NS}:damaged`
          ? [(event.payload as { amount: number }).amount]
          : [],
      );
    };
    expect(dealt(["adept"])).toEqual([2]);
    // Halved by Resistance, the 1 deals nothing.
    expect(dealt([])).toEqual([]);
  });

  it("takes an ally's Protection or Interception on its own when a foe attacks or hits a creature beside it", async () => {
    const run = await testRun();
    const attack = (
      guardTraits: readonly string[],
      inventory: string[],
      rolls = [15, 15],
    ) => {
      const foe = { ...hero([], { id: "foe" }), side: "enemy" as const };
      const friend = hero([], { id: "friend" });
      const guard = { ...hero(guardTraits, { id: "guard" }), inventory };
      const { dice, counts } = scripted(rolls);
      const context = contextOf(run, [foe, friend, guard], dice);
      const result = run.system.frames[`${NS}:attackRoll`]?.run(
        {
          attacker: "foe",
          actionId: "weapon:srd52:item/longsword",
          target: "friend",
        },
        context,
      );
      const labels = (result?.events ?? []).flatMap((event) =>
        event.kind === `${NS}:budgetSpent`
          ? [(event.payload as { label?: string }).label]
          : [],
      );
      const hit = result?.frames?.find((item) => item.kind === `${NS}:applyHit`)
        ?.payload as { reduceBy?: number } | undefined;
      return { d20s: counts[20], labels, reduceBy: hit?.reduceBy };
    };
    const shield = ["srd52:item/shield"];
    expect(attack(["protector"], shield)).toMatchObject({
      d20s: 2,
      labels: ["protector"],
    });
    // Protection needs a Shield in hand.
    expect(attack(["protector"], ["srd52:item/longsword"]).d20s).toBe(1);
    // A 4 on the d10 plus a Proficiency Bonus of 2.
    expect(
      attack(["interceptor"], ["srd52:item/longsword"], [15, 4]),
    ).toMatchObject({
      d20s: 1,
      labels: ["interceptor"],
      reduceBy: 6,
    });
    expect(attack([], shield)).toMatchObject({ d20s: 1, labels: [] });
    // A target that declines a reaction of its own still gets the ally's Interception.
    const declined = run.system.frames[`${NS}:afterReaction`]?.run(
      {
        attacker: "foe",
        actionId: "weapon:srd52:item/longsword",
        target: "friend",
        critical: false,
        hadAdvantage: false,
        total: 20,
        natural: 15,
        answer: DECLINE,
      },
      contextOf(
        run,
        [
          { ...hero([], { id: "foe" }), side: "enemy" as const },
          hero([], { id: "friend" }),
          hero(["interceptor"], { id: "guard" }),
        ],
        scripted([4]).dice,
      ),
    );
    expect(declined?.events?.map((event) => event.kind)).toContain(
      `${NS}:budgetSpent`,
    );
    expect(declined?.frames?.[0]?.payload).toMatchObject({ reduceBy: 6 });
  });

  it("lessens, rides on and overcomes a weapon hit's damage, as Heavy Armor Master, Slasher and Irresistible Offense do", async () => {
    const run = await testRun();
    const swing = (
      attackerTraits: readonly string[],
      targetTraits: readonly string[],
      armor: readonly string[] = [],
    ) => {
      const attacker = hero(attackerTraits);
      const target = {
        ...hero(targetTraits, { id: "foe" }),
        side: "enemy" as const,
        hp: 30,
        inventory: [...armor],
      };
      const ones: Dice = { below: () => 0, roll: () => 1 };
      const context = contextOf(run, [attacker, target], ones);
      const events =
        run.system.frames[`${NS}:applyHit`]?.run(
          {
            attacker: PLAYER_ACTOR,
            actionId: "weapon:srd52:item/longsword",
            target: "foe",
            critical: false,
            hadAdvantage: false,
            total: 20,
            natural: 15,
          },
          context,
        ).events ?? [];
      const after = events.reduce(applyDndEvent, context.state);
      return {
        damage: events.flatMap((event) =>
          event.kind === `${NS}:damaged`
            ? [(event.payload as { amount: number }).amount]
            : [],
        ),
        speed: deriveStats(after.actors.foe ?? target, run).speed,
      };
    };
    // A 1 on the d8 plus a Strength modifier of 3.
    expect(swing([], []).damage).toEqual([4]);
    expect(swing([], ["armored"], ["srd52:item/chain-mail"]).damage).toEqual([
      2,
    ]);
    expect(swing([], ["armored"]).damage).toEqual([4]);
    expect(swing([], ["slashproof"]).damage).toEqual([2]);
    expect(swing(["overcome"], ["slashproof"]).damage).toEqual([4]);
    expect(swing(["hamstring"], []).speed).toBe(swing([], []).speed - 10);
  });

  it("shoots beside an enemy without Disadvantage with Sharpshooter", async () => {
    const run = await testRun();
    const d20s = (traits: readonly string[]) => {
      const archer = { ...hero(traits), inventory: ["srd52:item/shortbow"] };
      const foe = { ...hero([], { id: "foe" }), side: "enemy" as const };
      const { dice, counts } = scripted([15, 15]);
      run.system.frames[`${NS}:attackRoll`]?.run(
        {
          attacker: PLAYER_ACTOR,
          actionId: "weapon:srd52:item/shortbow",
          target: "foe",
        },
        contextOf(run, [archer, foe], dice),
      );
      return counts[20];
    };
    expect(d20s([])).toBe(2);
    expect(d20s(["sharpshooter"])).toBe(1);
  });

  it("gives Advantage on Death Saving Throws", async () => {
    const run = await testRun();
    const d20s = (traits: readonly string[]) => {
      const actor = { ...hero(traits), hp: 0 };
      const { dice, counts } = scripted([]);
      run.system.frames[`${NS}:takeAction`]?.run(
        { actor: PLAYER_ACTOR, answer: DEATH_SAVE },
        contextOf(run, [actor], dice),
      );
      return counts[20];
    };
    expect(d20s(["defy-death"])).toBe(2);
    expect(d20s([])).toBe(1);
  });

  it("gives the party Temporary Hit Points as the rest it names ends", async () => {
    const run = await testRun();
    const leader = hero(["rally"], { level: 3 });
    const friend = hero([], { id: "friend" });
    const gained = (rest: "short" | "long") =>
      (
        restFrames[`${NS}:finishRest`].run(
          { rest },
          { ...contextOf(run, [leader, friend], scripted([]).dice) },
        ).events ?? []
      ).flatMap((event) =>
        event.kind === `${NS}:tempHpGained` ? [event.payload] : [],
      );
    expect(gained("short")).toEqual([
      { actor: PLAYER_ACTOR, amount: 3 },
      { actor: "friend", amount: 3 },
    ]);
    expect(gained("long")).toEqual([]);
  });

  it("casts a trait's or a chosen feat spell once per Long Rest without a slot", async () => {
    const run = await testRun();
    const free = (actor: Actor) =>
      deriveStats(actor, run).actions.find(
        (action) => action.id === "spell:srd52:spell/burning-hands:free",
      );
    const fromTrait = free(hero(["gift"]));
    expect(fromTrait?.activation.cost).toContainEqual({
      resource: "free:srd52:spell/burning-hands",
    });
    expect(fromTrait?.activation.cost).not.toContain("slot");
    const stats = deriveStats(hero(["gift"]), run);
    expect(stats.resourceDefs.map((item) => item.id)).toContain(
      "free:srd52:spell/burning-hands",
    );
    // A Fighter has no Spellcasting, so the best of Int, Wis and Cha casts it.
    expect(stats.spellAbility).toBe("wis");
    const picked = (freeCast: boolean) =>
      free(
        hero([], {
          answers: [
            {
              kind: "spells",
              values: ["srd52:spell/burning-hands"],
              ...(freeCast ? { freeCast: true as const } : {}),
            },
          ],
        }),
      );
    expect(picked(true)).toBeDefined();
    expect(picked(false)).toBeUndefined();
  });

  it("casts a free spell through a turn, spending its own use, until a Long Rest brings it back", async () => {
    const run = await testRun();
    const free = "spell:srd52:spell/bless:free";
    const cleric = hero(["blessed"]);
    const context = contextOf(run, [cleric], scripted([]).dice);
    const result = run.system.frames[`${NS}:takeAction`]?.run(
      { actor: PLAYER_ACTOR, answer: `${free}|${PLAYER_ACTOR}` },
      context,
    );
    const events = result?.events ?? [];
    const spent = events.flatMap((event) =>
      event.kind === `${NS}:resourceSpent`
        ? [(event.payload as { resource: string }).resource]
        : [],
    );
    expect(spent).toContain("free:srd52:spell/bless");
    expect(spent.some((id) => id.startsWith("slot:"))).toBe(false);
    const after = events.reduce(applyDndEvent, context.state);
    const caster = after.actors[PLAYER_ACTOR];
    if (!caster) throw new Error("No caster");
    expect(caster.concentratingOn).toBe(free);
    const action = findAction(caster, free, { ...context, state: after });
    expect(canAfford(action, caster, deriveStats(caster, run))).toBe(false);
    run.system.frames[`${NS}:finishTurn`]?.run(
      {},
      { ...context, state: after },
    );
    const rested = (
      restFrames[`${NS}:finishRest`].run(
        { rest: "long" },
        { ...context, state: after },
      ).events ?? []
    ).reduce(applyDndEvent, after).actors[PLAYER_ACTOR];
    if (!rested) throw new Error("No caster");
    expect(rested.resourcesSpent["free:srd52:spell/bless"]).toBeUndefined();
  });

  it("makes the save a feat raised proficient, as Resilient does", async () => {
    const run = await testRun();
    const saves = (feats: readonly string[]) =>
      deriveStats(
        hero([], {
          level: 4,
          answers: [
            { kind: "feats", values: [...feats] },
            { kind: "abilities", increases: { wis: 1 } },
          ],
        }),
        run,
      ).savingThrows;
    expect(saves(["test:feat/sturdy"])).toContain("wis");
    expect(saves([])).not.toContain("wis");
  });

  it("offers a feat printed once and encoded by versions only through its versions", async () => {
    const run = await testRun();
    const { options } = choiceOptions(
      { kind: "feat", id: "feat", category: "origin" },
      { picks: {}, backgroundId: "test:background/plain" } as never,
      null,
      lookup(run, ClassSchema, "srd52:class/fighter"),
      run,
    );
    const ids = options.map((item) => item.id);
    expect(ids).toContain("test:feat/initiate-cleric");
    expect(ids).not.toContain("test:feat/initiate");
  });

  it("offers racial feats to their species and one dragonmark at a general feat choice", async () => {
    const run = await testRun();
    const offered = (feats: readonly string[]) =>
      choiceOptions(
        { kind: "feat", id: "feat", category: "general" },
        { picks: {} } as never,
        (
          hero([], {
            level: 4,
            answers: [{ kind: "feats", values: [...feats] }],
          }).source as { build: CharacterBuild }
        ).build,
        lookup(run, ClassSchema, "srd52:class/fighter"),
        run,
      ).options.map((item) => item.id);
    expect(offered([])).toEqual(
      expect.arrayContaining(["test:feat/kin", "test:feat/mark"]),
    );
    expect(offered([])).not.toContain("test:feat/far");
    expect(offered([])).not.toContain("test:feat/greater");
    const marked = offered(["test:feat/mark"]);
    expect(marked).toContain("test:feat/greater");
    expect(marked).not.toContain("test:feat/other-mark");
  });

  it("lets a background's feat give way to one of the category it names, defaulting to its own", async () => {
    const run = await testRun();
    const { options, prefer } = choiceOptions(
      { kind: "feat", id: "background-feat", category: "darkGift" },
      { picks: {}, backgroundId: "test:background/haunted" } as never,
      null,
      lookup(run, ClassSchema, "srd52:class/fighter"),
      run,
    );
    expect(options.map((item) => item.id).slice(0, 2)).toEqual([
      "test:feat/steady",
      "test:feat/gift",
    ]);
    expect(prefer).toEqual(["test:feat/steady"]);
    const features = (answers: Answers) =>
      deriveStats(
        hero([], { background: "test:background/haunted", answers }),
        run,
      ).features;
    const gifted = features([{ kind: "feats", values: ["test:feat/gift"] }]);
    expect(gifted).toContain("test:feature/luck");
    expect(gifted).not.toContain("test:feature/savage");
    // A save from before the choice existed has no answer and keeps the background's own feat.
    expect(features([])).toContain("test:feature/savage");
  });
});

const NO_EDGE = { advantage: false, disadvantage: false };
