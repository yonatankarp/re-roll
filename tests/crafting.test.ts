import { type Decision, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { sceneGearActions } from "../plugins/systems/dnd5.5e/core/gear.ts";
import {
  type Actor,
  type DndState,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Features and items of the test's own for #175's crafting and spell preparation: ids and mechanics only.
const item = (name: string, rarity: string) => ({
  id: `test:item/${name}`,
  name,
  type: "magicItem",
  category: "wondrousItem",
  rarity,
  attunement: false,
  text: "Test.",
  automation: "full",
});
const CONTENT = [
  item("charm", "common"),
  item("cloak", "uncommon"),
  item("boots", "uncommon"),
  trait(
    "replicate",
    [
      {
        kind: "replicate",
        class: "fighter",
        resource: "replicate",
        cap: "items",
        plans: [
          { item: "test:item/charm", level: 1 },
          { item: "test:item/cloak", level: 1 },
          { item: "test:item/boots", level: 5 },
        ],
      },
      { kind: "replicateTransmute", resource: "transmute" },
    ],
    {
      resources: [
        {
          id: "replicate",
          max: { base: 3 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
        {
          id: "transmute",
          max: { base: 1 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
    },
  ),
  trait("cheat", [{ kind: "dropToOne", resource: "cheat", replicated: 20 }]),
];

async function craftRun(): Promise<RunContext> {
  const run = await testRun();
  const byId = new Map(CONTENT.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}
const between = (actor: Actor, run: RunContext): DndState => ({
  ...contextOf(run, [actor], scripted([]).dice).state,
  combat: null,
});
const kinds = (events: readonly SystemEvent[] = []) =>
  events.map((event) => event.kind);

describe("crafting, downtime and spell preparation (#175)", () => {
  it("replicates a plan its level allows where the party can rest, the oldest vanishing past the cap", async () => {
    const run = await craftRun();
    const artificer: Actor = {
      ...hero(["replicate"]),
      replicated: ["test:item/charm"],
      inventory: ["srd52:item/longsword", "test:item/charm"],
    };
    const state = between(artificer, run);
    const offers = sceneGearActions(state, run).filter((offer) =>
      ["replicate", "transmute"].includes(offer.id),
    );
    expect(offers.map((offer) => offer.id)).toEqual(["replicate", "transmute"]);
    expect(offers[0]?.rest).toBe(true);
    const menu = run.system.storyEffects[`${NS}:replicateMenu`]?.apply(
      {},
      {
        state,
        dice: scripted([]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    const asked = (menu?.frames?.[0]?.payload as { decision: Decision })
      .decision;
    expect(asked.options.map((option) => option.id)).toEqual([
      "test:item/cloak",
      "done",
    ]);
    const made = settle(run, state, menu?.frames ?? [], scripted([]).dice);
    // The test's scaling key `items` is missing, so the cap is 0 and the charm made before goes.
    expect(kinds(made.events)).toEqual(
      expect.arrayContaining([`${NS}:itemUsed`, `${NS}:treasureFound`]),
    );
    const after = made.state;
    expect(after.actors[PLAYER_ACTOR]?.replicated).toEqual(["test:item/cloak"]);
    expect(after.actors[PLAYER_ACTOR]?.inventory).not.toContain(
      "test:item/charm",
    );
  });

  it("drains the oldest replicated item into a slot by its rarity", async () => {
    const run = await craftRun();
    const artificer: Actor = {
      ...hero([]),
      replicated: ["test:item/cloak"],
      inventory: ["test:item/cloak"],
    };
    const events = leafEvents(
      [{ kind: "drainReplicated" }],
      "test",
      artificer,
      artificer,
      contextOf(run, [artificer], scripted([]).dice),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: `${NS}:resourceRestored`,
        payload: { actor: PLAYER_ACTOR, resource: "slot:2", amount: 1 },
      }),
    );
  });

  it("cheats death with replicated Uncommon items, 20 Hit Points for each", async () => {
    const run = await craftRun();
    const artificer: Actor = {
      ...hero(["cheat"]),
      hp: 5,
      replicated: ["test:item/cloak", "test:item/boots", "test:item/charm"],
      inventory: ["test:item/cloak", "test:item/boots", "test:item/charm"],
      position: { x: 0, y: 0 },
    };
    const events = leafEvents(
      [],
      "test",
      artificer,
      artificer,
      contextOf(run, [artificer], scripted([]).dice),
    );
    expect(events).toEqual([]);
    const { damageEvents } =
      await import("../plugins/systems/dnd5.5e/core/combat/effects.ts");
    const hurt = damageEvents(
      artificer,
      10,
      "slashing",
      false,
      contextOf(run, [artificer], scripted([]).dice),
    );
    const used = hurt.flatMap((event) =>
      event.kind === `${NS}:itemUsed` && "payload" in event
        ? [(event.payload as { item: string }).item]
        : [],
    );
    expect(used.sort()).toEqual(["test:item/boots", "test:item/cloak"]);
  });
});
