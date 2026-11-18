import {
  type ContentAccess,
  type Frame,
  type SystemEvent,
  type SystemResult,
  frameHandler,
} from "#sdk";
import { z } from "zod";
import {
  type Actor,
  applyDndEvent,
  type DndState,
  dndEvent,
  frame,
  isDead,
  isDown,
  NS,
} from "../state.ts";
import { MonsterSchema, type Passive, type Resolution } from "../schemas.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  lookup,
  rollAmount,
} from "../stats.ts";
import { finalDamage } from "../rules.ts";
import { distanceFeet, type Square, squareKey } from "../grid.ts";
import { lightAt } from "../sight.ts";
import { timeStopEnds } from "./durations.ts";
import {
  affects,
  statsOf,
  inZone,
  obscuring,
  sealed,
  sunlit,
  type Zone,
  zonesOf,
  zonesOn,
} from "../zones.ts";
import { isSpell } from "./dispel.ts";
import { CHECK_END, type Context, currentActor } from "./queries.ts";
import {
  concentrationFrame,
  dealEvents,
  resolveAction,
  rollSave,
} from "./effects.ts";

// Lasting areas acting on the creatures in them as turns start and end, a monster's burst where it dies, and
// sunlight burning the creatures it harms.

// What a zone does when it acts, as an action of its owner's that costs nothing.
export function zoneAction(zone: Zone, name: string): KnownAction | null {
  const resolution = zone.area?.resolution;
  if (!resolution) return null;
  return {
    id: zone.sourceId,
    name,
    activation: {
      cost: [],
      targeting: {
        area: {
          shape: zone.follows ? "emanation" : "sphere",
          radius: zone.radius,
        },
        range: "self",
        side: zone.area.side ?? "enemy",
      },
      resolution,
    },
    spellLevel: zone.sourceId.startsWith("spell:") ? (zone.level ?? 1) : null,
  };
}

// The zone action `id` of `actor`'s, for an attack it rolls later, as Mordenkainen's Faithful Hound's bite.
export function ownZoneAction(
  actor: Actor,
  id: string,
  context: ContentAccess & { readonly state: DndState },
): KnownAction | null {
  const zone = zonesOf(context.state, context).find(
    (item) => item.owner === actor.id && item.sourceId === id,
  );
  return zone ? zoneAction(zone, zone.name ?? "") : null;
}

// The zones that act as `actor`'s turn starts or ends: each it stands in that acts on its turn, once a source,
// and each of its own that acts on its owner's turn, on everyone in it (or the nearest few).
export function zoneFrames(
  actor: Actor,
  at: "start" | "end",
  context: ContentAccess & { readonly state: DndState },
): Frame[] {
  const { state } = context;
  if (isDead(actor)) return [];
  const own = at === "start" ? "ownerTurnStart" : "ownerTurnEnd";
  const occupant = at === "start" ? "turnStart" : "turnEnd";
  const seen = new Set<string>();
  const frames: Frame[] = [];
  for (const zone of zonesOf(state, context)) {
    const { area } = zone;
    if (!area?.resolution || !area.when) continue;
    const key = `${zone.owner}|${zone.sourceId}`;
    if (area.when === occupant) {
      if (seen.has(key) || !inZone(zone, actor.position)) continue;
      if (!affects(zone, actor, state, context)) continue;
      seen.add(key);
      frames.push(
        frame("zoneTick", {
          owner: zone.owner,
          sourceId: zone.sourceId,
          targets: [actor.id],
        }),
      );
    } else if (area.when === own && zone.owner === actor.id) {
      const caught = Object.values(state.actors)
        .filter(
          (item) =>
            item.position !== null &&
            inZone(zone, item.position) &&
            affects(zone, item, state, context),
        )
        .sort(
          (a, b) =>
            distanceFeet(zone.at, a.position) -
              distanceFeet(zone.at, b.position) || a.hp - b.hp,
        )
        .slice(0, area.targets ?? Infinity);
      if (caught.length === 0) continue;
      frames.push(
        frame("zoneTick", {
          owner: zone.owner,
          sourceId: zone.sourceId,
          targets: caught.map((item) => item.id),
        }),
      );
    }
  }
  return frames;
}

// Kept in a creature's usedThisTurn: an area that acts on whoever enters it has caught it on this turn, so it acts
// on it only once a turn. The turn is in the key, since the mark stays until the creature's own turn clears it.
export function caughtKey(zone: Zone, state: DndState): string {
  const round = state.combat?.round ?? 0;
  const index = state.combat?.index ?? 0;
  return `area:${zone.owner}|${zone.sourceId}@${String(round)}.${String(index)}`;
}

const caught = (zone: Zone, actor: Actor, state: DndState): boolean =>
  zone.area?.enters === true &&
  actor.usedThisTurn.includes(caughtKey(zone, state));

const entering = (state: DndState): readonly Zone[] =>
  zonesOf(state).filter(
    (zone) =>
      zone.layers !== undefined ||
      (zone.area?.enters === true && zone.area.resolution !== undefined),
  );

// Whether `square` is on the wall of a zone whose wall has layers, as Prismatic Wall's.
const onWall = (zone: Zone, square: Square | null): boolean =>
  square !== null && (zone.blocks ?? []).includes(squareKey(square));

// Whether a zone acts on `walker` walking into it: a wall's layers spare its caster's side, as Prismatic Wall's
// spares those the caster designates.
function entersOn(
  zone: Zone,
  walker: Actor,
  context: ContentAccess & { readonly state: DndState },
): boolean {
  const { state } = context;
  return (
    !caught(zone, walker, state) &&
    affects(zone, walker, state, context) &&
    (!zone.layers || state.actors[zone.owner]?.side !== walker.side)
  );
}

// The squares of walls whose layers `walker` would have to cross, which a sensible creature walks round.
export function layeredSquares(
  walker: Actor,
  context: ContentAccess & { readonly state: DndState },
): readonly string[] {
  return zonesOf(context.state, context).flatMap((zone) =>
    zone.layers && entersOn(zone, walker, context) ? (zone.blocks ?? []) : [],
  );
}

// Where a walk first takes `walker` into an area that acts on whoever enters it, as Moonbeam: the index on the
// path, and the areas it enters there.
export function areaEntry(
  walker: Actor,
  path: readonly Square[],
  context: ContentAccess & { readonly state: DndState },
): { readonly index: number; readonly zones: readonly Zone[] } | null {
  const { state } = context;
  const zones = entering(state).filter((zone) =>
    entersOn(zone, walker, context),
  );
  if (zones.length === 0) return null;
  for (let index = 0; index < path.length; index += 1) {
    const square = path[index] ?? null;
    const from = index === 0 ? walker.position : (path[index - 1] ?? null);
    const into = zones.filter((zone) =>
      zone.layers
        ? onWall(zone, square) && !onWall(zone, from)
        : inZone(zone, square) && !inZone(zone, from),
    );
    if (into.length > 0) {
      // A walk can't stop in another creature's space, so it stops on the next square it can, the last if need be.
      // shortcut: the area acts there only if that square is in it too.
      const taken = new Set(
        Object.values(state.actors).flatMap((item) =>
          item.id !== walker.id && item.position && !isDead(item)
            ? [squareKey(item.position)]
            : [],
        ),
      );
      let stop = index;
      while (stop < path.length - 1) {
        const at = path[stop];
        if (at && !taken.has(squareKey(at))) break;
        stop += 1;
      }
      return { index: stop, zones: into };
    }
  }
  return null;
}

// The ticks of the areas `walker` has walked into, and of its own moving areas that now reach creatures they didn't
// as it set out from `from`, as Spirit Guardians brought up to a foe.
// shortcut: a moving area is judged where the walk ends, so a creature it only passes over isn't caught.
export function entryFrames(
  walker: Actor,
  from: Square | null,
  to: Square,
  into: readonly Zone[],
  context: ContentAccess & { readonly state: DndState },
): Frame[] {
  const { state } = context;
  const tick = (zone: Zone, targets: readonly string[]): Frame =>
    frame("zoneTick", { owner: zone.owner, sourceId: zone.sourceId, targets });
  const swept = entering(state).flatMap((zone) => {
    if (!zone.follows || zone.owner !== walker.id || !from) return [];
    const before = { ...zone, at: from };
    const after = { ...zone, at: to };
    const reached = Object.values(state.actors).filter(
      (item) =>
        item.id !== walker.id &&
        item.position !== null &&
        !inZone(before, item.position) &&
        inZone(after, item.position) &&
        !caught(zone, item, state) &&
        affects(zone, item, state, context),
    );
    return reached.length > 0
      ? [
          tick(
            zone,
            reached.map((item) => item.id),
          ),
        ]
      : [];
  });
  // A wall's layers act one after another, as Prismatic Wall's, each on its own frame.
  const crossed = (zone: Zone): Frame[] =>
    (zone.layers ?? []).map((_, layer) =>
      frame("wallLayer", {
        owner: zone.owner,
        sourceId: zone.sourceId,
        target: walker.id,
        layer,
      }),
    );
  return [
    ...into.flatMap((zone) =>
      zone.layers ? crossed(zone) : [tick(zone, [walker.id])],
    ),
    ...swept,
  ];
}

export const WallLayerSchema = z.object({
  owner: z.string(),
  sourceId: z.string(),
  target: z.string(),
  layer: z.number().int(),
});

// One layer of a wall acting on a creature crossing it, while the creature is still up and the wall stands.
export function runWallLayer(
  payload: z.infer<typeof WallLayerSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const owner = state.actors[payload.owner];
  const target = state.actors[payload.target];
  const zone = zonesOf(state, context).find(
    (item) =>
      item.owner === payload.owner &&
      item.sourceId === payload.sourceId &&
      item.layers !== undefined,
  );
  const resolution = zone?.layers?.[payload.layer];
  if (!owner || !target || !zone || !resolution || isDown(target)) return {};
  if (sealed(target)) return {};
  const action = zoneAction({ ...zone, area: { resolution } }, zone.name ?? "");
  if (!action) return {};
  const result = resolveAction(action, owner, [target], context, zone.level);
  return {
    // Time Stop ends once what its caster made during it reaches another creature.
    events: [...timeStopEnds(owner, [target]), ...(result.events ?? [])],
    frames: [...(result.frames ?? []), CHECK_END],
  };
}

// The ticks of an area that acts on whoever it reaches, moved from `from`: on the creatures it now covers and didn't,
// as Moonbeam moved onto a foe.
export function movedFrames(
  zone: Zone,
  from: Square,
  context: ContentAccess & { readonly state: DndState },
): Frame[] {
  const { state } = context;
  if (!zone.area?.enters || !zone.area.resolution) return [];
  const before = { ...zone, at: from };
  const reached = Object.values(state.actors).filter(
    (item) =>
      item.position !== null &&
      !inZone(before, item.position) &&
      inZone(zone, item.position) &&
      !caught(zone, item, state) &&
      affects(zone, item, state, context),
  );
  return reached.length > 0
    ? [
        frame("zoneTick", {
          owner: zone.owner,
          sourceId: zone.sourceId,
          targets: reached.map((item) => item.id),
        }),
      ]
    : [];
}

// The areas `owner` keeps that drift away from it as its turn starts, as Cloudkill's 10 feet: where each goes, and
// the ticks on whoever it moves onto. shortcut: Incendiary Cloud's chosen direction is away from its caster too.
export function driftResult(
  owner: Actor,
  context: ContentAccess & { readonly state: DndState },
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const { state } = context;
  const grid = state.combat?.grid;
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  const seen = new Set<string>();
  for (const zone of zonesOf(state)) {
    const feet = zone.area?.drifts;
    if (!feet || zone.owner !== owner.id || zone.follows || !owner.position) {
      continue;
    }
    if (seen.has(zone.sourceId)) continue;
    seen.add(zone.sourceId);
    const steps = Math.floor(feet / 5);
    const dx = Math.sign(zone.at.x - owner.position.x);
    const dy = Math.sign(zone.at.y - owner.position.y);
    const clamp = (value: number, size: number): number =>
      Math.max(0, Math.min(size - 1, value));
    const to = {
      x: clamp(
        zone.at.x + (dx === 0 && dy === 0 ? 1 : dx) * steps,
        grid?.width ?? Infinity,
      ),
      y: clamp(zone.at.y + dy * steps, grid?.height ?? Infinity),
    };
    if (to.x === zone.at.x && to.y === zone.at.y) continue;
    events.push(
      dndEvent(`${NS}:zoneMoved`, {
        actor: owner.id,
        sourceId: zone.sourceId,
        to,
      }),
    );
    for (const item of zonesOf(state).filter(
      (other) => other.owner === owner.id && other.sourceId === zone.sourceId,
    )) {
      frames.push(...movedFrames({ ...item, at: to }, item.at, context));
    }
  }
  return { events, frames };
}

export const ZoneTickSchema = z.object({
  owner: z.string(),
  sourceId: z.string(),
  targets: z.array(z.string()),
});

// The zone acts on whoever is still in it. One that deals only so much damage ends once it has, as Guardian of Faith.
export function runZoneTick(
  payload: z.infer<typeof ZoneTickSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const owner = state.actors[payload.owner];
  // A spell may leave several zones, as Prismatic Wall's wall and light: the one that acts.
  const zone = zonesOf(state, context).find(
    (item) =>
      item.owner === payload.owner &&
      item.sourceId === payload.sourceId &&
      item.area?.resolution !== undefined,
  );
  if (!owner || !zone) return {};
  const targets = payload.targets.flatMap((id) => {
    const target = state.actors[id];
    return target &&
      inZone(zone, target.position) &&
      affects(zone, target, state, context) &&
      !caught(zone, target, state)
      ? [target]
      : [];
  });
  // A spirit holding the creature it Restrained acts only on that one, as Conjure Elemental's.
  const held = zone.area?.holding ? heldBy(zone, state) : undefined;
  const acting = held
    ? targets.filter((target) => target.id === held.id)
    : targets;
  const action = zoneAction(
    held && zone.area?.holding
      ? { ...zone, area: { ...zone.area, resolution: zone.area.holding } }
      : zone,
    zone.name ?? "",
  );
  if (acting.length === 0 || !action) return {};
  const marks = [
    ...(zone.area?.enters
      ? acting.map((target) =>
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: target.id,
            key: caughtKey(zone, state),
          }),
        )
      : []),
    // What it puts on a creature as its own turn ends is first saved against at the end of its next turn.
    ...(zone.area?.when === "turnEnd"
      ? acting
          .filter((target) => currentActor(state)?.id === target.id)
          .map((target) =>
            dndEvent(`${NS}:oncePerTurnUsed`, {
              actor: target.id,
              key: `${FRESH}${zone.sourceId}`,
            }),
          )
      : []),
  ];
  const result = resolveAction(action, owner, acting, context, zone.level);
  const events = [
    ...timeStopEnds(owner, acting),
    ...marks,
    ...(result.events ?? []),
  ];
  const { maxDamage } = zone.area ?? {};
  if (maxDamage !== undefined) {
    const dealt = events.reduce(
      (sum, event) =>
        event.kind === `${NS}:damaged` &&
        payload.targets.includes(String(event.payload.actor))
          ? sum + Number(event.payload.amount)
          : sum,
      0,
    );
    const key = `${zone.sourceId}${DEALT}`;
    if (dealt > 0) {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: owner.id,
          resource: key,
          amount: dealt,
        }),
      );
    }
    if ((owner.resourcesSpent[key] ?? 0) + dealt >= maxDamage) {
      events.push(
        dndEvent(`${NS}:effectEnded`, {
          actor: owner.id,
          sourceId: zone.sourceId,
          casterId: owner.id,
        }),
      );
    }
  }
  return { events, frames: [...(result.frames ?? []), CHECK_END] };
}

// The creature a zone holds with a condition it gave, if any.
function heldBy(zone: Zone, state: DndState): Actor | undefined {
  return Object.values(state.actors).find(
    (item) =>
      !isDead(item) &&
      item.activeEffects.some(
        ({ sourceId, casterId, modifier }) =>
          sourceId === zone.sourceId &&
          casterId === zone.owner &&
          modifier.kind === "condition",
      ),
  );
}

// Kept in a creature's usedThisTurn: a zone's effects went on it this turn, so they aren't saved against yet.
export const FRESH = "zone-fresh:";

// Kept on a zone's owner: the damage it has dealt so far.
export const DEALT = ":dealt";
export const BURST = "death-burst";

// A creature that has just died bursts where it fell, once, as a flaming skeleton or a balor does. The burst
// comes before the fight is judged over, so the last foe's explosion still lands.
export function burstResult(context: Context): SystemResult | null {
  const { state } = context;
  for (const actor of Object.values(state.actors)) {
    if (!isDead(actor) || !actor.position || actor.resourcesSpent[BURST]) {
      continue;
    }
    if (actor.source.kind === "character") continue;
    const bursts = statsOf(actor, context).passives.flatMap((passive) =>
      passive.kind === "deathBurst" ? [passive] : [],
    );
    const [burst] = bursts;
    if (!burst) continue;
    const events: SystemEvent[] = [
      dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: BURST }),
    ];
    const targets = Object.values(state.actors).filter(
      (item) =>
        item.id !== actor.id &&
        !isDead(item) &&
        !sealed(item) &&
        item.position !== null &&
        distanceFeet(actor.position, item.position) <= burst.radius,
    );
    const result =
      targets.length > 0
        ? resolveAction(
            burstAction(burst.name, burst.radius, burst.resolution),
            actor,
            targets,
            context,
          )
        : {};
    return {
      events: [...events, ...(result.events ?? [])],
      frames: [...(result.frames ?? []), CHECK_END],
    };
  }
  return null;
}

function burstAction(
  name: string,
  radius: number,
  resolution: Resolution,
): KnownAction {
  return {
    id: `${AURA_BURST}${name}`,
    name,
    activation: {
      cost: [],
      targeting: {
        area: { shape: "emanation", radius },
        range: "self",
        side: "enemy",
      },
      resolution,
    },
    spellLevel: null,
  };
}
const AURA_BURST = "burst:";

// A spell cast inside an area that foils spells, as a haunting revenant's Haunted Zone: the caster's save, and
// whether the spell fails and is wasted. Null where nothing foils it.
export function spellFoiled(
  actor: Actor,
  action: KnownAction,
  context: Context,
): { readonly failed: boolean; readonly events: SystemEvent[] } | null {
  const { state } = context;
  if (!zonesOf(state, context).some((zone) => zone.area?.foilsSpells)) {
    return null;
  }
  if (!isSpell(action, actor, context)) return null;
  const foil = zonesOn(actor, state, context).find(
    (zone) => zone.area?.foilsSpells,
  )?.area?.foilsSpells;
  if (!foil) return null;
  const save = rollSave(actor, foil.ability, foil.dc, context, true);
  return { failed: !save.saved, events: save.events };
}

// Whether a monster's stat block has a trait of this kind: a cheap look, kept by the content, before its stats are
// worked out on every hit or step.
const blockHas = (
  actor: Actor,
  kind: Passive["kind"],
  access: ContentAccess,
): boolean =>
  actor.source.kind === "monster" &&
  lookup(access, MonsterSchema, actor.source.statBlockId).passives.some(
    (passive) => passive.kind === kind,
  );

// Kept in a bearer's usedThisTurn once its damage burst has gone off on a turn, so two bursting neighbours can't set
// each other off forever.
const burstKey = (state: DndState): string =>
  `damage-burst@${String(state.combat?.round ?? 0)}.${String(state.combat?.index ?? 0)}`;

// A creature that bursts on taking damage of a type, as a spore of Moander's Explosive Core, once a turn.
export function damageBurstFrames(
  target: Actor,
  types: readonly string[],
  context: ContentAccess & { readonly state: DndState },
): Frame[] {
  if (!blockHas(target, "damageBurst", context) || isDead(target)) return [];
  if (target.usedThisTurn.includes(burstKey(context.state))) return [];
  const bursts = statsOf(target, context).passives.some(
    (passive) =>
      passive.kind === "damageBurst" &&
      passive.damage.some((type) => types.includes(type)),
  );
  return bursts
    ? [frame("damageBurst", { actor: target.id, types: [...types] })]
    : [];
}

export function runDamageBurst(
  payload: { readonly actor: string; readonly types: readonly string[] },
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[payload.actor];
  if (!actor?.position || actor.usedThisTurn.includes(burstKey(state))) {
    return {};
  }
  const burst = statsOf(actor, context).passives.find(
    (passive) =>
      passive.kind === "damageBurst" &&
      passive.damage.some((type) => payload.types.includes(type)),
  );
  if (burst?.kind !== "damageBurst") return {};
  const targets = Object.values(state.actors).filter(
    (item) =>
      item.id !== actor.id &&
      !isDead(item) &&
      !sealed(item) &&
      item.position !== null &&
      distanceFeet(actor.position, item.position) <= burst.radius,
  );
  const mark = dndEvent(`${NS}:oncePerTurnUsed`, {
    actor: actor.id,
    key: burstKey(state),
  });
  if (targets.length === 0) return { events: [mark] };
  const marked = { ...context, state: applyDndEvent(state, mark) };
  const result = resolveAction(
    burstAction(burst.name, burst.radius, burst.resolution),
    actor,
    targets,
    marked,
  );
  return {
    events: [mark, ...(result.events ?? [])],
    frames: [...(result.frames ?? []), CHECK_END],
  };
}

const FOG_BOUND = ":fog-bound";

// The conditions a creature bound to fog has where it stands, as a mist horror Invisible in fog and Incapacitated
// out of it: what changes, as its turn starts and after it moves.
// shortcut: fog that rises or clears round it counts from its next turn or move.
export function fogBoundEvents(
  actor: Actor,
  context: ContentAccess & { readonly state: DndState },
): SystemEvent[] {
  if (!blockHas(actor, "fogBound", context) || isDead(actor)) return [];
  const bound = statsOf(actor, context).passives.find(
    (passive) => passive.kind === "fogBound",
  );
  if (bound?.kind !== "fogBound") return [];
  const sourceId = `${actor.id}${FOG_BOUND}`;
  const wanted =
    obscuring(actor.position, context.state) === "fog"
      ? bound.inside
      : bound.outside;
  const has = actor.activeEffects.flatMap(({ sourceId: id, modifier }) =>
    id === sourceId && modifier.kind === "condition"
      ? [modifier.condition]
      : [],
  );
  if (
    has.length === wanted.length &&
    wanted.every((condition) => has.includes(condition))
  ) {
    return [];
  }
  return [
    ...(has.length > 0
      ? [
          dndEvent(`${NS}:effectEnded`, {
            actor: actor.id,
            sourceId,
            casterId: actor.id,
          }),
        ]
      : []),
    ...wanted.map((condition) =>
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId,
          casterId: actor.id,
          modifier: { kind: "condition", condition },
          ends: "spellDuration",
        },
      }),
    ),
  ];
}

// Whether `actor` is in the light that harms it: sunlight, or for Light Sensitivity any Bright Light.
export function inHarmfulLight(
  actor: Actor,
  light: "sunlight" | "bright",
  state: DndState,
  access: ContentAccess,
): boolean {
  return light === "sunlight"
    ? sunlit(actor.position, state)
    : lightAt(actor.position, state, access) === "bright";
}

// A creature that starts its turn in sunlight that burns it takes the damage, as a vampire does.
export function sunlightFrames(
  actor: Actor,
  context: ContentAccess & { readonly state: DndState },
): Frame[] {
  if (isDead(actor) || actor.source.kind === "character") return [];
  const burns = statsOf(actor, context).passives.some(
    (passive) =>
      passive.kind === "lightSensitive" &&
      passive.damage.length > 0 &&
      inHarmfulLight(actor, passive.light, context.state, context),
  );
  return burns ? [frame("sunlightTick", { actor: actor.id })] : [];
}

export function runSunlightTick(
  payload: { readonly actor: string },
  context: Context,
): SystemResult {
  const target = context.state.actors[payload.actor];
  if (!target || isDead(target)) return {};
  const stats = deriveStats(target, context);
  const responses = damageResponses(target, context);
  const hits = stats.passives.flatMap((passive) =>
    passive.kind === "lightSensitive" &&
    inHarmfulLight(target, passive.light, context.state, context)
      ? passive.damage.map(({ amount, type }) => ({
          amount: finalDamage(
            rollAmount(amount, stats, context.dice),
            type,
            responses,
          ),
          type,
        }))
      : [],
  );
  const { events, dealt } = dealEvents(target, hits, false, context);
  return { events, frames: [...concentrationFrame(target, dealt), CHECK_END] };
}

export const areaFrames = {
  [`${NS}:zoneTick`]: frameHandler({
    schema: ZoneTickSchema,
    run: runZoneTick,
  }),
  [`${NS}:wallLayer`]: frameHandler({
    schema: WallLayerSchema,
    run: runWallLayer,
  }),
  [`${NS}:damageBurst`]: frameHandler({
    schema: z.object({ actor: z.string(), types: z.array(z.string()) }),
    run: runDamageBurst,
  }),
  [`${NS}:sunlightTick`]: frameHandler({
    schema: z.object({ actor: z.string() }),
    run: runSunlightTick,
  }),
};
