import type { ContentAccess } from "#sdk";
import { type Item, ItemSchema } from "./schemas.ts";

const SEPARATOR = "--";

// One version of an item entry that has several: `<id>--<n>` is its nth version, counted from 1, so
// "dmg:item/potions-of-healing--2" is a Potion of Healing (greater). A magic weapon also names the plain
// weapon it is, by its name after the plugin: "dmg:item/weapon-1-2-or-3--2--longsword" is a +2 Longsword.
// The weapon is the first loaded one by that name, so the book that leads wins, as everywhere else.
export function deriveItem(
  id: string,
  access: ContentAccess,
): Item | undefined {
  const [parentId = "", index = "", weaponSlug, ...extra] = id.split(SEPARATOR);
  if (extra.length > 0 || !/^[1-9]\d*$/.test(index)) return undefined;
  const parent = ItemSchema.safeParse(access.content(parentId)).data;
  if (parent?.type !== "magicItem") return undefined;
  const variant = parent.variants?.[Number(index) - 1];
  if (!variant) return undefined;
  const bonus = variant.bonuses?.[0]?.amount;
  const name =
    variant.name ??
    (bonus === undefined
      ? `${parent.name} (${rarityName(variant.rarity)})`
      : `${parent.name.replace(/, \+1\b.*$/, "")}, +${String(bonus)}`);
  if (weaponSlug === undefined) {
    const item: Item = {
      ...parent,
      id,
      name,
      rarity: variant.rarity,
      ...(variant.bonuses ? { bonuses: variant.bonuses } : {}),
      ...(variant.healing ? { healing: variant.healing } : {}),
    };
    delete item.variants;
    return item;
  }
  // shortcut: only a weapon that needs no attunement takes a base, since a plain weapon has no attunement to check.
  if (parent.category !== "weapon" || parent.attunement) return undefined;
  const weapon = access
    .contentIds()
    .filter((other) => other.endsWith(`:item/${weaponSlug}`))
    .map((other) => ItemSchema.safeParse(access.content(other)).data)
    .find((item) => item?.type === "weapon");
  if (weapon?.type !== "weapon") return undefined;
  const item: Item = {
    ...weapon,
    id,
    name:
      bonus === undefined
        ? `${weapon.name} (${name})`
        : `+${String(bonus)} ${weapon.name}`,
    baseWeapon: weapon.id,
    ...(variant.bonuses ? { bonuses: variant.bonuses } : {}),
  };
  // A magic weapon has no merchant's price, as a magic item has none.
  delete item.costCp;
  delete item.replaces;
  return item;
}

// "veryRare" as "Very Rare".
const rarityName = (rarity: string): string =>
  rarity
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (first) => first.toUpperCase());
