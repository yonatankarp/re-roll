import { describe, expect, it } from "vitest";
import { createDice, hashText, rngFromSeed } from "../engine/kernel/dice.ts";

describe("dice", () => {
  it("keeps producing the same pinned numbers, so old saves stay replayable", () => {
    const dice = createDice(rngFromSeed("golden"));
    const rolls = Array.from({ length: 8 }, () => dice.below(1_000_000));
    expect(rolls).toEqual(GOLDEN_ROLLS);
  });

  it("gives the same rolls for the same seed, and different ones otherwise", () => {
    const rollsFor = (seed: string): number[] => {
      const dice = createDice(rngFromSeed(seed));
      return Array.from({ length: 20 }, () => dice.roll(20));
    };
    expect(rollsFor("a")).toEqual(rollsFor("a"));
    expect(rollsFor("a")).not.toEqual(rollsFor("b"));
  });

  it("stays in range and reaches every face about equally", () => {
    const dice = createDice(rngFromSeed("spread"));
    const counts = new Map<number, number>();
    for (let index = 0; index < 60_000; index += 1) {
      const value = dice.roll(6);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(9_500);
      expect(count).toBeLessThan(10_500);
    }
  });

  it("doesn't change the state it started from", () => {
    const start = rngFromSeed("pure");
    const copy = [...start];
    const dice = createDice(start);
    dice.roll(20);
    expect(start).toEqual(copy);
    expect(dice.state()).not.toEqual(copy);
  });

  it("records every roll", () => {
    const dice = createDice(rngFromSeed("record"));
    const value = dice.below(10);
    expect(dice.rolls()).toEqual([{ below: 10, value }]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses to roll below %s", (count) => {
    expect(() => createDice(rngFromSeed("x")).below(count)).toThrow();
  });

  it("hashes text consistently", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
    expect(hashText("abc")).toMatch(/^[0-9a-f]{32}$/);
  });
});

// From a separate, conventional sfc32, so these also check the implementation itself.
const GOLDEN_ROLLS: readonly number[] = [
  748158, 169045, 407678, 897739, 529163, 349543, 320428, 326547,
];
