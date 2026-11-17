import type { ContentAccess } from "#sdk";
import { type Item, ItemSchema } from "./schemas.ts";

const SEPARATOR = "--";

// One version of an item entry that has several: `<id>--<n>` is its nth version, counted from 1, so
// "dmg:item/potions-of-healing--2" is a Potion of Healing (greater). A magic weapon, armor or Shield also names the
// plain one it is, by its name after the plugin: "dmg:item/weapon-1-2-or-3--2--longsword" is a +2 Longsword, and
// "dmg:item/armor-1-2-or-3--1--chain-mail" is +1 Chain Mail. An entry with no versions is its own first, so
// "dmg:item/elven-chain--1--chain-shirt" is Elven Chain made as a Chain Shirt.
// The plain item is the first loaded one by that name, so the book that leads wins, as everywhere else.
export function deriveItem(
  id: string,
  access: ContentAccess,
): Item | undefined {
  const [parentId = "", index = "", baseSlug, ...extra] = id.split(SEPARATOR);
  if (extra.length > 0 || !/^[1-9]\d*$/.test(index)) return undefined;
  const parent = ItemSchema.safeParse(access.content(parentId)).data;
  if (parent?.type !== "magicItem") return undefined;
  const variant = parent.variants
    ? parent.variants[Number(index) - 1]
    : index === "1" && baseSlug !== undefined
      ? { name: parent.name, bonuses: parent.bonuses }
      : undefined;
  if (!variant) return undefined;
  const passives = [
    ...(parent.passives ?? []),
    ...("passives" in variant ? (variant.passives ?? []) : []),
  ];
  const casts = [
    ...(parent.casts ?? []),
    ...("casts" in variant ? (variant.casts ?? []) : []),
  ];
  const resources = [
    ...(parent.resources ?? []),
    ...("resources" in variant ? (variant.resources ?? []) : []),
  ];
  const magic = {
    ...(passives.length > 0 ? { passives } : {}),
    ...(parent.attunement ? { attunement: true as const } : {}),
    ...(casts.length > 0 ? { casts } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...(parent.lastCharge ? { lastCharge: parent.lastCharge } : {}),
    ...(parent.activations ? { activations: parent.activations } : {}),
  };
  const bonus = variant.bonuses?.[0]?.amount;
  const plus = bonus !== undefined && /, \+1\b/.test(parent.name);
  const name =
    variant.name ??
    (plus
      ? `${parent.name.replace(/, \+1\b.*$/, "")}, +${String(bonus)}`
      : `${parent.name} (${rarityName("rarity" in variant ? variant.rarity : parent.rarity)})`);
  if (baseSlug === undefined) {
    const item: Item = {
      ...parent,
      id,
      name,
      rarity: "rarity" in variant ? variant.rarity : parent.rarity,
      ...(variant.bonuses ? { bonuses: variant.bonuses } : {}),
      ...("abilities" in variant && variant.abilities
        ? { abilities: variant.abilities }
        : {}),
      ...("healing" in variant && variant.healing
        ? { healing: variant.healing }
        : {}),
      ...magic,
    };
    delete item.variants;
    return item;
  }
  // A staff is wielded as a Quarterstaff, as a Staff of Striking is.
  const types =
    parent.category === "weapon" || parent.category === "staff"
      ? ["weapon"]
      : parent.category === "armor"
        ? ["armor", "shield"]
        : [];
  const base = access
    .contentIds()
    .filter((other) => other.endsWith(`:item/${baseSlug}`))
    .map((other) => ItemSchema.safeParse(access.content(other)).data)
    .find((item) => item !== undefined && types.includes(item.type));
  if (base === undefined) return undefined;
  // "Elven Chain (Chain Shirt)", and a named version's "Wave-Swept Weapon (Barnacled, Longsword)".
  const named = plus
    ? `+${String(bonus)} ${base.name}`
    : name.endsWith(")")
      ? `${name.slice(0, -1)}, ${base.name})`
      : `${name} (${base.name})`;
  // A version with no bonuses of its own has the item's, as a Dragon Scale Mail's +1 for every kind of dragon.
  const own = variant.bonuses ?? parent.bonuses;
  const bonuses = own ? { bonuses: own } : {};
  let item: Item;
  if (base.type === "weapon") {
    const { damageType, addProperties, thrown } = parent;
    const damage = {
      ...base.damage,
      ...(damageType ? { type: damageType } : {}),
    };
    // Damage with no type of its own is the weapon's, and a weapon die is one of its dice.
    const hitDamage = parent.hitDamage?.map(
      ({ type, weaponDie, amount, ...rest }) => ({
        ...rest,
        amount:
          weaponDie && base.damage.dice
            ? {
                ...amount,
                dice: `1${base.damage.dice.slice(base.damage.dice.indexOf("d"))}`,
              }
            : amount,
        type: type ?? damage.type,
      }),
    );
    item = {
      ...base,
      id,
      name: named,
      baseWeapon: base.id,
      damage,
      properties: [
        ...new Set([
          ...base.properties,
          ...(addProperties ?? []),
          ...(thrown ? (["thrown"] as const) : []),
        ]),
      ],
      ...(thrown
        ? { range: { normal: thrown.normal, long: thrown.long } }
        : {}),
      ...bonuses,
      ...magic,
      ...(parent.returning ? { returning: true as const } : {}),
      ...(hitDamage ? { hitDamage } : {}),
      ...(parent.abilities ? { abilities: parent.abilities } : {}),
      ...riders(parent),
    };
  } else if (base.type === "armor") {
    item = {
      ...base,
      id,
      name: named,
      baseArmor: base.id,
      ...bonuses,
      ...magic,
      ...(parent.anyTraining ? { anyTraining: true as const } : {}),
    };
    if (parent.noStrength) delete item.strength;
  } else if (base.type === "shield") {
    item = {
      ...base,
      id,
      name: named,
      baseArmor: base.id,
      ...bonuses,
      ...magic,
    };
  } else {
    return undefined;
  }
  // A magic weapon or armor has no merchant's price, as a magic item has none.
  delete item.costCp;
  delete item.replaces;
  return item;
}

// A magic item's riders on its weapons' hits, as they are (schemas.ts WeaponRiders).
function riders(parent: Extract<Item, { type: "magicItem" }>) {
  const {
    hitSave,
    hitEffects,
    natural20,
    breaksConcentration,
    vs,
    thrown,
    classAbility,
    sworn,
  } = parent;
  return {
    ...(sworn ? { sworn: { ...sworn, item: parent.id } } : {}),
    ...(hitSave ? { hitSave } : {}),
    ...(hitEffects ? { hitEffects } : {}),
    ...(natural20 ? { natural20 } : {}),
    ...(breaksConcentration ? { breaksConcentration } : {}),
    ...(vs ? { vs } : {}),
    ...(thrown ? { thrown } : {}),
    ...(classAbility ? { classAbility } : {}),
  };
}

// "veryRare" as "Very Rare".
const rarityName = (rarity: string): string =>
  rarity
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (first) => first.toUpperCase());
