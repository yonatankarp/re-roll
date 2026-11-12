import { describe, expect, it } from "vitest";
import { parseEquipmentFromHtml } from "../plugins/systems/dnd5.5e/core/import/equipment.ts";
import {
  ItemSchema,
  WeaponSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { weaponActivation } from "../plugins/systems/dnd5.5e/core/stats.ts";

// Invented items only: nothing here comes from a real book.
const page = `
  <h1>Magic Items</h1>
  <h3 class="compendium--magic-item">Twig, +1, +2, or +3</h3>
  <p>Weapon (Any Twig, Bent), Uncommon (+1), Rare (+2), or Very Rare (+3)</p>
  <p>You have a bonus to attack rolls and damage rolls made with this magic weapon.</p>
  <h3>Plain Pebble</h3>
  <p>Wondrous Item, Common</p>
  <p>It is a pebble.</p>
  <h3>Pebble of Warding</h3>
  <p>Wondrous Item, Rare (Requires Attunement by a Gardener)</p>
  <p>You gain a +2 bonus to Armor Class and saving throws while you wear this pebble.</p>
  <h3>Bark of Warding</h3>
  <p>Armor (Any Light), Rare (Requires Attunement)</p>
  <p>You have a +1 bonus to Armor Class while wearing no shoes if it rains.</p>
  <h3>Rake of Might</h3>
  <p>Rod, Rare</p>
  <p>You have a +3 bonus to attack rolls and damage rolls made with it.</p>
  <p>You have a +3 bonus to attack rolls and damage rolls made with it.</p>
  <h3>Guard Knife</h3>
  <p>Weapon (Dagger), Legendary</p>
  <p>You gain a +3 bonus to attack rolls and damage rolls made with this magic weapon.</p>
  <p>You could lower the bonus by 2 and gain a +2 bonus to Armor Class.</p>
  <h3>Rally Rod</h3>
  <p>Rod, Rare</p>
  <p>For a minute, you and your allies gain a +1 bonus to Armor Class.</p>
  <h3>Tonics of Mending</h3>
  <p>Potion, Rarity Varies</p>
  <p>Drink it.</p>
  <table><thead><tr><th>Potion</th><th>HP Regained</th><th>Rarity</th></tr></thead><tbody>
    <tr><td>Tonic</td><td>2d4 + 2</td><td>Common</td></tr>
    <tr><td>Tonic (big)</td><td>3d6</td><td>Rare</td></tr>
  </tbody></table>
  <h3 class="compendium--magic-item">Snow Globe</h3>
  <p>Wondrous Item, Rare</p>
  <p>Parent text.</p>
  <h4>Snow Globe of Hail</h4>
  <p>Wondrous Item, Legendary</p>
  <p>Child text.</p>
  <h3 class="compendium--magic-item">Mundane Ware (5 GP)</h3>
  <p>Some ordinary thing.</p>
  <h3>Stone Set</h3>
  <p>Wondrous Item, Rarity Varies</p>
  <p>Each stone gives a +1 bonus to Armor Class.</p>
  <h2>Tools</h2>
  <h3>Artisan’s Tools</h3>
  <h4>Twiner’s Supplies (50 GP)</h4>
  <p><strong>Ability:</strong> Dexterity <strong>Weight:</strong> 8 lb.</p>
  <p><strong>Utilize:</strong> Tie a knot (DC 10).</p>
  <h4>Game Board (Varies)</h4>
  <p><strong>Ability:</strong> Wisdom</p>
  <h2>Adventuring Gear</h2>
  <table><caption><h3>Adventuring Gear</h3></caption>
    <tr><th>Item</th><th>Weight</th><th>Cost</th></tr>
    <tr><td><a>Sack of Holes</a></td><td>1 lb.</td><td>5 SP</td></tr>
    <tr><td><a>Hiker’s Pack</a></td><td>5 lb.</td><td>1,000 GP</td></tr>
    <tr><td><a>Scroll, Blank (Small)</a></td><td>—</td><td>Varies</td></tr>
    <tr><td><a>Scroll, Blank (Large)</a></td><td>—</td><td>Varies</td></tr>
  </table>
  <h4>Sack of Holes (5 SP)</h4>
  <p>It leaks.</p>
  <h4>Hiker’s Pack (1,000 GP)</h4>
  <p>Holds a sack.</p>
  <h2>Other Tables</h2>
  <table><caption><h4>Holy Symbols</h4></caption>
    <tr><th>Symbol</th><th>Weight</th><th>Cost</th></tr>
    <tr><td>Bead (worn or held)</td><td>—</td><td>5 GP</td></tr>
  </table>
  <table><caption>Tack, Harness, and Drawn Vehicles</caption>
    <tr><th>Item</th><th>Weight</th><th>Cost</th></tr>
    <tr><td colspan="3"><em>Saddle</em></td></tr>
    <tr><td><a href="/equipment/1-riding-saddle">Riding</a></td><td>25 lb.</td><td>10 GP</td></tr>
    <tr><td><a href="/equipment/2-sled">Sled</a></td><td>300 lb.</td><td>20 GP</td></tr>
  </table>
  <table><caption>Mounts and Other Animals</caption>
    <tr><th>Item</th><th>Carrying Capacity</th><th>Cost</th></tr>
    <tr><td>Big Goat</td><td>300 lb.</td><td>3 PP</td></tr>
  </table>
  <table><caption>Explosives</caption>
    <tr><th>Item</th><th>Cost</th><th>Weight</th></tr>
    <tr><td>Pop Nut</td><td>2 CP</td><td>1 lb.</td></tr>
  </table>
  <table><caption>10 GP Gemstones</caption>
    <tr><th>1d12</th><th>Stone</th></tr>
    <tr><td>1</td><td>Glitter (faintly blue)</td></tr>
  </table>
  <table><caption>25 GP Art Objects</caption>
    <tr><th>1d10</th><th>Object</th></tr>
    <tr><td>1</td><td>Clay owl</td></tr>
  </table>`;

describe("importing items from a book page", () => {
  const items = parseEquipmentFromHtml(page, "my-book");
  const parsed = (slug: string) =>
    ItemSchema.parse(items.find((item) => item.slug === slug)?.entry);

  it("makes every entry valid, with unique slugs", () => {
    for (const item of items) {
      expect(ItemSchema.safeParse(item.entry).success, item.slug).toBe(true);
    }
    expect(new Set(items.map((item) => item.slug)).size).toBe(items.length);
  });

  it("reads a magic item's category, rarity and attunement", () => {
    expect(parsed("plain-pebble")).toEqual({
      id: "my-book:item/plain-pebble",
      name: "Plain Pebble",
      type: "magicItem",
      category: "wondrousItem",
      rarity: "common",
      attunement: false,
      text: "Wondrous Item, Common\nIt is a pebble.",
      automation: "text",
    });
    expect(parsed("pebble-of-warding")).toMatchObject({
      rarity: "rare",
      attunement: true,
      attunementBy: "a Gardener",
      bonuses: [
        { to: "ac", amount: 2 },
        { to: "savingThrows", amount: 2 },
      ],
    });
  });

  it("takes per-rarity bonuses from the type line, even with a comma in the subtype", () => {
    expect(parsed("twig-1-2-or-3")).toMatchObject({
      category: "weapon",
      rarity: "varies",
      variants: [
        {
          rarity: "uncommon",
          bonuses: [
            { to: "attack", amount: 1 },
            { to: "damage", amount: 1 },
          ],
        },
        { rarity: "rare" },
        {
          rarity: "veryRare",
          bonuses: [
            { to: "attack", amount: 3 },
            { to: "damage", amount: 3 },
          ],
        },
      ],
    });
  });

  it("invents no numbers from conditional, repeated or multi-item wording", () => {
    expect(parsed("bark-of-warding")).not.toHaveProperty("bonuses");
    expect(parsed("rake-of-might")).not.toHaveProperty("bonuses");
    expect(parsed("rally-rod")).not.toHaveProperty("bonuses");
    expect(parsed("guard-knife")).toMatchObject({
      bonuses: [
        { to: "attack", amount: 3 },
        { to: "damage", amount: 3 },
      ],
    });
    expect(parsed("stone-set")).not.toHaveProperty("bonuses");
    expect(parsed("stone-set")).toMatchObject({ rarity: "varies" });
  });

  it("reads healing dice from a potion's table", () => {
    expect(parsed("tonics-of-mending")).toMatchObject({
      rarity: "varies",
      variants: [
        {
          name: "Tonic",
          rarity: "common",
          healing: { dice: "2d4", bonus: { base: 2 } },
        },
        { name: "Tonic (big)", rarity: "rare", healing: { dice: "3d6" } },
      ],
    });
  });

  it("keeps a nested item out of its parent's text", () => {
    expect(parsed("snow-globe")).toMatchObject({
      text: "Wondrous Item, Rare\nParent text.",
    });
    expect(parsed("snow-globe-of-hail")).toMatchObject({
      rarity: "legendary",
      text: "Wondrous Item, Legendary\nChild text.",
    });
  });

  it("ignores a heading with the magic-item class but no type line", () => {
    expect(items.some((item) => item.slug.startsWith("mundane-ware"))).toBe(
      false,
    );
  });

  it("reads tools from their headings", () => {
    expect(parsed("twiner-s-supplies")).toMatchObject({
      type: "tool",
      ability: "dex",
      costCp: 5000,
      weightLb: 8,
    });
    expect(parsed("game-board")).toMatchObject({
      type: "tool",
      ability: "wis",
    });
    expect(parsed("game-board")).not.toHaveProperty("costCp");
  });

  it("reads gear with its cost and text, and sorts packs apart", () => {
    expect(parsed("sack-of-holes")).toEqual({
      id: "my-book:item/sack-of-holes",
      name: "Sack of Holes",
      type: "gear",
      category: "adventuring",
      costCp: 50,
      weightLb: 1,
      text: "Weight: 1 lb.\nIt leaks.",
    });
    expect(parsed("hiker-s-pack")).toMatchObject({
      category: "pack",
      costCp: 100000,
      text: "Weight: 5 lb.\nHolds a sack.",
    });
    expect(parsed("scroll-blank-small")).not.toHaveProperty("costCp");
    expect(parsed("scroll-blank-large").name).toBe("Scroll, Blank (Large)");
  });

  it("reads other tables by their column names", () => {
    expect(parsed("bead")).toMatchObject({
      name: "Bead (worn or held)",
      category: "focus",
      costCp: 500,
    });
    expect(parsed("saddle-riding")).toMatchObject({
      name: "Saddle, Riding",
      category: "tack",
    });
    expect(parsed("sled").name).toBe("Sled");
    expect(parsed("big-goat")).toMatchObject({
      category: "mount",
      costCp: 3000,
      text: "Carrying Capacity: 300 lb.",
    });
    expect(parsed("pop-nut")).toMatchObject({
      category: "explosive",
      costCp: 2,
      weightLb: 1,
      text: "Weight: 1 lb.",
    });
  });

  it("prices treasure tables from their caption", () => {
    expect(parsed("glitter")).toMatchObject({
      category: "treasure",
      costCp: 1000,
      text: "faintly blue",
    });
    expect(parsed("clay-owl")).toMatchObject({ costCp: 2500 });
  });

  it("turns flat weapon damage into a fixed amount with no dice", () => {
    const weapon = WeaponSchema.parse({
      id: "my-book:item/seed-spitter",
      name: "Seed Spitter",
      type: "weapon",
      category: "martial",
      damage: { flat: 1, type: "piercing" },
      mastery: "vex",
    });
    const { resolution } = weaponActivation(weapon, {
      str: 10,
      dex: 14,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
    });
    expect(resolution).toMatchObject({
      damage: [{ amount: { bonus: { base: 1 } }, type: "piercing" }],
    });
    expect(
      ItemSchema.safeParse({ ...weapon, damage: { type: "piercing" } }).success,
    ).toBe(false);
  });
});
