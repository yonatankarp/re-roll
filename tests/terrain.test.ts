import { type Frame, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import type { Context } from "../plugins/systems/dnd5.5e/core/combat.ts";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { teleportSquares } from "../plugins/systems/dnd5.5e/core/combat/movement.ts";
import {
  groundFor,
  moveSquares,
  walledApart,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { zoneFrames } from "../plugins/systems/dnd5.5e/core/combat/areas.ts";
import {
  ClassSchema,
  PregenSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { seeing } from "../plugins/systems/dnd5.5e/core/sight.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  frame,
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  exhaustionOf,
  type KnownAction,
  lookup,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  blockedSquares,
  placedConditionEvents,
  zonesOf,
} from "../plugins/systems/dnd5.5e/core/zones.ts";

// Terrain, walls and areas (#159), on the SRD's spells and made-up ones: ids, numbers and the shapes the rules read.
const LOW: Dice = { below: () => 0, roll: () => 1 };
const HIGH: Dice = { below: () => 0, roll: (sides) => sides };

const BRUTE = {
  id: "test:monster/brute",
  name: "brute",
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
    {
      name: "Bow",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 80, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", flatBonus: 4 },
          damage: [{ amount: { dice: "1d6" }, type: "piercing" }],
        },
      },
    },
  ],
};

async function arena(): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const wizard = ClassSchema.parse(base.content("srd52:class/wizard"));
  const [first] = wizard.levels;
  if (!first) throw new Error("The wizard has no levels");
  const content: Record<string, unknown> = {
    [BRUTE.id]: BRUTE,
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

function hero(run: RunContext, x: number, y: number): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "hero",
      side: "party",
      source: { kind: "character", build: pregen.build },
      hp: 100,
      inventory: [],
    }),
    position: { x, y },
  };
}

function brute(id: string, x: number, y: number): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: BRUTE.id },
      hp: 500,
      inventory: [],
    }),
    position: { x, y },
  };
}

function fight(...actors: readonly Actor[]): DndState {
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      grid: { width: 20, height: 20 },
    },
  };
}

const contextOf = (run: RunContext, state: DndState, dice: Dice): Context => ({
  state,
  dice,
  content: run.content,
  contentIds: run.contentIds,
});

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

const actor = (state: DndState, id: string): Actor => {
  const found = state.actors[id];
  if (!found) throw new Error(`No actor ${id}`);
  return found;
};
const damageTo = (events: readonly SystemEvent[], id: string): number[] =>
  events.flatMap((event) =>
    event.kind === `${NS}:damaged` && event.payload.actor === id
      ? [Number(event.payload.amount)]
      : [],
  );

// An SRD spell as its caster knows it.
const srd = (run: RunContext, name: string): KnownAction => {
  const spell = lookup(run, SpellSchema, `srd52:spell/${name}`);
  if (!spell.activation) throw new Error(`${name} has no activation`);
  return {
    id: `spell:srd52:spell/${name}`,
    name: spell.name,
    activation: spell.activation,
    spellLevel: spell.level,
  };
};

const made = (name: string, activation: unknown): KnownAction => ({
  id: `spell:test:spell/${name}`,
  name,
  activation: activation as KnownAction["activation"],
  spellLevel: 3,
});

// Cast `action` by the hero at `aim`, rolling `dice`, and fold what it does.
function cast(
  run: RunContext,
  state: DndState,
  action: KnownAction,
  aim: { x: number; y: number },
  dice: Dice = HIGH,
  targets: readonly Actor[] = [],
): DndState {
  const result = resolveAction(
    action,
    actor(state, PLAYER_ACTOR),
    targets,
    contextOf(run, state, dice),
    action.spellLevel ?? undefined,
    false,
    aim,
  );
  return settle(
    run,
    (result.events ?? []).reduce(applyDndEvent, state),
    result.frames ?? [],
    dice,
  ).state;
}

const turnOf = (state: DndState, index: number): DndState =>
  state.combat ? { ...state, combat: { ...state.combat, index } } : state;

const withEffect = (item: Actor, effect: ActiveEffect): Actor => ({
  ...item,
  activeEffects: [...item.activeEffects, effect],
});

describe("terrain spells make", () => {
  it("turns Grease's ground into Difficult Terrain and knocks a walker Prone", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 2, 6));
    const greased = turnOf(
      cast(run, start, srd(run, "grease"), { x: 6, y: 6 }),
      1,
    );
    const foe = actor(greased, "foe");
    expect(groundFor(foe, greased, run).terrain.has("6,6")).toBe(true);
    const walked = settle(
      run,
      greased,
      [frame("move", { actor: "foe", answer: "6,6" })],
      LOW,
    );
    expect(hasCondition(actor(walked.state, "foe"), "prone")).toBe(true);
  });

  it("makes Plant Growth's ground cost 4 feet for each foot", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 10, 10));
    const grown = cast(run, start, srd(run, "plant-growth"), { x: 10, y: 10 });
    const foe = actor(grown, "foe");
    const reach = moveSquares(foe, grown, deriveStats(foe, run), run);
    const far = Math.max(...reach.map(({ square }) => Math.abs(square.x - 10)));
    expect(far).toBe(1);
  });

  it("lets Winter Strider cross a spell's ice freely", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 10, 10));
    const iced = cast(run, start, srd(run, "ice-storm"), { x: 10, y: 10 });
    const foe = actor(iced, "foe");
    expect(groundFor(foe, iced, run).terrain.has("10,10")).toBe(true);
    const strider = withEffect(foe, {
      sourceId: "item:test",
      casterId: "foe",
      modifier: { kind: "unhindered", ice: true },
      ends: "spellDuration",
    });
    const state = { ...iced, actors: { ...iced.actors, foe: strider } };
    expect(groundFor(strider, state, run).terrain.has("10,10")).toBe(false);
  });

  it("burns Web away with fire, freeing those it held and burning those in it", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 6, 6));
    const webbed = cast(run, start, srd(run, "web"), { x: 6, y: 6 }, LOW, [
      actor(start, "foe"),
    ]);
    expect(hasCondition(actor(webbed, "foe"), "restrained")).toBe(true);
    const fire = made("Spark", {
      cost: ["action"],
      targeting: { creatures: 1, range: 120, side: "enemy" },
      resolution: {
        kind: "automatic",
        damage: [{ amount: { bonus: { base: 3, add: [] } }, type: "fire" }],
        effects: [],
      },
    });
    const burnt = cast(run, webbed, fire, { x: 6, y: 6 }, HIGH, [
      actor(webbed, "foe"),
    ]);
    expect(hasCondition(actor(burnt, "foe"), "restrained")).toBe(false);
    expect(zonesOf(burnt).length).toBe(0);
    expect(actor(burnt, "foe").hp).toBe(500 - 3 - 8);
  });
});

describe("walls and their shapes", () => {
  it("raises a line of wall across the aim that hides but doesn't stop a walk", async () => {
    const run = await arena();
    const start = fight(hero(run, 10, 2), brute("foe", 10, 14));
    const sand = made("Sand", {
      cost: ["action", "slot"],
      targeting: {
        area: { shape: "wall", radius: 30 },
        range: 90,
        side: "enemy",
      },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [
          {
            kind: "zone",
            zone: "wall",
            shape: "line",
            radius: 30,
            walls: "sight",
            bare: true,
            duration: { concentration: true, minutes: 10 },
          },
          {
            kind: "zone",
            zone: "area",
            shape: "line",
            radius: 30,
            duration: { concentration: true, minutes: 10 },
          },
        ],
      },
      area: { conditions: ["blinded"], cost: 3 },
    });
    const walled = cast(run, start, sand, { x: 10, y: 8 });
    const sight = blockedSquares(walled, "sight");
    expect(sight).toContain("10,8");
    expect(sight).toContain("8,8");
    expect(sight).toContain("12,8");
    expect(sight).not.toContain("10,9");
    expect(blockedSquares(walled, "walking")).not.toContain("10,8");
    const inside = {
      ...walled,
      actors: {
        ...walled.actors,
        foe: { ...actor(walled, "foe"), position: { x: 10, y: 8 } },
      },
    };
    const placed = placedConditionEvents(inside).reduce(applyDndEvent, inside);
    expect(hasCondition(actor(placed, "foe"), "blinded")).toBe(true);
  });

  it("turns ranged weapon attacks aside past Wind Wall, but not a club next to it", async () => {
    const run = await arena();
    const start = fight(
      hero(run, 10, 2),
      brute("foe", 10, 14),
      brute("near", 9, 2),
    );
    const walled = cast(run, start, srd(run, "wind-wall"), { x: 10, y: 8 });
    const stats = deriveStats(actor(walled, "foe"), run);
    const bow = stats.actions.find(({ name }) => name === "Bow");
    const club = deriveStats(actor(walled, "near"), run).actions.find(
      ({ name }) => name === "Club",
    );
    if (!bow || !club) throw new Error("no weapons");
    const target = actor(walled, PLAYER_ACTOR);
    expect(walledApart(actor(walled, "foe"), target, bow, walled, run)).toBe(
      true,
    );
    expect(walledApart(actor(walled, "near"), target, club, walled, run)).toBe(
      false,
    );
  });

  it("keeps a creature from reaching through Antilife Shell but with a Reach weapon", async () => {
    const run = await arena();
    const start = fight(hero(run, 10, 10), brute("foe", 13, 10));
    const shelled = cast(run, start, srd(run, "antilife-shell"), {
      x: 10,
      y: 10,
    });
    const near = { ...actor(shelled, "foe"), position: { x: 13, y: 10 } };
    const ally = { ...hero(run, 12, 10), id: "ally" };
    const state = {
      ...shelled,
      actors: { ...shelled.actors, foe: near, ally },
    };
    const club = deriveStats(near, run).actions.find(
      ({ name }) => name === "Club",
    );
    if (!club) throw new Error("no club");
    expect(walledApart(near, ally, club, state, run)).toBe(true);
  });
});

describe("areas that act", () => {
  it("acts each of a spell's areas on its own, as Hunger of Hadar's cold and acid", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 6, 6));
    const hunger = made("Hunger", {
      cost: ["action", "slot"],
      targeting: {
        area: { shape: "sphere", radius: 10 },
        range: 150,
        side: "enemy",
      },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [
          {
            kind: "zone",
            zone: "darkness",
            radius: 10,
            part: 0,
            duration: { concentration: true, minutes: 1 },
          },
          {
            kind: "zone",
            zone: "area",
            radius: 10,
            part: 1,
            duration: { concentration: true, minutes: 1 },
          },
        ],
      },
      areas: [
        {
          conditions: ["blinded"],
          when: "turnStart",
          resolution: {
            kind: "automatic",
            damage: [{ amount: { bonus: { base: 4 } }, type: "cold" }],
            effects: [],
          },
        },
        {
          when: "turnEnd",
          resolution: {
            kind: "automatic",
            damage: [{ amount: { bonus: { base: 6 } }, type: "acid" }],
            effects: [],
          },
        },
      ],
    });
    const dark = turnOf(cast(run, start, hunger, { x: 6, y: 6 }), 1);
    const foe = actor(dark, "foe");
    const started = settle(
      run,
      dark,
      zoneFrames(foe, "start", contextOf(run, dark, LOW)),
      LOW,
    );
    expect(damageTo(started.events, "foe")).toEqual([4]);
    const ended = settle(
      run,
      started.state,
      zoneFrames(
        actor(started.state, "foe"),
        "end",
        contextOf(run, started.state, LOW),
      ),
      LOW,
    );
    expect(damageTo(ended.events, "foe")).toEqual([6]);
  });

  it("ends an area once it has acted as many times as it has uses, as Cordon of Arrows", async () => {
    const run = await arena();
    const start = fight(
      hero(run, 0, 0),
      brute("a", 2, 0),
      brute("b", 3, 0),
      brute("c", 4, 0),
    );
    const cordon = made("Cordon", {
      cost: ["action", "slot"],
      targeting: { self: true },
      resolution: {
        kind: "automatic",
        damage: [],
        effects: [
          {
            kind: "zone",
            zone: "area",
            radius: 30,
            duration: { minutes: 480 },
          },
        ],
      },
      area: {
        side: "enemy",
        when: "turnEnd",
        uses: 2,
        resolution: {
          kind: "automatic",
          damage: [{ amount: { bonus: { base: 2 } }, type: "piercing" }],
          effects: [],
        },
      },
    });
    let state = cast(run, start, cordon, { x: 0, y: 0 });
    const dealt: number[] = [];
    for (const id of ["a", "b", "c"]) {
      const after = settle(
        run,
        state,
        zoneFrames(actor(state, id), "end", contextOf(run, state, LOW)),
        LOW,
      );
      dealt.push(...damageTo(after.events, id));
      state = after.state;
    }
    expect(dealt).toEqual([2, 2]);
    expect(zonesOf(state).length).toBe(0);
  });

  it("opens a fissure under a foe Earthquake catches, which it falls into", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 10, 10));
    const shaken = cast(
      run,
      start,
      srd(run, "earthquake"),
      { x: 10, y: 10 },
      LOW,
      [actor(start, "foe")],
    );
    const foe = actor(shaken, "foe");
    expect(foe.hp).toBeLessThan(500);
    expect(hasCondition(foe, "prone")).toBe(true);
    expect(
      foe.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "actionLimit" && modifier.speed === "none",
      ),
    ).toBe(true);
  });

  it("lowers a foe's Speed only while it stands in the area, as Grasping Mist", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 6, 6));
    const mist = made("Mist", {
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
          { kind: "zone", zone: "area", radius: 10, duration: { minutes: 1 } },
        ],
      },
      area: {
        side: "enemy",
        places: [
          {
            kind: "bonus",
            to: "speed",
            amount: { bonus: { base: 5 } },
            subtract: true,
          },
        ],
      },
    });
    const misted = cast(run, start, mist, { x: 6, y: 6 });
    const placed = placedConditionEvents(misted).reduce(applyDndEvent, misted);
    expect(deriveStats(actor(placed, "foe"), run).speed).toBe(25);
    const away = {
      ...placed,
      actors: {
        ...placed.actors,
        foe: { ...actor(placed, "foe"), position: { x: 18, y: 18 } },
      },
    };
    const left = placedConditionEvents(away).reduce(applyDndEvent, away);
    expect(deriveStats(actor(left, "foe"), run).speed).toBe(30);
  });

  it("keeps teleports out of an Antimagic Field", async () => {
    const run = await arena();
    const start = fight(hero(run, 10, 10), brute("foe", 18, 18));
    const field = cast(run, start, srd(run, "antimagic-field"), {
      x: 10,
      y: 10,
    });
    const inside = actor(field, PLAYER_ACTOR);
    expect(teleportSquares(inside, 30, 0, field, run)).toEqual([]);
    const outside = actor(field, "foe");
    expect(
      teleportSquares(outside, 30, 0, field, run).some(
        ({ x, y }) => Math.max(Math.abs(x - 10), Math.abs(y - 10)) <= 2,
      ),
    ).toBe(false);
  });

  it("is seen only dimly through Insect Plague's swarm, and counts a spell's Exhaustion while it lasts", async () => {
    const run = await arena();
    const start = fight(hero(run, 0, 0), brute("foe", 6, 6));
    const swarm = cast(run, start, srd(run, "insect-plague"), { x: 6, y: 6 });
    expect(seeing(actor(swarm, PLAYER_ACTOR), { x: 6, y: 6 }, swarm, run)).toBe(
      "dim",
    );
    const tired = withEffect(actor(swarm, "foe"), {
      sourceId: "spell:test:spell/radiance",
      casterId: PLAYER_ACTOR,
      modifier: { kind: "exhausted", levels: 1 },
      ends: "spellDuration",
    });
    expect(exhaustionOf(tired)).toBe(1);
    expect(deriveStats(tired, run).speed).toBe(25);
  });
});
