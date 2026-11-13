import {
  type ContentAccess,
  ContentIdSchema,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemResult,
  awaitDecision,
  frameHandler,
  storyEffect,
} from "#sdk";
import { z } from "zod";
import { type Item, ItemSchema } from "./schemas.ts";
import { type DndState, NS, dndEvent, frame, isDead } from "./state.ts";
import { deriveStats, lookup } from "./stats.ts";

type Context = SystemContext<DndState>;

export const LEAVE = "leave";
export const SHOP_PREFIX = `${NS}:shop:`;
const WORN_TYPES = new Set(["weapon", "armor", "shield"]);

const StockSchema = z.strictObject({
  item: ContentIdSchema,
  price: z.number().min(0).optional(), // in gp, in place of the item's own cost
  quantity: z.number().int().min(1).optional(), // how many the merchant has; endless without
});

export const ShopSchema = z.strictObject({
  merchant: z.string().min(1),
  stock: z.array(StockSchema).min(1),
  // Percent off what the merchant asks, such as from a friendly attitude the adventure checks.
  discount: z.number().int().min(0).max(100).default(0),
});
export type Stock = z.infer<typeof StockSchema>;

function itemOf(access: ContentAccess, id: string): Item {
  return lookup(access, ItemSchema, id);
}

// What the merchant asks, in cp, or null for an item with no price. `bearer` is the party's own discount on
// nonmagical items, as Crafter gives.
export function buyPriceCp(
  stock: Stock,
  item: Item,
  discount: number,
  bearer = 0,
): number | null {
  const base =
    stock.price === undefined ? item.costCp : Math.round(stock.price * 100);
  const own = item.type === "magicItem" ? 0 : bearer;
  return base === undefined
    ? null
    : Math.round((base * (100 - discount) * (100 - own)) / 10000);
}

// The best discount a party member's feature gives on nonmagical items, as Crafter's 20 percent.
export function partyDiscount(state: DndState, access: ContentAccess): number {
  return Math.max(
    0,
    ...Object.values(state.actors).flatMap((actor) =>
      actor.side === "party" && !isDead(actor)
        ? deriveStats(actor, access).passives.flatMap((passive) =>
            passive.kind === "shopDiscount" ? [passive.percent] : [],
          )
        : [],
    ),
  );
}

// Selling pays half the item's cost, rounded down to the copper; null when it fetches nothing.
// shortcut: magic items have no cost in the content, so they can't be sold; give them one to allow it.
export function sellPriceCp(item: Item): number | null {
  const price = Math.floor((item.costCp ?? 0) / 2);
  return price > 0 ? price : null;
}

// Gold is kept in gp, with copper as hundredths, so "12 gp, 5 sp".
export function coins(gold: number): string {
  const cp = Math.round(gold * 100);
  const parts = [
    [Math.floor(cp / 100), "gp"],
    [Math.floor(cp / 10) % 10, "sp"],
    [cp % 10, "cp"],
  ] as const;
  const shown = parts.filter(([count]) => count > 0);
  return shown.length > 0
    ? shown.map(([count, coin]) => `${String(count)} ${coin}`).join(", ")
    : "0 gp";
}

const StepSchema = z.object({
  step: z.number().int(),
  shop: ShopSchema,
});
type Step = z.infer<typeof StepSchema>;

// How many the merchant still has, or null for no limit. Sales are kept by merchant, so coming back doesn't restock.
export function left(
  stock: Stock,
  merchant: string,
  state: DndState,
): number | null {
  const sold = state.shopBought?.[merchant] ?? [];
  return stock.quantity === undefined
    ? null
    : stock.quantity - sold.filter((id) => id === stock.item).length;
}

// What the player can do now: buy what's in stock and affordable, sell what fetches coin, or leave.
export function shopOptions(
  { shop }: Pick<Step, "shop">,
  state: DndState,
  access: ContentAccess,
): { id: string; label: string }[] {
  const purseCp = Math.round((state.gold ?? 0) * 100);
  const player = state.actors[PLAYER_ACTOR];
  const buys = shop.stock.flatMap((stock) => {
    const item = itemOf(access, stock.item);
    const price = buyPriceCp(
      stock,
      item,
      shop.discount,
      partyDiscount(state, access),
    );
    if (price === null) {
      throw new Error(
        `${stock.item} has no cost; give it a price in the stock`,
      );
    }
    const remaining = left(stock, shop.merchant, state);
    return (remaining === null || remaining > 0) && price <= purseCp
      ? [
          {
            id: `buy:${stock.item}`,
            label: `Buy ${item.name} (${coins(price / 100)})`,
          },
        ]
      : [];
  });
  const sells = [...new Set(player?.inventory ?? [])].flatMap((id) => {
    const item = itemOf(access, id);
    const price = sellPriceCp(item);
    return price === null
      ? []
      : [
          {
            id: `sell:${id}`,
            label: `Sell ${item.name} (${coins(price / 100)})`,
          },
        ];
  });
  // Leave comes first, so a player or test that always takes the first choice never trades forever.
  return [{ id: LEAVE, label: "Leave" }, ...buys, ...sells];
}

function runShopStep(payload: Step, context: Context): SystemResult {
  const { state } = context;
  return {
    frames: [
      awaitDecision({
        id: `${SHOP_PREFIX}${String(payload.step)}`,
        actor: PLAYER_ACTOR,
        prompt: `${payload.shop.merchant} shows you the wares. You have ${coins(state.gold ?? 0)}.`,
        options: shopOptions(payload, state, context),
        resume: frame("shopAnswer", payload),
      }),
    ],
  };
}

const AnswerSchema = StepSchema.extend({ answer: z.string() });

function runShopAnswer(
  { answer, ...payload }: z.infer<typeof AnswerSchema>,
  context: Context,
): SystemResult {
  if (answer === LEAVE) return {};
  const split = answer.indexOf(":");
  const verb = answer.slice(0, split);
  const id = answer.slice(split + 1);
  const item = itemOf(context, id);
  const { shop, step } = payload;
  // Checked again here, since an answer is only trusted once it's one the step offered.
  if (
    !shopOptions(payload, context.state, context).some((o) => o.id === answer)
  ) {
    throw new Error(`${answer} isn't on offer`);
  }
  const stock = shop.stock.find((entry) => entry.item === id);
  const buying = verb === "buy" && stock !== undefined;
  const price = buying
    ? (buyPriceCp(
        stock,
        item,
        shop.discount,
        partyDiscount(context.state, context),
      ) ?? 0)
    : (sellPriceCp(item) ?? 0);
  return {
    events: [
      dndEvent(`${NS}:traded`, {
        actor: PLAYER_ACTOR,
        merchant: shop.merchant,
        item: id,
        bought: buying,
        priceCp: price,
        stowed: buying && WORN_TYPES.has(item.type),
      }),
    ],
    frames: [frame("shopStep", { step: step + 1, shop })],
  };
}

export const shopEffects = {
  [`${NS}:shop`]: storyEffect({
    schema: ShopSchema,
    references: (shop) => shop.stock.map((stock) => stock.item),
    apply: (shop, _context: Context) => ({
      frames: [frame("shopStep", { step: 0, shop })],
    }),
  }),
};

export const shopFrames = {
  [`${NS}:shopStep`]: frameHandler({ schema: StepSchema, run: runShopStep }),
  [`${NS}:shopAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runShopAnswer,
  }),
};
