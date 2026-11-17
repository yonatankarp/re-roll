import { frameHandler, type SystemEvent, type SystemResult } from "#sdk";
import { z } from "zod";
import { ItemSchema, type LeafEffect } from "../schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  applyDndEvent,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
} from "../state.ts";
import {
  damageResponses,
  deriveStats,
  passiveModifiers,
  rollAmount,
} from "../stats.ts";
import { finalDamage } from "../rules.ts";
import { distanceFeet } from "../grid.ts";
import { behindTotalCover, seeing } from "../sight.ts";
import { levelOrChallenge } from "../forms.ts";
import { TACTIC, walkSpeed } from "../tactics.ts";
import { dealEvents, rollSave } from "./effects.ts";
import { type Context, currentActor, moveSquares } from "./queries.ts";

// Fear and its kin (core/schemas.ts applyCondition): fleeing on its turns, as from Fear or Turn Undead; shaking a
// creature out of a spell, as out of Sleep; saving with an action, as against Irresistible Dance; the Dodge a curse
// forces; a save before casting; and creatures a spell sends away, as Divine Word does.

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
export function shakeable(actor: Actor, state: DndState): readonly Actor[] {
  return Object.values(state.actors).filter(
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

// Power Word Pain or Gehennan Cruelty: a save before casting a spell, whose failure wastes the action, and the slot too
// unless the effect keeps it.
export function castSaveFoiled(
  actor: Actor,
  spell: boolean,
  context: Context,
): {
  readonly failed: boolean;
  readonly keepSlot: boolean;
  readonly events: SystemEvent[];
} | null {
  if (!spell) return null;
  const events: SystemEvent[] = [];
  // Gehennan Cruelty's comes as a passive from the plane around it (environment.ts).
  for (const modifier of [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(deriveStats(actor, context).passives),
  ]) {
    if (modifier.kind !== "castSave") continue;
    const save = rollSave(actor, modifier.ability, modifier.dc ?? 10, context);
    events.push(...save.events);
    if (!save.saved) {
      return { failed: true, keepSlot: modifier.keepSlot === true, events };
    }
  }
  return events.length > 0 ? { failed: false, keepSlot: false, events } : null;
}

// Contagion's Poisoned: what would end it does so only if the creature passes the save it came with.
export function clingSave(
  target: Actor,
  condition: string,
  context: Context,
): { readonly held: boolean; readonly events: SystemEvent[] } {
  const effect = target.activeEffects.find(
    ({ clings, modifier }) =>
      clings &&
      modifier.kind === "condition" &&
      modifier.condition === condition,
  );
  if (!effect?.clings) return { held: false, events: [] };
  const save = rollSave(
    target,
    effect.clings.ability,
    effect.clings.dc,
    context,
    true,
  );
  return { held: !save.saved, events: save.events };
}

// Fear: the creature drops the weapons it has ready, which lie where it stands until picked up (actions.ts) and go
// back to it after the fight.
// shortcut: every weapon it carries outside its pack counts as held, and a monster's stat block attacks aren't items,
// so it keeps them.
export function dropEvents(target: Actor, context: Context): SystemEvent[] {
  const at = target.position;
  if (!at || !context.state.combat) return [];
  const stowed = [...(target.stowed ?? [])];
  return target.inventory.flatMap((item) => {
    const packed = stowed.indexOf(item);
    if (packed >= 0) {
      stowed.splice(packed, 1);
      return [];
    }
    return ItemSchema.safeParse(context.content(item)).data?.type === "weapon"
      ? [
          dndEvent(`${NS}:weaponThrown`, {
            item,
            at,
            by: target.id,
          }),
        ]
      : [];
  });
}

// Mental Prison: moving out of the illusory cell, or attacking through it in melee, hurts and ends it.
export function prisonEvents(actor: Actor, context: Context): SystemEvent[] {
  const cell = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "prison",
  );
  if (cell?.modifier.kind !== "prison") return [];
  const caster = context.state.actors[cell.casterId] ?? actor;
  const stats = deriveStats(caster, context);
  const { events } = dealEvents(
    actor,
    cell.modifier.damage.map(({ amount, type }) => ({
      amount: finalDamage(
        rollAmount(amount, stats, context.dice),
        type,
        damageResponses(actor, context),
      ),
      type,
    })),
    false,
    context,
  );
  return [...events, ended(actor, cell)];
}
