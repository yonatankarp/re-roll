import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import type { RunContext } from "../engine/run/turn.ts";
import { describe, expect, it } from "vitest";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  type Actor,
  type ActiveEffect,
  applyDndEvent,
  frame,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  grantedKey,
  type KnownAction,
  UNARMED_STRIKE,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { deriveItem } from "../plugins/systems/dnd5.5e/core/variants.ts";
import { contextOf, hero, scripted, settle, testRun } from "./feat-fixtures.ts";

// Magic items of the test's own for #142's single-use items and #180's riders: ids and mechanics only.
const item = (name: string, extra: object) => ({
  id: `test:item/${name}`,
  name,
  type: "magicItem",
  category: "potion",
  rarity: "rare",
  attunement: false,
  text: "Test.",
  automation: "full",
  ...extra,
});
const self = (effects: object[]) => ({
  cost: ["bonusAction"],
  targeting: { self: true },
  resolution: { kind: "automatic", effects },
});
const minute = { minutes: 1 };
const ITEMS = [
  item("speed", {
    activation: self([
      {
        kind: "modifier",
        modifier: { kind: "hasted", noLethargy: true },
        duration: minute,
      },
    ]),
  }),
  item("fire-breath", {
    activation: self([
      {
        kind: "modifier",
        modifier: { kind: "grantedAction", damage: "fire", uses: 3 },
        duration: { minutes: 60 },
      },
    ]),
    granted: {
      cost: ["bonusAction"],
      targeting: { creatures: 1, range: 30, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: { base: 13 },
        damage: [{ amount: { dice: "4d6" }, type: "fire" }],
        onSuccessDamage: "half",
      },
    },
  }),
  item("giant", {
    variants: [
      {
        rarity: "uncommon",
        name: "Giant (hill)",
        activation: self([
          {
            kind: "modifier",
            modifier: { kind: "setScore", ability: "str", score: 21 },
            duration: { minutes: 60 },
          },
        ]),
      },
    ],
  }),
  item("oil", {
    verb: "Apply",
    activation: self([{ kind: "note", text: "Test." }]),
  }),
  item("wraps", {
    category: "wondrousItem",
    bonuses: [
      { to: "attack", amount: 2, weapons: ["unarmed-strike"] },
      { to: "damage", amount: 2, weapons: ["unarmed-strike"] },
    ],
  }),
  item("arrow", {
    category: "weapon",
    ammunition: true,
    variants: [
      {
        rarity: "rare",
        bonuses: [
          { to: "attack", amount: 2 },
          { to: "damage", amount: 2 },
        ],
      },
    ],
  }),
];

async function itemRun() {
  const run = await testRun();
  const byId = new Map(ITEMS.map((entry) => [entry.id, entry]));
  const access: RunContext = {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id) ?? deriveItem(id, access),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
  return access;
}
type Run = Awaited<ReturnType<typeof itemRun>>;

const carrying = (items: readonly string[], extra: Partial<Actor> = {}) => ({
  ...hero([]),
  hp: 30,
  inventory: ["srd52:item/longsword", ...items],
  ...extra,
});
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const actionOf = (run: Run, actor: Actor, id: string): KnownAction => {
  const found = deriveStats(actor, run).actions.find(
    (action) => action.id === id,
  );
  if (!found) throw new Error(`No ${id}`);
  return found;
};
// The actor once these events have happened to it.
const after = (actor: Actor, events: readonly SystemEvent[]): Actor => {
  let state = contextOf({} as never, [actor], scripted([]).dice).state;
  for (const event of events) state = applyDndEvent(state, event);
  return state.actors[actor.id] ?? actor;
};

describe("single-use magic items (#142)", () => {
  it("drinks a potion's own activation, named by its verb, and uses it up", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/speed", "test:item/oil"]);
    const drink = actionOf(run, actor, "item:test:item/speed");
    expect(drink.name).toBe("Drink speed");
    expect(actionOf(run, actor, "item:test:item/oil").name).toBe("Apply oil");
    const { events = [] } = resolveAction(
      drink,
      actor,
      [actor],
      contextOf(run, [actor], scripted([]).dice),
    );
    // Haste without its lethargy, as a Potion of Speed.
    const added = payloads(events, "effectAdded").map(
      (item) => (item.effect as ActiveEffect).modifier.kind,
    );
    expect(added).toEqual(["hasted"]);
  });

  it("gives an item's own action for a grant, as a Potion of Fire Breath's three exhales", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/fire-breath"]);
    const { events = [] } = resolveAction(
      actionOf(run, actor, "item:test:item/fire-breath"),
      actor,
      [actor],
      contextOf(run, [actor], scripted([]).dice),
    );
    const source = "item:test:item/fire-breath";
    expect(payloads(events, "resourceRestored")).toContainEqual({
      actor: PLAYER_ACTOR,
      resource: grantedKey(source),
    });
    const breathing = after(actor, events);
    const stats = deriveStats(breathing, run);
    const breath = actionOf(run, breathing, `granted:${source}`);
    expect(breath.name).toBe("fire-breath");
    expect(breath.activation.cost).toContainEqual({
      resource: grantedKey(source),
    });
    expect(stats.resources[grantedKey(source)]).toBe(3);
  });

  it("sets an ability score while a drink lasts, as a Potion of Giant Strength", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/giant--1"]);
    const drink = actionOf(run, actor, "item:test:item/giant--1");
    expect(drink.name).toBe("Drink Giant (hill)");
    const { events = [] } = resolveAction(
      drink,
      actor,
      [actor],
      contextOf(run, [actor], scripted([]).dice),
    );
    expect(deriveStats(actor, run).abilities.str).toBe(17);
    expect(deriveStats(after(actor, events), run).abilities.str).toBe(21);
  });
});

describe("magic item riders (#180)", () => {
  it("gives every character an Unarmed Strike, and Wraps of Unarmed Power add to it", async () => {
    const run = await itemRun();
    const strike = actionOf(run, carrying([]), UNARMED_STRIKE);
    const { resolution } = strike.activation;
    if (resolution.kind !== "attack") throw new Error("Not an attack");
    expect(resolution.attack).toEqual(
      expect.objectContaining({ ability: "str", unarmed: true }),
    );
    expect(resolution.damage[0]?.amount.bonus?.base).toBe(1);
    const wrapped = actionOf(run, carrying(["test:item/wraps"]), UNARMED_STRIKE)
      .activation.resolution;
    if (wrapped.kind !== "attack") throw new Error("Not an attack");
    expect(wrapped.attack.itemBonus).toBe(2);
    expect(wrapped.damage[0]?.amount.bonus?.base).toBe(3);
    // The wraps' bonus goes to no weapon.
    const sword = actionOf(
      run,
      carrying(["test:item/wraps"]),
      "weapon:srd52:item/longsword",
    ).activation.resolution;
    if (sword.kind !== "attack") throw new Error("Not an attack");
    expect(sword.attack.itemBonus).toBeUndefined();
  });

  it("fires magic ammunition with its bonus, and a hit spends one piece", async () => {
    const run = await itemRun();
    const archer = {
      ...carrying([
        "srd52:item/shortbow",
        "test:item/arrow--1",
        "test:item/arrow--1",
      ]),
      position: { x: 0, y: 0 },
    };
    const shot = actionOf(run, archer, "weapon:srd52:item/shortbow");
    expect(shot.ammunition).toBe("test:item/arrow--1");
    const { resolution } = shot.activation;
    if (resolution.kind !== "attack") throw new Error("Not an attack");
    expect(resolution.attack.itemBonus).toBe(2);
    // The ammunition's bonus goes to no other weapon.
    const sword = actionOf(run, archer, "weapon:srd52:item/longsword")
      .activation.resolution;
    if (sword.kind !== "attack") throw new Error("Not an attack");
    expect(sword.attack.itemBonus).toBeUndefined();
    const foe = {
      ...hero([], { id: "foe" }),
      side: "enemy" as const,
      hp: 40,
      position: { x: 3, y: 0 },
    };
    const { events, state } = settle(
      run,
      [archer, foe],
      [
        frame("attackRoll", {
          attacker: PLAYER_ACTOR,
          actionId: shot.id,
          target: "foe",
        }),
      ],
      scripted([18]).dice,
      () => "",
    );
    expect(payloads(events, "itemUsed")).toEqual([
      { actor: PLAYER_ACTOR, item: "test:item/arrow--1" },
    ]);
    expect(
      state.actors[PLAYER_ACTOR]?.inventory.filter(
        (id) => id === "test:item/arrow--1",
      ),
    ).toHaveLength(1);
  });
});
