import { PLAYER_ACTOR, type Decision } from "#sdk";
import { describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { GameState, Input } from "../engine/kernel/events.ts";
import { replayInputs } from "../engine/run/save.ts";
import { type RunContext, startRun, step } from "../engine/run/turn.ts";
import type { StoryEffect } from "../engine/story/adventure.ts";
import { storyDecision } from "../engine/story/runtime.ts";
import {
  carryingCapacity,
  encumberedSpeed,
} from "../plugins/systems/dnd5.5e/core/carry.ts";
import { coins } from "../plugins/systems/dnd5.5e/core/shop.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
  dndEvent,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

const LONGSWORD = "srd52:item/longsword";
const POTION = "srd52:item/potion-of-healing";
const SCALE = "srd52:item/scale-mail";
const CHAIN = "srd52:item/chain-mail";
const RING = "srd52:item/ring-of-protection";

const dnd = (state: GameState): DndState => StateSchema.parse(state.system);

function playerOf(state: DndState): Actor {
  const actor = state.actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return actor;
}

const gold = (amount: number, items: readonly string[] = []): StoryEffect => ({
  kind: "system",
  effect: "dnd5.5e:treasure",
  args: { gold: amount, items },
});

const shop = (args: Record<string, unknown>): StoryEffect => ({
  kind: "system",
  effect: "dnd5.5e:shop",
  args: { merchant: "Tam", ...args },
});

// One scene whose only choice runs `effects`, then an ending.
async function storyRun(effects: readonly StoryEffect[]): Promise<RunContext> {
  const { run } = await loadAdventure("goblin-ambush");
  const scene = (id: string, text: string, choices: never[] | object[]) => ({
    id,
    text,
    textVariants: [],
    rest: true,
    choices,
  });
  return {
    ...run,
    adventure: {
      ...run.adventure,
      startScene: "s0",
      scenes: [
        scene("s0", "Onward.", [
          {
            label: "Go on",
            effects: [...effects, { kind: "goto", scene: "end" }],
          },
        ]),
        scene("end", "The end.", []),
      ] as RunContext["adventure"]["scenes"],
    },
  };
}

// Plays as the fighter, answering shop decisions from `trades` in turn, then leaving; anything else takes "done" or the first.
function play(
  run: RunContext,
  trades: readonly string[],
): { state: GameState; asked: Decision[]; inputs: Input[] } {
  const queue = [...trades];
  const started = startRun(run, "shop");
  let { state, pending } = started;
  const asked: Decision[] = [];
  const inputs: Input[] = [{ kind: "start" }];
  for (let count = 0; pending && count < 50; count += 1) {
    const decision: Decision = pending;
    asked.push(decision);
    const optionId =
      decision.id === `${NS}:chooseCharacter`
        ? "srd52:pregen/fighter"
        : decision.id.startsWith(`${NS}:shop:`)
          ? (queue.shift() ?? "leave")
          : (decision.options.find((option) => option.id === "done")?.id ??
            decision.options[0]?.id ??
            "");
    const input: Input = { kind: "answer", decisionId: decision.id, optionId };
    inputs.push(input);
    const outcome = step(run, state, input);
    if (!outcome.ok) throw new Error(`${decision.id}: ${outcome.error}`);
    ({ state, pending } = outcome);
  }
  return { state, asked, inputs };
}

const shopsAsked = (asked: readonly Decision[]) =>
  asked.filter((item) => item.id.startsWith(`${NS}:shop:`));

describe("a merchant", () => {
  it("sells at the item's cost, into the pack, and runs out of limited stock", async () => {
    const run = await storyRun([
      gold(100),
      shop({ stock: [{ item: LONGSWORD }, { item: POTION, quantity: 1 }] }),
    ]);
    const { state, asked } = play(run, [`buy:${LONGSWORD}`, `buy:${POTION}`]);
    const system = dnd(state);
    expect(system.gold).toBe(35);
    const player = playerOf(system);
    expect(player.inventory).toEqual(
      expect.arrayContaining([LONGSWORD, POTION]),
    );
    expect(player.stowed).toEqual([LONGSWORD]);
    const shops = shopsAsked(asked);
    expect(shops[0]?.options.map((option) => option.label)).toContain(
      "Buy Longsword (15 gp)",
    );
    // The one potion is gone, and the UI shows it sold out.
    const last = shops.at(-1);
    if (!last) throw new Error("No shop");
    expect(last.options.map((option) => option.id)).not.toContain(
      `buy:${POTION}`,
    );
    const view = dndUi.shop(last, state.system, run);
    expect(view?.buy.find((card) => card.item === POTION)).toMatchObject({
      note: "Sold out",
      option: null,
    });
    expect(view?.buy.find((card) => card.item === LONGSWORD)).toMatchObject({
      summary: "1d8 slashing, Versatile",
      price: "15 gp",
    });
  });

  it("keeps limited stock sold when the party comes back", async () => {
    const tam = shop({ stock: [{ item: POTION, quantity: 1 }] });
    const run = await storyRun([gold(200), tam, tam]);
    const { state, asked } = play(run, [`buy:${POTION}`, "leave", "leave"]);
    const visits = shopsAsked(asked);
    expect(visits).toHaveLength(3);
    const again = visits[2];
    if (!again) throw new Error("No second visit");
    expect(again.options.map((option) => option.id)).not.toContain(
      `buy:${POTION}`,
    );
    expect(dndUi.shop(again, state.system, run)?.buy[0]?.note).toBe("Sold out");
    expect(dnd(state).shopBought).toEqual({ Tam: [POTION] });
  });

  it("offers only what the purse can pay for", async () => {
    const run = await storyRun([
      gold(10),
      shop({ stock: [{ item: LONGSWORD }] }),
    ]);
    const { state, asked } = play(run, []);
    const first = shopsAsked(asked)[0];
    if (!first) throw new Error("No shop");
    expect(first.options.map((option) => option.id)).not.toContain(
      `buy:${LONGSWORD}`,
    );
    expect(dndUi.shop(first, state.system, run)?.buy[0]).toMatchObject({
      note: "Not enough gold",
      option: null,
    });
  });

  it("takes a price override in gp and a discount, kept to the copper", async () => {
    const run = await storyRun([
      gold(20),
      shop({
        discount: 20,
        stock: [{ item: LONGSWORD }, { item: POTION, price: 2.5 }],
      }),
    ]);
    const { state, asked } = play(run, [`buy:${POTION}`]);
    const labels = shopsAsked(asked)[0]?.options.map((option) => option.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Buy Longsword (12 gp)",
        "Buy Potion of Healing (2 gp)",
      ]),
    );
    expect(dnd(state).gold).toBe(18);
    expect(coins(12.5)).toBe("12 gp, 5 sp");
    expect(coins(0.07)).toBe("7 cp");
    expect(coins(0)).toBe("0 gp");
  });

  it("buys back at half price, a stowed copy before a worn one", async () => {
    const run = await storyRun([
      gold(0, [CHAIN]),
      shop({ stock: [{ item: LONGSWORD }] }),
    ]);
    const { state, asked } = play(run, [`sell:${CHAIN}`, `sell:${CHAIN}`]);
    const labels = shopsAsked(asked)[0]?.options.map((option) => option.label);
    expect(labels).toContain("Sell Chain Mail (37 gp, 5 sp)");
    const system = dnd(state);
    expect(system.gold).toBe(75);
    const player = playerOf(system);
    expect(player.inventory).not.toContain(CHAIN);
    expect(player.stowed ?? []).toEqual([]);
    // With its armor sold, the fighter's AC falls to unarmored plus the shield.
    expect(deriveStats(player, run).ac).toBeLessThan(18);
  });

  it("ends attunement when the last copy is sold", () => {
    const state: DndState = {
      gold: 0,
      combat: null,
      actors: {
        [PLAYER_ACTOR]: {
          ...freshActor({
            id: PLAYER_ACTOR,
            name: "P",
            side: "party",
            source: {
              kind: "monster",
              statBlockId: "srd52:monster/goblin-warrior",
            },
            hp: 1,
            inventory: [RING],
          }),
          attuned: [RING],
        },
      },
    };
    const sold = applyDndEvent(
      state,
      dndEvent(`${NS}:traded`, {
        actor: PLAYER_ACTOR,
        merchant: "Tam",
        item: RING,
        bought: false,
        priceCp: 250,
        stowed: false,
      }),
    );
    expect(playerOf(sold).attuned).toEqual([]);
    expect(sold.gold).toBe(2.5);
  });

  it("replays a visit exactly from its inputs", async () => {
    const run = await storyRun([
      gold(100, [SCALE]),
      shop({ stock: [{ item: LONGSWORD }, { item: POTION, quantity: 2 }] }),
    ]);
    const { state, inputs } = play(run, [
      `buy:${POTION}`,
      `sell:${SCALE}`,
      `buy:${LONGSWORD}`,
    ]);
    const replayed = replayInputs(run, "shop", inputs);
    expect(replayed.state).toEqual(state);
    expect(dnd(state).gold).toBe(100 - 50 + 25 - 15);
  });

  it("gives Tam's friend's price only once Tam likes you", async () => {
    const { run } = await loadAdventure("goblin-ambush");
    const { state } = startRun(run, "tam");
    const at = (attitude: number) =>
      storyDecision(run, {
        ...state,
        story: {
          ...state.story,
          scene: "camp",
          attitudes: { ...state.story.attitudes, peddler: attitude },
        },
      });
    const labels = (attitude: number) => {
      const shown = at(attitude);
      return shown.kind === "decision"
        ? shown.decision.options.map((option) => option.label)
        : [];
    };
    expect(labels(0)).toContain("Trade with Tam the peddler");
    expect(labels(0)).not.toContain(
      "Trade with Tam, who now gives you a friend's price",
    );
    expect(labels(1)).toContain(
      "Trade with Tam, who now gives you a friend's price",
    );
    expect(labels(1)).not.toContain("Trade with Tam the peddler");
  });
});

describe("carrying capacity", () => {
  it("is Strength times 15, halved for Tiny and doubled for Large", () => {
    expect(carryingCapacity(15, "medium")).toBe(225);
    expect(carryingCapacity(15, "small")).toBe(225);
    expect(carryingCapacity(10, "tiny")).toBe(75);
    expect(carryingCapacity(10, "large")).toBe(300);
  });

  it("drops Speed to 5 feet past capacity, and to 0 past twice it", () => {
    expect(encumberedSpeed(30, 225, 225)).toBe(30);
    expect(encumberedSpeed(30, 226, 225)).toBe(5);
    expect(encumberedSpeed(30, 451, 225)).toBe(0);
  });

  it("slows a character carrying too much, and the sheet says so", async () => {
    const run = await storyRun([gold(0, Array<string>(5).fill(CHAIN))]);
    const { state } = play(run, []);
    const player = playerOf(dnd(state));
    const stats = deriveStats(player, run);
    const capacity = stats.abilities.str * 15;
    // Six suits of chain mail at 55 lb each are past the fighter's capacity but not twice it.
    expect(6 * 55).toBeGreaterThan(capacity);
    expect(6 * 55).toBeLessThanOrEqual(capacity * 2);
    expect(stats.speed).toBe(5);
    const rows =
      dndUi
        .sheets(state.system, run)[0]
        ?.sections.find((section) => section.title === "Equipment")?.rows ?? [];
    expect(rows.find((row) => row.label === "Carrying")).toMatchObject({
      note: "Over capacity: Speed 5 feet",
    });
  });
});
