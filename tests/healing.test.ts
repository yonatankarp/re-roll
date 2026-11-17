import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { sceneCastActions } from "../plugins/systems/dnd5.5e/core/camp.ts";
import {
  leafEvents,
  payCosts,
  sharedHealing,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  canAfford,
  findAction,
  goldFor,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  FeatureSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { nextDndDecision } from "../plugins/systems/dnd5.5e/core/combat/decisions.ts";
import {
  deriveStats,
  lookup,
  saveBonus,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Made-up healing traits: ids and mechanics only.
const ally = { creatures: 1, range: "touch", side: "ally" };
const auto = (effects: readonly object[]) => ({ kind: "automatic", effects });
const FIXTURES = [
  trait("hands", [], {
    resources: [{ id: "hands", max: { base: 10 }, recharge: [] }],
    activations: [
      {
        cost: ["bonusAction"],
        targeting: ally,
        resolution: auto([
          {
            kind: "heal",
            amount: { bonus: { base: 1 } },
            pool: { resource: "hands" },
          },
        ]),
      },
    ],
  }),
  trait("light", [], {
    resources: [{ id: "light", max: { base: 5 }, recharge: [] }],
    activations: [
      {
        cost: ["bonusAction"],
        targeting: ally,
        resolution: auto([
          {
            kind: "heal",
            amount: { dice: "1d6" },
            pool: { resource: "light", most: { base: 2 }, temp: true },
          },
        ]),
      },
    ],
  }),
  trait("raise", [], {
    activations: [
      {
        cost: ["action", { gold: 50 }],
        outOfCombat: true,
        targeting: { ...ally, dead: true, diedWithin: 8 },
        resolution: auto([
          { kind: "heal", amount: { bonus: { base: 1 } } },
          { kind: "ordeal", penalty: 4 },
        ]),
      },
    ],
  }),
  trait("mercy", [{ kind: "maxHealingAtZero" }], {
    activations: [
      {
        cost: ["action"],
        targeting: ally,
        resolution: auto([{ kind: "heal", amount: { dice: "2d4" } }]),
      },
    ],
  }),
  trait("restore", [
    { kind: "shakeOff", conditions: ["poisoned", "frightened"] },
  ]),
  trait("pull", [
    {
      kind: "extraDamage",
      dice: "1d4",
      when: "targetHurt",
      oncePerTurn: true,
      type: "necrotic",
    },
  ]),
];

async function healingRun() {
  const run = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id: string) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );

const effectsOf = (action: ReturnType<typeof findAction>) =>
  action.activation.resolution.kind === "automatic"
    ? action.activation.resolution.effects
    : [];

const dead = (actor: Actor): Actor => ({
  ...actor,
  hp: 0,
  deathSaves: { successes: 0, failures: 3 },
});

const between = (actors: readonly Actor[], gold = 0): DndState => ({
  actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
  combat: null,
  gold,
});

describe("healing, curing and raising the dead (#162)", () => {
  it("heals from a pool just what the target is missing, and can't with the pool spent, as Lay On Hands", async () => {
    const run = await healingRun();
    const healer = hero(["hands"]);
    const max = deriveStats(hero([]), run).maxHp;
    const friend = { ...hero([], { id: "friend" }), hp: max - 3 };
    const context = contextOf(run, [healer, friend], scripted([]).dice);
    const action = findAction(healer, "feature:test:feature/hands:0", context);
    const events = leafEvents(
      effectsOf(action),
      action.id,
      healer,
      friend,
      context,
    );
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "hands", amount: 3 },
    ]);
    expect(payloads(events, "healed")).toEqual([
      { actor: "friend", amount: 3, max },
    ]);
    const stats = deriveStats(healer, run);
    expect(canAfford(action, healer, stats)).toBe(true);
    const spent = { ...healer, resourcesSpent: { hands: 10 } };
    expect(canAfford(action, spent, stats)).toBe(false);
  });

  it("rolls a pool's dice up to its most at once, as Healing Light, with a Temporary Hit Point each with `temp`", async () => {
    const run = await healingRun();
    const healer = hero(["light"]);
    const friend = { ...hero([], { id: "friend" }), hp: 1 };
    const context = contextOf(run, [healer, friend], scripted([4, 5]).dice);
    const action = findAction(healer, "feature:test:feature/light:0", context);
    const events = leafEvents(
      effectsOf(action),
      action.id,
      healer,
      friend,
      context,
    );
    expect(payloads(events, "resourceSpent")).toEqual([
      { actor: PLAYER_ACTOR, resource: "light", amount: 2 },
    ]);
    expect(payloads(events, "healed")[0]).toMatchObject({ amount: 9 });
    // With `temp`, a Temporary Hit Point for each die, as Balm of the Summer Court.
    expect(payloads(events, "tempHpGained")).toEqual([
      { actor: "friend", amount: 2 },
    ]);
  });

  it("shares divided healing out to the most hurt first, never past half the maximum with `half`", async () => {
    const run = await healingRun();
    const max = deriveStats(hero([]), run).maxHp;
    const a = { ...hero([], { id: "a" }), hp: 0 };
    const b = { ...hero([], { id: "b" }), hp: 2 };
    const c = { ...hero([], { id: "c" }), hp: max };
    const context = contextOf(run, [a, b, c], scripted([]).dice);
    const half = Math.floor(max / 2);
    const total = half + 1;
    const shared = sharedHealing(
      [
        {
          kind: "heal",
          amount: { bonus: { base: total, add: [] } },
          divided: true,
          half: true,
        },
      ],
      [a, b, c],
      a,
      context,
    );
    const healed = (target: Actor) =>
      payloads(leafEvents(shared(target), "x", a, target, context), "healed")[0]
        ?.amount;
    // The one at 0 fills to half its maximum, the next gets what's left, and the unhurt one no heal at all.
    expect(healed(a)).toBe(half);
    expect(healed(b)).toBe(1);
    expect(healed(c)).toBeUndefined();
  });

  it("rolls healing dice at their highest for a creature at 0 Hit Points, as Circle of Mortality", async () => {
    const run = await healingRun();
    const healer = hero(["mercy"]);
    const action = findAction(
      healer,
      "feature:test:feature/mercy:0",
      contextOf(run, [healer], scripted([]).dice),
    );
    const heal = (hp: number) => {
      const friend = { ...hero([], { id: "friend" }), hp };
      const context = contextOf(run, [healer, friend], scripted([1, 1]).dice);
      return payloads(
        leafEvents(effectsOf(action), action.id, healer, friend, context),
        "healed",
      )[0]?.amount;
    };
    expect(heal(0)).toBe(8);
    expect(heal(1)).toBe(2);
  });

  it("raises the dead between fights for gold, within its time, with an ordeal that eases each Long Rest", async () => {
    const run = await healingRun();
    const priest = hero(["raise"]);
    const friend = dead(hero([], { id: "friend" }));
    const id = `cast:${PLAYER_ACTOR}:feature:test:feature/raise:0`;
    const offered = (state: DndState) =>
      sceneCastActions(state, run)
        .map((action) => action.id)
        .filter((item) => item.includes("raise"));
    // Not without the gold, and not once it's been dead too long.
    expect(offered(between([priest, friend], 10))).toEqual([]);
    expect(
      offered(between([priest, { ...friend, deadHours: 9 }], 100)),
    ).toEqual([]);
    expect(offered(between([priest, friend], 100))).toEqual([id]);
    // Nor in a fight, where the turn's options leave it out too.
    const fight = contextOf(run, [priest, friend], scripted([]).dice);
    expect(sceneCastActions(fight.state, run)).toEqual([]);
    const turn = nextDndDecision(fight.state, run);
    expect(turn?.options.some((option) => option.id.includes("raise"))).toBe(
      false,
    );

    let state = between([priest, friend], 100);
    const cast = run.system.storyEffects[`${NS}:castBetween`];
    const result = cast?.apply(
      { caster: PLAYER_ACTOR, action: "feature:test:feature/raise:0" },
      { state, dice: scripted([]).dice, ...run },
    );
    for (const event of result?.events ?? []) {
      state = applyDndEvent(state, event);
    }
    const raised = state.actors.friend;
    expect(state.gold).toBe(50);
    expect(raised?.hp).toBe(1);
    expect(raised?.ordeal).toBe(4);
    const stats = (actor: Actor) => deriveStats(actor, run);
    if (!raised) throw new Error("no friend");
    expect(saveBonus(stats(raised), "str")).toBe(
      saveBonus(stats(hero([], { id: "friend" })), "str") - 4,
    );
    state = applyDndEvent(
      state,
      dndEvent(`${NS}:rested`, {
        actor: "friend",
        rest: "long",
        maxHp: stats(raised).maxHp,
        resourcesSpent: {},
      }),
    );
    expect(state.actors.friend?.ordeal).toBe(3);
  });

  it("asks whom a single-target heal between fights goes to", async () => {
    const run = await healingRun();
    const max = deriveStats(hero([]), run).maxHp;
    const healer = { ...hero(["hands"]), hp: max };
    const a = { ...hero([], { id: "a" }), hp: 1 };
    const b = { ...hero([], { id: "b" }), hp: 2 };
    const state = between([healer, a, b]);
    const dice = scripted([]).dice;
    const started = run.system.storyEffects[`${NS}:castBetween`]?.apply(
      { caster: PLAYER_ACTOR, action: "feature:test:feature/hands:0" },
      { state, dice, ...run },
    );
    const { state: after, decisions } = settle(
      run,
      state,
      started?.frames ?? [],
      dice,
      () => "b",
    );
    expect(decisions[0]?.options.map((option) => option.id)).toEqual([
      "a",
      "b",
      "never-mind",
    ]);
    expect(after.actors.b?.hp).toBe(max);
    expect(after.actors.a?.hp).toBe(1);
    expect(after.actors[PLAYER_ACTOR]?.resourcesSpent.hands).toBe(max - 2);
  });

  it("leaves potions to their own row, and gives a Short Rest's benefits once a Long Rest, as Prayer of Healing", async () => {
    const run = await healingRun();
    const max = deriveStats(hero([]), run).maxHp;
    const drinker = {
      ...hero([]),
      hp: 1,
      inventory: ["srd52:item/longsword", "srd52:item/potion-of-healing"],
    };
    const ids = sceneCastActions(between([drinker]), run).map(({ id }) => id);
    expect(ids.some((id) => id.includes("potion"))).toBe(false);
    const prayer = { ...hero([], { id: "friend" }), hp: 1 };
    const context = {
      ...contextOf(run, [prayer], scripted([]).dice),
      state: between([prayer]),
    };
    const given = leafEvents(
      [{ kind: "shortRest" }],
      "x",
      prayer,
      prayer,
      context,
    );
    expect(payloads(given, "resourceSpent")).toContainEqual({
      actor: "friend",
      resource: "shortRest:given",
    });
    const after = given.reduce(applyDndEvent, between([prayer]));
    const again = after.actors.friend;
    if (!again) throw new Error("no friend");
    expect(
      leafEvents([{ kind: "shortRest" }], "x", again, again, {
        ...context,
        state: after,
      }),
    ).toEqual([]);
    expect(again.hp).toBeGreaterThan(1);
    expect(again.hp).toBeLessThanOrEqual(max);
  });

  it("counts the hours the party's dead lie dead by the rests passed, unless reposed", () => {
    const friend = dead(hero([], { id: "friend" }));
    const rest = (state: DndState, kind: "short" | "long") =>
      applyDndEvent(state, dndEvent(`${NS}:restFinished`, { rest: kind }));
    const once = rest(rest(between([hero([]), friend]), "short"), "long");
    expect(once.actors.friend?.deadHours).toBe(9);
    expect(once.actors[PLAYER_ACTOR]?.deadHours).toBeUndefined();
    const reposed = applyDndEvent(
      between([friend]),
      dndEvent(`${NS}:reposed`, { actor: "friend" }),
    );
    expect(rest(reposed, "long").actors.friend?.deadHours).toBeUndefined();
    // Raised, the count is gone.
    const raised = applyDndEvent(
      once,
      dndEvent(`${NS}:healed`, { actor: "friend", amount: 1, max: 10 }),
    );
    expect(raised.actors.friend?.deadHours).toBeUndefined();
  });

  it("pays a costly component from the party's gold", async () => {
    const run = await healingRun();
    const priest = hero(["raise"]);
    const context = contextOf(run, [priest], scripted([]).dice);
    const action = findAction(priest, "feature:test:feature/raise:0", context);
    expect(goldFor(action)).toBe(50);
    expect(payloads(payCosts(action, priest, context), "goldSpent")).toEqual([
      { gold: 50 },
    ]);
  });

  it("ends one listed condition at the end of the bearer's turn, as Self-Restoration", async () => {
    const run = await healingRun();
    const poisoned = {
      ...hero(["restore"]),
      activeEffects: [
        {
          sourceId: "x",
          casterId: "foe",
          modifier: {
            kind: "condition" as const,
            condition: "poisoned" as const,
          },
          ends: "spellDuration" as const,
        },
      ],
    };
    const foe = { ...hero([], { id: "foe" }), side: "enemy" as const };
    const context = contextOf(run, [poisoned, foe], scripted([]).dice);
    const result = run.system.frames[`${NS}:finishTurn`]?.run({}, context);
    expect(payloads(result?.events ?? [], "conditionRemoved")).toEqual([
      { actor: PLAYER_ACTOR, condition: "poisoned" },
    ]);
  });

  it("adds necrotic damage to a hit on a creature missing Hit Points, as Pull of Death", async () => {
    const run = await healingRun();
    const attacker = { ...hero(["pull"]), position: { x: 0, y: 0 } };
    const hit = (hp: number) => {
      const foe = {
        ...hero([], { id: "foe" }),
        side: "enemy" as const,
        hp,
        position: { x: 1, y: 0 },
      };
      const result = run.system.frames[`${NS}:applyHit`]?.run(
        {
          attacker: PLAYER_ACTOR,
          actionId: "weapon:srd52:item/longsword",
          target: "foe",
          critical: false,
          hadAdvantage: false,
          total: 20,
          natural: 15,
        },
        contextOf(run, [attacker, foe], scripted([]).dice),
      );
      return payloads(result?.events ?? [], "damaged").map((item) => item.type);
    };
    const max = deriveStats(hero([]), run).maxHp;
    expect(hit(max - 1)).toContain("necrotic");
    expect(hit(max)).not.toContain("necrotic");
  });

  it("ends curses with all their action gave, and lifts Exhaustion when there's no condition to cure", async () => {
    const run = await healingRun();
    const effect = (sourceId: string, modifier: object) => ({
      sourceId,
      casterId: "hag",
      modifier,
      ends: "spellDuration",
    });
    const cursed = {
      ...hero([], { id: "friend" }),
      exhaustion: 2,
      activeEffects: [
        effect("curse", { kind: "mark", curse: true }),
        effect("curse", { kind: "condition", condition: "charmed" }),
        effect("hold", { kind: "mark" }),
      ],
    } as Actor;
    const context = contextOf(run, [cursed], scripted([]).dice);
    expect(
      payloads(
        leafEvents([{ kind: "uncurse" }], "x", cursed, cursed, context),
        "effectEnded",
      ),
    ).toEqual([{ actor: "friend", sourceId: "curse", casterId: "hag" }]);
    const cure = {
      kind: "cure" as const,
      conditions: ["petrified" as const],
      exhaustion: true as const,
    };
    expect(
      payloads(
        leafEvents([cure], "x", cursed, cursed, context),
        "exhaustionChanged",
      ),
    ).toEqual([{ actor: "friend", levels: -1 }]);
  });

  it("reads the SRD's raising and healing spells as their time limits, gold and sharing say", async () => {
    const run = await healingRun();
    const spell = (id: string) => lookup(run, SpellSchema, `srd52:spell/${id}`);
    const targeting = (id: string) => spell(id).activation?.targeting;
    expect(targeting("revivify")).toMatchObject({ dead: true, diedWithin: 0 });
    expect(targeting("raise-dead")).toMatchObject({ diedWithin: 240 });
    expect(spell("raise-dead").activation?.outOfCombat).toBe(true);
    expect(spell("resurrection").activation?.cost).toContainEqual({
      gold: 1000,
    });
    expect(spell("mass-heal").activation?.resolution).toMatchObject({
      effects: [{ kind: "heal", divided: true }, {}, {}, {}],
    });
    const preserve = lookup(run, FeatureSchema, "srd52:feature/preserve-life");
    expect(preserve.activations[0]?.targeting).toMatchObject({
      bloodied: true,
    });
  });
});
