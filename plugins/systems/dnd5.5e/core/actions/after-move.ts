import { type Context, dealEvents, enemies, meleeReach } from "../combat.ts";
import { distanceFeet } from "../grid.ts";
import { finalDamage } from "../rules.ts";
import {
  dndEvent,
  frame,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../state.ts";
import { damageResponses, deriveStats, rollAmount } from "../stats.ts";
import { CHARGE_FROM, tacticsOf } from "../tactics.ts";
import { MOVE_HURT, READY } from "./ids.ts";
import { type Frame, type SystemEvent, type SystemResult } from "#sdk";
import { z } from "zod";

export const AfterMoveSchema = z.object({
  actor: z.string(),
  x: z.number(), // where the move started
  y: z.number(),
});

// A readied attack goes off at a foe stepping into reach. A grapple the move breaks ends in combat/grapple.ts.
// shortcut: a grappler doesn't drag the grappled creature along, and a readied attack fires on its own.
export function runAfterMove(
  payload: z.infer<typeof AfterMoveSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const mover = state.actors[payload.actor];
  if (!state.combat || !mover?.position || isDown(mover)) return {};
  const from = { x: payload.x, y: payload.y };
  // A charge needs to know where the last walk started.
  const charges = deriveStats(mover, context).actions.some(
    ({ activation }) => activation.trigger?.charge !== undefined,
  );
  const events: SystemEvent[] = [];
  // Grasping Arrow's brambles: the first walk on each turn hurts.
  const brambles = mover.activeEffects.find(
    ({ modifier }) => modifier.kind === "moveDamage",
  );
  if (
    brambles?.modifier.kind === "moveDamage" &&
    (from.x !== mover.position.x || from.y !== mover.position.y) &&
    !mover.usedThisTurn.includes(`${MOVE_HURT}${brambles.sourceId}`)
  ) {
    const responses = damageResponses(mover, context);
    const caster = state.actors[brambles.casterId] ?? mover;
    const casterStats = deriveStats(caster, context);
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: mover.id,
        key: `${MOVE_HURT}${brambles.sourceId}`,
      }),
      ...dealEvents(
        mover,
        brambles.modifier.damage.map(({ amount, type }) => ({
          amount: finalDamage(
            rollAmount(amount, casterStats, context.dice),
            type,
            responses,
          ),
          type,
        })),
        false,
        context,
      ).events,
      ...(brambles.modifier.once
        ? [
            dndEvent(`${NS}:effectEnded`, {
              actor: mover.id,
              sourceId: brambles.sourceId,
            }),
          ]
        : []),
    );
  }
  if (charges) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: mover.id,
        key: `${CHARGE_FROM}${String(from.x)},${String(from.y)}`,
      }),
    );
  }
  const frames: Frame[] = [];
  for (const foe of enemies(state, mover)) {
    const [ready] = tacticsOf(foe, "ready");
    if (!ready?.action || !foe.budget.reaction || isDown(foe)) continue;
    if (hasCondition(foe, ...INCAPACITATING)) continue;
    const action = deriveStats(foe, context).actions.find(
      (item) => item.id === ready.action,
    );
    const reach = action ? meleeReach(action) : null;
    if (
      reach === null ||
      distanceFeet(from, foe.position) <= reach ||
      distanceFeet(mover.position, foe.position) > reach
    ) {
      continue;
    }
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: foe.id, kind: "reaction" }),
      dndEvent(`${NS}:effectEnded`, { actor: foe.id, sourceId: READY }),
    );
    frames.push(
      frame("attackRoll", {
        attacker: foe.id,
        actionId: ready.action,
        target: mover.id,
      }),
    );
  }
  return { events, frames };
}
