import { awaitDecision, type Frame, type SystemResult } from "#sdk";
import type { z } from "zod";
import { finalDamage, halved } from "../rules.ts";
import { type Actor, applyDndEvent, frame, isDown, NS } from "../state.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  rollAmount,
} from "../stats.ts";
import { type HitSchema, missOutcome } from "./attack.ts";
import {
  concentrationFrame,
  dealEvents,
  payCosts,
  resolveAction,
  resolveTargets,
} from "./effects.ts";
import { AIM, DECLINE, parseOption } from "./ids.ts";
import {
  actorOf,
  canAfford,
  itemFits,
  CHECK_END,
  type Context,
  findAction,
  isMelee,
  slotToSpend,
  withUpcasts,
} from "./queries.ts";
import { afterDamage } from "./reactions.ts";

// Spells cast on a ranged weapon's hit: an area round the creature hit, as Hail of Thorns', and Lightning Arrow,
// which takes the attack's place as it hits or misses.

type Hit = z.infer<typeof HitSchema>;

// Who a spell on a hit reaches: an area it targets is centred on the creature hit, which it leaves out when the
// spell has already struck it in the attack's place.
export function aroundHit(
  action: KnownAction,
  attacker: Actor,
  target: Actor,
  context: Context,
): readonly Actor[] {
  if (!("area" in action.activation.targeting)) return [target];
  const caught = resolveTargets(
    `${AIM}${target.id}`,
    action,
    attacker,
    context,
  );
  return action.activation.trigger?.replacesHit
    ? caught.filter((item) => item.id !== target.id)
    : caught;
}

// Offered as a ranged weapon attack hits or misses, before anything it does.
export function replaceHitFrame(
  hit: Hit,
  landed: boolean,
  context: Context,
): Frame | null {
  const attacker = actorOf(context.state, hit.attacker);
  const target = actorOf(context.state, hit.target);
  const stats = deriveStats(attacker, context);
  // Most attackers have no such spell, so that's looked at first.
  if (
    isDown(attacker) ||
    isDown(target) ||
    !stats.actions.some((action) => action.activation.trigger?.replacesHit)
  ) {
    return null;
  }
  const hitWith = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const { resolution } = hitWith.activation;
  if (
    resolution.kind !== "attack" ||
    resolution.attack.type !== "weapon" ||
    isMelee(hitWith)
  ) {
    return null;
  }
  const options = stats.actions
    .filter(
      (action) =>
        action.activation.trigger?.replacesHit &&
        (landed || !action.activation.trigger.hitOnly) &&
        itemFits(action, hitWith) &&
        canAfford(action, attacker, stats),
    )
    .flatMap((action) =>
      withUpcasts(action, attacker, stats, target.id, action.name),
    );
  if (options.length === 0) return null;
  return awaitDecision({
    id: `${NS}:afterHit:${attacker.id}:instead`,
    actor: attacker.id,
    prompt: `${attacker.name} ${landed ? "hits" : "misses"} ${target.name}. Turn the shot into a spell?`,
    options: [...options, { id: DECLINE, label: "Not this time" }],
    resume: frame("replaceHit", { ...hit, landed }),
  });
}

export function runReplaceHit(
  payload: Hit & { readonly landed: boolean; readonly answer: string },
  context: Context,
): SystemResult {
  const { landed, answer, ...hit } = payload;
  if (answer === DECLINE) {
    return {
      frames: landed
        ? [frame("applyHit", { ...hit, kept: true })]
        : missOutcome(hit, context),
    };
  }
  const { state } = context;
  const attacker = actorOf(state, hit.attacker);
  const target = actorOf(state, hit.target);
  const stats = deriveStats(attacker, context);
  const [actionId = "", , slot] = parseOption(answer);
  const slotLevel =
    slot === undefined
      ? (slotToSpend(
          findAction(attacker, actionId, context),
          attacker,
          stats,
        ) ?? undefined)
      : Number(slot);
  const found = findAction(attacker, actionId, context, slotLevel);
  // Piercing or Seeking Arrow deals the weapon's own damage too, as if the arrow hit.
  const weapon = found.activation.weaponDamage
    ? findAction(attacker, hit.actionId, context).activation.resolution.damage
    : [];
  const action =
    weapon.length > 0
      ? {
          ...found,
          activation: {
            ...found.activation,
            resolution: {
              ...found.activation.resolution,
              damage: [...weapon, ...found.activation.resolution.damage],
            },
          },
        }
      : found;
  const responses = damageResponses(target, context);
  const rolled = (action.activation.trigger?.replacesHit ?? []).map(
    ({ amount, type }) => {
      const total = rollAmount(amount, stats, context.dice);
      return {
        amount: finalDamage(landed ? total : halved(total), type, responses),
        type,
      };
    },
  );
  const paid = payCosts(action, attacker, context, slotLevel);
  const dealt = dealEvents(target, rolled, false, {
    ...context,
    state: paid.reduce(applyDndEvent, state),
  });
  const events = [...paid, ...dealt.events];
  const after = { ...context, state: events.reduce(applyDndEvent, state) };
  const around = aroundHit(action, attacker, target, after);
  const burst =
    around.length > 0
      ? resolveAction(
          action,
          attacker,
          around,
          after,
          slotLevel,
          false,
          target.position ?? undefined,
        )
      : {};
  return {
    events: [...events, ...(burst.events ?? [])],
    frames: [
      ...afterDamage(
        target,
        dealt.dealt,
        {
          source: attacker.id,
          types: rolled.map(({ type }) => type),
          spell: true,
        },
        concentrationFrame(target, dealt.dealt),
        after,
      ),
      ...(burst.frames ?? []),
      CHECK_END,
    ],
  };
}
