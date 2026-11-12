import { describe, expect, it } from "vitest";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";
import { FRAME_KINDS, NS } from "../plugins/systems/dnd5.5e/core/state.ts";

// frame() takes only a kind from FRAME_KINDS, so this keeps the list and the registered handlers in step.
describe("the D&D frame kinds", () => {
  it("lists exactly the frames the system registers", () => {
    expect(Object.keys(dnd55e.frames).sort()).toEqual(
      FRAME_KINDS.map((kind) => `${NS}:${kind}`).sort(),
    );
  });
});
