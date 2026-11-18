import { z } from "zod";
import { isDown, frame } from "../../state.ts";
import { missFrames } from "../spell-riders.ts";
import { type Frame, type SystemResult } from "#sdk";
import { reactFrames } from "../reactions.ts";
import { deriveStats } from "../../stats.ts";
import { masteryOf } from "../../tactics.ts";
import { actorOf, type Context } from "../queries.ts";
import { leafEvents } from "../effects.ts";
import { attackKind } from "./attack-kind.ts";
import { HitSchema } from "./payloads.ts";

// What follows a miss: what the attack itself does on one, as Acid Arrow's splash, its weapon's mastery, as Graze,
// and what answers it.
export function missOutcome(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): Frame[] {
  const attacker = actorOf(context.state, hit.attacker);
  return [
    ...(deriveStats(attacker, context).passives.some(
      ({ kind }) => kind === "missRider",
    )
      ? [frame("missRider", hit)]
      : []),
    ...missFrames(hit, context),
    ...(masteryOf(attacker, hit.actionId, context)
      ? [frame("masteryMiss", hit)]
      : []),
    ...missedFrames(hit, context),
  ];
}

// What answers an attack that missed its target, as Sticky Shield does.
export function missedFrames(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): Frame[] {
  return [
    ...reactFrames(
      {
        kind: "missed",
        actor: hit.target,
        source: hit.attacker,
        ...attackKind(hit, context),
        ...(attackKind(hit, context).spell ? {} : { weapon: hit.actionId }),
      },
      context,
    ),
  ];
}

// What the attacker's own features put on a creature its attack roll missed, as Studied Attacks.
export function runMissRider(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const attacker = actorOf(context.state, hit.attacker);
  const target = context.state.actors[hit.target];
  if (!target || isDown(attacker)) return {};
  return {
    events: deriveStats(attacker, context).passives.flatMap((passive, index) =>
      passive.kind === "missRider"
        ? leafEvents(
            passive.effects,
            `miss:${hit.attacker}:${String(index)}`,
            attacker,
            target,
            context,
          )
        : [],
    ),
  };
}
