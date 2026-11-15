import { z } from "zod";
import { knownFoes } from "../fog.ts";
import {
  type Actor,
  applyDndEvent,
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
import type { Damage } from "../schemas.ts";
import { blockingSet, sealed, thornHits } from "../zones.ts";
import {
  concentrationFrame,
  dealEvents,
  payCosts,
  resolveAction,
} from "./effects.ts";
import { afterDamage, reactFrames } from "./reactions.ts";
import { leafEvents, rollSave } from "./effects.ts";
import {
  coverBetween,
  distanceFeet,
  parseSquare,
  rangeFeet,
  type Square,
  squareKey,
} from "../grid.ts";
import { seeing } from "../sight.ts";
import { hasTactic } from "../tactics.ts";
import { STAY } from "./ids.ts";
import { grapplesOn } from "./grapple.ts";
import { heightOf } from "./falling.ts";
import {
  actorOf,
  CHECK_END,
  type Context,
  dragEvents,
  type Walk,
  enemies,
  hasPassive,
  meleeReach,
  moveSquares,
  speedLeft,
  squareName,
} from "./queries.ts";

// Walking on the grid, and the Opportunity Attacks it provokes.

export const MoveSchema = z.object({
  actor: z.string(),
  answer: z.string(),
  rest: z.boolean().optional(), // the rest of a walk a reaction cut short, which stops if it can't go on
});

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
  WeakMap<DndState, ReadonlyMap<string, Walk>>
>();
export function walksOf(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): ReadonlyMap<string, Walk> {
  const byState = walks.get(actor) ?? new WeakMap();
  walks.set(actor, byState);
  const found =
    byState.get(state) ??
    new Map(
      moveSquares(actor, state, deriveStats(actor, access), access).map(
        (walk) => [squareKey(walk.square), walk],
      ),
    );
  byState.set(state, found);
  return found;
}

// Enemies that get an Opportunity Attack if the actor moves to `to`, and the attack each would make: any foe
// whose reach some step of the walk leaves. Off the grid (fleeing), only where it starts and ends counts.
// shortcut: the walk is the cheapest one moveSquares finds, not the one that provokes fewest; let a move
// choose its path once the board lets the player draw one.
// A jump goes straight there, so `path` is just its end. Flying or climbing straight up or down, `path` is the square
// it stays on and `height` how high it ends up.
export function provokers(
  actor: Actor,
  to: Square,
  state: DndState,
  access: ContentAccess,
  path?: readonly Square[],
  height?: number,
): readonly { readonly foe: Actor; readonly melee: KnownAction }[] {
  if (hasPassive(deriveStats(actor, access), "noOpportunityAttacks")) return [];
  // Sentinel's Guardian: Disengage doesn't stop a Sentinel's Opportunity Attack.
  const disengaged = hasTactic(actor, "disengage");
  const walk = path
    ? undefined
    : walksOf(actor, state, access).get(squareKey(to));
  const walked = path ?? walk?.path ?? [to];
  const steps = [actor.position, ...walked];
  // A creature it drags comes along, so the walk never leaves its reach.
  const dragged = new Set((walk?.drag ?? []).map(({ actor: id }) => id));
  return enemies(state, actor).flatMap((foe) => {
    if (
      dragged.has(foe.id) ||
      !foe.budget.reaction ||
      isDown(foe) ||
      sealed(foe) ||
      hasCondition(foe, ...INCAPACITATING) ||
      (disengaged && !hasPassive(deriveStats(foe, access), "sentinel"))
    ) {
      return [];
    }
    // One up in the air is that much farther from a foe below it (combat/falling.ts).
    const far = (index: number): number =>
      Math.max(
        distanceFeet(steps[index] ?? null, foe.position),
        Math.abs(
          (index === steps.length - 1 && height !== undefined
            ? height
            : heightOf(actor)) - heightOf(foe),
        ),
      );
    const leaves = (reach: number): boolean =>
      steps.some(
        (_, index) =>
          index + 1 < steps.length &&
          far(index) <= reach &&
          far(index + 1) > reach,
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

// An Opportunity Attack, or with War Caster a one-target spell of one action cast with the Reaction instead.
// A caster's companions and monsters cast the first damaging cantrip that reaches, which beats a dagger.
export function opportunity(
  foe: Actor,
  melee: KnownAction,
  walker: Actor,
  context: Context,
): SystemResult {
  const stats = deriveStats(foe, context);
  const spell = hasPassive(stats, "reactiveSpell")
    ? stats.actions.find((item) => {
        const { cost, targeting, resolution } = item.activation;
        return (
          item.spellLevel === 0 &&
          cost.includes("action") &&
          !item.activation.trigger &&
          "creatures" in targeting &&
          targeting.creatures === 1 &&
          targeting.side === "enemy" &&
          distanceFeet(foe.position, walker.position) <=
            rangeFeet(targeting.range) &&
          "damage" in resolution &&
          resolution.damage.length > 0
        );
      })
    : undefined;
  if (spell) {
    const cast = {
      ...spell,
      activation: {
        ...spell.activation,
        cost: spell.activation.cost.map((cost) =>
          cost === "action" ? ("reaction" as const) : cost,
        ),
      },
    };
    const result = resolveAction(cast, foe, [walker], context);
    return {
      events: [...payCosts(cast, foe, context), ...(result.events ?? [])],
      frames: result.frames ?? [],
    };
  }
  return {
    events: [
      dndEvent(`${NS}:budgetSpent`, { actor: foe.id, kind: "reaction" }),
    ],
    frames: [
      frame("attackRoll", {
        attacker: foe.id,
        actionId: melee.id,
        target: walker.id,
      }),
    ],
  };
}

// The first step of a walk that enters the reach of an enemy's reaction to that, as Polearm Master's, or null.
function enteredAt(
  walker: Actor,
  path: readonly Square[],
  context: Context,
): number | null {
  const { state } = context;
  const watching = enemies(state, walker).some((foe) =>
    deriveStats(foe, context).actions.some(
      (item) => item.activation.trigger?.entersReach,
    ),
  );
  if (!watching) return null;
  for (let index = 0; index < path.length; index += 1) {
    const square = path[index];
    const from = index === 0 ? walker.position : path[index - 1];
    if (!square || !from) continue;
    const there = {
      ...context,
      state: {
        ...state,
        actors: {
          ...state.actors,
          [walker.id]: { ...walker, position: square },
        },
      },
    };
    if (
      reactFrames({ kind: "entered", actor: walker.id, from }, there).length > 0
    ) {
      return index;
    }
  }
  return null;
}

// Whether an enemy reacts to a creature ending its move near it, as a nalfeshnee's Pursuit does.
function watchesMoves(walker: Actor, context: Context): boolean {
  return enemies(context.state, walker).some((foe) =>
    deriveStats(foe, context).actions.some(
      (item) => item.activation.trigger?.endsMove,
    ),
  );
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
  const step = moveSquares(
    actor,
    state,
    deriveStats(actor, context),
    context,
  ).find(({ square }) => squareKey(square) === payload.answer);
  if (!step) {
    if (payload.rest) return {};
    throw new Error(`${actor.name} can't reach ${payload.answer}`);
  }
  // A walk into the reach of a reaction such as Polearm Master's stops on the square it enters, for the reaction,
  // and then goes on from there.
  const entered = enteredAt(actor, step.path, context);
  const cut = entered === null ? undefined : step.path[entered];
  if (entered !== null && cut && entered < step.path.length - 1) {
    return {
      frames: [
        frame("move", { actor: actor.id, answer: squareKey(cut) }),
        frame("move", { actor: actor.id, answer: payload.answer, rest: true }),
      ],
    };
  }
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  // shortcut: thorns hurt as the walk starts, so damage that drops the walker stops it where it stood.
  // Rolls these hits on a creature, in turn after any before them.
  let now = state;
  const hurt = (victim: Actor, hits: readonly Damage[]): void => {
    if (hits.length === 0) return;
    const stats = deriveStats(victim, context);
    const responses = damageResponses(victim, context);
    const dealt = dealEvents(
      victim,
      hits.map(({ amount, type }) => ({
        amount: finalDamage(
          rollAmount(amount, stats, context.dice),
          type,
          responses,
        ),
        type,
      })),
      false,
      { ...context, state: now },
    );
    now = dealt.events.reduce(applyDndEvent, now);
    events.push(...dealt.events);
    frames.push(
      ...afterDamage(
        victim,
        dealt.dealt,
        { types: hits.map(({ type }) => type) },
        concentrationFrame(victim, dealt.dealt),
        { ...context, state: now },
      ),
    );
  };
  hurt(actor, thornHits(step.path, state));
  // Fire Form burns each creature whose space the walk enters. shortcut: once each move, not once each turn.
  const burn = deriveStats(actor, context).passives.flatMap((passive) =>
    passive.kind === "shareSpace" ? (passive.burn ?? []) : [],
  );
  if (burn.length > 0) {
    const entered = new Set(step.path.map(squareKey));
    for (const other of Object.values(state.actors)) {
      if (
        other.id !== actor.id &&
        other.position &&
        !isDead(other) &&
        entered.has(squareKey(other.position))
      ) {
        hurt(other, burn);
      }
    }
  }
  for (const { foe, melee } of provokers(actor, to, state, context)) {
    const answer = opportunity(foe, melee, actor, context);
    events.push(...(answer.events ?? []));
    frames.push(...(answer.frames ?? []));
  }
  const from = step.path.at(-2) ?? actor.position;
  return {
    events,
    frames: [
      ...frames,
      frame("finishMove", {
        actor: actor.id,
        x: to.x,
        y: to.y,
        feet: step.feet,
        ...(step.drag ? { dragged: step.drag } : {}),
      }),
      ...(entered !== null && from
        ? [frame("react", { kind: "entered", actor: actor.id, from })]
        : []),
      ...(watchesMoves(actor, context)
        ? [frame("react", { kind: "endsMove", actor: actor.id })]
        : []),
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
  // The creatures it grapples and drags along, and where each ends up.
  dragged: z
    .array(
      z.object({
        actor: z.string(),
        to: z.object({ x: z.number(), y: z.number() }),
      }),
    )
    .optional(),
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
      // Only those it still holds come along, as an Opportunity Attack may have broken a grapple.
      ...dragEvents({
        drag: (payload.dragged ?? []).filter(({ actor: id }) => {
          const held = context.state.actors[id];
          return (
            held !== undefined &&
            grapplesOn(held).some(({ casterId }) => casterId === actor.id)
          );
        }),
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
  near?: Near, // only squares this close to another creature, as Pursuit's
): readonly Square[] {
  const close = near ? state.actors[near.actor]?.position : undefined;
  const grid = state.combat?.grid;
  const from = actor.position;
  if (!grid || !from) return [];
  if (movement > 0 && speedLeft(actor, deriveStats(actor, access)) < movement) {
    return [];
  }
  const blocked = blockingSet(state);
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
        (!near || (close && distanceFeet(close, square) <= near.feet)) &&
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

const NearSchema = z.object({ actor: z.string(), feet: z.number() });
type Near = z.infer<typeof NearSchema>;

// The square a teleport or jump lands on, chosen like a move.
export function teleportFrame(
  actor: Actor,
  feet: number,
  movement: number,
  context: Context,
  provokes = true,
  near?: Near,
  actionId?: string, // the action it's part of, for what happens round it (aroundTeleport)
): Frame {
  const squares = teleportSquares(
    actor,
    feet,
    movement,
    context.state,
    context,
    near,
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
    resume: frame("teleport", {
      actor: actor.id,
      feet,
      movement,
      ...(provokes ? {} : { provokes }),
      ...(near ? { near } : {}),
      ...(actionId ? { actionId } : {}),
    }),
  });
}

// What a teleport does to the creatures round the square it lands on or leaves, as Whirlwind of Sand's Blinded.
function aroundTeleport(
  actor: Actor,
  actionId: string | undefined,
  to: Square,
  context: Context,
): SystemEvent[] {
  const action = deriveStats(actor, context).actions.find(
    (item) => item.id === actionId,
  );
  const { resolution } = action?.activation ?? {};
  const effects = resolution?.kind === "automatic" ? resolution.effects : [];
  const around = effects.find((effect) => effect.kind === "teleport")?.around;
  if (!action || !around || !actor.position) return [];
  const at = around.origin ? actor.position : to;
  return Object.values(context.state.actors).flatMap((target) => {
    if (
      target.id === actor.id ||
      isDown(target) ||
      !target.position ||
      (around.foes && target.side === actor.side) ||
      distanceFeet(target.position, at) > around.within
    ) {
      return [];
    }
    const save = around.save
      ? rollSave(target, around.save.ability, around.save.dc, context, true)
      : null;
    if (save?.saved) return save.events;
    return [
      ...(save?.events ?? []),
      ...leafEvents(
        [
          ...around.conditions.map((condition) => ({
            kind: "applyCondition" as const,
            condition,
            duration: around.duration,
            repeatSave: false,
            endsOnDamage: false,
          })),
          ...around.modifiers.map((modifier) => ({
            kind: "modifier" as const,
            modifier,
            duration: around.duration,
          })),
        ],
        action.id,
        actor,
        target,
        context,
      ),
    ];
  });
}

export const TeleportSchema = z.object({
  actor: z.string(),
  feet: z.number(),
  movement: z.number(),
  provokes: z.boolean().optional(), // false for movement spent that provokes nothing, as Portal Step's
  near: NearSchema.optional(),
  actionId: z.string().optional(),
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
    payload.near,
  );
  if (!open.some((square) => squareKey(square) === payload.answer)) {
    throw new Error(`${actor.name} can't land on ${payload.answer}`);
  }
  const jump = payload.movement > 0;
  const events: SystemEvent[] = [
    ...aroundTeleport(actor, payload.actionId, to, context),
  ];
  const frames: Frame[] = [];
  for (const { foe, melee } of jump && payload.provokes !== false
    ? provokers(actor, to, state, context, [to])
    : []) {
    const answer = opportunity(foe, melee, actor, context);
    events.push(...(answer.events ?? []));
    frames.push(...(answer.frames ?? []));
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
