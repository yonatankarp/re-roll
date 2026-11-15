import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import { tacticOptions } from "../plugins/systems/dnd5.5e/core/actions.ts";
import {
  fallFrames,
  heightOf,
} from "../plugins/systems/dnd5.5e/core/combat/falling.ts";
import { provokers } from "../plugins/systems/dnd5.5e/core/combat/movement.ts";
import {
  moveSquares,
  reaches,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { squareKey } from "../plugins/systems/dnd5.5e/core/grid.ts";
import { jumpOf } from "../plugins/systems/dnd5.5e/core/movement-modes.ts";
import {
  type Actor,
  type DndState,
  NS,
  freshActor,
  hasCondition,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { scripted, settle, testRun } from "./feat-fixtures.ts";

// Height on the board, falling from it, and moving through and into other creatures' spaces (issue #124), on
// made-up stat blocks encoded as the books' flyers, climbers, swarms and elementals are.

const club = {
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
};

const block = (id: string, fields: Readonly<Record<string, unknown>> = {}) => ({
  id: `test:monster/${id}`,
  name: id,
  ac: 10,
  hp: 50,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  actions: [club],
  ...fields,
});

const through = {
  kind: "moveThrough",
  creatures: "any",
  squeeze: true,
} as const;

const FIXTURES = [
  block("brute"),
  block("harpy", { speeds: { walk: 30, fly: 30 } }),
  block("spider", { speeds: { walk: 30, climb: 30 } }),
  block("cat", {
    abilities: { str: 6, dex: 16, con: 10, int: 10, wis: 10, cha: 10 },
    passives: [{ kind: "jump", runUp: 10, ability: "dex" }],
  }),
  block("elemental", {
    passives: [
      through,
      {
        kind: "shareSpace",
        who: "self",
        cover: false,
        burn: [{ amount: { dice: "1d10" }, type: "fire" }],
      },
    ],
  }),
  block("swarm", {
    passives: [
      { ...through, open: true },
      { kind: "shareSpace", who: "self", cover: false },
    ],
  }),
];

async function run(): Promise<RunContext> {
  const base = await testRun();
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...base,
    content: (id) => byId.get(id) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
}

type Effect = Actor["activeEffects"][number];

function monster(
  id: string,
  kind: string,
  x: number,
  y: number,
  side: "enemy" | "party" = "enemy",
  activeEffects: readonly Effect[] = [],
): Actor {
  return {
    ...freshActor({
      id,
      name: id,
      side,
      source: { kind: "monster", statBlockId: `test:monster/${kind}` },
      hp: 50,
      inventory: [],
    }),
    position: { x, y },
    activeEffects: [...activeEffects],
  };
}

const spell = (modifier: Effect["modifier"], sourceId = "spell"): Effect => ({
  sourceId,
  casterId: "caster",
  modifier,
  ends: "spellDuration",
});

// Up on its own Fly or Climb Speed, `feet` high.
const up = (feet: number, mode: "fly" | "climb" = "fly"): Effect => ({
  sourceId: "flight",
  casterId: "self",
  modifier: { kind: "aloft", feet, mode },
  ends: "spellDuration",
});

const prone: Effect = {
  sourceId: "shove",
  casterId: "brute",
  modifier: { kind: "condition", condition: "prone" },
  ends: "spellDuration",
};

function arena(
  actors: readonly Actor[],
  walls: readonly string[] = [],
  difficult: readonly string[] = [],
): DndState {
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      grid: { width: 12, height: 5 },
      walls: [...walls],
      ...(difficult.length > 0
        ? {
            terrain: {
              difficult: [...difficult],
              half: [],
              threeQuarters: [],
              dim: [],
              dark: [],
              light: "bright" as const,
            },
          }
        : {}),
    },
  };
}

function get(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(id);
  return actor;
}

function walks(content: RunContext, state: DndState, id: string) {
  const actor = get(state, id);
  return new Map(
    moveSquares(actor, state, deriveStats(actor, content), content).map(
      (item) => [squareKey(item.square), item],
    ),
  );
}

const options = (content: RunContext, state: DndState, id: string) =>
  tacticOptions(get(state, id), state, content).map((option) => option.id);

const take = (actor: string, answer: string) => ({
  kind: `${NS}:takeAction`,
  payload: { actor, answer },
});

const clubOf = (content: RunContext, actor: Actor) => {
  const action = deriveStats(actor, content).actions.find(
    (item) => item.name === "Club",
  );
  if (!action) throw new Error("Club");
  return action;
};

describe("height", () => {
  it("flies up out of a walker's reach for 10 feet of movement each step, and down again", async () => {
    const content = await run();
    const start = arena([
      monster(PLAYER_ACTOR, "harpy", 1, 1, "party"),
      monster("brute", "brute", 2, 1),
    ]);
    const rise = options(content, start, PLAYER_ACTOR).find((id) =>
      id.includes("rise"),
    );
    expect(rise).toBeDefined();
    // A walker has no such choice.
    expect(
      options(content, start, "brute").some((id) => id.includes("rise")),
    ).toBe(false);
    const { state } = settle(
      content,
      start,
      [take(PLAYER_ACTOR, rise ?? ""), take(PLAYER_ACTOR, rise ?? "")],
      scripted([]).dice,
    );
    const flyer = get(state, PLAYER_ACTOR);
    expect(heightOf(flyer)).toBe(20);
    expect(flyer.moved).toBe(20);
    const brute = get(state, "brute");
    expect(reaches(clubOf(content, brute), brute, flyer)).toBe(false);
    expect(reaches(clubOf(content, flyer), flyer, brute)).toBe(false);
    // Up there it flies on with the 10 feet left, and leaving the brute's side provokes nothing.
    expect(walks(content, state, PLAYER_ACTOR).get("1,3")?.feet).toBe(10);
    expect(walks(content, state, PLAYER_ACTOR).has("1,4")).toBe(false);
    expect(provokers(flyer, { x: 0, y: 1 }, state, content)).toEqual([]);
    expect(
      provokers(get(start, PLAYER_ACTOR), { x: 0, y: 1 }, start, content).map(
        ({ foe }) => foe.id,
      ),
    ).toEqual(["brute"]);
    // Down again, one step at a time.
    const sink = options(content, state, PLAYER_ACTOR).find((id) =>
      id.includes("sink"),
    );
    const landed = settle(
      content,
      state,
      [take(PLAYER_ACTOR, sink ?? ""), take(PLAYER_ACTOR, sink ?? "")],
      scripted([]).dice,
    ).state;
    expect(heightOf(get(landed, PLAYER_ACTOR))).toBe(0);
    expect(get(landed, PLAYER_ACTOR).moved).toBe(40);
  });

  it("falls once knocked Prone or once its Fly Speed ends, unless it hovers", async () => {
    const content = await run();
    const context = (state: DndState) => ({
      state,
      dice: scripted([]).dice,
      ...content,
    });
    const flying = (effects: readonly Effect[]) =>
      arena([monster("bird", "brute", 1, 1, "party", effects)]);
    const fly = spell({ kind: "movementMode", mode: "fly", feet: 60 });
    const hover = spell({
      kind: "movementMode",
      mode: "fly",
      feet: 60,
      hover: true,
    });
    expect(fallFrames(context(flying([fly, up(30)])))).toEqual([]);
    // Prone: down it comes, 3d6 for 30 feet, and Prone.
    const knocked = flying([fly, up(30), prone]);
    expect(fallFrames(context(knocked))).toEqual([
      { kind: `${NS}:fall`, payload: { actors: ["bird"], feet: 30 } },
    ]);
    const { state } = settle(
      content,
      knocked,
      fallFrames(context(knocked)),
      scripted([4, 4, 4]).dice,
    );
    expect(heightOf(get(state, "bird"))).toBe(0);
    expect(get(state, "bird").hp).toBe(38);
    // Fly's hover keeps it up while Prone, but not once the spell ends.
    expect(fallFrames(context(flying([hover, up(30), prone])))).toEqual([]);
    expect(fallFrames(context(flying([up(30)])))).toHaveLength(1);
    // Grappled, its Speed is 0, and it falls too.
    const held = spell(
      { kind: "condition", condition: "grappled" },
      "monster:0",
    );
    expect(fallFrames(context(flying([fly, up(30), held])))).toHaveLength(1);
  });

  it("floats down unhurt once Levitate ends", async () => {
    const content = await run();
    const levitated = arena([
      monster("bird", "brute", 1, 1, "party", [
        spell({ kind: "aloft", feet: 20, gentle: true }, "spell:aloft"),
      ]),
    ]);
    const frames = fallFrames({
      state: levitated,
      dice: scripted([]).dice,
      ...content,
    });
    expect(frames).toEqual([
      {
        kind: `${NS}:fall`,
        payload: { actors: ["bird"], feet: 20, gentle: true },
      },
    ]);
    const { state } = settle(content, levitated, frames, scripted([]).dice);
    expect(get(state, "bird")).toMatchObject({ hp: 50 });
    expect(heightOf(get(state, "bird"))).toBe(0);
    expect(hasCondition(get(state, "bird"), "prone")).toBe(false);
  });

  it("climbs up beside a wall, keeps to the walls up there, and goes anywhere along ceilings with Spider Climb", async () => {
    const content = await run();
    const walls = ["0,0", "1,0", "2,0", "3,0", "4,0", "5,0"];
    const open = arena([monster("spider", "spider", 2, 3)], walls);
    expect(
      options(content, open, "spider").some((id) => id.includes("rise")),
    ).toBe(false);
    const byWall = arena([monster("spider", "spider", 2, 1)], walls);
    expect(
      options(content, byWall, "spider").some((id) => id.includes("rise")),
    ).toBe(true);
    // Up the wall, it moves along it but not out into the room.
    const climbing = arena(
      [monster("spider", "spider", 2, 1, "enemy", [up(10, "climb")])],
      walls,
    );
    const squares = walks(content, climbing, "spider");
    expect(squares.has("4,1")).toBe(true);
    expect(squares.has("2,3")).toBe(false);
    const ceiling = spell({
      kind: "movementMode",
      mode: "climb",
      ceiling: true,
    });
    expect(
      options(
        content,
        arena([monster("spider", "spider", 2, 3, "enemy", [ceiling])], walls),
        "spider",
      ).some((id) => id.includes("rise")),
    ).toBe(true);
    expect(
      walks(
        content,
        arena(
          [
            monster("spider", "spider", 2, 1, "enemy", [
              ceiling,
              up(10, "climb"),
            ]),
          ],
          walls,
        ),
        "spider",
      ).has("2,3"),
    ).toBe(true);
  });
});

describe("sharing a square and other movement traits", () => {
  it("lets Fire Form stop in a foe's space and burns those it enters", async () => {
    const content = await run();
    const start = arena([
      monster("elemental", "elemental", 1, 1),
      monster("hero", "brute", 3, 1, "party"),
      monster(PLAYER_ACTOR, "brute", 5, 3, "party"),
    ]);
    const squares = walks(content, start, "elemental");
    expect(squares.has("3,1")).toBe(true);
    const { state } = settle(
      content,
      start,
      [{ kind: `${NS}:move`, payload: { actor: "elemental", answer: "3,1" } }],
      scripted([7]).dice,
    );
    expect(get(state, "elemental").position).toEqual({ x: 3, y: 1 });
    expect(get(state, "hero").hp).toBe(43);
    // One it didn't enter isn't burned.
    expect(get(state, PLAYER_ACTOR).hp).toBe(50);
  });

  it("lets anyone stop in a swarm's space, which it shares", async () => {
    const content = await run();
    const state = arena([
      monster("swarm", "swarm", 3, 1),
      monster("hero", "brute", 1, 1, "party"),
      monster("brute", "brute", 6, 1, "party"),
    ]);
    expect(walks(content, state, "hero").has("3,1")).toBe(true);
    expect(walks(content, state, "swarm").has("6,1")).toBe(true);
  });

  it("jumps by Dexterity with Jumper", async () => {
    const content = await run();
    const cat = monster("cat", "cat", 1, 1);
    expect(jumpOf(deriveStats(cat, content))).toMatchObject({
      running: 16,
      standing: 8,
    });
  });

  it("crosses Difficult Terrain at no extra cost and slips free of a grapple with Freedom of Movement", async () => {
    const content = await run();
    const free = spell({ kind: "unhindered" });
    const rough = [0, 1, 2, 3, 4].flatMap((y) => [
      `2,${String(y)}`,
      `3,${String(y)}`,
    ]);
    const plain = arena([monster("hero", "brute", 1, 1, "party")], [], rough);
    expect(walks(content, plain, "hero").get("3,1")?.feet).toBe(20);
    const freed = arena(
      [monster("hero", "brute", 1, 1, "party", [free])],
      [],
      rough,
    );
    expect(walks(content, freed, "hero").get("3,1")?.feet).toBe(10);
    const held = spell(
      { kind: "condition", condition: "grappled" },
      "monster:0",
    );
    const grappled = arena([
      monster(PLAYER_ACTOR, "brute", 1, 1, "party", [
        free,
        { ...held, casterId: "brute" },
      ]),
      monster("brute", "brute", 2, 1),
    ]);
    const slip = options(content, grappled, PLAYER_ACTOR).find((id) =>
      id.includes("slip"),
    );
    expect(slip).toBeDefined();
    const { state } = settle(
      content,
      grappled,
      [take(PLAYER_ACTOR, slip ?? "")],
      scripted([]).dice,
    );
    expect(hasCondition(get(state, PLAYER_ACTOR), "grappled")).toBe(false);
    expect(get(state, PLAYER_ACTOR).moved).toBe(5);
    expect(get(state, PLAYER_ACTOR).budget.action).toBe(true);
  });
});
