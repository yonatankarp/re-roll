import { fc, test as property } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import { createSave, loadSave } from "../engine/run/save.ts";
import { playRun } from "../engine/tools/bot.ts";
import {
  type AreaShape,
  SQUARE_FEET,
  distanceFeet,
  inArea,
  reachableSquares,
  squareKey,
} from "../plugins/systems/dnd5.5e/core/grid.ts";
import { PregenSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";

// Seeds are fixed globally in tests/setup.ts.
const square = (size: number) =>
  fc.record({ x: fc.nat(size - 1), y: fc.nat(size - 1) });
const keys = (size: number) =>
  fc.uniqueArray(square(size).map(squareKey), { maxLength: size * 2 });

describe("reachableSquares", () => {
  property.prop([
    fc.integer({ min: 1, max: 10 }),
    fc.integer({ min: 1, max: 10 }),
    fc.nat(60),
    square(10),
    keys(10),
    keys(10),
  ])(
    "steps to adjacent open squares, 5 feet each within the budget, never ending on anyone",
    (width, height, feet, rawStart, blockedList, occupiedList) => {
      const start = { x: rawStart.x % width, y: rawStart.y % height };
      const blocked = new Set(
        blockedList.filter((k) => k !== squareKey(start)),
      );
      const occupied = new Set(occupiedList);
      const reached = reachableSquares(
        start,
        feet,
        { width, height },
        blocked,
        occupied,
      );
      for (const { square: end, feet: cost, path } of reached) {
        expect(cost).toBe(path.length * SQUARE_FEET);
        expect(cost).toBeGreaterThan(0);
        expect(cost).toBeLessThanOrEqual(feet);
        expect(path.at(-1)).toEqual(end);
        expect(occupied.has(squareKey(end))).toBe(false);
        let at = start;
        for (const next of path) {
          expect(distanceFeet(at, next)).toBe(SQUARE_FEET);
          expect(blocked.has(squareKey(next))).toBe(false);
          expect(next.x >= 0 && next.x < width).toBe(true);
          expect(next.y >= 0 && next.y < height).toBe(true);
          at = next;
        }
      }
    },
  );
});

describe("inArea", () => {
  const shapes: AreaShape[] = ["sphere", "cone", "cube", "line", "emanation"];
  property.prop([
    fc.constantFrom(...shapes),
    fc.nat(120),
    fc.nat(120),
    square(20),
    square(20),
    square(20),
  ])(
    "never loses a square as the area grows",
    (shape, a, b, origin, aim, point) => {
      const [small, large] = a <= b ? [a, b] : [b, a];
      if (inArea(shape, small, origin, aim, point)) {
        expect(inArea(shape, large, origin, aim, point)).toBe(true);
      }
    },
  );
});

describe("D&D state", async () => {
  const { registry, run } = await loadAdventure("goblin-ambush");

  property.prop([fc.string({ maxLength: 12 })], { numRuns: 8 })(
    "a save of any run loads back to the same state",
    (seed) => {
      const played = playRun(run, seed, { maxDecisions: 300 });
      const save = createSave(registry, "goblin-ambush", seed, played.log);
      const loaded = loadSave(JSON.stringify(save), registry, run);
      if (!loaded.ok) throw new Error(loaded.error);
      expect(loaded.state).toStrictEqual(played.state);
    },
  );

  const pregen = lookup(run, PregenSchema, "srd52:pregen/fighter");
  const fighter = freshActor({
    id: "fighter",
    name: pregen.name,
    side: "party",
    source: { kind: "character", build: pregen.build },
    hp: 1,
    inventory: pregen.equipment,
  });
  const { maxHp } = deriveStats(fighter, run);
  const change = fc.record({
    heal: fc.boolean(),
    amount: fc.nat(40),
    critical: fc.boolean(),
  });

  property.prop([fc.integer({ min: 0, max: maxHp }), fc.array(change)])(
    "keeps Hit Points between 0 and the maximum after any damage or healing",
    (hp, changes) => {
      let state: DndState = {
        actors: { fighter: { ...fighter, hp } },
        combat: null,
      };
      for (const { heal, amount, critical } of changes) {
        state = applyDndEvent(
          state,
          heal
            ? dndEvent(`${NS}:healed`, { actor: "fighter", amount, max: maxHp })
            : dndEvent(`${NS}:damaged`, {
                actor: "fighter",
                amount,
                type: "fire",
                critical,
                massive: false,
              }),
        );
        const now = state.actors.fighter?.hp ?? -1;
        expect(now).toBeGreaterThanOrEqual(0);
        expect(now).toBeLessThanOrEqual(maxHp);
      }
    },
  );
});
