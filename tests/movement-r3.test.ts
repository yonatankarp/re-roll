import type { SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { moveSquares } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  breathAgainEvents,
  suffocationEvents,
  underwaterHampered,
} from "../plugins/systems/dnd5.5e/core/combat/water.ts";
import { codeKeys, squareKey } from "../plugins/systems/dnd5.5e/core/grid.ts";
import {
  speedsOf,
  unhindered,
} from "../plugins/systems/dnd5.5e/core/movement-modes.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { hero, trait } from "./feat-fixtures.ts";
import { at, block, monster, onMap, runWith } from "./senses-fixtures.ts";

// Swimming, water, underwater fights, Earthbind, jumps and Speeds of #173, on made-up stat blocks and traits.

const modifier = (fields: object, extra: object = {}) => ({
  kind: "modifier",
  modifier: fields,
  ...extra,
});

const FIXTURES = [
  block("walker"),
  block("fish", { speed: 10, speeds: { walk: 10, swim: 40 } }),
  block("gull", { speed: 10, speeds: { walk: 10, fly: 60 } }),
  trait("swimmer", [modifier({ kind: "movementMode", mode: "swim" })]),
  trait("strider", [modifier({ kind: "waterWalk" })]),
  trait("fast", [
    modifier(
      { kind: "bonus", to: "speed", amount: { bonus: { base: 10 } } },
      { armor: "noHeavy" },
    ),
  ]),
  trait("mobile", [
    modifier({ kind: "movementMode", mode: "climb", feet: 20 }),
    modifier({
      kind: "bonus",
      to: "speed",
      amount: { bonus: { base: 10 } },
      modes: ["climb"],
    }),
  ]),
  trait("springy", [modifier({ kind: "jumpBoost", feet: 30, movement: 10 })]),
  trait("swift", [
    {
      kind: "tacticRider",
      tactic: "dash",
      modifiers: [{ kind: "unhindered", terrainOnly: true }],
    },
  ]),
];

const effect = (modifier: ActiveEffect["modifier"]): ActiveEffect => ({
  sourceId: "test",
  casterId: "test",
  modifier,
  ends: "spellDuration",
});
const holding = (actor: Actor, ...effects: ActiveEffect[]): Actor => ({
  ...actor,
  activeEffects: [...actor.activeEffects, ...effects],
});

// The feet it costs to reach each square, by "x,y", on a map with water ("w").
function costs(run: RunContext, rows: readonly string[], actor: Actor) {
  const state = onMap(rows, [actor]);
  const water = codeKeys(rows, "w");
  const wet: DndState = {
    ...state,
    combat: state.combat && {
      ...state.combat,
      terrain: state.combat.terrain && { ...state.combat.terrain, water },
    },
  };
  return new Map(
    moveSquares(actor, wet, deriveStats(actor, run), run).map((item) => [
      squareKey(item.square),
      item.feet,
    ]),
  );
}

describe("swimming and water", () => {
  it("costs a walker double in water, but not a swimmer or one walking on it", async () => {
    const run = await runWith(FIXTURES);
    const rows = [".www"];
    expect(costs(run, rows, at(hero([]), 0, 0)).get("3,0")).toBe(30);
    expect(costs(run, rows, at(hero(["swimmer"]), 0, 0)).get("3,0")).toBe(15);
    expect(costs(run, rows, at(hero(["strider"]), 0, 0)).get("3,0")).toBe(15);
    // A swimmer faster in water than on land keeps to the water on its Swim Speed.
    const fish = costs(run, ["wwwwwwww"], at(monster("f", "fish"), 0, 0));
    expect(fish.get("7,0")).toBe(35);
  });

  it("gives Swim Speeds from traits and a stat block, and takes a Fly Speed away for Earthbind", async () => {
    const run = await runWith(FIXTURES);
    const swimmer = hero(["swimmer"]);
    expect(speedsOf(swimmer, deriveStats(swimmer, run)).get("swim")).toBe(30);
    const gull = monster("g", "gull");
    expect(speedsOf(gull, deriveStats(gull, run)).get("fly")).toBe(60);
    const bound = holding(gull, effect({ kind: "grounded", mode: "fly" }));
    expect(speedsOf(bound, deriveStats(bound, run)).has("fly")).toBe(false);
    const lowered = holding(
      gull,
      effect({ kind: "grounded", mode: "fly", feet: 30 }),
    );
    expect(speedsOf(lowered, deriveStats(lowered, run)).get("fly")).toBe(30);
  });

  it("hampers weapons and runs out the breath of one that can't breathe underwater", async () => {
    const run = await runWith(FIXTURES);
    const diver = at(hero([]), 0, 0);
    const base = onMap(["...."], [diver, at(monster("w", "walker"), 1, 0)]);
    const state: DndState = {
      ...base,
      combat: base.combat && { ...base.combat, underwater: true, round: 40 },
    };
    const context = { ...run, state };
    const sword = deriveStats(diver, run).actions.find(
      (item) => item.activation.resolution.kind === "attack",
    );
    if (sword?.activation.resolution.kind !== "attack") throw new Error();
    expect(
      underwaterHampered(diver, sword, sword.activation.resolution, context),
    ).toBe(true);
    const dice = { below: () => 0, roll: () => 1 };
    const gasping = suffocationEvents(diver, { ...context, dice });
    expect(gasping.map((event) => event.kind)).toContain(
      "dnd5.5e:exhaustionChanged",
    );
    // A Water Breathing creature never runs out, and the Exhaustion goes as the fight ends.
    const breathing = holding(diver, effect({ kind: "waterBreathing" }));
    expect(suffocationEvents(breathing, { ...context, dice })).toEqual([]);
    const after = gasping.reduce(applyDndEvent, state);
    const back: SystemEvent[] = breathAgainEvents(after);
    expect(
      (back[0] as { payload?: unknown } | undefined)?.payload,
    ).toMatchObject({ levels: -1 });
  });
});

describe("Speeds and jumps", () => {
  it("adds a Speed bonus without Heavy armor and to another Speed, and offers a boosted jump", async () => {
    const run = await runWith(FIXTURES);
    expect(deriveStats(hero(["fast"]), run).speed).toBe(
      deriveStats(hero([]), run).speed + 10,
    );
    const mobile = hero(["mobile"]);
    expect(speedsOf(mobile, deriveStats(mobile, run)).get("climb")).toBe(30);
    const jumps = deriveStats(hero(["springy"]), run).actions.find(
      (item) => item.id === "jump-boost",
    );
    expect(jumps?.activation.resolution).toMatchObject({
      effects: [{ kind: "teleport", feet: 30, movement: 10 }],
    });
  });

  it("makes Dash leave difficult terrain at no extra cost, without slipping a grapple", async () => {
    const run = await runWith(FIXTURES);
    const dashed = holding(
      hero(["swift"]),
      effect({ kind: "unhindered", terrainOnly: true }),
    );
    const stats = deriveStats(dashed, run);
    expect(unhindered(dashed, stats)).toBe(true);
    expect(unhindered(dashed, stats, true)).toBe(false);
  });
});
