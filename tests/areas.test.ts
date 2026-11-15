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
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type KnownAction,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { walkSpeed } from "../plugins/systems/dnd5.5e/core/tactics.ts";
import {
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
    const squares = moveSquares(me, walled, deriveStats(me, context)).map(
      (item) => `${String(item.square.x)},${String(item.square.y)}`,
    );
    expect(squares).not.toContain("4,5");
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
