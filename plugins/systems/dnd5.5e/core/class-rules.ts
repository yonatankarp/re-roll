import {
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
} from "#sdk";
import { z } from "zod";
import { type Actor, type DndState, NS, dndEvent, frame } from "./state.ts";
import { type KnownAction, type Stats, deriveStats } from "./stats.ts";
import { seekingReroll } from "./metamagic.ts";

// Rules that class features and Heroic Inspiration need in a fight, kept apart from the combat flow in combat.ts.

type Context = SystemContext<DndState>;

export const REROLL = "reroll";
const DECLINE = "decline";

// An effect like Guiding Bolt's or Bardic Inspiration's lasts only until the next attack roll it applies to.
export function onceEnded(
  actor: Actor,
  on: "attacks" | "attacksAgainst",
): SystemEvent[] {
  return actor.activeEffects.flatMap(({ modifier, sourceId }) =>
    ((modifier.kind === "advantage" || modifier.kind === "disadvantage") &&
      modifier.on === on &&
      modifier.once) ||
    (modifier.kind === "bonus" && modifier.to === on && modifier.once)
      ? [dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId })]
      : [],
  );
}

// Resources that come back every turn, such as Reckless Attack's once a turn. Given back as the bearer's turn ends,
// which is the same as at the start of its next one, since nothing between can spend them. Any rest gives back one
// left spent when a fight ended on the bearer's turn.
// shortcut: a fight started with no rest after that one begins with the use still spent; reset it in startCombat
// once a hook there is free of the sessions changing it.
export function turnRecharge(actor: Actor, context: Context): SystemEvent[] {
  const stats = deriveStats(actor, context);
  return stats.resourceDefs.flatMap(({ id, recharge }) =>
    recharge.some((item) => item.on === "turnStart") &&
    (actor.resourcesSpent[id] ?? 0) > 0
      ? [dndEvent(`${NS}:resourceRestored`, { actor: actor.id, resource: id })]
      : [],
  );
}

// The lowest natural roll that is a Critical Hit.
export function criticalFrom(stats: Stats): number {
  return Math.min(
    20,
    ...stats.passives.flatMap((passive) =>
      passive.kind === "criticalRange" ? [passive.from] : [],
    ),
  );
}

const AttackPayload = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  slotLevel: z.number().int().optional(),
});

// Seeking Spell rerolls a missed spell attack first, and then Heroic Inspiration may.
// shortcut: Heroic Inspiration rerolls only the player's missed attack rolls, not saves or checks.
export function offerInspiration(
  attacker: Actor,
  payload: z.infer<typeof AttackPayload>,
  report: SystemEvent,
  hit?: z.infer<typeof MissSchema>,
  context?: Context,
): SystemResult | null {
  const seeking = seekingReroll(attacker, payload.actionId);
  if (seeking) {
    return {
      events: [report, ...seeking],
      frames: [frame("attackRoll", payload)],
    };
  }
  const precision =
    hit && context ? offerPrecision(attacker, hit, report, context) : null;
  if (precision) return precision;
  if (attacker.id !== PLAYER_ACTOR || !attacker.heroicInspiration) return null;
  return {
    events: [report],
    frames: [
      awaitDecision({
        id: `${NS}:inspiration:${attacker.id}`,
        actor: attacker.id,
        prompt: `${attacker.name} misses. Spend Heroic Inspiration to reroll?`,
        options: [
          { id: REROLL, label: "Reroll with Heroic Inspiration" },
          { id: DECLINE, label: "Keep the miss" },
        ],
        resume: frame("inspiration", payload),
      }),
    ],
  };
}

export const InspirationSchema = AttackPayload.extend({ answer: z.string() });

export function runInspiration(
  { answer, ...attack }: z.infer<typeof InspirationSchema>,
  context: Context,
): SystemResult {
  const attacker = context.state.actors[attack.attacker];
  const target = context.state.actors[attack.target];
  if (!attacker) return {};
  if (answer !== REROLL) {
    return {
      events: [
        ...onceEnded(attacker, "attacks"),
        ...(target ? onceEnded(target, "attacksAgainst") : []),
      ],
    };
  }
  return {
    events: [dndEvent(`${NS}:inspirationSpent`, { actor: attacker.id })],
    frames: [frame("attackRoll", attack)],
  };
}

// Precision Attack: on a miss the die could still turn into a hit, a Superiority Die can be added to the roll.
const PRECISION = "-maneuver-precision-attack";
const SUPERIORITY = "superiority-dice";
const USE = "use";

const MissSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  hadAdvantage: z.boolean(),
  hadDisadvantage: z.boolean().optional(),
  total: z.number(),
  natural: z.number(),
  slotLevel: z.number().optional(),
  noModifier: z.boolean().optional(),
});
export const PrecisionSchema = MissSchema.extend({
  ac: z.number(),
  answer: z.string(),
});

function superiorityDie(stats: Stats): number {
  return stats.scaling.superiorityDie ?? 8;
}

function offerPrecision(
  attacker: Actor,
  hit: z.infer<typeof MissSchema>,
  report: SystemEvent,
  context: Context,
): SystemResult | null {
  const stats = deriveStats(attacker, context);
  const ac =
    "payload" in report
      ? Number((report.payload as { target?: unknown }).target)
      : NaN;
  const left =
    (stats.resources[SUPERIORITY] ?? 0) -
    (attacker.resourcesSpent[SUPERIORITY] ?? 0);
  if (
    hit.natural === 1 ||
    left <= 0 ||
    !Number.isFinite(ac) ||
    ac - hit.total > superiorityDie(stats) ||
    !stats.features.some((id) => id.endsWith(PRECISION))
  ) {
    return null;
  }
  return {
    events: [report],
    frames: [
      awaitDecision({
        id: `${NS}:precision:${attacker.id}`,
        actor: attacker.id,
        prompt: `${attacker.name} misses by ${String(ac - hit.total)}. Add a Superiority Die with Precision Attack?`,
        options: [
          { id: USE, label: "Precision Attack" },
          { id: DECLINE, label: "Keep the miss" },
        ],
        resume: frame("precision", { ...hit, ac }),
      }),
    ],
  };
}

export function runPrecision(
  { answer, ac, ...hit }: z.infer<typeof PrecisionSchema>,
  context: Context,
): SystemResult {
  const attacker = context.state.actors[hit.attacker];
  const target = context.state.actors[hit.target];
  if (!attacker) return {};
  const ended = [
    ...onceEnded(attacker, "attacks"),
    ...(target ? onceEnded(target, "attacksAgainst") : []),
  ];
  if (answer !== USE) return { events: ended };
  const rolled = context.dice.roll(
    superiorityDie(deriveStats(attacker, context)),
  );
  const total = hit.total + rolled;
  return {
    events: [
      dndEvent(`${NS}:resourceSpent`, {
        actor: attacker.id,
        resource: SUPERIORITY,
      }),
      dndEvent(`${NS}:rollReported`, {
        actor: attacker.id,
        against: hit.target,
        natural: hit.natural,
        total,
        target: ac,
        success: total >= ac,
        label: "Precision Attack",
      }),
      ...ended,
    ],
    frames: total >= ac ? [frame("recheckHit", { ...hit, total })] : [],
  };
}

// A maneuver's die is added to the hit's own damage roll, so it takes that damage's type.
export function asHit(action: KnownAction, hitWith: KnownAction): KnownAction {
  const [first] = hitWith.activation.resolution.damage;
  if (!action.hitType || !first) return action;
  const { resolution } = action.activation;
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution: {
        ...resolution,
        damage: resolution.damage.map((item) => ({
          ...item,
          type: first.type,
        })),
      },
    },
  };
}
