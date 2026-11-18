import { z } from "zod";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../../state.ts";
import { distanceFeet } from "../../grid.ts";
import { type Dice, type SystemEvent } from "#sdk";
import { reactionCosts } from "../reactions.ts";
import {
  damageResponses,
  deriveStats,
  passiveModifiers,
  rollAmount,
  type Stats,
} from "../../stats.ts";
import { halved } from "../../rules.ts";
import { type DamageType, type Resolution } from "../../schemas.ts";
import { canAfford, type Context } from "../queries.ts";
import { typeAgainst } from "../effects.ts";
import { HitSchema } from "./payloads.ts";

// Dice less this many, as Sneak Attack's 5d6 less 1d6 for Cunning Strike's Poison.
export function fewerDice(
  notation: string | undefined,
  less: number,
): string | undefined {
  const [count = "0", sides = "0"] = (notation ?? "").split("d");
  const left = Number(count) - less;
  return notation && left > 0 ? `${String(left)}d${sides}` : undefined;
}

// Pole Strike hits with the weapon's other end, whose damage die is a d4 of Bludgeoning.
export function poleEnd(
  resolution: Extract<Resolution, { kind: "attack" }>,
): Extract<Resolution, { kind: "attack" }> {
  return {
    ...resolution,
    damage: resolution.damage.map((item, index) =>
      index === 0
        ? { amount: { ...item.amount, dice: "1d4" }, type: "bludgeoning" }
        : item,
    ),
  };
}

// The type of these the target takes most damage from.
export function leastResisted(
  types: readonly DamageType[],
  responses: ReturnType<typeof damageResponses>,
): DamageType {
  const taken = (type: DamageType): number =>
    responses.immunities.includes(type)
      ? 0
      : responses.resistances.includes(type)
        ? 0.5
        : responses.vulnerabilities.includes(type)
          ? 2
          : 1;
  return (
    [...types].sort((a, b) => taken(b) - taken(a))[0] ?? types[0] ?? "force"
  );
}

// A Brooch of the Elements' Reaction: a creature that can answer a hit turns its first damage into the type that
// serves its own side best, the type the target resists least when the attacker is its ally, and most otherwise.
// shortcut: it's taken without asking whenever it changes something, by the first bearer that can.
export function retypedHit(
  attacker: Actor,
  target: Actor,
  resolution: Extract<Resolution, { kind: "attack" }>,
  context: Context,
): {
  readonly resolution: Extract<Resolution, { kind: "attack" }>;
  readonly events: SystemEvent[];
} {
  const unchanged = { resolution, events: [] };
  const [first, ...rest] = resolution.damage;
  if (!first) return unchanged;
  const responses = damageResponses(target, context);
  const taken = (type: DamageType): number =>
    responses.immunities.includes(type)
      ? 0
      : responses.resistances.includes(type)
        ? 0.5
        : responses.vulnerabilities.includes(type)
          ? 2
          : 1;
  for (const bearer of Object.values(context.state.actors)) {
    if (
      !bearer.budget.reaction ||
      isDown(bearer) ||
      hasCondition(bearer, ...INCAPACITATING)
    ) {
      continue;
    }
    const stats = deriveStats(bearer, context);
    const action = stats.actions.find(
      (item) =>
        item.activation.trigger?.hitDamages === true &&
        canAfford(item, bearer, stats) &&
        distanceFeet(bearer.position, attacker.position) <=
          (item.activation.trigger.within ?? 60),
    );
    const { resolution: own } = action?.activation ?? {};
    const effect =
      own?.kind === "automatic"
        ? own.effects.find((item) => item.kind === "retypeHit")
        : undefined;
    if (!action || effect?.kind !== "retypeHit") continue;
    const helps = bearer.side === attacker.side ? 1 : -1;
    const best = [...effect.types].sort(
      (a, b) => helps * (taken(b) - taken(a)),
    )[0];
    if (!best || helps * (taken(best) - taken(first.type)) <= 0) continue;
    return {
      resolution: {
        ...resolution,
        damage: [{ ...first, type: best }, ...rest],
      },
      events: reactionCosts(bearer, action, context),
    };
  }
  return unchanged;
}

// Damage added to the bearer's next attack only, as Deadly Aim's, is spent by that attack, hit or miss, as is
// True Strike's change to it.
export function onceHitEnded(attacker: Actor): SystemEvent[] {
  return attacker.activeEffects.flatMap(({ modifier, sourceId }) =>
    ((modifier.kind === "hitDamage" && modifier.dealtBy === "bearer") ||
      modifier.kind === "weaponSpell" ||
      modifier.kind === "damageBonus") &&
    modifier.once
      ? [dndEvent(`${NS}:effectEnded`, { actor: attacker.id, sourceId })]
      : [],
  );
}

// Crusher's and Slasher's effects on a creature hit by an attack dealing their damage type.
// shortcut: a reaction lessens the damage after Resistance rather than before it, which only matters to rounding.
export function lessenHits<T extends { readonly amount: number }>(
  hits: readonly T[],
  { halve, reduceBy = 0 }: z.infer<typeof HitSchema>,
): T[] {
  let left = reduceBy;
  return hits.map((item) => {
    if (item.amount < 0) return item; // absorbed: it heals, and nothing lessens that
    const amount = halve ? halved(item.amount) : item.amount;
    const after = Math.max(0, amount - left);
    left -= amount - after;
    return { ...item, amount: after };
  });
}

// Whether the hit's first damage needs its dice's faces: for a type they pick, or numbers that match for a leap.
export const needsFaces = (
  resolution: Extract<Resolution, { kind: "attack" }>,
) =>
  resolution.leap !== undefined ||
  resolution.damage[0]?.rolledTypes !== undefined;

// Dice that note each face they roll.
export const recorded = (dice: Dice, faces: number[]): Dice => ({
  below: (count) => dice.below(count),
  roll: (sides) => {
    const face = dice.roll(sides);
    faces.push(face);
    return face;
  },
});

// Chaos Bolt: the type one of the dice picks, by its face, the one the target resists least.
export function rolledType(
  types: readonly DamageType[] | undefined,
  faces: readonly number[],
  responses: ReturnType<typeof damageResponses>,
): DamageType | undefined {
  if (!types || faces.length === 0) return undefined;
  const picks = [
    ...new Set(faces.map((face) => types[(face - 1) % types.length])),
  ].flatMap((type) => (type ? [type] : []));
  return picks.length > 1 ? typeAgainst(picks, responses) : picks[0];
}

// Flat damage added to a weapon's own roll, such as Rage.
export function damageBonus(
  attacker: Actor,
  resolution: Extract<Resolution, { kind: "attack" }>,
  stats: Stats,
  context: Context,
): number {
  if (resolution.attack.type !== "weapon") return 0;
  const seen = new Set<string>();
  return [
    ...attacker.activeEffects.flatMap(({ modifier, sourceId }) => {
      if (seen.has(sourceId)) return [];
      if (modifier.kind === "damageBonus") seen.add(sourceId);
      return [modifier];
    }),
    ...passiveModifiers(stats.passives),
  ].reduce(
    (total, modifier) =>
      modifier.kind === "damageBonus" &&
      (!modifier.ability || modifier.ability === resolution.attack.ability)
        ? total +
          (modifier.subtract ? -1 : 1) *
            rollAmount(modifier.amount, stats, context.dice)
        : total,
    0,
  );
}
