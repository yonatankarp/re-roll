import type { ContentAccess, Dice, SystemEvent } from "#sdk";
import type { Duration, Modifier } from "../schemas.ts";
import type { KnownAction } from "../stats.ts";
import { spellOf } from "./dispel.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  dndEvent,
  NS,
  turnId,
} from "../state.ts";

// Durations counted in rounds, and the limits Slow and its kin put on a creature's turn.

type Lasts = NonNullable<ActiveEffect["lasts"]>;

// The round `actorId`'s next turn starts in, counting from the turn under way.
function nextTurnRound(state: DndState, actorId: string): number {
  const combat = state.combat;
  if (!combat) return 0;
  return combat.order.indexOf(actorId) > combat.index
    ? combat.round
    : combat.round + 1;
}

// When an effect with this duration runs out, as the effect's `lasts`, or nothing for one that lasts the fight or
// ends some other way. A minute is ten rounds, to the start of the caster's turn.
export function lastsFor(
  duration: Duration,
  caster: Actor,
  target: Actor,
  state: DndState,
): { lasts?: Lasts } {
  const combat = state.combat;
  if (!combat || typeof duration !== "object") return {};
  if ("until" in duration) {
    switch (duration.until) {
      case "itsNextTurnStart":
      case "itsNextTurnEnd":
        return {
          lasts: {
            actor: target.id,
            round: nextTurnRound(state, target.id),
            at: duration.until === "itsNextTurnStart" ? "start" : "end",
          },
        };
      case "turnEnd":
        return {
          lasts: {
            actor: turnId(combat) ?? target.id,
            round: combat.round,
            at: "end",
          },
        };
      default:
        return {};
    }
  }
  if (!("minutes" in duration)) return {};
  // A Dampened Magic Zone halves a spell lasting a minute or more.
  const rounds = state.combat?.environment?.halfDurations
    ? 5 * duration.minutes
    : 10 * duration.minutes;
  return {
    lasts: {
      actor: caster.id,
      round: nextTurnRound(state, caster.id) + rounds - 1,
      at: "start",
    },
  };
}

// The effects that run out as `actorId`'s turn starts or ends, and as a turn starts, any whose turn went by
// without coming round, as when that creature died.
export function expiredEvents(
  state: DndState,
  actorId: string,
  at: "start" | "end",
): SystemEvent[] {
  const round = state.combat?.round ?? 0;
  const seen = new Set<string>();
  const events: SystemEvent[] = [];
  for (const actor of Object.values(state.actors)) {
    for (const { lasts, sourceId, casterId } of actor.activeEffects) {
      if (!lasts) continue;
      const due =
        (lasts.at === at && lasts.actor === actorId && lasts.round <= round) ||
        (at === "start" && lasts.round < round);
      const key = `${actor.id}|${sourceId}|${casterId}`;
      if (!due || seen.has(key)) continue;
      seen.add(key);
      events.push(
        dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId, casterId }),
      );
    }
  }
  return events;
}

type Limit = Extract<Modifier, { kind: "actionLimit" }>;

// The limits on a creature's turn, merged from every effect that sets them.
export function limitsOf(actor: Actor): Omit<Limit, "kind"> {
  let limit: Omit<Limit, "kind"> = {};
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "actionLimit") limit = { ...limit, ...modifier };
  }
  return limit;
}

// What a limit takes away at once: the Reaction, and with no actions at all, the turn's action and Bonus Action
// when it's that creature's turn. They're taken again as each of its turns starts.
export function limitEvents(
  actor: Actor,
  limit: Omit<Limit, "kind">,
  ownTurn: boolean,
): SystemEvent[] {
  const spend = (kind: "action" | "bonusAction" | "reaction"): SystemEvent =>
    dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind });
  return [
    ...(limit.noReactions && actor.budget.reaction ? [spend("reaction")] : []),
    ...(limit.noActions && ownTurn && actor.budget.action
      ? [spend("action")]
      : []),
    ...(limit.noActions && ownTurn && actor.budget.bonusAction
      ? [spend("bonusAction")]
      : []),
  ];
}

// Once an action or a Bonus Action is spent, the other goes too for a creature that can take only one.
export function oneActionEvents(actor: Actor): SystemEvent[] {
  const { action, bonusAction } = actor.budget;
  const { oneAction, oneThing } = limitsOf(actor);
  if (!(oneAction || oneThing) || action === bonusAction) return [];
  return [
    dndEvent(`${NS}:budgetSpent`, {
      actor: actor.id,
      kind: action ? "action" : "bonusAction",
    }),
  ];
}

export const HASTE_ACTION = "haste-action";
const LETHARGY = ":lethargy";

const hasted = (actor: Actor): boolean =>
  actor.activeEffects.some(({ modifier }) => modifier.kind === "hasted");

// Taking Haste's additional action, which allows one attack, Dash, Disengage or Hide.
export const hasteActing = (actor: Actor): boolean =>
  hasted(actor) && actor.usedThisTurn.includes(HASTE_ACTION);

// What Haste leaves waiting on its target, for when the spell ends (turnStartEvents).
export function lethargyEffect(
  sourceId: string,
  casterId: string,
  target: Actor,
): SystemEvent | null {
  return target.activeEffects.some(
    ({ modifier }) => modifier.kind === "lethargy",
  )
    ? null
    : dndEvent(`${NS}:effectAdded`, {
        actor: target.id,
        effect: {
          sourceId: `${sourceId}${LETHARGY}`,
          casterId,
          modifier: { kind: "lethargy" },
          ends: "spellDuration",
        },
      });
}

// As a creature's turn starts: Slow's limits again, and once Haste is gone, its lethargy, Incapacitated until
// the turn ends.
export function turnStartEvents(actor: Actor, state: DndState): SystemEvent[] {
  const events = limitEvents(actor, limitsOf(actor), true);
  const waiting = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "lethargy",
  );
  if (waiting && !hasted(actor)) {
    const { sourceId, casterId } = waiting;
    events.push(
      dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId, casterId }),
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId,
          casterId,
          modifier: { kind: "condition", condition: "incapacitated" },
          ends: "spellDuration",
          lasts: {
            actor: actor.id,
            round: state.combat?.round ?? 0,
            at: "end",
          },
        },
      }),
    );
  }
  return events;
}

// After an action: Slow takes the other of action and Bonus Action, and Haste gives its additional action back once.
export function afterActionEvents(actor: Actor): SystemEvent[] {
  const events = oneActionEvents(actor);
  if (
    hasted(actor) &&
    !actor.budget.action &&
    !actor.usedThisTurn.includes(HASTE_ACTION) &&
    !limitsOf(actor).oneAction &&
    !limitsOf(actor).oneThing
  ) {
    events.push(
      dndEvent(`${NS}:actionRegained`, { actor: actor.id }),
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key: HASTE_ACTION }),
    );
  }
  return events;
}

// Slow's chance that a spell with a Somatic component fails, rolled as it's cast: the action and slot are spent.
export function spellFumble(
  actor: Actor,
  action: KnownAction,
  context: ContentAccess & { readonly dice: Dice },
): SystemEvent | null {
  const { spellFailure } = limitsOf(actor);
  if (spellFailure === undefined) return null;
  const spell = spellOf(action.id, actor, context);
  if (!spell || !/\bS\b/.test(spell.components)) return null;
  const roll = context.dice.roll(100);
  return roll > spellFailure
    ? null
    : dndEvent(`${NS}:rollReported`, {
        actor: actor.id,
        against: "check",
        natural: roll,
        total: roll,
        target: spellFailure + 1,
        success: false,
        label: "the spell's gestures under Slow",
      });
}

// Time Stop ends once something its caster does reaches another creature.
export function timeStopEnds(
  actor: Actor,
  targets: readonly Actor[],
): SystemEvent[] {
  const stopped = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "extraTurns",
  );
  return stopped && targets.some((target) => target.id !== actor.id)
    ? [
        dndEvent(`${NS}:effectEnded`, {
          actor: actor.id,
          sourceId: stopped.sourceId,
          casterId: stopped.casterId,
        }),
      ]
    : [];
}

// At the end of a turn under Time Stop, another turn of the caster's own, while it has turns left.
export function extraTurnEvents(actor: Actor): SystemEvent[] | null {
  const stopped = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "extraTurns",
  );
  if (stopped?.modifier.kind !== "extraTurns") return null;
  const { sourceId, casterId } = stopped;
  const left = stopped.modifier.turns - 1;
  return [
    dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId, casterId }),
    ...(left > 0
      ? [
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              ...stopped,
              modifier: { kind: "extraTurns", turns: left },
            },
          }),
        ]
      : []),
    dndEvent(`${NS}:turnRepeated`, { actor: actor.id }),
  ];
}
