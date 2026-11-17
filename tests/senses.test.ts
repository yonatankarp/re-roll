import { describe, expect, it } from "vitest";
import { partySight } from "../plugins/systems/dnd5.5e/core/fog.ts";
import {
  blindedTo,
  seeing,
  sensesOf,
  unseenInvisible,
} from "../plugins/systems/dnd5.5e/core/sight.ts";
import type {
  ActiveEffect,
  Actor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { hero, trait } from "./feat-fixtures.ts";
import { at, block, monster, onMap, runWith } from "./senses-fixtures.ts";

// Senses (#172): Blindsight, Truesight and Darkvision that adds to what a creature has, on made-up traits.

const sense = (kind: string, feet: number, extend?: number) => ({
  kind: "modifier",
  modifier: { kind: "sense", sense: kind, feet, ...(extend ? { extend } : {}) },
});

const FIXTURES = [
  block("bat", { text: "Senses Blindsight 60 ft.; Passive Perception 11" }),
  block("seer", { text: "Senses Truesight 120 ft." }),
  block("plain"),
  trait("blind-fighter", [sense("blindsight", 10)]),
  trait("true-eyed", [sense("truesight", 30)]),
  trait("night-eyed", [sense("darkvision", 60, 60)]),
  trait("dark-born", [sense("darkvision", 60)]),
];

const effect = (modifier: ActiveEffect["modifier"]): ActiveEffect => ({
  sourceId: "test",
  casterId: "test",
  modifier,
  ends: "spellDuration",
});
const invisible = (actor: Actor): Actor => ({
  ...actor,
  activeEffects: [
    ...actor.activeEffects,
    effect({ kind: "condition", condition: "invisible" }),
  ],
});

describe("senses", () => {
  it("reads printed senses and traits, and adds to Darkvision a creature already has", async () => {
    const run = await runWith(FIXTURES);
    expect(sensesOf(monster("b", "bat"), run).blindsight).toBe(60);
    expect(sensesOf(monster("s", "seer"), run).truesight).toBe(120);
    expect(sensesOf(monster("s", "seer"), run).darkvision).toBe(0);
    expect(sensesOf(hero(["night-eyed"]), run).darkvision).toBe(60);
    expect(sensesOf(hero(["dark-born", "night-eyed"]), run).darkvision).toBe(
      120,
    );
  });

  it("sees within Blindsight in darkness and fog, and past the Invisible condition", async () => {
    const run = await runWith(FIXTURES);
    const seen = at(hero(["blind-fighter"]), 0, 0);
    const near = at(invisible(monster("a", "plain")), 2, 0);
    const far = at(invisible(monster("b", "plain")), 4, 0);
    const state = onMap(["....."], [seen, near, far], "dark");
    expect(seeing(seen, { x: 2, y: 0 }, state, run)).toBe("clear");
    expect(seeing(seen, { x: 4, y: 0 }, state, run)).toBe("none");
    expect(unseenInvisible(near, seen, run)).toBe(false);
    expect(unseenInvisible(far, seen, run)).toBe(true);
    // Blinded, it still sees what Blindsight reaches.
    const blind: Actor = {
      ...seen,
      activeEffects: [effect({ kind: "condition", condition: "blinded" })],
    };
    expect(blindedTo(blind, near, run)).toBe(false);
    expect(blindedTo(blind, far, run)).toBe(true);
  });

  it("sees in magical darkness with Truesight, and finds a foe that hid", async () => {
    const run = await runWith(FIXTURES);
    const eyed = at(hero(["true-eyed"]), 0, 0);
    const lurker = at(monster("l", "plain"), 3, 0);
    const darkness = effect({
      kind: "zone",
      zone: "darkness",
      at: { x: 3, y: 0 },
      radius: 5,
    });
    const caster = {
      ...at(monster("c", "plain"), 6, 0),
      activeEffects: [darkness],
    };
    const state = onMap(["......."], [eyed, lurker, caster]);
    expect(seeing(eyed, { x: 3, y: 0 }, state, run)).toBe("clear");
    const plain = at(hero([]), 0, 0);
    expect(seeing(plain, { x: 3, y: 0 }, state, run)).toBe("none");
    // A foe that hid within Truesight is still in view.
    const hidden: Actor = {
      ...lurker,
      activeEffects: [
        effect({ kind: "tactic", tactic: "hidden", value: 20 }),
        effect({ kind: "condition", condition: "invisible" }),
      ],
    };
    const open = onMap(["......."], [eyed, hidden]);
    expect(partySight(open, run).foes.has("l")).toBe(true);
    const unaided = onMap(["......."], [plain, hidden]);
    expect(partySight(unaided, run).foes.has("l")).toBe(false);
  });
});
