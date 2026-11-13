import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { choiceOptions } from "../plugins/systems/dnd5.5e/core/character.ts";
import { DEATH_SAVE } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
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
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
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
  { level = 1, answers = [] as Answers, id = PLAYER_ACTOR } = {},
): Actor {
  const build: CharacterBuild = {
    baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    speciesId: "test:species/plain",
    backgroundId: "test:background/plain",
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
});

const NO_EDGE = { advantage: false, disadvantage: false };
