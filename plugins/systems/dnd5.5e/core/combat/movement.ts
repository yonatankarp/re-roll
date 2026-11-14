import { z } from "zod";
import { knownFoes } from "../fog.ts";
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
  awaitDecision,
  type ContentAccess,
  type Frame,
  type SystemEvent,
  type SystemResult,
  frameHandler,
} from "#sdk";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  rollAmount,
} from "../stats.ts";
import { finalDamage } from "../rules.ts";
import { thornHits } from "../zones.ts";
import { concentrationFrame, dealEvents } from "./effects.ts";
import {
  coverBetween,
  distanceFeet,
  parseSquare,
  type Square,
  squareKey,
} from "../grid.ts";
import { seeing } from "../sight.ts";
import { hasTactic } from "../tactics.ts";
import { STAY } from "./ids.ts";
import {
  actorOf,
  CHECK_END,
  type Context,
  enemies,
  hasPassive,
  meleeReach,
  moveSquares,
  speedLeft,
  squareName,
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
export function walksOf(
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
// A jump goes straight there, so `path` is just its end.
export function provokers(
  actor: Actor,
  to: Square,
  state: DndState,
  access: ContentAccess,
  path?: readonly Square[],
): readonly { readonly foe: Actor; readonly melee: KnownAction }[] {
  // Sentinel's Guardian: Disengage doesn't stop a Sentinel's Opportunity Attack.
  const disengaged = hasTactic(actor, "disengage");
  const walked = path ??
    walksOf(actor, state, access).get(squareKey(to)) ?? [to];
  const steps = [actor.position, ...walked];
  return enemies(state, actor).flatMap((foe) => {
    if (
      !foe.budget.reaction ||
      isDown(foe) ||
      hasCondition(foe, ...INCAPACITATING) ||
      (disengaged && !hasPassive(deriveStats(foe, access), "sentinel"))
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
  // shortcut: thorns hurt as the walk starts, so damage that drops the walker stops it where it stood.
  const thorns = thornHits(step.path, state);
  if (thorns.length > 0) {
    const stats = deriveStats(actor, context);
    const responses = damageResponses(actor, context);
    const hurt = dealEvents(
      actor,
      thorns.map(({ amount, type }) => ({
        amount: finalDamage(
          rollAmount(amount, stats, context.dice),
          type,
          responses,
        ),
        type,
      })),
      false,
      context,
    );
    events.push(...hurt.events);
    frames.push(...concentrationFrame(actor, hurt.dealt));
  }
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
  // An Opportunity Attack that halted or grabbed the walker, as Sentinel's does, keeps it where it stood. A teleport
  // costs no movement, so nothing stops it.
  if (payload.feet > 0 && speedLeft(actor, deriveStats(actor, context)) <= 0) {
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

// Where a teleport or a jump of `feet` can land: open squares on the map the actor can see, nearest a foe first.
// A jump also needs the movement it costs. shortcut: the line of sight is only checked against walls and the dark.
export function teleportSquares(
  actor: Actor,
  feet: number,
  movement: number,
  state: DndState,
  access: ContentAccess,
): readonly Square[] {
  const { grid, walls = [] } = state.combat ?? {};
  const from = actor.position;
  if (!grid || !from) return [];
  if (movement > 0 && speedLeft(actor, deriveStats(actor, access)) < movement) {
    return [];
  }
  const blocked = new Set(walls);
  const taken = new Set(
    Object.values(state.actors).flatMap((item) =>
      item.position && !isDown(item) ? [squareKey(item.position)] : [],
    ),
  );
  const noCover = { half: new Set<string>(), threeQuarters: new Set<string>() };
  const foes = knownFoes(state, actor, access).filter((item) => !isDown(item));
  const nearest = (square: Square): number =>
    Math.min(...foes.map((foe) => distanceFeet(square, foe.position)));
  const squares: Square[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const square = { x, y };
      const key = squareKey(square);
      if (
        distanceFeet(from, square) <= feet &&
        !blocked.has(key) &&
        !taken.has(key) &&
        coverBetween(from, square, blocked, noCover, new Set()) !== "total" &&
        seeing(actor, square, state, access) !== "none"
      ) {
        squares.push(square);
      }
    }
  }
  return squares.sort(
    (a, b) =>
      nearest(a) - nearest(b) || distanceFeet(from, a) - distanceFeet(from, b),
  );
}

// The square a teleport or jump lands on, chosen like a move.
export function teleportFrame(
  actor: Actor,
  feet: number,
  movement: number,
  context: Context,
): Frame {
  const squares = teleportSquares(
    actor,
    feet,
    movement,
    context.state,
    context,
  );
  return awaitDecision({
    id: `${NS}:teleportTo:${actor.id}:${String(actor.moved)}`,
    actor: actor.id,
    prompt: `Where does ${actor.name} ${movement > 0 ? "jump" : "teleport"} to?`,
    options: [
      ...squares.map((square) => ({
        id: squareKey(square),
        label: squareName(square),
      })),
      { id: STAY, label: "Stay where you are" },
    ],
    resume: frame("teleport", { actor: actor.id, feet, movement }),
  });
}

export const TeleportSchema = z.object({
  actor: z.string(),
  feet: z.number(),
  movement: z.number(),
  answer: z.string(),
});

// A teleport provokes nothing and costs no movement. A jump pays its movement and provokes as a walk would.
export function runTeleport(
  payload: z.infer<typeof TeleportSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = actorOf(state, payload.actor);
  const to = parseSquare(payload.answer);
  if (payload.answer === STAY || !to) return {};
  const open = teleportSquares(
    actor,
    payload.feet,
    payload.movement,
    state,
    context,
  );
  if (!open.some((square) => squareKey(square) === payload.answer)) {
    throw new Error(`${actor.name} can't land on ${payload.answer}`);
  }
  const jump = payload.movement > 0;
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  for (const { foe, melee } of jump
    ? provokers(actor, to, state, context, [to])
    : []) {
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
        feet: payload.movement,
      }),
      ...(actor.position
        ? [frame("afterMove", { actor: actor.id, ...actor.position })]
        : []),
      CHECK_END,
    ],
  };
}

export const movementFrames = {
  [`${NS}:move`]: frameHandler({ schema: MoveSchema, run: runMove }),
  [`${NS}:teleport`]: frameHandler({
    schema: TeleportSchema,
    run: runTeleport,
  }),
  [`${NS}:finishMove`]: frameHandler({
    schema: FinishMoveSchema,
    run: runFinishMove,
  }),
};
