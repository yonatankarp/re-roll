import { z } from "zod";
import {
  type Actor,
  dndEvent,
  isDead,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import { DECLINE } from "../ids.ts";
import { distanceFeet } from "../../grid.ts";
import { coverAgainst, seeing } from "../../sight.ts";
import { type Frame, type SystemEvent, type SystemResult } from "#sdk";
import { rollOnTable, slotRefund, strikeAction } from "../reactions.ts";
import {
  damageResponses,
  deriveStats,
  evaluateFormula,
  rollAmount,
} from "../../stats.ts";
import { type Damage } from "../../schemas.ts";
import {
  actorOf,
  type Context,
  enemies,
  findAction,
  meleeReach,
} from "../queries.ts";
import {
  concentrationFrame,
  dealEvents,
  leafEvents,
  payCosts,
  resolveAction,
  rollSave,
} from "../effects.ts";
import { meleeAc, attackKind } from "./attack-kind.ts";
import { acBonusOf, guardCosts, intercepted, transferTo } from "./guards.ts";
import { missedFrames } from "./miss.ts";
import { HitSchema } from "./payloads.ts";

export const ReactionSchema = HitSchema.extend({ answer: z.string() });

export function runAfterReaction(
  payload: z.infer<typeof ReactionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const { answer, ...hit } = payload;
  if (answer === DECLINE) return intercepted(hit, context);

  const target = actorOf(state, payload.target);
  const action = findAction(target, answer, context);
  const { resolution } = action.activation;
  // Elemental Rebuke: the hit is halved now, and the attacker saves once its damage lands (runReactAnswer pays).
  const halves = (action.activation.selfEffects ?? []).some(
    (effect) => effect.kind === "reduceDamage" && effect.halve,
  );
  if (resolution.kind === "save" && halves) {
    return {
      events: guardCosts(target, action, context),
      frames: [frame("applyHit", { ...hit, halve: true, echo: action.id })],
    };
  }
  // Jinx or Warding Charm: the attacker saves, and on a failure the hit misses.
  if (resolution.kind === "save") {
    const attacker = actorOf(state, payload.attacker);
    const dc = evaluateFormula(resolution.dc, deriveStats(target, context));
    const save = rollSave(attacker, resolution.ability, dc, context);
    const paid = [...payCosts(action, target, context), ...save.events];
    if (save.saved) {
      const guard = intercepted(hit, context);
      return { events: [...paid, ...guard.events], frames: guard.frames };
    }
    const turned = resolution.onFail.some(
      (effect) => effect.kind === "negateHit" && effect.retarget,
    )
      ? retargeted(hit, attacker, target, context)
      : null;
    return {
      events: [
        ...paid,
        ...leafEvents(resolution.onFail, action.id, target, attacker, context),
      ],
      frames: [
        ...missedFrames(hit, context),
        ...(turned ? [frame("recheckHit", turned)] : []),
      ],
    };
  }
  // Illusory Self: the hit misses outright.
  if (
    resolution.kind === "automatic" &&
    resolution.effects.some((effect) => effect.kind === "negateHit")
  ) {
    return {
      events: [
        ...payCosts(action, target, context),
        ...(resolveAction(action, target, [target], context).events ?? []),
      ],
      frames: missedFrames(hit, context),
    };
  }
  const result = resolveAction(action, target, [target], context);
  // Mythal Ward's table: its row lands before the hit is checked again, and may turn the spell aside.
  const attacker = actorOf(state, payload.attacker);
  const attack = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const table = rollOnTable(
    action,
    target,
    attacker,
    payload.slotLevel ?? attack.spellLevel ?? 0,
    context,
  );
  if (table.negate) {
    return {
      events: [
        ...payCosts(action, target, context),
        ...(result.events ?? []),
        ...table.events,
        ...slotRefund(
          attacker,
          attack,
          payload.slotLevel ?? attack.spellLevel ?? 0,
        ),
      ],
      frames: [...table.frames, ...missedFrames(hit, context)],
    };
  }
  const strike =
    resolution.kind === "automatic"
      ? resolution.effects.find((effect) => effect.kind === "strike")
      : undefined;
  const stats = deriveStats(target, context);
  const lessened = (
    resolution.kind === "automatic" ? resolution.effects : []
  ).flatMap((effect) => (effect.kind === "reduceDamage" ? [effect] : []));
  const reduceBy = lessened.reduce(
    (sum, effect) =>
      sum +
      (effect.amount ? rollAmount(effect.amount, stats, context.dice) : 0),
    0,
  );
  const acBonus = (
    resolution.kind === "automatic" ? resolution.effects : []
  ).reduce(
    (sum, effect) =>
      effect.kind === "acAgainstHit"
        ? sum + acBonusOf(effect, stats, context.dice)
        : sum,
    0,
  );
  // The rest of the attack is held here and rechecked once the reaction has taken effect.
  return {
    events: [
      ...payCosts(action, target, context),
      ...(result.events ?? []),
      ...table.events,
    ],
    frames: [
      ...(result.frames ?? []),
      ...table.frames,
      frame("recheckHit", {
        ...hit,
        // Sentinel at Death's Door: a Critical Hit is a normal hit.
        ...((resolution.kind === "automatic" ? resolution.effects : []).some(
          (effect) => effect.kind === "noCritical",
        )
          ? { critical: false }
          : {}),
        ...(lessened.some((effect) => effect.halve) ? { halve: true } : {}),
        ...(reduceBy > 0 ? { reduceBy: (hit.reduceBy ?? 0) + reduceBy } : {}),
        ...(acBonus > 0 ? { acBonus: (hit.acBonus ?? 0) + acBonus } : {}),
        ...(strike?.kind === "strike" ? { riposte: strike.action ?? "" } : {}),
        ...(lessened.some((effect) => effect.deflect)
          ? { deflect: action.id }
          : {}),
        ...transferTo(lessened, target, context),
      }),
    ],
  };
}

// Instinctive Charm: the attack goes on at the nearest other creature within its reach or range, with the same roll.
function retargeted(
  hit: z.infer<typeof HitSchema>,
  attacker: Actor,
  target: Actor,
  context: Context,
): z.infer<typeof HitSchema> | null {
  const attack = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const { targeting } = attack.activation;
  const reach =
    meleeReach(attack) ??
    ("range" in targeting && typeof targeting.range === "number"
      ? targeting.range
      : 5);
  const other = Object.values(context.state.actors)
    .filter(
      (item) =>
        item.id !== attacker.id &&
        item.id !== target.id &&
        !isDown(item) &&
        !isDead(item) &&
        distanceFeet(attacker.position, item.position) <= reach,
    )
    .sort(
      (a, b) =>
        distanceFeet(attacker.position, a.position) -
        distanceFeet(attacker.position, b.position),
    )[0];
  return other
    ? {
        attacker: hit.attacker,
        actionId: hit.actionId,
        target: other.id,
        critical: false,
        hadAdvantage: hit.hadAdvantage,
        total: hit.total,
        natural: hit.natural,
        ...(hit.slotLevel === undefined ? {} : { slotLevel: hit.slotLevel }),
      }
    : null;
}

export function runRecheckHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const target = actorOf(state, payload.target);
  const attacker = actorOf(state, payload.attacker);
  const targetStats = deriveStats(target, context);
  const ac =
    targetStats.ac +
    meleeAc(target, attackKind(payload, context).melee, targetStats) +
    coverAgainst(state, attacker, target, context) +
    (payload.acBonus ?? 0);
  if (!payload.critical && payload.total < ac) {
    // Riposte: on the miss, the target makes its attack back, or the guard that turned it aside does.
    const riposter = payload.riposter ? state.actors[payload.riposter] : target;
    const attack =
      payload.riposte === undefined || !riposter
        ? undefined
        : strikeAction(riposter, payload.riposte || undefined, context);
    const reaches =
      attack !== undefined &&
      riposter !== undefined &&
      distanceFeet(riposter.position, attacker.position) <=
        (meleeReach(attack) ?? 5);
    return {
      frames: [
        ...(attack && riposter && reaches
          ? [
              frame("attackRoll", {
                attacker: riposter.id,
                actionId: attack.id,
                target: payload.attacker,
              }),
            ]
          : []),
        ...missedFrames(payload, context),
      ],
    };
  }
  return intercepted(payload, context);
}

// Damage a reaction took off a hit and passed on: Transfer Harm's other half to the podling, or Deflect Missile's
// force at a foe once the hit is brought to 0.
export function passedOn(
  hits: readonly { readonly amount: number; readonly type: Damage["type"] }[],
  lessened: readonly {
    readonly amount: number;
    readonly type: Damage["type"];
  }[],
  payload: z.infer<typeof HitSchema>,
  attacker: Actor,
  target: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const { state } = context;
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  const kin = payload.transfer ? state.actors[payload.transfer] : undefined;
  if (kin) {
    const taken = hits.map((item, index) => ({
      type: item.type,
      amount:
        Math.max(0, item.amount) - Math.max(0, lessened[index]?.amount ?? 0),
      response: damageResponses(kin, context),
    }));
    const dealt = dealEvents(kin, taken, false, context);
    events.push(...dealt.events);
    frames.push(...concentrationFrame(kin, dealt.dealt));
  }
  const landed = hits.some((item) => item.amount > 0);
  if (payload.deflect && landed && lessened.every((item) => item.amount <= 0)) {
    const action = findAction(target, payload.deflect, context);
    const { resolution } = action.activation;
    const deflect = (resolution.kind === "automatic" ? resolution.effects : [])
      .flatMap((effect) => (effect.kind === "reduceDamage" ? [effect] : []))
      .find((effect) => effect.deflect)?.deflect;
    // At the attacker when it's in range, else the nearest foe that is.
    const kind = attackKind(payload, context);
    const range =
      deflect && kind.melee ? (deflect.melee ?? deflect.range) : deflect?.range;
    const targetStats = deriveStats(target, context);
    const paid =
      !deflect?.resource ||
      (target.resourcesSpent[deflect.resource] ?? 0) <
        (targetStats.resources[deflect.resource] ?? 0);
    const victim =
      deflect && paid && range !== undefined
        ? [attacker, ...enemies(state, target)].find(
            (item) =>
              item.side !== target.side &&
              !isDown(item) &&
              distanceFeet(item.position, target.position) <= range &&
              seeing(target, item.position, state, context) !== "none",
          )
        : undefined;
    if (deflect && victim) {
      if (deflect.resource) {
        events.push(
          dndEvent(`${NS}:resourceSpent`, {
            actor: target.id,
            resource: deflect.resource,
          }),
        );
      }
      const dc =
        typeof deflect.dc === "number"
          ? deflect.dc
          : evaluateFormula(deflect.dc, targetStats);
      const save = rollSave(victim, deflect.ability, dc, context);
      events.push(...save.events);
      // Deflect Attacks: the type of the attack's own damage.
      const own = lessened[0]?.type;
      if (!save.saved) {
        const stats = targetStats;
        const responses = damageResponses(victim, context);
        const dealt = dealEvents(
          victim,
          deflect.damage
            .map(({ amount, type: printed }) => ({
              type: deflect.sameType && own ? own : printed,
              amount,
            }))
            .map(({ amount, type }) => ({
              amount: rollAmount(amount, stats, context.dice),
              response: responses,
              type,
            })),
          false,
          context,
        );
        events.push(...dealt.events);
        frames.push(...concentrationFrame(victim, dealt.dealt));
      }
    }
  }
  return { events, frames };
}
