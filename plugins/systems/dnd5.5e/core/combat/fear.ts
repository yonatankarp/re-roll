import { frameHandler, type SystemEvent, type SystemResult } from "#sdk";
import { z } from "zod";
import type { LeafEffect } from "../schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  applyDndEvent,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
} from "../state.ts";
import { deriveStats } from "../stats.ts";
import { distanceFeet } from "../grid.ts";
import { behindTotalCover, seeing } from "../sight.ts";
import { levelOrChallenge } from "../forms.ts";
import { TACTIC, walkSpeed } from "../tactics.ts";
import { rollSave } from "./effects.ts";
import { type Context, currentActor, moveSquares } from "./queries.ts";

// Fear and its kin (core/schemas.ts applyCondition): fleeing on its turns, as from Fear or Turn Undead; shaking a
// creature out of a spell, as out of Sleep; saving with an action, as against Irresistible Dance; the Dodge a curse
// forces; and creatures a spell slays or sends away, as Divine Word does.

export const fleeingFrom = (actor: Actor): ActiveEffect | undefined =>
  actor.activeEffects.find(
    (effect) => effect.flee && effect.modifier.kind === "condition",
  );

// Whether `viewer` can't see `target`: Blinded, behind total cover, or in darkness or a zone it can't see into.
export function outOfSight(
  viewer: Actor,
  target: Actor,
  context: Context,
): boolean {
  return (
    hasCondition(viewer, "blinded") ||
    behindTotalCover(context.state, viewer, target) ||
    seeing(viewer, target.position, context.state, context) === "none"
  );
}

const ended = (actor: Actor, effect: ActiveEffect): SystemEvent =>
  dndEvent(`${NS}:effectEnded`, {
    actor: actor.id,
    sourceId: effect.sourceId,
    casterId: effect.casterId,
  });

// As its turn starts a fleeing creature takes the Dash action, when it can act, and spends its movement getting as far
// from the caster as it can. Turn Undead's ends first if its caster is Incapacitated or dead.
// shortcut: the flight provokes no Opportunity Attacks, as a push doesn't, and goes to the farthest square it can walk
// to rather than by the safest route.
export function runFleeTurn(context: Context): SystemResult {
  const { state } = context;
  const actor = currentActor(state);
  const effect = actor ? fleeingFrom(actor) : undefined;
  if (!actor || !effect || isDown(actor) || !actor.position) return {};
  const caster = state.actors[effect.casterId];
  if (
    !caster?.position ||
    isDead(caster) ||
    (effect.flee?.casterDown &&
      (isDown(caster) || hasCondition(caster, ...INCAPACITATING)))
  ) {
    return effect.flee?.casterDown ? { events: [ended(actor, effect)] } : {};
  }
  const events: SystemEvent[] = [];
  if (actor.budget.action && !hasCondition(actor, ...INCAPACITATING)) {
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: "action" }),
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId: `${TACTIC}dash`,
          casterId: actor.id,
          modifier: {
            kind: "tactic",
            tactic: "dash",
            value: walkSpeed(actor, deriveStats(actor, context)),
          },
          ends: "casterNextTurn",
        },
      }),
    );
  }
  const after = events.reduce(applyDndEvent, state);
  const moving = after.actors[actor.id] ?? actor;
  const away = (square: { x: number; y: number } | null): number =>
    distanceFeet(caster.position, square);
  const [farthest] = [
    ...moveSquares(moving, after, deriveStats(moving, context), context),
  ].sort((a, b) => away(b.square) - away(a.square) || a.feet - b.feet);
  if (farthest && away(farthest.square) > away(actor.position)) {
    events.push(
      dndEvent(`${NS}:moved`, {
        actor: actor.id,
        to: farthest.square,
        feet: farthest.feet,
      }),
    );
  }
  return { events };
}

// Whether a fleeing creature's repeat save is made as this turn ends: Fear's only out of the caster's sight.
export function repeatsNow(
  actor: Actor,
  effect: ActiveEffect,
  context: Context,
): boolean {
  if (effect.actionSave) return false;
  if (!effect.flee?.unseen) return true;
  const caster = context.state.actors[effect.casterId];
  return !caster || outOfSight(caster, actor, context);
}

// Eyebite's Panicked ends once the creature is far enough away where the caster can't see it.
export function fledEvents(actor: Actor, context: Context): SystemEvent[] {
  return actor.activeEffects.flatMap((effect) => {
    const far = effect.flee?.far;
    const caster = context.state.actors[effect.casterId];
    return far !== undefined &&
      (!caster ||
        (distanceFeet(caster.position, actor.position) >= far &&
          outOfSight(caster, actor, context)))
      ? [ended(actor, effect)]
      : [];
  });
}

// Bestow Curse's Dodge: a failed save as its turn starts spends its action on the Dodge action.
export function dodgeSaveEvents(actor: Actor, context: Context): SystemEvent[] {
  if (isDown(actor) || !actor.budget.action) return [];
  const curse = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "dodgeSave",
  );
  if (curse?.modifier.kind !== "dodgeSave") return [];
  const { ability, dc } = curse.modifier;
  const save = rollSave(actor, ability, dc ?? 10, context, true);
  return save.saved
    ? save.events
    : [
        ...save.events,
        dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: "action" }),
        dndEvent(`${NS}:effectAdded`, {
          actor: actor.id,
          effect: {
            sourceId: `${TACTIC}dodge`,
            casterId: actor.id,
            modifier: { kind: "tactic", tactic: "dodge" },
            ends: "casterNextTurn",
          },
        }),
      ];
}

export const SHAKE = `${TACTIC}shake`;
export const COLLECT = `${TACTIC}collect`;

// The allies within 5 feet that `actor` can shake out of a spell with its action, as out of Sleep.
export function shakeable(
  actor: Actor,
  context: Context,
): readonly Actor[] {
  return Object.values(context.state.actors).filter(
    (item) =>
      item.id !== actor.id &&
      item.side === actor.side &&
      !isDead(item) &&
      distanceFeet(actor.position, item.position) <= 5 &&
      item.activeEffects.some(({ shake }) => shake),
  );
}

// Shaking a creature ends every effect on it that another's action ends.
export function shakeEvents(target: Actor): SystemEvent[] {
  return target.activeEffects.flatMap((effect) =>
    effect.shake ? [ended(target, effect)] : [],
  );
}

// The effects `actor` can spend its action to save against, as Irresistible Dance.
export const collectable = (actor: Actor): readonly ActiveEffect[] =>
  actor.activeEffects.filter(
    (effect) => effect.actionSave && effect.repeatSave,
  );

// The save of one of them, ending every effect of that source and caster on a success.
export function collectEvents(
  actor: Actor,
  effect: ActiveEffect,
  context: Context,
): SystemEvent[] {
  if (!effect.repeatSave) return [];
  const save = rollSave(
    actor,
    effect.repeatSave.ability,
    effect.repeatSave.dc,
    context,
    effect.sourceId.startsWith("spell:"),
  );
  return [
    ...save.events,
    ...(save.saved
      ? actor.activeEffects.flatMap((item) =>
          item.sourceId === effect.sourceId && item.casterId === effect.casterId
            ? [ended(actor, item)]
            : [],
        )
      : []),
  ];
}

// Divine Word's lowest band: a target with few enough Hit Points dies.
export function slayEvents(
  effect: Extract<LeafEffect, { kind: "slay" }>,
  target: Actor,
): SystemEvent[] {
  return target.hp > 0 && target.hp <= effect.hpAtMost
    ? [
        dndEvent(`${NS}:damaged`, {
          actor: target.id,
          amount: target.hp + target.tempHp,
          type: "radiant",
          critical: false,
          massive: true,
        }),
        { kind: "actorDefeated", actor: target.id },
      ]
    : [];
}

// Sent off to another plane: shut away for good, which counts as beaten (combat/turn.ts shutAway).
// shortcut: Arcane Abjuration's banishing reaches any creature its CR allows, as if none were on its own plane.
export function sendAwayEvents(
  effect: Extract<LeafEffect, { kind: "sendAway" }>,
  sourceId: string,
  caster: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  if (isDead(target)) return [];
  const type = deriveStats(target, context).creatureType ?? "";
  if (effect.creatureTypes && !effect.creatureTypes.includes(type)) return [];
  if (effect.crByLevel) {
    const level =
      deriveStats(caster, context).classLevels[effect.crByLevel.class] ?? 0;
    const reached = effect.crByLevel.at.filter((row) => level >= row.level);
    const cr = reached[reached.length - 1]?.cr;
    if (cr === undefined || levelOrChallenge(target, context) > cr) return [];
  }
  return [
    dndEvent(`${NS}:effectAdded`, {
      actor: target.id,
      effect: {
        sourceId: `${sourceId}:sent-away`,
        casterId: caster.id,
        modifier: { kind: "sealed" },
        ends: "spellDuration",
      },
    }),
  ];
}

export const fearFrames = {
  [`${NS}:fleeTurn`]: frameHandler({
    schema: z.object({}),
    run: (_payload, context: Context) => runFleeTurn(context),
  }),
};
