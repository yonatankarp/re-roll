import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import { startRun, step } from "../engine/run/turn.ts";
import {
  sceneDamage,
  sceneEffects,
  scenePredicates,
} from "../plugins/systems/dnd5.5e/core/scene.ts";
import {
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";

// A started run of the shipped adventure with the fighter chosen, and a seeded context for its state.
async function fighter(seed = "scene") {
  const { run } = await loadAdventure("goblin-ambush");
  const chosen = step(run, startRun(run, "scene").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/fighter",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const state = StateSchema.parse(chosen.state.system);
  const context = (current: DndState, again = seed) => ({
    state: current,
    dice: createDice(rngFromSeed(again)),
    content: run.content,
    contentIds: run.contentIds,
  });
  return { state, context };
}

const fold = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);

const damageTo = (events: readonly SystemEvent[], actor: string) =>
  events.reduce((total, event) => {
    if (event.kind !== `${NS}:damaged` || !("payload" in event)) return total;
    const hit = event.payload as { actor: string; amount: number };
    return hit.actor === actor ? total + hit.amount : total;
  }, 0);

describe("scene damage", () => {
  const trap = {
    dice: "2d6",
    bonus: 0,
    times: 1,
    type: "piercing" as const,
  };

  it("halves the damage for a target who saves, from the same roll", async () => {
    const { state, context } = await fighter();
    const save = (dc: number) =>
      sceneDamage(
        {
          ...trap,
          who: "player",
          save: { ability: "dex", dc, onSuccess: "half" },
        },
        context(state),
      );
    const failed = save(99);
    const saved = save(1);
    expect(failed.some((event) => event.kind === `${NS}:saveRolled`)).toBe(
      true,
    );
    const full = damageTo(failed, PLAYER_ACTOR);
    expect(full).toBeGreaterThan(1);
    expect(damageTo(saved, PLAYER_ACTOR)).toBe(Math.floor(full / 2));
  });

  it("leaves at least 1 HP outside a fight", async () => {
    const { state, context } = await fighter();
    const events = sceneDamage(
      { dice: "40d10", bonus: 0, times: 1, type: "fire", who: "player" },
      context(state),
    );
    const player = fold(state, events).actors[PLAYER_ACTOR];
    expect(player?.hp).toBe(1);
  });

  it("catches every living party member when it's the party's", async () => {
    const { state, context } = await fighter();
    const members = Object.values(state.actors).filter(
      (actor) => actor.side === "party",
    );
    expect(members.length).toBeGreaterThan(1);
    const events = sceneDamage({ ...trap, who: "party" }, context(state));
    for (const member of members)
      expect(damageTo(events, member.id)).toBeGreaterThan(0);
  });

  it("takes less on Story, as fights do", async () => {
    const { state, context } = await fighter();
    const hit = (difficulty: DndState["difficulty"]) =>
      damageTo(
        sceneDamage(
          { dice: "2d4", bonus: 0, times: 1, type: "fire", who: "player" },
          context({ ...state, difficulty }),
        ),
        PLAYER_ACTOR,
      );
    expect(hit("story")).toBeLessThan(hit("normal"));
  });

  it("rolls the dice as many times as the trap hits", async () => {
    const { state, context } = await fighter();
    const hits = (times: number | string) =>
      damageTo(
        sceneDamage(
          { dice: "1d1", bonus: 0, times, type: "poison", who: "player" },
          context(state),
        ),
        PLAYER_ACTOR,
      );
    expect(hits(3)).toBe(3);
    expect([1, 2, 3]).toContain(hits("1d3"));
  });

  it("refuses arguments that aren't a damage roll", () => {
    const schema = sceneEffects[`${NS}:sceneDamage`].schema;
    expect(schema.safeParse({ dice: "2d6", type: "fire" }).success).toBe(true);
    expect(schema.safeParse({ dice: "2x6", type: "fire" }).success).toBe(false);
    expect(schema.safeParse({ dice: "2d6", type: "sharp" }).success).toBe(
      false,
    );
  });
});

describe("spending gold", () => {
  it("takes the price, never more than the party has", async () => {
    const { state, context } = await fighter();
    const spend = sceneEffects[`${NS}:spendGold`];
    const pay = (gold: number, purse: number) => {
      const before = { ...state, gold: purse };
      const result = spend.apply({ gold }, context(before));
      return fold(before, result.events ?? []).gold;
    };
    expect(pay(30, 100)).toBe(70);
    expect(pay(150, 100)).toBe(0);
    expect(pay(10, 0)).toBe(0);
  });

  it("tells whether the party can pay", async () => {
    const { state } = await fighter();
    const hasGold = scenePredicates[`${NS}:hasGold`];
    expect(hasGold.evaluate({ atLeast: 100 }, { ...state, gold: 100 })).toBe(
      true,
    );
    expect(hasGold.evaluate({ atLeast: 100 }, { ...state, gold: 99.5 })).toBe(
      false,
    );
  });
});
