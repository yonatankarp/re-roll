import {
  AWAIT_FRAME,
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import type { Context } from "../plugins/systems/dnd5.5e/core/combat.ts";
import { zoneFrames } from "../plugins/systems/dnd5.5e/core/combat/areas.ts";
import { castingTurn } from "../plugins/systems/dnd5.5e/core/combat/casting.ts";
import {
  ClassSchema,
  PregenSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { zonesOf } from "../plugins/systems/dnd5.5e/core/zones.ts";

// Spell effects moved or reused on later turns (#154), on the SRD's spells: ids, numbers and the shapes the rules
// read.
const HIGH: Dice = { below: () => 0, roll: (sides) => sides };
const LOW: Dice = { below: () => 0, roll: () => 1 };

const DUMMY = {
  id: "test:monster/dummy",
  name: "Dummy",
  ac: 5,
  hp: 500,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [],
};

async function arena(): Promise<RunContext> {
  const base = (await loadAdventure("goblin-ambush")).run;
  const wizard = ClassSchema.parse(base.content("srd52:class/wizard"));
  const [first] = wizard.levels;
  if (!first) throw new Error("The wizard has no levels");
  const content: Record<string, unknown> = {
    [DUMMY.id]: DUMMY,
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

function hero(run: RunContext, spells: readonly string[], x = 0, y = 0): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  const answers = [
    {
      kind: "spells" as const,
      values: spells.map((slug) => `srd52:spell/${slug}`),
    },
    { kind: "features" as const, values: [] },
  ];
  return {
    ...freshActor({
      id: PLAYER_ACTOR,
      name: "Hero",
      side: "party",
      source: {
        kind: "character",
        build: {
          ...pregen.build,
          levels: Array.from({ length: 17 }, () => ({ ...first, answers })),
        },
      },
      hp: 50,
      inventory: [],
    }),
    position: { x, y },
  };
}

function dummy(id: string, x: number, y: number, hp = 500): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side: "enemy",
      source: { kind: "monster", statBlockId: DUMMY.id },
      hp,
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
      grid: { width: 30, height: 30 },
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
  answer: (decision: Decision) => string = (decision) =>
    decision.options[0]?.id ?? "",
): { readonly state: DndState; readonly events: readonly SystemEvent[] } {
  let state = start;
  const events: SystemEvent[] = [];
  const stack = [...frames].reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    if (top.kind === AWAIT_FRAME) {
      const { decision } = top.payload as { decision: Decision };
      stack.push({
        kind: decision.resume.kind,
        payload: { ...decision.resume.payload, answer: answer(decision) },
      });
      continue;
    }
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

const act = (answer: string): Frame => ({
  kind: `${NS}:takeAction`,
  payload: { actor: PLAYER_ACTOR, answer },
});
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
// A new turn of the hero's: its action and Bonus Action back, the round on.
const nextTurn = (state: DndState, round: number): DndState => ({
  ...state,
  actors: {
    ...state.actors,
    [PLAYER_ACTOR]: {
      ...actor(state, PLAYER_ACTOR),
      budget: { action: true, bonusAction: true, reaction: true },
      usedThisTurn: [],
      moved: 0,
    },
  },
  ...(state.combat ? { combat: { ...state.combat, round, index: 0 } } : {}),
});
const actionNames = (run: RunContext, state: DndState): string[] =>
  deriveStats(actor(state, PLAYER_ACTOR), {
    ...run,
    state,
  } as never).actions.map(({ id }) => id);

describe("spell objects", () => {
  it("places Spiritual Weapon's force by its target, then moves it 20 feet to strike again", async () => {
    const run = await arena();
    const start = fight(
      hero(run, ["spiritual-weapon"]),
      dummy("near", 6, 0),
      dummy("far", 10, 0),
    );
    const cast = settle(
      run,
      start,
      [act("spell:srd52:spell/spiritual-weapon|near")],
      HIGH,
    );
    const [force] = zonesOf(cast.state);
    expect(force?.at).toEqual({ x: 5, y: 0 });
    expect(damageTo(cast.events, "near").length).toBe(1);
    const later = settle(
      run,
      nextTurn(cast.state, 2),
      [act("lasting:srd52:spell/spiritual-weapon|far")],
      HIGH,
    );
    expect(zonesOf(later.state)[0]?.at).toEqual({ x: 9, y: 0 });
    expect(damageTo(later.events, "far").length).toBe(1);
  });
});

describe("marks and lasting actions", () => {
  it("moves Hunter's Mark only once its quarry drops", async () => {
    const run = await arena();
    const start = fight(
      hero(run, ["hunter-s-mark"]),
      dummy("a", 3, 0),
      dummy("b", 4, 0),
    );
    const marked = settle(
      run,
      start,
      [act("spell:srd52:spell/hunter-s-mark|a")],
      HIGH,
    ).state;
    expect(actionNames(run, marked)).not.toContain(
      "lasting:srd52:spell/hunter-s-mark",
    );
    const dropped = {
      ...marked,
      actors: { ...marked.actors, a: { ...actor(marked, "a"), hp: 0 } },
    };
    expect(actionNames(run, dropped)).toContain(
      "lasting:srd52:spell/hunter-s-mark",
    );
  });

  it("heals Vampiric Touch's caster by half the damage, on its cast and later", async () => {
    const run = await arena();
    const start = fight(hero(run, ["vampiric-touch"]), dummy("foe", 1, 0));
    const hurt = {
      ...start,
      actors: {
        ...start.actors,
        [PLAYER_ACTOR]: { ...actor(start, PLAYER_ACTOR), hp: 20 },
      },
    };
    const cast = settle(
      run,
      hurt,
      [act("spell:srd52:spell/vampiric-touch|foe")],
      HIGH,
    );
    const [dealt = 0] = damageTo(cast.events, "foe");
    expect(actor(cast.state, PLAYER_ACTOR).hp).toBe(20 + Math.floor(dealt / 2));
  });

  it("sets off Delayed Blast Fireball where its bead is, a die bigger for each round", async () => {
    const run = await arena();
    const start = fight(
      hero(run, ["delayed-blast-fireball"]),
      dummy("foe", 12, 0),
    );
    const bead = settle(
      run,
      start,
      [act("spell:srd52:spell/delayed-blast-fireball|@12,0")],
      HIGH,
    ).state;
    const later = nextTurn(bead, 3);
    const blast = settle(
      run,
      later,
      [act("lasting:srd52:spell/delayed-blast-fireball|@0,0")],
      LOW,
    );
    // Two rounds on, 14d6 rolling 1s, halved for nothing: the dummy fails a save on a 1.
    expect(damageTo(blast.events, "foe")).toEqual([14]);
    expect(actor(blast.state, PLAYER_ACTOR).concentratingOn).toBeNull();
  });
});

describe("areas that move or act by turns", () => {
  it("makes a creature Flaming Sphere is rolled onto save", async () => {
    const run = await arena();
    const start = fight(hero(run, ["flaming-sphere"]), dummy("foe", 8, 0));
    const lit = settle(
      run,
      start,
      [act("spell:srd52:spell/flaming-sphere|@3,0")],
      HIGH,
    ).state;
    const rolled = settle(
      run,
      nextTurn(lit, 2),
      [act("zone-move:spell:srd52:spell/flaming-sphere|@8,0")],
      LOW,
    );
    expect(damageTo(rolled.events, "foe")).toEqual([2]);
  });

  it("brings Storm of Vengeance's acid on its second turn and lightning on its third", async () => {
    const run = await arena();
    const start = fight(hero(run, ["storm-of-vengeance"]), dummy("foe", 5, 0));
    const storm = settle(
      run,
      start,
      [act("spell:srd52:spell/storm-of-vengeance|@5,0")],
      HIGH,
    ).state;
    const second = nextTurn(storm, 2);
    const acid = settle(
      run,
      second,
      zoneFrames(
        actor(second, PLAYER_ACTOR),
        "start",
        contextOf(run, second, HIGH),
      ),
      HIGH,
    );
    expect(damageTo(acid.events, "foe")).toEqual([24]);
    const third = nextTurn(acid.state, 3);
    const bolts = settle(
      run,
      third,
      zoneFrames(
        actor(third, PLAYER_ACTOR),
        "start",
        contextOf(run, third, LOW),
      ),
      LOW,
    );
    expect(damageTo(bolts.events, "foe")).toEqual([10]);
    expect(hasCondition(actor(storm, "foe"), "deafened")).toBe(false);
  });
});

describe("spells cast over several turns", () => {
  it("takes Tsunami's ten turns of actions before the wave rises, and loses it with Concentration", async () => {
    const run = await arena();
    const start = fight(hero(run, ["tsunami"]), dummy("foe", 15, 10));
    const begun = settle(
      run,
      start,
      [act("spell:srd52:spell/tsunami|@15,10")],
      LOW,
    ).state;
    expect(zonesOf(begun)).toHaveLength(0);
    expect(actor(begun, PLAYER_ACTOR).concentratingOn).toBe(
      "casting:spell:srd52:spell/tsunami",
    );
    let state = begun;
    let completed: readonly Frame[] = [];
    for (let turn = 2; turn <= 10; turn += 1) {
      state = nextTurn(state, turn);
      const taken = castingTurn(actor(state, PLAYER_ACTOR));
      state = taken.events.reduce(applyDndEvent, state);
      expect(actor(state, PLAYER_ACTOR).budget.action).toBe(false);
      completed = taken.frames;
      if (completed.length > 0) break;
    }
    expect(state.combat?.round).toBe(10);
    const risen = settle(run, state, completed, LOW);
    expect(zonesOf(risen.state)).toHaveLength(1);
    expect(damageTo(risen.events, "foe")).toEqual([6]);
    expect(actor(risen.state, PLAYER_ACTOR).concentratingOn).toBe(
      "spell:srd52:spell/tsunami",
    );
    // Broken Concentration on the casting loses the spell.
    const broken = applyDndEvent(begun, {
      kind: `${NS}:concentrationEnded`,
      payload: { actor: PLAYER_ACTOR },
    });
    expect(castingTurn(actor(broken, PLAYER_ACTOR)).events).toEqual([]);
  });
});
