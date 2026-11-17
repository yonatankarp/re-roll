import type { ContentAccess } from "#sdk";
import { type Item, ItemSchema, SpellSchema } from "./schemas.ts";
import { boundNumbers, spellNamed } from "./stats.ts";

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
  const parts = id.split(SEPARATOR);
  if (parts.length < 2) return undefined;
  const bound = ItemSchema.safeParse(access.content(parts[0] ?? "")).data;
  if (bound?.type === "magicItem" && bound.boundSpell) {
    const inner = parts.slice(0, -1);
    const made = inner.length === 1 ? bound : version(inner, access);
    return (
      made && withSpell(made, bound.boundSpell, parts.at(-1) ?? "", id, access)
    );
  }
  return version(parts, access);
}

// The version an id's parts name: the entry, its version's number, and the plain item it's made from.
function version(
  parts: readonly string[],
  access: ContentAccess,
): Item | undefined {
  const id = parts.join(SEPARATOR);
  const [parentId = "", index = "", baseSlug, ...extra] = parts;
  if (extra.length > 0 || !/^[1-9]\d*$/.test(index)) return undefined;
  const parent = ItemSchema.safeParse(access.content(parentId)).data;
  if (parent?.type !== "magicItem") return undefined;
  const variant = parent.variants
    ? parent.variants[Number(index) - 1]
    : index === "1" && baseSlug !== undefined
      ? { name: parent.name, bonuses: parent.bonuses }
      : undefined;
  if (!variant) return undefined;
  // An evolving item's version has what the versions before it have too.
  const kept =
    parent.evolving && parent.variants
      ? parent.variants.slice(0, Number(index))
      : "rarity" in variant
        ? [variant]
        : [];
  const passives = [
    ...(parent.passives ?? []),
    ...kept.flatMap((entry) => entry.passives ?? []),
  ];
  const casts = [
    ...(parent.casts ?? []),
    ...kept.flatMap((entry) => entry.casts ?? []),
  ];
  const resources = [
    ...(parent.resources ?? []),
    ...kept.flatMap((entry) => entry.resources ?? []),
  ];
  const activations = [
    ...(parent.activations ?? []),
    ...kept.flatMap((entry) => entry.activations ?? []),
  ];
  const magic = {
    ...(passives.length > 0 ? { passives } : {}),
    ...(parent.attunement ? { attunement: true as const } : {}),
    ...(casts.length > 0 ? { casts } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...(parent.lastCharge ? { lastCharge: parent.lastCharge } : {}),
    ...(activations.length > 0 ? { activations } : {}),
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
      ...("activation" in variant && variant.activation
        ? { activation: variant.activation }
        : {}),
      ...("granted" in variant && variant.granted
        ? { granted: variant.granted }
        : {}),
      ...magic,
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
  // A version with no bonuses of its own has the item's, as a Dragon Scale Mail's +1 for every kind of dragon.
  const own = variant.bonuses ?? parent.bonuses;
  const bonuses = own ? { bonuses: own } : {};
  let item: Item;
  if (base.type === "weapon") {
    item = {
      ...base,
      id,
      name: named,
      baseWeapon: base.id,
      ...bonuses,
      ...magic,
      ...(parent.returning ? { returning: true as const } : {}),
      ...(parent.hitDamage ? { hitDamage: parent.hitDamage } : {}),
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

// "veryRare" as "Very Rare".
const rarityName = (rarity: string): string =>
  rarity
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (first) => first.toUpperCase());

// An item with the spell named `slug` bound into it (MagicItemSchema `boundSpell`), or nothing for a spell it can't
// hold. "Enspelled Staff (Fireball)".
function withSpell(
  item: Item,
  bound: NonNullable<Extract<Item, { type: "magicItem" }>["boundSpell"]>,
  slug: string,
  id: string,
  access: ContentAccess,
): Item | undefined {
  const spellId = spellNamed(slug, access);
  const spell = spellId
    ? SpellSchema.safeParse(access.content(spellId)).data
    : undefined;
  if (
    !spellId ||
    !spell ||
    spell.level < bound.minLevel ||
    spell.level > bound.maxLevel ||
    (bound.schools && !bound.schools.includes(spell.school))
  ) {
    return undefined;
  }
  const name = `${item.name} (${spell.name})`;
  if (bound.as !== "charges") {
    return item.type === "magicItem"
      ? { ...item, id, name, spell: spellId, boundSpell: bound }
      : undefined;
  }
  const cast = { spell: slug, charges: 1, ...boundNumbers(spell.level) };
  return {
    ...item,
    id,
    name,
    casts: [...("casts" in item ? (item.casts ?? []) : []), cast],
  } as Item;
}
