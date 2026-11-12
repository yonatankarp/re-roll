import { describe, expect, it } from "vitest";
import { choiceOptions } from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  parseClassesFromHtml,
  parseFeaturesFromHtml,
  parseSubclassesFromHtml,
} from "../plugins/systems/dnd5.5e/core/import/classes.ts";
import { parseCompanionsFromHtml } from "../plugins/systems/dnd5.5e/core/import/companions.ts";
import { parseMonstersFromHtml } from "../plugins/systems/dnd5.5e/core/import/monsters.ts";
import { parseFeatsFromHtml } from "../plugins/systems/dnd5.5e/core/import/origins.ts";
import {
  parseDuration,
  spellImportKind,
  spellTextFromHtml,
  splitSpells,
} from "../plugins/systems/dnd5.5e/core/import/spells.ts";
import {
  parseBastionsFromHtml,
  parseLookupsFromHtml,
} from "../plugins/systems/dnd5.5e/core/import/tables.ts";
import {
  BastionEntrySchema,
  ClassSchema,
  LookupTableSchema,
  MonsterSchema,
  SubclassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";

const entryOf = (
  parsed: readonly { readonly slug: string; readonly entry: unknown }[],
  slug: string,
): Record<string, unknown> =>
  parsed.find((item) => item.slug === slug)?.entry as Record<string, unknown>;

const classPage = `
  <h1>Opening</h1>
  <h1 class="with-metadata">The Thornwarden</h1>
  <table><caption><h2>Core Thornwarden Traits</h2></caption>
    <tr><th>Primary Ability</th><td>Wisdom</td></tr>
    <tr><th>Hit Point Die</th><td>D8 per level</td></tr>
    <tr><th>Saving Throw Proficiencies</th><td>Wisdom and Charisma</td></tr>
    <tr><th>Skill Proficiencies</th><td>Choose 2: Nature or Survival</td></tr>
    <tr><th>Weapon Proficiencies</th><td>Simple weapons</td></tr>
    <tr><th>Armor Training</th><td>Light armor</td></tr>
  </table>
  <h2>Becoming a Thornwarden...</h2>
  <h3 class="h4-override">As a Level 1 Character</h3><p>Take the traits.</p>
  <h2>Thornwarden Class Features</h2>
  <table><caption><h3>Thornwarden Features</h3></caption>
    <tr><th colspan="2"></th><th>Spell Slots</th></tr>
    <tr><th>Level</th><th>Class Features</th><th>Cantrips</th><th>1</th></tr>
    <tr><td>1</td><td><a href="#L1Bramble">Bramble</a></td><td>2</td><td>2</td></tr>
    <tr><td>3</td><td><a href="#L3Sub">Thornwarden Subclass</a></td><td>2</td><td>3</td></tr>
  </table>
  <h3 id="L1Bramble">Level 1: Bramble</h3><p>Wisdom is your spellcasting ability.</p>
  <h3 id="L3Sub">Level 3: Thornwarden Subclass</h3><p>Pick a path.</p>
  <h3>Thornwarden Spell List</h3>
  <table><caption><h4>Cantrips (Level 0 Thornwarden Spells)</h4></caption>
    <tr><th>Spell</th><th>School</th></tr>
    <tr><td><a href="/spells/1">Spark</a></td><td>Evocation</td></tr>
  </table>
  <table><caption><h4>Level 1 Thornwarden Spells</h4></caption>
    <tr><th>Spell</th><th>School</th></tr>
    <tr><td>Grow*</td><td>Transmutation</td></tr>
    <tr><td>Lost Spell</td><td>Abjuration</td></tr>
    <tr><td>Thorn Servant*</td><td>Conjuration</td></tr>
    <tr><td colspan="2">*Appears in this chapter.</td></tr>
  </table>
  <h2>Thornwarden Subclasses</h2><p>Paths.</p>
  <h3 class="with-metadata">Rootbound</h3><p>Roots.</p>
  <h4>Level 3: Deep Roots</h4><p>You root.</p>
  <h4 class="with-metadata">Root Golem</h4><p>A side box stays in the feature above.</p>
  <h4>Level 5: Deeper Roots</h4><p>You root further.</p>
  <h2>Spell</h2>
  <h3>Thorn Servant</h3>
  <p class="x"><em>Level 2 Conjuration (Thornwarden)</em></p>
  <div class="spell-components"><p><strong>Casting Time:</strong> Action</p>
    <p><strong>Range:</strong> Touch</p><p><strong>Components:</strong> V</p>
    <p><strong>Duration:</strong> Instantaneous</p></div>
  <p>It grows.</p>
  <h1>Character Options</h1><p>Not part of the class.</p>`;

describe("a class that is a chapter of its own", () => {
  const known = [
    "phb:spell/spark",
    "srd52:spell/spark",
    "phb:spell/grow",
    "phb:class/fighter",
  ];
  const [thornwarden] = parseClassesFromHtml(classPage, "my-book", known);

  it("finds the class under an h1 with its name after The", () => {
    expect(ClassSchema.parse(thornwarden?.entry)).toMatchObject({
      id: "my-book:class/thornwarden",
      name: "Thornwarden",
      spellcasting: { ability: "wis" },
    });
  });

  it("links the level table to features one heading level higher", () => {
    const levels = ClassSchema.parse(thornwarden?.entry).levels;
    expect(levels.map((level) => [level.level, level.grants])).toEqual([
      [1, ["my-book:feature/thornwarden-bramble"]],
      [3, ["my-book:feature/thornwarden-thornwarden-subclass"]],
    ]);
    expect(thornwarden?.notes.join()).not.toContain("no feature");
  });

  it("lists spells from its chapter, and reports names it can't find", () => {
    expect(ClassSchema.parse(thornwarden?.entry).spellList).toEqual([
      "phb:spell/spark",
      "phb:spell/grow",
      "my-book:spell/thorn-servant",
    ]);
    expect(thornwarden?.notes).toEqual([
      "spell list names not found: Lost Spell",
    ]);
  });

  it("reads subclasses with plain headings and keeps side boxes in the text", () => {
    const subclasses = parseSubclassesFromHtml(classPage, "my-book");
    expect(
      SubclassSchema.parse(entryOf(subclasses, "thornwarden-rootbound")).levels,
    ).toMatchObject([
      {
        level: 3,
        grants: ["my-book:feature/thornwarden-rootbound-deep-roots"],
      },
      {
        level: 5,
        grants: ["my-book:feature/thornwarden-rootbound-deeper-roots"],
      },
    ]);
    const features = parseFeaturesFromHtml(classPage, "my-book");
    expect(features.map((item) => item.slug)).toEqual([
      "thornwarden-bramble",
      "thornwarden-thornwarden-subclass",
      "thornwarden-rootbound-deep-roots",
      "thornwarden-rootbound-deeper-roots",
    ]);
    expect(
      entryOf(features, "thornwarden-rootbound-deep-roots").text,
    ).toContain("side box");
  });

  it("doesn't list spells for a class whose spells already name it", () => {
    const [handbook] = parseClassesFromHtml(
      `<h2>Bard</h2>
       <table><caption><h3>Core Bard Traits</h3></caption>
         <tr><th>Primary Ability</th><td>Charisma</td></tr>
         <tr><th>Hit Point Die</th><td>D8 per level</td></tr></table>
       <h3>Bard Class Features</h3>
       <table><caption><h4>Bard Features</h4></caption>
         <tr><th>Level</th><th>Class Features</th></tr><tr><td>1</td><td>None</td></tr></table>
       <table><caption><h4>Level 1 Bard Spells</h4></caption>
         <tr><th>Spell</th><th>School</th></tr><tr><td>Spark</td><td>Evocation</td></tr></table>`,
      "phb",
      known,
    );
    expect(handbook?.entry).not.toHaveProperty("spellList");
  });

  it("offers listed spells alongside those that name the class", () => {
    const classDef = ClassSchema.parse(thornwarden?.entry);
    const spell = (id: string, name: string, classes: string[]) => ({
      id,
      name,
      level: 0,
      school: "evocation",
      classes,
      castingTime: "Action",
      ritual: false,
      range: "Self",
      components: "V",
      duration: "instantaneous",
      text: name,
      automation: "text",
    });
    const content = new Map<string, Record<string, unknown>>([
      [classDef.id, classDef],
      ["phb:spell/spark", spell("phb:spell/spark", "Spark", [])],
      ["my-book:spell/bud", spell("my-book:spell/bud", "Bud", [classDef.id])],
      ["phb:spell/other", spell("phb:spell/other", "Other", [])],
      [
        "my-book:background/b",
        {
          id: "my-book:background/b",
          name: "B",
          abilities: ["str", "dex", "con"],
          feat: "my-book:feat/f",
          skills: ["arcana", "nature"],
          tool: "Tools",
        },
      ],
    ]);
    const access = {
      content: (id: string) => content.get(id) as never,
      contentIds: () => [...content.keys()],
    };
    const { options } = choiceOptions(
      {
        kind: "spells",
        id: "cantrips",
        count: 1,
        list: classDef.id,
        maxLevel: 0,
      },
      { picks: {}, backgroundId: "my-book:background/b" } as never,
      null,
      classDef,
      access,
    );
    expect(options.map((item) => item.id).sort()).toEqual([
      "my-book:spell/bud",
      "phb:spell/spark",
    ]);
  });
});

it("reads Dragonmark feats as their own category", () => {
  const feats = parseFeatsFromHtml(
    `<h4>Mark of Moss</h4><p><em>Dragonmark Feat (Prerequisite: None)</em></p><p>Moss.</p>`,
    "my-book",
  );
  expect(entryOf(feats, "mark-of-moss")).toMatchObject({
    category: "dragonmark",
  });
});

const block = (
  classes: string,
  name: string,
  body: string,
  cell = (label: string) => `<th>${label}</th>`,
): string => `<div class="${classes}"><h3>${name}</h3>
  <p>Medium Beast</p><p><strong>AC</strong> 12</p><p><strong>HP</strong> 9 (2d8)</p><p><strong>Speed</strong> 30 ft.</p>
  <div class="stats"><table><tbody>
  ${["STR", "DEX", "CON", "INT", "WIS", "CHA"].map((label) => `<tr>${cell(label)}<td>10</td><td>+0</td><td>+0</td></tr>`).join("")}
  </tbody></table></div>${body}</div>`;

const bite = (damage: string): string =>
  `<p class="monster-header">Actions</p><p><strong><em>Bite.</em></strong> <em>Melee Attack Roll:</em> +4, reach 5 ft. <em>Hit:</em> ${damage}.</p>`;

describe("stat blocks the parser used to skip", () => {
  it("accepts a book's own classes on a block, but not the worked example", () => {
    const parsed = parseMonstersFromHtml(
      [
        block(
          "stat-block darklord-stat-block darklord--moss",
          "Moss Lord",
          bite("5 (1d6 + 2) Piercing damage"),
        ),
        block(
          "stat-block ui-draggable",
          "Moss Hound",
          bite("5 (1d6 + 2) Piercing damage"),
        ),
        block(
          "stat-block example-stat-block",
          "Example",
          bite("5 (1d6 + 2) Piercing damage"),
        ),
        block(
          "stat-block-defined",
          "Definition",
          bite("5 (1d6 + 2) Piercing damage"),
        ),
      ].join(""),
      "my-book",
    );
    expect(parsed.map((item) => item.slug)).toEqual([
      "moss-lord",
      "moss-hound",
    ]);
  });

  it("reads ability names in bold cells", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "stat-block lamordia-stats",
        "Moss Man",
        bite("5 (1d6 + 2) Piercing damage"),
        (label) => `<td><strong>${label}</strong></td>`,
      ),
      "my-book",
    );
    expect(MonsterSchema.parse(parsed?.entry).abilities.str).toBe(10);
  });

  it("reads a minus written as an en dash", () => {
    const [parsed] = parseMonstersFromHtml(
      block("stat-block", "Moss Pup", bite("1 (1d4 – 1) Piercing damage")),
      "my-book",
    );
    expect(
      MonsterSchema.parse(parsed?.entry).actions[0]?.activation.resolution,
    ).toMatchObject({
      damage: [
        { amount: { dice: "1d4", bonus: { base: -1 } }, type: "piercing" },
      ],
    });
  });

  it.each([
    ["3 (1d6) Necrotic or Radiant damage (its choice)", "necrotic"],
    ["3 (1d6) damage of a type it picks: Acid, Cold, or Fire", "acid"],
  ])(
    "takes the first type when a block has only a choice: %s",
    (damage, type) => {
      const [parsed] = parseMonstersFromHtml(
        block("stat-block", "Moss Spirit", bite(damage)),
        "my-book",
      );
      expect(
        MonsterSchema.parse(parsed?.entry).actions[0]?.activation.resolution,
      ).toMatchObject({
        damage: [{ type }],
      });
      expect(parsed?.notes).toContain(
        "partial: Bite: left out a choice of damage type",
      );
    },
  );

  it("reads a choice of damage type as the first, in a block with other actions too", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "stat-block",
        "Moss Knight",
        `${bite("5 (1d6 + 2) Piercing damage")}<p><strong><em>Lash.</em></strong> <em>Melee Attack Roll:</em> +4, reach 5 ft. <em>Hit:</em> 3 (1d6) Cold or Fire damage.</p>`,
      ),
      "my-book",
    );
    expect(
      MonsterSchema.parse(parsed?.entry).actions.map((item) => item.name),
    ).toEqual(["Bite", "Lash"]);
    expect(parsed?.notes).toContain(
      "partial: Lash: left out a choice of damage type",
    );
  });

  it("keeps a creature with no automated action for reading", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "stat-block",
        "Moss Puff",
        `<p class="monster-header">Reactions</p><p><strong><em>Puff.</em></strong> It puffs.</p>`,
      ),
      "my-book",
    );
    expect(MonsterSchema.parse(parsed?.entry)).toMatchObject({
      name: "Moss Puff",
      actions: [],
    });
  });

  it("makes a creature whose attack comes from its caster a companion, not a monster", () => {
    const page = block(
      "stat-block",
      "Moss Doll",
      `<p class="monster-header">Actions</p><p><strong><em>Slam.</em></strong> <em>Melee Attack Roll:</em> Bonus equals your spell attack modifier, reach 5 ft. <em>Hit:</em> Force damage.</p>`,
    );
    expect(parseMonstersFromHtml(page, "my-book")).toEqual([]);
    expect(
      parseCompanionsFromHtml(page, "my-book").map((item) => item.slug),
    ).toEqual(["moss-doll"]);
  });

  it("finds a stat block in a plain frame, and no other frame", () => {
    const parsed = parseMonstersFromHtml(
      `<div class="Basic-Text-Frame"><p>A sidebar.</p></div>
       <div class="Basic-Text-Frame"><p class="Stat-Block-Styles_Stat-Block-Title">Moss Servant</p>
       <p>Tiny construct</p><p><span>Armor Class</span> 15</p><p><span>Hit Points</span> 10 (4d4)</p>
       <p><span>Speed</span> 30 ft.</p>
       <div class="stat-block-ability-scores">${["STR", "DEX", "CON", "INT", "WIS", "CHA"].map((label) => `<div class="stat-block-ability-scores-heading">${label}</div><div class="stat-block-ability-scores-score">10</div>`).join("")}</div></div>`,
      "my-book",
    );
    expect(parsed.map((item) => item.slug)).toEqual(["moss-servant"]);
  });
});

const olderPage = `
  <h1>Chapter 1: Subclasses</h1>
  <h2>Barbarian</h2>
  <h3>Totems</h3><h4 class="Table-Title">Totems</h4><table><tr><th>d6</th><th>Totem</th></tr></table>
  <h2>Moss Path</h2>
  <h4 class="Table-Title">Moss Path Features</h4>
  <table><tr><th>Barbarian Level</th><th>Feature</th></tr><tr><td>3rd</td><td>Soft Step</td></tr></table>
  <h4>Bonus Moss</h4><p>You gain moss.</p>
  <h4 class="Table-Title">Moss List</h4><table><tr><th>Level</th><th>Moss</th></tr><tr><td>1st</td><td>Green</td></tr></table>
  <h4>Soft Step</h4><p>At 3rd level, you step softly.</p>
  <h4>Quiet Step</h4><p>Starting at 6th level, you step quietly.</p>
  <h4>Still Step</h4><p>At 14th level, you stop.</p>
  <h2>Warlock</h2>
  <h2>Eldritch Invocations</h2>
  <h4>Moss Tongue</h4><p class="m">Prerequisite: 5th level</p><p>You speak moss.</p>
  <h4>Moss Eye</h4><p class="m">Prerequisite: 7th level</p><p>You see moss.</p>
  <h4>Moss Ear</h4><p class="m">Prerequisite: 9th level</p><p>You hear moss.</p>
  <h1>Chapter 1: Racial Feats</h1>
  <h2>Racial Feat Descriptions</h2>
  <h3>Mossy Luck</h3><p class="m">Prerequisite: Halfling</p><p>Lucky moss.</p>
  <h1>Chapter 3: Spells</h1>
  <h2>Spell Lists</h2>
  <h3>Bard Spells</h3><div class="compendium-spell-lists"><p><a href="#x">Moss Burst</a></p></div>
  <h3>Wizard Spells</h3><div class="compendium-spell-lists"><p><a href="#x">Moss Burst</a></p><p><a href="#y">Moss Spark</a></p></div>
  <h2>Spell Descriptions</h2>
  <h3>Moss Burst</h3>
  <p class="Core-Metadata">3rd-level evocation (ritual)</p>
  <p class="h"><span>Casting Ti</span><span>me:</span> 1 action</p>
  <p class="h"><span>Range:</span> 30 feet</p>
  <p class="h"><span>Components:</span> V, S</p>
  <p class="h"><span>Duration:</span> Instantaneous</p>
  <p>Moss bursts.</p>
  <h3>Moss Spark</h3>
  <p></p>
  <p class="Core-Metadata">Evocation cantrip</p>
  <p class="h"><span>Casting Time:</span> 1 action</p>
  <p class="h"><span>Range:</span> 30 feet</p>
  <p class="h"><span>Components:</span> V</p>
  <p class="h"><span>Duration:</span> Instantaneous or 1 hour (see below)</p>
  <p>Moss sparks.</p>`;

describe("2014-format books", () => {
  it("hides a 2014 subclass from character creation, with its features ready", () => {
    const subclasses = parseSubclassesFromHtml(olderPage, "older-book", [
      "phb:class/barbarian",
    ]);
    expect(subclasses.map((item) => item.slug)).toEqual([
      "barbarian-moss-path",
    ]);
    const moss = SubclassSchema.parse(subclasses[0]?.entry);
    expect(moss).toMatchObject({
      class: "phb:class/barbarian",
      edition: "2014",
    });
    expect(
      moss.levels.map((level) => [level.level, level.grants.length]),
    ).toEqual([
      [3, 2],
      [6, 1],
      [14, 1],
    ]);
    const classDef = ClassSchema.parse({
      id: "phb:class/barbarian",
      name: "Barbarian",
      hitDie: "d12",
      primaryAbilities: ["str"],
      savingThrows: ["str"],
      weapons: ["simple"],
      armor: [],
      levels: [{ level: 1 }],
    });
    const current = {
      id: "phb:subclass/barbarian-berserker",
      name: "Berserker",
      class: classDef.id,
      levels: [{ level: 3 }],
    };
    // Sorting first, it would hide the current printing if names were compared before the edition.
    const olderPrinting = {
      ...moss,
      id: "a-older:subclass/barbarian-berserker",
      name: "Berserker",
    };
    const content = new Map<string, unknown>([
      [olderPrinting.id, olderPrinting],
      [moss.id, moss],
      [current.id, current],
      [
        "b:background/b",
        {
          id: "b:background/b",
          name: "B",
          abilities: ["str", "dex", "con"],
          feat: "b:feat/f",
          skills: ["arcana", "nature"],
          tool: "Tools",
        },
      ],
    ]);
    const { options } = choiceOptions(
      { kind: "subclass", id: "subclass" },
      { picks: {}, backgroundId: "b:background/b" } as never,
      null,
      classDef,
      {
        content: (id: string) => content.get(id) as never,
        contentIds: () => [...content.keys()],
      },
    );
    expect(options.map((item) => item.label)).toEqual(["Berserker"]);
  });

  it("keeps a table with the feature above it", () => {
    const features = parseFeaturesFromHtml(olderPage, "older-book");
    expect(entryOf(features, "barbarian-moss-path-bonus-moss").text).toContain(
      "Green",
    );
  });

  it("reads racial feats in a category no level asks for", () => {
    const feats = parseFeatsFromHtml(olderPage, "older-book");
    expect(feats.map((item) => item.slug)).toEqual(["mossy-luck"]);
    expect(entryOf(feats, "mossy-luck")).toMatchObject({ category: "racial" });
  });

  it("turns spells into plain text with the classes from their spell lists", () => {
    const [burst, spark] = splitSpells(spellTextFromHtml(olderPage));
    expect(burst?.problem).toBeNull();
    expect(burst?.data).toMatchObject({
      name: "Moss Burst",
      level: 3,
      school: "evocation",
      classNames: ["Bard", "Wizard"],
      ritual: true,
    });
    expect(burst?.text).toContain("2014 rules.");
    expect(spark?.data).toMatchObject({
      level: 0,
      school: "evocation",
      classNames: ["Wizard"],
    });
  });

  it("reads a 1 action casting time, so the spell can be cast and picked", () => {
    const [burst] = splitSpells(spellTextFromHtml(olderPage));
    if (!burst) throw new Error("no spell");
    const built = spellImportKind.build({
      source: burst,
      draft: {
        encoding: {
          targeting: { creatures: 1, range: 30, side: "enemy" },
          resolution: {
            kind: "save",
            ability: "dex",
            dc: { add: [{ kind: "spellSaveDc" }] },
            damage: [{ amount: { dice: "2d6" }, type: "acid" }],
          },
        },
      },
      reference: undefined,
      pluginId: "older-book",
      knownIds: ["phb:class/bard", "phb:class/wizard"],
    });
    expect(built.entry).toMatchObject({
      classes: ["phb:class/bard", "phb:class/wizard"],
      activation: { cost: ["action", "slot"] },
    });
  });

  it("keeps a duration it can't model as text", () => {
    expect(parseDuration("Instantaneous or 1 hour (see below)")).toEqual({
      text: "Instantaneous or 1 hour (see below)",
    });
  });
});

describe("keyed tables and Bastions", () => {
  it("reads a table keyed by Challenge Rating or theme, and no other", () => {
    const parsed = parseLookupsFromHtml(
      `<h2>Moss Hoards</h2>
       <table><caption><h3>Random Moss Hoard</h3></caption>
         <tr><th>CR</th><th>Coins</th></tr><tr><td>0–4</td><td>2d4</td></tr><tr><td>5+</td><td>3d4</td></tr></table>
       <table><tr><th>Theme</th><th>Treasure</th></tr><tr><td>Moss</td><td>Spores</td></tr></table>
       <table><tr><th>d6</th><th>Result</th></tr><tr><td>1–6</td><td>None</td></tr></table>`,
      "my-book",
    );
    expect(parsed.map((item) => item.slug)).toEqual([
      "random-moss-hoard",
      "moss-hoards",
    ]);
    expect(LookupTableSchema.parse(parsed[0]?.entry)).toMatchObject({
      keyedBy: "CR",
      columns: ["Coins"],
      rows: [
        { key: "0–4", cells: ["2d4"] },
        { key: "5+", cells: ["3d4"] },
      ],
    });
  });

  it("reads facilities with the facts from their table, and events", () => {
    const parsed = parseBastionsFromHtml(
      `<h1>Bastions of Moss</h1>
       <h2>Special Facilities</h2><h3>Requirements</h3><p>Rules for all of them.</p>
       <table><caption><h3>Special Facilities</h3></caption>
         <tr><th>Level</th><th>Special Facility</th><th>Prerequisite</th><th>Order</th></tr>
         <tr><td>5</td><td>Moss Room</td><td>None</td><td>Craft</td></tr>
         <tr><td>9</td><td>Moss Hall</td><td>Moss Lore</td><td>Trade</td></tr>
       </table>
       <h2>Special Facility Descriptions</h2>
       <h3 class="h4-override">Moss Room</h3><p>A room.</p>
       <h3 class="h4-override">Moss Hall</h3><p>A hall.</p>
       <h2>Bastion Events</h2><h3>Event Descriptions</h3>
       <h4 class="h3-override">Moss Rain</h4><p>It rains moss.</p>
       <h1>Next Chapter</h1><h3>Moss Room</h3><p>Another book section.</p>`,
      "my-book",
    );
    expect(
      parsed.map((item) => BastionEntrySchema.parse(item.entry)),
    ).toMatchObject([
      {
        name: "Moss Room",
        type: "facility",
        level: 5,
        order: "Craft",
        text: "A room.",
      },
      {
        name: "Moss Hall",
        type: "facility",
        level: 9,
        prerequisite: "Moss Lore",
      },
      { name: "Moss Rain", type: "event", text: "It rains moss." },
    ]);
    expect(entryOf(parsed, "moss-room")).not.toHaveProperty("prerequisite");
  });
});
