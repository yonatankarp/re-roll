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
    };
    delete item.variants;
    return item;
  }
  const types =
    parent.category === "weapon"
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
  const bonuses = variant.bonuses ? { bonuses: variant.bonuses } : {};
  let item: Item;
  if (base.type === "weapon") {
    item = {
      ...base,
      id,
      name: named,
      baseWeapon: base.id,
      ...bonuses,
      ...(parent.attunement ? { attunement: true as const } : {}),
      ...(parent.returning ? { returning: true as const } : {}),
    };
  } else if (parent.attunement) {
    // shortcut: only a weapon keeps its attunement, since armor and Shields have nowhere to check it.
    return undefined;
  } else if (base.type === "armor") {
    item = {
      ...base,
      id,
      name: named,
      baseArmor: base.id,
      ...bonuses,
      ...(parent.anyTraining ? { anyTraining: true as const } : {}),
    };
    if (parent.noStrength) delete item.strength;
  } else if (base.type === "shield") {
    item = { ...base, id, name: named, baseArmor: base.id, ...bonuses };
  } else {
    return undefined;
  }
  // A magic weapon or armor has no merchant's price, as a magic item has none.
  delete item.costCp;
  delete item.replaces;
  return item;
}

// "veryRare" as "Very Rare".
const rarityName = (rarity: string): string =>
  rarity
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (first) => first.toUpperCase());
