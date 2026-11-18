import {
  deriveStats,
  evaluateFormula,
  type KnownAction,
  spellSaveDc,
} from "../../stats.ts";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  isDead,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import { type Frame, type SystemEvent } from "#sdk";
import {
  type Ability,
  type AreaEffect,
  type LeafEffect,
  LeafEffectSchema,
  type Resolution,
} from "../../schemas.ts";
import { walkSpeed } from "../../tactics.ts";
import { spellOfSource } from "../ids.ts";
import {
  distanceFeet,
  inArea,
  parseSquare,
  lineFrom,
  type Square,
  squareKey,
} from "../../grid.ts";
import {
  blockedSquares,
  inZone,
  squaresOf,
  type Zone,
  zonesOf,
} from "../../zones.ts";
import { lastsFor, timeStopEnds } from "../durations.ts";
import { carriedEvents, movedFrames } from "../areas.ts";
import { snuffedLights, spellLevelOf } from "../dispel.ts";
import { type Context, spellSource } from "../queries.ts";
import { leastResisted, retyped } from "./damage-types.ts";
import { effectEnds } from "./lasting.ts";
import { rollSave } from "./saves.ts";
import { leafEvents } from "./leaf.ts";

// The zones a spell leaves on the map: walls, moving areas, fissures and the light that ends darkness.

// The zones a spell leaves, once for the whole cast, where the area was aimed or round the caster, whoever it
// caught. Its area's save DC is fixed as cast; a wall rings the area with squares no one can pass.
export function zoneEvents(
  effects: readonly LeafEffect[],
  action: KnownAction,
  actor: Actor,
  context: Context,
  aim: Square | undefined,
  slotLevel: number | undefined,
  placing = false, // an anchored action's object, which combat/actions.ts places where it goes
): SystemEvent[] {
  if (action.activation.anchor && !placing) return [];
  const at = aim ?? actor.position;
  if (!at) return [];
  const stats = deriveStats(actor, context);
  const placed = new Set<string>();
  const events: SystemEvent[] = [];
  const { targeting } = action.activation;
  const wind = effects.find((effect) => effect.kind === "disperse");
  if (wind?.kind === "disperse" && wind.maxLevel !== undefined) {
    events.push(...overlapEnds(wind, effects, actor, at, context));
  } else if (wind?.kind === "disperse" && "area" in targeting) {
    const { shape, radius } = targeting.area;
    // shortcut: Sunburst ends any Darkness zone, as a monster's own Darkness is a spell too.
    const ends = (zone: ReturnType<typeof zonesOf>[number]): boolean =>
      wind.zones
        ? wind.zones.includes(zone.zone)
        : zone.zone === "fog" || zone.area?.disperses === true;
    for (const zone of zonesOf(context.state)) {
      if (ends(zone) && inArea(shape, radius, actor.position, at, zone.at)) {
        events.push(
          dndEvent(`${NS}:effectEnded`, {
            actor: zone.owner,
            sourceId: zone.sourceId,
            casterId: zone.owner,
          }),
        );
      }
    }
  }
  const above = Math.max(0, (slotLevel ?? 0) - (action.spellLevel ?? 0));
  // Its saves' DCs are fixed as cast.
  const fixed = (printed: Resolution | undefined): Resolution | undefined =>
    printed?.kind === "save"
      ? {
          ...printed,
          dc: { base: evaluateFormula(printed.dc, stats), add: [] },
        }
      : printed;
  const element = (
    effects.find((effect) => effect.kind === "zone" && effect.choose) as
      Extract<LeafEffect, { kind: "zone" }> | undefined
  )?.choose;
  const type = element ? leastResisted(element, actor, context) : undefined;
  // An area as it goes on the map: its DCs fixed, its element picked, and widened by a higher slot.
  // What the caster's features add to this spell's area, as Grasping Mist's to Fog Cloud.
  const spellId = spellOfSource(action.id);
  const riders = stats.passives.flatMap((passive) =>
    passive.kind === "areaRider" &&
    spellId !== null &&
    passive.spells.includes(spellId)
      ? [passive.area]
      : [],
  );
  const settle = (written: AreaEffect | undefined) => {
    const printed =
      riders.length > 0
        ? riders.reduce<AreaEffect>((sum, rider) => {
            const places = [...(sum.places ?? []), ...(rider.places ?? [])];
            return {
              ...sum,
              ...rider,
              ...(places.length > 0 ? { places } : {}),
            };
          }, written ?? {})
        : written;
    // A higher slot widens what the area shields, as Globe of Invulnerability's.
    const area =
      printed?.shieldGrows && printed.spellShield !== undefined
        ? { ...printed, spellShield: Math.min(9, printed.spellShield + above) }
        : printed;
    const resolution = retyped(fixed(area?.resolution), type);
    const holding = retyped(fixed(area?.holding), type);
    // A wall's layers go on the wall alone, their DCs fixed too.
    const { layers, usesPerSlot, ...kept } = area ?? {};
    const fixedLayers = layers?.flatMap((layer) => fixed(layer) ?? []);
    const uses =
      kept.uses === undefined
        ? undefined
        : Math.max(
            kept.usesAtLeast ?? 1,
            kept.uses +
              (usesPerSlot ?? 0) * above +
              (kept.usesMod
                ? evaluateFormula(
                    { base: 0, add: [{ kind: "spellMod" }] },
                    stats,
                  )
                : 0),
          );
    return {
      area: area
        ? {
            ...kept,
            ...(resolution ? { resolution } : {}),
            ...(holding ? { holding } : {}),
            ...(kept.schedule
              ? {
                  schedule: kept.schedule.map(
                    (step) => retyped(fixed(step), type) ?? step,
                  ),
                }
              : {}),
            ...(kept.foilsSpells
              ? {
                  foilsSpells: {
                    ...kept.foilsSpells,
                    dc: kept.foilsSpells.dc ?? spellSaveDc(stats),
                  },
                }
              : {}),
          }
        : undefined,
      layers: fixedLayers,
      uses,
    };
  };
  for (const effect of effects) {
    if (effect.kind !== "zone") continue;
    // A higher slot widens it, as Fog Cloud's 20 feet a level, and a feature can, as Aquatic Affinity.
    const widened =
      effect.wider && stats.features.includes(effect.wider.feature)
        ? effect.wider.radius
        : effect.radius;
    const radius = widened + (effect.perSlot ?? 0) * above;
    const key = `${effect.zone}|${String(radius)}|${String(effect.part ?? "")}`;
    if (placed.has(key)) continue;
    placed.add(key);
    if (effect.zone === "darkness") {
      events.push(...snuffedLights(at, radius, context));
    }
    const centre = effect.follows ? (actor.position ?? at) : at;
    // A line runs out from its caster, or, cast farther off, across the way to where it's aimed.
    const line =
      effect.shape === "line" && actor.position
        ? lineFrom(
            actor.position,
            at,
            radius,
            !effect.follows &&
              "range" in targeting &&
              targeting.range !== "self",
          )
        : null;
    const origin = line?.at ?? centre;
    const shaped: Zone = {
      zone: effect.zone,
      at: origin,
      radius,
      owner: actor.id,
      sourceId: spellSource(action),
      follows: effect.follows === true,
      shape: effect.shape,
      dir: line?.dir,
      width: effect.width,
    };
    // Time Stop ends once an area its caster leaves during it covers another creature.
    events.push(
      ...timeStopEnds(
        actor,
        Object.values(context.state.actors).filter(
          (other) =>
            other.position !== null &&
            !isDead(other) &&
            inZone(shaped, other.position),
        ),
      ),
    );
    if (effect.zone === "sunlight") {
      events.push(...dazzled(centre, spellSource(action), actor, context));
    }
    const wall =
      effect.zone === "wall"
        ? wallRing(
            shaped,
            context,
            effect.walls !== "sight" && effect.shape !== "line",
          )
        : null;
    const { area, layers, uses } = settle(
      effect.part === undefined
        ? action.activation.area
        : action.activation.areas?.[effect.part],
    );
    // A new cast starts its counts afresh: what an earlier one dealt or used up.
    const spell = spellOfSource(spellSource(action)) ?? "";
    const counts = [
      ...(uses !== undefined && !effect.bare
        ? [`${spellSource(action)}:used`]
        : []),
      ...(area?.maxDamage !== undefined && !effect.bare
        ? [`${spellSource(action)}:dealt`]
        : []),
      // Spirit Lantern's fragments are gone with the spell it was cast before.
      ...(area?.gathers
        ? [`spheres:${spell}`, `spheres:${spell}:gathered`]
        : []),
    ].flatMap((resource) =>
      actor.resourcesSpent[resource]
        ? [
            dndEvent(`${NS}:resourceRestored`, {
              actor: actor.id,
              resource,
            }),
          ]
        : [],
    );
    events.push(
      ...counts,
      ...(wall?.pushed ?? []),
      ...(wall && effect.escape
        ? wallEscapes(
            centre,
            radius,
            effect.escape,
            actor,
            wall.squares,
            context,
          )
        : []),
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId: spellSource(action),
          casterId: actor.id,
          ...(slotLevel === undefined ? {} : { level: slotLevel }),
          modifier: {
            kind: "zone",
            zone: effect.zone,
            at: origin,
            radius,
            ...(effect.damage ? { damage: effect.damage } : {}),
            ...(effect.follows ? { follows: true as const } : {}),
            ...(area && !effect.bare ? { area } : {}),
            ...(wall ? { blocks: wall.squares } : {}),
            ...(wall && effect.walls ? { walls: effect.walls } : {}),
            ...(wall && layers ? { layers } : {}),
            ...(effect.dim ? { dim: effect.dim } : {}),
            ...(effect.ownerSees ? { ownerSees: true as const } : {}),
            ...(effect.reveals ? { reveals: true as const } : {}),
            ...(effect.zone === "image"
              ? { dc: effect.dc ?? spellSaveDc(stats) }
              : {}),
            ...(effect.decoy ? { decoy: true as const } : {}),
            ...(effect.part === undefined ? {} : { part: effect.part }),
            ...(effect.shape ? { shape: effect.shape } : {}),
            ...(line ? { dir: line.dir } : {}),
            ...(effect.width ? { width: effect.width } : {}),
            ...(uses === undefined || effect.bare ? {} : { uses }),
            ...(context.state.combat
              ? { since: context.state.combat.round }
              : {}),
            name: action.name,
          },
          ends: effectEnds(effect.duration),
          ...lastsFor(effect.duration, actor, actor, context.state),
        },
      }),
    );
  }
  return events;
}

// Fissures opening under the healthiest foes caught, as Earthquake's: each saves again or falls in, taking the fall
// and spending its next turn's movement climbing out.
// shortcut: a fissure is under one creature, not a line across the area, and climbing out takes one turn's movement.
export function fissureEvents(
  fissure: NonNullable<Extract<Resolution, { kind: "save" }>["fissure"]>,
  ability: Ability,
  dc: number,
  action: KnownAction,
  actor: Actor,
  targets: readonly Actor[],
  frames: Frame[],
  context: Context,
): SystemEvent[] {
  const roll = (dice: string): number => {
    const [count, sides] = dice.split("d").map(Number);
    let total = 0;
    for (let die = 0; die < (count ?? 0); die += 1) {
      total += context.dice.roll(sides ?? 1);
    }
    return total;
  };
  const count =
    typeof fissure.count === "number" ? fissure.count : roll(fissure.count);
  const depth =
    typeof fissure.depth === "number"
      ? fissure.depth
      : roll(fissure.depth.dice) * fissure.depth.times;
  const foes = targets
    .flatMap((item) => {
      const now = context.state.actors[item.id];
      return now && !isDead(now) && now.side !== actor.side ? [now] : [];
    })
    .sort((a, b) => b.hp - a.hp)
    .slice(0, count);
  const events: SystemEvent[] = [];
  for (const foe of foes) {
    const save = rollSave(
      foe,
      ability,
      dc,
      context,
      action.spellLevel !== null,
    );
    events.push(...save.events);
    if (save.saved) continue;
    frames.push(frame("fall", { actors: [foe.id], feet: depth }));
    events.push(
      ...leafEvents(
        [
          LeafEffectSchema.parse({
            kind: "modifier",
            modifier: { kind: "actionLimit", speed: "none" },
            duration: { until: "itsNextTurnEnd" },
          }),
        ],
        spellSource(action),
        actor,
        foe,
        context,
      ),
    );
  }
  return events;
}

// An area that acts on those in it as it appears, as Conjure Celestial's light: its tick on each creature it covers.
export function appearFrames(
  action: KnownAction,
  actor: Actor,
  events: readonly SystemEvent[],
  context: Context,
): Frame[] {
  if (
    !action.activation.area?.appears &&
    !action.activation.areas?.some((area) => area.appears)
  ) {
    return [];
  }
  const state = events.reduce(applyDndEvent, context.state);
  const far = { x: -1000, y: -1000 };
  return zonesOf(state, context)
    .filter(
      (zone) =>
        zone.owner === actor.id &&
        zone.sourceId === spellSource(action) &&
        zone.area?.appears,
    )
    .flatMap((zone) => movedFrames(zone, far, { ...context, state }));
}

// A Robe of Eyes' wearer within its reach of a spell's sunlight is Blinded for a minute, saving at each turn's end.
function dazzled(
  centre: Square,
  sourceId: string,
  caster: Actor,
  context: Context,
): SystemEvent[] {
  return Object.values(context.state.actors).flatMap((bearer) => {
    if (!bearer.position || isDead(bearer)) return [];
    const passive = deriveStats(bearer, context).passives.find(
      (item) => item.kind === "dazzledBy",
    );
    if (
      passive?.kind !== "dazzledBy" ||
      distanceFeet(bearer.position, centre) > passive.within
    ) {
      return [];
    }
    return [
      dndEvent(`${NS}:effectAdded`, {
        actor: bearer.id,
        effect: {
          sourceId: `${sourceId}:dazzled`,
          casterId: caster.id,
          modifier: { kind: "condition", condition: "blinded" },
          ends: "spellDuration",
          ...lastsFor({ minutes: 1 }, caster, bearer, context.state),
          repeatSave: { ability: "con", dc: passive.dc },
        },
      }),
    ];
  });
}

// Daylight's sunlight ends Darkness of level 3 or lower that its area overlaps, and the Boon of the Bright Sun's
// light any spell's Darkness.
function overlapEnds(
  wind: Extract<LeafEffect, { kind: "disperse" }>,
  effects: readonly LeafEffect[],
  actor: Actor,
  at: Square,
  context: Context,
): SystemEvent[] {
  const own = effects.flatMap((effect) =>
    effect.kind === "zone" ? [effect] : [],
  );
  const reach = Math.max(0, ...own.map((effect) => effect.radius));
  const centre = own.some((effect) => effect.follows)
    ? (actor.position ?? at)
    : at;
  const kinds = wind.zones ?? ["fog"];
  return zonesOf(context.state).flatMap((zone) => {
    const owner = context.state.actors[zone.owner];
    const level =
      zone.level ?? spellLevelOf(zone.sourceId, owner, context) ?? 9;
    return kinds.includes(zone.zone) &&
      level <= (wind.maxLevel ?? 9) &&
      distanceFeet(zone.at, centre) <= zone.radius + reach
      ? [
          dndEvent(`${NS}:effectEnded`, {
            actor: zone.owner,
            sourceId: zone.sourceId,
            casterId: zone.owner,
          }),
        ]
      : [];
  });
}

// Moves the bearer's area of a spell to `to`, with the ticks on whoever it moves onto, as Moonbeam's.
export function movedZone(
  source: string,
  actor: Actor,
  to: Square,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const zones = zonesOf(context.state).filter(
    (zone) => zone.owner === actor.id && zone.sourceId === source,
  );
  if (zones.length === 0) return { events: [], frames: [] };
  return {
    events: [
      dndEvent(`${NS}:zoneMoved`, { actor: actor.id, sourceId: source, to }),
      ...zones.flatMap((zone) =>
        carriedEvents(zone, zone.at, to, context.state),
      ),
    ],
    frames: zones.flatMap((zone) =>
      movedFrames({ ...zone, at: to }, zone.at, context),
    ),
  };
}

// A creature the wall shuts in can save to get out first, spending its Reaction on a walk to the nearest open square
// outside, as Wall of Stone allows. shortcut: only the caster's foes try, since its friends would rather stay.
function wallEscapes(
  centre: Square,
  radius: number,
  ability: Ability,
  caster: Actor,
  wall: readonly string[],
  context: Context,
): SystemEvent[] {
  const { state } = context;
  const grid = state.combat?.grid;
  if (!grid) return [];
  const dc = evaluateFormula(
    { base: 0, add: [{ kind: "spellSaveDc" }] },
    deriveStats(caster, context),
  );
  const shut = new Set([...blockedSquares(state, "walking"), ...wall]);
  const taken = new Set(
    Object.values(state.actors).flatMap((item) =>
      item.position && !isDead(item) ? [squareKey(item.position)] : [],
    ),
  );
  const events: SystemEvent[] = [];
  for (const item of Object.values(state.actors)) {
    const at = item.position;
    if (
      !at ||
      isDown(item) ||
      item.side === caster.side ||
      !item.budget.reaction ||
      distanceFeet(centre, at) >= radius
    ) {
      continue;
    }
    const saved = rollSave(item, ability, dc, context);
    events.push(...saved.events);
    if (!saved.saved) continue;
    const reach = walkSpeed(item, deriveStats(item, context));
    let best: Square | null = null;
    for (let x = 0; x < grid.width; x += 1) {
      for (let y = 0; y < grid.height; y += 1) {
        const square = { x, y };
        const key = squareKey(square);
        if (distanceFeet(centre, square) <= radius || shut.has(key)) continue;
        if (taken.has(key) || distanceFeet(at, square) > reach) continue;
        if (!best || distanceFeet(at, square) < distanceFeet(at, best)) {
          best = square;
        }
      }
    }
    if (!best) continue;
    taken.add(squareKey(best));
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: item.id, kind: "reaction" }),
      dndEvent(`${NS}:moved`, { actor: item.id, to: best, feet: 0 }),
    );
  }
  return events;
}

// A wall's squares: the edge of the area round its centre, or the whole of a ring or a line. A creature standing on
// one that stops walking is pushed one square in, and where there's no room it stays, leaving a gap; one that only
// stops sight, as fire, it stands in.
function wallRing(
  zone: Zone,
  context: Context,
  pushes: boolean,
): { readonly squares: string[]; readonly pushed: SystemEvent[] } {
  const { state } = context;
  const grid = state.combat?.grid;
  if (!grid) return { squares: [], pushed: [] };
  const centre = zone.at;
  const taken = new Map(
    Object.values(state.actors).flatMap((item) =>
      item.position && !isDead(item)
        ? [[squareKey(item.position), item] as const]
        : [],
    ),
  );
  const walls = new Set([
    ...blockedSquares(state, "walking"),
    ...blockedSquares(state, "sight"),
  ]);
  const squares: string[] = [];
  const pushed: SystemEvent[] = [];
  const onWall = (square: Square): boolean =>
    zone.shape
      ? inZone(zone, square)
      : distanceFeet(centre, square) === zone.radius;
  for (const key of squaresOf(
    { ...zone, shape: zone.shape ?? "ring" },
    state,
  )) {
    const square = parseSquare(key);
    if (!square || !onWall(square) || walls.has(key)) continue;
    const standing = pushes ? taken.get(key) : undefined;
    if (standing) {
      const inward = {
        x: square.x - Math.sign(square.x - centre.x),
        y: square.y - Math.sign(square.y - centre.y),
      };
      const inwardKey = squareKey(inward);
      if (taken.has(inwardKey) || walls.has(inwardKey)) continue;
      taken.delete(key);
      taken.set(inwardKey, standing);
      pushed.push(
        dndEvent(`${NS}:moved`, { actor: standing.id, to: inward, feet: 0 }),
      );
    }
    squares.push(key);
  }
  return { squares, pushed };
}
