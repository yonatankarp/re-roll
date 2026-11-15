import { type Frame, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import type { Context } from "../plugins/systems/dnd5.5e/core/combat.ts";
import {
  leafEvents,
  resolveAction,
} from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import {
  afterActionEvents,
  expiredEvents,
  extraTurnEvents,
  limitEvents,
  turnStartEvents,
} from "../plugins/systems/dnd5.5e/core/combat/durations.ts";
import {
  attackRoutine,
  inReach,
  moveSquares,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { parseMonstersFromHtml } from "../plugins/systems/dnd5.5e/core/import/monsters.ts";
import {
  ClassSchema,
  type LeafEffect,
  MonsterSchema,
  PregenSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { lightAt } from "../plugins/systems/dnd5.5e/core/sight.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  frame,
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  fogBoundEvents,
  runZoneTick,
  spellFoiled,
  zoneFrames,
} from "../plugins/systems/dnd5.5e/core/combat/areas.ts";
import { afterDamage } from "../plugins/systems/dnd5.5e/core/combat/reactions.ts";
import { walkSpeed } from "../plugins/systems/dnd5.5e/core/tactics.ts";
import {
  affects,
  antimagicEvents,
  blockedSquares,
  placedFlag,
  zonesOf,
} from "../plugins/systems/dnd5.5e/core/zones.ts";

// Made-up monsters and spells: ids, numbers and the shapes the rules read.
const HIGH: Dice = { below: () => 0, roll: (sides) => sides };
const LOW: Dice = { below: () => 0, roll: () => 1 };

function statBlock(
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    name: id.split("/").pop(),
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
    ...fields,
  };
}

const save = (
  dc: number,
  onFail: readonly unknown[],
  onSuccess: readonly unknown[] = [],
) => ({
  kind: "save",
  ability: "con",
  dc: { base: dc, add: [] },
  damage: [],
  onSuccessDamage: "none",
  onFail,
  onSuccess,
});

const MONSTERS: Record<string, Readonly<Record<string, unknown>>> = {
  "test:monster/stinker": statBlock("test:monster/stinker", {
    passives: [
      {
        kind: "aura",
        name: "Stench",
        radius: 5,
        area: {
          when: "turnStart",
          resolution: save(
            15,
            [
              {
                kind: "applyCondition",
                condition: "poisoned",
                duration: { until: "itsNextTurnStart" },
              },
            ],
            [
              {
                kind: "modifier",
                modifier: { kind: "areaImmunity" },
                duration: { minutes: 1440 },
              },
            ],
          ),
        },
      },
    ],
  }),
  "test:monster/burner": statBlock("test:monster/burner", {
    passives: [
      {
        kind: "aura",
        name: "Fire Aura",
        radius: 5,
        area: {
          when: "ownerTurnEnd",
          resolution: {
            kind: "automatic",
            damage: [{ amount: { dice: "1d6" }, type: "fire" }],
          },
        },
      },
      {
        kind: "deathBurst",
        name: "Death Burst",
        radius: 10,
        resolution: {
          kind: "save",
          ability: "dex",
          dc: { base: 1, add: [] },
          damage: [{ amount: { dice: "2d6" }, type: "fire" }],
          onSuccessDamage: "half",
        },
      },
      { kind: "aura", name: "Glow", zone: "light", radius: 10 },
    ],
  }),
  "test:monster/marshal": statBlock("test:monster/marshal", {
    creatureType: "undead",
    passives: [
      {
        kind: "aura",
        name: "Marshal",
        radius: 60,
        area: {
          side: "ally",
          creatureTypes: ["undead"],
          awake: true,
          grants: [{ kind: "advantage", on: "attacks" }],
        },
      },
      {
        kind: "aura",
        name: "Suppression",
        radius: 60,
        area: { noHealing: true },
      },
    ],
  }),
  "test:monster/zombie": statBlock("test:monster/zombie", {
    creatureType: "undead",
  }),
  "test:monster/dread": statBlock("test:monster/dread", {
    passives: [
      {
        kind: "aura",
        name: "Dread",
        radius: 5,
        area: { side: "enemy", difficult: true },
      },
    ],
  }),
  "test:monster/vampire": statBlock("test:monster/vampire", {
    passives: [
      {
        kind: "lightSensitive",
        light: "sunlight",
        disadvantage: ["attacks", "checks"],
        damage: [{ amount: { bonus: { base: 20 } }, type: "radiant" }],
      },
    ],
  }),
  "test:monster/knight": statBlock("test:monster/knight", {
    passives: [
      {
        kind: "aura",
        name: "Courage",
        radius: 10,
        area: {
          side: "ally",
          self: true,
          grants: [{ kind: "conditionImmunity", condition: "frightened" }],
        },
      },
    ],
  }),
  "test:monster/scribe": statBlock("test:monster/scribe", {
    passives: [
      {
        kind: "aura",
        name: "Calm",
        radius: 10,
        area: {
          side: "ally",
          awake: true,
          grants: [{ kind: "advantage", on: "saves", conditions: ["charmed"] }],
        },
      },
    ],
  }),
  "test:monster/culler": statBlock("test:monster/culler", {
    passives: [
      {
        kind: "aura",
        name: "Cull",
        radius: 10,
        area: {
          bloodied: true,
          when: "ownerTurnEnd",
          resolution: save(30, [
            {
              kind: "modifier",
              modifier: { kind: "noHealing" },
              duration: { until: "yourNextTurnStart" },
            },
          ]),
        },
      },
    ],
  }),
  "test:monster/haunt": statBlock("test:monster/haunt", {
    passives: [
      {
        kind: "aura",
        name: "Haunt",
        radius: 10,
        area: { foilsSpells: { ability: "con", dc: 30 } },
      },
    ],
  }),
  "test:monster/spore": statBlock("test:monster/spore", {
    passives: [
      {
        kind: "damageBurst",
        name: "Core",
        damage: ["fire"],
        radius: 5,
        resolution: {
          kind: "automatic",
          damage: [{ amount: { bonus: { base: 4 } }, type: "fire" }],
          effects: [],
        },
      },
    ],
  }),
  "test:monster/speaker": statBlock("test:monster/speaker", {
    passives: [
      {
        kind: "aura",
        name: "Violence",
        radius: 15,
        area: {
          side: "enemy",
          when: "ownerTurnEnd",
          resolution: save(30, [
            {
              kind: "forcedAttack",
              otherwise: [{ amount: { bonus: { base: 6 } }, type: "psychic" }],
            },
          ]),
        },
      },
    ],
  }),
  "test:monster/possessor": statBlock("test:monster/possessor", {
    passives: [
      {
        kind: "aura",
        name: "Grasp",
        radius: 5,
        area: {
          when: "turnEnd",
          resolution: save(30, [
            {
              kind: "applyCondition",
              condition: "charmed",
              duration: { minutes: 1 },
              repeatSave: true,
            },
            {
              kind: "modifier",
              modifier: { kind: "actionLimit", speed: "none" },
              duration: { minutes: 1 },
              repeatSave: true,
            },
          ]),
        },
      },
    ],
  }),
  "test:monster/misty": statBlock("test:monster/misty", {
    passives: [
      { kind: "fogBound", inside: ["invisible"], outside: ["incapacitated"] },
    ],
  }),
};

async function arena(): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const wizard = ClassSchema.parse(base.content("srd52:class/wizard"));
  const [first] = wizard.levels;
  if (!first) throw new Error("The wizard has no levels");
  const content: Record<string, unknown> = {
    ...MONSTERS,
    "srd52:class/wizard": {
      ...wizard,
      levels: Array.from({ length: 20 }, (_, index) => ({
        ...(index === 0 ? first : { grants: [], choices: [], scaling: {} }),
        level: index + 1,
        slots: [4, 3, 3, 3, 3, 2, 2, 1, 1],
      })),
    },
  };
  return {
    ...base,
    content: (id) =>
      (content[id] as ReturnType<RunContext["content"]>) ?? base.content(id),
    contentIds: () => [
      ...new Set([...base.contentIds(), ...Object.keys(content)]),
    ],
  };
}

function hero(run: RunContext, x: number, y: number, id = PLAYER_ACTOR): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  return {
    ...freshActor({
      id,
      name: id,
      side: "party",
      source: { kind: "character", build: pregen.build },
      hp: 100,
      inventory: ["srd52:item/longsword"],
    }),
    position: { x, y },
  };
}

function monster(id: string, block: string, x: number, y: number): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: `test:monster/${block}` },
      hp: 500,
      inventory: [],
    }),
    position: { x, y },
  };
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
      grid: { width: 12, height: 12 },
    },
  };
}

const contextOf = (run: RunContext, state: DndState, dice: Dice): Context => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

// The kernel's loop for frames alone, with chosen dice.
function settle(
  run: RunContext,
  start: DndState,
  frames: readonly Frame[],
  dice: Dice,
): { readonly state: DndState; readonly events: readonly SystemEvent[] } {
  let state = start;
  const events: SystemEvent[] = [];
  const stack = [...frames].reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    const definition = run.system.frames[top.kind];
    if (!definition) throw new Error(`Unknown frame ${top.kind}`);
    const result = definition.run(top.payload, contextOf(run, state, dice));
    for (const event of result.events ?? []) {
      events.push(event);
      state = applyDndEvent(state, event);
    }
    stack.push(...[...(result.frames ?? [])].reverse());
  }
  return { state, events };
}

const frameOf = (kind: string): Frame => ({
  kind: `${NS}:${kind}`,
  payload: {},
});
const apply = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);
const damageTo = (events: readonly SystemEvent[], actor: string): number[] =>
  events.flatMap((event) =>
    event.kind === `${NS}:damaged` && event.payload.actor === actor
      ? [Number(event.payload.amount)]
      : [],
  );
const kinds = (events: readonly SystemEvent[]): string[] =>
  events.map((event) => event.kind);
const actor = (state: DndState, id: string): Actor => {
  const found = state.actors[id];
  if (!found) throw new Error(`No actor ${id}`);
  return found;
};

const effect = (modifier: unknown, duration: unknown): LeafEffect =>
  ({ kind: "modifier", modifier, duration }) as LeafEffect;

describe("durations counted in rounds", () => {
  it("ends a one-minute effect as its caster's turn starts ten rounds on", async () => {
    const run = await arena();
    const state = fight(hero(run, 0, 0), monster("foe", "zombie", 1, 0));
    const events = leafEvents(
      [
        effect(
          { kind: "bonus", to: "ac", amount: { bonus: { base: -2 } } },
          { concentration: true, minutes: 1 },
        ),
      ],
      "spell:test",
      actor(state, PLAYER_ACTOR),
      actor(state, "foe"),
      contextOf(run, state, LOW),
    );
    const after = apply(state, events);
    expect(actor(after, "foe").activeEffects[0]?.lasts).toEqual({
      actor: PLAYER_ACTOR,
      round: 11,
      at: "start",
    });
    const at = (round: number): DndState => ({
      ...after,
      combat: after.combat ? { ...after.combat, round } : null,
    });
    expect(expiredEvents(at(10), PLAYER_ACTOR, "start")).toEqual([]);
    expect(kinds(expiredEvents(at(11), PLAYER_ACTOR, "start"))).toEqual([
      `${NS}:effectEnded`,
    ]);
    // A turn that never comes, as a dead caster's, still lets it run out once the next round begins.
    expect(expiredEvents(at(12), "foe", "start")).toHaveLength(1);
  });
});

describe("auras", () => {
  it("poisons whoever starts its turn in a Stench until its own next turn, and spares one that saved", async () => {
    const run = await arena();
    const start = fight(monster("ghast", "stinker", 1, 0), hero(run, 0, 0));
    const failed = settle(run, start, [frameOf("advanceTurn")], LOW).state;
    const me = actor(failed, PLAYER_ACTOR);
    expect(hasCondition(me, "poisoned")).toBe(true);
    expect(me.activeEffects.find((item) => item.lasts)?.lasts).toEqual({
      actor: PLAYER_ACTOR,
      round: 2,
      at: "start",
    });
    const saved = settle(run, start, [frameOf("advanceTurn")], HIGH).state;
    expect(hasCondition(actor(saved, PLAYER_ACTOR), "poisoned")).toBe(false);
    const immune = actor(saved, PLAYER_ACTOR).activeEffects.some(
      ({ modifier }) => modifier.kind === "areaImmunity",
    );
    expect(immune).toBe(true);
    // Its next turn there, nothing is rolled.
    const again = settle(
      run,
      { ...saved, combat: saved.combat ? { ...saved.combat, index: 0 } : null },
      [frameOf("advanceTurn")],
      LOW,
    );
    expect(kinds(again.events)).not.toContain(`${NS}:saveRolled`);
  });

  it("burns everyone close as its owner's turn ends, and not one farther off", async () => {
    const run = await arena();
    const start = fight(
      monster("balor", "burner", 1, 1),
      hero(run, 0, 0),
      hero(run, 5, 5, "far"),
    );
    const { events } = settle(run, start, [frameOf("endTurn")], HIGH);
    expect(damageTo(events, PLAYER_ACTOR)).toEqual([6]);
    expect(damageTo(events, "far")).toEqual([]);
  });

  it("gives its undead allies Advantage only while its owner is awake", async () => {
    const run = await arena();
    const state = fight(
      monster("knight", "marshal", 0, 0),
      monster("zombie", "zombie", 3, 3),
      monster("living", "stinker", 2, 2),
    );
    const context = contextOf(run, state, LOW);
    const flag = (id: string, at: DndState): boolean =>
      placedFlag(actor(at, id), "advantage", "attacks", at, context);
    expect(flag("zombie", state)).toBe(true);
    expect(flag("living", state)).toBe(false);
    expect(flag("knight", state)).toBe(false);
    const stunned = apply(state, [
      dndEvent(`${NS}:effectAdded`, {
        actor: "knight",
        effect: {
          sourceId: "test",
          casterId: "zombie",
          modifier: { kind: "condition", condition: "stunned" },
          ends: "spellDuration",
        },
      }),
    ]);
    expect(flag("zombie", stunned)).toBe(false);
  });

  it("stops healing in Life Suppression", async () => {
    const run = await arena();
    const state = fight(monster("dracolich", "marshal", 0, 0), hero(run, 2, 0));
    const me = actor(state, PLAYER_ACTOR);
    const events = leafEvents(
      [{ kind: "heal", amount: { bonus: { base: 10, add: [] } } }],
      "spell:test",
      me,
      { ...me, hp: 50 },
      contextOf(run, state, LOW),
    );
    expect(kinds(events)).not.toContain(`${NS}:healed`);
  });

  it("bursts where it dies, once, before the fight is called", async () => {
    const run = await arena();
    const start = fight(monster("skeleton", "burner", 1, 0), hero(run, 0, 0));
    const dead = apply(start, [
      dndEvent(`${NS}:damaged`, {
        actor: "skeleton",
        amount: 600,
        type: "slashing",
        critical: false,
        massive: false,
      }),
    ]);
    const { events, state } = settle(
      run,
      dead,
      [frameOf("checkCombatEnd")],
      HIGH,
    );
    expect(damageTo(events, PLAYER_ACTOR)).toEqual([6]); // half of 12, for the save
    expect(kinds(events)).toContain(`${NS}:combatEnded`);
    expect(state.combat).toBeNull();
  });
});

describe("light and sunlight", () => {
  it("hampers and burns a sunlight-sensitive creature only in sunlight", async () => {
    const run = await arena();
    const shade = fight(monster("vampire", "vampire", 1, 0), hero(run, 0, 0));
    const sunny: DndState = {
      ...shade,
      combat: shade.combat ? { ...shade.combat, sunlight: true } : null,
    };
    const flag = (at: DndState): boolean =>
      placedFlag(
        actor(at, "vampire"),
        "disadvantage",
        "attacks",
        at,
        contextOf(run, at, LOW),
      );
    expect(flag(shade)).toBe(false);
    expect(flag(sunny)).toBe(true);
    const turn = (at: DndState) => ({
      ...at,
      combat: at.combat ? { ...at.combat, index: 1 } : null,
    });
    const burnt = settle(run, turn(sunny), [frameOf("advanceTurn")], LOW);
    expect(damageTo(burnt.events, "vampire")).toEqual([20]);
    const spared = settle(run, turn(shade), [frameOf("advanceTurn")], LOW);
    expect(damageTo(spared.events, "vampire")).toEqual([]);
  });

  it("lights a dark map round a creature that sheds light, wherever it goes", async () => {
    const run = await arena();
    const base = fight(monster("skull", "burner", 5, 5), hero(run, 0, 0));
    const state: DndState = {
      ...base,
      combat: base.combat
        ? {
            ...base.combat,
            terrain: {
              difficult: [],
              half: [],
              threeQuarters: [],
              dim: [],
              dark: [],
              light: "dark",
            },
          }
        : null,
    };
    const context = contextOf(run, state, LOW);
    expect(lightAt({ x: 6, y: 7 }, state, context)).toBe("bright");
    expect(lightAt({ x: 0, y: 0 }, state, context)).toBe("dark");
  });
});

describe("Slow and Haste", () => {
  it("halves Speed, allows one attack, and takes the other of action and Bonus Action and the Reaction", async () => {
    const run = await arena();
    const state = fight(hero(run, 0, 0), monster("foe", "zombie", 1, 0));
    const context = contextOf(run, state, LOW);
    const limit = {
      kind: "actionLimit",
      oneAction: true,
      noReactions: true,
      oneAttack: true,
      speed: "half",
    } as const;
    const events = leafEvents(
      [effect(limit, { concentration: true, minutes: 1 })],
      "spell:slow",
      actor(state, "foe"),
      actor(state, PLAYER_ACTOR),
      context,
    );
    expect(events).toContainEqual(
      dndEvent(`${NS}:budgetSpent`, { actor: PLAYER_ACTOR, kind: "reaction" }),
    );
    const slowed = apply(state, events);
    const me = actor(slowed, PLAYER_ACTOR);
    const stats = deriveStats(me, context);
    expect(walkSpeed(me, stats)).toBe(15);
    const attack = stats.actions.find(
      (item) => item.activation.resolution.kind === "attack",
    );
    if (!attack) throw new Error("No attack");
    expect(
      attackRoutine(attack, me, { ...stats, multiattack: 2 }),
    ).toHaveLength(1);
    const acted = { ...me, budget: { ...me.budget, action: false } };
    expect(afterActionEvents(acted)).toEqual([
      dndEvent(`${NS}:budgetSpent`, {
        actor: PLAYER_ACTOR,
        kind: "bonusAction",
      }),
    ]);
    expect(limitEvents(me, { noActions: true }, true)).toHaveLength(2);
  });

  it("doubles Speed and gives one more action, then leaves the target lethargic when it ends", async () => {
    const run = await arena();
    const state = fight(hero(run, 0, 0), monster("foe", "zombie", 5, 0));
    const context = contextOf(run, state, LOW);
    const me = actor(state, PLAYER_ACTOR);
    const hasted = apply(
      state,
      leafEvents(
        [effect({ kind: "hasted" }, { concentration: true, minutes: 1 })],
        "spell:haste",
        me,
        me,
        context,
      ),
    );
    const quick = actor(hasted, PLAYER_ACTOR);
    expect(walkSpeed(quick, deriveStats(quick, context))).toBe(60);
    const acted = { ...quick, budget: { ...quick.budget, action: false } };
    expect(kinds(afterActionEvents(acted))).toEqual([
      `${NS}:actionRegained`,
      `${NS}:oncePerTurnUsed`,
    ]);
    const ended = apply(hasted, [
      dndEvent(`${NS}:effectEnded`, {
        actor: PLAYER_ACTOR,
        sourceId: "spell:haste",
        casterId: PLAYER_ACTOR,
      }),
    ]);
    const tired = apply(
      ended,
      turnStartEvents(actor(ended, PLAYER_ACTOR), ended),
    );
    expect(hasCondition(actor(tired, PLAYER_ACTOR), "incapacitated")).toBe(
      true,
    );
  });
});

const spell = (
  name: string,
  activation: Record<string, unknown>,
): KnownAction => ({
  id: `spell:test:spell/${name.toLowerCase().replace(/\s+/g, "-")}`,
  name,
  activation: activation as unknown as KnownAction["activation"],
  spellLevel: 3,
});

describe("areas spells leave", () => {
  it("poisons and stops the actions of whoever starts its turn in a stinking cloud", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 6, 6));
    const cloud = spell("Stinking Cloud", {
      cost: ["action", "slot"],
      targeting: {
        area: { shape: "sphere", radius: 10 },
        range: 90,
        side: "enemy",
      },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [
          {
            kind: "zone",
            zone: "fog",
            radius: 10,
            duration: { concentration: true, minutes: 1 },
          },
        ],
      },
      area: {
        when: "turnStart",
        resolution: save(30, [
          {
            kind: "applyCondition",
            condition: "poisoned",
            duration: { until: "turnEnd" },
          },
          effect(
            { kind: "actionLimit", noActions: true },
            { until: "turnEnd" },
          ),
        ]),
      },
    });
    const cast = resolveAction(
      cloud,
      actor(start, PLAYER_ACTOR),
      [],
      contextOf(run, start, LOW),
      3,
      false,
      { x: 6, y: 6 },
    );
    const clouded = apply(start, cast.events ?? []);
    expect(zonesOf(clouded)).toHaveLength(1);
    const { state } = settle(run, clouded, [frameOf("advanceTurn")], LOW);
    const foe = actor(state, "foe");
    expect(hasCondition(foe, "poisoned")).toBe(true);
    expect(foe.budget.action).toBe(false);
    expect(foe.budget.bonusAction).toBe(false);
  });

  it("walls a ring of squares that no one walks through, pushing a creature on it inward", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 5), monster("foe", "zombie", 7, 5));
    const wall = spell("Wall", {
      cost: ["action", "slot"],
      targeting: {
        area: { shape: "sphere", radius: 10 },
        range: 120,
        side: "enemy",
      },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [
          {
            kind: "zone",
            zone: "wall",
            radius: 10,
            duration: { concentration: true, minutes: 10 },
          },
        ],
      },
    });
    const cast = resolveAction(
      wall,
      actor(start, PLAYER_ACTOR),
      [],
      contextOf(run, start, LOW),
      5,
      false,
      { x: 5, y: 5 },
    );
    const walled = apply(start, cast.events ?? []);
    const blocked = new Set(blockedSquares(walled));
    expect(blocked.has("3,5")).toBe(true);
    expect(blocked.has("7,3")).toBe(true);
    expect(actor(walled, "foe").position).toEqual({ x: 6, y: 5 });
    const context = contextOf(run, walled, LOW);
    const me = actor(walled, PLAYER_ACTOR);
    const squares = moveSquares(
      me,
      walled,
      deriveStats(me, context),
      context,
    ).map((item) => `${String(item.square.x)},${String(item.square.y)}`);
    expect(squares).not.toContain("4,5");
  });
});

const beam = (radius: number, follows = false): KnownAction =>
  spell("Beam", {
    cost: ["action", "slot"],
    targeting: follows
      ? { area: { shape: "emanation", radius }, range: "self", side: "enemy" }
      : { area: { shape: "sphere", radius }, range: 120, side: "enemy" },
    resolution: {
      kind: "automatic",
      damage: [],
      effects: [
        {
          kind: "zone",
          zone: "area",
          radius,
          duration: { concentration: true, minutes: 1 },
          ...(follows ? { follows: true } : {}),
        },
      ],
    },
    area: {
      side: "enemy",
      when: "turnEnd",
      enters: true,
      resolution: {
        ...save(30, []),
        damage: [{ amount: { bonus: { base: 7 } }, type: "radiant" }],
      },
    },
  });

describe("walking into an area", () => {
  it("acts on a creature that walks through it, once a turn, and again on a later turn", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 0, 6));
    const cast = resolveAction(
      beam(10),
      actor(start, PLAYER_ACTOR),
      [],
      contextOf(run, start, LOW),
      3,
      false,
      { x: 3, y: 6 },
    );
    const lit = apply(start, cast.events ?? []);
    const theirs: DndState = lit.combat
      ? { ...lit, combat: { ...lit.combat, index: 1 } }
      : lit;
    const walked = settle(
      run,
      theirs,
      [frame("move", { actor: "foe", answer: "6,6" })],
      LOW,
    );
    expect(damageTo(walked.events, "foe")).toEqual([7]);
    expect(actor(walked.state, "foe").position).toEqual({ x: 6, y: 6 });
    // In and staying put: the walk in was this turn's save, so ending the turn there is not another.
    const stopped = settle(
      run,
      theirs,
      [frame("move", { actor: "foe", answer: "3,6" })],
      LOW,
    );
    expect(damageTo(stopped.events, "foe")).toEqual([7]);
    const ended = settle(
      run,
      stopped.state,
      zoneFrames(
        actor(stopped.state, "foe"),
        "end",
        contextOf(run, stopped.state, LOW),
      ),
      LOW,
    );
    expect(damageTo(ended.events, "foe")).toEqual([]);
    const later: DndState = stopped.state.combat
      ? { ...stopped.state, combat: { ...stopped.state.combat, round: 2 } }
      : stopped.state;
    const next = settle(
      run,
      later,
      zoneFrames(actor(later, "foe"), "end", contextOf(run, later, LOW)),
      LOW,
    );
    expect(damageTo(next.events, "foe")).toEqual([7]);
  });

  it("acts on a foe a moving area is brought up to, as Spirit Guardians", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 8, 0));
    const cast = resolveAction(
      beam(15, true),
      actor(start, PLAYER_ACTOR),
      [],
      contextOf(run, start, LOW),
      3,
      false,
    );
    const guarded = apply(start, cast.events ?? []);
    const walked = settle(
      run,
      guarded,
      [frame("move", { actor: PLAYER_ACTOR, answer: "5,0" })],
      LOW,
    );
    expect(damageTo(walked.events, "foe")).toEqual([7]);
    expect(damageTo(walked.events, PLAYER_ACTOR)).toEqual([]);
  });
});

describe("one-off auras", () => {
  const ally = (id: string, block: string, x: number, y: number): Actor => ({
    ...monster(id, block, x, y),
  });
  const frightened: LeafEffect = {
    kind: "applyCondition",
    condition: "frightened",
    duration: { minutes: 1 },
    repeatSave: false,
    endsOnDamage: false,
  };

  it("keeps allies in a brave aura from being frightened, and not those outside it", async () => {
    const run = await arena();
    const state = fight(
      hero(run, 0, 0),
      monster("knight", "knight", 5, 5),
      ally("near", "zombie", 6, 5),
      ally("far", "zombie", 11, 11),
    );
    const context = contextOf(run, state, LOW);
    const me = actor(state, PLAYER_ACTOR);
    const on = (id: string) =>
      apply(
        state,
        leafEvents([frightened], "x", me, actor(state, id), context),
      );
    expect(hasCondition(actor(on("near"), "near"), "frightened")).toBe(false);
    expect(hasCondition(actor(on("knight"), "knight"), "frightened")).toBe(
      false,
    );
    expect(hasCondition(actor(on("far"), "far"), "frightened")).toBe(true);
  });

  it("gives Advantage only on saves against the conditions it names", async () => {
    const run = await arena();
    const state = fight(
      hero(run, 0, 0),
      monster("scribe", "scribe", 5, 5),
      ally("near", "zombie", 6, 5),
    );
    const context = contextOf(run, state, LOW);
    const near = actor(state, "near");
    const flag = (conditions: readonly string[]) =>
      placedFlag(
        near,
        "advantage",
        "saves",
        state,
        context,
        undefined,
        conditions,
      );
    expect(flag(["charmed"])).toBe(true);
    expect(flag(["frightened"])).toBe(false);
    expect(flag([])).toBe(false);
  });

  it("stops healing only for the Bloodied as its owner's turn ends", async () => {
    const run = await arena();
    const state = fight(
      monster("culler", "culler", 0, 0),
      { ...monster("hurt", "zombie", 1, 0), hp: 200 },
      monster("fresh", "zombie", 0, 1),
      hero(run, 11, 11),
    );
    const context = contextOf(run, state, LOW);
    const ticks = zoneFrames(actor(state, "culler"), "end", context);
    const after = settle(run, state, ticks, LOW).state;
    const noHealing = (id: string) =>
      actor(after, id).activeEffects.some(
        ({ modifier }) => modifier.kind === "noHealing",
      );
    expect(noHealing("hurt")).toBe(true);
    expect(noHealing("fresh")).toBe(false);
  });

  it("foils a spell cast close to a haunting creature unless the caster saves", async () => {
    const run = await arena();
    const state = fight(hero(run, 1, 0), monster("haunt", "haunt", 0, 0));
    const bolt = spell("Bolt", {
      cost: ["action"],
      targeting: { creatures: 1, range: 60, side: "enemy" },
      resolution: {
        kind: "automatic",
        damage: [{ amount: { bonus: { base: 5 } }, type: "fire" }],
        effects: [],
      },
    });
    const near = spellFoiled(
      actor(state, PLAYER_ACTOR),
      bolt,
      contextOf(run, state, LOW),
    );
    expect(near?.failed).toBe(true);
    const away = fight(hero(run, 6, 0), monster("haunt", "haunt", 0, 0));
    expect(
      spellFoiled(actor(away, PLAYER_ACTOR), bolt, contextOf(run, away, LOW)),
    ).toBeNull();
  });

  it("bursts on fire damage, once a turn, so two neighbours don't set each other off forever", async () => {
    const run = await arena();
    const state = fight(
      hero(run, 0, 0),
      monster("a", "spore", 1, 0),
      monster("b", "spore", 2, 0),
    );
    const context = contextOf(run, state, LOW);
    const frames = afterDamage(
      actor(state, "a"),
      5,
      { types: ["fire"] },
      [],
      context,
    );
    const { events } = settle(run, state, frames, LOW);
    expect(damageTo(events, PLAYER_ACTOR)).toEqual([4]);
    expect(damageTo(events, "b")).toEqual([4]);
    expect(damageTo(events, "a")).toEqual([4]);
    expect(
      afterDamage(actor(state, "a"), 5, { types: ["cold"] }, [], context),
    ).toEqual([]);
  });

  it("makes a foe in it attack its own ally with its Reaction, or hurts it when none is in reach", async () => {
    const run = await arena();
    const state = fight(
      monster("speaker", "speaker", 0, 0),
      hero(run, 1, 0),
      hero(run, 2, 0, "friend"),
    );
    const context = contextOf(run, state, LOW);
    const [tick] = zoneFrames(actor(state, "speaker"), "end", context);
    if (!tick) throw new Error("No tick");
    const result = runZoneTick(
      tick.payload as Parameters<typeof runZoneTick>[0],
      context,
    );
    const attacks = (result.frames ?? []).filter(
      (item) => item.kind === `${NS}:attackRoll`,
    );
    expect(attacks.map((item) => item.payload)).toContainEqual(
      expect.objectContaining({ attacker: PLAYER_ACTOR, target: "friend" }),
    );
    const alone = fight(monster("speaker", "speaker", 0, 0), hero(run, 2, 0));
    const lonely = contextOf(run, alone, LOW);
    const [far] = zoneFrames(actor(alone, "speaker"), "end", lonely);
    if (!far) throw new Error("No tick");
    const hurt = runZoneTick(
      far.payload as Parameters<typeof runZoneTick>[0],
      lonely,
    );
    expect(damageTo(hurt.events ?? [], PLAYER_ACTOR)).toEqual([6]);
  });

  it("charms and roots whoever ends its turn in it, with the first save to end it a turn later", async () => {
    const run = await arena();
    const start = fight(
      hero(run, 1, 0),
      monster("possessor", "possessor", 0, 0),
    );
    const ticks = zoneFrames(
      actor(start, PLAYER_ACTOR),
      "end",
      contextOf(run, start, LOW),
    );
    const { state } = settle(
      run,
      start,
      [...ticks, frameOf("finishTurn")],
      HIGH,
    );
    const me = actor(state, PLAYER_ACTOR);
    expect(hasCondition(me, "charmed")).toBe(true);
    expect(walkSpeed(me, deriveStats(me, contextOf(run, state, LOW)))).toBe(0);
  });

  it("makes a fog-bound creature Invisible in fog and Incapacitated out of it", async () => {
    const run = await arena();
    const out = fight(hero(run, 0, 0), monster("misty", "misty", 6, 6));
    const outside = apply(
      out,
      fogBoundEvents(actor(out, "misty"), contextOf(run, out, LOW)),
    );
    expect(hasCondition(actor(outside, "misty"), "incapacitated")).toBe(true);
    const cloud = spell("Fog", {
      cost: ["action"],
      targeting: {
        area: { shape: "sphere", radius: 10 },
        range: 60,
        side: "enemy",
      },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [
          {
            kind: "zone",
            zone: "fog",
            radius: 10,
            duration: { concentration: true, minutes: 1 },
          },
        ],
      },
    });
    const cast = resolveAction(
      cloud,
      actor(outside, PLAYER_ACTOR),
      [],
      contextOf(run, outside, LOW),
      1,
      false,
      { x: 6, y: 6 },
    );
    const fogged = apply(outside, cast.events ?? []);
    const inside = apply(
      fogged,
      fogBoundEvents(actor(fogged, "misty"), contextOf(run, fogged, LOW)),
    );
    expect(hasCondition(actor(inside, "misty"), "incapacitated")).toBe(false);
    expect(hasCondition(actor(inside, "misty"), "invisible")).toBe(true);
  });
});

describe("what a slot or a circle changes in an area", () => {
  const zoneSpell = (
    zone: Record<string, unknown>,
    area: Record<string, unknown>,
    follows = false,
  ): KnownAction =>
    spell("Shape", {
      cost: ["action", "slot"],
      targeting: follows
        ? {
            area: { shape: "emanation", radius: 10 },
            range: "self",
            side: "ally",
          }
        : { area: { shape: "sphere", radius: 10 }, range: 120, side: "enemy" },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [
          {
            kind: "zone",
            zone: "area",
            radius: 10,
            duration: { concentration: true, minutes: 1 },
            ...(follows ? { follows: true } : {}),
            ...zone,
          },
        ],
      },
      area,
    });
  const cast = (
    run: RunContext,
    start: DndState,
    action: KnownAction,
    slot: number,
  ) =>
    apply(
      start,
      resolveAction(
        action,
        actor(start, PLAYER_ACTOR),
        [],
        contextOf(run, start, LOW),
        slot,
        false,
        { x: 5, y: 5 },
      ).events ?? [],
    );

  it("widens a fog with the slot, and raises the level a globe blocks", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 11, 11));
    const wide = cast(
      run,
      start,
      zoneSpell({ perSlot: 20 }, { disperses: true }),
      5,
    );
    expect(zonesOf(wide)[0]?.radius).toBe(50);
    const globe = cast(
      run,
      start,
      zoneSpell({}, { spellShield: 5, shieldGrows: true, self: true }, true),
      5,
    );
    expect(zonesOf(globe)[0]?.area?.spellShield).toBe(7);
  });

  it("gives Advantage only on magical saves in a circle, and no damage on a success that halves it", async () => {
    const run = await arena();
    const start = fight(hero(run, 5, 5), monster("foe", "zombie", 0, 0));
    const circled = cast(
      run,
      start,
      zoneSpell(
        {},
        {
          side: "ally",
          self: true,
          magicWard: true,
          grants: [{ kind: "advantage", on: "saves", magical: true }],
        },
        true,
      ),
      5,
    );
    const context = contextOf(run, circled, HIGH);
    const me = actor(circled, PLAYER_ACTOR);
    expect(
      placedFlag(
        me,
        "advantage",
        "saves",
        circled,
        context,
        undefined,
        [],
        true,
      ),
    ).toBe(true);
    expect(placedFlag(me, "advantage", "saves", circled, context)).toBe(false);
    const blast = spell("Blast", {
      cost: ["action", "slot"],
      targeting: { creatures: 1, range: 60, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: { base: 5, add: [] },
        damage: [{ amount: { bonus: { base: 10, add: [] } }, type: "fire" }],
        onSuccessDamage: "half",
        onFail: [],
        onSuccess: [],
      },
    });
    const hit = resolveAction(blast, actor(circled, "foe"), [me], context, 3);
    expect(damageTo(hit.events ?? [], PLAYER_ACTOR)).toEqual([]);
  });

  it("holds off spells and magic items in an Antimagic Field, and no other spell's area reaches in", async () => {
    const run = await arena();
    const ring = "srd52:item/ring-of-protection";
    const blessed = {
      ...hero(run, 5, 5),
      inventory: [ring],
      attuned: [ring],
      activeEffects: [
        {
          sourceId: "spell:test:spell/bless",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration" as const,
          modifier: {
            kind: "bonus" as const,
            to: "saves" as const,
            amount: { dice: "1d4" },
          },
        },
      ],
    };
    const start = fight(blessed, monster("foe", "zombie", 6, 5));
    const field = apply(
      start,
      resolveAction(
        zoneSpell({}, { noSpells: "all", self: true }, true),
        actor(start, "foe"),
        [],
        contextOf(run, start, LOW),
        8,
      ).events ?? [],
    );
    const held = apply(field, antimagicEvents(field));
    const me = actor(held, PLAYER_ACTOR);
    expect(me.activeEffects).toEqual([]);
    expect(me.suppressed).toHaveLength(1);
    const context = contextOf(run, held, LOW);
    expect(deriveStats(me, context).ac).toBe(
      deriveStats(actor(start, PLAYER_ACTOR), context).ac - 1,
    );
    const cloud = apply(
      held,
      resolveAction(
        zoneSpell({}, { when: "turnStart", resolution: save(30, []) }),
        actor(held, PLAYER_ACTOR),
        [],
        context,
        3,
        false,
        { x: 5, y: 5 },
      ).events ?? [],
    );
    const cloudZone = zonesOf(cloud).find(
      (zone) => zone.owner === PLAYER_ACTOR,
    );
    if (!cloudZone) throw new Error("No cloud");
    expect(affects(cloudZone, actor(cloud, PLAYER_ACTOR), cloud, context)).toBe(
      false,
    );
    const away = apply(held, [
      dndEvent(`${NS}:moved`, { actor: "foe", to: { x: 11, y: 11 }, feet: 0 }),
    ]);
    const back = actor(apply(away, antimagicEvents(away)), PLAYER_ACTOR);
    expect(back.activeEffects).toHaveLength(1);
    expect(back.suppressed).toBeUndefined();
  });

  it("gives Immunity to Thunder damage inside Silence", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 5, 5));
    const quiet = cast(
      run,
      start,
      zoneSpell(
        {},
        {
          noSpells: "verbal",
          grants: [{ kind: "immunity", damage: "thunder" }],
        },
      ),
      3,
    );
    const context = contextOf(run, quiet, LOW);
    expect(damageResponses(actor(quiet, "foe"), context).immunities).toContain(
      "thunder",
    );
    expect(
      damageResponses(actor(quiet, PLAYER_ACTOR), context).immunities,
    ).not.toContain("thunder");
  });
});

describe("sealed away and Time Stop", () => {
  it("puts a sealed foe out of reach, and ends the fight when only sealed foes are left", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 1, 0));
    const sealed = apply(start, [
      dndEvent(`${NS}:effectAdded`, {
        actor: "foe",
        effect: {
          sourceId: "spell:maze",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "sealed",
            escape: { ability: "int", dc: 20, skill: "investigation" },
          },
          ends: "concentration",
        },
      }),
    ]);
    const context = contextOf(run, sealed, LOW);
    const me = actor(sealed, PLAYER_ACTOR);
    const club = deriveStats(me, context).actions.find(
      (item) => item.activation.resolution.kind === "attack",
    );
    if (!club) throw new Error("No attack");
    expect(inReach(club, me, sealed, context)).toEqual([]);
    const { events } = settle(run, sealed, [frameOf("checkCombatEnd")], LOW);
    expect(kinds(events)).toContain(`${NS}:combatEnded`);
  });

  it("takes another turn under Time Stop, one fewer each time", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 5, 0));
    const stopped = apply(start, [
      dndEvent(`${NS}:effectAdded`, {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "spell:time-stop",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "extraTurns", turns: 2 },
          ends: "spellDuration",
        },
      }),
      dndEvent(`${NS}:budgetSpent`, { actor: PLAYER_ACTOR, kind: "action" }),
    ]);
    const events = extraTurnEvents(actor(stopped, PLAYER_ACTOR)) ?? [];
    const after = apply(stopped, events);
    const me = actor(after, PLAYER_ACTOR);
    expect(me.budget.action).toBe(true);
    expect(after.combat?.index).toBe(0);
    expect(me.activeEffects[0]?.modifier).toEqual({
      kind: "extraTurns",
      turns: 1,
    });
  });
});

describe("reading areas from stat blocks", () => {
  const row = (name: string) =>
    `<tr><th>${name}</th><td>10</td><td>0</td><td>0</td></tr>`;
  const parse = (label: string, text: string) => {
    const [parsed] = parseMonstersFromHtml(
      `<div class="stat-block"><h3>Test Fiend</h3><p>Medium Fiend, Chaotic Evil</p><p><strong>AC</strong> 12</p><p><strong>HP</strong> 40 (9d8)</p><p><strong>Speed</strong> 30 ft.</p><table>${["Str", "Dex", "Con", "Int", "Wis", "Cha"].map(row).join("")}</table><p class="monster-header">Traits</p><p><strong><em>${label}.</em></strong> ${text}</p><p class="monster-header">Actions</p><p><strong><em>Claw.</em></strong> Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Slashing damage.</p></div>`,
      "my-book",
    );
    return MonsterSchema.parse(parsed?.entry).passives;
  };

  it("reads a save at the start of a turn in an Emanation, with immunity after a success", () => {
    const [aura] = parse(
      "Reek",
      "Constitution Saving Throw: DC 11, any creature that starts its turn in a 10-foot Emanation originating from the fiend. Failure: The target has the Poisoned condition until the start of its next turn. Success: The target is immune to this fiend’s Reek for 24 hours.",
    );
    expect(aura).toMatchObject({
      kind: "aura",
      name: "Reek",
      radius: 10,
      area: { when: "turnStart", resolution: { kind: "save" } },
    });
  });

  it("reads the one-off auras: immunity, Advantage against conditions, the Bloodied, a foiled spell, a burst on damage, a forced attack, a charm that roots, and fog", () => {
    expect(
      parse(
        "Steadfast",
        "Creatures of the fiend’s choice in a 20-foot Emanation originating from it have Immunity to the Frightened condition while there.",
      )[0],
    ).toMatchObject({
      radius: 20,
      area: {
        side: "ally",
        grants: [{ kind: "conditionImmunity", condition: "frightened" }],
      },
    });
    expect(
      parse(
        "Soothing",
        "Allies in a 10-foot Emanation originating from the fiend have Advantage on saving throws to avoid or end the Charmed condition.",
      )[0],
    ).toMatchObject({
      area: {
        grants: [{ kind: "advantage", on: "saves", conditions: ["charmed"] }],
      },
    });
    expect(
      parse(
        "Thinning",
        "Constitution Saving Throw: DC 12, each Bloodied creature in a 10-foot Emanation originating from the fiend at the end of the fiend’s turn. Failure: The target can’t regain Hit Points until the start of the fiend’s next turn.",
      )[0],
    ).toMatchObject({
      area: {
        bloodied: true,
        when: "ownerTurnEnd",
        resolution: {
          onFail: [
            {
              modifier: { kind: "noHealing" },
              duration: { until: "yourNextTurnStart" },
            },
          ],
        },
      },
    });
    expect(
      parse(
        "Spell Sink",
        "Constitution Saving Throw: DC 12, any creature that casts a spell while inside the fiend’s space. Failure: The spell fails and is wasted.",
      )[0],
    ).toMatchObject({ area: { foilsSpells: { ability: "con", dc: 12 } } });
    expect(
      parse(
        "Volatile",
        "When the fiend is subjected to Cold damage, each creature in a 5-foot Emanation originating from the fiend takes 3 (1d6) Cold damage.",
      )[0],
    ).toMatchObject({ kind: "damageBurst", damage: ["cold"], radius: 5 });
    expect(
      parse(
        "Rage",
        "At the end of each of the fiend’s turns, each creature of the fiend’s choice in a 10-foot Emanation originating from the fiend suffers the following effect. Wisdom Saving Throw: DC 12. Failure: The target takes a Reaction to make a melee attack roll against a creature within reach. If no creature is within reach, the target takes 3 (1d6) Psychic damage.",
      )[0],
    ).toMatchObject({
      area: {
        side: "enemy",
        when: "ownerTurnEnd",
        resolution: { dc: { base: 12 }, onFail: [{ kind: "forcedAttack" }] },
      },
    });
    const [clinging] = parse(
      "Clinging",
      "Spectral hands circle the fiend in a 5-foot Emanation originating from it. A creature that ends its turn in this area is subjected to the following effect. Charisma Saving Throw: DC 11. Failure: The target has the Charmed condition. While the creature is Charmed in this way, its Speed is reduced to 0. The target repeats the save at the end of each of its turns, ending the effect on itself on a success. After 1 minute, it succeeds automatically.",
    );
    expect(clinging).toMatchObject({
      radius: 5,
      area: {
        when: "turnEnd",
        resolution: {
          onFail: [
            { kind: "applyCondition", condition: "charmed", repeatSave: true },
            {
              modifier: { kind: "actionLimit", speed: "none" },
              repeatSave: true,
            },
          ],
        },
      },
    });
    expect(
      parse(
        "Fogborn",
        "While the fiend is in fog or mist, it has the Invisible condition. The fiend has the Incapacitated condition while it is outside an area of fog or mist.",
      )[0],
    ).toEqual({
      kind: "fogBound",
      inside: ["invisible"],
      outside: ["incapacitated"],
    });
  });

  it("reads damage as its turn ends, a burst where it dies, light it sheds, and sunlight it shuns", () => {
    expect(
      parse(
        "Embers",
        "At the end of each of the fiend’s turns, each creature in a 5-foot Emanation originating from the fiend takes 3 (1d6) Fire damage.",
      )[0],
    ).toMatchObject({ kind: "aura", area: { when: "ownerTurnEnd" } });
    expect(
      parse(
        "Pop",
        "The fiend explodes when it dies. Dexterity Saving Throw: DC 10, each creature in a 5-foot Emanation originating from the fiend. Failure: 3 (1d6) Fire damage. Success: Half damage.",
      )[0],
    ).toMatchObject({ kind: "deathBurst", radius: 5 });
    expect(
      parse(
        "Glow",
        "The fiend sheds Bright Light in a 10-foot radius and Dim Light for an additional 10 feet.",
      ).map((passive) => passive.kind === "aura" && passive.radius),
    ).toEqual([10, 20]);
    expect(
      parse(
        "Daylight Dread",
        "While in sunlight, the fiend has Disadvantage on D20 Tests.",
      )[0],
    ).toEqual({
      kind: "lightSensitive",
      light: "sunlight",
      disadvantage: ["attacks", "saves", "checks"],
      damage: [],
    });
  });
});

describe("reading slowing and bolstering auras", () => {
  const row = (name: string) =>
    `<tr><th>${name}</th><td>10</td><td>0</td><td>0</td></tr>`;
  const parse = (label: string, text: string) => {
    const [parsed] = parseMonstersFromHtml(
      `<div class="stat-block"><h3>Test Knight</h3><p>Medium Humanoid, Lawful Evil</p><p><strong>AC</strong> 18</p><p><strong>HP</strong> 60 (9d8)</p><p><strong>Speed</strong> 30 ft.</p><table>${["Str", "Dex", "Con", "Int", "Wis", "Cha"].map(row).join("")}</table><p class="monster-header">Traits</p><p><strong><em>${label}.</em></strong> ${text}</p><p class="monster-header">Actions</p><p><strong><em>Mace.</em></strong> Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.</p></div>`,
      "my-book",
    );
    return MonsterSchema.parse(parsed?.entry).passives;
  };

  it("reads halved Speeds as ground that slows its foes, and Temporary Hit Points for its allies of a kind", () => {
    expect(
      parse(
        "Mire",
        "Creatures in a 10-foot Emanation originating from the knight have their Speeds halved while in the Emanation.",
      )[0],
    ).toMatchObject({ kind: "aura", area: { side: "enemy", difficult: true } });
    expect(
      parse(
        "Tune-Up",
        "At the end of each of the knight’s turns, each of its Construct allies in a 5-foot Emanation originating from the knight gains 5 Temporary Hit Points.",
      )[0],
    ).toMatchObject({
      kind: "aura",
      area: {
        side: "ally",
        creatureTypes: ["construct"],
        when: "ownerTurnEnd",
      },
    });
  });
});

describe("areas on the move", () => {
  const feetTo = (
    run: RunContext,
    state: DndState,
    id: string,
    key: string,
  ): number | undefined => {
    const context = contextOf(run, state, LOW);
    const mover = actor(state, id);
    return moveSquares(mover, state, deriveStats(mover, context), context).find(
      (item) => `${String(item.square.x)},${String(item.square.y)}` === key,
    )?.feet;
  };

  it("makes a foe pay double inside an aura that halves its Speed", async () => {
    const run = await arena();
    const dread = fight(hero(run, 0, 2), monster("knight", "dread", 3, 3));
    const plain = fight(hero(run, 0, 2), monster("knight", "zombie", 3, 3));
    expect(feetTo(run, plain, PLAYER_ACTOR, "3,2")).toBe(15);
    expect(feetTo(run, dread, PLAYER_ACTOR, "3,2")).toBe(20);
  });

  it("bars the living from an Antilife Shell and lets the undead in", async () => {
    const run = await arena();
    const start = fight(
      hero(run, 6, 5),
      monster("zombie", "zombie", 0, 5),
      monster("living", "stinker", 0, 7),
    );
    const shelled = apply(start, [
      dndEvent(`${NS}:effectAdded`, {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: "spell:antilife",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "zone",
            zone: "area",
            at: { x: 6, y: 5 },
            radius: 10,
            follows: true,
            area: { barrier: true, exceptTypes: ["undead", "construct"] },
          },
          ends: "concentration",
        },
      }),
    ]);
    expect(feetTo(run, shelled, "zombie", "4,5")).toBe(20);
    expect(feetTo(run, shelled, "living", "4,7")).toBeUndefined();
  });

  it("waits out a seal that ends within a minute instead of calling the fight", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), monster("foe", "zombie", 1, 0));
    const sphere = apply(start, [
      dndEvent(`${NS}:effectAdded`, {
        actor: "foe",
        effect: {
          sourceId: "spell:sphere",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "sealed" },
          ends: "concentration",
          lasts: { actor: PLAYER_ACTOR, round: 11, at: "start" },
        },
      }),
    ]);
    const { events } = settle(run, sphere, [frameOf("checkCombatEnd")], LOW);
    expect(kinds(events)).not.toContain(`${NS}:combatEnded`);
  });
});
