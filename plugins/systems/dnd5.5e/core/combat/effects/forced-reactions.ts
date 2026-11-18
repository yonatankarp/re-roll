import { damageResponses, deriveStats, rollAmount } from "../../stats.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import { type Frame, type SystemEvent } from "#sdk";
import { type LeafEffect } from "../../schemas.ts";
import { speedOf } from "../../tactics.ts";
import { distanceFeet, pushTo } from "../../grid.ts";
import { sealed } from "../../zones.ts";
import { besideSquare } from "../reactions.ts";
import {
  type Context,
  enemies,
  inReach,
  isMelee,
  meleeReach,
} from "../queries.ts";
import { dealEvents } from "./damage.ts";
import { concentrationFrame } from "./concentration.ts";

// Reactions an effect makes a creature take: an attack, or a step towards or away.

// Aura of Violence: the target spends its Reaction on a melee attack against a creature in its reach, its own side
// first, or takes the damage when no creature is in reach. One with no Reaction left does neither.
export function forcedAttack(
  effects: readonly LeafEffect[],
  caster: Actor,
  target: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const forced = effects.find((effect) => effect.kind === "forcedAttack");
  if (forced?.kind !== "forcedAttack" || isDown(target)) {
    return { events: [], frames: [] };
  }
  const { state } = context;
  const melee = deriveStats(target, context).actions.filter(
    (item) =>
      meleeReach(item) !== null &&
      item.activation.resolution.kind === "attack" &&
      !item.activation.trigger &&
      item.spellLevel === null,
  );
  const reach = Math.max(5, ...melee.map((item) => meleeReach(item) ?? 0));
  const [victim] = Object.values(state.actors)
    .filter(
      (item) =>
        item.id !== target.id &&
        !isDead(item) &&
        !sealed(item) &&
        item.position !== null &&
        distanceFeet(target.position, item.position) <= reach,
    )
    .sort(
      (a, b) =>
        Number(b.side === target.side) - Number(a.side === target.side) ||
        a.hp - b.hp,
    );
  if (!victim) {
    const stats = deriveStats(caster, context);
    const responses = damageResponses(target, context);
    const hurt = dealEvents(
      target,
      forced.otherwise.map(({ amount, type }) => ({
        amount: rollAmount(amount, stats, context.dice),
        response: responses,
        type,
      })),
      false,
      context,
    );
    return {
      events: hurt.events,
      frames: [...concentrationFrame(target, hurt.dealt)],
    };
  }
  const away = distanceFeet(target.position, victim.position);
  const weapon = melee.find((item) => (meleeReach(item) ?? 0) >= away);
  if (
    !weapon ||
    !target.budget.reaction ||
    hasCondition(target, ...INCAPACITATING)
  ) {
    return { events: [], frames: [] };
  }
  return {
    events: [
      dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    ],
    frames: [
      frame("attackRoll", {
        attacker: target.id,
        actionId: weapon.id,
        target: victim.id,
      }),
    ],
  };
}

// A creature spends its Reaction on one melee attack at the weakest foe in its reach, as Incite Rampage gives.
export function reactionAttack(
  target: Actor,
  context: Context,
): { events: SystemEvent[]; frames: Frame[] } {
  if (!target.budget.reaction || isDown(target)) {
    return { events: [], frames: [] };
  }
  const { actions } = deriveStats(target, context);
  const melee = actions.find(
    (action) =>
      action.activation.resolution.kind === "attack" &&
      action.activation.cost.includes("action") &&
      isMelee(action),
  );
  const foe = melee
    ? [...inReach(melee, target, context.state, context)].sort(
        (a, b) => a.hp - b.hp,
      )[0]
    : undefined;
  if (!melee || !foe) return { events: [], frames: [] };
  return {
    events: [
      dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    ],
    frames: [
      frame("useAction", {
        actor: target.id,
        actionId: melee.id,
        target: foe.id,
      }),
    ],
  };
}

// A creature spends its Reaction to step beside its nearest foe within its Speed, or to get as far from the caster as
// it can, provoking nothing.
// shortcut: fleeing goes straight away from the caster, as a push does, not by the safest winding route.
export function reactionMove(
  target: Actor,
  context: Context,
  effect: Extract<LeafEffect, { kind: "reactionMove" }>,
  caster: Actor,
): SystemEvent[] {
  if (!target.budget.reaction || isDown(target) || !target.position) return [];
  const full = speedOf(target, deriveStats(target, context));
  const speed = effect.half ? Math.floor(full / 10) * 5 : full;
  if (effect.away) {
    const to =
      speed > 0 ? pushTo(caster.position, target, speed, context.state) : null;
    return to
      ? [
          dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
          dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 }),
        ]
      : [];
  }
  const [foe] = enemies(context.state, target)
    .filter((item) => !isDown(item) && item.position)
    .sort(
      (a, b) =>
        distanceFeet(target.position, a.position) -
        distanceFeet(target.position, b.position),
    );
  if (!foe || distanceFeet(target.position, foe.position) <= 5) return [];
  const to = besideSquare(target, foe, context);
  if (!to || distanceFeet(target.position, to) > speed) return [];
  return [
    dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 }),
  ];
}
