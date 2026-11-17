import { z } from "zod";
import {
  awaitDecision,
  type Frame,
  frameHandler,
  type SystemResult,
} from "#sdk";
import { DECLINE } from "./ids.ts";
import {
  type Actor,
  dndEvent,
  frame,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../state.ts";
import { distanceFeet, rangeFeet } from "../grid.ts";
import {
  castsSilently,
  deriveStats,
  evaluateFormula,
  type KnownAction,
  rollDiceNotation,
} from "../stats.ts";
import { seeing } from "../sight.ts";
import {
  actorOf,
  canAfford,
  CHECK_END,
  type Context,
  enemies,
  findAction,
  hasPassive,
  slotToSpend,
} from "./queries.ts";
import { slotRefund } from "./reactions.ts";
import { payCosts, resolveAction, rollSave } from "./effects.ts";
import { isSpell, spellLevelOf } from "./dispel.ts";

// Counterspell: a foe who sees a spell being cast nearby may spend its reaction to make the caster save, and on a
// failure the spell does nothing, its action is spent and its slot isn't. Another reaction to a spell nearby only acts
// on its bearer.

export const CounterSchema = z.object({
  actor: z.string(), // the caster
  actionId: z.string(),
  slot: z.string().optional(),
  target: z.union([z.string(), z.array(z.string())]),
  shape: z.string().optional(), // the shape it's cast in, for a spell that has several
  counterer: z.string(),
  answer: z.string(),
});
export type Cast = Omit<z.infer<typeof CounterSchema>, "counterer" | "answer">;

// The foe's reaction it could counter this spell with, if any.
function counterOf(
  foe: Actor,
  caster: Actor,
  context: Context,
): KnownAction | null {
  if (!foe.budget.reaction || isDown(foe)) return null;
  if (hasCondition(foe, ...INCAPACITATING)) return null;
  if (seeing(foe, caster.position, context.state, context) === "none") {
    return null;
  }
  const stats = deriveStats(foe, context);
  return (
    stats.actions.find((action) => {
      const { trigger, targeting } = action.activation;
      return (
        trigger?.spellCast === true &&
        "range" in targeting &&
        distanceFeet(foe.position, caster.position) <=
          rangeFeet(targeting.range) &&
        canAfford(action, foe, stats)
      );
    }) ?? null
  );
}

// The decision a foe gets before a spell takes effect, or null when nobody can counter it. A cantrip is let
// through first, since a slot of the counter's level is worth more.
export function counterWindow(
  caster: Actor,
  action: KnownAction,
  cast: Cast,
  slotLevel: number | undefined,
  context: Context,
): Frame | null {
  if (!isSpell(action, caster, context)) return null;
  // A spell cast with no components isn't seen being cast.
  if (castsSilently(caster, action, deriveStats(caster, context), context)) {
    return null;
  }
  for (const foe of enemies(context.state, caster)) {
    const counter = counterOf(foe, caster, context);
    if (!counter) continue;
    const level =
      slotLevel ??
      action.spellLevel ??
      spellLevelOf(action.id, caster, context) ??
      0;
    const options = [
      { id: counter.id, label: `${counter.name} (${caster.name})` },
      { id: DECLINE, label: "Let it be cast" },
    ];
    return awaitDecision({
      id: `${NS}:reaction:${foe.id}`,
      actor: foe.id,
      prompt: `${caster.name} casts ${action.name}. React?`,
      options: level > 0 ? options : [...options].reverse(),
      resume: frame("counterspell", { ...cast, counterer: foe.id }),
    });
  }
  return null;
}

export function runCounterspell(
  payload: z.infer<typeof CounterSchema>,
  context: Context,
  cast: (payload: Cast, context: Context) => SystemResult,
): SystemResult {
  const { counterer: countererId, answer, ...rest } = payload;
  if (answer === DECLINE) return cast(rest, context);
  const { state } = context;
  const caster = actorOf(state, payload.actor);
  const counterer = actorOf(state, countererId);
  const counter = findAction(counterer, answer, context);
  const { resolution } = counter.activation;
  // A reaction to a spell nearby that isn't a counter, as a gremishka's Magic Allergy, acts on its bearer and lets the
  // spell through.
  if (
    resolution.kind === "automatic" &&
    !resolution.effects.some(({ kind }) => kind === "counter")
  ) {
    const reacted = resolveAction(counter, counterer, [counterer], context);
    const result = cast(rest, context);
    return {
      ...result,
      events: [
        ...payCosts(counter, counterer, context),
        ...(reacted.events ?? []),
        ...(result.events ?? []),
      ],
      frames: [...(reacted.frames ?? []), ...(result.frames ?? [])],
    };
  }
  const dc =
    resolution.kind === "save"
      ? evaluateFormula(resolution.dc, deriveStats(counterer, context))
      : 0;
  const save = rollSave(caster, "con", dc, context, true);
  const own = deriveStats(counterer, context);
  const slot = slotToSpend(counter, counterer, own);
  const paid = payCosts(counter, counterer, context);
  if (save.saved) {
    const result = cast(rest, context);
    // Spell Breaker: a Counterspell that stops nothing keeps its slot.
    const kept =
      slot !== null && hasPassive(own, "spellBreaker")
        ? slotRefund(counterer, counter, slot)
        : [];
    return {
      ...result,
      events: [...paid, ...kept, ...save.events, ...(result.events ?? [])],
    };
  }
  // Absorb Spells: points back for a spell countered.
  const absorbed = own.passives.flatMap((passive) => {
    if (passive.kind !== "counterRegain") return [];
    const spent = counterer.resourcesSpent[passive.resource] ?? 0;
    const amount = Math.min(
      spent,
      rollDiceNotation(passive.dice, context.dice),
    );
    return amount > 0
      ? [
          dndEvent(`${NS}:resourceRestored`, {
            actor: counterer.id,
            resource: passive.resource,
            amount,
          }),
        ]
      : [];
  });
  const action = findAction(caster, payload.actionId, context);
  const wasted = {
    ...action,
    activation: {
      ...action.activation,
      cost: action.activation.cost.filter((cost) => cost !== "slot"),
    },
  };
  return {
    events: [
      ...paid,
      ...absorbed,
      ...save.events,
      ...payCosts(wasted, caster, context),
    ],
    frames: [CHECK_END, frame("afterAction", { actor: caster.id })],
  };
}

export const counterFrame = (
  cast: (payload: Cast, context: Context) => SystemResult,
) => ({
  [`${NS}:counterspell`]: frameHandler({
    schema: CounterSchema,
    run: (payload: z.infer<typeof CounterSchema>, context: Context) =>
      runCounterspell(payload, context, cast),
  }),
});
