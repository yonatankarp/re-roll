import { type Frame, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { encodeOption } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import {
  runTactic,
  tacticOptions,
} from "../plugins/systems/dnd5.5e/core/actions.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { provokers } from "../plugins/systems/dnd5.5e/core/combat/movement.ts";
import { inArea } from "../plugins/systems/dnd5.5e/core/grid.ts";
import {
  COLLECT,
  collectable,
  SHAKE,
  shakeable,
} from "../plugins/systems/dnd5.5e/core/combat/fear.ts";
import {
  type Actor,
  type ActiveEffect,
  type DndState,
  freshActor,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  attackBonus,
  deriveStats,
  spellModifier,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { settle } from "./feat-fixtures.ts";

// Attack-spell riders (issue #194) on made-up test spells beside the SRD's own: ids and mechanics only.

const spell = (slug: string): string => `srd52:spell/${slug}`;
const FOE = { creatures: 1, range: 60, side: "enemy" };
const DC = { base: 0, add: [{ kind: "spellSaveDc" }] };
const ATTACK = { type: "spell" };

// The d20 lands on 15, a hit that isn't critical, and every other die rolls its highest.
const MID: Dice = {
  below: () => 0,
  roll: (sides) => (sides === 20 ? 15 : sides),
};
// Saves fail on a 1 while damage dice roll their highest.
const FAIL_HIGH: Dice = {
  below: () => 0,
  roll: (sides) => (sides === 20 ? 1 : sides),
};

const testSpell = (slug: string, fields: Record<string, unknown>) => ({
  id: spell(slug),
  name: slug,
  level: 1,
  school: "evocation",
  classes: [],
  castingTime: "Action",
  ritual: false,
  range: "60 feet",
  components: "V",
  duration: "instantaneous",
  text: "A test spell.",
  automation: "full",
  ...fields,
});

const SPELLS = [
  testSpell("rolled", {
    activation: {
      cost: ["action"],
      targeting: FOE,
      resolution: {
        kind: "attack",
        attack: ATTACK,
        damage: [
          {
            amount: { dice: "2d8" },
            type: "acid",
            rolledTypes: ["acid", "cold", "fire", "force", "lightning"],
          },
          { amount: { dice: "1d6" }, type: "acid" },
        ],
      },
    },
  }),
  testSpell("draining", {
    activation: {
      cost: ["action"],
      targeting: FOE,
      resolution: {
        kind: "attack",
        attack: ATTACK,
        damage: [
          { amount: { dice: "1d4" }, type: "fire" },
          {
            amount: { dice: "2d6" },
            type: "necrotic",
            only: ["undead"],
            tempHp: true,
          },
        ],
      },
    },
  }),
  ...[10, 5].map((feet) =>
    testSpell(`lure-${String(feet)}`, {
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 15, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "str",
          dc: DC,
          damage: [{ amount: { dice: "1d8" }, type: "lightning" }],
          onFail: [{ kind: "forcedMove", feet, direction: "toward" }],
          onSuccess: [],
          damageWithin: 5,
        },
      },
    }),
  ),
  testSpell("seed", {
    activation: {
      cost: ["action"],
      targeting: { creatures: 1, range: 120, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "con",
        dc: DC,
        damage: [{ amount: { dice: "1d10" }, type: "fire" }],
        onFail: [],
        onSuccess: [],
        burst: {
          radius: 10,
          ability: "dex",
          dc: DC,
          damage: [{ amount: { dice: "1d10" }, type: "fire" }],
          others: true,
          everyone: true,
        },
      },
    },
  }),
  testSpell("boom", {
    level: 0,
    activation: {
      cost: ["action"],
      targeting: { creatures: 1, range: 5, side: "enemy" },
      resolution: {
        kind: "automatic",
        effects: [
          { kind: "weaponAttack" },
          {
            kind: "modifier",
            modifier: {
              kind: "moveDamage",
              once: true,
              damage: [{ amount: { dice: "1d8" }, type: "thunder" }],
            },
            duration: { until: "yourNextTurnStart" },
          },
          {
            kind: "splash",
            feet: 5,
            damage: [
              {
                amount: { bonus: { add: [{ kind: "spellMod" }] } },
                type: "fire",
              },
            ],
            perTier: "1d8",
          },
        ],
      },
    },
    cantrip: { perTier: { addDice: "1d8" } },
  }),
  testSpell("burst-blade", {
    level: 2,
    activation: {
      cost: ["bonusAction"],
      targeting: { self: true },
      resolution: {
        kind: "automatic",
        effects: [
          {
            kind: "modifier",
            modifier: { kind: "grantedAction" },
            duration: { minutes: 1 },
          },
        ],
      },
    },
    granted: {
      cost: ["bonusAction"],
      dismisses: true,
      targeting: FOE,
      resolution: {
        kind: "automatic",
        damage: [{ amount: { dice: "1d6" }, type: "radiant" }],
        effects: [],
      },
    },
  }),
  testSpell("moonlight", {
    activation: {
      cost: ["action"],
      targeting: { self: true },
      resolution: {
        kind: "automatic",
        effects: [
          {
            kind: "modifier",
            modifier: { kind: "grantedAction" },
            duration: { concentration: true, minutes: 10 },
          },
        ],
      },
    },
    granted: {
      cost: ["reaction"],
      trigger: { damaged: true, within: 60 },
      targeting: FOE,
      resolution: {
        kind: "save",
        ability: "con",
        dc: DC,
        onFail: [
          {
            kind: "applyCondition",
            condition: "blinded",
            duration: { until: "yourNextTurnEnd" },
          },
        ],
        onSuccess: [],
      },
    },
  }),
  testSpell("whirl", {
    activation: {
      cost: ["action"],
      teleportAfter: 5,
      targeting: { creatures: 2, range: 30, side: "enemy" },
      resolution: {
        kind: "attack",
        attack: ATTACK,
        damage: [{ amount: { dice: "1d10" }, type: "force" }],
      },
    },
  }),
];

const DUMMY = {
  name: "Dummy",
  ac: 10,
  hp: 500,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [
    {
      name: "Club",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", flatBonus: 4 },
          damage: [{ amount: { dice: "1d6" }, type: "bludgeoning" }],
        },
      },
    },
  ],
};
const MONSTERS = [
  { ...DUMMY, id: "test:monster/dummy" },
  { ...DUMMY, id: "test:monster/dead", creatureType: "undead" },
];

async function testRun(): Promise<RunContext> {
  const { run } = await loadAdventure("goblin-ambush");
  const byId = new Map<string, unknown>(
    [...SPELLS, ...MONSTERS].map((entry) => [entry.id, entry]),
  );
  return {
    ...run,
    content: (id) =>
      (byId.get(id) as ReturnType<RunContext["content"]>) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

// The SRD's level-1 wizard knowing these spells, at `level`.
function caster(
  run: RunContext,
  spells: readonly string[],
  { id = PLAYER_ACTOR, level = 1, inventory = ["srd52:item/longsword"] } = {},
): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  return freshActor({
    id,
    name: id,
    side: "party",
    source: {
      kind: "character",
      build: {
        ...pregen.build,
        levels: Array.from({ length: level }, () => ({
          ...first,
          answers: [{ kind: "spells" as const, values: spells.map(spell) }],
        })),
      },
    },
    hp: 100,
    inventory,
  });
}

function monster(id: string, statBlock = "test:monster/dummy"): Actor {
  return freshActor({
    id,
    name: id,
    side: "enemy",
    source: { kind: "monster", statBlockId: statBlock },
    hp: 500,
    inventory: [],
  });
}

// A fight on a 14-square grid, everyone where they're placed.
function onGrid(...placed: readonly [Actor, number, number][]): DndState {
  return {
    actors: Object.fromEntries(
      placed.map(([item, x, y]) => [item.id, { ...item, position: { x, y } }]),
    ),
    combat: {
      encounter: "arena",
      order: placed.map(([item]) => item.id),
      index: 0,
      round: 1,
      grid: { width: 14, height: 14 },
    },
  };
}

const act = (actor: string, answer: string): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor, answer },
});
const cast = (slug: string, target: string): Frame =>
  act(PLAYER_ACTOR, `spell:${spell(slug)}|${target}`);

function damageOf(events: readonly SystemEvent[], id: string): number[] {
  return events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === id
      ? [Number(event.payload.amount)]
      : [],
  );
}
const typesOf = (events: readonly SystemEvent[], id: string): string[] =>
  events.flatMap((event) =>
    event.kind === `${NS}:damaged` &&
    "payload" in event &&
    event.payload.actor === id
      ? [String(event.payload.type)]
      : [],
  );
const ctx = (run: RunContext, state: DndState, dice: Dice = MID) => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});
const need = (state: DndState, id: string): Actor => {
  const found = state.actors[id];
  if (!found) throw new Error(`No actor ${id}`);
  return found;
};

describe("attack-spell riders", () => {
  it("adds a die for each of Sorcerous Burst's 8s, up to the spellcasting modifier", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["sorcerous-burst"]), 0, 0],
      [monster("a"), 3, 0],
    );
    const mod = spellModifier(
      deriveStats(need(state, PLAYER_ACTOR), ctx(run, state)),
    );
    expect(mod).toBeGreaterThan(0);
    const burst = settle(run, state, [cast("sorcerous-burst", "a")], MID);
    expect(damageOf(burst.events, "a")).toEqual([8 * (1 + mod)]);
  });

  it("leaps Chromatic Orb on matching dice, once for a level 1 slot, never back to a creature it struck", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["chromatic-orb"]), 0, 0],
      [monster("a"), 4, 0],
      [monster("b"), 6, 0],
      [monster("c"), 8, 0],
    );
    const orb = settle(run, state, [cast("chromatic-orb", "a")], MID);
    expect(damageOf(orb.events, "a")).toEqual([24]);
    expect(damageOf(orb.events, "b")).toEqual([24]);
    expect(damageOf(orb.events, "c")).toEqual([]);
    // Dice that never match make no leap.
    let next = 0;
    const apart: Dice = {
      below: () => 0,
      roll: (sides) => (sides === 20 ? 15 : (next++ % sides) + 1),
    };
    const single = settle(run, state, [cast("chromatic-orb", "a")], apart);
    expect(damageOf(single.events, "b")).toEqual([]);
  });

  it("types the hit by a rolled die's face, the hit's other damage too, and leaps with no limit", async () => {
    const run = await testRun();
    const state = onGrid([caster(run, ["rolled"]), 0, 0], [monster("a"), 4, 0]);
    const rolled = settle(run, state, [cast("rolled", "a")], MID);
    // Both d8s show 8: the fifth type, wrapping round the list of five, and the d6 takes it too.
    expect(typesOf(rolled.events, "a")).toEqual(["fire"]);
    expect(damageOf(rolled.events, "a")).toEqual([22]);
  });

  it("deals damage only to the creature types it names, and turns it into the attacker's Temporary Hit Points", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["draining"]), 0, 0],
      [monster("a"), 4, 0],
      [monster("ghoul", "test:monster/dead"), 4, 2],
    );
    const living = settle(run, state, [cast("draining", "a")], MID);
    expect(damageOf(living.events, "a")).toEqual([4]);
    expect(need(living.state, PLAYER_ACTOR).tempHp).toBe(0);
    const dead = settle(run, state, [cast("draining", "ghoul")], MID);
    expect(damageOf(dead.events, "ghoul")).toEqual([16]);
    expect(need(dead.state, PLAYER_ACTOR).tempHp).toBe(12);
  });

  it("lands Lightning Lure's damage only when its pull leaves the target within 5 feet", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["lure-10", "lure-5"]), 0, 0],
      [monster("a"), 3, 0],
    );
    const pulled = settle(run, state, [cast("lure-10", "a")], FAIL_HIGH);
    expect(need(pulled.state, "a").position).toEqual({ x: 1, y: 0 });
    expect(damageOf(pulled.events, "a")).toEqual([8]);
    const short = settle(run, state, [cast("lure-5", "a")], FAIL_HIGH);
    expect(need(short.state, "a").position).toEqual({ x: 2, y: 0 });
    expect(damageOf(short.events, "a")).toEqual([]);
  });

  it("bursts round a save's target once it has saved, catching everyone near but the target", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["seed"]), 0, 0],
      [monster("a"), 6, 6],
      [monster("b"), 7, 6],
      [caster(run, [], { id: "ally" }), 6, 7],
      [monster("far"), 12, 12],
    );
    const seeded = settle(run, state, [cast("seed", "a")], FAIL_HIGH);
    expect(damageOf(seeded.events, "a")).toEqual([10]);
    expect(damageOf(seeded.events, "b")).toEqual([10]);
    expect(damageOf(seeded.events, "ally")).toEqual([10]);
    expect(damageOf(seeded.events, "far")).toEqual([]);
    expect(damageOf(seeded.events, PLAYER_ACTOR)).toEqual([]);
  });

  it("lands a spell's weapon-attack riders only on a hit, grown with its cantrip tier", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["boom"], { level: 5 }), 0, 0],
      [monster("a"), 1, 0],
      [monster("b"), 2, 0],
    );
    const hit = settle(run, state, [cast("boom", "a")], MID);
    const mod = spellModifier(
      deriveStats(need(state, PLAYER_ACTOR), ctx(run, state)),
    );
    // The fire leaps to b: the modifier and, past the first tier, 1d8.
    expect(damageOf(hit.events, "b")).toEqual([mod + 8]);
    const thunder = need(hit.state, "a").activeEffects.find(
      ({ modifier }) => modifier.kind === "moveDamage",
    )?.modifier;
    expect(thunder?.kind === "moveDamage" && thunder.damage).toEqual([
      { amount: { dice: "2d8" }, type: "thunder" },
    ]);
    const missed = settle(run, state, [cast("boom", "a")], {
      below: () => 0,
      roll: () => 1,
    });
    expect(need(missed.state, "a").activeEffects).toEqual([]);
    expect(damageOf(missed.events, "b")).toEqual([]);
  });

  it("gives Produce Flame's hurl for its duration, grown with the caster's level", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["produce-flame"], { level: 5 }), 0, 0],
      [monster("a"), 4, 0],
    );
    const lit = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("produce-flame")}|${PLAYER_ACTOR}`)],
      MID,
    );
    const hurl = deriveStats(
      need(lit.state, PLAYER_ACTOR),
      ctx(run, lit.state),
    ).actions.find(({ id }) => id.startsWith("granted:"));
    const resolution = hurl?.activation.resolution;
    expect(resolution?.kind === "attack" && resolution.damage).toEqual([
      { amount: { dice: "2d8" }, type: "fire" },
    ]);
  });

  it("ends the spell that gave an action which dismisses it", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["burst-blade"], { level: 3 }), 0, 0],
      [monster("a"), 4, 0],
    );
    const given = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("burst-blade")}|${PLAYER_ACTOR}`)],
      MID,
    );
    const granted = `granted:spell:${spell("burst-blade")}`;
    expect(
      deriveStats(
        need(given.state, PLAYER_ACTOR),
        ctx(run, given.state),
      ).actions.some(({ id }) => id === granted),
    ).toBe(true);
    const ready: DndState = {
      ...given.state,
      actors: {
        ...given.state.actors,
        [PLAYER_ACTOR]: {
          ...need(given.state, PLAYER_ACTOR),
          budget: { action: true, bonusAction: true, reaction: true },
        },
      },
    };
    const dismissed = settle(
      run,
      ready,
      [act(PLAYER_ACTOR, `${granted}|a`)],
      MID,
    );
    expect(damageOf(dismissed.events, "a")).toEqual([6]);
    expect(need(dismissed.state, PLAYER_ACTOR).activeEffects).toEqual([]);
  });

  it("answers damage with a Reaction a spell gives, as Fount of Moonlight's", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["moonlight"]), 0, 0],
      [monster("a"), 1, 0],
    );
    const lit = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("moonlight")}|${PLAYER_ACTOR}`)],
      MID,
    );
    let d20s = 0;
    const struck = settle(
      run,
      lit.state,
      [
        {
          kind: `${NS}:attackRoll`,
          payload: {
            attacker: "a",
            actionId: "monster:0",
            target: PLAYER_ACTOR,
          },
        },
      ],
      // The attack's d20 hits, Concentration holds, and the Reaction's save fails.
      {
        below: () => 0,
        roll: (sides) => (sides === 20 ? ([15, 20][d20s++] ?? 1) : 1),
      },
    );
    expect(damageOf(struck.events, PLAYER_ACTOR)).toEqual([1]);
    expect(struck.decisions.map(({ id }) => id)).toContain(
      `${NS}:reaction:${PLAYER_ACTOR}`,
    );
    expect(
      need(struck.state, "a").activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "condition" && modifier.condition === "blinded",
      ),
    ).toBe(true);
  });

  it("teleports beside the first target once Steel Wind Strike's attacks are made", async () => {
    const run = await testRun();
    const state = onGrid(
      [caster(run, ["whirl"]), 0, 0],
      [monster("a"), 5, 0],
      [monster("b"), 0, 5],
    );
    const struck = settle(
      run,
      state,
      [act(PLAYER_ACTOR, `spell:${spell("whirl")}|a`)],
      MID,
    );
    expect(
      struck.decisions.some(({ id }) => id.startsWith(`${NS}:teleportTo:`)),
    ).toBe(true);
    const at = need(struck.state, PLAYER_ACTOR).position;
    expect(Math.max(Math.abs((at?.x ?? 0) - 5), Math.abs(at?.y ?? 0))).toBe(1);
  });
});

describe("escaping, moving and seeing", () => {
  const vines = (dc: number): ActiveEffect => ({
    sourceId: "spell:srd52:spell/ensnaring-strike",
    casterId: "foe",
    modifier: { kind: "condition", condition: "restrained" },
    ends: "concentration",
    escape: { ability: "str", skill: "athletics", dc },
  });

  it("frees a creature held by vines with its own Athletics check, or a neighbour's", async () => {
    const run = await testRun();
    const held = { ...caster(run, []), activeEffects: [vines(12)] };
    const state = onGrid(
      [held, 0, 0],
      [caster(run, [], { id: "friend" }), 1, 0],
      [monster("foe"), 5, 5],
    );
    const collect = encodeOption(
      COLLECT,
      "foe",
      "spell:srd52:spell/ensnaring-strike",
    );
    expect(collectable(need(state, PLAYER_ACTOR))).toHaveLength(1);
    expect(shakeable(need(state, "friend"), state).map(({ id }) => id)).toEqual(
      [PLAYER_ACTOR],
    );
    expect(
      tacticOptions(need(state, PLAYER_ACTOR), state, run).map(({ id }) => id),
    ).toContain(collect);
    const tried = (by: string, answer: string, roll: number) =>
      [
        ...(runTactic(
          { actor: by, answer },
          ctx(run, state, { below: () => 0, roll: () => roll }),
        ).events ?? []),
      ].filter((event) => event.kind === `${NS}:effectEnded`);
    expect(tried(PLAYER_ACTOR, collect, 20)).toHaveLength(1);
    expect(tried(PLAYER_ACTOR, collect, 1)).toHaveLength(0);
    expect(tried("friend", encodeOption(SHAKE, PLAYER_ACTOR), 20)).toHaveLength(
      1,
    );
  });

  it("moves Infestation's target a square by a d4: north on a 1", async () => {
    const run = await testRun();
    const state = onGrid([caster(run, []), 0, 0], [monster("a"), 5, 5]);
    const events = leafEvents(
      [{ kind: "forcedMove", feet: 5, direction: "random" }],
      "spell:test",
      need(state, PLAYER_ACTOR),
      need(state, "a"),
      ctx(run, state, { below: () => 0, roll: () => 1 }),
    );
    expect(
      events.map((event) => ("payload" in event ? event.payload : null)),
    ).toContainEqual({
      actor: "a",
      to: { x: 5, y: 4 },
      feet: 0,
    });
  });

  it("widens a line that's 10 feet wide", () => {
    const origin = { x: 0, y: 5 };
    const aim = { x: 6, y: 5 };
    expect(inArea("line", 60, origin, aim, { x: 3, y: 6 })).toBe(false);
    expect(inArea("line", 60, origin, aim, { x: 3, y: 6 }, 10)).toBe(true);
    expect(inArea("line", 60, origin, aim, { x: 3, y: 7 }, 10)).toBe(false);
  });

  it("lets a creature under Zephyr Strike walk past foes unprovoked", async () => {
    const run = await testRun();
    const runner = caster(run, []);
    const state = onGrid([runner, 3, 3], [monster("a"), 4, 3]);
    const path = [
      { x: 3, y: 3 },
      { x: 2, y: 3 },
      { x: 1, y: 3 },
    ];
    expect(
      provokers(
        need(state, PLAYER_ACTOR),
        { x: 1, y: 3 },
        state,
        ctx(run, state),
        path,
      ),
    ).not.toEqual([]);
    const windy: Actor = {
      ...need(state, PLAYER_ACTOR),
      activeEffects: [
        {
          sourceId: "spell:test",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "unprovoking" },
          ends: "concentration",
        },
      ],
    };
    expect(
      provokers(windy, { x: 1, y: 3 }, state, ctx(run, state), path),
    ).toEqual([]);
  });

  it("swings a finesse weapon a spell makes with the better of Strength and Dexterity", async () => {
    const run = await testRun();
    const state = onGrid([caster(run, []), 0, 0]);
    const stats = deriveStats(need(state, PLAYER_ACTOR), ctx(run, state));
    const best = Math.max(stats.abilities.str, stats.abilities.dex);
    expect(
      attackBonus(
        {
          kind: "attack",
          attack: { type: "weapon", finesse: true },
          damage: [{ amount: { dice: "2d8" }, type: "psychic" }],
          onHit: [],
          onMiss: [],
        },
        stats,
      ),
    ).toBe(stats.proficiency + Math.floor((best - 10) / 2));
  });
});
