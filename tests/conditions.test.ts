import { describe, expect, it } from "vitest";
import type { SystemEvent } from "#sdk";
import type { RunContext } from "../engine/run/turn.ts";
import {
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  castSaveFoiled,
  clingSave,
  collectable,
  dropEvents,
  outOfSight,
  repeatsNow,
  runFleeTurn,
  SHAKE,
  shakeable,
  shakeEvents,
} from "../plugins/systems/dnd5.5e/core/combat/fear.ts";
import { canAfford } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { runFinishTurn } from "../plugins/systems/dnd5.5e/core/combat/turn.ts";
import { tacticOptions } from "../plugins/systems/dnd5.5e/core/actions.ts";
import { walkSpeed } from "../plugins/systems/dnd5.5e/core/tactics.ts";
import {
  type Activation,
  type LeafEffect,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  freshActor,
  hasCondition,
  isDead,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  type KnownAction,
  deriveStats,
  lookup,
  scaleActivation,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// The pieces of #149: fleeing, options, shaking awake, Hit Point bands, curses and effects that outlast a fight.
// Made-up traits carry ids and numbers only; the spells are the SRD's.
const FIXTURES = [
  trait("turning", [], {
    activations: [
      {
        cost: ["action"],
        label: "Turn Undead",
        targeting: {
          area: { shape: "emanation", radius: 30 },
          range: "self",
          side: "enemy",
        },
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 12, add: [] },
          onFail: [],
        },
      },
    ],
  }),
  trait("sear", [
    {
      kind: "activationRider",
      feature: "test:feature/turning",
      label: "Turn Undead",
      damage: [
        { amount: { dice: "1d8", diceCount: "mod:wis" }, type: "radiant" },
      ],
    },
  ]),
];

async function run(): Promise<RunContext> {
  const base = await testRun();
  const goblin = base.content("srd52:monster/goblin-warrior") as object;
  const byId = new Map<string, unknown>([
    ...FIXTURES.map((item): [string, unknown] => [item.id, item]),
    [
      "test:monster/fiend",
      { ...goblin, id: "test:monster/fiend", creatureType: "Fiend" },
    ],
  ]);
  return {
    ...base,
    content: (id) =>
      (byId.get(id) as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
}

const at = (actor: Actor, x: number, y: number, more: Partial<Actor> = {}) => ({
  ...actor,
  position: { x, y },
  ...more,
});
const foe = (
  id: string,
  hp = 7,
  statBlock = "srd52:monster/goblin-warrior",
): Actor =>
  freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: statBlock },
    hp,
    inventory: [],
  });
const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const onGrid = (
  content: RunContext,
  actors: readonly Actor[],
  dice = scripted([]).dice,
) => {
  const context = contextOf(content, actors, dice);
  const combat = context.state.combat;
  if (!combat) throw new Error("no fight");
  return {
    ...context,
    state: {
      ...context.state,
      combat: { ...combat, grid: { width: 20, height: 20 } },
    },
  };
};
const spellAction = (content: RunContext, id: string): KnownAction => {
  const spell = lookup(content, SpellSchema, `srd52:spell/${id}`);
  if (!spell.activation) throw new Error(id);
  return {
    id: `spell:srd52:spell/${id}`,
    name: spell.name,
    activation: spell.activation,
    spellLevel: spell.level,
  };
};
const effect = (more: Partial<ActiveEffect> = {}): ActiveEffect => ({
  sourceId: "spell:test",
  casterId: "caster",
  modifier: { kind: "condition", condition: "frightened" },
  ends: "spellDuration",
  ...more,
});
function need<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing");
  return value;
}
const conditionsOf = (actor: Actor | undefined) =>
  (actor?.activeEffects ?? []).flatMap(({ modifier }) =>
    modifier.kind === "condition" ? [modifier.condition] : [],
  );

describe("fleeing in fear (#149)", () => {
  it("drops its weapons and flees from the caster, saving only out of sight, as from Fear", async () => {
    const content = await run();
    const caster = at(foe("caster"), 0, 0);
    const target = at(hero([]), 1, 0);
    const context = onGrid(content, [caster, target], scripted([1, 1]).dice);
    const cast = settle(
      content,
      context.state,
      resolveAction(spellAction(content, "fear"), caster, [target], context)
        .frames ?? [],
      scripted([]).dice,
    );
    const events = [
      ...(resolveAction(spellAction(content, "fear"), caster, [target], context)
        .events ?? []),
      ...cast.events,
    ];
    expect(payloads(events, "weaponThrown")).toEqual([
      expect.objectContaining({ item: "srd52:item/longsword", by: target.id }),
    ]);
    const frightened = fold(context.state, events);
    const scared = frightened.actors[target.id];
    expect(conditionsOf(scared)).toContain("frightened");
    // Its turn: the Dash, then the farthest square from the caster.
    const turn = {
      ...frightened,
      combat: { ...need(frightened.combat), index: 1 },
    };
    const fled = runFleeTurn({ ...context, state: turn });
    const moved = payloads(fled.events ?? [], "moved")[0];
    expect(payloads(fled.events ?? [], "budgetSpent")[0]).toMatchObject({
      kind: "action",
    });
    expect((moved?.to as { x: number }).x).toBeGreaterThan(5);
    // In sight, no save; once the caster can't see it, it saves.
    const fear = scared?.activeEffects.find(({ flee }) => flee);
    if (!scared || !fear) throw new Error("no fear");
    expect(repeatsNow(scared, fear, { ...context, state: turn })).toBe(false);
    const blinded = {
      ...caster,
      activeEffects: [
        effect({ modifier: { kind: "condition", condition: "blinded" } }),
      ],
    };
    const dark = { ...turn, actors: { ...turn.actors, caster: blinded } };
    expect(outOfSight(blinded, scared, { ...context, state: dark })).toBe(true);
    expect(repeatsNow(scared, fear, { ...context, state: dark })).toBe(true);
  });

  it("ends Turn Undead's flight once its caster is Incapacitated", async () => {
    const content = await run();
    const cleric = at(hero([], { id: "cleric" }), 0, 0, {
      activeEffects: [
        effect({ modifier: { kind: "condition", condition: "stunned" } }),
      ],
    });
    const zombie = at(foe("zombie", 10), 1, 0, {
      activeEffects: [
        effect({ casterId: "cleric", flee: { casterDown: true } }),
      ],
    });
    const context = onGrid(content, [zombie, cleric]);
    const result = runFleeTurn(context);
    expect(payloads(result.events ?? [], "effectEnded")).toEqual([
      expect.objectContaining({ actor: "zombie", casterId: "cleric" }),
    ]);
    expect(payloads(result.events ?? [], "moved")).toEqual([]);
  });

  it("adds Sear Undead's Radiant to Turn Undead's failed saves, by the Wisdom modifier", async () => {
    const content = await run();
    const stats = deriveStats(hero(["turning", "sear"]), content);
    const turn = stats.actions.find(({ id }) =>
      id.startsWith("feature:test:feature/turning"),
    );
    const { resolution } = turn?.activation ?? {};
    expect(resolution?.kind === "save" && resolution.damage).toEqual([
      { amount: { dice: "1d8", diceCount: "mod:wis" }, type: "radiant" },
    ]);
    expect(stats.scaling["mod:wis"]).toBe(1); // Wisdom 12, at least 1
  });
});

describe("options, shaking awake and saving with an action (#149)", () => {
  it("lets the caster pick Blinded or Deafened as Blindness/Deafness lands", async () => {
    const content = await run();
    const caster = at(hero([], { id: "caster" }), 0, 0);
    const target = at(foe("goblin"), 3, 0);
    const context = onGrid(content, [caster, target], scripted([1]).dice);
    const result = resolveAction(
      spellAction(content, "blindness-deafness"),
      caster,
      [target],
      context,
      2,
    );
    const after = fold(context.state, result.events ?? []);
    const settled = settle(
      content,
      after,
      result.frames ?? [],
      scripted([]).dice,
      (decision) =>
        decision.id.includes(":option:")
          ? "Deafened"
          : (decision.options[0]?.id ?? ""),
    );
    expect(
      settled.decisions.find(({ id }) => id.includes(":option:"))?.options,
    ).toEqual([
      { id: "Blinded", label: "Blinded" },
      { id: "Deafened", label: "Deafened" },
    ]);
    expect(conditionsOf(settled.state.actors.goblin)).toEqual(["deafened"]);
  });

  it("puts Sleep's target down, then Unconscious, and an ally beside it can shake it out", async () => {
    const content = await run();
    const caster = at(foe("caster"), 0, 0);
    const sleeper = at(hero([]), 3, 0);
    const friend = at(hero([], { id: "friend" }), 4, 0);
    const context = onGrid(
      content,
      [caster, sleeper, friend],
      scripted([1]).dice,
    );
    const cast = resolveAction(
      spellAction(content, "sleep"),
      caster,
      [sleeper],
      context,
      1,
    );
    const asleep = fold(context.state, cast.events ?? []);
    expect(conditionsOf(asleep.actors[sleeper.id])).toEqual(["incapacitated"]);
    // A failed save at the end of its next turn leaves it Unconscious, still shaken awake.
    const turn = {
      ...asleep,
      combat: { ...need(asleep.combat), index: 1 },
    };
    const ending = runFinishTurn({
      ...context,
      state: turn,
      dice: scripted([1]).dice,
    });
    const deeper = fold(turn, ending.events ?? []);
    const down = deeper.actors[sleeper.id];
    expect(conditionsOf(down)).toEqual(["unconscious"]);
    expect(shakeable(friend, deeper).map(({ id }) => id)).toEqual([sleeper.id]);
    const options = tacticOptions(
      {
        ...friend,
        budget: { action: true, bonusAction: true, reaction: true },
      },
      deeper,
      content,
    );
    expect(options.some(({ id }) => id.startsWith(SHAKE))).toBe(true);
    const awake = fold(deeper, shakeEvents(need(down)));
    expect(conditionsOf(awake.actors[sleeper.id])).toEqual([]);
  });

  it("saves against Irresistible Dance only with its action", async () => {
    const content = await run();
    const caster = at(hero([], { id: "caster" }), 0, 0);
    const dancer = at(foe("dancer"), 2, 0);
    const context = onGrid(content, [caster, dancer], scripted([1]).dice);
    const cast = resolveAction(
      spellAction(content, "irresistible-dance"),
      caster,
      [dancer],
      context,
      6,
    );
    const dancing = need(fold(context.state, cast.events ?? []).actors.dancer);
    const charm = dancing.activeEffects.find(({ actionSave }) => actionSave);
    expect(charm).toBeDefined();
    expect(repeatsNow(dancing, need(charm), context)).toBe(false);
    expect(collectable(dancing)).toHaveLength(1);
    expect(walkSpeed(dancing, deriveStats(dancing, content))).toBe(0);
  });
});

describe("Hit Point bands, sending away and slaying (#149)", () => {
  it("plays Divine Word's bands, each with its own duration", async () => {
    const content = await run();
    const caster = at(hero([], { id: "caster" }), 0, 0);
    const targets = [15, 25, 35, 45, 60].map((hp, index) =>
      at(foe(`f${String(hp)}`, hp), 1 + index, 1),
    );
    const context = onGrid(
      content,
      [caster, ...targets],
      scripted([1, 1, 1, 1, 1]).dice,
    );
    const result = resolveAction(
      spellAction(content, "divine-word"),
      caster,
      targets,
      context,
      7,
    );
    const after = fold(context.state, result.events ?? []);
    expect(isDead(need(after.actors.f15))).toBe(true);
    expect(conditionsOf(after.actors.f25)).toEqual([
      "blinded",
      "deafened",
      "stunned",
    ]);
    expect(conditionsOf(after.actors.f35)).toEqual(["blinded", "deafened"]);
    expect(conditionsOf(after.actors.f45)).toEqual(["deafened"]);
    expect(conditionsOf(after.actors.f60)).toEqual([]);
    expect(after.actors.f25?.activeEffects[0]?.lingers).toBe(1);
  });

  it("stops a creature above Power Word Stun's 150 Hit Points instead of stunning it", async () => {
    const content = await run();
    const caster = at(hero([], { id: "caster" }), 0, 0);
    const big = at(foe("big", 200), 2, 0);
    const small = at(foe("small", 100), 3, 0);
    const context = onGrid(content, [caster, big, small]);
    const action = spellAction(content, "power-word-stun");
    const after = fold(context.state, [
      ...(resolveAction(action, caster, [big], context, 8).events ?? []),
      ...(resolveAction(action, caster, [small], context, 8).events ?? []),
    ]);
    expect(conditionsOf(after.actors.big)).toEqual([]);
    const big2 = need(after.actors.big);
    expect(walkSpeed(big2, deriveStats(big2, content))).toBe(0);
    expect(conditionsOf(after.actors.small)).toEqual(["stunned"]);
  });

  it("keeps an extraplanar creature Banishment holds gone, and lets a Humanoid come back", async () => {
    const content = await run();
    const caster = at(hero([], { id: "caster" }), 0, 0);
    const imp = at(foe("imp", 10, "test:monster/fiend"), 2, 0);
    const goblin = at(foe("goblin"), 3, 0);
    const context = onGrid(
      content,
      [caster, imp, goblin],
      scripted([1, 1]).dice,
    );
    const action = spellAction(content, "banishment");
    const after = fold(context.state, [
      ...(resolveAction(action, caster, [imp], context, 4).events ?? []),
      ...(resolveAction(action, caster, [goblin], context, 4).events ?? []),
    ]);
    const seal = (id: string) =>
      after.actors[id]?.activeEffects.find(
        ({ modifier }) => modifier.kind === "sealed",
      );
    expect(seal("imp")?.lasts).toBeUndefined();
    expect(seal("goblin")?.lasts).toBeDefined();
  });
});

describe("curses and what outlasts a fight (#149)", () => {
  it("makes Bestow Curse last 8 hours without Concentration from a level 5 slot", async () => {
    const content = await run();
    const spell = lookup(content, SpellSchema, "srd52:spell/bestow-curse");
    if (!spell.activation || !spell.upcast) throw new Error("bestow curse");
    const durations = (slot: number) => {
      const { resolution } = scaleActivation(
        need<Activation>(spell.activation),
        need(spell.upcast).perSlotLevel,
        slot - 3,
      );
      return resolution.kind === "save"
        ? resolution.onFail.map((item: LeafEffect) =>
            "duration" in item ? item.duration : null,
          )[0]
        : null;
    };
    expect(durations(3)).toEqual({ concentration: true, minutes: 1 });
    expect(durations(4)).toEqual({ concentration: true, minutes: 10 });
    expect(durations(5)).toEqual({ minutes: 480 });
    expect(durations(7)).toEqual({ minutes: 1440 });
  });

  it("keeps an hour-long effect after the fight and runs it down with rests", () => {
    const cursed = {
      ...hero([]),
      activeEffects: [
        effect({
          lingers: 9,
          lasts: { actor: "caster", round: 50, at: "start" },
        }),
        effect({ sourceId: "spell:short" }),
      ],
    };
    const state: DndState = {
      actors: { [cursed.id]: cursed },
      combat: { encounter: "x", order: [cursed.id], index: 0, round: 1 },
    };
    const after = applyDndEvent(state, dndEvent(`${NS}:combatEnded`, {}));
    const kept = after.actors[cursed.id]?.activeEffects ?? [];
    expect(kept).toEqual([
      expect.objectContaining({ sourceId: "spell:test", lingers: 9 }),
    ]);
    expect(kept[0]?.lasts).toBeUndefined();
    const rested = applyDndEvent(
      after,
      dndEvent(`${NS}:restFinished`, { rest: "long" }),
    );
    expect(rested.actors[cursed.id]?.activeEffects[0]?.lingers).toBe(1);
    const gone = applyDndEvent(
      rested,
      dndEvent(`${NS}:timePassed`, { hours: 1 }),
    );
    expect(gone.actors[cursed.id]?.activeEffects).toEqual([]);
  });

  it("holds Contagion's Poisoned against what would end it until the save is made", async () => {
    const content = await run();
    const sick = {
      ...hero([]),
      activeEffects: [
        effect({
          modifier: { kind: "condition", condition: "poisoned" },
          clings: { ability: "con", dc: 30 },
        }),
      ],
    };
    const context = contextOf(content, [sick], scripted([1]).dice);
    expect(clingSave(sick, "poisoned", context).held).toBe(true);
    const events = leafEvents(
      [{ kind: "removeCondition", condition: "poisoned" }],
      "spell:cure",
      sick,
      sick,
      { ...context, dice: scripted([1]).dice },
    );
    expect(payloads(events, "conditionRemoved")).toEqual([]);
  });

  it("wastes a spell cast through Power Word Pain on a failed save, keeping the slot when it says so", async () => {
    const content = await run();
    const pained = {
      ...hero([]),
      activeEffects: [
        effect({
          modifier: {
            kind: "castSave",
            ability: "con",
            dc: 30,
            keepSlot: true,
          },
        }),
      ],
    };
    const context = contextOf(content, [pained], scripted([1]).dice);
    expect(castSaveFoiled(pained, true, context)).toMatchObject({
      failed: true,
      keepSlot: true,
    });
    expect(castSaveFoiled(pained, false, context)).toBeNull();
  });

  it("lets Abjure Foes' target only move, act or take a Bonus Action", async () => {
    const content = await run();
    const awed = {
      ...hero([]),
      activeEffects: [
        effect({ modifier: { kind: "actionLimit", oneThing: true } }),
      ],
    };
    const stats = deriveStats(awed, content);
    expect(walkSpeed(awed, stats)).toBeGreaterThan(0);
    const acted = { ...awed, budget: { ...awed.budget, action: false } };
    expect(walkSpeed(acted, stats)).toBe(0);
    const moved = { ...awed, moved: 5 };
    const attack = stats.actions.find(({ activation }) =>
      activation.cost.includes("action"),
    );
    expect(attack && canAfford(attack, moved, stats)).toBe(false);
  });

  it("can't stand up out of Hideous Laughter's Prone", async () => {
    const content = await run();
    const laughing = at(hero([]), 0, 0, {
      activeEffects: [
        effect({
          modifier: { kind: "condition", condition: "prone" },
          cantStand: true,
        }),
      ],
    });
    const context = onGrid(content, [laughing]);
    const options = tacticOptions(laughing, context.state, content);
    expect(options.some(({ label }) => label.startsWith("Stand up"))).toBe(
      false,
    );
    expect(hasCondition(laughing, "prone")).toBe(true);
  });

  it("drops only the weapons outside the pack", async () => {
    const content = await run();
    const fighter = at(hero([]), 2, 2, {
      inventory: ["srd52:item/longsword", "srd52:item/dagger"],
      stowed: ["srd52:item/dagger"],
    });
    const context = onGrid(content, [fighter]);
    expect(payloads(dropEvents(fighter, context), "weaponThrown")).toEqual([
      expect.objectContaining({ item: "srd52:item/longsword" }),
    ]);
  });
});
