import { zonesOf } from "../../zones.ts";
import {
  type Actor,
  hasCondition,
  INCAPACITATING,
  isDead,
  mountOf,
} from "../../state.ts";
import { distanceFeet } from "../../grid.ts";
import {
  deriveStats,
  type KnownAction,
  passiveModifiers,
  type Stats,
} from "../../stats.ts";
import { type Resolution } from "../../schemas.ts";
import { markedBy } from "../../trait-rules.ts";
import { type Context, hasPassive, ridden, sizeOf } from "../queries.ts";

// Mounted Strike: Advantage from the saddle against an unmounted creature next to the mount and smaller than it.
export function mountedStrike(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): boolean {
  const mount = hasPassive(stats, "mountedCombatant")
    ? ridden(attacker, context.state)
    : null;
  return (
    mount !== null &&
    mountOf(target) === null &&
    distanceFeet(mount.position, target.position) <= 5 &&
    sizeOf(target, context) < sizeOf(mount, context)
  );
}

// Invoke Duplicity's Distract: an attack on a creature within 5 feet of the bearer's image of itself, by the bearer
// within 5 feet of that creature too, or with Shared Distraction by any of its allies.
// shortcut: the creature distracted needn't see the image.
export function distracted(
  attacker: Actor,
  target: Actor,
  context: Context,
): boolean {
  const near = (at: { x: number; y: number } | null): boolean =>
    distanceFeet(at, target.position) <= 5;
  return zonesOf(context.state).some((zone) => {
    if (zone.zone !== "image" || !zone.decoy || !near(zone.at)) return false;
    const bearer = context.state.actors[zone.owner];
    if (bearer?.side !== attacker.side) return false;
    const distract = deriveStats(bearer, context).passives.find(
      (passive) => passive.kind === "distract",
    );
    if (distract?.kind !== "distract") return false;
    return (
      distract.allies === true ||
      (bearer.id === attacker.id && near(attacker.position))
    );
  });
}

// Elusive or Trance of Order: attack rolls against the bearer can't have Advantage.
export function unadvantaged(
  target: Actor,
  stats: Stats,
  attacker: Actor,
): boolean {
  return [
    ...target.activeEffects.map(({ modifier }) => modifier),
    ...passiveModifiers(stats.passives),
  ].some(
    (modifier) =>
      modifier.kind === "noAdvantageAgainst" &&
      (!modifier.able || !hasCondition(target, ...INCAPACITATING)) &&
      // Wildhunt's: only attackers this near
      (modifier.within === undefined ||
        distanceFeet(attacker.position, target.position) <= modifier.within),
  );
}

export const PEERLESS_AIM = "peerless-aim";

// An Oathbow's curse on its bearer: while its sworn enemy lives, the bearer's other weapons attack with
// Disadvantage.
export function swornElsewhere(
  attacker: Actor,
  action: KnownAction,
  resolution: Extract<Resolution, { kind: "attack" }>,
  context: Context,
): boolean {
  if (resolution.attack.type !== "weapon") return false;
  const swearing = deriveStats(attacker, context).actions.flatMap((item) => {
    const { resolution: other } = item.activation;
    return other.kind === "attack" && other.sworn ? [other.sworn.item] : [];
  });
  return swearing.some(
    (item) =>
      resolution.sworn?.item !== item &&
      Object.values(context.state.actors).some(
        (other) => !isDead(other) && markedBy(other, attacker, [item]),
      ),
  );
}
