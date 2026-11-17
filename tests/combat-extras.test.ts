import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import {
  keepsActing,
  tacticOptions,
} from "../plugins/systems/dnd5.5e/core/actions.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { encodeOption } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import {
  canAfford,
  findAction,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  initiativeMoveFrames,
  initiativeSwapFrames,
} from "../plugins/systems/dnd5.5e/core/combat/reactions.ts";
import { castRiders } from "../plugins/systems/dnd5.5e/core/combat/school.ts";
import { STRIKE, TRADE } from "../plugins/systems/dnd5.5e/core/combat/trade.ts";
import {
  type Actor,
  CAST_ACTION,
  type DndState,
  NS,
  SURGED,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, hero, scripted, testRun, trait } from "./feat-fixtures.ts";

// Made-up features for extra actions, Bonus Actions and movement (#171): ids and mechanics only.
const self = { self: true };
const auto = (effects: readonly object[]) => ({ kind: "automatic", effects });
const FIXTURES = [
  trait("wind", [], {
    activations: [
      {
        cost: ["bonusAction"],
        targeting: self,
        resolution: auto([{ kind: "heal", amount: { bonus: { base: 1 } } }]),
      },
    ],
  }),
  trait("shift", [
    {
      kind: "activationRider",
      feature: "test:feature/wind",
      effects: [{ kind: "dash", half: true, safe: true }],
    },
  ]),
  trait("aim", [], {
    activations: [
      {
        cost: ["bonusAction"],
        unmoved: true,
        targeting: self,
        resolution: auto([
          {
            kind: "modifier",
            modifier: { kind: "advantage", on: "attacks", once: true },
            duration: { until: "turnEnd" },
          },
        ]),
      },
    ],
  }),
  trait("battle-magic", [], {
    activations: [
      {
        cost: ["bonusAction"],
        afterCast: true,
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: auto([{ kind: "weaponAttack" }]),
      },
    ],
  }),
  trait("rage", [], {
    activations: [
      {
        cost: ["bonusAction"],
        targeting: self,
        resolution: auto([
          {
            kind: "modifier",
            modifier: { kind: "resistance", damage: "slashing" },
            duration: { minutes: 10 },
          },
        ]),
      },
    ],
  }),
  trait("tree", [], {
    activations: [
      {
        cost: ["bonusAction"],
        while: ["test:feature/rage"],
        targeting: self,
        resolution: auto([{ kind: "teleport", feet: 60 }]),
      },
    ],
  }),
  trait("fleet", [], {
    activations: [
      {
        cost: [],
        afterBonusAction: true,
        targeting: self,
        resolution: auto([{ kind: "dash" }]),
      },
    ],
  }),
  trait("surge", [], {
    resources: [{ id: "surge", max: { base: 2 }, recharge: [] }],
    activations: [
      {
        cost: [{ resource: "surge" }],
        targeting: self,
        resolution: auto([{ kind: "extraAction" }]),
      },
    ],
  }),
  trait(
    "valor",
    [
      { kind: "multiattack", attacks: 2 },
      { kind: "attackReplacement", cantrips: true },
    ],
    {
      spells: { "1": ["srd52:spell/fire-bolt"] },
    },
  ),
  trait(
    "bewitching",
    [
      {
        kind: "castRider",
        school: ["enchantment"],
        effects: [{ kind: "teleport", feet: 30 }],
      },
    ],
    { spells: { "1": ["srd52:spell/charm-person", "srd52:spell/fire-bolt"] } },
  ),
  trait("hands", [{ kind: "fastHands" }]),
  trait("unpredictable", [], {
    activations: [
      {
        cost: [],
        trigger: { initiative: true },
        targeting: self,
        resolution: auto([{ kind: "teleport", feet: 15, movement: 15 }]),
      },
    ],
  }),
  trait("implosion", [], {
    activations: [
      {
        cost: ["action"],
        targeting: self,
        resolution: auto([
          {
            kind: "teleport",
            feet: 120,
            around: {
              origin: true,
              within: 30,
              save: { ability: "str", dc: { base: 30 } },
              damage: [{ amount: { dice: "3d10" }, type: "force" }],
              duration: "instantaneous",
            },
          },
        ]),
      },
    ],
  }),
  {
    id: "test:item/flask",
    name: "Flask",
    type: "gear",
    costCp: 100,
    activation: {
      cost: ["action"],
      targeting: { creatures: 1, range: 20, side: "enemy" },
      resolution: {
        kind: "automatic",
        damage: [{ amount: { dice: "1d4" }, type: "fire" }],
        effects: [],
      },
    },
  },
];

async function extrasRun() {
  const run = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id: string) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}
type Run = Awaited<ReturnType<typeof extrasRun>>;

const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );

const tactics = (events: readonly SystemEvent[]) =>
  payloads(events, "effectAdded").map(
    ({ effect }) => (effect as { modifier: Record<string, unknown> }).modifier,
  );

const at = (actor: Actor, extra: Partial<Actor> = {}): Actor => ({
  ...actor,
  position: { x: 0, y: 0 },
  ...extra,
});

const foe = (): Actor => ({
  ...hero([], { id: "foe" }),
  side: "enemy",
  hp: 30,
  position: { x: 1, y: 0 },
});

const affords = (run: Run, actor: Actor, id: string): boolean => {
  const context = contextOf(run, [actor], scripted([]).dice);
  return canAfford(
    findAction(actor, id, context),
    actor,
    deriveStats(actor, run),
  );
};

// One step of the turn: the events it makes, applied to the state.
function take(run: Run, state: DndState, answer: string) {
  const result = run.system.frames[`${NS}:takeAction`]?.run(
    { actor: PLAYER_ACTOR, answer },
    {
      state,
      dice: scripted([]).dice,
      content: run.content,
      contentIds: run.contentIds,
    },
  );
  const events = result?.events ?? [];
  return {
    events,
    frames: result?.frames ?? [],
    state: events.reduce(applyDndEvent, state),
  };
}

describe("extra actions, Bonus Actions and movement (#171)", () => {
  it("rides a move of half the Speed that provokes nothing on another feature's activation", async () => {
    const run = await extrasRun();
    const actor = hero(["wind", "shift"]);
    const context = contextOf(run, [actor], scripted([]).dice);
    const action = findAction(actor, "feature:test:feature/wind:0", context);
    const { resolution } = action.activation;
    const effects = resolution.kind === "automatic" ? resolution.effects : [];
    expect(effects.map(({ kind }) => kind)).toEqual(["heal", "dash"]);
    expect(
      tactics(leafEvents(effects.slice(1), action.id, actor, actor, context)),
    ).toEqual([
      { kind: "tactic", tactic: "dash", value: 15 },
      { kind: "tactic", tactic: "disengage" },
    ]);
    // Without the rider, Second Wind's like is only its own healing.
    const plain = findAction(hero(["wind"]), action.id, context);
    expect(plain.activation.resolution).toMatchObject({
      effects: [{ kind: "heal" }],
    });
  });

  it("takes the Dodge action as part of another, and trades places with an ally", async () => {
    const run = await extrasRun();
    const actor = at(hero([]));
    const ally = at(hero([], { id: "ally" }), { position: { x: 1, y: 0 } });
    const context = contextOf(run, [actor, ally], scripted([]).dice);
    expect(
      tactics(leafEvents([{ kind: "dodge" }], "x", actor, actor, context)),
    ).toEqual([{ kind: "tactic", tactic: "dodge" }]);
    expect(
      payloads(
        leafEvents([{ kind: "swapPlaces" }], "x", actor, ally, context),
        "moved",
      ),
    ).toEqual([
      { actor: PLAYER_ACTOR, to: { x: 1, y: 0 }, feet: 0 },
      { actor: "ally", to: { x: 0, y: 0 }, feet: 0 },
    ]);
  });

  it("gates activations on standing still, a cast, a Bonus Action spent and a Rage", async () => {
    const run = await extrasRun();
    const aim = "feature:test:feature/aim:0";
    expect(affords(run, hero(["aim"]), aim)).toBe(true);
    expect(affords(run, { ...hero(["aim"]), moved: 5 }, aim)).toBe(false);

    const magic = "feature:test:feature/battle-magic:0";
    expect(affords(run, hero(["battle-magic"]), magic)).toBe(false);
    expect(
      affords(
        run,
        { ...hero(["battle-magic"]), usedThisTurn: [CAST_ACTION] },
        magic,
      ),
    ).toBe(true);

    const fleet = "feature:test:feature/fleet:0";
    const spent = (actor: Actor): Actor => ({
      ...actor,
      budget: { ...actor.budget, bonusAction: false },
    });
    expect(affords(run, hero(["fleet"]), fleet)).toBe(false);
    expect(affords(run, spent(hero(["fleet"])), fleet)).toBe(true);

    const tree = "feature:test:feature/tree:0";
    const raging = hero(["rage", "tree"]);
    expect(affords(run, raging, tree)).toBe(false);
    expect(
      affords(
        run,
        {
          ...raging,
          activeEffects: [
            {
              sourceId: "feature:test:feature/rage:0",
              casterId: PLAYER_ACTOR,
              modifier: { kind: "resistance", damage: "slashing" },
              ends: "spellDuration",
            },
          ],
        },
        tree,
      ),
    ).toBe(true);
  });

  it("marks a spell cast with an action, for Battle Magic's attack after it", async () => {
    const run = await extrasRun();
    const state = contextOf(
      run,
      [at(hero(["valor"])), foe()],
      scripted([]).dice,
    ).state;
    const cast = take(
      run,
      state,
      encodeOption("spell:srd52:spell/fire-bolt", "foe"),
    );
    expect(payloads(cast.events, "oncePerTurnUsed")).toContainEqual({
      actor: PLAYER_ACTOR,
      key: CAST_ACTION,
    });
  });

  it("surges only once the action is spent, once a turn, and never for a spell's Magic action", async () => {
    const run = await extrasRun();
    const surge = "feature:test:feature/surge:0";
    const acting = hero(["surge", "valor"]);
    const done = { ...acting, budget: { ...acting.budget, action: false } };
    expect(affords(run, acting, surge)).toBe(false);
    expect(affords(run, done, surge)).toBe(true);
    const context = contextOf(run, [done], scripted([]).dice);
    const events = leafEvents(
      [{ kind: "extraAction" }],
      surge,
      done,
      done,
      context,
    );
    expect(payloads(events, "oncePerTurnUsed")).toEqual([
      { actor: PLAYER_ACTOR, key: SURGED },
    ]);
    const surged = events.reduce(applyDndEvent, context.state).actors[
      PLAYER_ACTOR
    ];
    if (!surged) throw new Error("no actor");
    expect(surged.budget.action).toBe(true);
    expect(
      affords(
        run,
        { ...surged, budget: { ...surged.budget, action: false } },
        surge,
      ),
    ).toBe(false);
    expect(affords(run, surged, "spell:srd52:spell/fire-bolt")).toBe(false);
    expect(affords(run, surged, "weapon:srd52:item/longsword")).toBe(true);
  });

  it("trades an attack of the Attack action for a cantrip, then makes the attack it leaves", async () => {
    const run = await extrasRun();
    let { state } = contextOf(
      run,
      [at(hero(["valor"])), foe()],
      scripted([]).dice,
    );
    const player = (): Actor => {
      const actor = state.actors[PLAYER_ACTOR];
      if (!actor) throw new Error("no player");
      return actor;
    };
    const ids = () => tacticOptions(player(), state, run).map(({ id }) => id);
    const trade = encodeOption(TRADE, PLAYER_ACTOR, "0");
    expect(ids()).toContain(trade);
    ({ state } = take(run, state, trade));
    expect(ids()).not.toContain(trade);

    const cast = take(
      run,
      state,
      encodeOption("spell:srd52:spell/fire-bolt", "foe"),
    );
    ({ state } = cast);
    expect(tactics(cast.events)).toContainEqual({
      kind: "tactic",
      tactic: "attacksLeft",
      value: 1,
    });
    const strike = encodeOption(STRIKE, "foe", "weapon:srd52:item/longsword");
    expect(ids()).toContain(strike);
    const context = { ...contextOf(run, [], scripted([]).dice), state };
    expect(keepsActing(PLAYER_ACTOR, context)).toBe(true);

    const struck = take(run, state, strike);
    expect(struck.frames.map(({ kind }) => kind)).toContain(`${NS}:attackRoll`);
    ({ state } = struck);
    expect(ids()).not.toContain(strike);
    expect(keepsActing(PLAYER_ACTOR, { ...context, state })).toBe(false);
  });

  it("casts a cantrip without a trade as it always did", async () => {
    const run = await extrasRun();
    const { state } = contextOf(
      run,
      [at(hero(["valor"])), foe()],
      scripted([]).dice,
    );
    const cast = take(
      run,
      state,
      encodeOption("spell:srd52:spell/fire-bolt", "foe"),
    );
    expect(tactics(cast.events)).not.toContainEqual(
      expect.objectContaining({ tactic: "attacksLeft" }),
    );
  });

  it("teleports after an Enchantment spell cast with a slot, as Bewitching Magic", async () => {
    const run = await extrasRun();
    const actor = at(hero(["bewitching"]));
    const context = contextOf(run, [actor, foe()], scripted([]).dice);
    const charm = findAction(actor, "spell:srd52:spell/charm-person", context);
    const kinds = (slot: number | undefined, id = charm.id) =>
      castRiders(
        actor,
        findAction(actor, id, context),
        slot,
        context,
      ).frames.map(
        ({ payload }) =>
          (payload as { decision?: { id: string } }).decision?.id ?? "",
      );
    expect(kinds(1)[0]).toMatch(/teleportTo/);
    expect(kinds(undefined)).toEqual([]);
    expect(kinds(1, "spell:srd52:spell/fire-bolt")).toEqual([]);
  });

  it("hurts those near the square it leaves, half on a save, as Warping Implosion", async () => {
    const run = await extrasRun();
    const actor = at(hero(["implosion"]));
    const near = { ...foe(), id: "near", position: { x: 2, y: 0 } };
    const far = { ...foe(), id: "far", position: { x: 15, y: 0 } };
    const state: DndState = {
      ...contextOf(run, [actor, near, far], scripted([]).dice).state,
      combat: {
        encounter: "arena",
        order: [PLAYER_ACTOR, "near", "far"],
        index: 0,
        round: 1,
        grid: { width: 20, height: 20 },
      },
    };
    // A save of 1 fails a DC of 30; then 4 on each d10.
    const result = run.system.frames[`${NS}:teleport`]?.run(
      {
        actor: PLAYER_ACTOR,
        feet: 120,
        movement: 0,
        actionId: "feature:test:feature/implosion:0",
        answer: "0,10",
      },
      {
        state,
        dice: scripted([1, 4, 4, 4]).dice,
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    const hurt = payloads(result?.events ?? [], "damaged");
    expect(hurt).toContainEqual(
      expect.objectContaining({ actor: "near", amount: 12 }),
    );
    expect(hurt.map(({ actor: id }) => id)).not.toContain("far");
  });

  it("uses gear with a Bonus Action with Fast Hands", async () => {
    const run = await extrasRun();
    const cost = (traits: readonly string[]) =>
      deriveStats(
        { ...hero(traits), inventory: ["test:item/flask"] },
        run,
      ).actions.find(({ id }) => id === "item:test:item/flask")?.activation
        .cost;
    expect(cost(["hands"])).toEqual(["bonusAction"]);
    expect(cost([])).toEqual(["action"]);
  });

  it("moves right after Initiative, as Unpredictable Movement, without offering an Initiative swap", async () => {
    const run = await extrasRun();
    const actor = at(hero(["unpredictable"]));
    const ally = at(hero([], { id: "ally" }), { position: { x: 2, y: 0 } });
    const context = contextOf(run, [actor, ally, foe()], scripted([]).dice);
    expect(initiativeSwapFrames([actor, ally], context)).toEqual([]);
    const [move] = initiativeMoveFrames([actor, ally], context);
    expect(move?.kind).toBe(`${NS}:initiativeMove`);
    const asked = run.system.frames[`${NS}:initiativeMove`]?.run(
      move?.payload ?? {},
      context,
    );
    const [decision] = asked?.frames ?? [];
    expect(
      (decision?.payload as { decision: { id: string } }).decision.id,
    ).toMatch(/teleportTo/);
    expect(initiativeMoveFrames([hero([])], context)).toEqual([]);
  });
});
