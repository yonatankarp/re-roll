import { type ContentAccess, type Decision, PLAYER_ACTOR } from "#sdk";
import { z } from "zod";
import { type Item, ItemSchema } from "../core/schemas.ts";
import {
  LEAVE,
  SHOP_PREFIX,
  ShopSchema,
  buyPriceCp,
  coins,
  left,
  partyDiscount,
  sellPriceCp,
} from "../core/shop.ts";
import { parseState } from "./parse-state.ts";

const words = (camel: string): string =>
  camel
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (first) => first.toUpperCase());

// A line of what the item does, such as "1d8 slashing, Versatile".
export function itemSummary(item: Item): string {
  switch (item.type) {
    case "weapon": {
      const { dice, flat, type } = item.damage;
      return [
        `${dice ?? String(flat)} ${type}`,
        ...item.properties.map(words),
      ].join(", ");
    }
    case "armor": {
      const dex = item.addDex
        ? ` + Dex${item.maxDex === undefined ? "" : ` (max ${String(item.maxDex)})`}`
        : "";
      return `AC ${String(item.base)}${dex}, ${item.armorType}`;
    }
    case "shield":
      return `+${String(item.bonus)} AC`;
    case "tool":
      return "Tool";
    case "gear":
    case "magicItem": {
      if (item.healing) {
        const { dice, bonus } = item.healing;
        const flat = bonus?.base;
        return `Heals ${[dice, flat ? String(flat) : null].filter(Boolean).join(" + ")}`;
      }
      if (item.type === "magicItem") {
        const bonuses = (item.bonuses ?? []).map(
          (bonus) =>
            `+${String(bonus.amount)} ${words(bonus.to).toLowerCase()}`,
        );
        return [...bonuses, words(item.rarity)].join(", ");
      }
      return item.category ? words(item.category) : "";
    }
  }
}

const ResumeSchema = z.object({ shop: ShopSchema });

// The merchant's screen over the shop decision: every card, with the offered ones made tradeable.
export function shop(
  decision: Decision,
  rawState: unknown,
  access: ContentAccess,
) {
  if (!decision.id.startsWith(SHOP_PREFIX)) return null;
  const resume = ResumeSchema.safeParse(decision.resume.payload);
  if (!resume.success) return null;
  const { shop: wares } = resume.data;
  const state = parseState(rawState);
  const offered = new Set(decision.options.map((option) => option.id));
  const itemOf = (id: string) => ItemSchema.parse(access.content(id));
  const discount = partyDiscount(state, access);
  const buy = wares.stock.map((stock) => {
    const item = itemOf(stock.item);
    const remaining = left(stock, wares.merchant, state);
    const option = `buy:${stock.item}`;
    const tradeable = offered.has(option);
    const note =
      remaining === 0
        ? "Sold out"
        : !tradeable
          ? "Not enough gold"
          : remaining === null
            ? undefined
            : `${String(remaining)} left`;
    return {
      item: stock.item,
      name: item.name,
      summary: itemSummary(item),
      price: coins(
        (buyPriceCp(stock, item, wares.discount, discount) ?? 0) / 100,
      ),
      ...(note ? { note } : {}),
      option: tradeable ? option : null,
    };
  });
  const inventory = state.actors[PLAYER_ACTOR]?.inventory ?? [];
  const sell = [...new Set(inventory)].flatMap((id) => {
    const option = `sell:${id}`;
    if (!offered.has(option)) return [];
    const item = itemOf(id);
    const count = inventory.filter((other) => other === id).length;
    return [
      {
        item: id,
        name: item.name,
        summary: itemSummary(item),
        price: coins((sellPriceCp(item) ?? 0) / 100),
        ...(count > 1 ? { note: `You have ${String(count)}` } : {}),
        option,
      },
    ];
  });
  return {
    merchant: wares.merchant,
    purse: coins(state.gold ?? 0),
    buy,
    sell,
    leave: LEAVE,
  };
}
