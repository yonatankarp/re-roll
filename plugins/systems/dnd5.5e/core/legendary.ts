import {
  type ContentAccess,
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import {
  AIM,
  ALL,
  CHECK_END,
  type Context,
  combatEnded,
  enemies,
  moveSquares,
  provokers,
  reaches,
  resolveAction,
  resolveTargets,
} from "./combat.ts";
import { distanceFeet, rangeFeet } from "./grid.ts";
import { legendaryOf } from "./import/monsters.ts";
import { type LeafEffect, MonsterSchema } from "./schemas.ts";
import {
  type Actor,
  type DndState,
  INCAPACITATING,
  LEGENDARY_RESISTANCE,
  LEGENDARY_USE,
  NS,
  applyDndEvent,
  dndEvent,
  hasCondition,
  isDead,
  isDown,
} from "./state.ts";
import { type KnownAction, deriveStats } from "./stats.ts";

// Boss fights and ambushes: legendary actions, Legendary Resistance, lair actions, surprise, and fleeing.

export const FLEE = "flee";
const WAIT = "wait";
const SEPARATOR = "|";
const LEGENDARY_PREFIX = "legendary:";
const LAIR_PREFIX = "lair:";
const OFF_MAP = { x: -1000, y: -1000 }; // where a fleeing creature heads, out of everyone's reach

function frame(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): Frame {
  return { kind: `${NS}:${kind}`, payload };
}

const LegendSchema = MonsterSchema.pick({
  legendary: true,
  legendaryResistance: true,
  lairActions: true,
});
type Legend = z.infer<typeof LegendSchema>;
const legends = new WeakMap<object, Legend>();

// What a monster can do as a legend. A stat block imported before these fields existed has them read from its
// printed text, as Multiattack is, and the result is kept per entry because this is asked on every save.
export function legendOf(
  actor: Actor,
  access: Pick<ContentAccess, "content">,
): Legend {
  if (actor.source.kind !== "monster") return {};
  const entry = access.content(actor.source.statBlockId);
  if (!entry) return {};
  const known = legends.get(entry);
  if (known) return known;
  const monster = MonsterSchema.parse(entry);
  const own = {
    legendary: monster.legendary,
    legendaryResistance: monster.legendaryResistance,
    lairActions: monster.lairActions,
  };
  const legend = LegendSchema.parse(
    Object.values(own).some(Boolean) || !monster.text
      ? own
      : legendaryOf(
          monster.text.split("\n"),
          monster.actions.map((action) => action.name),
        ).fields,
  );
  legends.set(entry, legend);
  return legend;
}

function legendaryUsesLeft(
  actor: Actor,
  legend: Legend,
  state: DndState,
): number {
  const { legendary } = legend;
  if (!legendary) return 0;
  const total = state.combat?.lair
    ? (legendary.usesInLair ?? legendary.uses)
    : legendary.uses;
  return (
    total - actor.usedThisTurn.filter((key) => key === LEGENDARY_USE).length
  );
}

// shortcut: a monster only exists for one fight, so "per day" is per fight.
export function resistancesLeft(
  actor: Actor,
  access: Pick<ContentAccess, "content">,
  state: DndState,
): number {
  const resistance = legendOf(actor, access).legendaryResistance;
  if (!resistance) return 0;
  const total = state.combat?.lair
    ? (resistance.inLair ?? resistance.perDay)
    : resistance.perDay;
  return total - (actor.resourcesSpent[LEGENDARY_RESISTANCE] ?? 0);
}

const DISABLING: readonly string[] = [
  ...INCAPACITATING,
  "blinded",
  "charmed",
  "frightened",
  "restrained",
];

export function conditionsApplied(effects: readonly LeafEffect[]): string[] {
  return effects.flatMap((effect) =>
    effect.kind === "applyCondition" ? [effect.condition] : [],
  );
}

// A failed save turned into a success: the monster spends one on anything that would take it out of the fight.
// `pending` holds the events not yet applied, so two saves in one step can't spend the same use.
export function legendaryResistance(
  target: Actor,
  conditions: readonly string[],
  context: Context,
  pending: readonly SystemEvent[],
): SystemEvent | null {
  if (!conditions.some((condition) => DISABLING.includes(condition))) {
    return null;
  }
  const spent = pending.filter(
    (event) =>
      event.kind === `${NS}:legendaryResistanceUsed` &&
      "payload" in event &&
      event.payload.actor === target.id,
  ).length;
  return resistancesLeft(target, context, context.state) - spent > 0
    ? dndEvent(`${NS}:legendaryResistanceUsed`, { actor: target.id })
    : null;
}

// Legendary and lair actions with an effect of their own, so frames left behind can find them by id.
export function bossAction(
  actor: Actor,
  id: string,
  access: Pick<ContentAccess, "content">,
): KnownAction | undefined {
  const legend = legendOf(actor, access);
  const activation = id.startsWith(LEGENDARY_PREFIX)
    ? legend.legendary?.actions[Number(id.slice(LEGENDARY_PREFIX.length))]
    : id.startsWith(LAIR_PREFIX)
      ? legend.lairActions?.[Number(id.slice(LAIR_PREFIX.length))]
      : undefined;
  return activation?.activation
    ? {
        id,
        name: activation.name,
        activation: activation.activation,
        spellLevel: null,
      }
    : undefined;
}

// What one legendary or lair action does: the monster's own actions it names, or its own effect.
function actionsOf(
  actor: Actor,
  item: { readonly makes?: readonly string[] | undefined },
  id: string,
  context: Context,
): readonly KnownAction[] {
  const stats = deriveStats(actor, context);
  const own = bossAction(actor, id, context);
  if (own) return [own];
  const made = (item.makes ?? []).flatMap((name) => {
    const found = stats.actions.find((action) => action.name === name);
    return found ? [found] : [];
  });
  // A recharge it hasn't got back, such as a breath weapon's, can't be used this way either.
  const ready = made.every((action) =>
    action.activation.cost.every(
      (cost) =>
        typeof cost !== "object" ||
        (actor.resourcesSpent[cost.resource] ?? 0) <
          (stats.resources[cost.resource] ?? 0),
    ),
  );
  return ready ? made : [];
}

// The answers for one action: everyone it can reach, or everyone at once for an area or several targets.
function targetOptions(
  actor: Actor,
  lead: KnownAction,
  key: string,
  name: string,
  steps: number,
  context: Context,
): Decision["options"] {
  const { targeting } = lead.activation;
  if ("self" in targeting) {
    return [{ id: `${key}${SEPARATOR}${actor.id}`, label: name }];
  }
  if (
    ("area" in targeting && targeting.area.shape === "emanation") ||
    ("creatures" in targeting && targeting.creatures > 1)
  ) {
    return resolveTargets(ALL, lead, actor, context).length > 0
      ? [{ id: `${key}${SEPARATOR}${ALL}`, label: name }]
      : [];
  }
  const range = "range" in targeting ? rangeFeet(targeting.range) : 0;
  return enemies(context.state, actor)
    .filter(
      (foe) =>
        !isDown(foe) &&
        (reaches(lead, actor, foe) ||
          distanceFeet(actor.position, foe.position) <= range + steps),
    )
    .map((foe) => ({
      id: `${key}${SEPARATOR}${"area" in targeting ? AIM : ""}${foe.id}`,
      label: `${name}: ${foe.name} (${String(foe.hp)} HP)`,
    }));
}

// The monster steps toward its target first, when the action lets it and the target is out of reach.
// shortcut: this move never provokes Opportunity Attacks, as some legendary moves say they don't.
function stepEvents(
  actor: Actor,
  lead: KnownAction,
  target: Actor | undefined,
  steps: number,
  context: Context,
): SystemEvent[] {
  if (steps <= 0 || !target || reaches(lead, actor, target)) return [];
  const stats = deriveStats(actor, context);
  const squares = moveSquares({ ...actor, moved: 0 }, context.state, {
    ...stats,
    speed: steps,
  });
  const best = [...squares].sort(
    (a, b) =>
      distanceFeet(a.square, target.position) -
        distanceFeet(b.square, target.position) || a.feet - b.feet,
  )[0];
  return best
    ? [
        dndEvent(`${NS}:moved`, {
          actor: actor.id,
          to: best.square,
          feet: best.feet,
        }),
      ]
    : [];
}

// Takes the actions one after another, attacks as their own rolls and everything else at once.
function takeEvents(
  actor: Actor,
  actions: readonly KnownAction[],
  answerTarget: string,
  steps: number,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const [lead] = actions;
  if (!lead) return { events: [], frames: [] };
  const aimed = context.state.actors[answerTarget.replace(AIM, "")];
  const moved = stepEvents(actor, lead, aimed, steps, context);
  let { state } = context;
  for (const event of moved) state = applyDndEvent(state, event);
  const mover = state.actors[actor.id] ?? actor;
  const after = { ...context, state };
  const events: SystemEvent[] = [...moved];
  const frames: Frame[] = [];
  for (const action of actions) {
    for (const cost of action.activation.cost) {
      if (typeof cost === "object") {
        events.push(
          dndEvent(`${NS}:resourceSpent`, {
            actor: actor.id,
            resource: cost.resource,
          }),
        );
      }
    }
    if (action.activation.resolution.kind === "attack") {
      frames.push(
        frame("attackRoll", {
          attacker: actor.id,
          actionId: action.id,
          target: answerTarget,
        }),
      );
      continue;
    }
    const result = resolveAction(
      action,
      mover,
      resolveTargets(answerTarget, action, mover, after),
      after,
    );
    events.push(...(result.events ?? []));
    frames.push(...(result.frames ?? []));
  }
  return { events, frames: [...frames, CHECK_END] };
}

function canAct(actor: Actor | undefined): actor is Actor {
  return (
    actor !== undefined &&
    !isDead(actor) &&
    !isDown(actor) &&
    !hasCondition(actor, ...INCAPACITATING)
  );
}

const onceKey = (index: number): string =>
  `${LEGENDARY_PREFIX}${String(index)}`;

// Right after another creature's turn: one legendary action from each monster that has a use left,
// then lair actions if initiative count 20 falls between this turn and the next.
export function betweenTurns(
  state: DndState,
  ending: readonly SystemEvent[],
  access: Pick<ContentAccess, "content">,
): Frame[] {
  // Most fights have no legends, and those skip the look ahead below.
  const legends = (state.combat?.order ?? []).some((id) => {
    const actor = state.actors[id];
    if (!actor) return false;
    const legend = legendOf(actor, access);
    return legend.legendary !== undefined || legend.lairActions !== undefined;
  });
  if (!legends) return [];
  let before = state;
  for (const event of ending) before = applyDndEvent(before, event);
  const after = applyDndEvent(before, dndEvent(`${NS}:turnAdvanced`, {}));
  const { combat } = before;
  if (!combat) return [];
  const ended = combat.order[combat.index];
  const legendary = combat.order.flatMap((id) => {
    const actor = before.actors[id];
    return id !== ended && canAct(actor) && legendOf(actor, access).legendary
      ? [frame("legendaryTurn", { actor: id })]
      : [];
  });
  const next = after.combat?.index ?? combat.index;
  const at = combat.lair?.at;
  const crossed =
    at !== undefined &&
    (next > combat.index
      ? combat.index < at && at <= next
      : at > combat.index || at <= next);
  return [...legendary, ...(crossed ? lairTurns(before, "", access) : [])];
}

export function lairTurns(
  state: DndState,
  when: string,
  access: Pick<ContentAccess, "content">,
): Frame[] {
  return (state.combat?.order ?? []).flatMap((id) => {
    const actor = state.actors[id];
    return actor && !isDead(actor) && legendOf(actor, access).lairActions
      ? [frame("lairTurn", { actor: id, when })]
      : [];
  });
}

const ActorPayload = z.object({ actor: z.string() });
const LairTurnPayload = z.object({ actor: z.string(), when: z.string() });
const AnswerPayload = z.object({ actor: z.string(), answer: z.string() });

// The choice is made when its moment comes, so it sees what earlier legendary actions left standing.
export function runLegendaryTurn(
  { actor: id }: z.infer<typeof ActorPayload>,
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[id];
  const legendary = actor && legendOf(actor, context).legendary;
  if (!state.combat || !canAct(actor) || !legendary) return {};
  const left = legendaryUsesLeft(actor, legendOf(actor, context), state);
  const steps = Math.floor(deriveStats(actor, context).speed / 2);
  const options = legendary.actions.flatMap((item, index) => {
    if (item.cost > left || actor.usedThisTurn.includes(onceKey(index))) {
      return [];
    }
    const [lead] = actionsOf(actor, item, onceKey(index), context);
    return lead
      ? targetOptions(
          actor,
          lead,
          String(index),
          item.name,
          item.moves ? steps : 0,
          context,
        )
      : [];
  });
  if (options.length === 0) return {};
  return {
    frames: [
      awaitDecision({
        id: `${NS}:legendary:${id}:${String(state.combat.round)}:${String(state.combat.index)}`,
        actor: id,
        prompt: `${actor.name} can take a legendary action.`,
        options: [...options, { id: WAIT, label: "Wait" }],
        resume: frame("legendaryAction", { actor: id }),
      }),
    ],
  };
}

export function runLegendaryAction(
  { actor: id, answer }: z.infer<typeof AnswerPayload>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[id];
  if (answer === WAIT || !context.state.combat || !canAct(actor)) return {};
  const [index = "", target = ""] = answer.split(SEPARATOR);
  const item = legendOf(actor, context).legendary?.actions[Number(index)];
  if (!item) throw new Error(`${id} has no legendary action ${index}`);
  const key = onceKey(Number(index));
  const taken = dndEvent(`${NS}:legendaryActionTaken`, {
    actor: id,
    name: item.name,
    cost: item.cost,
    ...(item.oncePerRound ? { key } : {}),
  });
  const result = takeEvents(
    actor,
    actionsOf(actor, item, key, context),
    target,
    item.moves ? Math.floor(deriveStats(actor, context).speed / 2) : 0,
    context,
  );
  return { events: [taken, ...result.events], frames: result.frames };
}

// shortcut: a lair action may repeat the one before, though older books say the same effect can't come twice in a row.
export function runLairTurn(
  { actor: id, when }: z.infer<typeof LairTurnPayload>,
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[id];
  const lairActions = actor && legendOf(actor, context).lairActions;
  if (!state.combat || !actor || isDead(actor) || !lairActions) return {};
  const options = lairActions.flatMap((item, index) => {
    const key = `${LAIR_PREFIX}${String(index)}`;
    const [lead] = actionsOf(actor, {}, key, context);
    return lead
      ? targetOptions(actor, lead, String(index), item.name, 0, context)
      : [];
  });
  if (options.length === 0) return {};
  return {
    frames: [
      awaitDecision({
        id: `${NS}:lair:${id}:${String(state.combat.round)}:${when || String(state.combat.index)}`,
        actor: id,
        prompt: `Initiative count 20: ${actor.name}'s lair stirs.`,
        options: [...options, { id: WAIT, label: "Let it rest" }],
        resume: frame("lairAction", { actor: id }),
      }),
    ],
  };
}

export function runLairAction(
  { actor: id, answer }: z.infer<typeof AnswerPayload>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[id];
  if (answer === WAIT || !context.state.combat || !actor) return {};
  const [index = "", target = ""] = answer.split(SEPARATOR);
  const key = `${LAIR_PREFIX}${index}`;
  const item = legendOf(actor, context).lairActions?.[Number(index)];
  if (!item) throw new Error(`${id} has no lair action ${index}`);
  const result = takeEvents(
    actor,
    actionsOf(actor, {}, key, context),
    target,
    0,
    context,
  );
  return {
    events: [
      dndEvent(`${NS}:lairActionTaken`, { actor: id, name: item.name }),
      ...result.events,
    ],
    frames: result.frames,
  };
}

// Always spends a use, since they come back: an area that catches two or more, else the weakest foe in reach.
export function chooseBossAction(decision: Decision, context: Context): string {
  const actor = context.state.actors[decision.actor];
  const scored = decision.options.flatMap((option) => {
    const [, target = ""] = option.id.split(SEPARATOR);
    if (option.id === WAIT || !actor) return [];
    if (target === ALL) return [{ option, score: 1000 }];
    const foe = context.state.actors[target.replace(AIM, "")];
    return foe ? [{ option, score: 500 - foe.hp }] : [];
  });
  const best = [...scored].sort((a, b) => b.score - a.score)[0];
  return best?.option.id ?? WAIT;
}

// Disengage, from the standard actions, stops the Opportunity Attacks.
export function disengaged(actor: Actor): boolean {
  return actor.usedThisTurn.includes("disengage");
}

function fleeProvokers(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): ReturnType<typeof provokers> {
  return disengaged(actor) ? [] : provokers(actor, OFF_MAP, state, access);
}

export function fleeOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): Decision["options"] {
  if (actor.id !== PLAYER_ACTOR || !state.combat?.canFlee) return [];
  const count = fleeProvokers(actor, state, access).length;
  return [
    {
      id: FLEE,
      label:
        count === 0
          ? "Flee the fight"
          : `Flee the fight (${String(count)} opportunity attack${count === 1 ? "" : "s"})`,
    },
  ];
}

// Running off the map: every foe that can reach the player gets an Opportunity Attack first,
// and the party gets away if the player is still on their feet afterwards.
// shortcut: companions run with the player and draw no attacks of their own.
export function runFlee(actor: Actor, context: Context): SystemResult {
  const foes = fleeProvokers(actor, context.state, context);
  return {
    events: foes.map(({ foe }) =>
      dndEvent(`${NS}:budgetSpent`, { actor: foe.id, kind: "reaction" }),
    ),
    frames: [
      ...foes.map(({ foe, melee }) =>
        frame("attackRoll", {
          attacker: foe.id,
          actionId: melee.id,
          target: actor.id,
        }),
      ),
      CHECK_END,
      frame("escape", { actor: actor.id }),
    ],
  };
}

export function runEscape(
  { actor: id }: z.infer<typeof ActorPayload>,
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[id];
  if (!state.combat || !actor) return {};
  return isDown(actor)
    ? { frames: [frame("endTurn", {})] }
    : { events: combatEnded(state, "flee") };
}

const SurpriseArgs = z.strictObject({ side: z.enum(["party", "enemies"]) });

// Sets who is caught unaware in the next fight, such as after a Stealth check: the party on a failure,
// the enemies on a success.
export const surpriseEffects = {
  [`${NS}:surprise`]: storyEffect({
    schema: SurpriseArgs,
    apply: ({ side }, _context: Context) => ({
      events: [dndEvent(`${NS}:surpriseSet`, { side })],
    }),
  }),
};

export const legendaryFrames = {
  [`${NS}:legendaryTurn`]: frameHandler({
    schema: ActorPayload,
    run: runLegendaryTurn,
  }),
  [`${NS}:legendaryAction`]: frameHandler({
    schema: AnswerPayload,
    run: runLegendaryAction,
  }),
  [`${NS}:lairTurn`]: frameHandler({
    schema: LairTurnPayload,
    run: runLairTurn,
  }),
  [`${NS}:lairAction`]: frameHandler({
    schema: AnswerPayload,
    run: runLairAction,
  }),
  [`${NS}:escape`]: frameHandler({ schema: ActorPayload, run: runEscape }),
};
