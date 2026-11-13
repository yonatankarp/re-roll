import type { ContentAccess, SystemEvent } from "#sdk";
import { ItemSchema, type Weapon } from "./schemas.ts";
import {
  type Actor,
  INCAPACITATING,
  NS,
  type TACTICS,
  dndEvent,
  hasCondition,
} from "./state.ts";
import type { Stats } from "./stats.ts";

// What the actions anyone can take (Dodge, Hide, Grapple…) and weapon masteries leave on a creature, read by
// the combat rules. The actions themselves are in actions.ts. This file imports nothing from combat.ts.

export const TACTIC = "tactic:"; // option ids and effect sources of those actions
export const HIDE_SOURCE = `${TACTIC}hide`;
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

// Slow takes 10 feet off however often it hits, and each Dash adds the Speed that's left again.
// Climbing out of a dead swallower takes its feet off the whole turn's movement.
export function speedOf(actor: Actor, stats: Stats): number {
  const slowed = hasTactic(actor, "slowed") ? 10 : 0;
  const exiting = tacticsOf(actor, "exiting").reduce(
    (total, { value }) => total + (value ?? 0),
    0,
  );
  return Math.max(
    0,
    Math.max(0, stats.speed - slowed) * (1 + tacticsOf(actor, "dash").length) -
      exiting,
  );
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

const WEAPON = "weapon:"; // the prefix of a weapon's action id, set in stats.ts

export function weaponOf(
  actionId: string,
  access: Pick<ContentAccess, "content">,
): Weapon | null {
  if (!actionId.startsWith(WEAPON)) return null;
  const item = ItemSchema.safeParse(
    access.content(actionId.slice(WEAPON.length)),
  ).data;
  return item?.type === "weapon" ? item : null;
}

// The mastery of the weapon behind an action, if the character has mastered that weapon. Matched by name,
// since a book's Longsword and the SRD's are the same weapon to the player who chose it.
export function masteryOf(
  actor: Actor,
  actionId: string,
  access: Pick<ContentAccess, "content">,
): Weapon["mastery"] | null {
  const build = actor.source.kind === "character" ? actor.source.build : null;
  const weapon = weaponOf(actionId, access);
  if (!build || !weapon) return null;
  const mastered = build.levels.flatMap((level) =>
    level.answers.flatMap((answer) =>
      answer.kind === "weaponMastery" ? answer.values : [],
    ),
  );
  return mastered.some(
    (id) => ItemSchema.safeParse(access.content(id)).data?.name === weapon.name,
  )
    ? weapon.mastery
    : null;
}

// An attack with a Light weapon lets a second Light weapon attack after it (actions.ts).
export const LIGHT_USED = "light:";

export function lightAttackEvents(
  actor: Actor,
  actionId: string,
  access: Pick<ContentAccess, "content">,
): SystemEvent[] {
  return weaponOf(actionId, access)?.properties.includes("light")
    ? [
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: actor.id,
          key: `${LIGHT_USED}${actionId}`,
        }),
      ]
    : [];
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
