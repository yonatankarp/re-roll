import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { SystemEvent } from "../engine/kernel/events.ts";
import { createSave, loadSave } from "../engine/run/save.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { playRun } from "../engine/tools/bot.ts";
import {
  choosePolicy,
  nextDndDecision,
} from "../plugins/systems/dnd5.5e/core/combat.ts";
import { stepToward } from "../plugins/systems/dnd5.5e/core/policy.ts";
import {
  MOVE,
  parseOption,
} from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { startCombat } from "../plugins/systems/dnd5.5e/core/combat/start.ts";
import {
  fogged,
  knownFoes,
  partySight,
  revealedSquares,
  withReveal,
} from "../plugins/systems/dnd5.5e/core/fog.ts";
import {
  BattlemapSchema,
  PregenSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { darkvisionOf } from "../plugins/systems/dnd5.5e/core/sight.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
  dndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { dndCue } from "../plugins/systems/dnd5.5e/ui/cues.ts";

// Fog of war (core/fog.ts): what the party has seen of a battle map, and what its side knows of the foes.

const base = async (): Promise<RunContext> =>
  (await loadAdventure("goblin-ambush")).run;

function hero(run: RunContext, id = PLAYER_ACTOR): Actor {
  const pregen = PregenSchema.parse(run.content("srd52:pregen/wizard"));
  const [first] = pregen.build.levels;
  if (!first) throw new Error("The pregen has no levels");
  const actor = freshActor({
    id,
    name: id,
    side: "party",
    source: {
      kind: "character",
      build: {
        ...pregen.build,
        levels: [
          {
            ...first,
            answers: [
              { kind: "spells", values: ["srd52:spell/fire-bolt"] },
              { kind: "features", values: [] },
            ],
          },
        ],
      },
    },
    hp: 1,
    inventory: [],
  });
  return { ...actor, hp: deriveStats(actor, run).maxHp };
}

// The same fight as an older save has it, with no fog.
function unfogged(state: DndState): DndState {
  if (!state.combat) return state;
  const combat = { ...state.combat };
  delete combat.fog;
  return { ...state, combat };
}

// Two rooms split by a wall, joined only by a gap in its top row. Walled along the bottom too, since a line
// along the map's open edge passes (grid.ts).
const ROOMS = [
  ".........",
  "....#....",
  "....#....",
  "....#....",
  "#########",
] as const;

function battlemap(
  rows: readonly string[],
  {
    cropX = 0,
    party = [[0, 3]],
    monsters = [[7, 3]],
  }: {
    readonly cropX?: number;
    readonly party?: readonly (readonly [number, number])[];
    readonly monsters?: readonly (readonly [number, number])[];
  } = {},
) {
  return BattlemapSchema.parse({
    image: "assets/dungeon.png",
    imageWidth: 5000,
    imageHeight: 1000,
    crop: {
      x: cropX,
      y: 0,
      width: (rows[0]?.length ?? 1) * 100,
      height: rows.length * 100,
    },
    columns: rows[0]?.length ?? 1,
    rows: rows.length,
    walls: rows,
    party,
    monsters,
  });
}

// A fight started the way the system starts one, its reveal included.
function started(
  run: RunContext,
  actors: readonly Actor[],
  map: ReturnType<typeof battlemap>,
  before: Partial<DndState> = {},
): DndState {
  const state: DndState = {
    ...before,
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: null,
  };
  const context = {
    state,
    dice: createDice(rngFromSeed("fog")),
    content: run.content,
    contentIds: run.contentIds,
  };
  const result = withReveal(
    startCombat(
      {
        id: "cellar",
        monsters: [{ monster: "srd52:monster/goblin-warrior", count: 1 }],
        battlemap: map,
      },
      context,
      { canFlee: false, defeatContinues: false },
    ),
    context,
  );
  return (result.events ?? []).reduce(applyDndEvent, state);
}

// Moves a creature as a step of the fight does, with the reveal the step adds.
function step(
  run: RunContext,
  state: DndState,
  events: SystemEvent[],
): DndState {
  const result = withReveal(
    { events },
    {
      state,
      dice: createDice(rngFromSeed("fog")),
      content: run.content,
      contentIds: run.contentIds,
    },
  );
  return (result.events ?? []).reduce(applyDndEvent, state);
}

const moved = (actor: string, x: number, y: number): SystemEvent =>
  dndEvent(`${NS}:moved`, { actor, to: { x, y }, feet: 0 });

const foeId = "cellar:goblin-warrior-1";

describe("fog of war", () => {
  it("covers what the party can't see past a wall, and keeps the wall's near side", async () => {
    const run = await base();
    const state = started(run, [hero(run)], battlemap(ROOMS));
    expect(fogged(state)).toBe(true);
    const sight = partySight(state, run);
    expect(sight.squares.has("0,3")).toBe(true);
    expect(sight.squares.has("4,2")).toBe(true); // the wall itself
    expect(sight.squares.has("7,3")).toBe(false);
    expect(sight.foes.has(foeId)).toBe(false);
    // What was seen is in the state, from the step's own event.
    expect(revealedSquares(state)?.has("2,2")).toBe(true);
    expect(revealedSquares(state)?.has("7,3")).toBe(false);
  });

  it("keeps a square revealed after no one sees it, and shows a foe only while it's seen", async () => {
    const run = await base();
    let state = started(run, [hero(run)], battlemap(ROOMS));
    state = step(run, state, [moved(PLAYER_ACTOR, 5, 0)]);
    expect(partySight(state, run).foes.has(foeId)).toBe(true);
    expect(revealedSquares(state)?.has("7,3")).toBe(true);
    state = step(run, state, [moved(PLAYER_ACTOR, 0, 3)]);
    expect(partySight(state, run).squares.has("7,3")).toBe(false);
    expect(revealedSquares(state)?.has("7,3")).toBe(true);
    expect(partySight(state, run).foes.has(foeId)).toBe(false);
  });

  it("reveals what a walk passes, not only where it stops", async () => {
    const run = await base();
    // A corridor with an alcove off it, seen only from in front of it.
    const corridor = [
      "###.######",
      "###.######",
      "###.######",
      "..........",
      "##########",
    ];
    let state = started(
      run,
      [hero(run)],
      battlemap(corridor, { party: [[0, 3]], monsters: [[9, 3]] }),
    );
    expect(revealedSquares(state)?.has("3,0")).toBe(false);
    state = step(run, state, [
      dndEvent(`${NS}:moved`, {
        actor: PLAYER_ACTOR,
        to: { x: 6, y: 3 },
        feet: 30,
      }),
    ]);
    expect(partySight(state, run).squares.has("3,0")).toBe(false);
    expect(revealedSquares(state)?.has("3,0")).toBe(true);
  });

  it("hides a foe in darkness beyond the party's darkvision, and shows one within it", async () => {
    const run = await base();
    const wizard = hero(run);
    const feet = darkvisionOf(wizard, run);
    const dark = ["x".repeat(30), "x".repeat(30)];
    const near = started(
      run,
      [wizard],
      battlemap(dark, { party: [[0, 0]], monsters: [[2, 0]] }),
    );
    expect(partySight(near, run).foes.has(foeId)).toBe(feet >= 10);
    const far = started(
      run,
      [wizard],
      battlemap(dark, { party: [[0, 0]], monsters: [[feet / 5 + 3, 0]] }),
    );
    expect(partySight(far, run).foes.has(foeId)).toBe(false);
  });

  it("remembers a picture's squares in a later fight on another crop of it", async () => {
    const run = await base();
    const first = started(run, [hero(run)], battlemap(ROOMS));
    const after = applyDndEvent(first, dndEvent(`${NS}:combatEnded`, {}));
    // The same picture cropped one square to the right: its square 1,2 is the first fight's 2,2.
    const second = started(
      run,
      Object.values(after.actors).filter((item) => item.side === "party"),
      battlemap(ROOMS, { cropX: 100, party: [[8, 3]] }),
      { revealed: after.revealed },
    );
    expect(revealedSquares(second)?.has("1,2")).toBe(true);
  });

  it("starts an older save's fight, which has no fog, with everything known", async () => {
    const run = await base();
    const state = started(run, [hero(run)], battlemap(ROOMS));
    const old = unfogged(state);
    expect(fogged(old)).toBe(false);
    expect(revealedSquares(old)).toBeNull();
    const wizard = old.actors[PLAYER_ACTOR];
    if (!wizard) throw new Error("No hero");
    expect(knownFoes(old, wizard, run).map((item) => item.id)).toEqual([foeId]);
  });
});

describe("what the party knows in the fog", () => {
  it("goes looking for a foe it hasn't found rather than straight at it, and goes for it once seen", async () => {
    const run = await base();
    // A pocket to the west, and the goblin round the bend to the east.
    const halls = [
      "#############",
      "#...#.......#",
      "#.#.#.#####.#",
      "#.#...#.....#",
      "#############",
    ];
    const state = started(
      run,
      [hero(run)],
      battlemap(halls, { party: [[3, 3]], monsters: [[10, 3]] }),
    );
    const context = (now: DndState) => ({
      state: now,
      dice: createDice(rngFromSeed("fog")),
      content: run.content,
      contentIds: run.contentIds,
    });
    const choose = (now: DndState): string => {
      const decision = nextDndDecision(now, run);
      if (!decision) throw new Error("No decision");
      return choosePolicy(decision, context(now));
    };
    const wizard = state.actors[PLAYER_ACTOR];
    if (!wizard || !state.combat) throw new Error("No fight");
    const yours = {
      ...state,
      combat: { ...state.combat, order: [PLAYER_ACTOR, foeId], index: 0 },
    };
    expect(knownFoes(yours, wizard, run)).toEqual([]);
    expect(choose(yours)).not.toContain(foeId);
    // It searches the nearest place it hasn't seen, the pocket to the west.
    expect(choose(yours)).toBe(MOVE);
    expect(stepToward(wizard, context(yours))?.x).toBeLessThan(3);
    // Knowing where the goblin is, the same party would head east for it.
    expect(stepToward(wizard, context(unfogged(yours)))?.x).toBeGreaterThan(3);
    // The monsters, as the DM, know where the party is.
    const goblinActor = yours.actors[foeId];
    if (!goblinActor) throw new Error("No goblin");
    expect(knownFoes(yours, goblinActor, run).map((item) => item.id)).toEqual([
      PLAYER_ACTOR,
    ]);
    // Once it stands in sight, it's fair game.
    const seen = applyDndEvent(yours, moved(foeId, 5, 1));
    expect(choose(seen)).toContain(foeId);
  });

  it("offers no attack on a foe the party can't see, though nothing covers it", async () => {
    const run = await base();
    const wizard = hero(run);
    const feet = darkvisionOf(wizard, run);
    const state = started(
      run,
      [wizard],
      battlemap(["x".repeat(30), "x".repeat(30)], {
        party: [[0, 0]],
        monsters: [[feet / 5 + 3, 0]],
      }),
    );
    if (!state.combat) throw new Error("No fight");
    const yours = {
      ...state,
      combat: { ...state.combat, order: [PLAYER_ACTOR, foeId], index: 0 },
    };
    const named = (now: DndState): boolean =>
      (nextDndDecision(now, run)?.options ?? []).some(
        (option) =>
          option.label.includes(foeId) ||
          parseOption(option.id).includes(foeId),
      );
    expect(named(yours)).toBe(false);
    expect(named(unfogged(yours))).toBe(true);
  });
});

describe("the board in the fog", () => {
  it("doesn't animate a foe the party can't see, before or after", async () => {
    const run = await base();
    const state = started(run, [hero(run)], battlemap(ROOMS));
    const walk = moved(foeId, 8, 3);
    const after = applyDndEvent(state, walk);
    expect(dndCue(walk, state, after, run)).toBeNull();
    // Stepping into sight shows the step.
    const into = moved(foeId, 3, 0);
    expect(dndCue(into, state, applyDndEvent(state, into), run)).toEqual({
      kind: "move",
      actor: foeId,
      x: 3,
      y: 0,
    });
    const own = moved(PLAYER_ACTOR, 1, 3);
    expect(dndCue(own, state, applyDndEvent(state, own), run)).not.toBeNull();
  });
});

describe("fog in saves", () => {
  it("folds what was seen from the save's own events, the same as live play", async () => {
    const plain = await base();
    const encounters = plain.adventure.encounters.map((encounter) => ({
      ...encounter,
      battlemap: battlemap(ROOMS, {
        party: [
          [0, 3],
          [1, 3],
          [0, 2],
          [1, 2],
        ],
        monsters: [
          [7, 3],
          [8, 3],
          [7, 2],
        ],
      }),
    }));
    const run: RunContext = {
      ...plain,
      adventure: { ...plain.adventure, encounters },
    };
    const played = playRun(run, "fog-save", { maxDecisions: 400, smart: true });
    const seen = played.log.flatMap(({ events }) =>
      events.filter((event) => event.kind === `${NS}:squaresSeen`),
    );
    expect(seen.length).toBeGreaterThan(0);
    const registry = (await loadAdventure("goblin-ambush")).registry;
    const save = createSave(registry, "goblin-ambush", "fog-save", played.log);
    const loaded = loadSave(JSON.stringify(save), registry, run);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.state.system).toEqual(played.state.system);
    const system = StateSchema.parse(loaded.state.system);
    expect(Object.keys(system.revealed ?? {}).length).toBe(1);
  });
});
