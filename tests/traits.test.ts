import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import { type RunContext, startRun, step } from "../engine/kernel/turn.ts";
import {
  CREATE_CHARACTER,
  type Context,
  damageEvents,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { restFrames } from "../plugins/systems/dnd5.5e/core/rest.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  damageResponses,
  deriveStats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { traitSaveAdvantage } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";

// Made-up species, feats and traits: ids and mechanics only.
const FIXTURES = [
  {
    id: "test:species/stoneling",
    name: "Stoneling",
    text: "A test species.",
    creatureType: "Humanoid",
    size: "medium",
    speed: 30,
    traits: [
      "test:feature/stone-hide",
      "test:feature/stubborn",
      "test:feature/last-stand",
      "test:feature/spark-gift",
      "test:feature/late-bloom",
      "test:feature/rested",
    ],
    choices: [
      {
        kind: "option",
        id: "ancestry",
        count: 1,
        from: ["test:feature/ember-breath", "test:feature/frost-breath"],
      },
      { kind: "skills", id: "sense", count: 1, from: ["religion"] },
    ],
  },
  {
    id: "test:feature/stone-hide",
    name: "Stone Hide",
    text: "Test.",
    automation: "full",
    passives: [
      { kind: "modifier", modifier: { kind: "resistance", damage: "poison" } },
      { kind: "saveAdvantage", abilities: ["int"], conditions: ["poisoned"] },
    ],
  },
  {
    id: "test:feature/stubborn",
    name: "Stubborn",
    text: "Test.",
    automation: "full",
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "bonus",
          to: "maxHp",
          amount: { bonus: { add: [{ kind: "level" }] } },
        },
      },
    ],
  },
  {
    id: "test:feature/last-stand",
    name: "Last Stand",
    text: "Test.",
    automation: "full",
    passives: [{ kind: "dropToOne", resource: "last-stand" }],
    resources: [
      {
        id: "last-stand",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  },
  {
    id: "test:feature/spark-gift",
    name: "Spark Gift",
    text: "Test.",
    automation: "full",
    spells: { 1: ["srd52:spell/fire-bolt"], 3: ["srd52:spell/burning-hands"] },
  },
  {
    id: "test:feature/late-bloom",
    name: "Late Bloom",
    text: "Test.",
    automation: "full",
    fromLevel: 5,
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "bonus",
          to: "speed",
          amount: { bonus: { base: 10 } },
        },
      },
    ],
  },
  {
    id: "test:feature/rested",
    name: "Rested",
    text: "Test.",
    automation: "full",
    passives: [{ kind: "restInspiration", rests: ["long"] }],
  },
  ...["ember", "frost"].map((kind) => ({
    id: `test:feature/${kind}-breath`,
    name: `${kind} breath`,
    text: "Test.",
    automation: "full",
    perTier: { addDice: "1d10" },
    activations: [
      {
        cost: ["action"],
        targeting: {
          area: { shape: "cone", radius: 15 },
          range: "self",
          side: "enemy",
        },
        resolution: {
          kind: "save",
          ability: "dex",
          dc: {
            base: 8,
            add: [
              { kind: "abilityMod", ability: "con" },
              { kind: "proficiency" },
            ],
          },
          damage: [
            {
              amount: { dice: "1d10" },
              type: kind === "ember" ? "fire" : "cold",
            },
          ],
          onSuccessDamage: "half",
        },
      },
    ],
  })),
  {
    id: "test:feat/watchful",
    name: "Watchful",
    category: "origin",
    text: "Test.",
    grants: ["test:feature/watchful"],
    choices: [
      { kind: "skills", id: "trained", count: 1, from: ["stealth", "arcana"] },
    ],
  },
  {
    id: "test:feature/watchful",
    name: "Watchful",
    text: "Test.",
    automation: "full",
    passives: [
      {
        kind: "modifier",
        modifier: {
          kind: "bonus",
          to: "initiative",
          amount: { bonus: { add: [{ kind: "proficiency" }] } },
        },
      },
    ],
  },
  {
    id: "test:background/lookout",
    name: "Lookout",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/watchful",
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

function stoneling(level: number, features: readonly string[]): Actor {
  const build: CharacterBuild = {
    baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    speciesId: "test:species/stoneling",
    backgroundId: "test:background/lookout",
    backgroundIncrease: { str: 2, con: 1 },
    levels: Array.from({ length: level }, (_, index) => ({
      classId: "srd52:class/fighter",
      hitPointGain: 10,
      answers: index === 0 ? [{ kind: "features", values: [...features] }] : [],
    })),
  };
  return freshActor({
    id: PLAYER_ACTOR,
    name: "Hero",
    side: "party",
    source: { kind: "character", build },
    hp: 10,
    inventory: [],
  });
}

const HIGH: Dice = { below: () => 0, roll: (sides) => sides };

function contextOf(run: RunContext, actor: Actor): Context {
  const state: DndState = { actors: { [actor.id]: actor }, combat: null };
  return {
    state,
    dice: HIGH,
    content: run.content,
    contentIds: run.contentIds,
  };
}

describe("species traits and feats", () => {
  it("raises Hit Points by level, Initiative by Proficiency, and resists damage", async () => {
    const run = await testRun();
    const one = deriveStats(stoneling(1, []), run);
    const five = deriveStats(stoneling(5, []), run);
    // Con 14: +2 a level, plus Stubborn's 1 a level.
    expect(one.maxHp).toBe(10 + 2 + 1);
    expect(five.maxHp).toBe(5 * (10 + 2) + 5);
    expect(one.initiative).toBe(2 + 2);
    expect(five.initiative).toBe(2 + 3);
    expect(damageResponses(stoneling(1, []), run).resistances).toEqual([
      "poison",
    ]);
  });

  it("adds breath dice at levels 5, 11 and 17, and gives spells from the level they start", async () => {
    const run = await testRun();
    const breath = (level: number) =>
      deriveStats(stoneling(level, ["test:feature/ember-breath"]), run)
        .actions.filter((action) =>
          action.id.startsWith("feature:test:feature/ember"),
        )
        .map((action) =>
          action.activation.resolution.kind === "save"
            ? action.activation.resolution.damage[0]?.amount.dice
            : null,
        );
    expect(breath(1)).toEqual(["1d10"]);
    expect(breath(5)).toEqual(["2d10"]);
    const spells = (level: number) =>
      deriveStats(stoneling(level, []), run)
        .actions.map((action) => action.id)
        .filter((id) => id.startsWith("spell:"));
    expect(spells(1)).toEqual(["spell:srd52:spell/fire-bolt"]);
    expect(spells(3)).toContain("spell:srd52:spell/burning-hands");
  });

  it("starts a feature at its character level", async () => {
    const run = await testRun();
    expect(deriveStats(stoneling(4, []), run).speed).toBe(30);
    expect(deriveStats(stoneling(5, []), run).speed).toBe(40);
  });

  it("gives Heroic Inspiration when the rest it names ends", async () => {
    const run = await testRun();
    const hero = stoneling(1, []);
    const inspired = (rest: "short" | "long") =>
      (
        restFrames[`${NS}:finishRest`].run({ rest }, contextOf(run, hero))
          .events ?? []
      ).some((event) => event.kind === `${NS}:inspirationGranted`);
    expect(inspired("long")).toBe(true);
    expect(inspired("short")).toBe(false);
  });

  it("gives Advantage on saves by ability or by the condition a save would bring", async () => {
    const run = await testRun();
    const stats = deriveStats(stoneling(1, []), run);
    expect(traitSaveAdvantage(stats, "int", [])).toBe(true);
    expect(traitSaveAdvantage(stats, "con", ["poisoned"])).toBe(true);
    expect(traitSaveAdvantage(stats, "con", ["frightened"])).toBe(false);
  });

  it("drops to 1 Hit Point instead of 0 once, then falls as usual", async () => {
    const run = await testRun();
    const hero = { ...stoneling(1, []), hp: 5 };
    const kinds = (actor: Actor, amount = 8) =>
      damageEvents(actor, amount, "fire", false, contextOf(run, actor)).map(
        (event) =>
          "payload" in event
            ? `${event.kind}:${String((event.payload as { amount?: number }).amount ?? "")}`
            : event.kind,
      );
    expect(kinds(hero)).toEqual([
      "dnd5.5e:resourceSpent:",
      "dnd5.5e:damaged:4",
    ]);
    const spent = { ...hero, resourcesSpent: { "last-stand": 1 } };
    expect(kinds(spent)).toEqual(["dnd5.5e:damaged:8", "actorDowned"]);
    // Damage that would kill outright isn't survived.
    expect(kinds(hero, 20)).toEqual(["dnd5.5e:damaged:20", "actorDefeated"]);
  });

  it("asks a species' and an origin feat's choices at character creation", async () => {
    const run = await testRun();
    const answers: Record<string, string> = {
      class: "srd52:class/fighter",
      species: "test:species/stoneling",
      background: "test:background/lookout",
    };
    let { state, pending } = startRun(run, "traits");
    const asked: string[] = [];
    while (pending) {
      const decision = pending;
      asked.push(decision.id);
      const key = decision.id.split(":").at(-1) ?? "";
      const optionId = decision.id.includes("chooseCharacter")
        ? CREATE_CHARACTER
        : (answers[key] ?? decision.options.at(-1)?.id ?? "");
      const outcome = step(run, state, {
        kind: "answer",
        decisionId: decision.id,
        optionId,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      ({ state, pending } = outcome);
      if (asked.length > 60) break;
    }
    const player = StateSchema.parse(state.system).actors[PLAYER_ACTOR];
    if (player?.source.kind !== "character" || !player.source.build) {
      throw new Error("No character");
    }
    const [first] = player.source.build.levels;
    expect(asked.some((id) => id.endsWith("species-ancestry-0"))).toBe(true);
    expect(first?.answers).toContainEqual({
      kind: "features",
      values: ["test:feature/frost-breath"],
    });
    expect(first?.answers).toContainEqual({
      kind: "skills",
      values: ["religion"],
    });
    expect(first?.answers).toContainEqual({
      kind: "skills",
      values: ["arcana"],
    });
    const stats = deriveStats(player, run);
    expect(stats.skills).toEqual(
      expect.arrayContaining(["religion", "arcana"]),
    );
    expect(stats.actions.map((action) => action.name)).toContain(
      "frost breath",
    );
  });
});
