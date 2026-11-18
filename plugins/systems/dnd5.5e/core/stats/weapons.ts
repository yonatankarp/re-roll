// Weapon attacks: proficiency, forms, ammunition, throwing and the Unarmed Strike.
import type { ContentAccess } from "#sdk";
import { type Actor, equipped } from "../state.ts";
import {
  type Item,
  type Ability,
  type AbilityScores,
  type Activation,
  type LeafEffect,
  ItemSchema,
  type Passive,
  type Resolution,
  type ClassDef,
  WeaponSchema,
  type Weapon,
  type WeaponChange,
} from "../schemas.ts";
import { WEAPON_PREFIX, itemUseOf, weaponItemId } from "../combat/ids.ts";
import type { KnownAction } from "./model.ts";
import { abilityModifier } from "./abilities.ts";

// An attack with `emptyHanded` dice rolls them while the bearer holds no weapon or Shield, as Unarmed Fighting's d8.
export function emptyHanded(
  actions: readonly KnownAction[],
  actor: Actor,
  access: ContentAccess,
): KnownAction[] {
  const holding = equipped(actor).some((id) => {
    const item = ItemSchema.safeParse(access.content(id)).data;
    return item?.type === "weapon" || item?.type === "shield";
  });
  return actions.map((action) => {
    const dice = action.activation.emptyHanded;
    const { resolution } = action.activation;
    const [first, ...rest] = resolution.damage;
    if (!dice || holding || !first) return action;
    return {
      ...action,
      activation: {
        ...action.activation,
        resolution: {
          ...resolution,
          damage: [{ ...first, amount: { ...first.amount, dice } }, ...rest],
        },
      },
    };
  });
}

// Whether a Martial Training passive covers this weapon: ranged ones have Ammunition, as a weapon attack reads them.
export function trainedWith(
  passive: Extract<Passive, { kind: "martialTraining" }>,
  weapon: Weapon,
): boolean {
  const ranged = weapon.properties.includes("ammunition");
  return (
    (!passive.ranged || ranged) &&
    (!passive.melee || !ranged) &&
    !passive.without?.some((property) => weapon.properties.includes(property))
  );
}

export function weaponProficient(classDef: ClassDef, weapon: Weapon): boolean {
  if (!classDef.weapons.includes(weapon.category)) return false;
  const limit = classDef.martialWeaponProperties;
  return (
    weapon.category !== "martial" ||
    !limit ||
    weapon.properties.some((property) => limit.includes(property))
  );
}

// The weapon, or one of the forms it changes into, whose damage die is biggest, attacked with as a Finesse weapon.
export function bestForm(
  weapon: Weapon,
  forms: readonly string[],
  access: ContentAccess,
): Weapon {
  const average = (item: Weapon): number => {
    const [count = 1, sides = 0] = (item.damage.dice ?? "0d0")
      .split("d")
      .map(Number);
    return (item.damage.flat ?? 0) + (count * (sides + 1)) / 2;
  };
  const shaped = forms
    .map((slug) =>
      access
        .contentIds()
        .filter((id) => id.endsWith(`:item/${slug}`))
        .map((id) => WeaponSchema.safeParse(access.content(id)).data)
        .find((item) => item !== undefined),
    )
    .filter((item): item is Weapon => item !== undefined);
  const best = [weapon, ...shaped].reduce((most, item) =>
    average(item) > average(most) ? item : most,
  );
  const properties = best.properties.includes("finesse")
    ? best.properties
    : [...best.properties, "finesse" as const];
  return { ...weapon, damage: best.damage, properties };
}

// The range a weapon is thrown to while its own activation's `thrownWeapon` lasts, as a Martialist's Quarterstaff's.
export function imbuedRange(
  actor: Actor,
  itemId: string,
): { readonly normal: number; readonly long: number } | undefined {
  for (const { modifier, sourceId } of actor.activeEffects) {
    if (modifier.kind === "thrownWeapon" && itemUseOf(sourceId) === itemId) {
      return { normal: modifier.normal, long: modifier.long };
    }
  }
  return undefined;
}

// The magic ammunition carried with the biggest bonus to attack rolls, as +3 Ammunition over +1.
export function bestAmmunition(
  worn: readonly (readonly [string, Item])[],
  works: (itemId: string, item: Item) => boolean,
):
  | {
      readonly id: string;
      readonly name: string;
      readonly attack: number;
      readonly damage: number;
      readonly item: Item;
    }
  | undefined {
  const bonus = (item: Item, to: string): number =>
    (item.type === "magicItem"
      ? (item.bonuses ?? item.variants?.[0]?.bonuses ?? [])
      : []
    )
      .filter((entry) => entry.to === to)
      .reduce((total, entry) => total + entry.amount, 0);
  return worn
    .filter(
      ([itemId, item]) =>
        item.type === "magicItem" && item.ammunition && works(itemId, item),
    )
    .map(([id, item]) => ({
      id,
      name: item.name,
      attack: bonus(item, "attack"),
      damage: bonus(item, "damage"),
      item,
    }))
    .sort((a, b) => b.attack - a.attack)[0];
}

// A weapon firing a piece of magic ammunition takes its riders on the hit, as Walloping Ammunition's save: damage of
// no type of its own is the weapon's.
export function firing(weapon: Weapon, ammunition: Item | undefined): Weapon {
  if (ammunition?.type !== "magicItem") return weapon;
  const { hitDamage, hitSave, hitEffects } = ammunition;
  const typed = (hitDamage ?? []).map(({ type, weaponDie: _die, ...rest }) => ({
    ...rest,
    type: type ?? weapon.damage.type,
  }));
  return {
    ...weapon,
    ...(typed.length > 0
      ? { hitDamage: [...(weapon.hitDamage ?? []), ...typed] }
      : {}),
    ...(hitSave && !weapon.hitSave ? { hitSave } : {}),
    ...(hitEffects
      ? { hitEffects: [...(weapon.hitEffects ?? []), ...hitEffects] }
      : {}),
  };
}

// The Unarmed Strike every character can make: a Strength attack it's proficient with, dealing 1 plus its
// Strength modifier in Bludgeoning damage. Its Grapple and Shove are actions of their own (actions.ts).
export const UNARMED_STRIKE = "unarmed-strike";

export function unarmedStrike(abilities: AbilityScores): KnownAction {
  const activation = weaponActivation(
    {
      id: UNARMED_STRIKE,
      name: "Unarmed Strike",
      type: "weapon",
      category: "simple",
      damage: { flat: 1, type: "bludgeoning" },
      properties: [],
      mastery: "nick",
    },
    abilities,
  );
  const { resolution } = activation;
  return {
    id: UNARMED_STRIKE,
    name: "Unarmed Strike",
    activation:
      resolution.kind === "attack"
        ? {
            ...activation,
            resolution: {
              ...resolution,
              attack: { ...resolution.attack, unarmed: true },
            },
          }
        : activation,
    spellLevel: null,
  };
}

// An Unarmed Strike with what items add to its attack and damage rolls, as Wraps of Unarmed Power's +1.
export function withUnarmedBonus(
  action: KnownAction,
  attack: number,
  damage: number,
): KnownAction {
  const { resolution } = action.activation;
  if (
    (attack === 0 && damage === 0) ||
    resolution.kind !== "attack" ||
    !resolution.attack.unarmed
  ) {
    return action;
  }
  const [first, ...rest] = resolution.damage;
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution: {
        ...resolution,
        attack: {
          ...resolution.attack,
          ...(attack > 0
            ? { itemBonus: (resolution.attack.itemBonus ?? 0) + attack }
            : {}),
        },
        damage: first
          ? [
              {
                ...first,
                amount: {
                  ...first.amount,
                  bonus: {
                    base: (first.amount.bonus?.base ?? 0) + damage,
                    add: first.amount.bonus?.add ?? [],
                  },
                },
              },
              ...rest,
            ]
          : resolution.damage,
      },
    },
  };
}

export function weaponActivation(
  weapon: Weapon,
  abilities: AbilityScores,
  proficient = true,
  damageBonus = 0,
  itemBonus = 0,
  classIds: readonly string[] = [], // the wielder's classes, for a weapon's `classAbility`
): Activation {
  const ranged = weapon.properties.includes("ammunition");
  const finesse = weapon.properties.includes("finesse");
  const ability: Ability =
    ranged ||
    (finesse && abilityModifier(abilities.dex) > abilityModifier(abilities.str))
      ? "dex"
      : "str";
  // A Lute of Thunderous Thumping's Bard swings it with Charisma, its damage still with Strength.
  const { classAbility } = weapon;
  const rolledWith =
    classAbility &&
    !ranged &&
    classIds.some((id) => id.endsWith(`/${classAbility.class}`)) &&
    abilityModifier(abilities[classAbility.ability]) >
      abilityModifier(abilities[ability])
      ? classAbility.ability
      : ability;
  // shortcut: an Ammunition weapon without its range in the data reaches 80 feet with no long range.
  const range = ranged ? (weapon.range ?? { normal: 80, long: 80 }) : null;
  const reach = !ranged && weapon.properties.includes("reach");
  return {
    cost: ["action"],
    targeting: {
      creatures: 1,
      range: range?.long ?? (reach ? 10 : 5),
      side: "enemy",
      ...(reach ? { reach: true as const } : {}),
    },
    resolution: {
      kind: "attack",
      attack: {
        type: "weapon",
        ability: rolledWith,
        ...(proficient ? {} : { proficient }),
        ...(itemBonus > 0 ? { itemBonus } : {}),
        ...(range && range.normal < range.long
          ? { normalRange: range.normal }
          : {}),
      },
      damage: [
        {
          amount: {
            ...(weapon.damage.dice ? { dice: weapon.damage.dice } : {}),
            bonus: {
              base: (weapon.damage.flat ?? 0) + damageBonus,
              add: [{ kind: "abilityMod", ability }],
            },
          },
          type: weapon.damage.type,
        },
        ...(weapon.hitDamage ?? []),
      ],
      onHit: weapon.hitEffects ?? [],
      onMiss: [],
      ...(weapon.hitSave ? { onHitSave: weapon.hitSave } : {}),
      ...(weapon.natural20 ? { natural20: weapon.natural20 } : {}),
      ...(weapon.breaksConcentration ? { breaksConcentration: true } : {}),
      ...(weapon.vs ? { vs: weapon.vs } : {}),
      ...(weapon.sworn?.item
        ? { sworn: { item: weapon.sworn.item, damage: weapon.sworn.damage } }
        : {}),
    },
  };
}

// A magic weapon whose magic doesn't work, unattuned or in an Antimagic Field: no damage or riders of its magic's.
export function plainWeapon(weapon: Weapon): Weapon {
  const plain = { ...weapon };
  delete plain.hitDamage;
  delete plain.hitSave;
  delete plain.hitEffects;
  delete plain.natural20;
  delete plain.breaksConcentration;
  delete plain.vs;
  delete plain.thrown;
  delete plain.classAbility;
  delete plain.sworn;
  return plain;
}

// Throwing a Thrown weapon: its melee attack made at range, with Disadvantage past its normal range.
export function thrownActivation(
  melee: Activation,
  range: NonNullable<Weapon["range"]>,
  passives: readonly Passive[],
  thrown?: Weapon["thrown"], // a magic weapon's own throw, as a Hammer of Thunderbolts' hurl
): Activation {
  const { resolution } = melee;
  if (resolution.kind !== "attack") return melee;
  const bonus = passives.reduce(
    (sum, passive) =>
      passive.kind === "thrownDamage" ? sum + passive.bonus : sum,
    0,
  );
  const longShots = passives.some(({ kind }) => kind === "longShots");
  return {
    ...melee,
    ...(thrown?.resource
      ? { cost: [...melee.cost, { resource: thrown.resource }] }
      : {}),
    targeting: { creatures: 1, range: range.long, side: "enemy" },
    resolution: {
      ...resolution,
      ...(thrown?.hitSave ? { onHitSave: thrown.hitSave } : {}),
      attack: {
        ...resolution.attack,
        ...(longShots || range.normal >= range.long
          ? {}
          : { normalRange: range.normal }),
      },
      damage: [
        ...resolution.damage.map((damage, index) =>
          index === 0 && bonus > 0
            ? {
                ...damage,
                amount: {
                  ...damage.amount,
                  bonus: {
                    base: (damage.amount.bonus?.base ?? 0) + bonus,
                    add: damage.amount.bonus?.add ?? [],
                  },
                },
              }
            : damage,
        ),
        ...(thrown?.damage ?? []),
      ],
    },
  };
}

export function weaponAttackOf(
  resolution: Resolution,
): Extract<LeafEffect, { kind: "weaponAttack" }> | undefined {
  if (resolution.kind !== "automatic") return undefined;
  const found = resolution.effects.find(
    (effect) => effect.kind === "weaponAttack",
  );
  return found?.kind === "weaponAttack" ? found : undefined;
}

// A weapon attack of the creature's own that a spell's change applies to: only the weapons it names (or a magic
// one made from them), and with `ranged` only one firing ammunition.
export function weaponFits(
  action: KnownAction,
  change: WeaponChange,
  access: ContentAccess,
): boolean {
  if (!action.id.startsWith(WEAPON_PREFIX)) return false;
  const weapon = WeaponSchema.safeParse(
    access.content(weaponItemId(action.id)),
  ).data;
  if (!weapon) return false;
  if (change.ranged && !weapon.properties.includes("ammunition")) return false;
  const ids = [weaponItemId(action.id), weapon.baseWeapon ?? ""];
  return !change.weapons || ids.some((id) => change.weapons?.includes(id));
}
