// What a battle map's ground, cover and light do in a fight: cover between two squares, and who can see whom.
import type { ContentAccess } from "#sdk";
import { everySquare } from "./environment.ts";
import {
  type Cover,
  type Square,
  codeKeys,
  coverBetween,
  distanceFeet,
  squareKey,
} from "./grid.ts";
import type { Battlemap, Modifier } from "./schemas.ts";
import {
  CompanionSchema,
  FeatureSchema,
  MonsterSchema,
  SpeciesSchema,
} from "./schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  type Terrain,
  hasCondition,
  invisibleTo,
  isDead,
} from "./state.ts";
import { lookup, passiveModifiers } from "./stats.ts";
import { swallowerOf } from "./combat/swallow.ts";
import {
  blockingSet,
  glows,
  lit,
  revealed,
  shaded,
  obscuring,
  statsOf,
  thornKeys,
  coverKeys,
  type ZoneKind,
} from "./zones.ts";

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
  const water = codeKeys(map.walls, "w");
  const marked = [
    terrain.difficult,
    terrain.half,
    terrain.threeQuarters,
    terrain.dim,
    terrain.dark,
  ].some((keys) => keys.length > 0);
  if (water.length > 0) return { ...terrain, water };
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
  const icy = everySquare(state); // Slippery Ice: the whole map (environment.ts)
  return thorns.length > 0 || icy.length > 0
    ? new Set([...ground, ...thorns, ...icy])
    : ground;
}

// Whether `actor` stands in the space of an ally whose trait gives it Half Cover there, as Overhanging Branches does.
function coveredByHost(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): boolean {
  const at = actor.position;
  if (!at) return false;
  return Object.values(state.actors).some(
    (host) =>
      host.id !== actor.id &&
      host.side === actor.side &&
      host.source.kind === "monster" &&
      !isDead(host) &&
      host.position?.x === at.x &&
      host.position.y === at.y &&
      lookup(access, MonsterSchema, host.source.statBlockId).passives.some(
        (passive) =>
          passive.kind === "shareSpace" &&
          passive.who === "allies" &&
          passive.cover,
      ),
  );
}

// The cover `target` has against something coming from `from`. Creatures in the way count, except the target and
// anyone listed in `ignore`, such as the attacker. With `access`, so does an ally's space that covers it.
export function coverFor(
  state: DndState,
  from: Square | null,
  target: Actor,
  ignore: readonly string[] = [],
  access?: ContentAccess,
): Cover {
  const found = squaresCover(state, from, target, ignore);
  return found !== "total" && access && coveredByHost(target, state, access)
    ? (Math.max(found, 2) as Cover)
    : found;
}

function squaresCover(
  state: DndState,
  from: Square | null,
  target: Actor,
  ignore: readonly string[],
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
    // shortcut: a wall that stops only sight, as Wall of Fire, is total cover too, so nothing is aimed through
    // it; tell seeing from aiming here if attacks at unseen creatures across one should play.
    blockingSet(state, "sight"),
    {
      half: withZones(setOf(terrain?.half), coverKeys(state, "half")),
      threeQuarters: withZones(
        setOf(terrain?.threeQuarters),
        coverKeys(state, "threeQuarters"),
      ),
    },
    creatures,
  );
}

const withZones = (
  map: ReadonlySet<string>,
  zones: readonly string[],
): ReadonlySet<string> => (zones.length === 0 ? map : new Set([...map, ...zones]));

// What cover adds to AC and Dexterity saves. Total cover has no bonus, since nothing can target through it.
export function coverBonus(cover: Cover): number {
  return cover === "total" ? 0 : cover;
}

export function lightAt(
  square: Square | null,
  state: DndState,
  access?: ContentAccess, // for the light monsters shed, as a flameskull's
): "bright" | "dim" | "dark" {
  const light = unshadedLight(square, state, access);
  if (!shaded(square, state)) return light;
  return light === "bright" ? "dim" : "dark";
}

function unshadedLight(
  square: Square | null,
  state: DndState,
  access?: ContentAccess,
): "bright" | "dim" | "dark" {
  const terrain = state.combat?.terrain;
  if (!terrain || !square || lit(square, state, access)) return "bright";
  const key = squareKey(square);
  const ground = setOf(terrain.dark).has(key)
    ? "dark"
    : setOf(terrain.dim).has(key)
      ? "dim"
      : terrain.light;
  return ground !== "bright" && glows(square, state, access) ? "dim" : ground;
}

// A sense reaches a square this many feet away, when the creature has it at all.
const reaches = (feet: number, range: number): boolean =>
  range > 0 && feet <= range;

const PRINTED_SENSE = /\b(darkvision|blindsight|truesight) (\d+) ft/gi;

export interface Senses {
  readonly darkvision: number; // sees Darkness as Dim Light, and Dim Light as Bright
  readonly blindsight: number; // sees without light: through fog and darkness, the Invisible, while Blinded
  readonly truesight: number; // sees in magical and normal darkness, and the Invisible
  readonly devilsSight: number; // sees normally in Dim Light and Darkness, magical too, as Devil's Sight
  readonly ownDarkness: boolean; // sees through the Darkness of its own spells, as Power of Shadow
  readonly xray: number; // sees through solid walls, as a Ring of X-ray Vision
}

type SenseModifier = Extract<Modifier, { kind: "sense" }>;

// The senses as feet, from the modifiers a creature has: Darkvision and True Seeing's `darkvision`, and `sense`.
// Darkvision that only extends what the creature already has is added last.
function fromModifiers(
  base: Senses,
  modifiers: readonly ActiveEffect["modifier"][],
): Senses {
  let { darkvision, blindsight, truesight, xray } = base;
  const extending: SenseModifier[] = [];
  for (const modifier of modifiers) {
    if (modifier.kind === "darkvision") {
      darkvision = Math.max(darkvision, modifier.feet);
      if (modifier.truesight) truesight = Math.max(truesight, modifier.feet);
    } else if (modifier.kind === "sense") {
      if (modifier.extend) extending.push(modifier);
      else if (modifier.sense === "darkvision")
        darkvision = Math.max(darkvision, modifier.feet);
      else if (modifier.sense === "blindsight")
        blindsight = Math.max(blindsight, modifier.feet);
      else if (modifier.sense === "xray") xray = Math.max(xray, modifier.feet);
      else truesight = Math.max(truesight, modifier.feet);
    }
  }
  for (const { feet, extend = 0 } of extending) {
    darkvision = darkvision > 0 ? darkvision + extend : feet;
  }
  return { ...base, darkvision, blindsight, truesight, xray };
}

const NO_SENSES: Senses = {
  darkvision: 0,
  blindsight: 0,
  truesight: 0,
  devilsSight: 0,
  ownDarkness: false,
  xray: 0,
};

// What a stat block's or companion's printed senses give.
function printedSenses(text: string): Senses {
  const found = { ...NO_SENSES };
  for (const match of text.matchAll(PRINTED_SENSE)) {
    const sense = match[1]?.toLowerCase() as
      "darkvision" | "blindsight" | "truesight";
    found[sense] = Math.max(found[sense], Number(match[2]));
  }
  return found;
}

// A species trait named Darkvision, or one that lists all the species' traits starting with it, as the SRD's do.
function speciesDarkvision(actor: Actor, access: ContentAccess): number {
  if (actor.source.kind !== "character" || !actor.source.build) return 0;
  const species = lookup(access, SpeciesSchema, actor.source.build.speciesId);
  return Math.max(
    0,
    ...species.traits.flatMap((id) => {
      const feature = lookup(access, FeatureSchema, id);
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

// Kept per actor object, which never changes in place, since sight is asked about on every square a turn weighs.
const sensesKept = new WeakMap<Actor, Senses>();

// How far a creature sees each way: its stat block's printed senses or its species' Darkvision, then what its traits,
// worn items and the effects on it give (Blind Fighting, Goggles of Night, True Seeing, Devil's Sight).
export function sensesOf(actor: Actor, access: ContentAccess): Senses {
  const known = sensesKept.get(actor);
  if (known) return known;
  const stats = statsOf(actor, access);
  const printed =
    actor.source.kind === "monster"
      ? printedSenses(
          lookup(access, MonsterSchema, actor.source.statBlockId).text ?? "",
        )
      : actor.source.kind === "summon"
        ? printedSenses(
            lookup(access, CompanionSchema, actor.source.companion).text,
          )
        : { ...NO_SENSES, darkvision: speciesDarkvision(actor, access) };
  const base = {
    ...printed,
    ownDarkness: stats.passives.some(
      (passive) => passive.kind === "seesOwnDarkness",
    ),
    devilsSight: Math.max(
      0,
      ...stats.passives.flatMap((passive) =>
        passive.kind === "seesInDarkness" ? [passive.feet] : [],
      ),
    ),
  };
  const senses = fromModifiers(base, [
    ...passiveModifiers(stats.passives),
    ...actor.activeEffects.map(({ modifier }) => modifier),
  ]);
  sensesKept.set(actor, senses);
  return senses;
}

// How far a creature sees without light, in feet: Darkvision, or Devil's Sight, which sees darkness better still.
export function darkvisionOf(actor: Actor, access: ContentAccess): number {
  const senses = sensesOf(actor, access);
  return Math.max(senses.darkvision, senses.devilsSight);
}

// How far a creature sees into a zone: Blindsight sees through fog and darkness, Truesight or Devil's Sight only
// through darkness. 0 for not at all.
export function seesThrough(
  viewer: Actor,
  zone: ZoneKind,
  access: ContentAccess,
): number {
  const senses = sensesOf(viewer, access);
  return zone === "darkness"
    ? Math.max(senses.blindsight, senses.truesight, senses.devilsSight)
    : senses.blindsight;
}

// Whether `viewer` sees past `target`'s Invisible condition: See Invisibility, or Blindsight or Truesight reaching it.
export function seesInvisible(
  viewer: Actor,
  target: Actor,
  access: ContentAccess,
): boolean {
  if (
    viewer.activeEffects.some(
      ({ modifier }) => modifier.kind === "seeInvisible",
    )
  ) {
    return true;
  }
  const senses = sensesOf(viewer, access);
  const feet = distanceFeet(viewer.position, target.position);
  return reaches(feet, Math.max(senses.blindsight, senses.truesight));
}

// A Blinded viewer sees nothing beyond its Blindsight.
export function blindedTo(
  viewer: Actor,
  target: Actor,
  access: ContentAccess,
): boolean {
  return (
    hasCondition(viewer, "blinded") &&
    !reaches(
      distanceFeet(viewer.position, target.position),
      sensesOf(viewer, access).blindsight,
    )
  );
}

// How well `viewer` sees the square `at`: Blindsight sees whatever its range holds; a zone hides what's in it from all
// but the senses that pierce it; Darkness hides from a creature without Darkvision in range, Darkvision sees it as
// Dim Light, and Truesight or Devil's Sight as plainly as Bright. Dim Light gives Disadvantage on Perception that relies
// on sight.
export function seeing(
  viewer: Actor,
  at: Square | null,
  state: DndState,
  access: ContentAccess,
  senses: Senses = sensesOf(viewer, access), // the viewer's, when it stands somewhere else for the question
): "clear" | "dim" | "none" {
  const feet = distanceFeet(viewer.position, at);
  // Shadow Arrow: nothing farther than a few feet away.
  const limit = viewer.activeEffects.reduce(
    (least, { modifier }) =>
      modifier.kind === "sightLimit" ? Math.min(least, modifier.feet) : least,
    Infinity,
  );
  if (feet > limit) return "none";
  if (reaches(feet, senses.blindsight)) return "clear";
  // shortcut: a zone hides whatever is in it and blinds whoever stands in it, whichever way the line runs.
  const hidden =
    obscuring(at, state, viewer.id, senses.ownDarkness) ??
    obscuring(viewer.position, state, viewer.id, senses.ownDarkness);
  if (hidden) {
    // Truesight sees through Darkness and illusions alike.
    const through =
      hidden === "darkness"
        ? Math.max(senses.truesight, senses.devilsSight)
        : hidden === "image"
          ? senses.truesight
          : 0;
    return reaches(feet, through) ? "clear" : "none";
  }
  const light = lightAt(at, state, access);
  if (light === "bright") return "clear";
  if (reaches(feet, senses.devilsSight)) return "clear";
  if (light === "dark" && reaches(feet, senses.truesight)) return "clear";
  const inRange = reaches(feet, senses.darkvision);
  if (light === "dark") return inRange ? "dim" : "none";
  return inRange ? "clear" : "dim";
}

// The cover `target` has against what `actor` does to it. From inside its swallower there is none, wherever
// the creature's old square lies.
export function coverAgainst(
  state: DndState,
  actor: Actor,
  target: Actor,
  access?: ContentAccess,
): number {
  return swallowerOf(actor) === target.id
    ? 0
    : coverBonus(coverFor(state, actor.position, target, [actor.id], access));
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

// Invisible to `viewer`, which nothing it has sees past, Blindsight and Truesight in range included, and not in the
// Bright Light of a light that shows the Invisible. Shadow of Moil's shroud hides the bearer as well from all but
// Blindsight, and Umbral Sight from a viewer that sees it in Darkness only by Darkvision.
export function unseenInvisible(
  target: Actor,
  viewer: Actor,
  context: ContentAccess & { readonly state: DndState },
): boolean {
  if (target.id === viewer.id) return false;
  const feet = distanceFeet(viewer.position, target.position);
  if (
    target.activeEffects.some(({ modifier }) => modifier.kind === "shrouded") &&
    !reaches(feet, sensesOf(viewer, context).blindsight)
  ) {
    return true;
  }
  if (umbralTo(target, viewer, context.state, context)) return true;
  return (
    invisibleTo(target, viewer) &&
    !seesInvisible(viewer, target, context) &&
    !revealed(target.position, context.state, context)
  );
}

// Umbral Sight: the bearer, in Darkness, is unseen by a viewer whose only way to see it there is Darkvision.
export function umbralTo(
  target: Actor,
  viewer: Actor,
  state: DndState,
  access: ContentAccess,
): boolean {
  if (!statsOf(target, access).passives.some((p) => p.kind === "umbral")) {
    return false;
  }
  if (lightAt(target.position, state, access) !== "dark") return false;
  const feet = distanceFeet(viewer.position, target.position);
  const senses = sensesOf(viewer, access);
  return !reaches(
    feet,
    Math.max(senses.blindsight, senses.truesight, senses.devilsSight),
  );
}
