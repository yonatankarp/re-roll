import type { SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { rollBonus } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import { partySight } from "../plugins/systems/dnd5.5e/core/fog.ts";
import {
  blindedTo,
  lightAt,
  seeing,
  sensesOf,
  unseenInvisible,
} from "../plugins/systems/dnd5.5e/core/sight.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import type { KnownAction } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { zonesOf } from "../plugins/systems/dnd5.5e/core/zones.ts";
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
  trait("umbral", [{ kind: "umbral" }]),
  trait("shadow-born", [{ kind: "seesOwnDarkness" }]),
  block("dark-eyed", { text: "Senses Darkvision 60 ft." }),
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
    expect(unseenInvisible(near, seen, { ...run, state })).toBe(false);
    expect(unseenInvisible(far, seen, { ...run, state })).toBe(true);
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

const zone = (fields: Record<string, unknown>): ActiveEffect =>
  effect({
    kind: "zone",
    at: { x: 0, y: 0 },
    radius: 5,
    ...fields,
  } as ActiveEffect["modifier"]);
const holding = (actor: Actor, ...effects: ActiveEffect[]): Actor => ({
  ...actor,
  activeEffects: [...actor.activeEffects, ...effects],
});
const apply = (state: DndState, events: readonly SystemEvent[]): DndState =>
  events.reduce(applyDndEvent, state);

describe("light and darkness", () => {
  it("sheds Dim Light beyond a light's Bright, and a shade dims a step", async () => {
    const run = await runWith(FIXTURES);
    const torch = holding(
      at(monster("t", "plain"), 0, 0),
      zone({ zone: "light", dim: 5 }),
    );
    const dark = onMap(["...."], [torch], "dark");
    expect(lightAt({ x: 1, y: 0 }, dark, run)).toBe("bright");
    expect(lightAt({ x: 2, y: 0 }, dark, run)).toBe("dim");
    expect(lightAt({ x: 3, y: 0 }, dark, run)).toBe("dark");
    const moil = holding(
      at(monster("m", "plain"), 0, 0),
      zone({ zone: "shade", radius: 10 }),
    );
    const lit = onMap(["...."], [moil]);
    expect(lightAt({ x: 1, y: 0 }, lit, run)).toBe("dim");
    expect(lightAt({ x: 3, y: 0 }, lit, run)).toBe("bright");
    // A creature outlined by Faerie Fire sheds Dim Light round itself.
    const outlined = holding(
      at(monster("o", "plain"), 3, 0),
      effect({ kind: "sheds", light: "dim", feet: 5 }),
    );
    expect(
      lightAt({ x: 2, y: 0 }, onMap(["...."], [outlined], "dark"), run),
    ).toBe("dim");
  });

  it("lets a caster see through Darkness it sees through, and a lantern show the Invisible", async () => {
    const run = await runWith(FIXTURES);
    const caster = holding(
      at(hero([]), 0, 0),
      zone({ zone: "darkness", radius: 10, ownerSees: true }),
    );
    const foe = at(monster("f", "plain"), 1, 0);
    const state = onMap(["...."], [caster, foe]);
    expect(seeing(caster, { x: 1, y: 0 }, state, run)).toBe("clear");
    expect(seeing(foe, { x: 0, y: 0 }, state, run)).toBe("none");
    // Power of Shadow sees through any Darkness of its own.
    const sorcerer = holding(
      at(hero(["shadow-born"]), 0, 0),
      zone({ zone: "darkness", radius: 10 }),
    );
    const own = onMap(["...."], [sorcerer, foe]);
    expect(seeing(sorcerer, { x: 1, y: 0 }, own, run)).toBe("clear");
    // A creature in a revealing light's Bright Light has no benefit from the Invisible condition.
    const ghost = invisible(at(monster("g", "plain"), 1, 0));
    const lantern = holding(
      at(hero([]), 0, 0),
      zone({ zone: "light", radius: 10, reveals: true }),
    );
    const shown = onMap(["...."], [lantern, ghost]);
    expect(unseenInvisible(ghost, lantern, { ...run, state: shown })).toBe(
      false,
    );
    const unlit = onMap(["...."], [at(hero([]), 0, 0), ghost]);
    expect(
      unseenInvisible(ghost, at(hero([]), 0, 0), { ...run, state: unlit }),
    ).toBe(true);
  });

  it("hides Umbral Sight from Darkvision in darkness, and a shroud from all but Blindsight", async () => {
    const run = await runWith(FIXTURES);
    const ranger = at(hero(["umbral"]), 0, 0);
    const watcher = at(monster("w", "dark-eyed"), 2, 0);
    const state = onMap(["x..."], [ranger, watcher], "bright");
    expect(unseenInvisible(ranger, watcher, { ...run, state })).toBe(true);
    const seer = at(monster("s", "seer"), 2, 0);
    expect(
      unseenInvisible(ranger, seer, {
        ...run,
        state: onMap(["x..."], [ranger, seer]),
      }),
    ).toBe(false);
    const lit = onMap(["...."], [ranger, watcher]);
    expect(unseenInvisible(ranger, watcher, { ...run, state: lit })).toBe(
      false,
    );
    // Shadow of Moil's shroud: unseen but by Blindsight in range.
    const moiled = holding(at(hero([]), 0, 0), effect({ kind: "shrouded" }));
    const bat = at(monster("b", "bat"), 2, 0);
    expect(unseenInvisible(moiled, watcher, { ...run, state: lit })).toBe(true);
    expect(
      unseenInvisible(moiled, bat, {
        ...run,
        state: onMap(["...."], [moiled, bat]),
      }),
    ).toBe(false);
  });

  it("ends Darkness of a low enough level that sunlight overlaps, and grants a zone's bonus", async () => {
    const run = await runWith(FIXTURES);
    const shadow = holding(at(monster("d", "plain"), 3, 0), {
      ...zone({ zone: "darkness", at: { x: 3, y: 0 }, radius: 10 }),
      sourceId: "spell:srd52:spell/darkness",
      casterId: "d",
      level: 2,
    });
    const caster = at(hero([]), 0, 0);
    const start = onMap(["......"], [caster, shadow]);
    const daylight: KnownAction = {
      id: "spell:test:spell/daylight",
      name: "Daylight",
      spellLevel: 3,
      activation: {
        cost: ["action"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [
            {
              kind: "zone",
              zone: "sunlight",
              radius: 5,
              duration: { minutes: 60 },
            },
            { kind: "disperse", zones: ["darkness"], maxLevel: 3 },
          ],
        },
      },
    };
    const context = {
      ...run,
      state: start,
      dice: { below: () => 0, roll: () => 1 },
    };
    const cast = resolveAction(daylight, caster, [], context, 3);
    const after = apply(start, cast.events ?? []);
    expect(zonesOf(after).map((item) => item.zone)).toEqual(["sunlight"]);
    // Pass without Trace's +10 to Stealth for allies in its aura.
    const aura = holding(
      at(hero([]), 0, 0),
      zone({
        zone: "area",
        radius: 30,
        follows: true,
        area: {
          side: "ally",
          self: true,
          grants: [
            {
              kind: "bonus",
              to: "checks",
              skill: "stealth",
              amount: { bonus: { base: 10, add: [] } },
            },
          ],
        },
      }),
    );
    const friend = at(monster("p", "plain", "party"), 1, 0);
    const aided = onMap(["...."], [aura, friend]);
    const dice = { below: () => 0, roll: () => 1 };
    expect(
      rollBonus(friend, "checks", { ...run, state: aided, dice }, "stealth"),
    ).toBe(10);
    expect(
      rollBonus(friend, "checks", { ...run, state: aided, dice }, "athletics"),
    ).toBe(0);
  });
});
