import { PLAYER_ACTOR } from "#sdk";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../engine/run/turn.ts";
import {
  moveSquares,
  speedLeft,
} from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { dropToOneEvents } from "../plugins/systems/dnd5.5e/core/trait-rules.ts";
import { partySight } from "../plugins/systems/dnd5.5e/core/fog.ts";
import { codeKeys, squareKey } from "../plugins/systems/dnd5.5e/core/grid.ts";
import { makeJudge } from "../plugins/systems/dnd5.5e/core/worth.ts";
import {
  type Actor,
  type DndState,
  applyDndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hero, testRun, trait } from "./feat-fixtures.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";

// Speeds besides walking, and moving through creatures, walls and gaps (issues #100 and #106), on made-up stat
// blocks and traits.

const block = (id: string, fields: Readonly<Record<string, unknown>> = {}) => ({
  id: `test:monster/${id}`,
  name: id,
  ac: 10,
  hp: 50,
  speed: 30,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  proficiency: 2,
  initiative: 0,
  ...fields,
});
const through = (fields: object) => ({ kind: "moveThrough", ...fields });

const FIXTURES = [
  block("walker"),
  block("bat", { speed: 10, speeds: { walk: 10, fly: 30 } }),
  block("mole", { speed: 10, speeds: { walk: 10, burrow: 20 } }),
  block("gnat", { size: "tiny" }),
  block("ogre", { size: "large" }),
  block("giant", { size: "huge" }),
  block("ghost", {
    passives: [through({ creatures: "any", walls: true, costly: true })],
  }),
  block("xorn", { passives: [through({ walls: true })] }),
  block("swarm", {
    passives: [through({ creatures: "any", open: true, squeeze: true })],
  }),
  block("ooze", { passives: [through({ squeeze: true })] }),
  block("frog", {
    abilities: { str: 6, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    passives: [{ kind: "jump", feet: 20, runUp: 0 }],
  }),
  trait("climber", [
    { kind: "modifier", modifier: { kind: "movementMode", mode: "climb" } },
  ]),
  trait("nimble", [through({ creatures: "larger" })]),
  trait("leaper", [{ kind: "jump", runUp: 5 }]),
  trait("misty", [
    {
      kind: "dropToOne",
      resource: "misty",
      effects: [{ kind: "movementMode", mode: "fly", feet: 20 }],
    },
  ]),
  trait("winged", [], {
    resources: [
      {
        id: "wings",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: ["bonusAction", { resource: "wings" }],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              duration: { minutes: 10 },
              modifier: { kind: "movementMode", mode: "fly" },
            },
          ],
        },
      },
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

function monster(id: string, kind: string, side: "enemy" | "party" = "enemy") {
  return freshActor({
    id,
    name: id,
    side,
    source: { kind: "monster", statBlockId: `test:monster/${kind}` },
    hp: 50,
    inventory: [],
  });
}

const at = (actor: Actor, x: number, y: number): Actor => ({
  ...actor,
  position: { x, y },
});

// A fight on a map drawn as rows: "#" walls and "~" difficult terrain.
function onMap(rows: readonly string[], actors: readonly Actor[]): DndState {
  const difficult = codeKeys(rows, "~");
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      grid: { width: rows[0]?.length ?? 0, height: rows.length },
      walls: codeKeys(rows, "#"),
      ...(difficult.length > 0
        ? {
            terrain: {
              difficult,
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

// The feet it costs `id` to reach each square, by "x,y".
function costs(
  content: RunContext,
  state: DndState,
  id: string,
): ReadonlyMap<string, number> {
  const actor = state.actors[id];
  if (!actor) throw new Error(id);
  return new Map(
    moveSquares(actor, state, deriveStats(actor, content), content).map(
      (item) => [squareKey(item.square), item.feet],
    ),
  );
}

describe("movement modes", () => {
  it("moves in its fastest Speed, and a flyer crosses difficult terrain at no extra cost", async () => {
    const content = await run();
    const state = onMap(
      ["..........", ".~~~~~~~~.", ".........."],
      [at(monster("bat", "bat"), 0, 1), at(monster("walker", "walker"), 0, 0)],
    );
    const bat = costs(content, state, "bat");
    expect(bat.get("6,1")).toBe(30);
    expect(bat.has("7,1")).toBe(false);
    const flyer = at(monster("bat", "bat"), 0, 1);
    expect(speedLeft(flyer, deriveStats(flyer, content))).toBe(30);
    // Walking, the same ground costs double.
    expect(costs(content, state, "walker").get("1,1")).toBe(10);
  });

  it("switches Speeds by what's left after moving, as the rules do", async () => {
    const content = await run();
    const bat = { ...at(monster("bat", "bat"), 0, 0), moved: 20 };
    const state = onMap([".........."], [bat]);
    expect(Math.max(...costs(content, state, "bat").values())).toBe(10);
  });

  it("lets a climber from a trait, or a burrower, cross difficult terrain at no extra cost", async () => {
    const content = await run();
    const climber = at(hero(["climber"]), 0, 0);
    const state = onMap(
      ["~~~~~~~", "~~~~~~~"],
      [climber, at(monster("mole", "mole"), 0, 1)],
    );
    expect(costs(content, state, PLAYER_ACTOR).get("6,0")).toBe(30);
    expect(costs(content, state, "mole").get("4,1")).toBe(20);
  });

  it("passes walls with Earth Glide but never stops in one, and Incorporeal Movement pays double", async () => {
    const content = await run();
    const rows = ["..#..", "..#..", "..#.."];
    const xorn = costs(
      content,
      onMap(rows, [at(monster("x", "xorn"), 0, 1)]),
      "x",
    );
    expect(xorn.get("3,1")).toBe(15);
    expect(xorn.has("2,1")).toBe(false);
    const ghost = costs(
      content,
      onMap(rows, [at(monster("g", "ghost"), 0, 1)]),
      "g",
    );
    expect(ghost.get("3,1")).toBe(20);
    const walker = costs(
      content,
      onMap(rows, [at(monster("w", "walker"), 0, 1)]),
      "w",
    );
    expect(walker.has("3,1")).toBe(false);
  });

  it("passes creatures as the rules allow: allies, Tiny ones, two sizes apart, or with a trait", async () => {
    const content = await run();
    const wall = (kind: string) =>
      onMap(
        ["#.#", "#.#", "#.#"],
        [at(hero([]), 1, 0), at(monster("foe", kind), 1, 1)],
      );
    expect(costs(content, wall("walker"), PLAYER_ACTOR).has("1,2")).toBe(false);
    expect(costs(content, wall("ogre"), PLAYER_ACTOR).has("1,2")).toBe(false);
    // A foe's space costs double, unless it's Tiny.
    expect(costs(content, wall("giant"), PLAYER_ACTOR).get("1,2")).toBe(15);
    expect(costs(content, wall("gnat"), PLAYER_ACTOR).get("1,2")).toBe(10);
    // Halfling Nimbleness: through a creature one size larger.
    const nimble = onMap(
      ["#.#", "#.#", "#.#"],
      [at(hero(["nimble"]), 1, 0), at(monster("foe", "ogre"), 1, 1)],
    );
    expect(costs(content, nimble, PLAYER_ACTOR).get("1,2")).toBe(15);
    // A swarm goes through anyone, and anyone through it, but nobody stops on another.
    const swarm = onMap(
      ["#.#", "#.#", "#.#"],
      [at(monster("s", "swarm"), 1, 0), at(hero([]), 1, 1)],
    );
    expect(costs(content, swarm, "s").get("1,2")).toBe(15);
    expect(costs(content, swarm, "s").has("1,1")).toBe(false);
    const past = onMap(
      ["#.#", "#.#", "#.#"],
      [at(hero([]), 1, 0), at(monster("s", "swarm"), 1, 1)],
    );
    expect(costs(content, past, PLAYER_ACTOR).get("1,2")).toBe(15);
  });

  it("slips between walls that meet at a corner with Amorphous", async () => {
    const content = await run();
    const rows = ["#.", ".#"];
    const ooze = costs(
      content,
      onMap(rows, [at(monster("o", "ooze"), 0, 1)]),
      "o",
    );
    expect(ooze.get("1,0")).toBe(5);
    const walker = costs(
      content,
      onMap(rows, [at(monster("w", "walker"), 0, 1)]),
      "w",
    );
    expect(walker.has("1,0")).toBe(false);
  });

  it("long jumps over difficult terrain: a run-up of 10 feet, 5 with Athlete, none with Standing Leap", async () => {
    const content = await run();
    const walk = (traits: readonly string[], rows: readonly string[]) =>
      costs(content, onMap(rows, [at(hero(traits), 0, 0)]), PLAYER_ACTOR);
    // Strength 17: a 17-foot jump after 10 feet of running, 8 feet standing. Walking it all costs 25 feet.
    expect(walk([], [".~~.."]).get("3,0")).toBe(20);
    // After only 5 feet, Athlete jumps both rough squares; a plain run-up reaches the first one first.
    expect(walk(["leaper"], ["..~~.."]).get("4,0")).toBe(20);
    expect(walk([], ["..~~.."]).get("4,0")).toBe(25);
    // A frog leaps 20 feet from a standstill.
    const frog = costs(
      content,
      onMap(["~~~.."], [at(monster("f", "frog"), 0, 0)]),
      "f",
    );
    expect(frog.get("3,0")).toBe(15);
  });

  it("gains a Fly Speed from a Bonus Action trait, and the bot values it on rough ground", async () => {
    const content = await run();
    const winged = at(hero(["winged"]), 0, 0);
    const state = onMap(
      ["~~~~~~~~", "~~~~~~~~", "~~~~~~~~"],
      [winged, at(monster("foe", "walker"), 7, 2)],
    );
    const stats = deriveStats(winged, content);
    const action = stats.actions.find((item) => item.id.includes("winged"));
    if (!action) throw new Error("no wings");
    const dice = createDice(rngFromSeed("wings"));
    const judge = makeJudge({ ...content, state, dice }, winged);
    expect(
      judge.worth(winged, action.id, PLAYER_ACTOR, undefined),
    ).toBeGreaterThan(0);
    const flying = applyDndEvent(state, {
      kind: "dnd5.5e:effectAdded",
      payload: {
        actor: PLAYER_ACTOR,
        effect: {
          sourceId: action.id,
          casterId: PLAYER_ACTOR,
          modifier: { kind: "movementMode", mode: "fly" },
          ends: "spellDuration",
        },
      },
    });
    expect(costs(content, flying, PLAYER_ACTOR).get("6,0")).toBe(30);
    expect(costs(content, state, PLAYER_ACTOR).get("3,0")).toBe(30);
  });

  it("drops to 1 Hit Point with a Fly Speed, as Boon of Misty Escape's Gaseous Form", async () => {
    const content = await run();
    const misty = { ...at(hero(["misty"]), 0, 0), hp: 5 };
    const stats = deriveStats(misty, content);
    const events = dropToOneEvents(
      misty,
      9,
      4,
      { type: "slashing", critical: false },
      { ...stats, resources: { ...stats.resources, misty: 1 } },
    );
    expect(events?.map((event) => event.kind)).toContain("dnd5.5e:effectAdded");
  });

  it("finds foes on the ground with Tremorsense, hidden or not, but not flyers", async () => {
    const content = await run();
    const sensing = at(hero([]), 0, 0);
    const felt = {
      ...sensing,
      activeEffects: [
        {
          sourceId: "stone",
          casterId: PLAYER_ACTOR,
          modifier: { kind: "tremorsense" as const, feet: 60 },
          ends: "spellDuration" as const,
        },
      ],
    };
    const hidden = (actor: Actor): Actor => ({
      ...actor,
      activeEffects: [
        {
          sourceId: "hide",
          casterId: actor.id,
          modifier: { kind: "tactic", tactic: "hidden", value: 20 },
          ends: "spellDuration",
        },
      ],
    });
    const rows = ["..#....", "..#....", "..#...."];
    const foes = [
      at(hidden(monster("w", "walker")), 5, 1),
      at(hidden(monster("b", "bat")), 5, 2),
    ];
    expect(partySight(onMap(rows, [sensing, ...foes]), content).foes.size).toBe(
      0,
    );
    const seen = partySight(onMap(rows, [felt, ...foes]), content).foes;
    expect([...seen]).toEqual(["w"]);
  });
});
