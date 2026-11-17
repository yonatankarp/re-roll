import { z } from "zod";
import { knownFoes } from "../fog.ts";
import {
  awaitDecision,
  type Frame,
  type SystemEvent,
  type SystemResult,
  frameHandler,
} from "#sdk";
import {
  AIM,
  ALL,
  DEATH_SAVE,
  encodeOption,
  ITEM_PREFIX,
  MOVE,
  parseOption,
  PASS,
  PICK_UP,
  STAY,
} from "./ids.ts";
import {
  type Actor,
  CAST_ACTION,
  dndEvent,
  fightingOn,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
  frame,
} from "../state.ts";
import { distanceFeet, type Square, squareKey } from "../grid.ts";
import {
  deriveStats,
  evaluateFormula,
  type KnownAction,
  rollAmount,
} from "../stats.ts";
import { rollD20 } from "../rules.ts";
import { FLEE, runFlee } from "../legendary.ts";
import {
  ADD,
  AIM_AREA,
  BACK,
  CONFIRM,
  describeCaught,
  directionName,
  PICK,
  pickOptions,
} from "../targeting.ts";
import { lightAttackEvents, revealEvents } from "../tactics.ts";
import {
  actorOf,
  aimsFor,
  canAfford,
  CHECK_END,
  type Context,
  findAction,
  hasPassive,
  inReach,
  moveSquares,
  reaches,
  slotLevelFor,
  squareName,
  targetCount,
} from "./queries.ts";
import {
  aimSquare,
  payCosts,
  resolveAction,
  resolveTargets,
  rollSave,
} from "./effects.ts";
import { keepsHidden, metamagicCast } from "../metamagic.ts";
import { counterFrame, counterWindow } from "./counter.ts";
import { spellFumble, timeStopEnds } from "./durations.ts";
import { castRiders, schoolCastEvents } from "./school.ts";
import { tradeEvents } from "./trade.ts";
import { spellFoiled } from "./areas.ts";

// Taking an action on a turn: casting it, choosing its targets one by one, or aiming its area.

export const TakeActionSchema = z.object({
  actor: z.string(),
  answer: z.string(),
});

export function runTakeAction(
  payload: z.infer<typeof TakeActionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = actorOf(state, payload.actor);

  if (payload.answer === DEATH_SAVE) {
    return {
      events: deathSaveEvents(actor, context),
      frames: [CHECK_END, frame("endTurn", {})],
    };
  }

  if (payload.answer === PASS) return { frames: [frame("endTurn", {})] };
  if (payload.answer === MOVE) {
    // Squares next to the nearest enemy come first, as the likeliest choice.
    const foes = knownFoes(state, actor, context).filter(
      (item) => !isDown(item),
    );
    const nearest = (square: Square): number =>
      Math.min(...foes.map((foe) => distanceFeet(square, foe.position)));
    const squares = [
      ...moveSquares(actor, state, deriveStats(actor, context), context),
    ].sort((a, b) => nearest(a.square) - nearest(b.square) || a.feet - b.feet);
    return {
      frames: [
        awaitDecision({
          id: `${NS}:moveTo:${actor.id}:${String(actor.moved)}`,
          actor: actor.id,
          prompt: `Where does ${actor.name} move?`,
          options: [
            ...squares.map(({ square, feet, drag }) => ({
              id: squareKey(square),
              label: `${squareName(square)} (${String(feet)} ft${drag ? `, dragging ${drag.map(({ actor: id }) => state.actors[id]?.name ?? id).join(" and ")}` : ""})`,
            })),
            { id: STAY, label: "Stay where you are" },
          ],
          resume: frame("move", { actor: actor.id }),
        }),
      ],
    };
  }
  if (payload.answer === FLEE) return runFlee(actor, context);

  const [actionId = "", targetId = "", slot] = parseOption(payload.answer);
  if (actionId === PICK_UP) {
    return {
      events: [
        dndEvent(`${NS}:itemPickedUp`, {
          actor: actor.id,
          index: Number(targetId),
        }),
      ],
    };
  }
  if (targetId === PICK) {
    return { frames: [pickFrame(actor, actionId, slot, [], context)] };
  }
  if (targetId === AIM_AREA) {
    return { frames: [aimFrame(actor, actionId, slot, context)] };
  }
  return castAction(actor, actionId, slot, targetId, context);
}

// A Death Saving Throw and what it leads to. One fighting on at 0 Hit Points as Rage beyond Death makes it too, as
// its turn starts, and isn't defeated by a third failure until that ends.
export function deathSaveEvents(actor: Actor, context: Context): SystemEvent[] {
  const { dice } = context;
  {
    const stats = deriveStats(actor, context);
    const { natural } = rollD20(dice, {
      advantage: hasPassive(stats, "deathSaveAdvantage"),
      disadvantage: false,
      rerollOnes: hasPassive(stats, "rerollOnes"),
    });
    // Survivor's 18-20 count as a 20, and a Periapt of Wound Closure turns a failure into a 10.
    const counts = stats.passives.reduce(
      (roll, passive) =>
        passive.kind !== "deathSaveRoll"
          ? roll
          : Math.max(
              passive.twentyFrom !== undefined && natural >= passive.twentyFrom
                ? 20
                : roll,
              passive.floor ?? 0,
            ),
      natural,
    );
    const events: SystemEvent[] = [
      dndEvent(`${NS}:deathSaveRolled`, {
        actor: actor.id,
        natural,
        ...(counts === natural ? {} : { counts }),
      }),
    ];
    const failuresAfter =
      actor.deathSaves.failures + (counts < 10 ? (counts === 1 ? 2 : 1) : 0);
    if (counts !== 20 && failuresAfter >= 3 && !fightingOn(actor)?.delayDeath) {
      events.push({ kind: "actorDefeated", actor: actor.id });
    }
    // Defy Death: a success heals, once.
    const heal = stats.passives.find(
      (passive) =>
        passive.kind === "deathSaveHeal" &&
        (actor.resourcesSpent[passive.resource] ?? 0) <
          (stats.resources[passive.resource] ?? 0),
    );
    if (counts >= 10 && heal?.kind === "deathSaveHeal") {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: heal.resource,
        }),
        dndEvent(`${NS}:healed`, {
          actor: actor.id,
          amount: Math.max(1, rollAmount(heal.amount, stats, dice)),
          max: stats.maxHp,
        }),
      );
    }
    return events;
  }
}

// Teleporting out of a prison that allows it, as a Forcecage: a save against its caster's spell save DC first. On a
// success the prison ends and the teleport goes ahead; on a failure the magic is wasted.
function caged(
  actor: Actor,
  action: KnownAction,
  context: Context,
): { readonly failed: boolean; readonly events: SystemEvent[] } | null {
  const { resolution } = action.activation;
  if (
    resolution.kind !== "automatic" ||
    !resolution.effects.some((effect) => effect.kind === "teleport")
  ) {
    return null;
  }
  const seal = actor.activeEffects.find(
    ({ modifier }) =>
      (modifier.kind === "sealed" || modifier.kind === "caged") &&
      modifier.teleportSave,
  );
  const ability =
    seal?.modifier.kind === "sealed" || seal?.modifier.kind === "caged"
      ? seal.modifier.teleportSave
      : undefined;
  if (!seal || !ability) return null;
  const caster = context.state.actors[seal.casterId];
  const dc = caster
    ? evaluateFormula(
        { base: 0, add: [{ kind: "spellSaveDc" }] },
        deriveStats(caster, context),
      )
    : 10;
  const save = rollSave(actor, ability, dc, context, true);
  return {
    failed: !save.saved,
    events: [
      ...save.events,
      ...(save.saved
        ? [
            dndEvent(`${NS}:effectEnded`, {
              actor: actor.id,
              sourceId: seal.sourceId,
              casterId: seal.casterId,
            }),
          ]
        : []),
    ],
  };
}

// Pays for an action and resolves it, at a target id (a creature, ALL, or an aim) or at chosen creatures.
// Darts and rays go one each at the chosen ids, which may repeat.
function castAction(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  target: string | readonly string[],
  context: Context,
  uncountered = false, // a foe has already had its chance to counter it
  shape?: string, // the shape picked for a spell that has several, as Forcecage's cage or box
): SystemResult {
  const { state } = context;
  const slotLevel = slotLevelFor(actor, actionId, slot, context);
  const found = findAction(actor, actionId, context, slotLevel);
  const cast = {
    actor: actor.id,
    actionId,
    ...(slot === undefined ? {} : { slot }),
    target: typeof target === "string" ? target : [...target],
  };
  // The shape is picked first, before anything is paid or countered.
  const { shapes } = found.activation;
  if (shapes && shape === undefined) {
    return {
      frames: [
        awaitDecision({
          id: `${NS}:shape:${actor.id}:${String(state.combat?.round ?? 0)}`,
          actor: actor.id,
          prompt: `What shape does ${actor.name} give ${found.name}?`,
          options: shapes.map(({ name }) => ({ id: name, label: name })),
          resume: frame("chooseShape", cast),
        }),
      ],
    };
  }
  const action = shape === undefined ? found : withShape(found, shape);
  const counter = uncountered
    ? null
    : counterWindow(
        actor,
        action,
        { ...cast, ...(shape === undefined ? {} : { shape }) },
        slotLevel,
        context,
      );
  if (counter) return { frames: [counter] };
  const fumbled = spellFumble(actor, action, context);
  const foiled = fumbled
    ? null
    : (spellFoiled(actor, action, context) ?? caged(actor, action, context));
  if (fumbled || foiled?.failed) {
    return {
      events: [
        ...payCosts(action, actor, context, slotLevel),
        ...(fumbled ? [fumbled] : []),
        ...(foiled?.events ?? []),
      ],
      frames: [CHECK_END, frame("afterAction", { actor: actor.id })],
    };
  }
  const picked = typeof target === "string" ? null : target;
  const targetId = typeof target === "string" ? target : ALL;
  const { projectiles, resolution } = action.activation;
  const caught = picked
    ? picked.map((id) => actorOf(state, id))
    : resolveTargets(targetId, action, actor, context);
  const riders = castRiders(actor, action, slotLevel, context, caught);
  const result: SystemResult =
    projectiles !== undefined && resolution.kind !== "save"
      ? {
          frames: Array.from({ length: projectiles }, (_, index) =>
            frame(resolution.kind === "attack" ? "attackRoll" : "projectile", {
              attacker: actor.id,
              actionId,
              target: picked?.[index] ?? targetId,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          ),
        }
      : resolveAction(
          action,
          actor,
          caught,
          context,
          slotLevel,
          false,
          aimSquare(targetId, state) ?? undefined,
        );
  return {
    events: [
      ...payCosts(action, actor, context, slotLevel),
      ...timeStopEnds(actor, caught),
      ...schoolCastEvents(actor, action, slotLevel, context),
      ...riders.events,
      ...tradeEvents(actor, action, context),
      // Battle Magic's attack waits on a spell cast with an action.
      ...(action.spellLevel !== null &&
      action.activation.cost.includes("action")
        ? [
            dndEvent(`${NS}:oncePerTurnUsed`, {
              actor: actor.id,
              key: CAST_ACTION,
            }),
          ]
        : []),
      ...(foiled?.events ?? []),
      ...lightAttackEvents(actor, actionId, context),
      // An attack gives a hidden creature away once it's rolled, with the hiding's Advantage.
      ...(resolution.kind === "attack" || keepsHidden(actor, actionId)
        ? []
        : revealEvents(actor)),
      ...(result.events ?? []),
    ],
    frames: [
      ...(result.frames ?? []),
      ...riders.frames,
      ...metamagicCast(actor, actionId),
      // Used up once its darts or rolls are done, since they look the action up again.
      ...(actionId.startsWith(ITEM_PREFIX)
        ? [
            frame("useItem", {
              actor: actor.id,
              item: actionId.slice(ITEM_PREFIX.length),
            }),
          ]
        : []),
      CHECK_END,
      frame("afterAction", { actor: actor.id }),
    ],
  };
}

// The action as cast in `shape`: the first is as written, and another's effects replace its resolution's.
function withShape(action: KnownAction, shape: string): KnownAction {
  const chosen = action.activation.shapes?.find(({ name }) => name === shape);
  if (!chosen) throw new Error(`${action.name} has no shape ${shape}`);
  const { resolution } = action.activation;
  if (!chosen.effects || resolution.kind !== "automatic") return action;
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution: { ...resolution, effects: chosen.effects },
    },
  };
}

export const ShapeSchema = z.object({
  actor: z.string(),
  actionId: z.string(),
  slot: z.string().optional(),
  target: z.union([z.string(), z.array(z.string())]),
  answer: z.string(),
});

export const PickSchema = z.object({
  actor: z.string(),
  actionId: z.string(),
  slot: z.string().optional(),
  picked: z.array(z.string()),
  answer: z.string(),
});

// Asks for the next target, one at a time like a move, so every choice is in the save. Nothing is paid until the cast.
function pickFrame(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  picked: readonly string[],
  context: Context,
): Frame {
  const { state } = context;
  const action = findAction(actor, actionId, context);
  const count = targetCount(
    action,
    slotLevelFor(actor, actionId, slot, context),
  );
  const repeats = action.activation.projectiles !== undefined;
  return awaitDecision({
    id: encodeOption(
      `${NS}:targets:${actor.id}:${String(state.combat?.round ?? 0)}`,
      actionId,
      count,
      picked.join(","),
    ),
    actor: actor.id,
    prompt: `${action.name}: choose ${repeats ? `where each of ${String(count)} goes` : `up to ${String(count)} targets`} (${String(picked.length)} of ${String(count)}).`,
    options: [
      ...pickOptions(
        action.name,
        inReach(action, actor, state, context),
        picked,
        count,
        repeats,
      ),
    ],
    resume: frame("pickTargets", {
      actor: actor.id,
      actionId,
      ...(slot === undefined ? {} : { slot }),
      picked,
    }),
  });
}

export function runPickTargets(
  payload: z.infer<typeof PickSchema>,
  context: Context,
): SystemResult {
  const actor = actorOf(context.state, payload.actor);
  const { actionId, slot, picked, answer } = payload;
  if (answer === BACK) return {};
  if (answer === CONFIRM) {
    return castAction(actor, actionId, slot, picked, context);
  }
  const id = answer.slice(1);
  const at = picked.lastIndexOf(id);
  const next = answer.startsWith(ADD)
    ? [...picked, id]
    : picked.filter((_, index) => index !== at);
  return { frames: [pickFrame(actor, actionId, slot, next, context)] };
}

export const AimSchema = z.object({
  actor: z.string(),
  actionId: z.string(),
  slot: z.string().optional(),
  answer: z.string(),
});

// Asks where an area goes: any square in range, or a direction for one that starts at the caster.
// Each option names who it would catch, the caster's side too, best first.
function aimFrame(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  context: Context,
): Frame {
  const { state } = context;
  const action = findAction(actor, actionId, context);
  const { targeting } = action.activation;
  const byDirection = "range" in targeting && targeting.range === "self";
  return awaitDecision({
    id: encodeOption(
      `${NS}:aim:${actor.id}:${String(state.combat?.round ?? 0)}`,
      actionId,
    ),
    actor: actor.id,
    prompt: `Where does ${actor.name} aim ${action.name}?`,
    options: [
      ...aimsFor(action, actor, context).map(({ square, caught }) => ({
        id: squareKey(square),
        label: `${byDirection && actor.position ? directionName(actor.position, square) : squareName(square)}: ${describeCaught(actor, caught)}`,
      })),
      { id: BACK, label: "Choose something else" },
    ],
    resume: frame("aimArea", {
      actor: actor.id,
      actionId,
      ...(slot === undefined ? {} : { slot }),
    }),
  });
}

export function runAimArea(
  payload: z.infer<typeof AimSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === BACK) return {};
  const actor = actorOf(context.state, payload.actor);
  return castAction(
    actor,
    payload.actionId,
    payload.slot,
    `${AIM}${payload.answer}`,
    context,
  );
}

export const UseActionSchema = z.object({
  actor: z.string(),
  actionId: z.string(),
  target: z.string(),
  // At that creature whatever its side, as a confused or berserk creature's attack (combat/madness.ts).
  anyone: z.boolean().optional(),
  // With nothing at all to pay, as a spell a Ring of Spell Turning sends back at its caster.
  free: z.boolean().optional(),
});

// An action a Multiattack uses after its attacks: at their target if it still reaches it, or else the weakest
// creature it reaches; an area where it catches most. The attacks paid for the turn's action, so only a recharge or a use is spent here.
export function runUseAction(
  payload: z.infer<typeof UseActionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  // A fight that ended mid-Multiattack has taken its monsters off the board.
  const actor = state.actors[payload.actor];
  if (
    !state.combat ||
    !actor ||
    isDown(actor) ||
    hasCondition(actor, ...INCAPACITATING)
  )
    return {};
  const found = findAction(actor, payload.actionId, context);
  const action = {
    ...found,
    activation: {
      ...found.activation,
      cost: payload.free
        ? []
        : found.activation.cost.filter((cost) => typeof cost === "object"),
    },
  };
  if (!canAfford(action, actor, deriveStats(actor, context))) return {};
  const { targeting } = action.activation;
  const reached = inReach(action, actor, state, context);
  // A cone, line, sphere or cube goes where it catches most; with no map, as if placed with care.
  const [aim] =
    "area" in targeting && targeting.area.shape !== "emanation"
      ? aimsFor(action, actor, context)
      : [];
  const struck = payload.anyone ? state.actors[payload.target] : undefined;
  const targets = struck
    ? isDown(struck) || !reaches(action, actor, struck)
      ? []
      : [struck]
    : "creatures" in targeting && targeting.creatures === 1
      ? [
          reached.find((item) => item.id === payload.target) ??
            [...reached].sort((a, b) => a.hp - b.hp)[0],
        ].filter((item) => item !== undefined)
      : aim
        ? aim.score > 0
          ? resolveTargets(
              `${AIM}${squareKey(aim.square)}`,
              action,
              actor,
              context,
            )
          : []
        : resolveTargets(ALL, action, actor, context);
  if (targets.length === 0) return {};
  const result = resolveAction(
    action,
    actor,
    targets,
    context,
    undefined,
    false,
    aim?.square,
  );
  return {
    events: [...payCosts(action, actor, context), ...(result.events ?? [])],
    frames: [...(result.frames ?? []), CHECK_END],
  };
}

export const actionFrames = {
  ...counterFrame((cast, context) =>
    castAction(
      actorOf(context.state, cast.actor),
      cast.actionId,
      cast.slot,
      cast.target,
      context,
      true,
      cast.shape,
    ),
  ),
  [`${NS}:useAction`]: frameHandler({
    schema: UseActionSchema,
    run: runUseAction,
  }),
  [`${NS}:pickTargets`]: frameHandler({
    schema: PickSchema,
    run: runPickTargets,
  }),
  [`${NS}:aimArea`]: frameHandler({ schema: AimSchema, run: runAimArea }),
  [`${NS}:chooseShape`]: frameHandler({
    schema: ShapeSchema,
    run: (payload, context: Context) =>
      castAction(
        actorOf(context.state, payload.actor),
        payload.actionId,
        payload.slot,
        payload.target,
        context,
        false,
        payload.answer,
      ),
  }),
};
