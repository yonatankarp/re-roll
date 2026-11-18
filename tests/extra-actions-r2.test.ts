import { describe, expect, it } from "vitest";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { runBringAlong } from "../plugins/systems/dnd5.5e/core/combat/movement.ts";
import {
  attackedKey,
  canAfford,
  inReach,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  type Actor,
  ATTACK_ACTION,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  turnId,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hero, trait } from "./feat-fixtures.ts";
import { at, block, monster, onMap, runWith } from "./senses-fixtures.ts";

// Extra actions, gates and turns of #200, on made-up traits.

const strike = {
  targeting: { creatures: 1, range: 120, side: "enemy" },
  resolution: { kind: "automatic", effects: [{ kind: "weaponAttack" }] },
};
const FIXTURES = [
  block("foe"),
  trait("sudden", [], {
    activations: [{ ...strike, cost: ["bonusAction"], afterAction: "attack" }],
  }),
  trait("late", [], {
    activations: [
      {
        ...strike,
        cost: ["bonusAction"],
        minLevel: { class: "srd52:class/fighter", level: 3 },
      },
    ],
  }),
  trait("third", [], {
    activations: [{ ...strike, cost: [], afterTargets: 2 }],
  }),
  trait("bonded", [{ kind: "warBond" }]),
  trait("floored", [
    { kind: "modifier", modifier: { kind: "speedFloor", feet: 50 } },
  ]),
];

const own = (actor: Actor, run: Awaited<ReturnType<typeof runWith>>) => {
  const stats = deriveStats(actor, run);
  const action = stats.actions.find((item) =>
    item.id.startsWith("feature:test:"),
  );
  if (!action) throw new Error("no feature action");
  return { stats, action };
};

describe("action gates", () => {
  it("waits on the Attack action, a class level and creatures already attacked", async () => {
    const run = await runWith(FIXTURES);
    const fresh = hero(["sudden"]);
    const { stats, action } = own(fresh, run);
    expect(canAfford(action, fresh, stats)).toBe(false);
    const attacked: Actor = {
      ...fresh,
      budget: { ...fresh.budget, action: false },
      usedThisTurn: [ATTACK_ACTION],
    };
    expect(canAfford(action, attacked, stats)).toBe(true);
    const low = own(hero(["late"]), run);
    expect(canAfford(low.action, hero(["late"]), low.stats)).toBe(false);
    const high = hero(["late"], { level: 3 });
    const raised = own(high, run);
    expect(canAfford(raised.action, high, raised.stats)).toBe(true);
    // Distant Strike's third attack: two creatures attacked, then only at one it hasn't.
    const ranger = at(hero(["third"]), 0, 0);
    const third = own(ranger, run);
    const foes = [
      at(monster("f1", "foe"), 1, 0),
      at(monster("f2", "foe"), 0, 1),
      at(monster("f3", "foe"), 1, 1),
    ];
    const state = onMap(["...", "...", "..."], [ranger, ...foes]);
    expect(canAfford(third.action, ranger, third.stats)).toBe(false);
    const twice: Actor = {
      ...ranger,
      usedThisTurn: [attackedKey("f1"), attackedKey("f2")],
    };
    expect(canAfford(third.action, twice, third.stats)).toBe(true);
    expect(
      inReach(third.action, ranger, state, run).map((item) => item.id),
    ).toEqual(["f1", "f2", "f3"]);
    expect(
      inReach(third.action, twice, state, run).map((item) => item.id),
    ).toEqual(["f3"]);
  });
});

describe("turns and movement", () => {
  it("gives Thief's Reflexes a second turn before the creature it comes before, once", () => {
    const actors = ["a", "b", "c"].map((id) => monster(id, "foe"));
    const start = onMap(["..."], actors);
    let state: DndState = {
      ...start,
      combat: start.combat && {
        ...start.combat,
        secondTurns: [{ actor: "a", before: "c" }],
      },
    };
    const next = (): string | undefined => {
      state = applyDndEvent(state, dndEvent(`${NS}:turnAdvanced`, {}));
      return turnId(state.combat);
    };
    expect(next()).toBe("b");
    expect(next()).toBe("a");
    expect(state.combat?.round).toBe(1);
    expect(next()).toBe("c");
    expect(next()).toBe("a");
    expect(state.combat?.round).toBe(2);
    expect(next()).toBe("b");
  });

  it("lands the allies a teleport brings beside where it lands", async () => {
    const run = await runWith(FIXTURES);
    const teleporter = at(hero([]), 5, 0);
    const ally = at(monster("ally", "foe", "party"), 0, 0);
    const state = onMap([".........."], [teleporter, ally]);
    const context = { ...run, state, dice: { below: () => 0, roll: () => 1 } };
    const landed = runBringAlong(
      {
        actor: teleporter.id,
        x: 5,
        y: 0,
        near: 5,
        count: 1,
        allies: ["ally"],
        answer: "ally",
      },
      context,
    );
    const moved = landed.events?.[0] as
      { payload: { actor: string; to: { x: number } } } | undefined;
    expect(moved?.payload).toMatchObject({ actor: "ally" });
    const to = moved?.payload.to ?? { x: 0 };
    expect(Math.abs(to.x - 5)).toBe(1);
    const alone = runBringAlong(
      {
        actor: teleporter.id,
        x: 5,
        y: 0,
        near: 5,
        count: 1,
        allies: ["ally"],
        answer: "none",
      },
      context,
    );
    expect(alone.events ?? []).toEqual([]);
  });

  it("keeps War Bond's weapon in hand, and holds a Speed at its floor", async () => {
    const run = await runWith(FIXTURES);
    const disarm = (actor: Actor) => {
      const state = onMap([".."], [at(actor, 0, 0)]);
      const context = {
        ...run,
        state,
        dice: { below: () => 0, roll: () => 1 },
      };
      return leafEvents(
        [{ kind: "disarm" }],
        "test",
        actor,
        at(actor, 0, 0),
        context,
      ).map((event) => event.kind);
    };
    expect(disarm(hero([]))).toContain(`${NS}:weaponThrown`);
    expect(disarm(hero(["bonded"]))).toEqual([]);
    expect(deriveStats(hero(["floored"]), run).speed).toBe(50);
  });
});
