import { z } from "zod";
import {
  awaitDecision,
  type Frame,
  frameHandler,
  type SystemEvent,
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
import { deriveStats, evaluateFormula, type KnownAction } from "../stats.ts";
import { seeing } from "../sight.ts";
import {
  actorOf,
  canAfford,
  CHECK_END,
  type Context,
  enemies,
  findAction,
  slotLevelFor,
} from "./queries.ts";
import {
  payCosts,
  resolveAction,
  retributionEvents,
  rollSave,
} from "./effects.ts";
import { itemUseOf } from "./ids.ts";
import { ItemSchema, type LeafEffect } from "../schemas.ts";
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

// An automatic counter's own limits (an Ioun Stone of Absorption's), or null for one that makes the caster save.
function outright(
  action: KnownAction,
): Extract<LeafEffect, { kind: "counter" }> | null {
  const { resolution } = action.activation;
  if (resolution.kind !== "automatic") return null;
  const found = resolution.effects.find((effect) => effect.kind === "counter");
  return found?.kind === "counter" ? found : null;
}

// The foe's reaction it could counter this spell, of `level`, with, if any. `alone` is whether the spell is aimed
// at that foe alone.
function counterOf(
  foe: Actor,
  caster: Actor,
  level: number,
  alone: boolean,
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
      const limits = outright(action);
      return (
        trigger?.spellCast === true &&
        "range" in targeting &&
        distanceFeet(foe.position, caster.position) <=
          rangeFeet(targeting.range) &&
        canAfford(action, foe, stats) &&
        (limits?.maxLevel === undefined || level <= limits.maxLevel) &&
        (!limits?.gains ||
          (alone &&
            level > 0 &&
            roomFor(foe, action, limits, level, context))) &&
        (limits?.levels === undefined ||
          limits.gains === true ||
          (level > 0 &&
            (stats.resources[limits.levels] ?? 0) -
              (foe.resourcesSpent[limits.levels] ?? 0) >=
              level))
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
  const level =
    slotLevel ??
    action.spellLevel ??
    spellLevelOf(action.id, caster, context) ??
    0;
  for (const foe of enemies(context.state, caster)) {
    const aimed = typeof cast.target === "string" ? [cast.target] : cast.target;
    const alone = aimed.length > 0 && aimed.every((id) => id === foe.id);
    const counter = counterOf(foe, caster, level, alone, context);
    if (!counter) continue;
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
  const limits = outright(counter);
  if (limits) {
    // It fails outright, and what cast it is spent, its slot too.
    const action = findAction(caster, payload.actionId, context);
    const level =
      slotLevelFor(caster, payload.actionId, payload.slot, context) ??
      action.spellLevel ??
      spellLevelOf(action.id, caster, context) ??
      0;
    return {
      events: [
        ...payCosts(counter, counterer, context),
        ...(limits.levels && limits.gains
          ? absorbed(counterer, counter, limits.levels, level, context)
          : limits.levels
            ? [
                dndEvent(`${NS}:resourceSpent`, {
                  actor: counterer.id,
                  resource: limits.levels,
                  amount: level,
                }),
              ]
            : []),
        ...payCosts(action, caster, context, level || undefined),
      ],
      frames: [CHECK_END, frame("afterAction", { actor: caster.id })],
    };
  }
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
  const paid = payCosts(counter, counterer, context);
  if (save.saved) {
    const result = cast(rest, context);
    return {
      ...result,
      events: [...paid, ...save.events, ...(result.events ?? [])],
    };
  }
  const action = findAction(caster, payload.actionId, context);
  const wasted = {
    ...action,
    activation: {
      ...action.activation,
      cost: action.activation.cost.filter((cost) => cost !== "slot"),
    },
  };
  return {
    events: [...paid, ...save.events, ...payCosts(wasted, caster, context)],
    frames: [CHECK_END, frame("afterAction", { actor: caster.id })],
  };
}

// Whether an absorbing item holds this many more levels, or breaks past its maximum as a Staff of the Magi does.
// A Rod of Absorption with no room lets the spell through.
function roomFor(
  foe: Actor,
  counter: KnownAction,
  limits: Extract<LeafEffect, { kind: "counter" }>,
  level: number,
  context: Context,
): boolean {
  if (!limits.levels) return true;
  if ((foe.resourcesSpent[limits.levels] ?? 0) >= level) return true;
  const itemId = itemUseOf(counter.id);
  const item = itemId
    ? ItemSchema.safeParse(context.content(itemId)).data
    : undefined;
  return (item && "activations" in item ? (item.activations ?? []) : []).some(
    ({ activation }) =>
      activation.resolution.kind === "automatic" &&
      activation.resolution.effects.some(
        (effect) => effect.kind === "retribution",
      ),
  );
}

// A Staff of the Magi's absorbed spell: its levels back as charges, and past its maximum, the staff breaks as its
// Retributive Strike does.
function absorbed(
  bearer: Actor,
  counter: KnownAction,
  resource: string,
  level: number,
  context: Context,
): SystemEvent[] {
  const spent = bearer.resourcesSpent[resource] ?? 0;
  if (level <= spent) {
    return [
      dndEvent(`${NS}:resourceRestored`, {
        actor: bearer.id,
        resource,
        amount: level,
      }),
    ];
  }
  const itemId = itemUseOf(counter.id);
  const item = itemId
    ? ItemSchema.safeParse(context.content(itemId)).data
    : undefined;
  const strike = (item && "activations" in item ? (item.activations ?? []) : [])
    .flatMap(({ activation }) =>
      activation.resolution.kind === "automatic"
        ? activation.resolution.effects
        : [],
    )
    .find((effect) => effect.kind === "retribution");
  // Charges past the maximum blast as though held, so the staff is at its maximum and more.
  const over = {
    ...bearer,
    resourcesSpent: { ...bearer.resourcesSpent, [resource]: spent - level },
  };
  return itemId && strike?.kind === "retribution"
    ? retributionEvents(over, itemId, strike, context)
    : [];
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
