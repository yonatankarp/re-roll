import { describe, expect, it } from "vitest";
import { importParsed } from "../engine/tools/import.ts";
import {
  parseFeaturesFromHtml,
  parseSubclassesFromHtml,
} from "../plugins/systems/dnd5.5e/core/import/classes.ts";
import { parseCompanionsFromHtml } from "../plugins/systems/dnd5.5e/core/import/companions.ts";
import { parseMagicItemsFromHtml } from "../plugins/systems/dnd5.5e/core/import/magic-items.ts";
import {
  parseBackgroundsFromHtml,
  parseFeatsFromHtml,
  parseSpeciesFromHtml,
  parseSpeciesTraits,
} from "../plugins/systems/dnd5.5e/core/import/origins.ts";
import {
  spellTextFromHtml,
  splitSpells,
} from "../plugins/systems/dnd5.5e/core/import/spells.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";
import { memoryStorage } from "./memory-storage.ts";

const stats = `<div class="stats"><table class="physical abilities-saves"><tbody>
  <tr><th>STR</th><td>14</td><td>+2</td><td>+2</td></tr>
  <tr><th>DEX</th><td>12</td><td>+1</td><td>+1</td></tr>
  <tr><th>CON</th><td>10</td><td>+0</td><td>+0</td></tr>
</tbody></table><table class="mental abilities-saves"><tbody>
  <tr><th>INT</th><td>8</td><td>−1</td><td>−1</td></tr>
  <tr><th>WIS</th><td>10</td><td>+0</td><td>+0</td></tr>
  <tr><th>CHA</th><td>6</td><td>−2</td><td>−2</td></tr>
</tbody></table></div>`;

const subclassPage = `
  <h1>Chapter 3: Callings (Continued)</h1>
  <h2>Subclasses</h2>
  <h3 class="with-metadata">Moss Knight (Fighter)</h3>
  <p>Knights of the moss.</p>
  <h4 id="L3">Level 3: Soft Step</h4>
  <p>You step softly.</p>
  <div class="stat-block"><h3 class="with-metadata">Moss Hound</h3>
    <p>Small Plant</p><p><strong>AC</strong> 12 plus your Wisdom modifier</p>
    <p><strong>HP</strong> 5 plus five times your Fighter level</p>
    <p><strong>Speed</strong> 30 ft.</p>${stats}
  </div>
  <h4 id="L7">Level 7: Green Mind</h4>
  <p>Your mind turns green.</p>
  <h4>Moss Options</h4>
  <p>Pick a moss.</p>
  <h3>Lantern Mage (Monk)</h3>
  <h4>Level 3: Spellcasting</h4>
  <p>You cast spells.</p>
  <table><caption><h4>Lantern Mage Spellcasting</h4></caption>
    <tr><th colspan="2"></th><th colspan="2">Spell Slots</th></tr>
    <tr><th>Monk Level</th><th>Prepared Spells</th><th>1</th><th>2</th></tr>
    <tr><td>3</td><td>3</td><td>2</td><td>—</td></tr>
    <tr><td>4</td><td>4</td><td>3</td><td>1</td></tr>
  </table>
  <h3>Bone Binder (Artificer)</h3>
  <h4>Level 3: Bind</h4>
  <p>You bind bones.</p>
  <h2>Backgrounds</h2>`;

const knownClasses = ["phb:class/fighter", "phb:class/monk"];

describe("subclasses printed alone in a book", () => {
  const subclasses = parseSubclassesFromHtml(
    subclassPage,
    "my-book",
    knownClasses,
  );

  it("points a subclass at the class another plugin holds", () => {
    const knight = subclasses.find(
      (item) => item.slug === "fighter-moss-knight",
    );
    expect(knight?.entry).toMatchObject({
      id: "my-book:subclass/fighter-moss-knight",
      name: "Moss Knight",
      class: "phb:class/fighter",
      levels: [
        {
          level: 3,
          grants: ["my-book:feature/fighter-moss-knight-soft-step"],
        },
        {
          level: 7,
          grants: ["my-book:feature/fighter-moss-knight-green-mind"],
        },
      ],
    });
  });

  it("leaves out a subclass with no class anywhere, but keeps its features", () => {
    expect(subclasses.map((item) => item.slug)).not.toContain(
      "artificer-bone-binder",
    );
    expect(
      parseFeaturesFromHtml(subclassPage, "my-book").map((item) => item.slug),
    ).toContain("artificer-bone-binder-bind");
  });

  it("doesn't mistake a chapter heading for a subclass", () => {
    expect(
      parseSubclassesFromHtml(subclassPage, "my-book", knownClasses).map(
        (item) => (item.entry as { readonly name: string }).name,
      ),
    ).toEqual(["Moss Knight", "Lantern Mage"]);
  });

  it("keeps a stat block and an unlevelled heading in the feature above them", () => {
    const features = new Map(
      parseFeaturesFromHtml(subclassPage, "my-book").map((item) => [
        item.slug,
        (item.entry as { readonly text: string }).text,
      ]),
    );
    expect(features.get("fighter-moss-knight-soft-step")).toContain(
      "Moss Hound",
    );
    expect(features.get("fighter-moss-knight-green-mind")).toContain(
      "Pick a moss.",
    );
    expect(features.get("fighter-moss-knight-soft-step")).not.toContain(
      "turns green",
    );
  });

  it("reads a subclass's own spell slots from its table", () => {
    const mage = subclasses.find((item) => item.slug === "monk-lantern-mage");
    expect(mage?.entry).toMatchObject({
      levels: [
        {
          level: 3,
          grants: ["my-book:feature/monk-lantern-mage-spellcasting"],
          slots: [2],
          scaling: { preparedSpells: 3 },
        },
        { level: 4, grants: [], slots: [3, 1], scaling: { preparedSpells: 4 } },
      ],
    });
  });

  it("passes what other plugins hold through to the parser", async () => {
    const storage = memoryStorage({});
    const summary = await importParsed({
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "subclasses",
      html: subclassPage,
      knownIds: knownClasses,
    });
    expect(summary).toMatchObject({ written: 2, invalid: [] });
    expect(
      await storage.read(
        "private/import/my-book/subclasses/monk-lantern-mage.yaml",
      ),
    ).toContain("class: phb:class/monk");
  });
});

describe("companions", () => {
  it("takes a stat block with a formula and leaves printed numbers to the monster parser", () => {
    const page = `${subclassPage}
      <div class="stat-block"><h3>Plain Wolf</h3><p>Medium Beast</p>
        <p><strong>AC</strong> 13</p><p><strong>HP</strong> 11 (2d8 + 2)</p>
        <p><strong>Speed</strong> 40 ft.</p>${stats}</div>`;
    const companions = parseCompanionsFromHtml(page, "my-book");
    expect(companions.map((item) => item.slug)).toEqual(["moss-hound"]);
    const [hound] = companions;
    expect(hound?.entry).toMatchObject({
      id: "my-book:companion/moss-hound",
      size: "small",
      ac: "12 plus your Wisdom modifier",
      hp: "5 plus five times your Fighter level",
      speed: "30 ft.",
      abilities: { str: 14, dex: 12, con: 10, int: 8, wis: 10, cha: 6 },
    });
    expect(dnd55e.contentKinds.companions?.parse(hound?.entry).ok).toBe(true);
  });
});

const originsPage = `
  <h2>Feats</h2>
  <h3>Origin Feats</h3>
  <p>These feats are origin feats.</p>
  <h4 class="with-metadata">Sharp Nose</h4>
  <p>Origin Feat</p>
  <p>You smell things.</p>
  <h4 class="with-metadata">Boon of Moss</h4>
  <p><em>Epic Boon Feat (Prerequisite: Level 19+)</em></p>
  <p>Moss loves you.</p>
  <h3>Dark Gifts</h3>
  <h4 class="with-metadata">Night Blood</h4>
  <p><em>Dark Gift Feat (Prerequisite: Level 4+)</em></p>
  <p>Your blood is dark.</p>
  <h2>Character Backgrounds</h2>
  <h3>Faction Backgrounds</h3>
  <p>This is only a list.</p>
  <h3>Bog Hunter</h3>
  <div class="condensed-group"><p><strong>Ability Score:</strong> Strength, Dexterity, Wisdom</p>
  <p><strong>Feat:</strong> Sharp Nose (see <a>Feats</a>)</p>
  <p><strong>Skill Proficiencies:</strong> Nature and Survival</p>
  <p><strong>Tool Proficiency:</strong> Tinker’s Tools</p></div>
  <h3>Sailor</h3>
  <div class="condensed-group"><p><strong>Ability Scores:</strong> Strength, Dexterity, Wisdom</p>
  <p><strong>Feat:</strong> Tough (see <a>Feats</a>)</p>
  <p><strong>Skill Proficiencies:</strong> Nature and Survival</p>
  <p><strong>Tool Proficiency:</strong> Tinker’s Tools</p></div>
  <h3>Mire Touched</h3>
  <div class="condensed-group"><p><strong>Ability Scores:</strong> Strength, Dexterity, Wisdom</p>
  <p><strong>Feat:</strong> Sharp Nose or a Dark Gift feat of your choice (see <a>Feats</a>)</p>
  <p><strong>Skill Proficiencies:</strong> Nature and Survival</p>
  <p><strong>Tool Proficiency:</strong> Tinker’s Tools</p></div>
  <h3>Gift Bearer</h3>
  <div class="condensed-group"><p><strong>Ability Scores:</strong> Strength, Dexterity, Wisdom</p>
  <p><strong>Feat:</strong> A Dark Gift feat of your choice (see <a>Feats</a>)</p>
  <p><strong>Skill Proficiencies:</strong> Nature and Survival</p>
  <p><strong>Tool Proficiency:</strong> Tinker’s Tools</p></div>
  <h2>Species</h2>
  <h3>Bogling</h3>
  <h4>Bogling Traits</h4>
  <div class="condensed-group"><p><strong>Creature Type:</strong> Humanoid</p>
  <p><strong>Size:</strong> Small (about 3 feet tall)</p>
  <p><strong>Speed:</strong> 25 feet</p></div>
  <p><strong>Damp.</strong> You stay damp.</p>
  <p><strong>Murky.</strong> You see through mud.</p>
  <h4>Bogling Origins</h4>
  <table><tr><th>d4</th><th>Origin</th></tr><tr><td>1</td><td>A bog</td></tr></table>
  <h3>Elfish</h3>
  <p>A tale of elves.</p>
  <h4>Elfish Culture</h4>
  <p>This species has no traits here.</p>`;

describe("origins in other books", () => {
  it("reads a feat's kind from the line under its name", () => {
    expect(
      parseFeatsFromHtml(originsPage, "my-book").map((item) => [
        item.slug,
        (item.entry as { readonly category: string }).category,
      ]),
    ).toEqual([
      ["sharp-nose", "origin"],
      ["boon-of-moss", "epicBoon"],
      ["night-blood", "darkGift"],
    ]);
  });

  it("finds backgrounds by their label, and their feats here or elsewhere", () => {
    const backgrounds = new Map(
      parseBackgroundsFromHtml(originsPage, "my-book", [
        "phb:feat/tough",
        "phb:feat/sharp-nose",
      ]).map((item) => [item.slug, item]),
    );
    expect([...backgrounds.keys()]).toEqual([
      "bog-hunter",
      "sailor",
      "mire-touched",
      "gift-bearer",
    ]);
    expect(backgrounds.get("bog-hunter")?.entry).toMatchObject({
      feat: "my-book:feat/sharp-nose",
      abilities: ["str", "dex", "wis"],
      skills: ["nature", "survival"],
    });
    expect(backgrounds.get("sailor")?.entry).toMatchObject({
      feat: "phb:feat/tough",
    });
    const mire = backgrounds.get("mire-touched");
    expect(mire?.entry).toMatchObject({ feat: "my-book:feat/sharp-nose" });
    expect(mire?.notes).toEqual([
      "feat option not held: Dark Gift feat of your choice",
    ]);
    const bearer = backgrounds.get("gift-bearer");
    expect(bearer?.entry).toMatchObject({ feat: "my-book:feat/night-blood" });
    expect(bearer?.notes).toEqual(["feat is a choice of Dark Gift"]);
  });

  it("finds species by their traits heading, with plain bold trait labels", () => {
    const [bogling, ...others] = parseSpeciesFromHtml(originsPage, "my-book");
    expect(others).toEqual([]);
    expect(bogling?.entry).toMatchObject({
      name: "Bogling",
      size: "small",
      speed: 25,
      traits: ["my-book:feature/bogling-damp", "my-book:feature/bogling-murky"],
    });
    expect((bogling?.entry as { readonly text: string }).text).toContain(
      "A bog",
    );
    const [damp, murky] = parseSpeciesTraits(originsPage, "my-book");
    expect(damp?.entry).toMatchObject({ text: "You stay damp." });
    expect((murky?.entry as { readonly text: string }).text).not.toContain(
      "A bog",
    );
  });

  it("uses the name when a species prints nothing before its traits", () => {
    const [species] = parseSpeciesFromHtml(
      `<h3>Quiet</h3><h4>Quiet Traits</h4>
       <p><strong>Creature Type:</strong> Fey</p>
       <p><strong>Size:</strong> Medium</p><p><strong>Speed:</strong> 30 feet</p>
       <p><strong><em>Hush.</em></strong> You are quiet.</p>`,
      "my-book",
    );
    expect(species?.entry).toMatchObject({ text: "Quiet" });
  });
});

describe("spells in a plain group", () => {
  const page = `
    <h3>Bog Hunter</h3>
    <div class="condensed-group"><p><strong>Ability Scores:</strong> Strength</p></div>
    <h3 class="h4-override">Mud Hound</h3>
    <p><em>Level 2 Conjuration (Druid, Ranger)</em></p>
    <div class="condensed-group">
      <p><strong>Casting Time:</strong> Action</p>
      <p><strong>Range:</strong> 10 feet</p>
      <p><strong>Components:</strong> V, S</p>
      <p><strong>Duration:</strong> 1 hour</p>
    </div>
    <p>A hound of mud appears.</p>
    <div class="stat-block"><h3>Mud Hound</h3><p>Medium Beast</p></div>
    <h3 class="h4-override">Grim Note</h3>
    <div class="condensed-group">
      <p><em>Water Cantrip (Druid)</em></p>
      <p><strong>Casting Time:</strong> Action</p>
      <p><strong>Range:</strong> Self</p>
      <p><strong>Components:</strong> V</p>
      <p><strong>Duration:</strong> Instantaneous</p>
    </div>
    <p>A note sounds.</p>`;

  it("reads spells whose group holds a Casting Time, and nothing else", () => {
    const spells = splitSpells(spellTextFromHtml(page));
    expect(spells.map((item) => [item.slug, item.problem])).toEqual([
      ["mud-hound", null],
      ["grim-note", null],
    ]);
  });

  it("keeps the spell's stat block in its text", () => {
    const [hound] = splitSpells(spellTextFromHtml(page));
    expect(hound?.text).toContain("A hound of mud appears.");
    expect(hound?.text).toContain("Medium Beast");
  });
});

describe("magic items", () => {
  it("reads a rarity printed in lowercase", () => {
    const [ball] = parseMagicItemsFromHtml(
      `<h2>Clouded Ball</h2><p><em>Wondrous Item, very rare (Requires Attunement)</em></p>
       <p>It is cloudy.</p>`,
      "my-book",
    );
    expect(ball?.entry).toMatchObject({
      category: "wondrousItem",
      rarity: "veryRare",
      attunement: true,
    });
  });
});
