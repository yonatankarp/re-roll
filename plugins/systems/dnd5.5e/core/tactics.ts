import type { ContentAccess, SystemEvent } from "#sdk";
import { ItemSchema, type Weapon } from "./schemas.ts";
import { weaponItemId } from "./combat/ids.ts";
import {
  type Actor,
  INCAPACITATING,
  NS,
  type TACTICS,
  dndEvent,
  effectiveBuild,
  hasCondition,
} from "./state.ts";
import { type Stats, hasSteadySpeed } from "./stats.ts";
import { limitsOf } from "./combat/durations.ts";

// What the actions anyone can take (Dodge, Hide, Grapple…) and weapon masteries leave on a creature, read by
// the combat rules. The actions themselves are in actions.ts. This file imports nothing from combat.ts.

export const TACTIC = "tactic:"; // option ids and effect sources of those actions
export const HIDE_SOURCE = `${TACTIC}hide`;
// Kept hidden after an attack by Stealth Attack this turn, until the turn ends out of cover (combat/turn.ts).
export const STEALTH_ATTACK = "stealth-attack";
export const GRAPPLE_SOURCE = `${TACTIC}grapple`;
export const MASTERY = "mastery:"; // effect sources of weapon masteries

type Tactic = (typeof TACTICS)[number];

export function tacticsOf(
  actor: Actor,
  tactic: Tactic,
): readonly {
  readonly value?: number | undefined;
  readonly action?: string | undefined;
}[] {
  return actor.activeEffects.flatMap(({ modifier }) =>
    modifier.kind === "tactic" && modifier.tactic === tactic ? [modifier] : [],
  );
}

export function hasTactic(actor: Actor, tactic: Tactic): boolean {
  return tacticsOf(actor, tactic).length > 0;
}

// Dodging stops while the creature is Incapacitated.
export function dodging(actor: Actor): boolean {
  return hasTactic(actor, "dodge") && !hasCondition(actor, ...INCAPACITATING);
}

// The Speed left after Slow, which takes 10 feet off however often it hits.
// Slow the spell halves it and Haste doubles it, after that.
export function walkSpeed(actor: Actor, stats: Stats): number {
  const speed = Math.max(
    0,
    stats.speed - (hasTactic(actor, "slowed") ? 10 : 0),
  );
  const limited = limitsOf(actor).speed;
  // A Ring of Free Action keeps an effect from halving or stopping its Speed.
  const limit =
    hasSteadySpeed(stats) && limited !== "double" ? undefined : limited;
  // Shut away, it goes nowhere, unless it rolls its prison along, as in Resilient Sphere, at half Speed.
  const seals = actor.activeEffects.flatMap(({ modifier }) =>
    modifier.kind === "sealed" ? [modifier] : [],
  );
  if (limit === "none" || seals.some((seal) => !seal.rolls)) return 0;
  if (seals.length > 0) return Math.floor(speed / 10) * 5;
  const hasted = actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "hasted",
  );
  const doubled = hasted || limit === "double" ? speed * 2 : speed;
  return limit === "half" ? Math.floor(doubled / 10) * 5 : doubled;
}

// Each Dash adds that Speed again, or the feet it holds, as a Charge's half Speed.
// Climbing out of a dead swallower takes its feet off the whole turn's movement.
export function speedOf(actor: Actor, stats: Stats): number {
  const walk = walkSpeed(actor, stats);
  const exiting = tacticsOf(actor, "exiting").reduce(
    (total, { value }) => total + (value ?? 0),
    0,
  );
  const dashes = tacticsOf(actor, "dash").reduce(
    (total, { value }) => total + (value ?? walk),
    0,
  );
  return Math.max(0, walk + dashes - exiting);
}

// A Bonus Action Dash's feet: half the Speed, to the square, for a Charge.
export function bonusDashFeet(actor: Actor, stats: Stats): number {
  const walk = walkSpeed(actor, stats);
  const half = stats.passives.some(
    (passive) =>
      passive.kind === "bonusTactics" &&
      passive.half === true &&
      passive.tactics.includes("dash"),
  );
  return half ? 5 * Math.floor(walk / 10) : walk;
}

// A Grappled creature has Disadvantage on attacks against anyone but whoever holds it.
export function grappledAwayFrom(attacker: Actor, target: Actor): boolean {
  const holders = attacker.activeEffects.flatMap(({ modifier, casterId }) =>
    modifier.kind === "condition" && modifier.condition === "grappled"
      ? [casterId]
      : [],
  );
  return holders.length > 0 && !holders.includes(target.id);
}

// Attacking or casting gives a hidden creature away.
export function revealEvents(actor: Actor): SystemEvent[] {
  return hasTactic(actor, "hidden")
    ? [
        dndEvent(`${NS}:effectEnded`, {
          actor: actor.id,
          sourceId: HIDE_SOURCE,
        }),
      ]
    : [];
}

export function weaponOf(
  actionId: string,
  access: Pick<ContentAccess, "content">,
): Weapon | null {
  const itemId = weaponItemId(actionId);
  if (!itemId) return null;
  const item = ItemSchema.safeParse(access.content(itemId)).data;
  return item?.type === "weapon" ? item : null;
}

// The mastery of the weapon behind an action, if the character has mastered that weapon. Matched by name,
// since a book's Longsword and the SRD's are the same weapon to the player who chose it.
export function masteryOf(
  actor: Actor,
  actionId: string,
  access: Pick<ContentAccess, "content">,
): Weapon["mastery"] | null {
  const build = effectiveBuild(actor);
  const weapon = weaponOf(actionId, access);
  if (!build || !weapon) return null;
  const mastered = build.levels.flatMap((level) =>
    level.answers.flatMap((answer) =>
      answer.kind === "weaponMastery" ? answer.values : [],
    ),
  );
  // A +2 Longsword is still a Longsword to master.
  const name = weapon.baseWeapon
    ? ItemSchema.safeParse(access.content(weapon.baseWeapon)).data?.name
    : weapon.name;
  return mastered.some(
    (id) => ItemSchema.safeParse(access.content(id)).data?.name === name,
  )
    ? weapon.mastery
    : null;
}

// An attack with a Light weapon lets a second Light weapon attack after it (actions.ts).
export const LIGHT_USED = "light:";

// An attack with a polearm lets Polearm Master's Pole Strike follow it (actions.ts).
export const POLE_USED = "pole";
// Hew: a crit or a drop with a melee weapon readies its Bonus Action attack ("hew:<action>"), once a turn.
export const HEW_READY = "hew:";
export const HEW_USED = "hew-used";
export const POLE_STRUCK = "pole-struck";

// Pole Strike's weapons: a Quarterstaff, a Spear, or one that is Heavy with Reach. Matched by name, as masteries are.
export function isPolearm(weapon: Weapon): boolean {
  return (
    ["Quarterstaff", "Spear"].includes(weapon.name) ||
    (weapon.properties.includes("heavy") && weapon.properties.includes("reach"))
  );
}

export function lightAttackEvents(
  actor: Actor,
  actionId: string,
  access: Pick<ContentAccess, "content">,
): SystemEvent[] {
  const weapon = weaponOf(actionId, access);
  const used = (key: string) =>
    dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key });
  return [
    ...(weapon?.properties.includes("light")
      ? [used(`${LIGHT_USED}${actionId}`)]
      : []),
    ...(weapon && isPolearm(weapon) && !actor.usedThisTurn.includes(POLE_USED)
      ? [used(POLE_USED)]
      : []),
  ];
}

// How each reads on a creature, in the log, its marks and the board's cues.
export const TACTIC_WORDS: Readonly<Record<Tactic, string>> = {
  dodge: "dodging",
  disengage: "disengaging",
  dash: "dashing",
  hidden: "hidden",
  ready: "ready to strike",
  slowed: "slowed",
  metamagic: "shaping a spell",
  exiting: "climbing out",
  trading: "trading an attack",
  attacksLeft: "attacking",
};

// "Help" for tactic:help, "Sap" for mastery:sap.
export function tacticSourceName(sourceId: string): string | null {
  const word = sourceId.startsWith(TACTIC)
    ? sourceId.slice(TACTIC.length)
    : sourceId.startsWith(MASTERY)
      ? sourceId.slice(MASTERY.length)
      : null;
  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : null;
}
