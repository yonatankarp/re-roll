import type { ContentAccess, Dice, SystemEvent } from "#sdk";
import { type Ability, type DamageType, ItemSchema } from "./schemas.ts";
import { type Actor, NS, dndEvent } from "./state.ts";
import { type Stats, lookup } from "./stats.ts";

// Species traits and feats that change rolls combat makes, kept out of combat.ts behind one call each.

// Advantage on a save from a trait, such as Gnomish Cunning, or Brave against a save that would frighten.
export function traitSaveAdvantage(
  stats: Stats,
  ability: Ability,
  conditions: readonly string[],
): boolean {
  // A save to keep Concentration names "concentration" among its conditions.
  return stats.passives.some(
    (passive) =>
      (passive.kind === "saveAdvantage" &&
        (passive.abilities.includes(ability) ||
          passive.conditions.some((condition) =>
            conditions.includes(condition),
          ))) ||
      (passive.kind === "concentrationAdvantage" &&
        conditions.includes("concentration")),
  );
}

// Great Weapon Fighting: damage dice of a Two-Handed melee weapon attack never count below 3.
// shortcut: a Versatile weapon held in two hands doesn't count, since the hands used aren't tracked.
export function weaponDamageDice(
  dice: Dice,
  actionId: string,
  stats: Stats,
  access: ContentAccess,
): Dice {
  if (!stats.passives.some(({ kind }) => kind === "greatWeaponFighting")) {
    return dice;
  }
  const itemId = actionId.startsWith("weapon:") ? actionId.slice(7) : "";
  const item =
    itemId && access.content(itemId)
      ? lookup(access, ItemSchema, itemId)
      : null;
  const twoHanded =
    item?.type === "weapon" &&
    item.properties.includes("twoHanded") &&
    !item.properties.includes("ammunition") &&
    !item.properties.includes("thrown");
  return twoHanded
    ? {
        below: (count) => dice.below(count),
        roll: (sides) => Math.max(3, dice.roll(sides)),
      }
    : dice;
}

// Elemental Adept: the damage types a spell of the bearer's ignores Resistance to.
export function masteredTypes(
  stats: Stats,
  spell: boolean,
): readonly DamageType[] {
  return spell
    ? stats.passives.flatMap((passive) =>
        passive.kind === "energyMastery" ? [passive.damage] : [],
      )
    : [];
}

// Resistance the mastered types go through.
export function piercing<
  T extends { readonly resistances: readonly DamageType[] },
>(responses: T, mastered: readonly DamageType[]): T {
  return mastered.length === 0
    ? responses
    : {
        ...responses,
        resistances: responses.resistances.filter(
          (type) => !mastered.includes(type),
        ),
      };
}

// A 1 on a damage die of a mastered type counts as a 2.
export function masteredDice(
  dice: Dice,
  type: DamageType,
  mastered: readonly DamageType[],
): Dice {
  return mastered.includes(type)
    ? {
        below: (count) => dice.below(count),
        roll: (sides) => Math.max(2, dice.roll(sides)),
      }
    : dice;
}

// The conditions a repeated save would end, so that a trait such as Fey Ancestry gives its Advantage there as well.
export function repeatSaveConditions(actor: Actor, sourceId: string): string[] {
  return actor.activeEffects.flatMap((effect) =>
    effect.sourceId === sourceId && effect.modifier.kind === "condition"
      ? [effect.modifier.condition]
      : [],
  );
}

// Relentless Endurance: a hit that would drop the target to 0 Hit Points, without killing it outright, leaves it
// at 1 instead and spends the trait's use. Null when it doesn't apply.
export function dropToOneEvents(
  target: Actor,
  amount: number,
  remaining: number,
  hit: { readonly type: DamageType; readonly critical: boolean },
  stats: Stats,
): SystemEvent[] | null {
  const outright = target.side === "party" && remaining >= stats.maxHp;
  if (target.hp <= 0 || remaining < 0 || outright) return null;
  const trait = stats.passives.find(
    (passive) =>
      passive.kind === "dropToOne" &&
      (target.resourcesSpent[passive.resource] ?? 0) <
        (stats.resources[passive.resource] ?? 0),
  );
  if (trait?.kind !== "dropToOne") return null;
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: target.id,
      resource: trait.resource,
    }),
    dndEvent(`${NS}:damaged`, {
      actor: target.id,
      amount: amount - remaining - 1,
      ...hit,
      massive: false,
    }),
  ];
}
