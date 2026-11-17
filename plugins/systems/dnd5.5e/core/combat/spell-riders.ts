import { type Frame, frameHandler, type SystemResult } from "#sdk";
import { z } from "zod";
import { finalDamage, halved } from "../rules.ts";
import type { Resolution } from "../schemas.ts";
import {
  type Actor,
  applyDndEvent,
  frame,
  isDead,
  isDown,
  NS,
} from "../state.ts";
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
import { distanceFeet } from "../grid.ts";
import { AIM } from "./ids.ts";
import {
  actorOf,
  CHECK_END,
  type Context,
  enemies,
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

// The hit's damage against this target (DamageSchema's `types`, `hurtDie`, `vs`, `except` and `only`).
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
        item.vs !== undefined ||
        item.except !== undefined ||
        item.only !== undefined,
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
      if (item.except && exemptFrom(item.except, target, met)) return [];
      if (item.only && !exemptFrom(item.only, target, met)) return [];
      const type = item.types ? typeAgainst(item.types, responses) : item.type;
      const count = (item.amount.dice ?? "").split("d")[0] ?? "0";
      const amount =
        item.hurtDie && hurt
          ? { ...item.amount, dice: `${count}d${String(item.hurtDie)}` }
          : item.amount;
      return [
        {
          amount,
          type,
          ...(item.rolledTypes ? { rolledTypes: item.rolledTypes } : {}),
          ...(item.tempHp ? { tempHp: true as const } : {}),
        },
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
  const { burst } = resolution;
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
        // Detonate's explosion is harder to escape when the seed dropped the creature it was in.
        ...(burst.dropped && target.hp <= 0
          ? { edges: [{ roll: "disadvantage" as const }] }
          : {}),
      },
    },
  };
  const around = (
    burst.everyone
      ? Object.values(context.state.actors).filter(
          (item) =>
            !isDead(item) &&
            item.position !== null &&
            distanceFeet(target.position, item.position) <= burst.radius,
        )
      : resolveTargets(`${AIM}${target.id}`, exploding, attacker, context)
  ).filter((item) => !burst.others || item.id !== target.id);
  const caught = around;
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

// Chromatic Orb's or Chaos Bolt's leap from the creature just hit to another within reach of it, with a new roll.
// shortcut: it leaps to the nearest foe of the attacker's it hasn't struck yet (the most hurt of those as near),
// rather than one the player picks.
const LeapSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
  leapt: z.array(z.string()).optional(),
});

export function runLeap(
  hit: z.infer<typeof LeapSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const attacker = actorOf(state, hit.attacker);
  const from = actorOf(state, hit.target);
  const action = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const leap = attackOf(action)?.leap;
  if (!leap || !from.position) return {};
  const leapt = [...(hit.leapt ?? []), from.id];
  const most =
    leap.max === "slotLevel"
      ? (hit.slotLevel ?? action.spellLevel ?? 1)
      : Infinity;
  if (leapt.length - 1 >= most) return {};
  const [next] = enemies(state, attacker)
    .filter(
      (item) =>
        !leapt.includes(item.id) &&
        !isDown(item) &&
        distanceFeet(from.position, item.position) <= leap.feet,
    )
    .sort(
      (a, b) =>
        distanceFeet(from.position, a.position) -
          distanceFeet(from.position, b.position) || a.hp - b.hp,
    );
  if (!next) return {};
  return {
    frames: [
      frame("attackRoll", {
        attacker: attacker.id,
        actionId: action.id,
        target: next.id,
        ...(hit.slotLevel === undefined ? {} : { slotLevel: hit.slotLevel }),
        leapt,
      }),
    ],
  };
}

// applyMiss takes a hit's payload, so it sits with attackFrames (combat/attack.ts).
export const spellRiderFrames = {
  [`${NS}:burst`]: frameHandler({ schema: BurstSchema, run: runBurst }),
  [`${NS}:leap`]: frameHandler({ schema: LeapSchema, run: runLeap }),
};
