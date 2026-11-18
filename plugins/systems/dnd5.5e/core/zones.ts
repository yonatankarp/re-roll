import type { ContentAccess } from "#sdk";
import type {
  Ability,
  AreaEffect,
  Damage,
  Modifier,
  Resolution,
  ZoneKind,
} from "./schemas.ts";
import type { SystemEvent } from "#sdk";
import {
  type Actor,
  type DndState,
  dndEvent,
  equipped,
  hasCondition,
  INCAPACITATING,
  isDead,
  NS,
} from "./state.ts";
import { distanceFeet, type Square, squareKey, wallSet } from "./grid.ts";
import {
  bareSpell,
  deriveStats,
  type KnownAction,
  type Stats,
} from "./stats.ts";
import { spellOf } from "./combat/dispel.ts";
import { spellOfSource } from "./combat/ids.ts";
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
  readonly walls?: Wall | undefined; // what alone its wall stops, when not both walking and sight
  readonly layers?: readonly Resolution[] | undefined; // what crossing its wall does, in order
  readonly name?: string | undefined; // what made it, for the log and the board
  readonly level?: number | undefined; // the slot its spell was cast with
  readonly dim?: number | undefined; // light: feet of Dim Light beyond its Bright
  readonly ownerSees?: true | undefined; // darkness its owner sees through
  readonly reveals?: true | undefined; // light: no benefit from the Invisible condition in its Bright Light
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
          // Light the creature sheds, as Faerie Fire's outline.
          if (modifier.kind === "sheds") {
            if (!actor.position || isDead(actor)) return [];
            return [
              {
                zone: modifier.light,
                at: actor.position,
                radius: modifier.feet,
                dim: modifier.dim,
                owner: actor.id,
                sourceId,
                follows: true,
              },
            ];
          }
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
              walls: modifier.walls,
              layers: modifier.layers,
              name: modifier.name,
              level,
              dim: modifier.dim,
              ownerSees: modifier.ownerSees,
              reveals: modifier.reveals,
            },
          ];
        }),
      );
  // A Dead Magic Zone: an Antimagic Field over the whole fight (environment.ts).
  const dead: Zone[] = state.combat?.environment?.deadMagic
    ? [
        {
          zone: "area",
          at: { x: 0, y: 0 },
          radius: 100000,
          owner: "",
          sourceId: "environment:dead-magic",
          follows: false,
          area: { noSpells: "all" },
        },
      ]
    : [];
  const all = dead.length > 0 ? [...zones, ...dead] : zones;
  spellZones.set(state, all);
  return all;
}

// A sealed-away creature's areas reach nothing outside, and one Incapacitated loses those it must be awake for. A
// character's come only from what it carries, as a Holy Avenger's.
function auraZones(state: DndState, access: ContentAccess): readonly Zone[] {
  return Object.values(state.actors).flatMap((actor): Zone[] => {
    if (!actor.position) return [];
    if (isDead(actor) || sealed(actor)) return [];
    if (actor.source.kind === "character" && !carriesAura(actor, access)) {
      return [];
    }
    const at = actor.position;
    const stats = statsOf(actor, access);
    const levelIn = (slug: string): number =>
      Object.entries(stats.classLevels).find(([id]) =>
        id.endsWith(`/${slug}`),
      )?.[1] ?? 0;
    return stats.passives.flatMap((passive): Zone[] =>
      passive.kind === "aura" &&
      !(passive.area.awake && hasCondition(actor, ...INCAPACITATING))
        ? [
            {
              zone: passive.zone,
              at,
              radius:
                passive.wider &&
                levelIn(passive.wider.class) >= passive.wider.level
                  ? passive.wider.radius
                  : passive.radius,
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

// Whether a character carries an item with an aura, read off the raw entries so the rest of its stats aren't derived
// for every new state.
function carriesAura(actor: Actor, access: ContentAccess): boolean {
  const aura = (passives: unknown): boolean =>
    Array.isArray(passives) &&
    passives.some(
      (passive: unknown) =>
        typeof passive === "object" &&
        passive !== null &&
        "kind" in passive &&
        passive.kind === "aura",
    );
  return equipped(actor).some((id) => {
    const entry: unknown = access.content(id);
    return (
      typeof entry === "object" &&
      entry !== null &&
      "passives" in entry &&
      aura(entry.passives)
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

// Inside an Antimagic Field, where no other spell's area reaches (its own and ones like it aside).
export const inAntimagic = (actor: Actor, state: DndState): boolean =>
  castZones(state).some(
    (zone) => zone.area?.noSpells === "all" && inZone(zone, actor.position),
  );

// The events that hold off the spell and item effects of every creature in an Antimagic Field, and bring them back
// for those out of it again. Its own zones aren't held, since they act where they were cast.
// shortcut: checked as turns start and after moves, so a field that ends works on until then, and an effect that ran
// out while held off ends at its next check.
export function antimagicEvents(state: DndState): SystemEvent[] {
  const field = castZones(state).some((zone) => zone.area?.noSpells === "all");
  return Object.values(state.actors).flatMap((actor): SystemEvent[] => {
    const inside = field && inAntimagic(actor, state);
    if (!inside) {
      return actor.suppressed
        ? [dndEvent(`${NS}:effectsRestored`, { actor: actor.id })]
        : [];
    }
    const sourceIds = [
      ...new Set(
        actor.activeEffects.flatMap(({ sourceId, modifier }) =>
          (sourceId.startsWith("spell:") || sourceId.startsWith("item:")) &&
          modifier.kind !== "zone"
            ? [sourceId]
            : [],
        ),
      ),
    ];
    return !actor.suppressed || sourceIds.length > 0
      ? [dndEvent(`${NS}:effectsSuppressed`, { actor: actor.id, sourceIds })]
      : [];
  });
}

const PLACED = "placed:";

// The conditions spells' areas put on those in them while there, as Silence's Deafened: added for each creature that
// stands in one and ended for each that left it, checked where Antimagic Field's are.
export function placedConditionEvents(state: DndState): SystemEvent[] {
  const placing = castZones(state).filter((zone) => zone.area?.conditions);
  return Object.values(state.actors).flatMap((actor): SystemEvent[] => {
    const had = actor.activeEffects.filter(({ sourceId }) =>
      sourceId.startsWith(PLACED),
    );
    if (placing.length === 0 && had.length === 0) return [];
    const wanted = placing.filter(
      (zone) => inZone(zone, actor.position) && affects(zone, actor, state),
    );
    const keys = new Set(wanted.map((zone) => `${PLACED}${zone.sourceId}`));
    const ended = [...new Set(had.map((effect) => effect.sourceId))]
      .filter((sourceId) => !keys.has(sourceId))
      .map((sourceId) =>
        dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId }),
      );
    const added = wanted
      .filter(
        (zone) =>
          !had.some(
            (effect) => effect.sourceId === `${PLACED}${zone.sourceId}`,
          ),
      )
      .flatMap((zone) =>
        (zone.area?.conditions ?? []).map((condition) =>
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              sourceId: `${PLACED}${zone.sourceId}`,
              casterId: zone.owner,
              modifier: { kind: "condition", condition },
              ends: "spellDuration",
            },
          }),
        ),
      );
    return [...ended, ...added];
  });
}

export const sealed = (actor: Actor): boolean =>
  actor.activeEffects.some(({ modifier }) => modifier.kind === "sealed");

// Whether one of the two has the other Grappled, as Barbed Hide's spines need.
const grappleBetween = (a: Actor, b: Actor): boolean =>
  [
    [a, b],
    [b, a],
  ].some(([held, by]) =>
    held?.activeEffects.some(
      ({ modifier, casterId }) =>
        modifier.kind === "condition" &&
        modifier.condition === "grappled" &&
        casterId === by?.id,
    ),
  );

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
  if (
    zone.sourceId.startsWith("spell:") &&
    zone.area?.noSpells !== "all" &&
    inAntimagic(actor, state)
  ) {
    return false;
  }
  if (zone.follows && actor.id === owner.id && !area.self) return false;
  if (area.side === "enemy" && actor.side === owner.side) return false;
  if (area.side === "ally" && actor.side !== owner.side) return false;
  if (
    area.bloodied &&
    (!access || actor.hp * 2 > statsOf(actor, access).maxHp)
  ) {
    return false;
  }
  if (area.grappling && !grappleBetween(owner, actor)) return false;
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

// The zone that hides a square, darkness before fog, or undefined. Darkness its caster sees through doesn't hide it
// from `viewer`, when that's its caster, nor any of its own with `ownDarkness`.
export function obscuring(
  square: Square | null,
  state: DndState,
  viewer?: string,
  ownDarkness = false,
): "darkness" | "fog" | undefined {
  const zones = zonesOf(state).filter(
    (zone) =>
      (zone.zone === "darkness" || zone.zone === "fog") &&
      inZone(zone, square) &&
      !(
        zone.zone === "darkness" &&
        zone.owner === viewer &&
        (zone.ownerSees ?? ownDarkness)
      ),
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

// Dim Light a zone sheds there: a dim zone, or the ring beyond a light's Bright Light.
export const glows = (
  square: Square | null,
  state: DndState,
  access?: ContentAccess,
): boolean =>
  zonesOf(state, access).some(
    (zone) =>
      (zone.zone === "dim" && inZone(zone, square)) ||
      ((zone.zone === "light" || zone.zone === "sunlight") &&
        zone.dim !== undefined &&
        square !== null &&
        distanceFeet(zone.at, square) <= zone.radius + zone.dim),
  );

// In a zone that makes light a step dimmer, as round Shadow of Moil's caster.
export const shaded = (square: Square | null, state: DndState): boolean =>
  zonesOf(state).some((zone) => zone.zone === "shade" && inZone(zone, square));

// In the Bright Light of a light that shows the Invisible, as a Lantern of Revealing's.
export const revealed = (
  square: Square | null,
  state: DndState,
  access?: ContentAccess,
): boolean =>
  zonesOf(state, access).some(
    (zone) => zone.reveals === true && inZone(zone, square),
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

// What a wall stops: walking (Forcecage's cage), sight (Wall of Fire), or, unless it says, both.
export type Wall = "walking" | "sight";

const blocked: Record<Wall, WeakMap<DndState, readonly string[]>> = {
  walking: new WeakMap(),
  sight: new WeakMap(),
};
// Squares no one can walk into, or see through: the map's walls and the walls spells raise that stop it. With no
// such spell walls it's the map's own list, so whatever is kept by that list stays.
export function blockedSquares(
  state: DndState,
  stops: Wall,
): readonly string[] {
  const walls = state.combat?.walls ?? [];
  const raised = zonesOf(state).flatMap((zone) =>
    !zone.walls || zone.walls === stops ? (zone.blocks ?? []) : [],
  );
  if (raised.length === 0) return walls;
  const known = blocked[stops].get(state);
  if (known) return known;
  const all = [...new Set([...walls, ...raised])];
  blocked[stops].set(state, all);
  return all;
}

// The walls as walking or sight tests them: the map's and the spells', with the corners the fight opened (grid.ts).
export function blockingSet(state: DndState, stops: Wall): Set<string> {
  return wallSet({
    walls: blockedSquares(state, stops),
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
  magical = false, // a save against a spell or magic
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
          modifier.conditions.some((item) => conditions.includes(item))) &&
        (!("magical" in modifier) || !modifier.magical || magical),
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
  // Sing Out: Charmed by its caster's Otto's Irresistible Dance, it can't speak a spell.
  const singing = actor.activeEffects.some(
    ({ modifier, sourceId, casterId }) => {
      const spell = spellOfSource(sourceId);
      const caster = state.actors[casterId];
      return (
        modifier.kind === "condition" &&
        modifier.condition === "charmed" &&
        spell !== null &&
        caster !== undefined &&
        deriveStats(caster, access).passives.some(
          (passive) =>
            passive.kind === "singOut" && passive.spells.includes(spell),
        )
      );
    },
  );
  if (singing) kinds.add("verbal");
  if (kinds.size === 0) return null;
  // A voice thrown elsewhere, as through a Spell-Slinger's Puppet, isn't silenced.
  const elsewhere = actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "voiceElsewhere",
  );
  return (action) => {
    const spell = spellOf(action.id, actor, access);
    if (!spell) return false;
    return (
      kinds.has("all") ||
      (!elsewhere &&
        /\bV\b/.test(spell.components) &&
        !bareSpell(actor, spell.school, access))
    );
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
