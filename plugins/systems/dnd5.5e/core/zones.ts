import type { ContentAccess } from "#sdk";
import type {
  Ability,
  AreaEffect,
  Damage,
  Modifier,
  ZoneKind,
} from "./schemas.ts";
import {
  type Actor,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDead,
} from "./state.ts";
import { distanceFeet, type Square, squareKey, wallSet } from "./grid.ts";
import { deriveStats, type KnownAction, type Stats } from "./stats.ts";
import { spellOf } from "./combat/dispel.ts";
import { lightAt } from "./sight.ts";

// Lasting areas on the map: what a spell leaves (Darkness, Fog Cloud, Spike Growth, Spirit Guardians, a wall), kept
// as an effect on its caster so it ends with the caster's Concentration or the spell's rounds, and the auras a
// monster's stat block gives it (Stench, Fire Aura, Illumination), which move with it.

export type { ZoneKind };

export interface Zone {
  readonly zone: ZoneKind;
  readonly at: Square; // its centre now: the owner's square for one that moves with it
  readonly radius: number;
  readonly damage?: readonly Damage[] | undefined;
  readonly owner: string; // the creature it belongs to
  readonly sourceId: string; // the spell, or the monster's trait as "aura:<name>"
  readonly follows: boolean;
  readonly area?: AreaEffect | undefined;
  readonly blocks?: readonly string[] | undefined; // a wall's squares
  readonly name?: string | undefined; // what made it, for the log and the board
  readonly level?: number | undefined; // the slot its spell was cast with
}

export const AURA = "aura:";

// A creature's stats as zones read them, kept per actor object, which never changes in place: auras, light
// sensitivity and creature types are asked for on every roll and every square a walk weighs.
const statsKept = new WeakMap<Actor, Stats>();
export function statsOf(actor: Actor, access: ContentAccess): Stats {
  const known = statsKept.get(actor);
  if (known) return known;
  const made = deriveStats(actor, access);
  statsKept.set(actor, made);
  return made;
}

// Spell zones need only the state; monster auras need the stat blocks too, so they come with `access`. Kept per
// state, which never changes in place.
const spellZones = new WeakMap<DndState, readonly Zone[]>();
const allZones = new WeakMap<DndState, readonly Zone[]>();

function castZones(state: DndState): readonly Zone[] {
  const known = spellZones.get(state);
  if (known) return known;
  const zones = !state.combat
    ? []
    : Object.values(state.actors).flatMap((actor) =>
        actor.activeEffects.flatMap(({ modifier, sourceId, level }): Zone[] => {
          if (modifier.kind !== "zone") return [];
          const at = modifier.follows ? actor.position : modifier.at;
          if (!at || (modifier.follows && isDead(actor))) return [];
          return [
            {
              zone: modifier.zone,
              at,
              radius: modifier.radius,
              damage: modifier.damage,
              owner: actor.id,
              sourceId,
              follows: modifier.follows === true,
              area: modifier.area,
              blocks: modifier.blocks,
              name: modifier.name,
              level,
            },
          ];
        }),
      );
  spellZones.set(state, zones);
  return zones;
}

// A sealed-away creature's areas reach nothing outside, and one Incapacitated loses those it must be awake for.
function auraZones(state: DndState, access: ContentAccess): readonly Zone[] {
  return Object.values(state.actors).flatMap((actor): Zone[] => {
    if (actor.source.kind === "character" || !actor.position) return [];
    if (isDead(actor) || sealed(actor)) return [];
    const at = actor.position;
    return statsOf(actor, access).passives.flatMap((passive): Zone[] =>
      passive.kind === "aura" &&
      !(passive.area.awake && hasCondition(actor, ...INCAPACITATING))
        ? [
            {
              zone: passive.zone,
              at,
              radius: passive.radius,
              owner: actor.id,
              sourceId: `${AURA}${passive.name}`,
              follows: true,
              area: passive.area,
              name: passive.name,
            },
          ]
        : [],
    );
  });
}

export function zonesOf(
  state: DndState,
  access?: ContentAccess,
): readonly Zone[] {
  if (!access || !state.combat) return castZones(state);
  const known = allZones.get(state);
  if (known) return known;
  const zones = [...castZones(state), ...auraZones(state, access)];
  allZones.set(state, zones);
  return zones;
}

export const inZone = (zone: Zone, square: Square | null): boolean =>
  square !== null && distanceFeet(zone.at, square) <= zone.radius;

export const sealed = (actor: Actor): boolean =>
  actor.activeEffects.some(({ modifier }) => modifier.kind === "sealed");

// Whether a zone's effects reach `actor`: its side and kind, never the bearer of one that moves with it, and not
// a creature that saved against it for good.
export function affects(
  zone: Zone,
  actor: Actor,
  state: DndState,
  access?: ContentAccess,
): boolean {
  const owner = state.actors[zone.owner];
  const area = zone.area ?? {};
  if (!owner || isDead(actor) || sealed(actor)) return false;
  if (zone.follows && actor.id === owner.id && !area.self) return false;
  if (area.side === "enemy" && actor.side === owner.side) return false;
  if (area.side === "ally" && actor.side !== owner.side) return false;
  if (
    area.bloodied &&
    (!access || actor.hp * 2 > statsOf(actor, access).maxHp)
  ) {
    return false;
  }
  if (area.creatureTypes || area.exceptTypes) {
    const type = access ? statsOf(actor, access).creatureType : undefined;
    if (area.creatureTypes && !area.creatureTypes.includes(type ?? "")) {
      return false;
    }
    if (area.exceptTypes?.includes(type ?? "")) return false;
  }
  return !actor.activeEffects.some(
    ({ modifier, sourceId, casterId }) =>
      modifier.kind === "areaImmunity" &&
      sourceId === zone.sourceId &&
      casterId === zone.owner,
  );
}

// The zones whose effects reach `actor` where it stands, or would stand at `at`.
export function zonesOn(
  actor: Actor,
  state: DndState,
  access?: ContentAccess,
  at: Square | null = actor.position,
): readonly Zone[] {
  return zonesOf(state, access).filter(
    (zone) =>
      zone.area !== undefined &&
      inZone(zone, at) &&
      affects(zone, actor, state, access),
  );
}

// The modifiers the zones `actor` stands in give it, as Marshal Undead's Advantage.
export function zoneModifiers(
  actor: Actor,
  state: DndState,
  access?: ContentAccess,
): readonly Modifier[] {
  return zonesOn(actor, state, access).flatMap(
    (zone) => zone.area?.grants ?? [],
  );
}

// Immunity to a condition the zones `actor` stands in give it, as a questing knight's Aura of Bravery.
export const zoneImmune = (
  actor: Actor,
  condition: string,
  state: DndState,
  access?: ContentAccess,
): boolean =>
  zoneModifiers(actor, state, access).some(
    (modifier) =>
      modifier.kind === "conditionImmunity" && modifier.condition === condition,
  );

// The zone that hides a square, darkness before fog, or undefined.
export function obscuring(
  square: Square | null,
  state: DndState,
): "darkness" | "fog" | undefined {
  const zones = zonesOf(state).filter(
    (zone) =>
      (zone.zone === "darkness" || zone.zone === "fog") && inZone(zone, square),
  );
  return zones.find((zone) => zone.zone === "darkness")
    ? "darkness"
    : zones[0]
      ? "fog"
      : undefined;
}

export const lit = (
  square: Square | null,
  state: DndState,
  access?: ContentAccess,
): boolean =>
  zonesOf(state, access).some(
    (zone) =>
      (zone.zone === "light" || zone.zone === "sunlight") &&
      inZone(zone, square),
  );

export const glows = (
  square: Square | null,
  state: DndState,
  access?: ContentAccess,
): boolean =>
  zonesOf(state, access).some(
    (zone) => zone.zone === "dim" && inZone(zone, square),
  );

// Sunlight: a fight under the sky, outside the map's shade and darkness and any magical darkness, or a spell's
// sunlight, as Daylight's.
export function sunlit(square: Square | null, state: DndState): boolean {
  if (!square || !state.combat) return false;
  if (
    zonesOf(state).some(
      (zone) => zone.zone === "sunlight" && inZone(zone, square),
    )
  ) {
    return true;
  }
  if (!state.combat.sunlight || obscuring(square, state) === "darkness") {
    return false;
  }
  const terrain = state.combat.terrain;
  const key = squareKey(square);
  return !terrain?.dim.includes(key) && !terrain?.dark.includes(key);
}

// The squares inside a zone, on the map.
function squaresOf(zone: Zone, state: DndState): readonly string[] {
  const grid = state.combat?.grid;
  if (!grid) return [];
  const reach = Math.floor(zone.radius / 5);
  const keys: string[] = [];
  for (let x = zone.at.x - reach; x <= zone.at.x + reach; x += 1) {
    for (let y = zone.at.y - reach; y <= zone.at.y + reach; y += 1) {
      if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) {
        if (inZone(zone, { x, y })) keys.push(squareKey({ x, y }));
      }
    }
  }
  return keys;
}

// Squares a thorny zone covers, which cost double to walk through.
export function thornKeys(state: DndState): readonly string[] {
  return zonesOf(state).flatMap((zone) =>
    zone.zone === "thorns" ? squaresOf(zone, state) : [],
  );
}

// Squares that cost `mover` double besides the map's own: a zone that halves its Speed, as Spirit Guardians does.
export function slowingKeys(
  mover: Actor,
  state: DndState,
  access?: ContentAccess,
): readonly string[] {
  return zonesOf(state, access).flatMap((zone) =>
    zone.area?.difficult && affects(zone, mover, state, access)
      ? squaresOf(zone, state)
      : [],
  );
}

// Squares `mover` can't enter: a barrier against it, as Antilife Shell's.
// shortcut: a creature already inside when the barrier rises can still walk about in it.
export function barredKeys(
  mover: Actor,
  state: DndState,
  access?: ContentAccess,
): readonly string[] {
  return zonesOf(state, access).flatMap((zone) =>
    zone.area?.barrier && affects(zone, mover, state, access)
      ? squaresOf(zone, state)
      : [],
  );
}

const blocked = new WeakMap<DndState, readonly string[]>();
// Squares no one can enter or see through: the map's walls and the walls spells raise. With no spell walls it's
// the map's own list, so whatever is kept by that list stays.
export function blockedSquares(state: DndState): readonly string[] {
  const walls = state.combat?.walls ?? [];
  const raised = zonesOf(state).flatMap((zone) => zone.blocks ?? []);
  if (raised.length === 0) return walls;
  const known = blocked.get(state);
  if (known) return known;
  const all = [...new Set([...walls, ...raised])];
  blocked.set(state, all);
  return all;
}

// The walls as walking and sight test them: the map's and the spells', with the corners the fight opened (grid.ts).
export function blockingSet(state: DndState): Set<string> {
  return wallSet({
    walls: blockedSquares(state),
    openCorners: state.combat?.openCorners,
  });
}

// The damage each square of a walk takes inside thorny zones, as Spike Growth's per 5 feet travelled there.
export function thornHits(
  path: readonly Square[],
  state: DndState,
): readonly Damage[] {
  const zones = zonesOf(state).filter((zone) => zone.zone === "thorns");
  return path.flatMap((square) =>
    zones.flatMap((zone) => (inZone(zone, square) ? (zone.damage ?? []) : [])),
  );
}

// Advantage or Disadvantage from where `actor` stands: what the zones it's in give it, and sunlight or Bright Light
// for a creature sensitive to it.
export function placedFlag(
  actor: Actor,
  kind: "advantage" | "disadvantage",
  on: "attacks" | "saves" | "checks" | "attacksAgainst",
  state: DndState,
  access: ContentAccess,
  ability?: Ability,
  conditions: readonly string[] = [], // what the save would put on it or end, for Advantage only against those
): boolean {
  if (!state.combat || !actor.position) return false;
  const given =
    zonesOf(state, access).length > 0 &&
    zoneModifiers(actor, state, access).some(
      (modifier) =>
        modifier.kind === kind &&
        modifier.on === on &&
        (!modifier.ability || modifier.ability === ability) &&
        (!("conditions" in modifier) ||
          !modifier.conditions ||
          modifier.conditions.some((item) => conditions.includes(item))),
    );
  // Light sensitivity is a stat block's trait, so a character is never asked for it.
  if (
    given ||
    kind !== "disadvantage" ||
    on === "attacksAgainst" ||
    actor.source.kind === "character"
  ) {
    return given;
  }
  return statsOf(actor, access).passives.some(
    (passive) =>
      passive.kind === "lightSensitive" &&
      passive.disadvantage.includes(on) &&
      (passive.light === "sunlight"
        ? sunlit(actor.position, state)
        : lightAt(actor.position, state, access) === "bright"),
  );
}

// No Hit Points are regained in a zone that stops it, as a dracolich's Life Suppression.
export function healingStopped(
  actor: Actor,
  state: DndState,
  access?: ContentAccess,
): boolean {
  return zonesOn(actor, state, access).some((zone) => zone.area?.noHealing);
}

// The spells `actor` can't cast where it stands, as a test of an action, or null where it can cast them all: none
// in an Antimagic Field, and none with a Verbal component in Silence.
export function silencedSpells(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): ((action: KnownAction) => boolean) | null {
  const kinds = new Set(
    zonesOn(actor, state, access).flatMap((zone) =>
      zone.area?.noSpells ? [zone.area.noSpells] : [],
    ),
  );
  if (kinds.size === 0) return null;
  return (action) => {
    const spell = spellOf(action.id, actor, access);
    if (!spell) return false;
    return kinds.has("all") || /\bV\b/.test(spell.components);
  };
}

// How many harmful things would act on `actor` at `at`: a zone that acts on those in it, its side's own clouds too
// unless the zone is only for allies, and sunlight that burns it. Movement ranks squares by it, so a creature closes in without standing in a cloud it needn't.
export function zoneHarm(
  actor: Actor,
  at: Square,
  state: DndState,
  access: ContentAccess,
): number {
  const zones = zonesOf(state, access).filter(
    (zone) =>
      zone.area?.resolution !== undefined &&
      zone.area.when !== undefined &&
      zone.area.side !== "ally" &&
      inZone(zone, at) &&
      affects(zone, actor, state, access),
  ).length;
  const burns =
    actor.source.kind !== "character" &&
    statsOf(actor, access).passives.some(
      (passive) =>
        passive.kind === "lightSensitive" &&
        passive.damage.length > 0 &&
        passive.light === "sunlight" &&
        sunlit(at, state),
    );
  return zones + (burns ? 1 : 0);
}
