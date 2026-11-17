import { describe, expect, it } from "vitest";
import type { SystemEvent } from "#sdk";
import type { RunContext } from "../engine/run/turn.ts";
import {
  contagionEvents,
  diseaseRestEvents,
  environmentConditionEvents,
  environmentEvents,
  everySquare,
  featureCheck,
  fightEnvironment,
  restHampered,
  turnSaveEvents,
} from "../plugins/systems/dnd5.5e/core/environment.ts";
import { dealEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { inAntimagic } from "../plugins/systems/dnd5.5e/core/zones.ts";
import { masteredDice } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  immuneToCondition,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, hero, scripted, testRun } from "./feat-fixtures.ts";

// The pieces of #191: made-up entities with ids and numbers only.
const FIXTURES = [
  {
    id: "test:environmental-effect/cold",
    name: "Cold",
    source: "Test",
    text: "A test effect.",
    automation: "full",
    exposure: { every: "hour", ability: "con", dc: 10, resist: "cold" },
  },
  {
    id: "test:environmental-effect/heat",
    name: "Heat",
    source: "Test",
    text: "A test effect.",
    automation: "full",
    exposure: { every: "hour", ability: "con", dc: 5, dcStep: 1 },
  },
  {
    id: "test:environmental-effect/water",
    name: "Water",
    source: "Test",
    text: "A test effect.",
    automation: "full",
    exposure: { every: "minute", ability: "con", dc: 10, graceCon: true },
  },
  {
    id: "test:environmental-effect/calm",
    name: "Calm",
    source: "Test",
    text: "A test effect.",
    automation: "full",
    passives: [{ kind: "conditionImmunity", condition: "frightened" }],
    except: ["fiend"],
  },
  {
    id: "test:environmental-effect/ice",
    name: "Ice",
    source: "Test",
    text: "A test effect.",
    automation: "full",
    fight: {
      conditions: ["deafened"],
      difficult: true,
      deadMagic: true,
      turnSave: { ability: "dex", dc: 10, condition: "prone" },
    },
  },
  {
    id: "test:environmental-effect/wind",
    name: "Wind",
    source: "Test",
    text: "A test effect.",
    automation: "full",
    tables: [
      { die: 20, rows: [{ min: 1, max: 20, hours: 3, hoursTimes: 24 }] },
      {
        save: { ability: "int", dc: 15 },
        die: 20,
        rows: [
          { min: 1, max: 20, conditions: ["unconscious"], lingers: "1d4" },
        ],
      },
    ],
  },
  {
    id: "test:disease/plague",
    name: "Plague",
    source: "Test",
    text: "A test disease.",
    automation: "full",
    creatureTypes: ["humanoid"],
    catch: { ability: "con", dc: 11 },
    onsetRests: 1,
    symptoms: {
      exhaustion: 1,
      noRestHealing: true,
      keepExhaustion: true,
      laughter: {
        dc: 13,
        damage: [{ amount: { dice: "1d10" }, type: "psychic" }],
      },
    },
    fight: {
      ability: "con",
      dc: 11,
      failExhaustion: true,
      successLessens: true,
      cureAtZero: true,
    },
  },
  {
    id: "test:dungeon-feature/lock",
    name: "Lock",
    source: "Test",
    text: "A test feature.",
    automation: "full",
    check: { skill: "sleightOfHand", ability: "dex" },
  },
];

async function run(): Promise<RunContext> {
  const base = await testRun();
  const byId = new Map<string, unknown>(
    FIXTURES.map((item) => [item.id, item]),
  );
  return {
    ...base,
    content: (id) =>
      (byId.get(id) as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
}

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);
const between = (
  content: RunContext,
  actors: readonly Actor[],
  rolls: readonly number[],
) => {
  const context = contextOf(content, actors, scripted(rolls).dice);
  return { ...context, state: { ...context.state, combat: null } };
};
function need<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing");
  return value;
}

describe("environmental effects (#191)", () => {
  it("rolls a save for each hour spent in the cold, Exhaustion on each failure, and spares the cold-resistant", async () => {
    const content = await run();
    const context = between(content, [hero([])], [1, 20, 1]);
    const events = environmentEvents(
      { effects: ["test:environmental-effect/cold"], hours: 3, minutes: 0 },
      context,
    );
    expect(payloads(events, "saveRolled")).toHaveLength(3);
    expect(payloads(events, "exhaustionChanged")).toHaveLength(2);
    expect(fold(context.state, events).ambient).toEqual([
      "test:environmental-effect/cold",
    ]);
    const warm = {
      ...hero([]),
      activeEffects: [
        {
          sourceId: "spell:x",
          casterId: "x",
          modifier: { kind: "resistance" as const, damage: "cold" as const },
          ends: "spellDuration" as const,
        },
      ],
    };
    const spared = environmentEvents(
      { effects: ["test:environmental-effect/cold"], hours: 3, minutes: 0 },
      between(content, [warm], [1, 1, 1]),
    );
    expect(payloads(spared, "saveRolled")).toEqual([]);
  });

  it("raises the DC each hour, and lets the Constitution score's minutes pass first in water", async () => {
    const content = await run();
    const heat = environmentEvents(
      { effects: ["test:environmental-effect/heat"], hours: 3, minutes: 0 },
      between(content, [hero([])], [10, 10, 10]),
    );
    expect(payloads(heat, "saveRolled").map(({ dc }) => dc)).toEqual([5, 6, 7]);
    // Constitution 14 with the fixture hero's increases: 16 minutes in it, the last two saved for.
    const con = deriveStats(hero([]), content).abilities.con;
    const water = environmentEvents(
      {
        effects: ["test:environmental-effect/water"],
        hours: 0,
        minutes: con + 2,
      },
      between(content, [hero([])], [10, 10]),
    );
    expect(payloads(water, "saveRolled")).toHaveLength(2);
  });

  it("gives every creature in a fight the effect's passives, but not an excepted type", async () => {
    const content = await run();
    const fighter = hero([]);
    const context = contextOf(content, [fighter], scripted([]).dice);
    const state: DndState = {
      ...context.state,
      combat: {
        ...need(context.state.combat),
        environment: { ids: ["test:environmental-effect/calm"] },
      },
    };
    expect(
      immuneToCondition(
        deriveStats(fighter, { ...content, state } as never),
        "frightened",
      ),
    ).toBe(true);
    expect(immuneToCondition(deriveStats(fighter, content), "frightened")).toBe(
      false,
    );
  });

  it("deafens everyone, makes every square difficult, saves for Prone each turn and stops magic in an icy dead zone", async () => {
    const content = await run();
    const fighter = hero([]);
    const environment = fightEnvironment(
      ["test:environmental-effect/ice"],
      content,
    );
    expect(environment).toMatchObject({ difficult: true, deadMagic: true });
    const deaf = environmentConditionEvents(
      ["test:environmental-effect/ice"],
      [fighter],
      content,
    );
    expect(payloads(deaf, "effectAdded")).toHaveLength(1);
    const context = contextOf(content, [fighter], scripted([1]).dice);
    const state: DndState = {
      ...context.state,
      combat: {
        ...need(context.state.combat),
        grid: { width: 3, height: 2 },
        environment: need(environment),
      },
    };
    expect(everySquare(state)).toHaveLength(6);
    expect(inAntimagic({ ...fighter, position: { x: 1, y: 1 } }, state)).toBe(
      true,
    );
    const slipped = turnSaveEvents(fighter, { ...context, state });
    expect(payloads(slipped, "effectAdded")[0]).toMatchObject({
      effect: { modifier: { kind: "condition", condition: "prone" } },
    });
  });

  it("passes the days a psychic wind costs and knocks out a traveler who fails its save", async () => {
    const content = await run();
    const events = environmentEvents(
      { effects: ["test:environmental-effect/wind"], hours: 0, minutes: 0 },
      between(content, [hero([])], [5, 1, 5, 2]),
    );
    expect(payloads(events, "timePassed")).toEqual([{ hours: 72 }]);
    expect(payloads(events, "effectAdded")[0]).toMatchObject({
      effect: {
        modifier: { condition: "unconscious" },
        shake: true,
        lingers: 2,
      },
    });
  });

  it("counts an Empowered Force Zone's low Force dice as 3", () => {
    const low = masteredDice(scripted([1, 2, 5]).dice, "force", [], [], 3);
    expect([low.roll(6), low.roll(6), low.roll(6)]).toEqual([3, 3, 5]);
    const fire = masteredDice(scripted([1]).dice, "fire", [], [], 3);
    expect(fire.roll(6)).toBe(1);
  });
});

describe("diseases (#191)", () => {
  it("is caught on a failed save, sets in after a Long Rest, and is fought off a level of Exhaustion at a time", async () => {
    const content = await run();
    const sick = hero([]);
    const caught = contagionEvents(
      { disease: "test:disease/plague", who: "party" },
      between(content, [sick], [1]),
    );
    let state = fold(between(content, [sick], []).state, caught);
    expect(state.actors[sick.id]?.diseases).toEqual([
      expect.objectContaining({ disease: "test:disease/plague", onset: 1 }),
    ]);
    // The first Long Rest brings the symptoms: a level of Exhaustion and the laughter.
    const onset = diseaseRestEvents(need(state.actors[sick.id]), {
      ...between(content, [], []),
      state,
    });
    state = fold(state, onset);
    const ill = need(state.actors[sick.id]);
    expect(ill.exhaustion).toBe(1);
    expect(
      ill.activeEffects.some(({ modifier }) => modifier.kind === "laughter"),
    ).toBe(true);
    // While Exhausted it heals nothing and keeps its Exhaustion through a Long Rest.
    expect(restHampered(ill, { ...content, state })).toEqual({
      keepHp: true,
      exhaustionFloor: 1,
    });
    // A saved rest takes the level away, and with none left it's over.
    const fought = diseaseRestEvents(ill, {
      ...between(content, [], [20]),
      state,
    });
    expect(payloads(fought, "exhaustionChanged")).toEqual([
      { actor: sick.id, levels: -1 },
    ]);
    const well = fold(state, fought).actors[sick.id];
    expect(well?.diseases).toBeUndefined();
    expect(well?.activeEffects).toEqual([]);
  });

  it("sets off a fit of laughter when damage other than Psychic lands", async () => {
    const content = await run();
    const laughing: Actor = {
      ...hero([]),
      hp: 30,
      activeEffects: [
        {
          sourceId: "disease:test:disease/plague",
          casterId: "hero",
          modifier: {
            kind: "laughter",
            dc: 13,
            damage: [{ amount: { dice: "1d10" }, type: "psychic" }],
          },
          ends: "spellDuration",
          lingers: "cured",
        },
      ],
    };
    const context = contextOf(content, [laughing], scripted([1, 4]).dice);
    const fire = dealEvents(
      laughing,
      [{ amount: 3, type: "fire" }],
      false,
      context,
    );
    expect(payloads(fire.events, "effectAdded")[0]).toMatchObject({
      effect: { modifier: { kind: "condition", condition: "incapacitated" } },
    });
    const psychic = dealEvents(
      laughing,
      [{ amount: 3, type: "psychic" }],
      false,
      context,
    );
    expect(payloads(psychic.events, "saveRolled")).toEqual([]);
  });

  it("spares a creature of another type", async () => {
    const content = await run();
    const goblin = freshActor({
      id: "goblin",
      name: "goblin",
      side: "party",
      source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
      hp: 7,
      inventory: [],
    });
    const events = contagionEvents(
      { disease: "test:disease/plague", who: "party" },
      between(content, [goblin], [1]),
    );
    expect(events).toEqual([]);
  });
});

describe("dungeon features (#191)", () => {
  it("makes a check against a feature with its skill, at the scene's DC", async () => {
    const content = await run();
    expect(
      featureCheck({ feature: "test:dungeon-feature/lock", dc: 15 }, content),
    ).toEqual({
      skill: "sleightOfHand",
      ability: "dex",
      dc: 15,
    });
    expect(featureCheck({ skill: "perception", dc: 12 }, content)).toEqual({
      skill: "perception",
      dc: 12,
    });
  });
});
