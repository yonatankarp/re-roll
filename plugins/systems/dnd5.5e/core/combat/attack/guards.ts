import { z } from "zod";
import {
  type Actor,
  dndEvent,
  hasCondition,
  equipped,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import { distanceFeet } from "../../grid.ts";
import { seeing } from "../../sight.ts";
import { type Frame, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { playerTakes } from "../reactions.ts";
import {
  deriveStats,
  type KnownAction,
  evaluateFormula,
  rollAmount,
  rollDiceNotation,
  type Stats,
} from "../../stats.ts";
import { type Formula, ItemSchema, type LeafEffect } from "../../schemas.ts";
import {
  actorOf,
  allies,
  canAfford,
  type Context,
  sizeOf,
  within5,
} from "../queries.ts";
import { leafEvents, payCosts } from "../effects.ts";
import { attackKind } from "./attack-kind.ts";
import { HitSchema } from "./payloads.ts";

// A reaction's AC bonus against a hit: a number, or a formula of the reactor's.
// An AC bonus against one hit: its number or formula, and its die, at its highest unless rolled with `dice`.
export function acBonusOf(
  effect: {
    readonly bonus: number | Formula;
    readonly dice?: string | undefined;
  },
  stats: Stats,
  dice?: Context["dice"],
): number {
  const { bonus } = effect;
  const flat =
    typeof bonus === "number" ? bonus : evaluateFormula(bonus, stats);
  const die = effect.dice
    ? dice
      ? rollDiceNotation(effect.dice, dice)
      : Number(effect.dice.split("d")[0]) * Number(effect.dice.split("d")[1])
    : 0;
  return flat + die;
}

// A creature of this kind beside the bearer, as the podling Transfer Harm needs.
export function kinNear(
  bearer: Actor,
  near: { readonly monster: string; readonly within: number },
  context: Context,
): Actor | null {
  return (
    Object.values(context.state.actors).find(
      (item) =>
        item.id !== bearer.id &&
        !isDown(item) &&
        item.source.kind === "monster" &&
        item.source.statBlockId === near.monster &&
        distanceFeet(item.position, bearer.position) <= near.within,
    ) ?? null
  );
}

// Whether the bearer holds what a reaction needs, such as a Shield for Protection.
export function holds(
  actor: Actor,
  holding: "shield" | "shieldOrWeapon" | "polearm" | "finesse" | undefined,
  context: Context,
): boolean {
  return (
    holding === undefined ||
    equipped(actor).some((id) => {
      const item = ItemSchema.safeParse(context.content(id)).data;
      if (holding === "finesse") {
        return (
          item?.type === "weapon" &&
          "properties" in item &&
          item.properties.includes("finesse")
        );
      }
      return (
        item?.type === "shield" ||
        (holding !== "shield" && item?.type === "weapon")
      );
    })
  );
}

// An ally's reaction for a target within 5 feet: Protection before the roll, Interception after a hit. A companion
// takes it as soon as it can; the player is asked.
export function guardFor(
  target: Actor,
  attacker: Actor,
  when: "allyAttacked" | "allyHit",
  context: Context,
  // A ranged attack sets off a guard that only answers those, and `draw` looks for one that takes the attack on
  // itself, as an Arrow-Catching Shield, instead of one that protects, as Protection.
  how: { readonly ranged?: boolean; readonly draw?: boolean } = {},
): { readonly guard: Actor; readonly action: KnownAction } | null {
  const { state } = context;
  for (const guard of allies(state, target)) {
    if (
      guard.id === target.id ||
      !guard.budget.reaction ||
      isDown(guard) ||
      hasCondition(guard, ...INCAPACITATING) ||
      seeing(guard, attacker.position, state, context) === "none"
    ) {
      continue;
    }
    const stats = deriveStats(guard, context);
    const action = stats.actions.find(
      (item) =>
        item.activation.trigger?.[when] &&
        (!item.activation.trigger.ranged || how.ranged === true) &&
        draws(item) === (how.draw === true) &&
        distanceFeet(guard.position, target.position) <=
          (item.activation.trigger.within ?? 5) &&
        holds(guard, item.activation.trigger.holding, context) &&
        // Sentinel at Death's Door: only for a Bloodied creature.
        (!item.activation.trigger.bloodied ||
          target.hp * 2 <= deriveStats(target, context).maxHp) &&
        canAfford(item, guard, stats),
    );
    if (
      action &&
      (guard.id !== PLAYER_ACTOR ||
        playerTakes(
          `${when}:${target.id}`,
          `${attacker.name} ${when === "allyHit" ? "hits" : "attacks"} ${target.name}. Use ${action.name}?`,
          action,
          context,
        ))
    ) {
      return { guard, action };
    }
  }
  return null;
}

// What taking a guard's reaction costs, named so the log says which reaction it was.
export function guardCosts(
  guard: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  return payCosts(action, guard, context).map((event) =>
    event.kind === `${NS}:budgetSpent`
      ? dndEvent(`${NS}:budgetSpent`, {
          actor: guard.id,
          kind: "reaction",
          label: action.name,
        })
      : event,
  );
}

// Redirect Attack: a target that sees the attack coming trades places with a Small or Medium ally next to it, who
// becomes the target instead.
export function redirect(
  attacker: Actor,
  target: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly ally: string } | null {
  const { state } = context;
  if (
    !target.budget.reaction ||
    isDown(target) ||
    hasCondition(target, ...INCAPACITATING) ||
    !target.position ||
    seeing(target, attacker.position, state, context) === "none"
  ) {
    return null;
  }
  const stats = deriveStats(target, context);
  const action = stats.actions.find(
    (item) =>
      item.activation.trigger?.attacked &&
      redirects(item) &&
      canAfford(item, target, stats),
  );
  if (!action) return null;
  const effects =
    action.activation.resolution.kind === "automatic"
      ? action.activation.resolution.effects
      : [];
  // Misdirection: a creature beside the bearer that stands between it and the attacker takes the attack.
  if (effects.some((effect) => effect.kind === "redirect" && effect.cover)) {
    const shield = Object.values(state.actors).find(
      (item) =>
        item.id !== target.id &&
        item.id !== attacker.id &&
        !isDown(item) &&
        !isDead(item) &&
        within5(item, target) &&
        distanceFeet(attacker.position, item.position) <
          distanceFeet(attacker.position, target.position),
    );
    return shield
      ? { ally: shield.id, events: guardCosts(target, action, context) }
      : null;
  }
  const charmed = effects.some(
    (effect) => effect.kind === "redirect" && effect.charmed,
  );
  const pool = charmed
    ? Object.values(state.actors).filter((item) =>
        hasCondition(item, "charmed"),
      )
    : allies(state, target);
  const ally = pool.find((item) => {
    const size = sizeOf(item, context);
    return (
      item.id !== target.id &&
      item.id !== attacker.id &&
      !isDown(item) &&
      !hasCondition(item, ...INCAPACITATING) &&
      within5(item, target) &&
      size >= 1 &&
      size <= 2
    );
  });
  if (!ally?.position) return null;
  return {
    ally: ally.id,
    events: [
      ...guardCosts(target, action, context),
      dndEvent(`${NS}:moved`, {
        actor: target.id,
        to: ally.position,
        feet: 0,
      }),
      dndEvent(`${NS}:moved`, {
        actor: ally.id,
        to: target.position,
        feet: 0,
      }),
    ],
  };
}

const draws = (action: KnownAction): boolean => {
  const { resolution } = action.activation;
  return (
    resolution.kind === "automatic" &&
    resolution.effects.some((effect) => effect.kind === "drawAttack")
  );
};

export const redirects = (action: KnownAction): boolean => {
  const { resolution } = action.activation;
  return (
    resolution.kind === "automatic" &&
    resolution.effects.some((effect) => effect.kind === "redirect")
  );
};

// An ally's reaction to a hit on someone near it: Interception lessens the hit by what it rolls, and a shield
// guardian's Protection or Spontaneous Barrier adds to the target's AC, which may turn it into a miss.
export function intercepted(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const { state, dice } = context;
  const target = actorOf(state, hit.target);
  const found = guardFor(
    target,
    actorOf(state, hit.attacker),
    "allyHit",
    context,
    { ranged: attackKind(hit, context).ranged },
  );
  if (!found) return { events: [], frames: [frame("applyHit", hit)] };
  const { guard, action } = found;
  const { resolution } = action.activation;
  const stats = deriveStats(guard, context);
  const effects = resolution.kind === "automatic" ? resolution.effects : [];
  const reduceBy = effects.reduce(
    (sum, effect) =>
      effect.kind === "reduceDamage" && effect.amount
        ? sum + rollAmount(effect.amount, stats, dice)
        : sum,
    0,
  );
  const acBonus = effects.reduce(
    (sum, effect) =>
      effect.kind === "acAgainstHit"
        ? sum + acBonusOf(effect, stats, dice)
        : sum,
    0,
  );
  // A lasting AC bonus goes on the target, and the hit is checked again once it's there.
  const raised = effects.some(
    (effect) =>
      effect.kind === "modifier" &&
      effect.modifier.kind === "bonus" &&
      effect.modifier.to === "ac",
  );
  const strike = effects.find((effect) => effect.kind === "strike");
  const lessened = {
    ...hit,
    ...(strike?.kind === "strike"
      ? { riposte: strike.action ?? "", riposter: guard.id }
      : {}),
    ...(effects.some((effect) => effect.kind === "noCritical")
      ? { critical: false }
      : {}),
    ...(reduceBy > 0 ? { reduceBy: (hit.reduceBy ?? 0) + reduceBy } : {}),
    ...(acBonus > 0 ? { acBonus: (hit.acBonus ?? 0) + acBonus } : {}),
    ...(effects.some((effect) => effect.kind === "reduceDamage" && effect.halve)
      ? { halve: true }
      : {}),
  };
  return {
    events: [
      ...guardCosts(guard, action, context),
      ...(raised ? leafEvents(effects, action.id, guard, target, context) : []),
    ],
    frames: [
      frame(acBonus > 0 || raised ? "recheckHit" : "applyHit", lessened),
    ],
  };
}

export function transferTo(
  lessened: readonly Extract<LeafEffect, { kind: "reduceDamage" }>[],
  target: Actor,
  context: Context,
): { transfer?: string } {
  const near = lessened.find((effect) => effect.toNear)?.toNear;
  const kin = near ? kinNear(target, near, context) : null;
  return kin ? { transfer: kin.id } : {};
}
