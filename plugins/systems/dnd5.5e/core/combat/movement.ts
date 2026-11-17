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
  evaluateFormula,
  type KnownAction,
  rollAmount,
  UNARMED_STRIKE,
} from "../stats.ts";
import { finalDamage } from "../rules.ts";
import type { Damage } from "../schemas.ts";
import {
  antimagicEvents,
  placedConditionEvents,
  blockingSet,
  sealed,
  thornHits,
  zonesOf,
} from "../zones.ts";
import {
  concentrationFrame,
  dealEvents,
  payCosts,
  resolveAction,
} from "./effects.ts";
import { afterDamage, reactFrames } from "./reactions.ts";
import { areaEntry, entryFrames, fogBoundEvents } from "./areas.ts";
import { leafEvents, rollSave } from "./effects.ts";
import {
  coverBetween,
  distanceFeet,
  parseSquare,
  rangeFeet,
  reachableSquares,
  type Square,
  squareKey,
} from "../grid.ts";
import { seeing } from "../sight.ts";
import { hasTactic } from "../tactics.ts";
import { ALL, FANCY_FOOTWORK, STAY } from "./ids.ts";
import { grapplesOn } from "./grapple.ts";
import { heightOf } from "./falling.ts";
import { limitsOf } from "./durations.ts";
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
  ridden,
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
  // Sentinel's Guardian: Disengage doesn't stop a Sentinel's Opportunity Attack. A mount's Disengage covers its
  // rider. shortcut: either one's covers both.
  const mount = ridden(actor, state);
  const disengaged =
    hasTactic(actor, "disengage") ||
    (mount !== null && hasTactic(mount, "disengage"));
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
      limitsOf(foe).noOpportunityAttacks === true || // Shocking Grasp
      // Fancy Footwork: a creature the mover attacked in melee this turn
      foe.activeEffects.some(
        ({ sourceId, casterId }) =>
          sourceId === FANCY_FOOTWORK && casterId === actor.id,
      ) ||
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
    const actions = deriveStats(foe, access).actions;
    // A bare Unarmed Strike isn't worth the Reaction to one that has another use for it, as Shield.
    // shortcut: the Opportunity Attack is still taken without asking, with a weapon or one's only use for it.
    const saves = actions.some(
      (item) =>
        item.activation.cost.includes("reaction") &&
        item.activation.trigger !== undefined,
    );
    const melee = actions.find((item) => {
      const reach = meleeReach(item);
      return (
        reach !== null &&
        item.activation.resolution.kind === "attack" &&
        !item.activation.trigger &&
        item.spellLevel === null &&
        !(saves && item.id === UNARMED_STRIKE) &&
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

// What standing in Antimagic Field or Silence holds off or puts on a creature, after a walk.
const placedEvents = (state: DndState): SystemEvent[] => [
  ...antimagicEvents(state),
  ...placedConditionEvents(state),
];

// Leaving an enemy's reach gives it an Opportunity Attack, made before the move, so falling stops it.
export function runMove(
  payload: z.infer<typeof MoveSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  // A fight that ended mid-turn has taken its monsters off the board.
  if (!state.actors[payload.actor]) return {};
  const actor = actorOf(state, payload.actor);
  const to = parseSquare(payload.answer);
  if (payload.answer === STAY || !to) return {};
  if (payload.rest && isDown(actor)) return {};
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
  // So does a walk into an area that acts on whoever enters it, as Moonbeam, for its save.
  const entered = enteredAt(actor, step.path, context);
  const entry = areaEntry(actor, step.path, context);
  const at = Math.min(entered ?? Infinity, entry?.index ?? Infinity);
  const cut = step.path[at];
  if (cut && at < step.path.length - 1) {
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
      ...entryFrames(actor, actor.position, to, entry?.zones ?? [], context),
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
  // A rider's walk is its mount's, which carries it.
  const walker = ridden(actor, context.state) ?? actor;
  if (
    payload.feet > 0 &&
    speedLeft(walker, deriveStats(walker, context)) <= 0
  ) {
    return {};
  }
  const moved = dndEvent(`${NS}:moved`, {
    actor: walker.id,
    to: { x: payload.x, y: payload.y },
    feet: payload.feet,
  });
  const arrived = { ...actor, position: { x: payload.x, y: payload.y } };
  // A walk into or out of an Antimagic Field, or one carrying it, holds off or brings back spells and items.
  const fields =
    zonesOf(context.state).some(
      (zone) =>
        zone.area?.noSpells === "all" || zone.area?.conditions !== undefined,
    ) ||
    Object.values(context.state.actors).some(
      (item) =>
        item.suppressed !== undefined ||
        item.activeEffects.some(({ sourceId }) =>
          sourceId.startsWith("placed:"),
        ),
    );
  return {
    events: [
      moved,
      // Only those it still holds come along, as an Opportunity Attack may have broken a grapple. A rider's walk drags
      // what its mount holds. shortcut: not what the rider holds, until a rider can grapple from the saddle.
      ...dragEvents({
        drag: (payload.dragged ?? []).filter(({ actor: id }) => {
          const held = context.state.actors[id];
          return (
            held !== undefined &&
            grapplesOn(held).some(({ casterId }) => casterId === walker.id)
          );
        }),
      }),
      ...fogBoundEvents(arrived, context),
      ...(fields ? placedEvents(applyDndEvent(context.state, moved)) : []),
      ...carriedEvents(walker, { x: payload.x, y: payload.y }, context),
      ...beenEvents(walker, { x: payload.x, y: payload.y }, context),
    ],
  };
}

// Open squares within `near` feet of `centre`, nearest first, that no one stands on and no wall fills.
function besideSquares(
  state: DndState,
  centre: Square,
  near: number,
  taken: ReadonlySet<string>,
): Square[] {
  const grid = state.combat?.grid;
  if (!grid) return [];
  const blocked = blockingSet(state, "walking");
  const squares: Square[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const square = { x, y };
      const key = squareKey(square);
      if (
        !blocked.has(key) &&
        !taken.has(key) &&
        distanceFeet(square, centre) <= near
      ) {
        squares.push(square);
      }
    }
  }
  return squares.sort(
    (a, b) => distanceFeet(a, centre) - distanceFeet(b, centre),
  );
}

function occupiedKeys(state: DndState, except: readonly string[]): Set<string> {
  return new Set(
    Object.values(state.actors).flatMap((item) =>
      item.position && !isDead(item) && !except.includes(item.id)
        ? [squareKey(item.position)]
        : [],
    ),
  );
}

const BEEN = "been:";

// The squares it stood on this turn, for a teleport that only goes back to one.
function retraced(actor: Actor): Square[] {
  return actor.usedThisTurn
    .flatMap((key) =>
      key.startsWith(BEEN) ? [parseSquare(key.slice(BEEN.length))] : [],
    )
    .flatMap((square) => (square ? [square] : []));
}

// Boots of the Winding Path's wearer: each square it stands on this turn is kept, for the teleport back.
function beenEvents(
  walker: Actor,
  to: Square,
  context: Context,
): SystemEvent[] {
  const winding = deriveStats(walker, context).actions.some((action) => {
    const { resolution } = action.activation;
    return (
      resolution.kind === "automatic" &&
      resolution.effects.some(
        (effect) => effect.kind === "teleport" && effect.retrace,
      )
    );
  });
  if (!winding) return [];
  return [walker.position, to].flatMap((square) =>
    square && !walker.usedThisTurn.includes(`${BEEN}${squareKey(square)}`)
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: walker.id,
            key: `${BEEN}${squareKey(square)}`,
          }),
        ]
      : [],
  );
}

// Heightened Focus's Step of the Wind: the ally it carries lands beside it after each move, provoking nothing.
function carriedEvents(
  walker: Actor,
  to: Square,
  context: Context,
): SystemEvent[] {
  const { state } = context;
  const events: SystemEvent[] = [];
  const taken = occupiedKeys(state, [walker.id]);
  taken.add(squareKey(to));
  for (const { modifier } of walker.activeEffects) {
    if (modifier.kind !== "carrying") continue;
    const carried = state.actors[modifier.actor];
    if (!carried?.position || isDown(carried)) continue;
    if (distanceFeet(carried.position, to) <= 5) continue;
    taken.delete(squareKey(carried.position));
    const [square] = besideSquares(state, to, 5, taken);
    if (!square) continue;
    taken.add(squareKey(square));
    events.push(
      dndEvent(`${NS}:moved`, { actor: carried.id, to: square, feet: 0 }),
    );
  }
  return events;
}

// Who may come along on a teleport: the action's own `bring`, or a rider's for its spell or feature.
function bringRule(
  actor: Actor,
  actionId: string | undefined,
  context: Context,
): { count: number; within: number; near: number } | null {
  if (!actionId) return null;
  const stats = deriveStats(actor, context);
  const action = stats.actions.find((item) => item.id === actionId);
  const { resolution } = action?.activation ?? {};
  const own =
    resolution?.kind === "automatic"
      ? resolution.effects.find((effect) => effect.kind === "teleport")?.bring
      : undefined;
  if (own) return own;
  for (const passive of stats.passives) {
    if (
      passive.kind === "teleportRider" &&
      passive.actions.some(
        (id) =>
          actionId === `spell:${id}` ||
          actionId.startsWith(`spell:${id}:`) ||
          actionId.startsWith(`feature:${id}:`),
      )
    ) {
      return passive.bring;
    }
  }
  return null;
}

const NO_ONE = "none";

// After a teleport that may bring allies, the teleporter picks who comes: one of them for a single place, or everyone
// in reach for more. "No one" is first, so the tactics bring none unless asked.
function bringFrame(
  actor: Actor,
  from: Square,
  to: Square,
  rule: { count: number; within: number; near: number },
  context: Context,
): Frame | null {
  const allies = Object.values(context.state.actors).filter(
    (item) =>
      item.id !== actor.id &&
      item.side === actor.side &&
      item.position !== null &&
      !isDown(item) &&
      !hasCondition(item, ...INCAPACITATING) &&
      distanceFeet(item.position, from) <= rule.within,
  );
  if (allies.length === 0) return null;
  const options =
    rule.count === 1 || allies.length === 1
      ? allies.map((item) => ({ id: item.id, label: `Bring ${item.name}` }))
      : [
          {
            id: ALL,
            label: `Bring up to ${String(rule.count)} allies near you`,
          },
        ];
  return awaitDecision({
    id: `${NS}:bring:${actor.id}:${String(actor.moved)}`,
    actor: actor.id,
    prompt: `Who comes along with ${actor.name}?`,
    options: [{ id: NO_ONE, label: "No one" }, ...options],
    resume: frame("bringAlong", {
      actor: actor.id,
      x: to.x,
      y: to.y,
      near: rule.near,
      count: rule.count,
      allies: allies.map((item) => item.id),
    }),
  });
}

export const BringAlongSchema = z.object({
  actor: z.string(),
  x: z.number(),
  y: z.number(),
  near: z.number(),
  count: z.number(),
  allies: z.array(z.string()),
  answer: z.string(),
});

// The allies picked land on open squares within reach of the teleporter's new square, nearest first.
export function runBringAlong(
  payload: z.infer<typeof BringAlongSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === NO_ONE) return {};
  const picked =
    payload.answer === ALL
      ? payload.allies.slice(0, payload.count)
      : payload.allies.filter((id) => id === payload.answer);
  const { state } = context;
  const to = { x: payload.x, y: payload.y };
  const taken = occupiedKeys(state, picked);
  const events: SystemEvent[] = [];
  for (const id of picked) {
    const [square] = besideSquares(state, to, payload.near, taken);
    if (!square) continue;
    taken.add(squareKey(square));
    events.push(dndEvent(`${NS}:moved`, { actor: id, to: square, feet: 0 }));
  }
  return { events };
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
  fly = false, // flown to round walls instead, as Tempestuous Magic's 10 feet
  retrace = false, // only back to a square it stood on this turn, as Boots of the Winding Path's
): readonly Square[] {
  const close = near ? state.actors[near.actor]?.position : undefined;
  const grid = state.combat?.grid;
  const from = actor.position;
  if (!grid || !from) return [];
  // Boots of the Winding Path: only back to a square it stood on this turn.
  if (retrace) {
    const taken = occupiedKeys(state, [actor.id]);
    return retraced(actor).filter(
      (square) =>
        !taken.has(squareKey(square)) &&
        distanceFeet(square, from) <= feet &&
        (square.x !== from.x || square.y !== from.y),
    );
  }
  if (fly) {
    const occupied = occupiedKeys(state, [actor.id]);
    return reachableSquares(
      from,
      feet,
      grid,
      blockingSet(state, "walking"),
      occupied,
    )
      .map(({ square }) => square)
      .filter((square) => square.x !== from.x || square.y !== from.y);
  }
  if (movement > 0 && speedLeft(actor, deriveStats(actor, access)) < movement) {
    return [];
  }
  const blocked = blockingSet(state, "walking");
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
  fly = false,
  retrace = false,
): Frame {
  const squares = teleportSquares(
    actor,
    feet,
    movement,
    context.state,
    context,
    near,
    fly,
    retrace,
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
      ...(fly ? { fly } : {}),
      ...(retrace ? { retrace } : {}),
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
    const stats = deriveStats(actor, context);
    const { save: rule } = around;
    const save = rule
      ? rollSave(
          target,
          rule.ability,
          typeof rule.dc === "number"
            ? rule.dc
            : evaluateFormula(rule.dc, stats),
          context,
          true,
        )
      : null;
    const hits = (around.damage ?? []).map(({ amount, type }) => {
      const rolled = rollAmount(amount, stats, context.dice);
      return { amount: save?.saved ? Math.floor(rolled / 2) : rolled, type };
    });
    const dealt =
      hits.length > 0 ? dealEvents(target, hits, false, context).events : [];
    if (save?.saved) return [...save.events, ...dealt];
    return [
      ...(save?.events ?? []),
      ...dealt,
      ...leafEvents(
        [
          // Warping Implosion: pulled straight toward the space left.
          ...(around.pull
            ? [
                {
                  kind: "forcedMove" as const,
                  feet: around.within,
                  direction: "toward" as const,
                },
              ]
            : []),
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
  fly: z.boolean().optional(),
  retrace: z.boolean().optional(),
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
    payload.fly === true,
    payload.retrace === true,
  );
  if (!open.some((square) => squareKey(square) === payload.answer)) {
    throw new Error(`${actor.name} can't land on ${payload.answer}`);
  }
  const jump = payload.movement > 0;
  const events: SystemEvent[] = [
    ...aroundTeleport(actor, payload.actionId, to, context),
  ];
  const rule = bringRule(actor, payload.actionId, context);
  const bring =
    rule && actor.position
      ? bringFrame(actor, actor.position, to, rule, context)
      : null;
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
      ...(bring ? [bring] : []),
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
  [`${NS}:bringAlong`]: frameHandler({
    schema: BringAlongSchema,
    run: runBringAlong,
  }),
  [`${NS}:finishMove`]: frameHandler({
    schema: FinishMoveSchema,
    run: runFinishMove,
  }),
};
