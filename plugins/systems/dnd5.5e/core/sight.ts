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
import { deriveStats, lookup } from "./stats.ts";
import { swallowerOf } from "./combat/swallow.ts";
import { lit, obscuring, thornKeys, type ZoneKind } from "./zones.ts";

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
  const thorns = thornKeys(state);
  const ground = setOf(state.combat?.terrain?.difficult);
  return thorns.length > 0 ? new Set([...ground, ...thorns]) : ground;
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
  if (!terrain || !square || lit(square, state)) return "bright";
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
    ...deriveStats(actor, access).passives.flatMap((passive) =>
      passive.kind === "seesInDarkness" ? [passive.feet] : [],
    ),
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

const SEES_THROUGH = /\b(blindsight|truesight) (\d+) ft/gi;

// How far a creature sees into a zone: Blindsight sees through fog and darkness, Truesight or Devil's Sight only
// through darkness. 0 for not at all.
export function seesThrough(
  viewer: Actor,
  zone: ZoneKind,
  access: ContentAccess,
): number {
  const text =
    viewer.source.kind === "monster"
      ? (lookup(access, MonsterSchema, viewer.source.statBlockId).text ?? "")
      : "";
  return Math.max(
    0,
    ...[...text.matchAll(SEES_THROUGH)].flatMap((match) =>
      zone === "darkness" || match[1]?.toLowerCase() === "blindsight"
        ? [Number(match[2])]
        : [],
    ),
    ...(zone === "darkness" && viewer.source.kind === "character"
      ? deriveStats(viewer, access).passives.flatMap((passive) =>
          passive.kind === "seesInDarkness" ? [passive.feet] : [],
        )
      : []),
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
  // shortcut: a zone hides whatever is in it and blinds whoever stands in it, whichever way the line runs.
  const hidden = obscuring(at, state) ?? obscuring(viewer.position, state);
  if (hidden) {
    const feet = seesThrough(viewer, hidden, access);
    return feet > 0 && distanceFeet(viewer.position, at) <= feet
      ? "clear"
      : "none";
  }
  const light = lightAt(at, state);
  if (light === "bright") return "clear";
  const darkvision = darkvisionOf(viewer, access);
  const inRange =
    darkvision > 0 && distanceFeet(viewer.position, at) <= darkvision;
  if (light === "dark") return inRange ? "dim" : "none";
  return inRange ? "clear" : "dim";
}

// The cover `target` has against what `actor` does to it. From inside its swallower there is none, wherever
// the creature's old square lies.
export function coverAgainst(
  state: DndState,
  actor: Actor,
  target: Actor,
): number {
  return swallowerOf(actor) === target.id
    ? 0
    : coverBonus(coverFor(state, actor.position, target, [actor.id]));
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
