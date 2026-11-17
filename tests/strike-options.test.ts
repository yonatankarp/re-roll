import { type Frame, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  extraFits,
  isMelee,
  meleeReach,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { type Actor, NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  rollAmount,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { traitAttackAdvantage } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import {
  contextOf,
  hero,
  scripted,
  settle,
  testRun,
  trait,
} from "./feat-fixtures.ts";

// Strike options that spend a resource (issue #157) and always-on attack riders (issue #158), on made-up traits:
// ids and mechanics only.

const FOE = { creatures: 1, range: 120, side: "enemy" };
const DC = { base: 8, add: [{ kind: "proficiency" }] };
const prone = {
  kind: "applyCondition",
  condition: "prone",
  duration: { minutes: 1 },
};
const RECKLESS = "test:feature/reckless";

const FIXTURES = [
  trait("sneak", [
    {
      kind: "extraDamage",
      dice: "3d6",
      diceCount: "sneakAttackD6",
      when: "advantage",
    },
  ]),
  trait("death-strike", [
    { kind: "deathStrike", ability: "con", dc: { base: 30 } },
  ]),
  trait("cunning", [], {
    activations: [
      {
        label: "Trip",
        cost: [],
        trigger: { afterHit: "weapon", forgo: 1 },
        targeting: FOE,
        resolution: { kind: "save", ability: "dex", dc: DC, onFail: [prone] },
      },
      {
        label: "Knock Out",
        cost: [],
        trigger: { afterHit: "weapon", forgo: 6 },
        targeting: FOE,
        resolution: { kind: "save", ability: "con", dc: DC, onFail: [prone] },
      },
    ],
  }),
  trait("reckless", [], {
    activations: [
      {
        cost: [],
        oncePerTurn: true,
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              modifier: { kind: "advantage", on: "attacks", ability: "str" },
              duration: { until: "yourNextTurnStart" },
            },
          ],
        },
      },
    ],
  }),
  trait("brutal", [], {
    hitType: true,
    activations: [
      {
        label: "Forceful Blow",
        cost: [],
        oncePerTurn: "brutal",
        while: [RECKLESS],
        trigger: { afterHit: "strength", forgoAdvantage: true },
        targeting: FOE,
        resolution: {
          kind: "automatic",
          damage: [{ amount: { dice: "1d10" }, type: "bludgeoning" }],
          effects: [{ kind: "forcedMove", feet: 15, direction: "away" }],
        },
        selfEffects: [{ kind: "dash", half: true, safe: true }],
      },
    ],
  }),
  trait("stunning", [], {
    resources: [{ id: "focus", max: { base: 3 }, recharge: [] }],
    activations: [
      {
        cost: [{ resource: "focus" }],
        oncePerTurn: true,
        trigger: { afterHit: "meleeWeapon" },
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: { kind: "automatic", effects: [prone] },
      },
    ],
  }),
  trait("sweeping", [], {
    activations: [
      {
        cost: [],
        trigger: { afterHit: "meleeWeapon", near: 5, sameRoll: true },
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "automatic",
          damage: [{ amount: { dice: "1d8" }, type: "slashing" }],
          effects: [],
        },
      },
    ],
  }),
  trait("fury", [
    {
      kind: "extraDamage",
      dice: "1d6",
      bonus: { base: 2 },
      types: ["necrotic", "radiant"],
      when: "always",
      with: "weapon",
      oncePerTurn: true,
      ownTurn: true,
      while: [RECKLESS],
    },
  ]),
  trait("riders", [
    { kind: "weaponRider", with: "rangedWeapon", attack: 2 },
    { kind: "weaponRider", with: "heavy", reach: 10 },
    { kind: "weaponRider", with: "meleeWeapon", types: ["radiant"] },
  ]),
  trait("studied", [
    {
      kind: "missRider",
      effects: [
        {
          kind: "modifier",
          modifier: {
            kind: "advantage",
            on: "attacksAgainst",
            once: true,
            casterOnly: true,
          },
          duration: { until: "yourNextTurnEnd" },
        },
      ],
    },
  ]),
  trait("avenger", [
    {
      kind: "damageRider",
      opportunity: true,
      effects: [
        {
          kind: "modifier",
          modifier: { kind: "actionLimit", speed: "none" },
          duration: { until: "turnEnd" },
        },
      ],
    },
  ]),
  trait("ambusher", [
    { kind: "attackAdvantage", when: "unacted" },
    { kind: "attackAdvantage", when: "marked", against: ["test:feature/mark"] },
  ]),
  {
    id: "test:item/glaive",
    name: "Glaive",
    type: "weapon",
    category: "martial",
    damage: { dice: "1d10", type: "slashing" },
    properties: ["heavy", "reach", "twoHanded"],
    mastery: "graze",
  },
];

let run: RunContext;

beforeAll(async () => {
  const base = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  run = {
    ...base,
    content: (id) => byId.get(id) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
});

const foe = (id = "foe", x = 1): Actor => ({
  ...hero([], { id }),
  side: "enemy",
  hp: 100,
  position: { x, y: 0 },
});
const placed = (actor: Actor, x = 0): Actor => ({
  ...actor,
  position: { x, y: 0 },
});
const payloads = (events: readonly SystemEvent[], kind: string) =>
  events.flatMap((event) =>
    event.kind === `${NS}:${kind}` && "payload" in event
      ? [event.payload as Record<string, unknown>]
      : [],
  );
const hit = (actionId: string, extra = {}): Frame => ({
  kind: `${NS}:applyHit`,
  payload: {
    attacker: PLAYER_ACTOR,
    actionId,
    target: "foe",
    critical: false,
    hadAdvantage: true,
    total: 30,
    natural: 15,
    ...extra,
  },
});
const reckless = (actor: Actor): Actor => ({
  ...actor,
  activeEffects: [
    {
      sourceId: `feature:${RECKLESS}:0`,
      casterId: actor.id,
      ends: "casterNextTurn",
      modifier: { kind: "advantage", on: "attacks", ability: "str" },
    },
  ],
});

describe("strike options", () => {
  it("gives up Sneak Attack dice before they're rolled, then lands the strike after the damage", () => {
    const rogue = {
      ...placed(hero(["sneak", "cunning"])),
      inventory: ["srd52:item/shortsword"],
    };
    const { dice, counts } = scripted([4, 1, 1, 1, 1]);
    const done = settle(
      run,
      [rogue, foe()],
      [hit("weapon:srd52:item/shortsword")],
      dice,
      (decision) =>
        decision.options.find((item) => item.label.startsWith("cunning (Trip)"))
          ?.id ?? "decline",
    );
    const [asked] = done.decisions;
    expect(asked?.id).toBe(`${NS}:strike:${PLAYER_ACTOR}`);
    // Knock Out costs 6 dice, more than the 3 the hit carries.
    expect(asked?.options.map((item) => item.label)).toEqual([
      "cunning (Trip) (1 die)",
      "None",
    ]);
    // The shortsword's d6 and two Sneak Attack dice, then nothing else.
    expect(counts[6]).toBe(3);
    expect(
      done.state.actors.foe?.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "condition" && modifier.condition === "prone",
      ),
    ).toBe(true);
  });

  it("doubles a first-round Sneak Attack hit when the target fails its save, as Death Strike", () => {
    const rogue = {
      ...placed(hero(["sneak", "death-strike"])),
      inventory: ["srd52:item/shortsword"],
    };
    const damage = (round: number) => {
      const { state } = contextOf(run, [rogue, foe()], scripted([]).dice);
      const done = settle(
        run,
        { ...state, combat: state.combat && { ...state.combat, round } },
        [hit("weapon:srd52:item/shortsword")],
        scripted([3, 1, 1, 1, 1]).dice,
      );
      return payloads(done.events, "damaged").reduce(
        (sum, item) => sum + Number(item.amount),
        0,
      );
    };
    expect(damage(1)).toBe(2 * damage(2));
  });

  it("asks nothing when the hit carries no Sneak Attack", () => {
    const rogue = {
      ...placed(hero(["sneak", "cunning"])),
      inventory: ["srd52:item/shortsword"],
    };
    const done = settle(
      run,
      [rogue, foe()],
      [hit("weapon:srd52:item/shortsword", { hadAdvantage: false })],
      scripted([]).dice,
    );
    expect(done.decisions).toHaveLength(0);
  });

  it("gives up Advantage before the roll for Brutal Strike's die and move", () => {
    const barbarian = reckless(placed(hero(["reckless", "brutal"])));
    const { dice, counts } = scripted([18, 5, 7]);
    const done = settle(
      run,
      [barbarian, foe()],
      [
        {
          kind: `${NS}:attackRoll`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: "weapon:srd52:item/longsword",
            target: "foe",
          },
        },
      ],
      dice,
    );
    expect(done.decisions[0]?.id).toBe(`${NS}:strike:${PLAYER_ACTOR}`);
    // One d20, as the roll went without its Advantage, and Brutal Strike's d10.
    expect(counts[20]).toBe(1);
    expect(counts[10]).toBe(1);
    // The bearer's own move after the blow.
    expect(
      done.state.actors[PLAYER_ACTOR]?.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "tactic" && modifier.tactic === "dash",
      ),
    ).toBe(true);
    expect(
      done.state.actors[PLAYER_ACTOR]?.usedThisTurn.includes("once:brutal"),
    ).toBe(true);
  });

  it("limits an after-hit option to once a turn", () => {
    const monk = placed(hero(["stunning"]));
    const after = {
      kind: `${NS}:afterHit`,
      payload: {
        attacker: PLAYER_ACTOR,
        actionId: "weapon:srd52:item/longsword",
        target: "foe",
        critical: false,
      },
    };
    const first = settle(run, [monk, foe()], [after], scripted([]).dice);
    expect(first.decisions).toHaveLength(1);
    const second = settle(run, first.state, [after], scripted([]).dice);
    expect(second.decisions).toHaveLength(0);
  });

  it("offers a second creature beside the one hit that the same roll hits", () => {
    const fighter = placed(hero(["sweeping"]));
    const done = settle(
      run,
      [fighter, foe("foe", 1), foe("near", 1), foe("far", 4)],
      [
        {
          kind: `${NS}:afterHit`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: "weapon:srd52:item/longsword",
            target: "foe",
            critical: false,
            total: 12,
          },
        },
      ],
      scripted([3]).dice,
    );
    expect(done.decisions[0]?.options.map((item) => item.id)).toEqual([
      `feature:test:feature/sweeping:0|near`,
      "decline",
    ]);
    expect(payloads(done.events, "damaged")[0]?.actor).toBe("near");
  });
});

describe("attack riders", () => {
  it("adds extra damage of the type the target resists least, only while its effect lasts and once a turn", () => {
    const resistant: Actor = {
      ...foe(),
      activeEffects: [
        {
          sourceId: "ward",
          casterId: "foe",
          ends: "spellDuration",
          modifier: { kind: "resistance", damage: "radiant" },
        },
      ],
    };
    const raging = reckless(placed(hero(["fury"])));
    const done = settle(
      run,
      [raging, resistant],
      [hit("weapon:srd52:item/longsword", { hadAdvantage: false })],
      scripted([]).dice,
    );
    expect(payloads(done.events, "damaged").map((item) => item.type)).toContain(
      "necrotic",
    );
    const calm = settle(
      run,
      [placed(hero(["fury"])), resistant],
      [hit("weapon:srd52:item/longsword", { hadAdvantage: false })],
      scripted([]).dice,
    );
    expect(
      payloads(calm.events, "damaged").map((item) => item.type),
    ).not.toContain("necrotic");
    const again = settle(
      run,
      done.state,
      [hit("weapon:srd52:item/longsword", { hadAdvantage: false })],
      scripted([]).dice,
    );
    expect(
      payloads(again.events, "damaged").map((item) => item.type),
    ).not.toContain("necrotic");
  });

  it("gives weapon attacks of a kind a bonus, more reach or another damage type", () => {
    const fighter = {
      ...hero(["riders"]),
      inventory: ["srd52:item/shortbow", "test:item/glaive"],
    };
    const actions = deriveStats(fighter, run).actions;
    const bow = actions.find(({ id }) => id === "weapon:srd52:item/shortbow");
    const glaive = actions.find(({ id }) => id === "weapon:test:item/glaive");
    const bowAttack = bow?.activation.resolution;
    expect(bowAttack?.kind === "attack" && bowAttack.attack.flatBonus).toBe(2);
    expect(glaive && meleeReach(glaive)).toBe(20);
    expect(glaive && isMelee(glaive)).toBe(true);
    const glaiveHit = glaive?.activation.resolution;
    expect(glaiveHit?.kind === "attack" && glaiveHit.damage[0]?.types).toEqual([
      "slashing",
      "radiant",
    ]);
  });

  it("reaches 10 feet with a Reach weapon and still counts as melee", () => {
    const fighter = { ...hero([]), inventory: ["test:item/glaive"] };
    const glaive = deriveStats(fighter, run).actions.find(
      ({ id }) => id === "weapon:test:item/glaive",
    );
    expect(glaive && meleeReach(glaive)).toBe(10);
    expect(glaive && isMelee(glaive)).toBe(true);
  });

  it("marks a creature an attack missed for Advantage on the bearer's next attack", () => {
    const fighter = placed(hero(["studied"]));
    const done = settle(
      run,
      [fighter, foe()],
      [
        {
          kind: `${NS}:missRider`,
          payload: {
            attacker: PLAYER_ACTOR,
            actionId: "weapon:srd52:item/longsword",
            target: "foe",
            critical: false,
            hadAdvantage: false,
            total: 3,
            natural: 2,
          },
        },
      ],
      scripted([]).dice,
    );
    expect(done.state.actors.foe?.activeEffects[0]?.modifier).toMatchObject({
      kind: "advantage",
      casterOnly: true,
    });
  });

  it("sets off an Opportunity Attack's rider only on the target's own turn", () => {
    const avenger = placed(hero(["avenger"]));
    const target = foe();
    const ownTurn = contextOf(run, [avenger, target], scripted([]).dice).state;
    const mine = settle(
      run,
      ownTurn,
      [hit("weapon:srd52:item/longsword", { hadAdvantage: false })],
      scripted([]).dice,
    );
    expect(mine.state.actors.foe?.activeEffects).toHaveLength(0);
    const theirs = settle(
      run,
      {
        ...ownTurn,
        combat: ownTurn.combat && { ...ownTurn.combat, index: 1 },
      },
      [hit("weapon:srd52:item/longsword", { hadAdvantage: false })],
      scripted([]).dice,
    );
    expect(theirs.state.actors.foe?.activeEffects).toHaveLength(1);
  });

  it("gives Advantage against a creature yet to act in the first round, or one the bearer marked", () => {
    const bearer = hero(["ambusher"]);
    const stats = deriveStats(bearer, run);
    const target = foe();
    const { state } = contextOf(run, [bearer, target], scripted([]).dice);
    expect(traitAttackAdvantage(stats, bearer, target, stats, state)).toBe(
      true,
    );
    const later = {
      ...state,
      combat: state.combat && { ...state.combat, round: 2 },
    };
    expect(traitAttackAdvantage(stats, bearer, target, stats, later)).toBe(
      false,
    );
    const marked: Actor = {
      ...target,
      activeEffects: [
        {
          sourceId: "feature:test:feature/mark:0",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration",
          modifier: { kind: "mark" },
        },
      ],
    };
    expect(traitAttackAdvantage(stats, bearer, marked, stats, later)).toBe(
      true,
    );
  });

  it("rolls half a pool's dice, rounded up, and Sneak Attack only on a Finesse or Ranged hit", () => {
    const stats = deriveStats(hero([]), run);
    const { dice, counts } = scripted([]);
    rollAmount({ dice: "5d6", halfDice: true }, stats, dice);
    expect(counts[6]).toBe(3);
    const rogue = { ...hero(["sneak"]), inventory: ["srd52:item/longsword"] };
    const [passive] = deriveStats(rogue, run).passives.filter(
      (item) => item.kind === "extraDamage",
    );
    const sword = deriveStats(rogue, run).actions.find(
      ({ id }) => id === "weapon:srd52:item/longsword",
    );
    const context = contextOf(run, [rogue, foe()], dice);
    expect(
      passive?.kind === "extraDamage" &&
        sword &&
        extraFits(
          passive,
          rogue,
          foe(),
          sword,
          { advantage: true, disadvantage: false },
          context,
        ),
    ).toBe(false);
  });
});
