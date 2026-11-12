import { z } from "zod";
import {
  type Actor,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
  frame,
} from "../state.ts";
import {
  type ContentAccess,
  type Frame,
  type SystemEvent,
  type SystemResult,
  frameHandler,
} from "#sdk";
import { deriveStats, type KnownAction } from "../stats.ts";
import { distanceFeet, parseSquare, type Square, squareKey } from "../grid.ts";
import { hasTactic } from "../tactics.ts";
import { STAY } from "./ids.ts";
import {
  actorOf,
  CHECK_END,
  type Context,
  enemies,
  meleeReach,
  moveSquares,
} from "./queries.ts";

// Walking on the grid, and the Opportunity Attacks it provokes.

export const MoveSchema = z.object({ actor: z.string(), answer: z.string() });

// The longest melee reach a creature has, or null if it has no melee attack.
export function meleeReachOf(
  actor: Actor,
  access: ContentAccess,
): number | null {
  const reaches = deriveStats(actor, access).actions.flatMap((action) => {
    const reach = meleeReach(action);
    return reach !== null &&
      action.activation.resolution.kind === "attack" &&
      !action.activation.trigger &&
      action.spellLevel === null
      ? [reach]
      : [];
  });
  return reaches.length > 0 ? Math.max(...reaches) : null;
}

// The board asks about every square it can walk to, so the walks are found once per actor and state.
const walks = new WeakMap<
  Actor,
  WeakMap<DndState, ReadonlyMap<string, readonly Square[]>>
>();
function walksOf(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): ReadonlyMap<string, readonly Square[]> {
  const byState = walks.get(actor) ?? new WeakMap();
  walks.set(actor, byState);
  const found =
    byState.get(state) ??
    new Map(
      moveSquares(actor, state, deriveStats(actor, access)).map(
        ({ square, path }) => [squareKey(square), path],
      ),
    );
  byState.set(state, found);
  return found;
}

// Enemies that get an Opportunity Attack if the actor moves to `to`, and the attack each would make: any foe
// whose reach some step of the walk leaves. Off the grid (fleeing), only where it starts and ends counts.
// shortcut: the walk is the cheapest one moveSquares finds, not the one that provokes fewest; let a move
// choose its path once the board lets the player draw one.
export function provokers(
  actor: Actor,
  to: Square,
  state: DndState,
  access: ContentAccess,
): readonly { readonly foe: Actor; readonly melee: KnownAction }[] {
  if (hasTactic(actor, "disengage")) return [];
  const walked = walksOf(actor, state, access).get(squareKey(to)) ?? [to];
  const steps = [actor.position, ...walked];
  return enemies(state, actor).flatMap((foe) => {
    if (
      !foe.budget.reaction ||
      isDown(foe) ||
      hasCondition(foe, ...INCAPACITATING)
    ) {
      return [];
    }
    const leaves = (reach: number): boolean =>
      steps.some(
        (square, index) =>
          index + 1 < steps.length &&
          distanceFeet(square, foe.position) <= reach &&
          distanceFeet(steps[index + 1] ?? null, foe.position) > reach,
      );
    const melee = deriveStats(foe, access).actions.find((item) => {
      const reach = meleeReach(item);
      return (
        reach !== null &&
        item.activation.resolution.kind === "attack" &&
        !item.activation.trigger &&
        item.spellLevel === null &&
        leaves(reach)
      );
    });
    return melee ? [{ foe, melee }] : [];
  });
}

// Leaving an enemy's reach gives it an Opportunity Attack, made before the move, so falling stops it.
export function runMove(
  payload: z.infer<typeof MoveSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = actorOf(state, payload.actor);
  const to = parseSquare(payload.answer);
  if (payload.answer === STAY || !to) return {};
  const step = moveSquares(actor, state, deriveStats(actor, context)).find(
    ({ square }) => squareKey(square) === payload.answer,
  );
  if (!step) throw new Error(`${actor.name} can't reach ${payload.answer}`);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  for (const { foe, melee } of provokers(actor, to, state, context)) {
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: foe.id, kind: "reaction" }),
    );
    frames.push(
      frame("attackRoll", {
        attacker: foe.id,
        actionId: melee.id,
        target: actor.id,
      }),
    );
  }
  return {
    events,
    frames: [
      ...frames,
      frame("finishMove", {
        actor: actor.id,
        x: to.x,
        y: to.y,
        feet: step.feet,
      }),
      ...(actor.position
        ? [frame("afterMove", { actor: actor.id, ...actor.position })]
        : []),
      CHECK_END,
    ],
  };
}

export const FinishMoveSchema = z.object({
  actor: z.string(),
  x: z.number(),
  y: z.number(),
  feet: z.number(),
});

export function runFinishMove(
  payload: z.infer<typeof FinishMoveSchema>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[payload.actor];
  if (!context.state.combat || !actor || isDown(actor) || isDead(actor)) {
    return {};
  }
  return {
    events: [
      dndEvent(`${NS}:moved`, {
        actor: actor.id,
        to: { x: payload.x, y: payload.y },
        feet: payload.feet,
      }),
    ],
  };
}

export const movementFrames = {
  [`${NS}:move`]: frameHandler({ schema: MoveSchema, run: runMove }),
  [`${NS}:finishMove`]: frameHandler({
    schema: FinishMoveSchema,
    run: runFinishMove,
  }),
};
