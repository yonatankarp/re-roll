import { describe, expect, it } from "vitest";
import {
  STILL_DWELL,
  dwell,
} from "../plugins/systems/dnd5.5e/ui/board-math.ts";

describe("the board's pacing", () => {
  it("keeps each moment's time, shortens it with reduced motion and drops it when skipping", () => {
    expect(dwell(1100, false, false)).toBe(1100);
    expect(dwell(1100, false, true)).toBe(STILL_DWELL);
    expect(dwell(250, false, true)).toBe(250);
    expect(dwell(1100, true, false)).toBe(0);
    expect(dwell(1100, true, true)).toBe(0);
  });
});
