import { readFile, readdir } from "node:fs/promises";
import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import type { GameState } from "../engine/kernel/events.ts";
import { type Registry, loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  step,
  startRun,
} from "../engine/run/turn.ts";
import { checkPlugins } from "../engine/tools/check-pack.ts";
import { gearOptions, treasure } from "../plugins/systems/dnd5.5e/core/gear.ts";
import { shopOptions } from "../plugins/systems/dnd5.5e/core/shop.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  attackBonus,
  deriveStats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { masteryOf } from "../plugins/systems/dnd5.5e/core/tactics.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";
import { memoryStorage } from "./memory-storage.ts";

// A rules plugin of the test's own, with two items that each cover several versions.
const ITEMS = `- id: "variant-test:item/potions"
  name: Test Potions
  type: magicItem
  category: potion
  rarity: varies
  attunement: false
  text: A test potion in two strengths.
  automation: partial
  variants:
    - { name: Weak Test Potion, rarity: common, healing: { dice: 1d4 } }
    - { name: Strong Test Potion, rarity: uncommon, healing: { dice: 4d4, bonus: { base: 4 } } }
- id: "variant-test:item/weapon-1-2-or-3"
  name: Weapon, +1, +2, or +3
  type: magicItem
  category: weapon
  rarity: varies
  attunement: false
  text: A test weapon with a bonus.
  automation: partial
  variants:
    - { rarity: uncommon, bonuses: [{ to: attack, amount: 1 }, { to: damage, amount: 1 }] }
    - { rarity: rare, bonuses: [{ to: attack, amount: 2 }, { to: damage, amount: 2 }] }
`;
const STRONG = "variant-test:item/potions--2";
const SWORD = "variant-test:item/weapon-1-2-or-3--2--longsword";

async function pluginFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const root of [
    "plugins/rules/srd52",
    "plugins/adventures/goblin-ambush",
  ]) {
    for (const name of await readdir(root, { recursive: true })) {
      if (name.endsWith(".yaml")) {
        const file = `${root}/${name.replaceAll("\\", "/")}`;
        files[file] = await readFile(file, "utf8");
      }
    }
  }
  files["plugins/rules/variant-test/plugin.yaml"] = [
    "id: variant-test",
    "kind: rules",
    "version: 1.0.0",
    "sdk: ^1",
    "system: dnd5.5e@^1",
    "requires:",
    "  - { plugin: srd52, version: ^1 }",
    "distribution: shipped",
  ].join("\n");
  files["plugins/rules/variant-test/equipment/items.yaml"] = ITEMS;
  return files;
}

let registry: Registry;
let run: RunContext;

beforeAll(async () => {
  const storage = memoryStorage(await pluginFiles());
  const catalog = await scanPlugins(storage, ["plugins"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "variant-test",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  registry = loaded.registry;
  run = createRunContext(registry, "goblin-ambush");
});

const dnd = (state: GameState): DndState => StateSchema.parse(state.system);

// The fighter pregen with its Longsword in hand, also carrying `items`, equipped.
function fighter(items: readonly string[]): {
  state: DndState;
  actor: Actor;
} {
  const started = startRun(run, "variants");
  const chosen = step(run, started.state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: "srd52:pregen/fighter",
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const state = dnd(chosen.state);
  const player = state.actors[PLAYER_ACTOR];
  if (!player) throw new Error("No player");
  const actor: Actor = {
    ...player,
    inventory: [...player.inventory, ...items],
  };
  return {
    state: { ...state, actors: { ...state.actors, [PLAYER_ACTOR]: actor } },
    actor,
  };
}

describe("item variants", () => {
  it("finds a version by id without listing it", () => {
    expect(registry.content(STRONG)).toMatchObject({
      name: "Strong Test Potion",
      rarity: "uncommon",
      healing: { dice: "4d4", bonus: { base: 4 } },
    });
    expect(
      registry.content("variant-test:item/weapon-1-2-or-3--2"),
    ).toMatchObject({
      name: "Weapon, +2",
      type: "magicItem",
      bonuses: [
        { to: "attack", amount: 2 },
        { to: "damage", amount: 2 },
      ],
    });
    expect(registry.content(SWORD)).toMatchObject({
      name: "+2 Longsword",
      type: "weapon",
      category: "martial",
      baseWeapon: "srd52:item/longsword",
    });
    expect(registry.content(SWORD)).not.toHaveProperty("costCp");
    for (const id of [
      "variant-test:item/potions--3", // no third version
      "variant-test:item/potions--0",
      "variant-test:item/potions--2--longsword", // a potion has no base weapon
      "variant-test:item/weapon-1-2-or-3--2--chain-mail", // not a weapon
      "variant-test:item/weapon-1-2-or-3--2--longsword--x",
      "srd52:item/longsword--1", // has no versions
    ]) {
      expect(registry.content(id), id).toBeUndefined();
    }
    expect(registry.contentIds().some((id) => id.includes("--"))).toBe(false);
  });

  it("swings a magic weapon with its own bonus and the base weapon's mastery", () => {
    const { actor } = fighter([SWORD]);
    const stats = deriveStats(actor, run);
    const action = stats.actions.find((each) => each.id === `weapon:${SWORD}`);
    expect(action?.name).toBe("+2 Longsword");
    const resolution = action?.activation.resolution;
    if (resolution?.kind !== "attack") throw new Error("Not an attack");
    // Proficiency 2, Strength 17 (+3), and the sword's +2.
    expect(attackBonus(resolution, stats)).toBe(2 + 3 + 2);
    expect(resolution.damage[0]?.amount.bonus?.base).toBe(2);
    expect(masteryOf(actor, `weapon:${SWORD}`, run)).toBe("sap");
    // The bonus is the sword's own, so the plain Longsword held beside it has none.
    const plain = stats.actions.find(
      (each) => each.id === "weapon:srd52:item/longsword",
    )?.activation.resolution;
    if (plain?.kind !== "attack") throw new Error("Not an attack");
    expect(attackBonus(plain, stats)).toBe(2 + 3);
    expect(plain.damage[0]?.amount.bonus?.base).toBe(0);
  });

  it("drinks the version found, and a bare entry as its first version", () => {
    const { actor } = fighter([STRONG, "variant-test:item/potions"]);
    const drinks = deriveStats(actor, run).actions.filter((each) =>
      each.id.startsWith("item:"),
    );
    expect(
      drinks.map((each) => [
        each.name,
        each.activation.resolution.kind === "automatic"
          ? each.activation.resolution.effects[0]
          : undefined,
      ]),
    ).toEqual([
      [
        "Drink Strong Test Potion",
        { kind: "heal", amount: { dice: "4d4", bonus: { base: 4, add: [] } } },
      ],
      ["Drink Test Potions", { kind: "heal", amount: { dice: "1d4" } }],
    ]);
  });

  it("packs a found magic weapon and offers to equip it", () => {
    const { state } = fighter([]);
    const context = {
      state,
      dice: createDice(rngFromSeed("variants")),
      content: run.content,
      contentIds: run.contentIds,
    };
    const found = treasure({ gold: 0, items: [SWORD, STRONG] }, context);
    const after = (found.events ?? []).reduce(applyDndEvent, state);
    const player = after.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    expect(player.stowed).toEqual([SWORD]);
    expect(gearOptions(player, run, [SWORD])).toContainEqual({
      id: `equip:${SWORD}`,
      label: "Equip +2 Longsword",
    });
  });

  it("sells and shows a version by its own name", () => {
    const { state } = fighter([STRONG]);
    const shop = {
      merchant: "Tester",
      stock: [{ item: STRONG, price: 50 }],
      discount: 0,
    };
    const options = shopOptions({ shop }, { ...state, gold: 100 }, run);
    expect(options.map((option) => option.label)).toContain(
      "Buy Strong Test Potion (50 gp)",
    );
    const [sheet] = dndUi.sheets(state, run);
    const gear = sheet?.sections.find(
      (section) => section.title === "Equipment",
    );
    expect(gear?.rows.map((row) => row.label)).toContain("Strong Test Potion");
  });
});

describe("checking item variants", () => {
  async function issuesFor(item: string): Promise<string[]> {
    const files = await pluginFiles();
    const adventure = "plugins/adventures/goblin-ambush";
    files[`${adventure}/plugin.yaml`] = (
      files[`${adventure}/plugin.yaml`] ?? ""
    ).replace(
      "requires:",
      "requires:\n  - { plugin: variant-test, version: ^1 }",
    );
    files[`${adventure}/encounters.yaml`] =
      `- id: variant-fight\n  monsters: [{ monster: "srd52:monster/goblin-warrior" }]\n  loot: { items: ["${item}"] }\n` +
      (files[`${adventure}/encounters.yaml`] ?? "");
    const report = await checkPlugins(
      memoryStorage(files),
      ["plugins"],
      systems,
    );
    return report.issues.map((issue) => issue.message);
  }

  it("accepts a known version and a magic weapon on a weapon", async () => {
    expect(await issuesFor(STRONG)).toEqual([]);
    expect(await issuesFor(SWORD)).toEqual([]);
  });

  it("rejects an unknown version or base weapon", async () => {
    for (const id of [
      "variant-test:item/potions--3",
      "variant-test:item/weapon-1-2-or-3--2--nope",
    ]) {
      expect((await issuesFor(id)).join("\n")).toContain(
        `unknown reference "${id}"`,
      );
    }
  });
});
