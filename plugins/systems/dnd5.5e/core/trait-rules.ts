import type { ContentAccess, Dice, SystemEvent } from "#sdk";
import {
  type Ability,
  ClassSchema,
  type DamageType,
  ItemSchema,
} from "./schemas.ts";
import { type Actor, NS, dndEvent, equipped } from "./state.ts";
import { type Stats, evaluateFormula, lookup } from "./stats.ts";
import { HIT_DICE } from "./combat/ids.ts";

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

// Resistance the bearer's damage goes through: the mastered types, and any the bearer always overcomes, as with the
// Boon of Irresistible Offense.
export function piercing<
  T extends { readonly resistances: readonly DamageType[] },
>(responses: T, mastered: readonly DamageType[], stats: Stats): T {
  const ignored = [
    ...mastered,
    ...stats.passives.flatMap((passive) =>
      passive.kind === "overcomeResistance" ? passive.damage : [],
    ),
  ];
  return ignored.length === 0
    ? responses
    : {
        ...responses,
        resistances: responses.resistances.filter(
          (type) => !ignored.includes(type),
        ),
      };
}

// Heavy Armor Master: what an attack's damage of a type is lessened by while the target wears the armor.
export function armoredReduction(
  target: Actor,
  stats: Stats,
  type: DamageType,
  access: ContentAccess,
): number {
  const worn = new Set(
    equipped(target).flatMap((id) => {
      const item = ItemSchema.safeParse(access.content(id)).data;
      return item?.type === "armor" ? [item.armorType] : [];
    }),
  );
  return stats.passives.reduce(
    (total, passive) =>
      passive.kind === "armoredReduction" &&
      worn.has(passive.armor) &&
      passive.damage.includes(type)
        ? total + evaluateFormula(passive.amount, stats)
        : total,
    0,
  );
}

// Sharpshooter, Spell Sniper and Crossbow Expert: whether a ranged attack ignores an enemy beside the attacker, and
// whether it ignores Half and Three-Quarters Cover.
export function steadyShot(
  stats: Stats,
  actionId: string,
  attack: "weapon" | "spell",
): { readonly inMelee: boolean; readonly bypassCover: boolean } {
  const fits = stats.passives.flatMap((passive) =>
    passive.kind === "firingInMelee" &&
    passive.attack === attack &&
    (!passive.crossbows || actionId.includes("crossbow"))
      ? [passive]
      : [],
  );
  return {
    inMelee: fits.length > 0,
    bypassCover: fits.some((passive) => passive.bypassCover),
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

// Mage Slayer's Guarded Mind: a failed save with one of its abilities succeeds instead, spending the resource.
// `pending` holds the events not yet applied, so two saves in one step can't spend the same use.
export function rescuedSave(
  target: Actor,
  ability: Ability,
  stats: Stats,
  pending: readonly SystemEvent[],
): SystemEvent | null {
  for (const passive of stats.passives) {
    if (passive.kind !== "saveRescue" || !passive.abilities.includes(ability)) {
      continue;
    }
    const { resource } = passive;
    const spent =
      (target.resourcesSpent[resource] ?? 0) +
      pending.filter(
        (event) =>
          event.kind === `${NS}:resourceSpent` &&
          "payload" in event &&
          event.payload.actor === target.id &&
          event.payload.resource === resource,
      ).length;
    if (spent < (stats.resources[resource] ?? 0)) {
      return dndEvent(`${NS}:resourceSpent`, { actor: target.id, resource });
    }
  }
  return null;
}

// The die a character's next unspent Hit Point Die is, in level order as resting spends them, or null for none.
export function nextHitDie(actor: Actor, access: ContentAccess): string | null {
  if (actor.source.kind !== "character") return null;
  const entry = actor.source.build?.levels[actor.resourcesSpent[HIT_DICE] ?? 0];
  return entry ? lookup(access, ClassSchema, entry.classId).hitDie : null;
}
