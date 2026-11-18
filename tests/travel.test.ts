import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { describe, expect, it } from "vitest";
import { resolveAction } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { restHampered } from "../plugins/systems/dnd5.5e/core/environment.ts";
import { type Actor, NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import type { KnownAction } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, hero, scripted, settle, testRun } from "./feat-fixtures.ts";

// #152's travel, shelters and wards, with the test's own effects: ids and mechanics only.
const ESCAPE: KnownAction = {
  id: "spell:test:spell/away",
  name: "Away",
  activation: {
    cost: [],
    targeting: { self: true },
    resolution: {
      kind: "automatic",
      damage: [],
      effects: [{ kind: "escape" }],
    },
  },
  spellLevel: 7,
};
const kinds = (events: readonly SystemEvent[] = []) =>
  events.map((event) => event.kind);
const foe = (): Actor => ({
  ...hero([], { id: "foe" }),
  side: "enemy",
  hp: 30,
  position: { x: 3, y: 0 },
});
const party = (extra: Partial<Actor> = {}): Actor => ({
  ...hero([]),
  hp: 20,
  position: { x: 0, y: 0 },
  ...extra,
});

describe("travel, shelters and wards between scenes (#152)", () => {
  it("gets the party away from a fight it may flee, and does nothing where it may not", async () => {
    const run = await testRun();
    const fled = contextOf(run, [party(), foe()], scripted([]).dice);
    const free = {
      ...fled,
      state: {
        ...fled.state,
        combat: {
          encounter: "arena",
          order: [PLAYER_ACTOR, "foe"],
          index: 0,
          round: 1,
          canFlee: true,
        },
      },
    };
    const away = resolveAction(ESCAPE, party(), [party()], free);
    expect(away.frames?.map((item) => item.kind)).toContain(`${NS}:escape`);
    const held = resolveAction(ESCAPE, party(), [party()], fled);
    expect(held.frames?.map((item) => item.kind) ?? []).not.toContain(
      `${NS}:escape`,
    );
  });

  it("keeps a place's harm from a sheltered rest", async () => {
    const run = await testRun();
    const tired = party({ exhaustion: 2 });
    const access = {
      ...run,
      content: (id: string) =>
        id === "test:environmental-effect/storm"
          ? {
              id,
              name: "Storm",
              text: "Test.",
              source: "Test",
              rest: { keepExhaustion: true },
            }
          : run.content(id),
    };
    const outside = contextOf(access, [tired], scripted([]).dice).state;
    const stormy = { ...outside, ambient: ["test:environmental-effect/storm"] };
    expect(
      restHampered(tired, { ...access, state: stormy }).exhaustionFloor,
    ).toBe(2);
    const hut = {
      ...tired,
      activeEffects: [
        {
          sourceId: "test",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration" as const,
          modifier: { kind: "sheltered" as const },
        },
      ],
    };
    const covered = { ...stormy, actors: { [PLAYER_ACTOR]: hut } };
    expect(
      restHampered(hut, { ...access, state: covered }).exhaustionFloor,
    ).toBe(0);
  });

  it("sets off a readied ward at the first foe as the fight starts", async () => {
    const run = await testRun();
    const warded = party({
      activeEffects: [
        {
          sourceId: "spell:test:spell/glyph:scene",
          casterId: PLAYER_ACTOR,
          ends: "spellDuration",
          modifier: {
            kind: "prepared",
            alert: true,
            activation: {
              cost: [],
              targeting: { creatures: 1, range: 60, side: "enemy" },
              resolution: {
                kind: "automatic",
                damage: [{ amount: { bonus: { base: 7 } }, type: "fire" }],
                effects: [],
              },
            },
          },
        },
      ],
    });
    const { events } = settle(
      run,
      [warded, foe()],
      [{ kind: `${NS}:wardsSet`, payload: {} }],
      scripted([]).dice,
    );
    expect(kinds(events)).toContain(`${NS}:effectEnded`);
    const hurt = events.flatMap((event) =>
      event.kind === `${NS}:damaged` && "payload" in event
        ? [event.payload as { actor: string; amount: number }]
        : [],
    );
    expect(hurt).toContainEqual(
      expect.objectContaining({ actor: "foe", amount: 7 }),
    );
  });
});
