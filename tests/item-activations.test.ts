import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { itemUseId } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { gainAdvantageFrame } from "../plugins/systems/dnd5.5e/core/combat/strikes.ts";
import { gainRolls } from "../plugins/systems/dnd5.5e/core/gear.ts";
import {
  type ActiveEffect,
  type Actor,
  applyDndEvent,
  frame,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { deriveItem } from "../plugins/systems/dnd5.5e/core/variants.ts";
import { contextOf, hero, scripted, settle, testRun } from "./feat-fixtures.ts";

// Magic items of the test's own for #141's activations: ids and mechanics only.
const item = (name: string, extra: object) => ({
  id: `test:item/${name}`,
  name,
  type: "magicItem",
  category: "wondrousItem",
  rarity: "rare",
  attunement: false,
  text: "Test.",
  automation: "full",
  ...extra,
});
const daily = (id: string, max: number) => ({
  id,
  max: { base: max },
  recharge: [{ on: "dawn", amount: "all" }],
});
const self = (effects: object[], cost: unknown[] = ["action"]) => ({
  cost,
  targeting: { self: true },
  resolution: { kind: "automatic", effects },
});
const ITEMS = [
  item("clock", {
    resources: [daily("clock", 1)],
    activations: [
      {
        name: "Clockwork",
        activation: {
          cost: [{ resource: "clock" }],
          trigger: { afterHit: "attack", fixedRoll: 10 },
          targeting: { creatures: 1, range: 600, side: "enemy" },
          resolution: { kind: "automatic", effects: [] },
        },
      },
    ],
  }),
  item("wand", { resources: [daily("wand", 7)] }),
  item("brooch", {
    resources: [daily("brooch", 3)],
    activations: [
      {
        name: "Brooch",
        activation: {
          cost: ["reaction", { resource: "brooch" }],
          trigger: { hitDamages: true, within: 60 },
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            effects: [{ kind: "retypeHit", types: ["acid", "cold", "fire"] }],
          },
        },
      },
    ],
  }),
  item("adder", {
    activations: [
      {
        name: "Snake",
        activation: self(
          [
            {
              kind: "modifier",
              modifier: { kind: "grantedAction", damage: "poison" },
              duration: { minutes: 1 },
            },
          ],
          ["bonusAction"],
        ),
      },
    ],
    granted: {
      cost: ["action"],
      targeting: { creatures: 1, range: 5, side: "enemy" },
      resolution: {
        kind: "attack",
        attack: { type: "weapon", ability: "wis" },
        damage: [{ amount: { dice: "3d6" }, type: "poison" }],
        onHit: [],
        onMiss: [],
      },
    },
  }),
  item("rod", {
    resources: [
      { id: "rod", max: { base: 50 }, startsWith: "1d10", recharge: [] },
    ],
  }),
  item("coin", {
    resources: [daily("coin", 1)],
    activations: [
      {
        name: "Toss",
        activation: {
          cost: ["action", { resource: "coin" }],
          targeting: { creatures: 1, range: 60, side: "enemy" },
          resolution: {
            kind: "automatic",
            effects: [
              { kind: "randomAction", of: ["Heads (coin)", "Tails (coin)"] },
            ],
          },
        },
      },
      {
        name: "Heads",
        rolled: true,
        activation: {
          cost: [],
          targeting: { creatures: 1, range: 60, side: "enemy" },
          resolution: {
            kind: "automatic",
            damage: [{ amount: { dice: "2d4" }, type: "psychic" }],
            effects: [],
          },
        },
      },
      {
        name: "Tails",
        rolled: true,
        activation: {
          cost: [],
          targeting: { self: true },
          resolution: {
            kind: "automatic",
            damage: [{ amount: { dice: "1d4" }, type: "psychic" }],
            effects: [],
          },
        },
      },
    ],
  }),
  item("javelin", {
    category: "weapon",
    altTypes: ["lightning"],
  }),
];

async function itemRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(ITEMS.map((entry) => [entry.id, entry]));
  const access: RunContext = {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id) ?? deriveItem(id, access),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
  return access;
}

const carrying = (
  items: readonly string[],
  extra: Partial<Actor> = {},
): Actor => ({
  ...hero([]),
  hp: 30,
  inventory: ["srd52:item/longsword", ...items],
  position: { x: 0, y: 0 },
  ...extra,
});
const foeAt = (x: number, extra: Partial<Actor> = {}): Actor => ({
  ...hero([], { id: "foe" }),
  side: "enemy",
  hp: 60,
  position: { x, y: 0 },
  ...extra,
});
const resisting = (damage: string): ActiveEffect => ({
  sourceId: "test",
  casterId: "test",
  ends: "spellDuration",
  modifier: { kind: "resistance", damage: damage as "slashing" },
});
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const actionOf = (run: RunContext, actor: Actor, id: string): KnownAction => {
  const found = deriveStats(actor, run).actions.find(
    (action) => action.id === id,
  );
  if (!found) throw new Error(`No ${id}`);
  return found;
};
const after = (actor: Actor, events: readonly SystemEvent[]): Actor => {
  let state = contextOf({} as never, [actor], scripted([]).dice).state;
  for (const event of events) state = applyDndEvent(state, event);
  return state.actors[actor.id] ?? actor;
};
const hit = (attacker: string, actionId: string) =>
  frame("applyHit", {
    attacker,
    actionId,
    target: "foe",
    critical: false,
    hadAdvantage: false,
    total: 30,
    natural: 15,
  });

describe("magic item activations (#141)", () => {
  it("takes a Clockwork Amulet's 10 in place of an attack roll's d20, paid as it's picked", async () => {
    const run = await itemRun();
    const wearer = carrying(["test:item/clock"]);
    const foe = foeAt(1);
    const context = contextOf(run, [wearer, foe], scripted([]).dice);
    expect(
      gainAdvantageFrame(
        {
          attacker: PLAYER_ACTOR,
          actionId: "weapon:srd52:item/longsword",
          target: "foe",
        },
        context,
      ),
    ).not.toBeNull();
    const { events } = settle(
      run,
      [wearer, foe],
      [
        frame("advantageGained", {
          attacker: PLAYER_ACTOR,
          actionId: "weapon:srd52:item/longsword",
          target: "foe",
          answer: `${itemUseId("test:item/clock", 0)}|foe`,
        }),
      ],
      scripted([3, 3]).dice,
      () => "",
    );
    expect(payloads(events, "rollReported")[0]).toMatchObject({ natural: 10 });
    expect(payloads(events, "resourceSpent")).toContainEqual({
      actor: PLAYER_ACTOR,
      resource: "clock",
    });
  });

  it("gives back charges to the daily item with most spent, as an Arcane Battery", async () => {
    const run = await itemRun();
    const actor = carrying(["test:item/wand"], { resourcesSpent: { wand: 6 } });
    const events = leafEvents(
      [
        {
          kind: "rechargeItem",
          amount: { dice: "1d4", bonus: { base: 1, add: [] } },
        },
      ],
      "test",
      actor,
      actor,
      contextOf(run, [actor], scripted([3]).dice),
    );
    expect(payloads(events, "resourceRestored")).toEqual([
      { actor: PLAYER_ACTOR, resource: "wand", amount: 4 },
    ]);
  });

  it("turns an ally's hit to a type the target doesn't resist with a Brooch of the Elements, and a Javelin of Lightning picks its own", async () => {
    const run = await itemRun();
    const bearer = carrying(["test:item/brooch"], { id: "bearer" });
    const ally = carrying([], { position: { x: 1, y: 0 } });
    const foe = foeAt(2, { activeEffects: [resisting("slashing")] });
    const { events } = settle(
      run,
      [ally, bearer, foe],
      [hit(PLAYER_ACTOR, "weapon:srd52:item/longsword")],
      scripted([]).dice,
      () => "",
    );
    expect(payloads(events, "damaged")[0]?.type).toBe("acid");
    expect(payloads(events, "budgetSpent")).toContainEqual(
      expect.objectContaining({ actor: "bearer", kind: "reaction" }),
    );
    const thrower = carrying(["test:item/javelin--1--longsword"], {
      position: { x: 1, y: 0 },
    });
    const javelin = settle(
      run,
      [thrower, foeAt(2, { activeEffects: [resisting("slashing")] })],
      [hit(PLAYER_ACTOR, "weapon:test:item/javelin--1--longsword")],
      scripted([]).dice,
      () => "",
    );
    expect(payloads(javelin.events, "damaged")[0]?.type).toBe("lightning");
  });

  it("offers an item's granted action while its activation's effect lasts, as a Staff of the Adder's snake head", async () => {
    const run = await itemRun();
    const holder = carrying(["test:item/adder"]);
    const use = actionOf(run, holder, itemUseId("test:item/adder", 0));
    const effect = leafEvents(
      use.activation.resolution.kind === "automatic"
        ? use.activation.resolution.effects
        : [],
      use.id,
      holder,
      holder,
      contextOf(run, [holder], scripted([]).dice),
    );
    const animated = after(holder, effect);
    expect(
      actionOf(run, animated, `granted:${itemUseId("test:item/adder", 0)}`)
        .activation.resolution,
    ).toMatchObject({ attack: { ability: "wis" } });
  });

  it("finds a Rod of Absorption holding only its starting energy", async () => {
    const run = await itemRun();
    const actor = carrying([]);
    const events = gainRolls(
      actor,
      ["test:item/rod"],
      contextOf(run, [actor], scripted([7]).dice),
    );
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "rod", amount: 43 },
    ]);
  });

  it("rolls a Rival Coin's heads or tails, which aren't offered on their own", async () => {
    const run = await itemRun();
    const tosser = carrying(["test:item/coin"]);
    const foe = foeAt(3);
    const ids = deriveStats(tosser, run).actions.map((action) => action.id);
    expect(ids).toContain(itemUseId("test:item/coin", 1));
    expect(
      deriveStats(tosser, run).actions.find(
        (action) => action.id === itemUseId("test:item/coin", 1),
      )?.rolled,
    ).toBe(true);
    const { events } = settle(
      run,
      [tosser, foe],
      [
        frame("useAction", {
          actor: PLAYER_ACTOR,
          actionId: itemUseId("test:item/coin", 0),
          target: "foe",
          free: true,
        }),
      ],
      scripted([2, 4, 4]).dice,
      () => "",
    );
    expect(payloads(events, "damaged").map((item) => item.actor)).toEqual([
      PLAYER_ACTOR,
    ]);
  });
});
