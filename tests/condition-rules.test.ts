import { describe, expect, it } from "vitest";
import type { SystemEvent } from "#sdk";
import type { RunContext } from "../engine/run/turn.ts";
import { deathSaveEvents } from "../plugins/systems/dnd5.5e/core/combat/actions.ts";
import {
  moveSquares,
  provokers,
  runAttackRoll,
  startCombat,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import { rollSave } from "../plugins/systems/dnd5.5e/core/combat/effects/saves.ts";
import { abilityCheck } from "../plugins/systems/dnd5.5e/core/actions/checks.ts";
import { dodging } from "../plugins/systems/dnd5.5e/core/tactics.ts";
import {
  fearSources,
  frightenedInSight,
} from "../plugins/systems/dnd5.5e/core/sight.ts";
import { distanceFeet } from "../plugins/systems/dnd5.5e/core/grid.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  deathSaveOutcome,
  exhaustionEvents,
  freshActor,
  isDead,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, hero, scripted, testRun } from "./feat-fixtures.ts";

// #214: condition rules checked against the 2024 Player's Handbook.

const at = (actor: Actor, x: number, y: number, more: Partial<Actor> = {}) => ({
  ...actor,
  position: { x, y },
  ...more,
});
const goblin = (id: string): Actor =>
  freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: "srd52:monster/goblin-warrior" },
    hp: 10,
    inventory: [],
  });
const effect = (
  modifier: ActiveEffect["modifier"],
  casterId = "caster",
): ActiveEffect => ({
  sourceId: "spell:test",
  casterId,
  modifier,
  ends: "spellDuration",
});
const condition = (
  name: "frightened" | "prone" | "invisible" | "blinded" | "grappled",
  casterId = "caster",
) => effect({ kind: "condition", condition: name }, casterId);
const onGrid = (
  run: RunContext,
  actors: readonly Actor[],
  dice = scripted([]).dice,
) => {
  const context = contextOf(run, actors, dice);
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
const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const farthest = (run: RunContext, actor: Actor, state: DndState): number =>
  Math.max(
    ...moveSquares(actor, state, deriveStats(actor, run), run).map(
      ({ square }) => distanceFeet(actor.position, square),
    ),
  );

describe("condition rules (#214)", () => {
  it("makes a Prone creature crawl, at 1 extra foot for each foot", async () => {
    const run = await testRun();
    const standing = at(hero([]), 10, 10);
    const prone = { ...standing, activeEffects: [condition("prone")] };
    expect(farthest(run, standing, onGrid(run, [standing]).state)).toBe(30);
    expect(farthest(run, prone, onGrid(run, [prone]).state)).toBe(15);
  });

  it("gives Frightened Disadvantage only with its source in line of sight", async () => {
    const run = await testRun();
    const source = at(goblin("caster"), 0, 0);
    const scared = at(hero([]), 3, 0, {
      activeEffects: [condition("frightened")],
    });
    const { state } = onGrid(run, [source, scared]);
    expect(frightenedInSight(scared, state)).toBe(true);
    // The source gone from the map, nothing of it is in sight.
    const away = {
      ...state,
      actors: { ...state.actors, caster: { ...source, position: null } },
    };
    expect(frightenedInSight(scared, away)).toBe(false);
    // Out of a fight, with nothing to measure, it always counts.
    expect(frightenedInSight(scared, { ...state, combat: null })).toBe(true);
    // An ability check rolls twice in sight and once out of it.
    const d20s = (world: DndState): number => {
      const { dice, counts } = scripted([]);
      abilityCheck(scared, "athletics", "str", 10, () => "", {
        state: world,
        dice,
        content: run.content,
        contentIds: run.contentIds,
      });
      return counts[20] ?? 0;
    };
    expect(d20s(state)).toBe(2);
    expect(d20s(away)).toBe(1);
  });

  it("keeps a Frightened creature from moving closer to its source", async () => {
    const run = await testRun();
    const source = at(goblin("caster"), 10, 0);
    const scared = at(hero([]), 10, 5, {
      activeEffects: [condition("frightened")],
    });
    const { state } = onGrid(run, [source, scared]);
    expect(fearSources(scared, state).map(({ id }) => id)).toEqual(["caster"]);
    const ends = moveSquares(scared, state, deriveStats(scared, run), run);
    const start = distanceFeet(scared.position, source.position);
    expect(ends.length).toBeGreaterThan(0);
    expect(
      ends.every(
        ({ square }) => distanceFeet(square, source.position) >= start,
      ),
    ).toBe(true);
  });

  it("gives no Opportunity Attack on a mover the reactor can't see", async () => {
    const run = await testRun();
    const foe = at(goblin("foe"), 5, 5);
    const mover = at(hero([]), 6, 5);
    const away = { x: 9, y: 5 };
    const ids = (actor: Actor, reactor: Actor) => {
      const { state } = onGrid(run, [actor, reactor]);
      return provokers(actor, away, state, run, [{ x: 7, y: 5 }, away]).map(
        ({ foe: item }) => item.id,
      );
    };
    expect(ids(mover, foe)).toEqual(["foe"]);
    const unseen = { ...mover, activeEffects: [condition("invisible")] };
    expect(ids(unseen, foe)).toEqual([]);
    const blind = { ...foe, activeEffects: [condition("blinded")] };
    expect(ids(mover, blind)).toEqual([]);
  });

  it("kills a creature at the sixth level of Exhaustion", async () => {
    const run = await testRun();
    const worn = at(hero([]), 0, 0, { exhaustion: 5 });
    const { state } = onGrid(run, [worn]);
    expect(exhaustionEvents(worn, -1)).toHaveLength(1);
    const events = exhaustionEvents(worn, 1);
    expect(events.map(({ kind }) => kind)).toEqual([
      `${NS}:exhaustionChanged`,
      `${NS}:exhaustedToDeath`,
      "actorDefeated",
    ]);
    const after = fold(state, events).actors[worn.id];
    if (!after) throw new Error("gone");
    expect(after.hp).toBe(0);
    expect(isDead(after)).toBe(true);
  });

  it("adds save bonuses and takes Exhaustion off a death save, keeping the natural 1 and 20", async () => {
    const run = await testRun();
    const dying = at(hero([]), 0, 0, { hp: 0, exhaustion: 2 });
    const context = onGrid(run, [dying], scripted([11]).dice);
    const events = deathSaveEvents(dying, context);
    expect(payloads(events, "deathSaveRolled")).toEqual([
      { actor: dying.id, natural: 11, total: 7 },
    ]);
    expect(fold(context.state, events).actors[dying.id]?.deathSaves).toEqual({
      successes: 0,
      failures: 1,
    });
    expect(deathSaveOutcome(20, 16).revived).toBe(true);
    expect(deathSaveOutcome(1, 12).failures).toBe(2);
    expect(deathSaveOutcome(9, 10).success).toBe(true);
  });

  it("fails a dying creature's Strength and Dexterity saves, as Unconscious", async () => {
    const run = await testRun();
    const dying = at(hero([]), 0, 0, { hp: 0 });
    const context = onGrid(run, [dying], scripted([20, 20]).dice);
    expect(rollSave(dying, "dex", 5, context)).toEqual({
      saved: false,
      events: [],
    });
    expect(rollSave(dying, "con", 5, context).saved).toBe(true);
  });

  it("makes any hit on an Unconscious creature within 5 feet a Critical Hit, ranged or not", async () => {
    const run = await testRun();
    const critical = (x: number): unknown => {
      const archer = at(goblin("archer"), x, 0);
      const asleep = at(hero([]), 0, 0, {
        activeEffects: [
          effect({ kind: "condition", condition: "unconscious" }),
        ],
      });
      const context = onGrid(run, [archer, asleep], scripted([15, 15]).dice);
      const rolled = runAttackRoll(
        { attacker: "archer", actionId: "monster:1", target: asleep.id },
        context,
      );
      const hit = rolled.frames?.find(({ kind }) => kind === `${NS}:applyHit`);
      return (hit?.payload as { critical?: boolean } | undefined)?.critical;
    };
    expect(critical(1)).toBe(true);
    expect(critical(4)).toBe(false);
  });

  it("rolls Initiative with Advantage while Invisible and Disadvantage while Incapacitated", async () => {
    const run = await testRun();
    const d20s = (activeEffects: ActiveEffect[]): number => {
      const { dice, counts } = scripted([]);
      startCombat(
        {
          id: "e",
          monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
        },
        {
          state: {
            actors: { hero: { ...hero([], { id: "hero" }), activeEffects } },
            combat: null,
          },
          dice,
          content: run.content,
          contentIds: run.contentIds,
        },
        { canFlee: false, defeatContinues: false },
      );
      return counts[20] ?? 0;
    };
    const plain = d20s([]);
    expect(d20s([condition("invisible")])).toBe(plain + 1);
    expect(
      d20s([effect({ kind: "condition", condition: "incapacitated" })]),
    ).toBe(plain + 1);
  });

  it("ends the Dodge's benefit while the creature's Speed is 0", async () => {
    const run = await testRun();
    const dodger = at(hero([]), 0, 0, {
      activeEffects: [effect({ kind: "tactic", tactic: "dodge" }, "hero")],
    });
    const stats = deriveStats(dodger, run);
    expect(dodging(dodger, stats)).toBe(true);
    const held = {
      ...dodger,
      activeEffects: [...dodger.activeEffects, condition("grappled")],
    };
    expect(dodging(held, stats)).toBe(false);
  });
});
