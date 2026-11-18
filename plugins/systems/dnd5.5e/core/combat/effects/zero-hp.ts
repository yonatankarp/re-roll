import { deriveStats, modifierFor } from "../../stats.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  fightingOn,
  isDead,
  isDown,
  NS,
  turnId,
} from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { type Condition, type Passive } from "../../schemas.ts";
import { markedBy } from "../../trait-rules.ts";
import { distanceFeet } from "../../grid.ts";
import { allies, type Context, sizeOf } from "../queries.ts";
import { leafEvents } from "./leaf.ts";
import { animatedEvents } from "./animated.ts";

// A creature dropping to 0 Hit Points: what its foes gain, what it calls, and what keeps it up.

// A foe that just dropped to 0 Hit Points feeds its enemies' traits, as Dark One's Blessing.
// shortcut: the creature whose turn it is counts as the one that dropped it, as most damage comes on its own turn.
export function killEvents(fallen: Actor, context: Context): SystemEvent[] {
  const turn = context.state.combat ? turnId(context.state.combat) : undefined;
  return Object.values(context.state.actors).flatMap((bearer) => {
    if (bearer.side === fallen.side || isDown(bearer)) return [];
    const stats = deriveStats(bearer, context);
    return stats.passives.flatMap((passive) => {
      if (
        passive.kind !== "onKill" ||
        (passive.within !== undefined &&
          !(passive.mine && turn === bearer.id) &&
          distanceFeet(bearer.position, fallen.position) > passive.within) ||
        (passive.resource !== undefined &&
          (bearer.resourcesSpent[passive.resource] ?? 0) >=
            (stats.resources[passive.resource] ?? 0)) ||
        (passive.reaction &&
          (!bearer.budget.reaction ||
            hasCondition(bearer, ...INCAPACITATING))) ||
        (passive.oncePerTurn &&
          (bearer.usedThisTurn.includes(ON_KILL) ||
            hasCondition(bearer, ...INCAPACITATING))) ||
        (passive.marked && !markedBy(fallen, bearer, passive.marked))
      ) {
        return [];
      }
      // Keeper of Souls: the most hurt of the bearer and its allies near it, healed by the foe's Hit Dice.
      const to = passive.ally
        ? ([bearer, ...allies(context.state, bearer)]
            .filter(
              (item) =>
                !isDead(item) &&
                distanceFeet(bearer.position, item.position) <=
                  (passive.within ?? Infinity),
            )
            .map((item) => ({
              item,
              missing: deriveStats(item, context).maxHp - item.hp,
            }))
            .sort((a, b) => b.missing - a.missing)
            .find(({ missing }) => missing > 0)?.item ?? null)
        : bearer;
      if (!to) return [];
      const dice = hitDiceOf(fallen, context);
      const fallenStats = passive.fallenMaxHp
        ? deriveStats(fallen, context)
        : undefined;
      if (
        fallenStats &&
        ["construct", "undead"].includes(fallenStats.creatureType ?? "")
      ) {
        return [];
      }
      const effects = passive.fallenHitDice
        ? passive.effects.map((effect) =>
            effect.kind === "heal"
              ? { ...effect, amount: { bonus: { base: dice, add: [] } } }
              : effect,
          )
        : fallenStats
          ? passive.effects.map((effect) =>
              effect.kind === "tempHp"
                ? {
                    ...effect,
                    amount: { bonus: { base: fallenStats.maxHp, add: [] } },
                  }
                : effect,
            )
          : passive.effects;
      return [
        ...(passive.oncePerTurn
          ? [
              dndEvent(`${NS}:oncePerTurnUsed`, {
                actor: bearer.id,
                key: ON_KILL,
              }),
            ]
          : []),
        ...(passive.resource
          ? [
              dndEvent(`${NS}:resourceSpent`, {
                actor: bearer.id,
                resource: passive.resource,
              }),
            ]
          : []),
        ...(passive.reaction
          ? [
              dndEvent(`${NS}:budgetSpent`, {
                actor: bearer.id,
                kind: "reaction",
              }),
            ]
          : []),
        ...leafEvents(effects, `onKill:${fallen.id}`, bearer, to, context),
      ];
    });
  });
}

const ON_KILL = "onKill";

// Effects from an activation with `transfers` move off a creature that drops to the foe nearest their caster.
export function transferEvents(fallen: Actor, context: Context): SystemEvent[] {
  const { state } = context;
  const moved = new Set<string>();
  return fallen.activeEffects.flatMap((effect) => {
    const caster = state.actors[effect.casterId];
    const key = `${effect.casterId}|${effect.sourceId}`;
    if (!caster || isDown(caster) || moved.has(key)) return [];
    if (!effect.sourceId.startsWith("feature:")) return [];
    const feet = deriveStats(caster, context).actions.find(
      ({ id }) => id === effect.sourceId,
    )?.activation.transfers;
    if (feet === undefined) return [];
    moved.add(key);
    const [next] = Object.values(state.actors)
      .filter(
        (other) =>
          other.id !== fallen.id &&
          other.side !== caster.side &&
          !isDown(other) &&
          distanceFeet(caster.position, other.position) <= feet,
      )
      .sort(
        (a, b) =>
          distanceFeet(caster.position, a.position) -
          distanceFeet(caster.position, b.position),
      );
    if (!next) return [];
    const carried = fallen.activeEffects.filter(
      (item) =>
        item.sourceId === effect.sourceId && item.casterId === effect.casterId,
    );
    return [
      dndEvent(`${NS}:effectEnded`, {
        actor: fallen.id,
        sourceId: effect.sourceId,
        casterId: effect.casterId,
      }),
      ...carried.map((item) =>
        dndEvent(`${NS}:effectAdded`, { actor: next.id, effect: item }),
      ),
    ];
  });
}

// A creature's number of Hit Dice: a character's level, or a monster's worked out from its Hit Points.
// shortcut: a stat block gives no Hit Dice here, so they come from its Hit Points over its size's die and Constitution.
function hitDiceOf(fallen: Actor, context: Context): number {
  const stats = deriveStats(fallen, context);
  if (fallen.source.kind === "character") return stats.level;
  const die = [2.5, 3.5, 4.5, 5.5, 6.5][sizeOf(fallen, context)] ?? 10.5;
  return Math.max(
    1,
    Math.round(stats.maxHp / Math.max(1, die + modifierFor(stats, "con"))),
  );
}

// Dropping to 0 Hit Points without dying: what keeps the creature conscious, as Rage beyond Death or Strength before
// Death, and what it calls, as Faithful Summons.
export function downedEvents(target: Actor, context: Context): SystemEvent[] {
  const stats = deriveStats(target, context);
  const left = (resource: string) =>
    (target.resourcesSpent[resource] ?? 0) < (stats.resources[resource] ?? 0);
  const events: SystemEvent[] = [];
  for (const passive of stats.passives) {
    if (passive.kind === "whenDowned" && left(passive.resource)) {
      events.push(...calledEvents(target, passive, context));
    }
    if (passive.kind !== "fightOn" || fightingOn(target)) continue;
    if (passive.while) {
      const rage = target.activeEffects.find(({ sourceId }) =>
        passive.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
      );
      if (!rage) continue;
      events.push(
        dndEvent(`${NS}:effectAdded`, {
          actor: target.id,
          effect: {
            ...rage,
            modifier: { kind: "fightingOn", delayDeath: true },
          },
        }),
      );
    } else if (
      passive.resource &&
      left(passive.resource) &&
      target.budget.reaction
    ) {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: target.id,
          resource: passive.resource,
        }),
        dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
        dndEvent(`${NS}:effectAdded`, {
          actor: target.id,
          effect: {
            sourceId: `fightOn:${passive.resource}`,
            casterId: target.id,
            modifier: { kind: "fightingOn" },
            ends: "casterNextTurnEnd",
          },
        }),
      );
    }
    if (events.length > 0) break;
  }
  return events;
}

// A `whenDowned` trait's effects, spending its use.
function calledEvents(
  target: Actor,
  passive: Extract<Passive, { kind: "whenDowned" }>,
  context: Context,
): SystemEvent[] {
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: target.id,
      resource: passive.resource,
    }),
    ...passive.effects.flatMap((effect) =>
      effect.kind === "animate"
        ? animatedEvents(effect, target, context)
        : leafEvents([effect], passive.resource, target, target, context),
    ),
  ];
}

// Incapacitated by a foe: a `whenDowned` trait with `incapacitated` answers it, as Faithful Summons does.
export function incapacitatedEvents(
  target: Actor,
  caster: Actor,
  condition: Condition,
  context: Context,
): SystemEvent[] {
  if (caster.side === target.side || !INCAPACITATING.includes(condition)) {
    return [];
  }
  const stats = deriveStats(target, context);
  const passive = stats.passives.find(
    (item) =>
      item.kind === "whenDowned" &&
      item.incapacitated &&
      (target.resourcesSpent[item.resource] ?? 0) <
        (stats.resources[item.resource] ?? 0),
  );
  return passive?.kind === "whenDowned"
    ? calledEvents(target, passive, context)
    : [];
}
