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
import {
  changed,
  gearEffects,
  gearFrames,
  gearOptions,
  sceneGearActions,
  treasure,
} from "../plugins/systems/dnd5.5e/core/gear.ts";
import { shopOptions } from "../plugins/systems/dnd5.5e/core/shop.ts";
import {
  type Actor,
  type DndState,
  NS,
  StateSchema,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { restEffects } from "../plugins/systems/dnd5.5e/core/rest.ts";
import { darkvisionOf } from "../plugins/systems/dnd5.5e/core/sight.ts";
import {
  attackBonus,
  checkBonus,
  damageResponses,
  deriveStats,
  evaluateFormula,
  saveBonus,
  spellSaveDc,
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
- id: "variant-test:item/armor-1-2-or-3"
  name: Armor, +1, +2, or +3
  type: magicItem
  category: armor
  rarity: varies
  attunement: false
  text: A test armor with a bonus.
  automation: full
  variants:
    - { rarity: rare, bonuses: [{ to: ac, amount: 1 }] }
    - { rarity: veryRare, bonuses: [{ to: ac, amount: 2 }] }
- id: "variant-test:item/shield-1-2-or-3"
  name: Shield, +1, +2, or +3
  type: magicItem
  category: armor
  rarity: varies
  attunement: false
  text: A test shield with a bonus.
  automation: full
  variants:
    - { rarity: uncommon, bonuses: [{ to: ac, amount: 1 }] }
- id: "variant-test:item/light-chain"
  name: Light Chain
  type: magicItem
  category: armor
  rarity: rare
  attunement: false
  text: A test armor anyone can wear.
  automation: full
  anyTraining: true
  noStrength: true
  bonuses: [{ to: ac, amount: 1 }]
- id: "variant-test:item/strong-gloves"
  name: Strong Gloves
  type: magicItem
  category: wondrousItem
  rarity: uncommon
  attunement: true
  text: A test item that sets Strength.
  automation: full
  abilities: [{ ability: str, set: 19 }]
- id: "variant-test:item/weak-gloves"
  name: Weak Gloves
  type: magicItem
  category: wondrousItem
  rarity: common
  attunement: false
  text: A test item that sets Strength lower than a fighter's.
  automation: full
  abilities: [{ ability: str, set: 12 }]
- id: "variant-test:item/stones"
  name: Test Stone
  type: magicItem
  category: wondrousItem
  rarity: varies
  attunement: true
  text: Test stones that raise a score.
  automation: partial
  variants:
    - { name: Quick Stone, rarity: veryRare, abilities: [{ ability: dex, raise: 2, max: 20 }] }
    - { name: Capped Stone, rarity: rare, abilities: [{ ability: dex, raise: 2, max: 14 }] }
- id: "variant-test:item/lucky-pebble"
  name: Lucky Pebble
  type: magicItem
  category: wondrousItem
  rarity: uncommon
  attunement: false
  text: A test item for checks and saves.
  automation: full
  bonuses: [{ to: checks, amount: 1 }, { to: savingThrows, amount: 1 }]
- id: "variant-test:item/guard-bracers"
  name: Guard Bracers
  type: magicItem
  category: wondrousItem
  rarity: rare
  attunement: false
  text: A test item for AC without armor.
  automation: full
  bonuses: [{ to: ac, amount: 2, unarmored: true }]
- id: "variant-test:item/caster-robe"
  name: Caster Robe
  type: magicItem
  category: wondrousItem
  rarity: veryRare
  attunement: false
  text: A test item for spells.
  automation: partial
  bonuses: [{ to: spellAttack, amount: 1 }, { to: spellDc, amount: 1 }]
- id: "variant-test:item/key-blade"
  name: Key Blade
  type: magicItem
  category: weapon
  rarity: varies
  attunement: true
  text: A test weapon that needs attunement.
  automation: partial
  variants:
    - { name: Key Blade (Three), rarity: uncommon, bonuses: [{ to: attack, amount: 1 }, { to: damage, amount: 1 }] }
- id: "variant-test:item/homing-weapon"
  name: Homing Weapon
  type: magicItem
  category: weapon
  rarity: uncommon
  attunement: false
  text: A test weapon that comes back.
  automation: full
  returning: true
  bonuses: [{ to: attack, amount: 1 }, { to: damage, amount: 1 }]
- id: "variant-test:item/archer-bracers"
  name: Archer Bracers
  type: magicItem
  category: wondrousItem
  rarity: uncommon
  attunement: false
  text: A test item for some weapons.
  automation: full
  weaponTraining: [shortbow, longsword]
  bonuses: [{ to: damage, amount: 2, weapons: [shortbow] }]
- id: "variant-test:item/mastery-stone"
  name: Mastery Stone
  type: magicItem
  category: wondrousItem
  rarity: legendary
  attunement: false
  text: A test item for the Proficiency Bonus.
  automation: full
  bonuses: [{ to: proficiency, amount: 1 }]
- id: "variant-test:item/strength-manual"
  name: Strength Manual
  type: magicItem
  category: wondrousItem
  rarity: veryRare
  attunement: false
  text: A test book that raises Strength for good.
  automation: full
  study: { ability: str, raise: 2, max: 30 }
- id: "variant-test:item/ward-plate"
  name: Ward Plate
  type: magicItem
  category: armor
  rarity: rare
  attunement: true
  text: A test armor that resists one type of damage, and fire.
  automation: full
  bonuses: [{ to: ac, amount: 1 }]
  passives: [{ kind: modifier, modifier: { kind: resistance, damage: fire } }]
  variants:
    - { name: Cold Ward Plate, rarity: rare, passives: [{ kind: modifier, modifier: { kind: resistance, damage: cold } }] }
    - { name: Acid Ward Plate, rarity: rare, passives: [{ kind: modifier, modifier: { kind: resistance, damage: acid } }] }
- id: "variant-test:item/frost-blade"
  name: Frost Blade
  type: magicItem
  category: weapon
  rarity: veryRare
  attunement: true
  text: A test weapon that resists fire while held, and adds cold.
  automation: full
  passives: [{ kind: modifier, modifier: { kind: resistance, damage: fire } }]
  hitDamage: [{ amount: { dice: 1d6 }, type: cold }]
- id: "variant-test:item/mage-robe"
  name: Mage Robe
  type: magicItem
  category: wondrousItem
  rarity: legendary
  attunement: true
  text: A test robe for AC without armor, Darkvision and slow healing.
  automation: full
  passives:
    - { kind: modifier, modifier: { kind: acFormula, formula: { base: 15, add: [{ kind: abilityMod, ability: dex }] } } }
    - { kind: modifier, modifier: { kind: darkvision, feet: 60 } }
    - { kind: slowRegeneration, dice: 1d6, minutes: 10 }
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
      const file = `${root}/${name.replaceAll("\\", "/")}`;
      if (name.endsWith(".yaml")) files[file] = await readFile(file, "utf8");
      // The adventure's pictures: only that they're there is checked.
      else if (/\.\w+$/.test(name)) files[file] = "";
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
function fighter(
  items: readonly string[],
  pregen = "srd52:pregen/fighter",
): {
  state: DndState;
  actor: Actor;
} {
  const started = startRun(run, "variants");
  const chosen = step(run, started.state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: pregen,
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

const CHAIN = "variant-test:item/armor-1-2-or-3--2--chain-mail";
const SHIELD = "variant-test:item/shield-1-2-or-3--1--shield";
const LIGHT = "variant-test:item/light-chain--1--chain-mail";

// The pregen wearing `items` in place of its armor and shield, attuned to `attuned`.
function wearing(
  items: readonly string[],
  attuned: readonly string[] = [],
  pregen = "srd52:pregen/fighter",
): Actor {
  const { actor } = fighter([], pregen);
  return {
    ...actor,
    inventory: [
      ...actor.inventory.filter(
        (id) => id !== "srd52:item/chain-mail" && id !== "srd52:item/shield",
      ),
      ...items,
    ],
    attuned: [...attuned],
  };
}

describe("magic armor, flat bonuses and ability scores", () => {
  it("makes magic armor and a magic Shield from plain ones", () => {
    expect(registry.content(CHAIN)).toMatchObject({
      name: "+2 Chain Mail",
      type: "armor",
      base: 16,
      bonuses: [{ to: "ac", amount: 2 }],
    });
    expect(registry.content(CHAIN)).not.toHaveProperty("costCp");
    expect(registry.content(SHIELD)).toMatchObject({
      name: "+1 Shield",
      type: "shield",
      bonus: 2,
    });
    // An entry with no versions is its own first.
    expect(registry.content(LIGHT)).toMatchObject({
      name: "Light Chain (Chain Mail)",
      type: "armor",
      anyTraining: true,
    });
    expect(registry.content(LIGHT)).not.toHaveProperty("strength");
    for (const id of [
      "variant-test:item/armor-1-2-or-3--1--longsword", // not armor
      "variant-test:item/light-chain--2--chain-mail", // no second version
      "variant-test:item/light-chain--1", // no versions to pick from
      "variant-test:item/strong-gloves--1--chain-mail", // not armor or a weapon
    ]) {
      expect(registry.content(id), id).toBeUndefined();
    }
  });

  it("wears magic armor and a Shield for their AC, unless magic is suppressed", () => {
    // Chain Mail 16, a Shield's 2 and the pregen's Defense.
    expect(
      deriveStats(wearing(["srd52:item/chain-mail", "srd52:item/shield"]), run)
        .ac,
    ).toBe(19);
    const magic = wearing([CHAIN, SHIELD]);
    expect(deriveStats(magic, run).ac).toBe(16 + 2 + 2 + 1 + 1);
    expect(deriveStats({ ...magic, suppressed: [] }, run).ac).toBe(19);
  });

  it("swaps the worn armor for magic armor put on", () => {
    const { actor } = fighter([]);
    const packed = {
      ...actor,
      inventory: [...actor.inventory, CHAIN],
      stowed: [CHAIN],
    };
    expect(gearOptions(packed, run)).toContainEqual({
      id: `equip:${CHAIN}`,
      label: "Equip +2 Chain Mail",
    });
    expect(changed(packed, `equip:${CHAIN}`, run).stowed).toEqual([
      "srd52:item/chain-mail",
    ]);
  });

  it("wears armor that needs no training or Strength", () => {
    const wizard = (armor: string) =>
      deriveStats(wearing([armor], [], "srd52:pregen/wizard"), run);
    const plain = wizard("srd52:item/chain-mail");
    expect(plain.untrainedArmor).toBe(true);
    const light = wizard(LIGHT);
    expect(light.untrainedArmor).toBe(false);
    expect(light.ac).toBe(17);
    // Strength 8 is below Chain Mail's 13, which costs the plain one 10 feet.
    expect(light.speed - plain.speed).toBe(10);
  });

  it("sets and raises ability scores while worn and attuned", () => {
    const gloves = "variant-test:item/strong-gloves";
    expect(deriveStats(wearing([gloves]), run).abilities.str).toBe(17);
    expect(deriveStats(wearing([gloves], [gloves]), run).abilities.str).toBe(
      19,
    );
    // A score set lower than the character's own does nothing.
    expect(
      deriveStats(wearing(["variant-test:item/weak-gloves"]), run).abilities
        .str,
    ).toBe(17);
    const quick = "variant-test:item/stones--1";
    const capped = "variant-test:item/stones--2";
    expect(registry.content(quick)).toMatchObject({ name: "Quick Stone" });
    expect(deriveStats(wearing([quick], [quick]), run).abilities.dex).toBe(15);
    expect(deriveStats(wearing([capped], [capped]), run).abilities.dex).toBe(
      14,
    );
  });

  it("adds item bonuses to checks, saves, spells and unarmored AC", () => {
    const { actor } = fighter([]);
    const pebble = deriveStats(
      wearing(["variant-test:item/lucky-pebble"]),
      run,
    );
    const plain = deriveStats(wearing([]), run);
    expect(saveBonus(pebble, "dex") - saveBonus(plain, "dex")).toBe(1);
    expect(
      checkBonus(pebble, actor, { ability: "wis", skill: "perception" }) -
        checkBonus(plain, actor, { ability: "wis", skill: "perception" }),
    ).toBe(1);
    const bracers = "variant-test:item/guard-bracers";
    expect(deriveStats(wearing([bracers]), run).ac).toBe(plain.ac + 2);
    expect(deriveStats(wearing([bracers, "srd52:item/shield"]), run).ac).toBe(
      plain.ac + 2,
    );
    const wizard = (items: readonly string[]) =>
      deriveStats(wearing(items, [], "srd52:pregen/wizard"), run);
    const robed = wizard(["variant-test:item/caster-robe"]);
    expect(spellSaveDc(robed) - spellSaveDc(wizard([]))).toBe(1);
    expect(robed.itemBonuses.spellAttack).toBe(1);
    const intDc = {
      base: 0,
      add: [{ kind: "spellSaveDc" as const, ability: "int" as const }],
    };
    expect(
      evaluateFormula(intDc, robed) - evaluateFormula(intDc, wizard([])),
    ).toBe(1);
  });
});

describe("magic items' passives while worn or attuned", () => {
  const PLATE = "variant-test:item/ward-plate--1--chain-mail";
  const resists = (actor: Actor) =>
    [...damageResponses(actor, run).resistances].sort();

  it("makes attuned magic armor from a plain one, with its passives and a version's", () => {
    expect(registry.content(PLATE)).toMatchObject({
      name: "Cold Ward Plate (Chain Mail)",
      type: "armor",
      attunement: true,
      passives: [
        { kind: "modifier", modifier: { kind: "resistance", damage: "fire" } },
        { kind: "modifier", modifier: { kind: "resistance", damage: "cold" } },
      ],
    });
    // Its AC bonus and passives work only once attuned.
    const unattuned = wearing([PLATE]);
    expect(deriveStats(unattuned, run).ac).toBe(17); // with the pregen's Defense
    expect(resists(unattuned)).toEqual([]);
    const attuned = wearing([PLATE], [PLATE]);
    expect(deriveStats(attuned, run).ac).toBe(18);
    expect(resists(attuned)).toEqual(["cold", "fire"]);
    expect(resists({ ...attuned, suppressed: [] })).toEqual([]);
    expect(gearOptions(unattuned, run)).toContainEqual({
      id: `attune:${PLATE}`,
      label: "Attune to Cold Ward Plate (Chain Mail)",
    });
    // A bare entry with versions counts as its first.
    const bare = "variant-test:item/ward-plate";
    expect(resists(wearing([bare], [bare]))).toEqual(["cold", "fire"]);
  });

  it("gives a magic weapon's passives and damage while held and attuned", () => {
    const blade = "variant-test:item/frost-blade--1--longsword";
    const types = (actor: Actor) => {
      const resolution = deriveStats(actor, run).actions.find(
        (each) => each.id === `weapon:${blade}`,
      )?.activation.resolution;
      if (resolution?.kind !== "attack") throw new Error("Not an attack");
      return resolution.damage.map((each) => each.type);
    };
    expect(resists(wearing([blade]))).toEqual([]);
    expect(types(wearing([blade]))).toEqual(["slashing"]);
    expect(resists(wearing([blade], [blade]))).toEqual(["fire"]);
    expect(types(wearing([blade], [blade]))).toEqual(["slashing", "cold"]);
  });

  it("changes AC and Darkvision by an item's passives", () => {
    const robe = "variant-test:item/mage-robe";
    // The fighter's Dexterity 13 without armor: 15 + 1 with the robe, 10 + 1 without.
    expect(deriveStats(wearing([]), run).ac).toBe(11);
    expect(deriveStats(wearing([robe], [robe]), run).ac).toBe(16);
    expect(darkvisionOf(wearing([robe], [robe]), run)).toBe(60);
  });

  it("heals a Ring of Regeneration's dice over a Short Rest's hour", () => {
    const robe = "variant-test:item/mage-robe";
    const { state } = fighter([]);
    const rest = (actor: Actor) => {
      const dnd = {
        ...state,
        actors: { ...state.actors, [PLAYER_ACTOR]: actor },
      };
      const result = restEffects[`${NS}:shortRest`].apply(
        {},
        {
          state: dnd,
          dice: createDice(rngFromSeed("regenerate")),
          content: run.content,
          contentIds: run.contentIds,
        },
      );
      return (result.events ?? []).reduce(applyDndEvent, dnd).actors[
        PLAYER_ACTOR
      ]?.hp;
    };
    const hurt = { ...wearing([robe], [robe]), hp: 1 };
    // Six rolls of 1d6 over the hour, from 6 to 36.
    const healed = (rest(hurt) ?? 0) - 1;
    expect(healed).toBeGreaterThanOrEqual(6);
    expect(healed).toBeLessThanOrEqual(36);
    expect(rest({ ...hurt, hp: 0 })).toBe(0);
    expect(rest({ ...hurt, attuned: [] })).toBe(1);
  });
});

describe("magic weapons that need attunement or come back, and other item pieces", () => {
  const attack = (actor: Actor, itemId: string) => {
    const stats = deriveStats(actor, run);
    const resolution = stats.actions.find(
      (each) => each.id === `weapon:${itemId}`,
    )?.activation.resolution;
    if (resolution?.kind !== "attack") throw new Error("Not an attack");
    return {
      hit: attackBonus(resolution, stats),
      damage: resolution.damage[0]?.amount.bonus?.base,
      proficient: resolution.attack.proficient !== false,
    };
  };

  it("swings an attuned magic weapon with its bonus only once attuned", () => {
    const blade = "variant-test:item/key-blade--1--dagger";
    expect(registry.content(blade)).toMatchObject({
      name: "Key Blade (Three, Dagger)",
      type: "weapon",
      attunement: true,
    });
    const { actor } = fighter([blade]);
    expect(attack(actor, blade).hit).toBe(2 + 3);
    expect(attack({ ...actor, attuned: [blade] }, blade).hit).toBe(2 + 3 + 1);
    expect(gearOptions(actor, run)).toContainEqual({
      id: `attune:${blade}`,
      label: "Attune to Key Blade (Three, Dagger)",
    });
  });

  it("keeps a Returning Weapon in hand once thrown", () => {
    const homing = "variant-test:item/homing-weapon--1--dagger";
    expect(registry.content(homing)).toMatchObject({
      name: "Homing Weapon (Dagger)",
      returning: true,
    });
    const { state } = fighter([homing]);
    const context = {
      state,
      dice: createDice(rngFromSeed("returning")),
      content: run.content,
      contentIds: run.contentIds,
    };
    const thrown = (item: string) =>
      gearFrames[`${NS}:throwWeapon`].run(
        { actor: PLAYER_ACTOR, item, target: PLAYER_ACTOR },
        context,
      ).events ?? [];
    expect(thrown(homing)).toEqual([]);
    const { state: plain } = fighter(["srd52:item/dagger"]);
    expect(
      gearFrames[`${NS}:throwWeapon`].run(
        {
          actor: PLAYER_ACTOR,
          item: "srd52:item/dagger",
          target: PLAYER_ACTOR,
        },
        { ...context, state: plain },
      ).events,
    ).toHaveLength(1);
  });

  it("trains with some weapons and adds to their damage alone", () => {
    const bracers = "variant-test:item/archer-bracers";
    const wizard = (items: readonly string[]) =>
      wearing(items, [], "srd52:pregen/wizard");
    const sword = "srd52:item/longsword";
    const bow = "srd52:item/shortbow";
    expect(attack(wizard([sword]), sword).proficient).toBe(false);
    expect(attack(wizard([sword, bracers]), sword).proficient).toBe(true);
    expect(attack(wizard([sword, bracers]), sword).damage).toBe(0);
    expect(attack(wizard([bow, bracers]), bow).damage).toBe(2);
  });

  it("raises the Proficiency Bonus", () => {
    const stone = "variant-test:item/mastery-stone";
    expect(deriveStats(wearing([stone]), run).proficiency).toBe(3);
  });

  it("studies a book to raise a score for good, spending the book", () => {
    const manual = "variant-test:item/strength-manual";
    const { state } = fighter([manual]);
    const action = sceneGearActions(state, run).find(
      (each) => each.id === `study:${manual}`,
    );
    expect(action).toMatchObject({
      label: "Study Strength Manual",
      rest: true,
    });
    const result = gearEffects[`${NS}:study`].apply(
      { item: manual },
      {
        state,
        dice: createDice(rngFromSeed("study")),
        content: run.content,
        contentIds: run.contentIds,
      },
    );
    const after = (result.events ?? []).reduce(applyDndEvent, state);
    const player = after.actors[PLAYER_ACTOR];
    if (!player) throw new Error("No player");
    expect(player.raised).toEqual({ str: 2 });
    expect(player.inventory).not.toContain(manual);
    expect(deriveStats(player, run).abilities.str).toBe(19);
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
