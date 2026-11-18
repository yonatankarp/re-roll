import {
  deriveStats,
  evaluateFormula,
  onList,
  rollAmount,
  rollDiceNotation,
  type Stats,
  maybeLookup,
} from "../../stats.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../../state.ts";
import { type Dice, type SystemEvent } from "#sdk";
import {
  type Amount,
  type Formula,
  type LeafEffect,
  SpellSchema,
} from "../../schemas.ts";
import { castFrom } from "../ids.ts";
import { distanceFeet } from "../../grid.ts";
import { allies, type Context } from "../queries.ts";

// Healing: shared, from a pool, empowered, boosted by a caster's passives, and stopped.

// Boon of Bountiful Health's Augmented Health.
export function tempHpBonus(stats: Stats): number {
  return stats.passives.reduce(
    (sum, passive) =>
      passive.kind === "tempHpBonus" ? sum + passive.amount : sum,
    0,
  );
}

// Healing shared among the targets, as Mass Heal: rolled once, then given out to the most hurt first, each as much
// as it can take, so each target's own heal is its share.
export function sharedHealing(
  effects: readonly LeafEffect[],
  targets: readonly Actor[],
  caster: Actor,
  context: Context,
): (target: Actor) => readonly LeafEffect[] {
  // shortcut: Temporary Hit Points to divide go evenly, as the caster may share them out any way.
  const split = effects.find(
    (effect) => effect.kind === "tempHp" && effect.divided,
  );
  if (split?.kind === "tempHp") {
    const each = Math.floor(
      rollAmount(split.amount, deriveStats(caster, context), context.dice) /
        Math.max(1, targets.length),
    );
    return () =>
      effects.map((effect) =>
        effect === split
          ? {
              kind: "tempHp" as const,
              amount: { bonus: { base: each, add: [] } },
            }
          : effect,
      );
  }
  const divided = effects.find(
    (effect) => effect.kind === "heal" && effect.divided,
  );
  if (divided?.kind !== "heal") return () => effects;
  const room = (target: Actor): number => {
    const max = deriveStats(target, context).maxHp;
    return Math.max(
      0,
      (divided.half ? Math.floor(max / 2) : max) - Math.max(target.hp, 0),
    );
  };
  let left = rollAmount(
    divided.amount,
    deriveStats(caster, context),
    context.dice,
  );
  const shares = new Map<string, number>();
  for (const target of [...targets].sort((a, b) => room(b) - room(a))) {
    const share = Math.min(left, room(target));
    shares.set(target.id, share);
    left -= share;
  }
  // No share, no heal, so a dying creature's death saves stand.
  return (target) =>
    effects.flatMap((effect) => {
      if (effect !== divided) return [effect];
      const share = shares.get(target.id) ?? 0;
      return share > 0
        ? [
            {
              kind: "heal" as const,
              amount: { bonus: { base: share, add: [] } },
            },
          ]
        : [];
    });
}

export const FORTIFIED = "fortified-health";

const MEAN: Dice = { below: () => 0, roll: (sides) => (sides + 1) / 2 };

// A healing pool spends one of its resource for each `amount` it heals: as many as fill `room`, never more than
// are left or than `most` allows, as Lay On Hands' Hit Points or Healing Light's dice.
export function poolHealing(
  pool: { readonly resource: string; readonly most?: Formula | undefined },
  amount: Amount,
  room: number,
  caster: Actor,
  stats: Stats,
  dice: Dice,
): { resource: string; spent: number; healed: number } {
  const left =
    (stats.resources[pool.resource] ?? 0) -
    (caster.resourcesSpent[pool.resource] ?? 0);
  const each = Math.max(1, rollAmount(amount, stats, MEAN));
  const spent = Math.max(
    0,
    Math.min(
      left,
      pool.most ? Math.max(1, evaluateFormula(pool.most, stats)) : left,
      Math.ceil(room / each),
    ),
  );
  let healed = 0;
  for (let index = 0; index < spent; index += 1) {
    healed += rollAmount(amount, stats, dice);
  }
  return { resource: pool.resource, spent, healed };
}

// A spell stopped, by Dispel Magic or a counter: a use of each `stopRegain` resource back.
export function stopRegains(caster: Actor, stats: Stats): SystemEvent[] {
  return stats.passives.flatMap((passive) =>
    passive.kind === "stopRegain" &&
    (caster.resourcesSpent[passive.resource] ?? 0) > 0
      ? [
          dndEvent(`${NS}:resourceRestored`, {
            actor: caster.id,
            resource: passive.resource,
            amount: 1,
          }),
        ]
      : [],
  );
}

// Empowered Healing: the caster or an ally within 5 feet of it whose `empoweredHealing` use is left this turn spends
// it, and its resource, for the healing dice to be rolled again when low.
export function empowerer(
  caster: Actor,
  context: Context,
): { readonly events: SystemEvent[] } | null {
  for (const bearer of [caster, ...allies(context.state, caster)]) {
    if (
      bearer.id !== caster.id &&
      distanceFeet(bearer.position, caster.position) > 5
    ) {
      continue;
    }
    if (bearer.usedThisTurn.includes(EMPOWERED_HEALING)) continue;
    if (hasCondition(bearer, ...INCAPACITATING) || isDown(bearer)) continue;
    const own = deriveStats(bearer, context);
    const passive = own.passives.find(
      (item) => item.kind === "empoweredHealing",
    );
    if (passive?.kind !== "empoweredHealing") continue;
    if (
      (bearer.resourcesSpent[passive.resource] ?? 0) >=
      (own.resources[passive.resource] ?? 0)
    ) {
      continue;
    }
    return {
      events: [
        dndEvent(`${NS}:resourceSpent`, {
          actor: bearer.id,
          resource: passive.resource,
        }),
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: bearer.id,
          key: EMPOWERED_HEALING,
        }),
      ],
    };
  }
  return null;
}

const EMPOWERED_HEALING = "empoweredHealing";

// What a caster's `spellHealing` passives add to the healing of a spell, cast with a slot of this level unless it's a
// free cast or one from an item.
export function spellHealing(
  spell: string,
  sourceId: string,
  stats: Stats,
  context: Context,
  slotLevel: number | undefined,
): number {
  const slotted =
    slotLevel !== undefined &&
    !/:free(:|$)/.test(sourceId) &&
    castFrom(sourceId) === null;
  const known = maybeLookup(context, SpellSchema, spell);
  return stats.passives.reduce(
    (sum, passive) =>
      passive.kind === "spellHealing" &&
      (!passive.slot || slotted) &&
      (!passive.list || onList(spell, known, passive.list, context))
        ? sum +
          evaluateFormula(passive.bonus, stats) +
          (passive.dice ? rollDiceNotation(passive.dice, context.dice) : 0) +
          (passive.perSlot && slotted ? slotLevel : 0)
        : sum,
    0,
  );
}
