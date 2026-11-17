import { type Frame, frameHandler, type SystemResult } from "#sdk";
import { z } from "zod";
import { finalDamage, halved } from "../rules.ts";
import type { Resolution } from "../schemas.ts";
import { type Actor, applyDndEvent, frame, isDead, NS } from "../state.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  rollAmount,
} from "../stats.ts";
import { type HitSchema } from "./attack.ts";
import {
  concentrationFrame,
  dealEvents,
  leafEvents,
  resolveAction,
  resolveTargets,
  typeAgainst,
} from "./effects.ts";
import { AIM } from "./ids.ts";
import {
  actorOf,
  CHECK_END,
  type Context,
  exemptFrom,
  findAction,
  hasPassive,
} from "./queries.ts";
import { afterDamage } from "./reactions.ts";

// What an attack spell does past its hit: the type of its damage a target resists least, a hurt target's larger die
// and dice against its kind, half its damage and its effects on a miss, as Acid Arrow's, and a burst round the target
// hit or miss, as Ice Knife's.

type AttackResolution = Extract<Resolution, { kind: "attack" }>;
type Hit = z.infer<typeof HitSchema>;

// The hit's damage against this target (DamageSchema's `types`, `hurtDie` and `vs`).
export function againstTarget(
  resolution: AttackResolution,
  target: Actor,
  context: Context,
): AttackResolution {
  if (
    !resolution.damage.some(
      (item) =>
        item.types !== undefined ||
        item.hurtDie !== undefined ||
        item.vs !== undefined,
    )
  ) {
    return resolution;
  }
  const responses = damageResponses(target, context);
  const met = deriveStats(target, context);
  const hurt = target.hp < met.maxHp;
  return {
    ...resolution,
    damage: resolution.damage.flatMap((item) => {
      const type = item.types ? typeAgainst(item.types, responses) : item.type;
      const count = (item.amount.dice ?? "").split("d")[0] ?? "0";
      const amount =
        item.hurtDie && hurt
          ? { ...item.amount, dice: `${count}d${String(item.hurtDie)}` }
          : item.amount;
      return [
        { amount, type },
        ...(item.vs && exemptFrom(item.vs.creatureTypes, target, met)
          ? [{ amount: { dice: item.vs.dice }, type }]
          : []),
      ];
    }),
  };
}

const attackOf = (action: KnownAction): AttackResolution | null => {
  const { resolution } = action.activation;
  return resolution.kind === "attack" ? resolution : null;
};

// What a miss sets off of the attack's own, after its mastery and the answers to it.
export function missFrames(hit: Hit, context: Context): Frame[] {
  const attacker = actorOf(context.state, hit.attacker);
  const resolution = attackOf(
    findAction(attacker, hit.actionId, context, hit.slotLevel),
  );
  return resolution && (resolution.missDamage || resolution.onMiss.length > 0)
    ? [frame("applyMiss", hit)]
    : [];
}

export function runApplyMiss(hit: Hit, context: Context): SystemResult {
  const { state } = context;
  const attacker = actorOf(state, hit.attacker);
  const target = actorOf(state, hit.target);
  const action = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const printed = attackOf(action);
  if (!printed || isDead(target)) return {};
  const resolution = againstTarget(printed, target, context);
  const stats = deriveStats(attacker, context);
  const responses = damageResponses(target, context);
  const rolled = resolution.missDamage
    ? resolution.damage.map(({ amount, type }) => ({
        amount: finalDamage(
          halved(rollAmount(amount, stats, context.dice)),
          type,
          responses,
        ),
        type,
      }))
    : [];
  const dealt = dealEvents(target, rolled, false, context);
  const events = [
    ...dealt.events,
    ...leafEvents(resolution.onMiss, action.id, attacker, target, context),
  ];
  return {
    events,
    frames: [
      ...afterDamage(
        target,
        dealt.dealt,
        {
          source: attacker.id,
          types: rolled.map(({ type }) => type),
          spell: action.spellLevel !== null,
        },
        concentrationFrame(
          target,
          dealt.dealt,
          hasPassive(stats, "concentrationBreaker"),
        ),
        { ...context, state: events.reduce(applyDndEvent, state) },
      ),
      CHECK_END,
    ],
  };
}

export const BurstSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
});

// The save round the target as an attack's burst, made as an area spell aimed at it, so it reaches the caster's
// side too.
export function runBurst(
  payload: z.infer<typeof BurstSchema>,
  context: Context,
): SystemResult {
  const attacker = actorOf(context.state, payload.attacker);
  const target = actorOf(context.state, payload.target);
  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const { resolution } = action.activation;
  const burst =
    resolution.kind === "attack" || resolution.kind === "automatic"
      ? resolution.burst
      : undefined;
  if (!burst || !target.position) return {};
  const { targeting } = action.activation;
  const exploding: KnownAction = {
    ...action,
    activation: {
      ...action.activation,
      targeting: {
        area: { shape: "sphere", radius: burst.radius },
        range: "range" in targeting ? targeting.range : "self",
        side: "enemy",
      },
      resolution: {
        kind: "save",
        ability: burst.ability,
        dc: burst.dc,
        damage: burst.damage,
        onSuccessDamage: burst.half ? "half" : "none",
        onFail: [],
        onSuccess: [],
      },
    },
  };
  const caught = resolveTargets(
    `${AIM}${target.id}`,
    exploding,
    attacker,
    context,
  );
  const result = resolveAction(
    exploding,
    attacker,
    caught,
    context,
    payload.slotLevel,
    false,
    target.position,
  );
  return {
    events: result.events ?? [],
    frames: [...(result.frames ?? []), CHECK_END],
  };
}

// applyMiss takes a hit's payload, so it sits with attackFrames (combat/attack.ts).
export const spellRiderFrames = {
  [`${NS}:burst`]: frameHandler({ schema: BurstSchema, run: runBurst }),
};
