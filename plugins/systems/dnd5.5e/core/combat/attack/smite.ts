import { companionOwner } from "../companions.ts";
import { z } from "zod";
import { type Actor, dndEvent, isDown, NS, frame } from "../../state.ts";
import { DECLINE, parseOption } from "../ids.ts";
import { SNEAK_DICE } from "../strikes.ts";
import { aroundHit } from "../ranged-smite.ts";
import { distanceFeet } from "../../grid.ts";
import { awaitDecision, type SystemResult } from "#sdk";
import { deriveStats, type KnownAction, type Stats } from "../../stats.ts";
import { CHARGE_FROM } from "../../tactics.ts";
import { asHit } from "../../class-rules.ts";
import { holdsShield, markedBy } from "../../trait-rules.ts";
import {
  actorOf,
  canAfford,
  hitFits,
  itemFits,
  type Context,
  findAction,
  onceKey,
  reaches,
  fitsType,
  slotToSpend,
  withUpcasts,
} from "../queries.ts";
import {
  leafEvents,
  payCosts,
  reactionMove,
  resolveAction,
} from "../effects.ts";
import { inOwnTurn } from "./attack-kind.ts";

export function smitesFor(
  hitWith: KnownAction,
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
  following?: string,
  critical = false,
): readonly KnownAction[] {
  if (hitWith.activation.resolution.kind !== "attack") return [];
  return stats.actions.filter((action) => {
    const { trigger } = action.activation;
    return (
      trigger?.afterHit !== undefined &&
      (following === undefined
        ? trigger.following === undefined
        : trigger.following?.includes(following) === true) &&
      !trigger.replacesHit && // offered before the hit lands instead (combat/ranged-smite.ts)
      trigger.forgo === undefined && // picked before the damage (combat/strikes.ts)
      !trigger.forgoAdvantage && // picked before the roll
      !trigger.gainsAdvantage &&
      trigger.fixedRoll === undefined &&
      (!trigger.onCritical || critical) &&
      canAfford(action, attacker, stats) &&
      hitFits(trigger.afterHit, hitWith, attacker, context) &&
      itemFits(action, hitWith, context) &&
      (!trigger.withFeature ||
        hitWith.id.startsWith(`feature:${trigger.withFeature}:`)) &&
      (!trigger.sneakAttack || sneakLanded(attacker, stats)) &&
      (!trigger.marked || markedBy(target, attacker, trigger.marked)) &&
      (!trigger.ownTurn || inOwnTurn(attacker, context)) &&
      (trigger.charge === undefined ||
        charged(attacker, target, trigger.charge)) &&
      (!action.activation.withShield || holdsShield(attacker, context)) &&
      (!trigger.dealing ||
        hitWith.activation.resolution.damage.some(
          (item) =>
            item.type === trigger.dealing ||
            (item.types ?? []).includes(trigger.dealing ?? item.type),
        ))
    );
  });
}

// Charge Attack: the last walk this turn was at least `feet` in a straight line toward the target.
function charged(attacker: Actor, target: Actor, feet: number): boolean {
  const last = attacker.usedThisTurn.findLast((key) =>
    key.startsWith(CHARGE_FROM),
  );
  if (!last || !attacker.position || !target.position) return false;
  const [x = NaN, y = NaN] = last
    .slice(CHARGE_FROM.length)
    .split(",")
    .map(Number);
  const from = { x, y };
  const walked = distanceFeet(from, attacker.position);
  return (
    walked >= feet &&
    distanceFeet(from, target.position) >=
      walked + distanceFeet(attacker.position, target.position) - 5
  );
}

// Whether the attacker's Sneak Attack has been dealt this turn, as it is once a hit carries it.
function sneakLanded(attacker: Actor, stats: Stats): boolean {
  return stats.passives.some(
    (passive, index) =>
      passive.kind === "extraDamage" &&
      passive.diceCount === SNEAK_DICE &&
      attacker.usedThisTurn.includes(`extra:${String(index)}`),
  );
}

// The creatures an `afterHit` option with `near` can go for instead of the one hit: of its side, within `near` of
// that one and within its own range, and with `sameRoll` only those the attack roll's total also hits.
function nearHit(
  action: KnownAction,
  attacker: Actor,
  hit: Actor,
  total: number | undefined,
  context: Context,
): readonly Actor[] {
  const { trigger, targeting } = action.activation;
  if (trigger?.near === undefined || !("creatures" in targeting)) return [];
  const { state } = context;
  const near = trigger.near;
  return Object.values(state.actors).filter(
    (item) =>
      item.id !== hit.id &&
      item.position !== null &&
      !isDown(item) &&
      (item.side === attacker.side) === (targeting.side === "ally") &&
      distanceFeet(item.position, hit.position) <= near &&
      reaches(action, attacker, item) &&
      (!trigger.sameRoll ||
        (total !== undefined && total >= deriveStats(item, context).ac)),
  );
}

export const AfterHitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  total: z.number().optional(), // the attack roll, for an option that must also hit another (`sameRoll`)
  // A second strike option of one name on a hit adds its effects but not its damage, as Brutal Strike's die.
  noDamage: z.boolean().optional(),
  // The feature whose option just landed, so only the options that follow it are offered (`trigger.following`).
  following: z.string().optional(),
});

export function runAfterHit(
  payload: z.infer<typeof AfterHitSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const stats = deriveStats(attacker, context);
  const hitWith = findAction(attacker, payload.actionId, context);
  // One limited to a size or type, as Hill's Tumble to Large or smaller, is offered only for a target that fits.
  const options = smitesFor(
    hitWith,
    attacker,
    target,
    stats,
    context,
    payload.following,
    payload.critical,
  ).flatMap((action) =>
    action.activation.trigger?.near === undefined
      ? fitsType(target, action.activation.targeting, context, attacker)
        ? withUpcasts(action, attacker, stats, target.id, action.name)
        : []
      : nearHit(action, attacker, target, payload.total, context).flatMap(
          (item) =>
            withUpcasts(
              action,
              attacker,
              stats,
              item.id,
              `${action.name}: ${item.name}`,
            ),
        ),
  );
  // A lasting companion's hit: what its owner can add, as Arcane Jolt.
  const ownerId = companionOwner(attacker);
  const owner = ownerId ? state.actors[ownerId] : undefined;
  const ownerOptions =
    owner && !isDown(target) && !isDown(attacker)
      ? ownerSmites(owner, target, context)
      : [];
  if (ownerOptions.length > 0 && owner) {
    return {
      frames: [
        awaitDecision({
          id: `${NS}:companionHit:${owner.id}`,
          actor: owner.id,
          prompt: `${attacker.name} hits ${target.name}. Add something to the hit?`,
          options: [...ownerOptions, { id: DECLINE, label: "Not this time" }],
          resume: frame("companionSmite", {
            owner: owner.id,
            target: target.id,
          }),
        }),
      ],
    };
  }
  if (isDown(target) || isDown(attacker) || options.length === 0) return {};
  return {
    frames: [
      awaitDecision({
        id: `${NS}:afterHit:${attacker.id}`,
        actor: attacker.id,
        prompt: `${attacker.name} hits ${target.name}. Add something to the hit?`,
        options: [...options, { id: DECLINE, label: "Not this time" }],
        resume: frame("smite", payload),
      }),
    ],
  };
}

export const SmiteSchema = AfterHitSchema.extend({ answer: z.string() });

// Whether a lasting companion's owner has something to add to its hit.
export function companionSmites(
  attacker: Actor,
  target: Actor,
  context: Context,
): boolean {
  const ownerId = companionOwner(attacker);
  const owner = ownerId ? context.state.actors[ownerId] : undefined;
  return owner !== undefined && ownerSmites(owner, target, context).length > 0;
}

// The owner's activations it can add to its lasting companion's hit, as Arcane Jolt's.
function ownerSmites(
  owner: Actor,
  target: Actor,
  context: Context,
): { id: string; label: string }[] {
  const stats = deriveStats(owner, context);
  return stats.actions.flatMap((action) =>
    action.activation.trigger?.afterHit !== undefined &&
    action.activation.trigger.alsoCompanion === true &&
    canAfford(action, owner, stats) &&
    fitsType(target, action.activation.targeting, context, owner)
      ? [{ id: action.id, label: action.name }]
      : [],
  );
}

export const CompanionSmiteSchema = z.object({
  owner: z.string(),
  target: z.string(),
  answer: z.string(),
});

// The owner pays for what it adds to its companion's hit, which lands on the creature hit.
export function runCompanionSmite(
  payload: z.infer<typeof CompanionSmiteSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === DECLINE) return {};
  const owner = actorOf(context.state, payload.owner);
  const target = actorOf(context.state, payload.target);
  const action = findAction(owner, payload.answer, context);
  const done = resolveAction(action, owner, [target], context);
  return {
    events: [
      ...payCosts(action, owner, context),
      ...(action.activation.oncePerTurn
        ? [
            dndEvent(`${NS}:oncePerTurnUsed`, {
              actor: owner.id,
              key: onceKey(action),
            }),
          ]
        : []),
      ...(done.events ?? []),
    ],
    frames: [...(done.frames ?? [])],
  };
}

export function runSmite(
  payload: z.infer<typeof SmiteSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === DECLINE) return {};
  const { state } = context;
  const attacker = actorOf(state, payload.attacker);
  const [actionId = "", aimed = "", slot] = parseOption(payload.answer);
  const known = findAction(attacker, actionId, context);
  // One aimed at another creature near the one hit goes for that one, and one on the bearer itself for the bearer.
  const target =
    "self" in known.activation.targeting
      ? attacker
      : actorOf(
          state,
          known.activation.trigger?.near === undefined ? payload.target : aimed,
        );
  const slotLevel =
    slot === undefined
      ? (slotToSpend(known, attacker, deriveStats(attacker, context)) ??
        undefined)
      : Number(slot);
  const found = asHit(
    findAction(attacker, actionId, context, slotLevel),
    findAction(attacker, payload.actionId, context),
  );
  const action = payload.noDamage
    ? {
        ...found,
        activation: {
          ...found.activation,
          resolution: { ...found.activation.resolution, damage: [] },
        },
      }
    : found;
  // A smite's damage is part of the attack, so a Critical Hit doubles its dice too, but not an area's round the target.
  const result = resolveAction(
    action,
    attacker,
    [
      ...aroundHit(action, attacker, target, context),
      ...alsoStruck(known, attacker, target, payload.target, context),
    ],
    context,
    slotLevel,
    payload.critical && !("area" in action.activation.targeting),
    target.position ?? undefined,
  );
  const own = action.activation.selfEffects ?? [];
  // Options that follow this one on the same hit, as Stalker's Flurry's after Dreadful Strike, or Elemental Smite's
  // after the Divine Smite spell.
  const featureId =
    /^feature:(.+):\d+$/.exec(known.id)?.[1] ??
    (known.id.startsWith("spell:")
      ? known.id.slice("spell:".length).replace(/:free$/, "")
      : undefined);
  const follows =
    featureId !== undefined &&
    known.activation.trigger?.following === undefined &&
    deriveStats(attacker, context).actions.some(
      ({ activation }) =>
        activation.trigger?.following?.includes(featureId) === true,
    );
  return {
    events: [
      ...payCosts(action, attacker, context, slotLevel),
      ...(result.events ?? []),
      ...leafEvents(own, action.id, attacker, attacker, context),
      // A move as part of the option, as Mobile Flourish's after the push.
      ...own.flatMap((effect) =>
        effect.kind === "reactionMove"
          ? reactionMove(attacker, context, effect, target)
          : [],
      ),
    ],
    frames: [
      ...(result.frames ?? []),
      ...(follows
        ? [
            frame("afterHit", {
              attacker: attacker.id,
              actionId: payload.actionId,
              target: payload.target,
              critical: payload.critical,
              ...(payload.total === undefined ? {} : { total: payload.total }),
              following: featureId,
            }),
          ]
        : []),
    ],
  };
}

// Another creature an afterHit activation lands on through an `alsoStrikes` passive.
function alsoStruck(
  known: KnownAction,
  attacker: Actor,
  target: Actor,
  hitId: string,
  context: Context,
): readonly Actor[] {
  const [, featureId] = /^feature:(.+):\d+$/.exec(known.id) ?? [];
  const passives = deriveStats(attacker, context).passives.filter(
    (passive) =>
      passive.kind === "alsoStrikes" &&
      passive.feature === featureId &&
      (passive.label === undefined || passive.label === known.activation.label),
  );
  return passives.flatMap((passive): Actor[] => {
    if (passive.kind !== "alsoStrikes") return [];
    if (passive.other === undefined) {
      const hit = actorOf(context.state, hitId);
      return hit.id === target.id || isDown(hit) ? [] : [hit];
    }
    const feet = passive.other;
    const [nearest] = Object.values(context.state.actors)
      .filter(
        (other) =>
          other.id !== target.id &&
          other.side !== attacker.side &&
          !isDown(other) &&
          distanceFeet(attacker.position, other.position) <= feet &&
          fitsType(other, known.activation.targeting, context, attacker),
      )
      .sort(
        (a, b) =>
          distanceFeet(target.position, a.position) -
          distanceFeet(target.position, b.position),
      );
    return nearest ? [nearest] : [];
  });
}
