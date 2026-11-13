import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { carryingCapacity } from "../plugins/systems/dnd5.5e/core/carry.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { provokers } from "../plugins/systems/dnd5.5e/core/combat/movement.ts";
import {
  canAfford,
  findAction,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { ItemSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  buyPriceCp,
  partyDiscount,
} from "../plugins/systems/dnd5.5e/core/shop.ts";
import {
  type Actor,
  NS,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  lookup,
  rollAmount,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { rescuedSave } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import { contextOf, hero, scripted, testRun } from "./feat-fixtures.ts";

const foeOf = (traits: readonly string[] = [], extra: Partial<Actor> = {}) => ({
  ...hero(traits, { id: "foe" }),
  side: "enemy" as const,
  hp: 30,
  ...extra,
});

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );

const SWING = {
  actionId: "weapon:srd52:item/longsword",
  critical: false,
  hadAdvantage: false,
  total: 20,
  natural: 15,
};

describe("feats and traits that act on their own", () => {
  it("spends a Luck Point to give an attack against a badly hurt bearer Disadvantage, as Lucky does", async () => {
    const run = await testRun();
    const maxHp = deriveStats(hero(["lucky"]), run).maxHp;
    const attack = (hp: number, used = 0) => {
      const target = { ...hero(["lucky"]), hp, resourcesSpent: { luck: used } };
      const { dice, counts } = scripted([15, 15]);
      const result = run.system.frames[`${NS}:attackRoll`]?.run(
        { attacker: "foe", actionId: SWING.actionId, target: PLAYER_ACTOR },
        contextOf(run, [target, foeOf()], dice),
      );
      return {
        d20s: counts[20],
        spent: payloads(result?.events ?? [], "resourceSpent").map(
          (payload) => payload.resource,
        ),
      };
    };
    expect(attack(maxHp)).toEqual({ d20s: 1, spent: [] });
    expect(attack(Math.floor(maxHp / 2))).toEqual({ d20s: 2, spent: ["luck"] });
    expect(attack(Math.floor(maxHp / 2), 1)).toEqual({ d20s: 1, spent: [] });
  });

  it("strikes back at an attacker in range that damages the bearer, as Storm's Thunder does", async () => {
    const run = await testRun();
    const hit = (hp: number, foePosition = { x: 1, y: 0 }) => {
      const bearer = { ...hero(["thunder"]), hp, position: { x: 0, y: 0 } };
      const foe = foeOf([], { position: foePosition });
      const result = run.system.frames[`${NS}:applyHit`]?.run(
        { ...SWING, attacker: "foe", target: PLAYER_ACTOR },
        contextOf(run, [bearer, foe], { below: () => 0, roll: () => 4 }),
      );
      const events = result?.events ?? [];
      return {
        struck: payloads(events, "damaged").filter(
          (payload) => payload.actor === "foe",
        ),
        labels: payloads(events, "budgetSpent").map((payload) => payload.label),
      };
    };
    expect(hit(30)).toEqual({
      struck: [expect.objectContaining({ amount: 4, type: "thunder" })],
      labels: ["thunder"],
    });
    // Out of range, or dropped by the hit, it can't.
    expect(hit(30, { x: 13, y: 0 })).toEqual({ struck: [], labels: [] });
    expect(hit(1)).toEqual({ struck: [], labels: [] });
  });

  it("heals with a Healer's Kit by a Hit Point Die, rolling 1s again, as Healer's Battle Medic does", async () => {
    const run = await testRun();
    const medic = { ...hero(["medic"]), inventory: ["test:item/kit"] };
    const friend = { ...hero([], { id: "friend" }), hp: 1 };
    const context = contextOf(run, [medic, friend], scripted([1, 6]).dice);
    const action = findAction(medic, "feature:test:feature/medic:0", context);
    const stats = deriveStats(medic, run);
    expect(canAfford(action, medic, stats)).toBe(true);
    expect(canAfford(action, { ...medic, inventory: [] }, stats)).toBe(false);
    const { resolution } = action.activation;
    const effects = resolution.kind === "automatic" ? resolution.effects : [];
    const events = leafEvents(effects, action.id, medic, friend, context);
    // The 1 on the fighter's d10 is rolled again for a 6, plus a Proficiency Bonus of 2.
    expect(payloads(events, "healed")).toEqual([
      expect.objectContaining({ actor: "friend", amount: 8 }),
    ]);
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: "friend", resource: "hitDice" },
    ]);
    // With its only Hit Point Die spent, the friend gains nothing.
    const spent = { ...friend, resourcesSpent: { hitDice: 1 } };
    expect(leafEvents(effects, action.id, medic, spent, context)).toEqual([]);
  });

  it("rolls a 1 on an amount's die again when it says so, as Tavern Brawler's strike does", async () => {
    const run = await testRun();
    const stats = deriveStats(hero([]), run);
    expect(rollAmount({ dice: "1d4" }, stats, scripted([1, 3]).dice)).toBe(1);
    expect(
      rollAmount(
        { dice: "1d4", rerollOnes: true },
        stats,
        scripted([1, 3]).dice,
      ),
    ).toBe(3);
  });

  it("takes 20 percent off nonmagical items for a Crafter in the party", async () => {
    const run = await testRun();
    const { state } = contextOf(run, [hero(["crafter"])], scripted([]).dice);
    expect(partyDiscount(state, run)).toBe(20);
    expect(
      partyDiscount(contextOf(run, [hero([])], scripted([]).dice).state, run),
    ).toBe(0);
    const kit = lookup(run, ItemSchema, "test:item/kit");
    // 500 cp, 10 percent off for a friendly merchant and 20 more for the Crafter.
    expect(buyPriceCp({ item: kit.id }, kit, 10, 20)).toBe(360);
    const potion = lookup(run, ItemSchema, "srd52:item/potion-of-healing");
    expect(buyPriceCp({ item: potion.id, price: 50 }, potion, 0, 20)).toBe(
      5000,
    );
  });

  it("carries as one size larger with Powerful Build", async () => {
    expect(carryingCapacity(15, "medium")).toBe(225);
    expect(carryingCapacity(15, "medium", true)).toBe(450);
    expect(carryingCapacity(15, "large", true)).toBe(900);
    const run = await testRun();
    // Five sets of chain mail are 275 pounds, past a Strength of 17's 255 but not its 510.
    const loaded = (traits: readonly string[]) =>
      deriveStats(
        {
          ...hero(traits),
          inventory: Array.from({ length: 5 }, () => "srd52:item/chain-mail"),
          stowed: Array.from({ length: 5 }, () => "srd52:item/chain-mail"),
        },
        run,
      ).speed;
    expect(loaded([])).toBe(5);
    expect(loaded(["mighty"])).toBe(30);
  });

  it("gives a Mage Slayer's target Disadvantage to keep Concentration, and turns its own failed save into a success once", async () => {
    const run = await testRun();
    const target = { ...foeOf(), concentratingOn: "srd52:spell/bless" };
    const save = (traits: readonly string[]) =>
      run.system.frames[`${NS}:applyHit`]
        ?.run(
          { ...SWING, attacker: PLAYER_ACTOR, target: "foe" },
          contextOf(run, [hero(traits), target], scripted([]).dice),
        )
        .frames?.find((item) => item.kind === `${NS}:concentrationSave`)
        ?.payload;
    expect(save(["mage-slayer"])).toMatchObject({ disadvantage: true });
    expect(save([])).not.toHaveProperty("disadvantage");
    const { counts, dice } = scripted([15, 15]);
    run.system.frames[`${NS}:concentrationSave`]?.run(
      { actor: "foe", dc: 10, disadvantage: true },
      contextOf(run, [target], dice),
    );
    expect(counts[20]).toBe(2);

    const slayer = hero(["mage-slayer"]);
    const stats = deriveStats(slayer, run);
    const used = rescuedSave(slayer, "wis", stats, []);
    expect(used).toMatchObject({ payload: { resource: "mind" } });
    expect(used && rescuedSave(slayer, "wis", stats, [used])).toBeNull();
    expect(rescuedSave(slayer, "str", stats, [])).toBeNull();
  });

  it("makes Opportunity Attacks through Disengage and stops the creature it hits, as Sentinel does", async () => {
    const run = await testRun();
    const disengaged = {
      ...hero([]),
      position: { x: 1, y: 0 },
      activeEffects: [
        {
          sourceId: "disengage",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "tactic" as const, tactic: "disengage" as const },
          ends: "casterNextTurn" as const,
        },
      ],
    };
    const away = (traits: readonly string[]) => {
      const foe = foeOf(traits, { position: { x: 0, y: 0 } });
      const context = contextOf(run, [disengaged, foe], scripted([]).dice);
      const state = {
        ...context.state,
        combat: {
          encounter: "arena",
          order: [PLAYER_ACTOR, "foe"],
          index: 0,
          round: 1,
          grid: { width: 10, height: 10 },
        },
      };
      return provokers(disengaged, { x: 3, y: 0 }, state, run).length;
    };
    expect(away([])).toBe(0);
    expect(away(["sentinel"])).toBe(1);

    // Hit in its own turn, the walker's move ends where it stood.
    const walk = (traits: readonly string[]) => {
      const walker = { ...hero([]), hp: 30, position: { x: 1, y: 0 } };
      const context = contextOf(
        run,
        [walker, foeOf(traits, { position: { x: 0, y: 0 } })],
        scripted([]).dice,
      );
      const events =
        run.system.frames[`${NS}:applyHit`]?.run(
          { ...SWING, attacker: "foe", target: PLAYER_ACTOR },
          context,
        ).events ?? [];
      const after = events.reduce(applyDndEvent, context.state);
      return (
        run.system.frames[`${NS}:finishMove`]?.run(
          { actor: PLAYER_ACTOR, x: 2, y: 0, feet: 5 },
          { ...context, state: after },
        ).events ?? []
      ).length;
    };
    expect(walk(["sentinel"])).toBe(0);
    expect(walk([])).toBe(1);
  });

  it("attacks a creature it grapples with Advantage, as Grappler does", async () => {
    const run = await testRun();
    const d20s = (traits: readonly string[]) => {
      const held = foeOf([], {
        activeEffects: [
          {
            sourceId: "grapple",
            casterId: PLAYER_ACTOR,
            modifier: { kind: "condition", condition: "grappled" },
            ends: "spellDuration",
          },
        ],
      });
      const { dice, counts } = scripted([15, 15]);
      run.system.frames[`${NS}:attackRoll`]?.run(
        { attacker: PLAYER_ACTOR, actionId: SWING.actionId, target: "foe" },
        contextOf(run, [hero(traits), held], dice),
      );
      return counts[20];
    };
    expect(d20s(["grappler"])).toBe(2);
    expect(d20s([])).toBe(1);
  });

  it("rolls a low piercing damage die again once a turn, and one more die on a Critical Hit, as Piercer does", async () => {
    const run = await testRun();
    const stab = (
      traits: readonly string[],
      used: readonly string[] = [],
      critical = false,
    ) => {
      const attacker = {
        ...hero(traits),
        inventory: ["srd52:item/shortsword"],
        usedThisTurn: [...used],
      };
      const { dice, counts } = scripted([1, 5, 2]);
      const events =
        run.system.frames[`${NS}:applyHit`]?.run(
          {
            ...SWING,
            actionId: "weapon:srd52:item/shortsword",
            attacker: PLAYER_ACTOR,
            target: "foe",
            critical,
          },
          contextOf(run, [attacker, foeOf()], dice),
        ).events ?? [];
      return {
        damage: payloads(events, "damaged").map((payload) => payload.amount),
        d6s: counts[6],
      };
    };
    // A 1 on the d6 plus a Strength modifier of 3, or the 1 rolled again for a 5.
    expect(stab([])).toEqual({ damage: [4], d6s: 1 });
    expect(stab(["piercer"])).toEqual({ damage: [8], d6s: 2 });
    expect(stab(["piercer"], ["reroll:piercing"])).toEqual({
      damage: [4],
      d6s: 1,
    });
    // A Critical Hit rolls two dice and one more.
    expect(stab(["piercer"], ["reroll:piercing"], true).d6s).toBe(3);
  });
});
