import {
  type Actor,
  dndEvent,
  hasCondition,
  isDead,
  isDown,
  NS,
} from "../../state.ts";
import { lastsFor } from "../durations.ts";
import { distanceFeet } from "../../grid.ts";
import { seeing } from "../../sight.ts";
import { type SystemEvent } from "#sdk";
import {
  deriveStats,
  type KnownAction,
  modifierFor,
  evaluateFormula,
  type Stats,
} from "../../stats.ts";
import { type Resolution } from "../../schemas.ts";
import { holdsShield } from "../../trait-rules.ts";
import {
  allies,
  type Context,
  exemptFrom,
  hasPassive,
  isMelee,
  within5,
} from "../queries.ts";
import { leafEvents, rollSave } from "../effects.ts";
import { inOwnTurn } from "./attack-kind.ts";

export function deathStruck(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): { readonly doubled: boolean; readonly events: SystemEvent[] } | null {
  const passive = stats.passives.find(({ kind }) => kind === "deathStrike");
  if (
    passive?.kind !== "deathStrike" ||
    (context.state.combat?.round ?? 1) > 1
  ) {
    return null;
  }
  const save = rollSave(
    target,
    passive.ability,
    evaluateFormula(passive.dc, stats),
    context,
  );
  return { doubled: !save.saved, events: save.events };
}

export const CHARGE_ATTACK = "charge-attack";

const FEAST = "sanguine-feast";

export function hasUse(actor: Actor, stats: Stats, resource: string): boolean {
  return (
    (actor.resourcesSpent[resource] ?? 0) < (stats.resources[resource] ?? 0)
  );
}

// A Dhampir's Vampiric Bite on a creature that isn't a Construct or an Undead: Drain heals the biter by the damage
// dealt, and Strengthen adds it to the biter's next attack roll or ability check within a minute.
// shortcut: Drain is taken while the biter is missing that many Hit Points, else Strengthen, without asking.
export function drained(
  resolution: Extract<Resolution, { kind: "attack" }>,
  attacker: Actor,
  target: Actor,
  dealt: number,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const { drain } = resolution;
  if (
    !drain ||
    dealt <= 0 ||
    !hasUse(attacker, stats, drain.resource) ||
    exemptFrom(["construct", "undead"], target, deriveStats(target, context))
  )
    return [];
  const missing = stats.maxHp - Math.max(attacker.hp, 0);
  const strengthen = (to: "attacks" | "checks") =>
    dndEvent(`${NS}:effectAdded`, {
      actor: attacker.id,
      effect: {
        sourceId: `${drain.resource}:strengthen`,
        casterId: attacker.id,
        modifier: {
          kind: "bonus",
          to,
          amount: { bonus: { base: dealt, add: [] } },
          once: true,
        },
        ends: "spellDuration",
        ...lastsFor({ minutes: 1 }, attacker, attacker, context.state),
      },
    });
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: attacker.id,
      resource: drain.resource,
    }),
    ...(missing >= dealt
      ? [
          dndEvent(`${NS}:healed`, {
            actor: attacker.id,
            amount: Math.min(dealt, missing),
            max: stats.maxHp,
          }),
        ]
      : [strengthen("attacks"), strengthen("checks")]),
  ];
}

// Bloodlust's Sanguine Feast: once a turn, a hit on a Bloodied creature, not a Construct or Undead, heals by a Hit
// Point Die.
// shortcut: it's spent whenever it can be, rather than when the bearer is hurt enough to want it.
export function feast(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const passive = stats.passives.find(({ kind }) => kind === "bloodiedFeast");
  const targetStats = deriveStats(target, context);
  if (
    passive?.kind !== "bloodiedFeast" ||
    attacker.usedThisTurn.includes(FEAST) ||
    !hasUse(attacker, stats, passive.resource) ||
    target.hp * 2 > targetStats.maxHp ||
    ["construct", "undead"].includes(targetStats.creatureType ?? "") ||
    attacker.hp >= stats.maxHp
  ) {
    return [];
  }
  return [
    dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: FEAST }),
    dndEvent(`${NS}:resourceSpent`, {
      actor: attacker.id,
      resource: passive.resource,
    }),
    ...leafEvents(
      [
        {
          kind: "hitDieHeal",
          bonus: { base: 0, add: [{ kind: "abilityMod", ability: "con" }] },
        },
      ],
      FEAST,
      attacker,
      attacker,
      context,
    ),
  ];
}

export const BLOODIED_DAMAGE = "bloodied-damage";

const SHIELD_BASH = "shield-bash";

// Shield Master's Shield Bash: once on the bearer's turn, a melee weapon hit on a creature within 5 feet makes it save
// with Strength against 8 + Strength modifier + Proficiency Bonus, or be knocked Prone.
// shortcut: it always knocks Prone rather than pushing 5 feet, since Prone helps the party more.
export function shieldBash(
  attacker: Actor,
  target: Actor,
  action: KnownAction,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  if (
    !hasPassive(stats, "shieldBash") ||
    attacker.usedThisTurn.includes(SHIELD_BASH) ||
    !inOwnTurn(attacker, context) ||
    !isMelee(action) ||
    !within5(attacker, target) ||
    isDown(target) ||
    !holdsShield(attacker, context)
  ) {
    return [];
  }
  const dc = 8 + modifierFor(stats, "str") + stats.proficiency;
  const save = rollSave(target, "str", dc, context, false, 0, ["prone"]);
  return [
    dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: SHIELD_BASH }),
    ...save.events,
    ...(save.saved
      ? []
      : [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: SHIELD_BASH,
              casterId: attacker.id,
              modifier: { kind: "condition", condition: "prone" },
              ends: "spellDuration",
            },
          }),
        ]),
  ];
}

// Tavern Brawler's push: effects on a hit once a turn, on the attacker's own turn.
export function oncePerTurnHit(
  resolution: Extract<Resolution, { kind: "attack" }>,
  action: KnownAction,
  attacker: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  const effects = resolution.onHitOncePerTurn;
  const key = `onhit-effects:${action.id}`;
  if (
    !effects ||
    attacker.usedThisTurn.includes(key) ||
    !inOwnTurn(attacker, context)
  ) {
    return [];
  }
  return [
    dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key }),
    ...leafEvents(effects, action.id, attacker, target, context),
  ];
}

// Lords' Alliance Agent: once a turn, a Critical Hit gives the nearest ally within 30 feet without Heroic
// Inspiration that Inspiration.
export function inspiringStrike(
  attacker: Actor,
  critical: boolean,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const key = "inspiring-strike";
  if (
    !critical ||
    !hasPassive(stats, "critInspiration") ||
    attacker.usedThisTurn.includes(key)
  ) {
    return [];
  }
  const ally = allies(context.state, attacker)
    .filter(
      (item) =>
        item.id !== attacker.id &&
        !isDead(item) &&
        !item.heroicInspiration &&
        distanceFeet(attacker.position, item.position) <= 30 &&
        // who can see or hear the bearer
        (seeing(item, attacker.position, context.state, context) !== "none" ||
          !hasCondition(item, "deafened")),
    )
    .sort(
      (a, b) =>
        distanceFeet(attacker.position, a.position) -
        distanceFeet(attacker.position, b.position),
    )[0];
  return ally
    ? [
        dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key }),
        dndEvent(`${NS}:inspirationGranted`, { actor: ally.id }),
      ]
    : [];
}

// Lords' Alliance Agent's Reassert Honor: an enemy that damages an ally beside the bearer is easier to hit.
export function reassertHonor(
  attacker: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  const { state } = context;
  return allies(state, target).flatMap((bearer) =>
    bearer.id !== target.id &&
    bearer.side !== attacker.side &&
    !isDown(bearer) &&
    within5(bearer, target) &&
    seeing(bearer, attacker.position, state, context) !== "none" &&
    hasPassive(deriveStats(bearer, context), "avengeAlly")
      ? leafEvents(
          [
            {
              kind: "modifier",
              duration: { until: "yourNextTurnEnd" },
              modifier: {
                kind: "advantage",
                on: "attacksAgainst",
                once: true,
                casterOnly: true,
              },
            },
          ],
          "reassert-honor",
          bearer,
          attacker,
          context,
        )
      : [],
  );
}

// Sentinel's Halt: a Sentinel's hit on a creature in that creature's own turn is a reaction, so an Opportunity
// Attack, and takes its Speed to 0 for the turn.
export function halted(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  if (!hasPassive(stats, "sentinel") || !inOwnTurn(target, context)) return [];
  return leafEvents(
    [
      {
        kind: "modifier",
        duration: { until: "yourNextTurnStart" },
        modifier: {
          kind: "bonus",
          to: "speed",
          amount: { bonus: { base: 1000, add: [] } },
          subtract: true,
        },
      },
    ],
    "sentinel",
    attacker,
    target,
    context,
  );
}
