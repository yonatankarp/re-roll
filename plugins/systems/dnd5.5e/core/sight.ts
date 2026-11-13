// What a battle map's ground, cover and light do in a fight: cover between two squares, and who can see whom.
import type { ContentAccess } from "#sdk";
import {
  type Cover,
  type Square,
  codeKeys,
  coverBetween,
  distanceFeet,
  squareKey,
} from "./grid.ts";
import type { Battlemap } from "./schemas.ts";
import { FeatureSchema, MonsterSchema, SpeciesSchema } from "./schemas.ts";
import { type Actor, type DndState, type Terrain, isDead } from "./state.ts";
import { lookup } from "./stats.ts";
import { swallowerOf } from "./combat/swallow.ts";

// A map's codes as squares, or nothing for a map that marks none, so fights on older maps stay as they were.
export function terrainOf(map: Battlemap): Terrain | null {
  const terrain = {
    difficult: codeKeys(map.walls, "~"),
    half: codeKeys(map.walls, "h"),
    threeQuarters: codeKeys(map.walls, "t"),
    dim: codeKeys(map.walls, "d"),
    dark: codeKeys(map.walls, "x"),
    light: map.light ?? "bright",
  } as const;
  const marked = [
    terrain.difficult,
    terrain.half,
    terrain.threeQuarters,
    terrain.dim,
    terrain.dark,
  ].some((keys) => keys.length > 0);
  return marked || terrain.light !== "bright" ? terrain : null;
}

// The state never changes in place, so a list's set can be kept for as long as the list lives.
const sets = new WeakMap<readonly string[], ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();
function setOf(keys: readonly string[] | undefined): ReadonlySet<string> {
  if (!keys) return NONE;
  const known = sets.get(keys);
  if (known) return known;
  const made = new Set(keys);
  sets.set(keys, made);
  return made;
}

export function difficultSquares(state: DndState): ReadonlySet<string> {
  return setOf(state.combat?.terrain?.difficult);
}

// The cover `target` has against something coming from `from`. Creatures in the way count, except the target and
// anyone listed in `ignore`, such as the attacker.
export function coverFor(
  state: DndState,
  from: Square | null,
  target: Actor,
  ignore: readonly string[] = [],
): Cover {
  const terrain = state.combat?.terrain;
  const creatures = new Set(
    Object.values(state.actors).flatMap((item) =>
      item.position &&
      item.id !== target.id &&
      !ignore.includes(item.id) &&
      !isDead(item)
        ? [squareKey(item.position)]
        : [],
    ),
  );
  return coverBetween(
    from,
    target.position,
    setOf(state.combat?.walls),
    {
      half: setOf(terrain?.half),
      threeQuarters: setOf(terrain?.threeQuarters),
    },
    creatures,
  );
}

// What cover adds to AC and Dexterity saves. Total cover has no bonus, since nothing can target through it.
export function coverBonus(cover: Cover): number {
  return cover === "total" ? 0 : cover;
}

export function lightAt(
  square: Square | null,
  state: DndState,
): "bright" | "dim" | "dark" {
  const terrain = state.combat?.terrain;
  if (!terrain || !square) return "bright";
  const key = squareKey(square);
  if (setOf(terrain.dark).has(key)) return "dark";
  if (setOf(terrain.dim).has(key)) return "dim";
  return terrain.light;
}

const SEES_IN_DARK = /\b(?:darkvision|blindsight|truesight) (\d+) ft/gi;

// How far a creature sees without light, in feet: Darkvision from its species, or Darkvision, Blindsight or
// Truesight from its stat block's senses. 0 for none.
// shortcut: Blindsight and Truesight count as Darkvision, so magical darkness and invisibility aren't told apart.
export function darkvisionOf(actor: Actor, access: ContentAccess): number {
  if (actor.source.kind === "monster") {
    const { text = "" } = lookup(
      access,
      MonsterSchema,
      actor.source.statBlockId,
    );
    return Math.max(
      0,
      ...[...text.matchAll(SEES_IN_DARK)].map((match) => Number(match[1])),
    );
  }
  const { build } = actor.source;
  if (!build) return 0;
  const species = lookup(access, SpeciesSchema, build.speciesId);
  return Math.max(
    0,
    ...species.traits.flatMap((id) => {
      const feature = lookup(access, FeatureSchema, id);
      // A trait named Darkvision, or one that lists all the species' traits starting with it, as the SRD's do.
      if (
        !/\bdarkvision\b/i.test(feature.name) &&
        !/^darkvision\b/i.test(feature.text)
      ) {
        return [];
      }
      const range = /(\d+) feet/.exec(feature.text);
      return [range ? Number(range[1]) : 60];
    }),
  );
}

// How well `viewer` sees the square `at`: Darkness hides it from a creature without Darkvision in range, and
// Darkvision sees darkness as dim light. Dim light gives Disadvantage on Perception that relies on sight.
export function seeing(
  viewer: Actor,
  at: Square | null,
  state: DndState,
  access: ContentAccess,
): "clear" | "dim" | "none" {
  const light = lightAt(at, state);
  if (light === "bright") return "clear";
  const darkvision = darkvisionOf(viewer, access);
  const inRange =
    darkvision > 0 && distanceFeet(viewer.position, at) <= darkvision;
  if (light === "dark") return inRange ? "dim" : "none";
  return inRange ? "clear" : "dim";
}

// Whether total cover keeps `target` out of reach of anything `actor` aims at it.
export function behindTotalCover(
  state: DndState,
  actor: Actor,
  target: Actor,
): boolean {
  // From inside a swallower, nothing stands between them, wherever it has carried the creature.
  return (
    actor.id !== target.id &&
    swallowerOf(actor) !== target.id &&
    coverFor(state, actor.position, target, [actor.id]) === "total"
  );
}
