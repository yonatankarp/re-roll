import type { RunContext } from "../engine/run/turn.ts";
import { codeKeys } from "../plugins/systems/dnd5.5e/core/grid.ts";
import {
  type Actor,
  type DndState,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { testRun } from "./feat-fixtures.ts";

// Made-up stat blocks, traits and maps for senses, light, hiding and movement (#172, #173, #200): ids and mechanics
// only.

export const block = (
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
) => ({
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

export async function runWith(
  fixtures: readonly { readonly id: string }[],
): Promise<RunContext> {
  const base = await testRun();
  const byId = new Map(fixtures.map((entry) => [entry.id, entry]));
  return {
    ...base,
    content: (id) => byId.get(id) ?? base.content(id),
    contentIds: () => [...base.contentIds(), ...byId.keys()].sort(),
  };
}

export function monster(
  id: string,
  kind: string,
  side: "enemy" | "party" = "enemy",
): Actor {
  return freshActor({
    id,
    name: id,
    side,
    source: { kind: "monster", statBlockId: `test:monster/${kind}` },
    hp: 50,
    inventory: [],
  });
}

export const at = (actor: Actor, x: number, y: number): Actor => ({
  ...actor,
  position: { x, y },
});

// A fight on a map drawn as rows: "#" walls, "~" difficult terrain, "d" dim light and "x" darkness, under `light`.
export function onMap(
  rows: readonly string[],
  actors: readonly Actor[],
  light: "bright" | "dim" | "dark" = "bright",
): DndState {
  const terrain = {
    difficult: codeKeys(rows, "~"),
    half: codeKeys(rows, "h"),
    threeQuarters: codeKeys(rows, "t"),
    dim: codeKeys(rows, "d"),
    dark: codeKeys(rows, "x"),
    light,
  };
  return {
    actors: Object.fromEntries(actors.map((item) => [item.id, item])),
    combat: {
      encounter: "arena",
      order: actors.map((item) => item.id),
      index: 0,
      round: 1,
      grid: { width: rows[0]?.length ?? 0, height: rows.length },
      walls: codeKeys(rows, "#"),
      terrain,
    },
  };
}
