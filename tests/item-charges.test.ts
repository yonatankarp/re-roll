import { readFile, readdir } from "node:fs/promises";
import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  step,
  startRun,
} from "../engine/run/turn.ts";
import {
  castFrom,
  itemCastId,
  spellOfSource,
} from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { payCosts } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { recovered } from "../plugins/systems/dnd5.5e/core/rest.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  type KnownAction,
  deriveStats,
  evaluateFormula,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { contextOf, scripted } from "./feat-fixtures.ts";
import { memoryStorage } from "./memory-storage.ts";

// Magic items with charges that cast spells and come back at dawn (#140), in a rules plugin of the test's own.
const ITEMS = `- id: "charge-test:item/fire-wand"
  name: Fire Wand
  type: magicItem
  category: wand
  rarity: rare
  attunement: true
  text: A test wand of three levels of Fireball.
  automation: full
  resources: [{ id: fire-wand, max: { base: 7 }, recharge: [{ on: dawn, amount: 1, roll: 1d6 }] }]
  casts: [{ spell: fireball, upTo: 3, dc: 15 }]
  lastCharge: destroyed
- id: "charge-test:item/ray-circlet"
  name: Ray Circlet
  type: magicItem
  category: wondrousItem
  rarity: uncommon
  attunement: false
  text: A test circlet that fires rays once a dawn.
  automation: full
  resources: [{ id: ray-circlet, max: { base: 1 }, recharge: [{ on: dawn, amount: all }] }]
  casts: [{ spell: scorching-ray, attack: 5 }]
- id: "charge-test:item/healing-staff"
  name: Healing Staff
  type: magicItem
  category: staff
  rarity: rare
  attunement: false
  text: A test staff that heals with its bearer's numbers.
  automation: full
  resources: [{ id: healing-staff, max: { base: 2 }, recharge: [{ on: dawn, amount: all }] }]
  casts: [{ spell: cure-wounds, upTo: 2 }, { spell: magic-missile, charges: 0 }]
  lastCharge: { becomes: "srd52:item/quarterstaff" }
- id: "charge-test:item/charged-blade"
  name: Charged Blade
  type: magicItem
  category: weapon
  rarity: rare
  attunement: false
  text: A test weapon that casts.
  automation: full
  bonuses: [{ to: attack, amount: 1 }, { to: damage, amount: 1 }]
  resources: [{ id: charged-blade, max: { base: 4 }, recharge: [{ on: dawn, amount: 0, roll: 1d4 }] }]
  casts: [{ spell: searing-smite, dc: 15 }]
- id: "charge-test:item/blade-ring"
  name: Blade Ring
  type: magicItem
  category: ring
  rarity: rare
  attunement: false
  text: A test ring that calls a blade.
  automation: full
  casts: [{ spell: test-blade, charges: 0, dc: 14 }]
`;
// A spell of the test's own whose blade attacks while it's held.
const SPELLS = `- id: "charge-test:spell/test-blade"
  name: Test Blade
  level: 2
  school: evocation
  classes: []
  castingTime: Bonus Action
  ritual: false
  range: Self
  components: V
  duration: { concentration: true, minutes: 10 }
  text: A test blade that lasts.
  automation: full
  activation:
    cost: [bonusAction, slot]
    targeting: { self: true }
    resolution:
      kind: automatic
      effects:
        - { kind: zone, zone: light, radius: 10, duration: { concentration: true, minutes: 10 } }
  lasting:
    cost: [action]
    targeting: { creatures: 1, range: 5, side: enemy }
    resolution:
      kind: attack
      attack: { type: spell }
      damage: [{ amount: { dice: 3d6 }, type: fire }]
`;
const WAND = "charge-test:item/fire-wand";
const CIRCLET = "charge-test:item/ray-circlet";
const STAFF = "charge-test:item/healing-staff";
const BLADE = "charge-test:item/charged-blade--1--longsword";
const FIREBALL = "srd52:spell/fireball";

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
  files["plugins/rules/charge-test/plugin.yaml"] = [
    "id: charge-test",
    "kind: rules",
    "version: 1.0.0",
    "sdk: ^1",
    "system: dnd5.5e@^1",
    "requires:",
    "  - { plugin: srd52, version: ^1 }",
    "distribution: shipped",
  ].join("\n");
  files["plugins/rules/charge-test/equipment/items.yaml"] = ITEMS;
  files["plugins/rules/charge-test/spells/spells.yaml"] = SPELLS;
  return files;
}

let run: RunContext;

beforeAll(async () => {
  const storage = memoryStorage(await pluginFiles());
  const catalog = await scanPlugins(storage, ["plugins"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "charge-test",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
});

// A pregen carrying `items`, attuned to every one, and with `stowed` in its pack.
function bearer(
  items: readonly string[],
  pregen = "cleric",
  stowed: readonly string[] = [],
): Actor {
  const chosen = step(run, startRun(run, "charges").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: `srd52:pregen/${pregen}`,
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return {
    ...actor,
    inventory: [...actor.inventory, ...items],
    stowed: [...(actor.stowed ?? []), ...stowed],
    attuned: [...items],
  };
}

const castsOf = (actor: Actor): KnownAction[] =>
  deriveStats(actor, run).actions.filter((action) => castFrom(action.id));

describe("magic items with charges", () => {
  it("reads the spell and the item behind a cast's id", () => {
    const id = itemCastId(FIREBALL, WAND, 2);
    expect(id).toBe(`spell:${FIREBALL}:item:${WAND}:2`);
    expect(castFrom(id)).toEqual({ item: WAND, charges: 2 });
    expect(spellOfSource(id)).toBe(FIREBALL);
    expect(spellOfSource(`spell:${FIREBALL}:free`)).toBe(FIREBALL);
    expect(spellOfSource(`spell:${FIREBALL}`)).toBe(FIREBALL);
    expect(castFrom(`spell:${FIREBALL}:free`)).toBeNull();
    expect(spellOfSource("monster:0")).toBeNull();
  });

  it("casts a wand's spell a level higher for each charge more, at the wand's DC and with no slot", () => {
    const casts = castsOf(bearer([WAND]));
    expect(casts.map((action) => [action.name, action.spellLevel])).toEqual([
      ["Fireball, level 3 (Fire Wand)", 3],
      ["Fireball, level 4 (Fire Wand)", 4],
      ["Fireball, level 5 (Fire Wand)", 5],
    ]);
    expect(casts.map((action) => action.activation.cost)).toEqual([
      ["action", { resource: "fire-wand" }],
      ["action", { resource: "fire-wand", count: 2 }],
      ["action", { resource: "fire-wand", count: 3 }],
    ]);
    const top = casts[2]?.activation.resolution;
    if (top?.kind !== "save") throw new Error("Not a save");
    expect(top.dc).toEqual({ base: 15, add: [] });
    expect(top.damage[0]?.amount.dice).toBe("10d6");
    // Nothing offers a slot to raise it.
    expect(casts.every((action) => action.upcast === undefined)).toBe(true);
  });

  it("keeps a pool for every item carried, and casts only from one worn", () => {
    const worn = deriveStats(bearer([WAND]), run);
    expect(worn.resources["fire-wand"]).toBe(7);
    const packed = bearer([WAND], "cleric", [WAND]);
    expect(castsOf(packed)).toEqual([]);
    expect(
      deriveStats(packed, run).resourceDefs.map((pool) => pool.id),
    ).toContain("fire-wand");
  });

  it("uses an item's attack bonus, or the bearer's numbers where it prints none", () => {
    const actor = bearer([CIRCLET, STAFF]);
    const stats = deriveStats(actor, run);
    const [ray] = castsOf(actor).filter((action) =>
      action.id.includes(CIRCLET),
    );
    const resolution = ray?.activation.resolution;
    if (resolution?.kind !== "attack") throw new Error("Not an attack");
    expect(resolution.attack.flatBonus).toBe(5);
    const cures = castsOf(actor).filter((action) =>
      action.name.startsWith("Cure Wounds"),
    );
    expect(cures.map((action) => action.spellLevel)).toEqual([1, 2]);
    const heal = cures[1]?.activation.resolution;
    if (heal?.kind !== "automatic") throw new Error("Not automatic");
    const effect = heal.effects[0];
    if (effect?.kind !== "heal") throw new Error("Not a heal");
    expect(effect.amount.dice).toBe("4d8");
    expect(
      evaluateFormula(effect.amount.bonus ?? { base: 0, add: [] }, stats),
    ).toBe(
      3, // the cleric's Wisdom 16
    );
    // A cast of no charges costs only its action.
    const missile = castsOf(actor).find((action) =>
      action.name.startsWith("Magic Missile"),
    );
    expect(missile?.activation.cost).toEqual(["action"]);
  });

  it("spends charges, and on the last one's d20 of 1 the item is gone or left plain", () => {
    const actor = bearer([WAND, STAFF]);
    const [, two] = castsOf(actor);
    if (!two) throw new Error("No cast");
    const kinds = (events: readonly { kind: string }[]) =>
      events.map((event) => event.kind.replace(`${NS}:`, ""));
    // Two of seven: no roll.
    const first = scripted([1]);
    const spent = payCosts(two, actor, contextOf(run, [actor], first.dice));
    expect(kinds(spent)).toEqual(["budgetSpent", "resourceSpent"]);
    expect(first.counts[20]).toBeUndefined();
    // The last two: a 1 crumbles it.
    const low = { ...actor, resourcesSpent: { "fire-wand": 5 } };
    const gone = payCosts(two, low, contextOf(run, [low], scripted([1]).dice));
    expect(kinds(gone)).toEqual([
      "budgetSpent",
      "resourceSpent",
      "itemUsed",
      "resourceRestored",
    ]);
    expect(gone[2] && "payload" in gone[2] ? gone[2].payload : null).toEqual({
      actor: PLAYER_ACTOR,
      item: WAND,
    });
    const kept = payCosts(two, low, contextOf(run, [low], scripted([2]).dice));
    expect(kinds(kept)).toEqual(["budgetSpent", "resourceSpent"]);
    // A staff that becomes a plain one leaves a Quarterstaff in hand.
    const cure = castsOf(actor).find((action) =>
      action.name.startsWith("Cure Wounds, level 2"),
    );
    if (!cure) throw new Error("No cure");
    const plain = payCosts(
      cure,
      actor,
      contextOf(run, [actor], scripted([1]).dice),
    );
    const last = plain.at(-1);
    expect(last && "payload" in last ? last.payload : null).toEqual({
      actor: PLAYER_ACTOR,
      gold: 0,
      items: ["srd52:item/quarterstaff"],
      stowed: [],
    });
  });

  it("regains rolled charges at dawn, no more than were spent", () => {
    const stats = deriveStats(bearer([WAND]), run);
    // 1d6 + 1: a 3 gives four back.
    expect(
      recovered({ "fire-wand": 6 }, stats, "long", scripted([3]).dice),
    ).toEqual({ "fire-wand": 2 });
    expect(
      recovered({ "fire-wand": 2 }, stats, "long", scripted([6]).dice),
    ).toEqual({});
    // A Short Rest isn't dawn, and nothing spent rolls nothing.
    expect(recovered({ "fire-wand": 6 }, stats, "short")).toEqual({
      "fire-wand": 6,
    });
    const idle = scripted([]);
    recovered({}, stats, "long", idle.dice);
    expect(idle.counts[6]).toBeUndefined();
  });

  it("lets a spell cast from an item act while it's held", () => {
    const ring = "charge-test:item/blade-ring";
    const actor = bearer([ring], "fighter");
    const [cast] = castsOf(actor);
    expect(cast?.concentrates).toBe(true);
    const lasting = (concentratingOn: string | null) =>
      deriveStats({ ...actor, concentratingOn }, run).actions.filter((action) =>
        action.id.startsWith("lasting:"),
      );
    expect(lasting(null)).toEqual([]);
    expect(
      lasting(itemCastId("charge-test:spell/test-blade", ring, 0)).map(
        (action) => [action.id, action.name],
      ),
    ).toEqual([["lasting:charge-test:spell/test-blade", "Test Blade"]]);
  });

  it("carries the charges into a magic weapon made from the item", () => {
    const actor = bearer([BLADE], "fighter");
    const stats = deriveStats(actor, run);
    expect(stats.resources["charged-blade"]).toBe(4);
    const [smite] = castsOf(actor);
    expect(smite?.name).toBe("Searing Smite (Charged Blade (Longsword))");
    expect(smite?.activation.trigger).toEqual({ afterHit: "meleeWeapon" });
    expect(smite?.activation.cost).toEqual([
      "bonusAction",
      { resource: "charged-blade" },
    ]);
  });
});
