import { type Frame, type SystemEvent, type SystemResult } from "#sdk";
import { type Actor, dndEvent, frame, NS } from "../state.ts";
import type { KnownAction } from "../stats.ts";
import { spellOf } from "./dispel.ts";
import { payCosts } from "./effects.ts";
import { CHECK_END, type Context } from "./queries.ts";

// Longer Casting Times: a spell whose casting takes a minute or more (a spell's `castRounds`) is cast in a fight by
// spending the action of that many turns in a row while concentrating on the casting. It's paid as it begins and
// takes effect as the last of those turns starts; broken Concentration loses it.
// shortcut: the slot is spent as the casting begins, so a broken one loses it too.

export const CASTING = "casting:";

// The turns a spell takes to cast in a fight, or undefined for one cast in its own turn.
export function castRoundsOf(
  action: KnownAction,
  actor: Actor,
  context: Context,
): number | undefined {
  if (action.spellLevel === null || !context.state.combat) return undefined;
  return spellOf(action.id, actor, context)?.castRounds;
}

// The casting begun: its costs paid, Concentration on it, and the turns still to go.
export function beginCasting(
  actor: Actor,
  action: KnownAction,
  slot: string | undefined,
  target: string | readonly string[],
  rounds: number,
  slotLevel: number | undefined,
  context: Context,
): SystemResult {
  const sourceId = `${CASTING}${action.id}`;
  return {
    events: [
      ...payCosts(action, actor, context, slotLevel),
      ...(actor.concentratingOn !== null
        ? [dndEvent(`${NS}:concentrationEnded`, { actor: actor.id })]
        : []),
      dndEvent(`${NS}:concentrationStarted`, {
        actor: actor.id,
        spell: sourceId,
      }),
      castingEffect(actor, action.id, slot, target, rounds - 1),
    ],
    frames: [CHECK_END, frame("afterAction", { actor: actor.id })],
  };
}

const castingEffect = (
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  target: string | readonly string[],
  left: number,
): SystemEvent =>
  dndEvent(`${NS}:effectAdded`, {
    actor: actor.id,
    effect: {
      sourceId: `${CASTING}${actionId}`,
      casterId: actor.id,
      modifier: {
        kind: "casting",
        actionId,
        target: typeof target === "string" ? target : [...target],
        ...(slot === undefined ? {} : { slot }),
        left,
      },
      ends: "concentration",
    },
  });

// As the caster's turn starts, a casting under way takes its action: one turn fewer to go, or done this turn.
export function castingTurn(actor: Actor): {
  readonly events: SystemEvent[];
  readonly frames: Frame[];
} {
  const casting = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "casting",
  );
  if (casting?.modifier.kind !== "casting") return { events: [], frames: [] };
  const { actionId, target, slot, left } = casting.modifier;
  const spent = dndEvent(`${NS}:budgetSpent`, {
    actor: actor.id,
    kind: "action",
  });
  if (left <= 1) {
    return {
      events: [spent],
      frames: [frame("castCompleted", { actor: actor.id })],
    };
  }
  return {
    events: [
      spent,
      dndEvent(`${NS}:effectEnded`, {
        actor: actor.id,
        sourceId: casting.sourceId,
        casterId: actor.id,
      }),
      castingEffect(actor, actionId, slot, target, left - 1),
    ],
    frames: [],
  };
}
