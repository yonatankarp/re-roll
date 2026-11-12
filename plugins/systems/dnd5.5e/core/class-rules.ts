import {
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
} from "#sdk";
import { z } from "zod";
import { type Actor, type DndState, NS, dndEvent, frame } from "./state.ts";
import { type Stats, deriveStats } from "./stats.ts";

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

// shortcut: Heroic Inspiration rerolls only the player's missed attack rolls, not saves or checks.
export function offerInspiration(
  attacker: Actor,
  payload: z.infer<typeof AttackPayload>,
  report: SystemEvent,
): SystemResult | null {
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
