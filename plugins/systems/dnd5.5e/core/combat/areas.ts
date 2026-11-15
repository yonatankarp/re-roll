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
  type DndState,
  dndEvent,
  frame,
  isDead,
  NS,
} from "../state.ts";
import type { Resolution } from "../schemas.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  rollAmount,
} from "../stats.ts";
import { finalDamage } from "../rules.ts";
import { distanceFeet } from "../grid.ts";
import { lightAt } from "../sight.ts";
import {
  affects,
  inZone,
  sealed,
  sunlit,
  type Zone,
  zonesOf,
} from "../zones.ts";
import { CHECK_END, type Context } from "./queries.ts";
import { concentrationFrame, dealEvents, resolveAction } from "./effects.ts";

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
  const zone = zonesOf(state, context).find(
    (item) =>
      item.owner === payload.owner && item.sourceId === payload.sourceId,
  );
  if (!owner || !zone) return {};
  const targets = payload.targets.flatMap((id) => {
    const target = state.actors[id];
    return target &&
      inZone(zone, target.position) &&
      affects(zone, target, state, context)
      ? [target]
      : [];
  });
  const action = zoneAction(zone, zone.name ?? "");
  if (targets.length === 0 || !action) return {};
  const result = resolveAction(action, owner, targets, context, zone.level);
  const events = [...(result.events ?? [])];
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
    const bursts = deriveStats(actor, context).passives.flatMap((passive) =>
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
  const burns = deriveStats(actor, context).passives.some(
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
  [`${NS}:sunlightTick`]: frameHandler({
    schema: z.object({ actor: z.string() }),
    run: runSunlightTick,
  }),
};
