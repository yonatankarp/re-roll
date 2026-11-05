import { describe, expect, it } from "vitest";
import { satisfiesCaret } from "../engine/kernel/semver.ts";

describe("satisfiesCaret", () => {
  it.each([
    ["1.0.0", "^1", true],
    ["1.9.3", "^1", true],
    ["2.0.0", "^1", false],
    ["1.2.0", "^1.2", true],
    ["1.1.9", "^1.2", false],
    ["1.3.0", "^1.2.5", true],
    ["1.2.4", "^1.2.5", false],
    ["1.2.5", "^1.2.5", true],
    ["0.2.5", "^0.2", true],
    ["0.3.0", "^0.2", false],
    ["0.3.0", "^0", true],
    ["1.0", "^1", false],
    ["1.0.0", ">=1", false],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfiesCaret(version, range)).toBe(expected);
  });
});
