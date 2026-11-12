import { parse, stringify } from "yaml";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import {
  type LoadResult,
  loadRun,
  scanPlugins,
} from "../engine/kernel/loader.ts";
import type { ModelClient, ModelRequest } from "../engine/prep/model.ts";
import { checkPlugins } from "../engine/tools/check-pack.ts";
import {
  approveImport,
  importParsed,
  importSource,
  splitSource,
} from "../engine/tools/import.ts";
import {
  describeEncoding,
  parseDuration,
  shapeProblems,
  spellTextFromHtml,
  sourceProblems,
  splitSpells,
} from "../plugins/systems/dnd5.5e/core/import/spells.ts";
import {
  parseClassesFromHtml,
  parseFeaturesFromHtml,
  parseSubclassesFromHtml,
} from "../plugins/systems/dnd5.5e/core/import/classes.ts";
import { parseEquipmentFromHtml } from "../plugins/systems/dnd5.5e/core/import/equipment.ts";
import { parseMonstersFromHtml } from "../plugins/systems/dnd5.5e/core/import/monsters.ts";
import {
  parseBackgroundsFromHtml,
  parseFeatsFromHtml,
  parseSpeciesFromHtml,
} from "../plugins/systems/dnd5.5e/core/import/origins.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";
import {
  BackgroundSchema,
  ClassSchema,
  FeatSchema,
  FeatureSchema,
  ItemSchema,
  SubclassSchema,
  MonsterSchema,
  SpeciesSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { memoryStorage } from "./memory-storage.ts";

const FIXTURE = "tests/fixtures/import/srd-gold-spells.txt";
const fixtureText = (): Promise<string> => readFile(FIXTURE, "utf8");

const NO_DIFFERENCES = { differences: [] };

const FIREBOLT_DRAFT = {
  encoding: {
    targeting: { creatures: 1, range: 120, side: "enemy" },
    resolution: {
      kind: "attack",
      attack: { type: "spell" },
      damage: [{ amount: { dice: "1d10" }, type: "fire" }],
    },
  },
};

function scripted(answers: readonly unknown[]): ModelClient & {
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete(request) {
      const answer = answers[requests.length];
      requests.push(request);
      return Promise.resolve({
        text: typeof answer === "string" ? answer : JSON.stringify(answer),
        finishReason: "stop",
        completionTokens: 1,
        durationMs: 1,
      });
    },
  };
}

const known = ["srd52:class/wizard", "srd52:class/cleric"];

const onlyFireBolt = {
  only: (source: { readonly slug: string }) => source.slug === "fire-bolt",
};

describe("splitting SRD spell text", () => {
  it("finds each spell with its own description", async () => {
    const byName = new Map(
      splitSpells(await fixtureText()).map((item) => [item.name, item]),
    );
    expect([...byName.keys()].sort()).toEqual([
      "Bless",
      "Cure Wounds",
      "Fire Bolt",
      "Fireball",
      "Healing Word",
      "Magic Missile",
      "Sacred Flame",
      "Shield",
    ]);
    const phrases: Record<string, string> = {
      Bless: "bless up to three",
      "Fire Bolt": "mote of fire",
      Fireball: "8d6 Fire damage",
      "Sacred Flame": "1d8 Radiant",
      Shield: "barrier of magical force",
      "Healing Word": "2d4 plus",
      "Cure Wounds": "2d8 plus",
    };
    for (const [name, phrase] of Object.entries(phrases)) {
      const { description } = byName.get(name)?.data as { description: string };
      expect(description).toContain(phrase);
    }
  });

  it("removes page numbers and footers from inside entries", async () => {
    const bless = splitSpells(await fixtureText()).find(
      (item) => item.name === "Bless",
    );
    expect(bless?.problem).toBeNull();
    expect(bless?.data).toMatchObject({
      range: "30 feet",
      components: "V, S, M (a Holy Symbol worth 5+ GP)",
      duration: { concentration: true, minutes: 1 },
    });
    expect(bless?.text).not.toContain("System Reference Document");
  });

  it("handles class lists and casting times that wrap onto another line", async () => {
    const spells = splitSpells(await fixtureText());
    expect(
      spells.find((item) => item.name === "Cure Wounds")?.data,
    ).toMatchObject({
      level: 1,
      school: "abjuration",
      classNames: ["Bard", "Cleric", "Druid", "Paladin", "Ranger"],
    });
    expect(spells.find((item) => item.name === "Shield")?.data).toMatchObject({
      castingTime:
        "Reaction, which you take when you are hit by an attack roll or targeted by the Magic Missile spell",
      duration: { until: "yourNextTurnStart" },
    });
  });

  it("reads a cantrip as level 0", async () => {
    const bolt = splitSpells(await fixtureText()).find(
      (item) => item.name === "Fire Bolt",
    );
    expect(bolt?.data).toMatchObject({ level: 0, school: "evocation" });
  });

  it("flags an entry it can't read, rather than guessing", () => {
    const [entry] = splitSpells(
      "Odd Spell\nLevel 2 Illusion (Wizard)\nCasting Time: Action\nRange: Self\nComponents: V\nDuration: Until the moon sets\nText.\n",
    );
    expect(entry?.problem).toContain("duration");
  });

  it("flags an entry with a missing field", () => {
    const [entry] = splitSpells(
      "Odd Spell\nLevel 2 Illusion (Wizard)\nCasting Time: Action\nText.\n",
    );
    expect(entry?.problem).toContain("missing field");
  });

  it("reports duplicate names", () => {
    const entry =
      "Twin\nLevel 2 Illusion (Wizard)\nCasting Time: Action\nRange: Self\nComponents: V\nDuration: Instantaneous\nText.\n";
    const { sources, duplicates } = splitSource(
      dnd55e,
      "spells",
      `${entry}${entry}`,
    );
    expect(sources).toHaveLength(1);
    expect(duplicates).toEqual(["Twin"]);
  });

  it.each([
    ["Instantaneous", "instantaneous"],
    ["1 round", { until: "yourNextTurnStart" }],
    ["Concentration, up to 1 minute", { concentration: true, minutes: 1 }],
    ["Concentration, up to 10 minutes", { concentration: true, minutes: 10 }],
    ["1 hour", { minutes: 60 }],
    ["8 hours", { minutes: 480 }],
    ["Until dispelled", { text: "Until dispelled" }],
    ["Until dispelled or triggered", { text: "Until dispelled or triggered" }],
    ["Special", { text: "Special" }],
    ["Up to 8 hours", { minutes: 480 }],
    ["Concentration up to 10 minutes", { concentration: true, minutes: 10 }],
    ["Until the moon sets", null],
  ])("reads the duration %s", (text, expected) => {
    expect(parseDuration(text)).toEqual(expected);
  });
});

describe("checking an encoding against the source", () => {
  const text =
    "A target must make a Dexterity saving throw, taking 2d6 Fire damage.";
  const encoding = (overrides: object) => ({
    targeting: { creatures: 1, range: 60, side: "enemy" as const },
    resolution: {
      kind: "save" as const,
      ability: "dex" as const,
      dc: { base: 0, add: [] },
      damage: [{ amount: { dice: "2d6" }, type: "fire" as const }],
      onSuccessDamage: "none" as const,
      onFail: [],
      onSuccess: [],
      ...overrides,
    },
  });

  it("accepts what the text says", () => {
    expect(sourceProblems(encoding({}), text)).toEqual([]);
  });

  it("requires self or an area when the range is Self", () => {
    expect(sourceProblems(encoding({}), text, "Self").join()).toContain("Self");
    expect(sourceProblems(encoding({}), text, "60 feet")).toEqual([]);
  });

  const withBonus = (amount: object) => ({
    targeting: { creatures: 1, range: 60, side: "ally" as const },
    resolution: {
      kind: "automatic" as const,
      damage: [],
      effects: [
        {
          kind: "modifier" as const,
          duration: "instantaneous" as const,
          modifier: { kind: "bonus" as const, to: "ac" as const, amount },
        },
      ],
    },
  });

  it("rejects a bonus with no amount", () => {
    expect(sourceProblems(withBonus({}), "Grants a bonus.").join()).toContain(
      "no amount",
    );
  });

  it("rejects a bonus number that isn't in the text", () => {
    const wrong = withBonus({ bonus: { base: 5, add: [] } });
    expect(sourceProblems(wrong, "A +2 bonus to AC.").join()).toContain("5");
    expect(sourceProblems(wrong, "A +5 bonus to AC.")).toEqual([]);
  });

  it("rejects invented dice", () => {
    const wrong = encoding({
      damage: [{ amount: { dice: "9d6" }, type: "fire" }],
    });
    expect(sourceProblems(wrong, text).join()).toContain("9d6");
  });

  it("rejects an invented damage type", () => {
    const wrong = encoding({
      damage: [{ amount: { dice: "2d6" }, type: "cold" }],
    });
    expect(sourceProblems(wrong, text).join()).toContain("cold");
  });

  it("rejects the wrong saving throw", () => {
    expect(sourceProblems(encoding({ ability: "wis" }), text).join()).toContain(
      "wis",
    );
  });
});

describe("reading a saved book page", () => {
  const page = `<h2 id="Spells">Spells</h2>
    <h3 class="h4-override with-metadata" id="Zap"><a href="#Zap"></a><a class="spell-tooltip">Zap &amp; Bang</a></h3>
    <p data-x="1"><em>Level 1 Evocation (Wizard)</em></p>
    <div class="spell-components" data-x="2">
      <p><strong>Casting Time:</strong> Action</p>
      <p><strong>Range:</strong> 60 feet</p>
      <p><strong>Components:</strong> V</p>
      <p><strong>Duration:</strong> Instantaneous</p>
    </div>
    <p>Deal <a class="rule-tooltip">1d6</a> Fire damage.</p>
    <p><strong><em>Using a Higher-Level Spell Slot.</em></strong> More.</p>
    <h3 class="h4-override with-metadata" id="Calm"><a class="spell-tooltip">Calm</a></h3>
    <p><em>Abjuration Cantrip (Cleric)</em></p>
    <div class="spell-components">
      <p><strong>Casting Time:</strong> Action</p>
      <p><strong>Range:</strong> Self</p>
      <p><strong>Components:</strong> S</p>
      <p><strong>Duration:</strong> 1 hour</p>
    </div>
    <p>Stay calm.</p>
    <h2 id="Next">Appendix</h2><p>Not a spell.</p>`;

  it("produces text the splitter can read, without following sections", () => {
    const spells = splitSpells(spellTextFromHtml(page));
    expect(spells.map((spell) => spell.name)).toEqual(["Zap & Bang", "Calm"]);
    expect(spells.map((spell) => spell.problem)).toEqual([null, null]);
    expect(spells[0]?.data).toMatchObject({
      level: 1,
      range: "60 feet",
      description:
        "Deal 1d6 Fire damage. Using a Higher-Level Spell Slot. More.",
    });
    expect(spells[1]?.data).toMatchObject({
      level: 0,
      description: "Stay calm.",
    });
  });
});

describe("parsing a monster stat block", () => {
  const row = (name: string, score: number, mod: string, save: string) =>
    `<tr><th>${name}</th><td>${String(score)}</td><td>${mod}</td><td>${save}</td></tr>`;
  const page = `<div class="stat-block" data-x="1">
    <h3 id="Mire"><a class="monster-tooltip">Mire Beast</a></h3>
    <p>Large Monstrosity, Unaligned</p>
    <p><strong>AC</strong> 14 <strong>Initiative</strong> −1 (9)</p>
    <p><strong>HP</strong> 45 (6d10 + 12)</p>
    <p><strong>Speed</strong> 30 ft.</p>
    <div class="stats"><table class="physical"><tbody>
      ${row("Str", 18, "+4", "+4")}${row("Dex", 8, "−1", "−1")}${row("Con", 14, "+2", "+4")}
    </tbody></table><table class="mental"><tbody>
      ${row("Int", 3, "−4", "−4")}${row("Wis", 10, "+0", "+0")}${row("Cha", 6, "−2", "−2")}
    </tbody></table></div>
    <p><strong>CR</strong> 3 (XP 700; PB +2)</p>
    <p class="monster-header">Traits</p>
    <p><strong><em>Mudborn.</em></strong> It swims in mud.</p>
    <p class="monster-header">Actions</p>
    <p><strong><em>Multiattack.</em></strong> The beast makes two Bite attacks.</p>
    <p><strong><em>Bite.</em></strong> <em>Melee Attack Roll:</em> +6, reach 10 ft. <em>Hit:</em> 13 (2d8 + 4) Piercing damage plus 3 (1d6) Acid damage, or 15 (2d10 + 4) Piercing damage if it's wet. The target has the Grappled condition.</p>
    <p><strong><em>Mud Breath (Recharge 5–6).</em></strong> <em>Dexterity Saving Throw:</em> DC 13, each creature in a 15-foot Cone. <em>Failure:</em> 14 (4d6) Acid damage. <em>Success:</em> Half damage.</p>
    <p><strong><em>Stare.</em></strong> <em>Wisdom Saving Throw:</em> DC 12, one creature within 30 feet. <em>Failure:</em> The target has the Frightened condition until the end of its next turn.</p>
    <p><strong><em>Odd Trick.</em></strong> It does something unusual.</p>
    <p class="monster-header">Reactions</p>
    <p><strong><em>Slip.</em></strong> <em>Trigger:</em> It's hit. <em>Response:</em> It slips.</p>
  </div>`;
  const [parsed] = parseMonstersFromHtml(page, "my-book");
  const entry = MonsterSchema.parse(parsed?.entry);

  it("reads the numbers from the block", () => {
    expect(entry).toMatchObject({
      id: "my-book:monster/mire-beast",
      name: "Mire Beast",
      ac: 14,
      hp: 45,
      speed: 30,
      initiative: -1,
      proficiency: 2,
      multiattack: 2,
      saves: ["con"],
      abilities: { str: 18, dex: 8, con: 14, int: 3, wis: 10, cha: 6 },
    });
  });

  it("encodes an attack, its extra damage and its condition, without the alternative", () => {
    expect(entry.actions[0]).toMatchObject({
      name: "Bite",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 10, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", flatBonus: 6 },
          damage: [
            { amount: { dice: "2d8", bonus: { base: 4 } }, type: "piercing" },
            { amount: { dice: "1d6" }, type: "acid" },
          ],
          onHit: [{ kind: "applyCondition", condition: "grappled" }],
        },
      },
    });
    const bite = entry.actions[0]?.activation.resolution;
    expect(bite?.kind === "attack" ? bite.damage : []).toHaveLength(2);
  });

  it("turns extra damage on Advantage into a passive, not damage on every hit", () => {
    const [goblin] = parseMonstersFromHtml(
      page.replace(
        "plus 3 (1d6) Acid damage,",
        "plus 3 (1d6) Acid damage if the attack roll had Advantage,",
      ),
      "my-book",
    );
    const parsed = MonsterSchema.parse(goblin?.entry);
    const bite = parsed.actions[0]?.activation.resolution;
    expect(bite?.kind === "attack" ? bite.damage : []).toHaveLength(1);
    expect(parsed.passives).toEqual([
      {
        kind: "extraDamage",
        dice: "1d6",
        when: "advantage",
        oncePerTurn: false,
      },
    ]);
  });

  it("encodes a recharging area save", () => {
    expect(entry.actions[1]).toMatchObject({
      name: "Mud Breath",
      recharge: 5,
      activation: {
        cost: ["action", { resource: "recharge:mud-breath" }],
        targeting: { area: { shape: "cone", radius: 15 } },
        resolution: {
          kind: "save",
          ability: "dex",
          dc: { base: 13 },
          onSuccessDamage: "half",
        },
      },
    });
  });

  it("encodes a condition save with its range and short duration", () => {
    expect(entry.actions[2]).toMatchObject({
      name: "Stare",
      activation: {
        targeting: { creatures: 1, range: 30 },
        resolution: {
          kind: "save",
          onFail: [
            {
              condition: "frightened",
              duration: { until: "yourNextTurnStart" },
            },
          ],
        },
      },
    });
  });

  it("names what it couldn't automate, rather than guessing", () => {
    expect(entry.actions).toHaveLength(3);
    expect(parsed?.notes).toEqual([
      "not automated: Mudborn",
      "not automated: Odd Trick",
      "not automated: Slip",
    ]);
  });

  const withActions = (...actions: readonly string[]) => {
    const [item] = parseMonstersFromHtml(
      page.replace(
        /<p class="monster-header">Actions[\s\S]*<\/div>$/,
        `<p class="monster-header">Actions</p>${actions.join("")}</div>`,
      ),
      "my-book",
    );
    return {
      entry: MonsterSchema.parse(item?.entry),
      notes: item?.notes ?? [],
    };
  };
  const action = (name: string, body: string) =>
    `<p><strong><em>${name}.</em></strong> ${body}</p>`;
  const claw = action(
    "Claw",
    "<em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Slashing damage.",
  );
  const saveOn = (rule: string, failure: string) =>
    `<em>Wisdom Saving Throw:</em> DC 13, ${rule} <em>Failure:</em> ${failure}`;

  it.each([
    ["The beast makes two Claw attacks.", 2],
    ["The beast makes one Claw attack and one Bite attack.", 2],
    [
      "The beast makes one Ram attack, one Claw attack, and one Bite attack.",
      3,
    ],
    [
      "The beast makes one Bite attack and three other attacks, using Claw or Tail in any combination.",
      4,
    ],
    [
      "The beast makes two Claw attacks, uses Reel, and makes two Bite attacks.",
      4,
    ],
    [
      "The beast makes three Claw attacks. It can replace one attack with a use of Spit.",
      3,
    ],
    ["The beast makes three Claw attacks or two Spit attacks.", 3],
    [
      "The beast makes one Claw attack and one Bite attack, or it makes two Spit attacks.",
      2,
    ],
    ["The beast uses Spit and makes one Claw attack.", 1],
    ["The beast uses Claw three times.", 3],
    ["The beast uses Gaze twice.", 2],
  ])("counts the routine %s", (routine, count) => {
    expect(
      withActions(action("Multiattack", routine), claw).entry.multiattack,
    ).toBe(count);
  });

  it("names a multiattack whose count depends on something else", () => {
    const { entry, notes } = withActions(
      action(
        "Multiattack",
        "The beast makes a number of Claw attacks equal to half its level.",
      ),
      claw,
    );
    expect(entry.multiattack).toBe(1);
    expect(notes).toContain("not automated: Multiattack count");
  });

  it("applies only the first stage of a staged condition", () => {
    const { entry, notes } = withActions(
      action(
        "Stony Stare",
        `<em>Constitution Saving Throw:</em> DC 12, each creature in a 15-foot Cone. <em>First Failure:</em> The target has the Restrained condition and repeats the save at the end of its next turn if it is still Restrained. <em>Second Failure:</em> The target has the Petrified condition instead. <em>Success:</em> Half damage.`,
      ),
    );
    const stare = entry.actions[0]?.activation.resolution;
    expect(stare?.kind === "save" ? stare.onFail : []).toMatchObject([
      { condition: "restrained", repeatSave: true },
    ]);
    expect(stare?.kind === "save" ? stare.onFail : []).toHaveLength(1);
    expect(notes).toContain(
      "partial: Stony Stare: left out a later failure stage",
    );
  });

  it("treats a failure by a margin as a later stage", () => {
    const { entry } = withActions(
      action(
        "Glare",
        saveOn(
          "one creature within 30 feet.",
          "The target has the Blinded condition until the end of its next turn. <em>Failure by 5 or More:</em> The target has the Stunned condition.",
        ),
      ),
    );
    const glare = entry.actions[0]?.activation.resolution;
    expect(glare?.kind === "save" ? glare.onFail : []).toMatchObject([
      { condition: "blinded" },
    ]);
  });

  it.each([
    [
      "If the beast moved 20+ feet straight toward the target immediately before the hit, the target has the Prone condition.",
      "a charge requirement",
    ],
    [
      "If the target is a Small or smaller creature, it has the Grappled condition (escape DC 13).",
      "a size limit",
    ],
    [
      "If the target has 20 Hit Points or fewer, it has the Stunned condition.",
      "a Hit Point threshold",
    ],
    [
      "While the target is wet, it has the Poisoned condition.",
      "another condition",
    ],
    [
      "<em>Constitution Saving Throw:</em> DC 12. <em>Failure:</em> The target has the Paralyzed condition.",
      "a nested save",
    ],
  ])("leaves out the rider in %s", (rider, reason) => {
    const { entry, notes } = withActions(
      action(
        "Gore",
        `<em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Piercing damage. ${rider}`,
      ),
    );
    const gore = entry.actions[0]?.activation.resolution;
    expect(gore?.kind === "attack" ? gore.onHit : ["kept"]).toEqual([]);
    expect(gore?.kind === "attack" ? gore.damage : []).toHaveLength(1);
    expect(notes).toContain(`partial: Gore: left out ${reason}`);
  });

  it.each([
    "If the target is a Large or smaller creature, it has the Grappled condition (escape DC 13).",
    "The target has the Prone condition if it is Huge or smaller.",
  ])("keeps a size limit every hero meets: %s", (rider) => {
    const { entry, notes } = withActions(
      action(
        "Gore",
        `<em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Piercing damage. ${rider}`,
      ),
    );
    const gore = entry.actions[0]?.activation.resolution;
    expect(gore?.kind === "attack" ? gore.onHit : []).toHaveLength(1);
    expect(notes).not.toContain("partial: Gore: left out a size limit");
  });

  it("keeps a save aimed at one Large or smaller creature", () => {
    const { entry } = withActions(
      action(
        "Squeeze",
        "<em>Strength Saving Throw:</em> DC 14, one Large or smaller creature within 10 feet. <em>Failure:</em> 9 (2d6 + 2) Bludgeoning damage, and the target has the Restrained condition.",
      ),
    );
    expect(entry.actions[0]).toMatchObject({
      name: "Squeeze",
      activation: {
        targeting: { creatures: 1, range: 10 },
        resolution: { kind: "save", onFail: [{ condition: "restrained" }] },
      },
    });
  });

  it("imports a Melee or Ranged attack as a melee and a ranged action", () => {
    const { entry } = withActions(
      action("Multiattack", "The beast makes two Spike attacks."),
      action(
        "Spike",
        "<em>Melee or Ranged Attack Roll:</em> +4, reach 5 ft. or range 20/60 ft. <em>Hit:</em> 4 (1d4 + 2) Piercing damage.",
      ),
    );
    expect(
      entry.actions.map((item) => [
        item.name,
        "range" in item.activation.targeting
          ? item.activation.targeting.range
          : null,
      ]),
    ).toEqual([
      ["Spike", 5],
      ["Spike (ranged)", 20],
    ]);
  });

  it("gives an X/Day action a resource with that many uses", () => {
    const { entry } = withActions(
      action(
        "Howl (2/Day)",
        saveOn(
          "each creature in a 30-foot Emanation.",
          "The target has the Frightened condition.",
        ),
      ),
    );
    expect(entry.actions[0]).toMatchObject({
      name: "Howl",
      perDay: 2,
      activation: { cost: ["action", { resource: "day:howl" }] },
    });
  });

  it("reads repeat saves and a condition that ends on damage", () => {
    const { entry } = withActions(
      action(
        "Lull",
        saveOn(
          "one creature within 30 feet.",
          "The target has the Unconscious condition. The effect ends early if the target takes damage, and the target repeats the save at the end of each of its turns.",
        ),
      ),
    );
    const lull = entry.actions[0]?.activation.resolution;
    expect(lull?.kind === "save" ? lull.onFail : []).toMatchObject([
      { condition: "unconscious", repeatSave: true, endsOnDamage: true },
    ]);
  });

  it("counts as many attacks as the heads a trait names", () => {
    const [many] = parseMonstersFromHtml(
      page
        .replace("It swims in mud.", "The beast has five heads.")
        .replace(
          "The beast makes two Bite attacks.",
          "The beast makes as many Bite attacks as it has heads.",
        ),
      "my-book",
    );
    expect(MonsterSchema.parse(many?.entry).multiattack).toBe(5);
  });

  it("reads defences and known traits as passives", () => {
    const [tough] = parseMonstersFromHtml(
      page
        .replace(
          "<p><strong>CR</strong>",
          "<p><strong>Resistances</strong> Cold, Fire</p><p><strong>Vulnerabilities</strong> Radiant</p><p><strong>Immunities</strong> Poison; Charmed, Poisoned</p><p><strong>CR</strong>",
        )
        .replace(
          "<p><strong><em>Mudborn.</em></strong> It swims in mud.</p>",
          "<p><strong><em>Magic Resistance.</em></strong> It shrugs off spells.</p><p><strong><em>Regeneration.</em></strong> The beast regains 10 Hit Points at the start of each of its turns. Acid damage stops this for a turn.</p>",
        ),
      "my-book",
    );
    expect(MonsterSchema.parse(tough?.entry).passives).toEqual([
      { kind: "modifier", modifier: { kind: "resistance", damage: "cold" } },
      { kind: "modifier", modifier: { kind: "resistance", damage: "fire" } },
      {
        kind: "modifier",
        modifier: { kind: "vulnerability", damage: "radiant" },
      },
      { kind: "modifier", modifier: { kind: "immunity", damage: "poison" } },
      { kind: "conditionImmunity", condition: "charmed" },
      { kind: "conditionImmunity", condition: "poisoned" },
      { kind: "magicResistance" },
      { kind: "regeneration", hp: 10, stoppedBy: ["acid"] },
    ]);
    expect(tough?.notes).not.toContain("not automated: Magic Resistance");
  });

  it("reads older defence lines", () => {
    const [old] = parseMonstersFromHtml(
      page.replace(
        "<p><strong>CR</strong>",
        "<p><strong>Damage Resistances</strong> bludgeoning, piercing, and slashing from nonmagical attacks</p><p><strong>Condition Immunities</strong> frightened</p><p><strong>CR</strong>",
      ),
      "my-book",
    );
    expect(MonsterSchema.parse(old?.entry).passives).toEqual([
      {
        kind: "modifier",
        modifier: { kind: "resistance", damage: "bludgeoning" },
      },
      {
        kind: "modifier",
        modifier: { kind: "resistance", damage: "piercing" },
      },
      {
        kind: "modifier",
        modifier: { kind: "resistance", damage: "slashing" },
      },
      { kind: "conditionImmunity", condition: "frightened" },
    ]);
  });

  it("keeps a rider that always holds", () => {
    const { entry } = withActions(
      action(
        "Gore",
        "<em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Piercing damage. If the target is a creature, it has the Prone condition.",
      ),
    );
    const gore = entry.actions[0]?.activation.resolution;
    expect(gore?.kind === "attack" ? gore.onHit : []).toMatchObject([
      { condition: "prone" },
    ]);
  });

  it("doesn't add damage to another creature", () => {
    const { entry, notes } = withActions(
      action(
        "Cleave",
        "<em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Slashing damage, and a creature within 5 feet of the target takes 3 (1d6) Slashing damage.",
      ),
    );
    const cleave = entry.actions[0]?.activation.resolution;
    expect(cleave?.kind === "attack" ? cleave.damage : []).toHaveLength(1);
    expect(notes).toContain(
      "partial: Cleave: left out damage to another creature",
    );
  });

  it("doesn't add ongoing damage to the first hit", () => {
    const { entry, notes } = withActions(
      action(
        "Ember Burst",
        saveOn(
          "each creature in a 20-foot-radius Sphere.",
          "14 (4d6) Fire damage, and the target catches fire, taking 3 (1d6) Fire damage at the start of each of its turns.",
        ),
      ),
    );
    const burst = entry.actions[0]?.activation.resolution;
    expect(burst?.kind === "save" ? burst.damage : []).toMatchObject([
      { amount: { dice: "4d6" }, type: "fire" },
    ]);
    expect(burst?.kind === "save" ? burst.damage : []).toHaveLength(1);
    expect(notes).toContain("partial: Ember Burst: left out an ongoing effect");
  });

  it.each([
    [
      "its branches depend on Hit Points",
      saveOn(
        "one creature within 60 feet.",
        "If the target has 20 Hit Points or fewer, it has the Unconscious condition. If the target has 21 Hit Points or more, it takes 18 (4d8) Psychic damage.",
      ),
    ],
    [
      "only some sizes can be targeted",
      saveOn(
        "one Small or smaller creature within 5 feet.",
        "7 (2d6) Bludgeoning damage.",
      ),
    ],
    [
      "only a grappled creature can be targeted",
      saveOn("one creature Grappled by the beast.", "7 (2d6) Piercing damage."),
    ],
    [
      "its main damage needs a charge",
      "<em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> If the beast moved 20+ feet, the target takes 7 (2d6) Piercing damage and has the Prone condition.",
    ],
  ])("doesn't automate an action when %s", (_, body) => {
    const { entry, notes } = withActions(action("Doom", body), claw);
    expect(entry.actions.map((item) => item.name)).toEqual(["Claw"]);
    expect(notes).toContain("not automated: Doom");
  });

  it("targets everyone around the monster for each creature within a distance", () => {
    const { entry } = withActions(
      action(
        "Howl",
        saveOn(
          "each creature within 30 feet that isn't a beast.",
          "9 (2d8) Psychic damage.",
        ),
      ),
    );
    expect(entry.actions[0]?.activation.targeting).toEqual({
      area: { shape: "emanation", radius: 30 },
      range: "self",
      side: "enemy",
    });
  });

  it("reads a label however the book closes it", () => {
    const { entry } = withActions(
      `<p><strong><em>Gore</em>.</strong> <em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Piercing damage.</p>`,
      `<p><strong><em>Bile</em></strong>. <em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Acid damage.</p>`,
      `<p><strong><em>Fire Breath</em> (Recharge 5–6).</strong> <em>Dexterity Saving Throw:</em> DC 13, each creature in a 15-foot Cone. <em>Failure:</em> 14 (4d6) Fire damage.</p>`,
      `<p><strong><em>Gaze (Recharge</em></strong> 4–6). <em>Wisdom Saving Throw:</em> DC 13, each creature in a 15-foot Cone. <em>Failure:</em> The target has the Stunned condition.</p>`,
    );
    expect(entry.actions.map(({ name, recharge }) => [name, recharge])).toEqual(
      [
        ["Gore", undefined],
        ["Bile", undefined],
        ["Fire Breath", 5],
        ["Gaze", 4],
      ],
    );
  });

  it("reads damage around a dashed alternative", () => {
    const { entry } = withActions(
      action(
        "Bite",
        "<em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 7 (1d8 + 3) Piercing damage—or 12 (2d8 + 3) Piercing damage if the target is held—plus 4 (1d8) Acid damage.",
      ),
    );
    const bite = entry.actions[0]?.activation.resolution;
    expect(bite?.kind === "attack" ? bite.damage : []).toMatchObject([
      { amount: { dice: "1d8", bonus: { base: 3 } }, type: "piercing" },
      { amount: { dice: "1d8" }, type: "acid" },
    ]);
  });

  it("encodes an attack that only applies a condition, dealing nothing", () => {
    const { entry } = withActions(
      claw,
      action(
        "Lash",
        "<em>Melee Attack Roll:</em> +5, reach 60 ft. <em>Hit:</em> The target has the Grappled condition (escape DC 13), and the target has the Poisoned condition until the grapple ends.",
      ),
    );
    const lash = entry.actions[1]?.activation.resolution;
    expect(entry.actions[1]?.activation.targeting).toMatchObject({ range: 60 });
    expect(lash?.kind === "attack" ? lash.onHit : []).toMatchObject([
      { condition: "grappled" },
      { condition: "poisoned" },
    ]);
    expect(lash?.kind === "attack" ? lash.damage : []).toEqual([
      { amount: { bonus: { base: 0, add: [] } }, type: "bludgeoning" },
    ]);
  });

  it("makes each breath in one entry its own action, sharing one recharge", () => {
    const { entry } = withActions(
      action(
        "Breath Weapons (Recharge 5–6)",
        "The beast uses one of the following. Fire Breath. <em>Dexterity Saving Throw:</em> DC 13, each creature in a 15-foot Cone. <em>Failure:</em> 14 (4d6) Fire damage. <em>Success:</em> Half damage. Slowing Breath. <em>Constitution Saving Throw:</em> DC 13, each creature in a 15-foot Cone. <em>Failure:</em> The target has the Poisoned condition.",
      ),
    );
    expect(entry.actions).toMatchObject([
      {
        name: "Fire Breath",
        recharge: 5,
        activation: {
          cost: ["action", { resource: "recharge:breath-weapons" }],
          resolution: { ability: "dex", onSuccessDamage: "half" },
        },
      },
      {
        name: "Slowing Breath",
        activation: {
          cost: ["action", { resource: "recharge:breath-weapons" }],
          resolution: { ability: "con" },
        },
      },
    ]);
    // The recharge roll happens once per action that has one, so only one may.
    expect(entry.actions[1]?.recharge).toBeUndefined();
  });

  it("keeps the size, creature type and every speed", () => {
    const { entry } = withActions(claw);
    expect(entry).toMatchObject({ size: "large", creatureType: "monstrosity" });
    expect(entry.speeds).toBeUndefined();
    const [flying] = parseMonstersFromHtml(
      page.replace("30 ft.</p>", "10 ft., Fly 60 ft. (hover), Swim 20 ft.</p>"),
      "my-book",
    );
    expect(MonsterSchema.parse(flying?.entry)).toMatchObject({
      speed: 10,
      speeds: { walk: 10, fly: 60, swim: 20 },
    });
  });

  it("reads a stat block in the older format", () => {
    const score = (name: string, value: number) =>
      `<div class="stat-block-ability-scores-stat"><div class="stat-block-ability-scores-heading" data-x="1">${name}</div><div class="stat-block-ability-scores-data"><span class="stat-block-ability-scores-score" data-x="1">${String(value)}</span> <span class="stat-block-ability-scores-modifier">(+0)</span></div></div>`;
    const [older] = parseMonstersFromHtml(
      `<div class="Basic-Text-Frame stat-block-background--space stat-block-finder">
        <p class="Stat-Block-Styles_Stat-Block-Title"><a>Void Moth</a></p>
        <p class="Stat-Block-Styles_Stat-Block-Metadata">Huge beast, unaligned</p>
        <div class="red-statblock-text">
          <p class="Stat-Block-Styles_Stat-Block-Data"><strong>Armor Class</strong> 13 (natural armor)</p>
          <p class="Stat-Block-Styles_Stat-Block-Data"><strong>Hit Points</strong> 22 (4d8 + 4)</p>
          <p class="Stat-Block-Styles_Stat-Block-Data"><strong>Speed</strong> 10 ft., fly 40 ft.</p>
        </div>
        <div class="stat-block-ability-scores">
          ${score("STR", 12)}${score("DEX", 16)}${score("CON", 13)}${score("INT", 2)}${score("WIS", 10)}${score("CHA", 5)}
        </div>
        <div class="red-statblock-text">
          <p class="Stat-Block-Styles_Stat-Block-Data"><strong>Saving Throws</strong> Dex +5</p>
          <p class="Stat-Block-Styles_Stat-Block-Data-Last"><strong>Challenge</strong> 1 (200 XP) <strong>Proficiency Bonus</strong> +3</p>
        </div>
        <p class="Stat-Block-Styles_Stat-Block-Data"><strong><em>Dusty.</em></strong> It sheds dust.</p>
        <p class="Stat-Block-Styles_Stat-Block-Heading">Actions</p>
        <p class="Stat-Block-Styles_Stat-Block-Data"><strong><em>Multiattack.</em></strong> The moth makes one Bite attack and one Wing attack.</p>
        <p class="Stat-Block-Styles_Stat-Block-Data"><strong><em>Bite.</em></strong> <em>Melee Weapon Attack:</em> +4 to hit, reach 5 ft., one target. <em>Hit:</em> 6 (1d8 + 2) piercing damage, and the target is grappled (escape DC 12).</p>
        <p class="Stat-Block-Styles_Stat-Block-Body"><em><strong>Wing.</strong> Ranged Spell Attack:</em> +4 to hit, range 60 ft., one creature. <em>Hit:</em> 5 (1d6 + 2) force damage.</p>
        <p class="Stat-Block-Styles_Stat-Block-Data"><strong><em>Dust Cloud (Recharge 5–6).</em></strong> Each creature in a 15-foot cone must make a DC 12 Dexterity saving throw, taking 7 (2d6) poison damage on a failed save, or half as much on a successful one.</p>
      </div>`,
      "my-book",
    );
    expect(MonsterSchema.parse(older?.entry)).toMatchObject({
      id: "my-book:monster/void-moth",
      name: "Void Moth",
      size: "huge",
      creatureType: "beast",
      ac: 13,
      hp: 22,
      speed: 10,
      speeds: { walk: 10, fly: 40 },
      abilities: { str: 12, dex: 16, con: 13, int: 2, wis: 10, cha: 5 },
      saves: ["dex"],
      proficiency: 3,
      initiative: 3,
      multiattack: 2,
      actions: [
        {
          name: "Bite",
          activation: {
            targeting: { creatures: 1, range: 5 },
            resolution: {
              attack: { flatBonus: 4 },
              damage: [{ amount: { dice: "1d8" }, type: "piercing" }],
              onHit: [],
            },
          },
        },
        { name: "Wing", activation: { targeting: { range: 60 } } },
      ],
    });
    expect(older?.notes).toEqual([
      "not automated: Dusty",
      "partial: Bite: left out a condition in older wording",
      "not automated: Dust Cloud (Recharge 5–6)",
    ]);
  });

  it("keeps a block with no usable action for reading, and says so", () => {
    const empty = page.replace(
      /<p class="monster-header">Actions[\s\S]*<\/div>$/,
      "</div>",
    );
    const [parsed] = parseMonstersFromHtml(empty, "my-book");
    expect(parsed?.entry).toMatchObject({ actions: [] });
    expect(parsed?.notes).toContain("no action could be automated");
  });

  it("writes parsed monsters as drafts that approve into a working plugin", async () => {
    const storage = memoryStorage(await readAllSrd());
    const summary = await importParsed({
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "monsters",
      html: page,
    });
    expect(summary).toMatchObject({ written: 1, invalid: [] });
    await approveImport({
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "monsters",
      slugs: "all",
      requires: [{ plugin: "srd52", version: "^1" }],
    });
    const report = await checkPlugins(storage, ["plugins", "books"], systems);
    expect(report.issues).toEqual([]);
    expect(report.checked).toContain("my-book");
  });
});

describe("using encodings that were already written", () => {
  const request = async (encodings: Record<string, unknown>) => {
    const storage = memoryStorage({});
    const client = scripted([]);
    const summary = await importSource({
      storage,
      client,
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      sourceText: await fixtureText(),
      knownIds: known,
      encodings,
      ...onlyFireBolt,
    });
    return { summary, client, storage };
  };

  it("keeps the cantrip scaling a provided encoding gives", async () => {
    const scaling = { perTier: { addDice: "1d10" } };
    const { storage } = await request({
      "fire-bolt": {
        encoding: { ...FIREBOLT_DRAFT.encoding, cantrip: scaling },
      },
    });
    const draft = parse(
      (await storage.read("books/import/my-book/spells/fire-bolt.yaml")) ?? "",
    ) as { entry: { cantrip?: unknown } };
    expect(draft.entry.cantrip).toEqual(scaling);
  });

  it("uses a provided encoding without calling a model", async () => {
    const { summary, client } = await request({
      "fire-bolt": FIREBOLT_DRAFT,
    });
    expect(client.requests).toHaveLength(0);
    expect(summary).toMatchObject({ encoded: 1 });
  });

  it("still applies the source checks to a provided encoding", async () => {
    const invented = {
      encoding: {
        ...FIREBOLT_DRAFT.encoding,
        resolution: {
          ...FIREBOLT_DRAFT.encoding.resolution,
          damage: [{ amount: { dice: "9d9" }, type: "fire" }],
        },
      },
    };
    const { summary } = await request({ "fire-bolt": invented });
    expect(summary).toMatchObject({ encoded: 0, textOnly: 1 });
  });

  it("leaves a missing entry as text only", async () => {
    const { summary } = await request({});
    expect(summary).toMatchObject({ encoded: 0, textOnly: 1 });
  });
});

describe("limiting encodings to what the format can say", () => {
  const healing = {
    targeting: { creatures: 1, range: 60, side: "ally" as const },
    resolution: {
      kind: "automatic" as const,
      damage: [],
      effects: [{ kind: "heal" as const, amount: { dice: "2d4" } }],
    },
  };
  const damage = {
    targeting: { creatures: 1, range: 60, side: "enemy" as const },
    resolution: {
      kind: "attack" as const,
      attack: { type: "spell" as const },
      damage: [{ amount: { dice: "1d10" }, type: "fire" as const }],
      onHit: [],
      onMiss: [],
    },
  };
  const bonus = (to: "ac" | "checks", duration: object | string) => ({
    targeting: { creatures: 1, range: 30, side: "ally" as const },
    resolution: {
      kind: "automatic" as const,
      damage: [],
      effects: [
        {
          kind: "modifier" as const,
          duration: duration as "instantaneous",
          modifier: {
            kind: "bonus" as const,
            to,
            amount: { bonus: { base: 2, add: [] } },
          },
        },
      ],
    },
  });
  const tenMinutes = { concentration: true as const, minutes: 10 };

  it("accepts instant damage, healing and a bonus that lasts as long as the spell", () => {
    expect(shapeProblems(damage, "instantaneous")).toEqual([]);
    expect(shapeProblems(healing, "instantaneous")).toEqual([]);
    expect(shapeProblems(bonus("ac", tenMinutes), tenMinutes)).toEqual([]);
  });

  it("rejects lasting damage, like a wall that hurts on later turns", () => {
    expect(shapeProblems(damage, tenMinutes).join()).toContain("several turns");
  });

  it("rejects a bonus to checks, which can't be limited to one skill", () => {
    expect(
      shapeProblems(bonus("checks", tenMinutes), tenMinutes).join(),
    ).toContain("ability checks");
  });

  it("rejects a bonus that doesn't last as long as the spell", () => {
    expect(
      shapeProblems(bonus("ac", "instantaneous"), tenMinutes).join(),
    ).toContain("as long as");
  });

  it("describes an encoding in plain English for the verifier", () => {
    expect(describeEncoding(damage)).toBe(
      "Affects 1 enemy creature(s) within 60 feet. One spell attack roll per target. On a hit: 1d10 fire damage. On a miss: nothing.",
    );
  });
});

describe("drafting", () => {
  async function draft(client: ModelClient) {
    const storage = memoryStorage({});
    const summary = await importSource({
      storage,
      client,
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      sourceText: await fixtureText(),
      knownIds: known,
      ...onlyFireBolt,
    });
    return { storage, summary };
  }

  it("writes a draft with code-set facts and checked mechanics", async () => {
    const { storage, summary } = await draft(
      scripted([FIREBOLT_DRAFT, NO_DIFFERENCES]),
    );
    expect(summary).toMatchObject({ total: 1, written: 1, encoded: 1 });
    const text =
      (await storage.read("books/import/my-book/spells/fire-bolt.yaml")) ?? "";
    expect(text).toContain("id: my-book:spell/fire-bolt");
    expect(text).toContain("automation: partial");
    expect(text).toContain("- srd52:class/wizard");
    expect(text).toContain("notes:");
    expect(text).toContain("unknown class dropped: Sorcerer");
  });

  it("sends the verifier a plain summary, without the model's JSON", async () => {
    const client = scripted([FIREBOLT_DRAFT, NO_DIFFERENCES]);
    await draft(client);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.prompt).toContain("One spell attack roll");
    expect(client.requests[1]?.prompt).not.toContain('"targeting"');
  });

  it("falls back to text only when the verifier keeps finding a real difference", async () => {
    const objection = {
      differences: [{ quote: "mote of fire", problem: "Left out." }],
    };
    const { summary } = await draft(
      scripted([
        FIREBOLT_DRAFT,
        objection,
        FIREBOLT_DRAFT,
        objection,
        FIREBOLT_DRAFT,
        objection,
      ]),
    );
    expect(summary).toMatchObject({ encoded: 0, textOnly: 1 });
  });

  it("ignores an objection whose quote isn't in the spell's text", async () => {
    const { summary } = await draft(
      scripted([
        FIREBOLT_DRAFT,
        { differences: [{ quote: "invented words", problem: "Left out." }] },
      ]),
    );
    expect(summary).toMatchObject({ encoded: 1 });
  });

  it("treats an unreadable verdict as a failure", async () => {
    const { summary } = await draft(
      scripted([
        FIREBOLT_DRAFT,
        "not json",
        FIREBOLT_DRAFT,
        "not json",
        FIREBOLT_DRAFT,
        "not json",
      ]),
    );
    expect(summary).toMatchObject({ encoded: 0, textOnly: 1 });
  });

  it("reuses reviewed mechanics when the text matches, without asking the model", async () => {
    const [bolt] = splitSpells(await fixtureText()).filter(
      (item) => item.slug === "fire-bolt",
    );
    const { description } = bolt?.data as { description: string };
    const reviewed = {
      id: "srd52:spell/fire-bolt",
      name: "Fire Bolt",
      level: 0,
      school: "evocation",
      classes: [],
      castingTime: "Action",
      range: "120 feet",
      components: "V, S",
      duration: "instantaneous",
      // Differences in spacing, case and punctuation shouldn't block a match.
      text: description.toUpperCase().replaceAll(",", " "),
      automation: "full",
      activation: {
        cost: ["action"],
        ...FIREBOLT_DRAFT.encoding,
      },
    };
    const run = async (contentText: string) => {
      const storage = memoryStorage({});
      const client = scripted([{ encoding: null }]);
      const summary = await importSource({
        storage,
        client,
        system: dnd55e,
        pluginId: "my-book",
        folder: "spells",
        sourceText: await fixtureText(),
        knownIds: [...known, reviewed.id],
        contentOf: () => ({ ...reviewed, text: contentText }),
        ...onlyFireBolt,
      });
      return { storage, client, summary };
    };

    const same = await run(reviewed.text);
    expect(same.client.requests).toHaveLength(0);
    expect(same.summary).toMatchObject({ encoded: 1, reused: 1 });
    const text =
      (await same.storage.read("books/import/my-book/spells/fire-bolt.yaml")) ??
      "";
    expect(text).toContain("automation: full");
    expect(text).toContain("mechanics reused from srd52:spell/fire-bolt");

    const different = await run("Changed rules text.");
    expect(different.client.requests).toHaveLength(1);
    expect(different.summary).toMatchObject({ reused: 0, textOnly: 1 });
  });

  it("ignores any attack bonus the model supplies for a spell", async () => {
    const withBonus = {
      encoding: {
        ...FIREBOLT_DRAFT.encoding,
        resolution: {
          ...FIREBOLT_DRAFT.encoding.resolution,
          attack: { type: "spell", ability: "cha", flatBonus: 9 },
        },
      },
    };
    const { storage } = await draft(scripted([withBonus, NO_DIFFERENCES]));
    const text =
      (await storage.read("books/import/my-book/spells/fire-bolt.yaml")) ?? "";
    expect(text).not.toContain("flatBonus");
    expect(text).not.toContain("ability: cha");
  });

  it("falls back to text only when the mechanics keep failing the source check", async () => {
    const invented = {
      encoding: {
        ...FIREBOLT_DRAFT.encoding,
        resolution: {
          ...FIREBOLT_DRAFT.encoding.resolution,
          damage: [{ amount: { dice: "9d9" }, type: "fire" }],
        },
      },
    };
    const client = scripted([invented, invented, invented]);
    const { storage, summary } = await draft(client);
    expect(client.requests).toHaveLength(3);
    expect(summary).toMatchObject({ encoded: 0, textOnly: 1 });
    const text =
      (await storage.read("books/import/my-book/spells/fire-bolt.yaml")) ?? "";
    expect(text).toContain("automation: text");
    expect(text).not.toContain("activation:");
    expect(text).toContain("mechanics rejected");
  });

  it("keeps text only when the model says it can't encode the spell", async () => {
    const { summary } = await draft(scripted([{ encoding: null }]));
    expect(summary).toMatchObject({ encoded: 0, textOnly: 1 });
  });

  it("resumes without redoing finished entries", async () => {
    const storage = memoryStorage({});
    const request = {
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      sourceText: await fixtureText(),
      knownIds: known,
      ...onlyFireBolt,
    };
    await importSource({
      ...request,
      client: scripted([FIREBOLT_DRAFT, NO_DIFFERENCES]),
    });
    const second = scripted([]);
    const summary = await importSource({ ...request, client: second });
    expect(summary.skippedAlreadyDone).toBe(1);
    expect(second.requests).toHaveLength(0);
  });

  it("redoes an entry when its source text changes", async () => {
    const storage = memoryStorage({});
    const base = {
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      knownIds: known,
      ...onlyFireBolt,
    };
    const text = await fixtureText();
    await importSource({
      ...base,
      sourceText: text,
      client: scripted([FIREBOLT_DRAFT, NO_DIFFERENCES]),
    });
    const client = scripted([FIREBOLT_DRAFT, NO_DIFFERENCES]);
    await importSource({
      ...base,
      sourceText: text.replace("mote of fire", "spark of fire"),
      client,
    });
    expect(client.requests).toHaveLength(2);
  });

  it("uses a schema with no references for the model", () => {
    const text = JSON.stringify(dnd55e.importKinds?.spells?.modelSchema);
    expect(text).not.toContain("$ref");
    expect(text).not.toContain("$defs");
  });

  it("refuses a kind the system can't import, and unsafe names", async () => {
    const base = {
      storage: memoryStorage({}),
      client: scripted([]),
      system: dnd55e,
      sourceText: "",
      knownIds: [],
    };
    await expect(
      importSource({ ...base, pluginId: "my-book", folder: "monsters" }),
    ).rejects.toThrow("can't import");
    await expect(
      importSource({ ...base, pluginId: "../escape", folder: "spells" }),
    ).rejects.toThrow("Invalid plugin id");
  });
});

describe("approving drafts", () => {
  async function drafted() {
    const srd = await readAllSrd();
    const storage = memoryStorage(srd);
    await importSource({
      storage,
      client: scripted([FIREBOLT_DRAFT, NO_DIFFERENCES]),
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      sourceText: await fixtureText(),
      knownIds: known,
      ...onlyFireBolt,
    });
    return storage;
  }

  it("keeps unapproved drafts out of the game", async () => {
    const storage = await drafted();
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    expect([...catalog.plugins.keys()]).not.toContain("my-book");
    expect(catalog.issues).toEqual([]);
  });

  it("makes approved drafts a working private plugin that passes check-pack", async () => {
    const storage = await drafted();
    const result = await approveImport({
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      slugs: ["fire-bolt"],
      requires: [{ plugin: "srd52", version: "^1" }],
    });
    expect(result).toEqual({ approved: ["fire-bolt"], missing: [], kept: [] });

    const report = await checkPlugins(storage, ["plugins", "books"], systems);
    expect(report.issues).toEqual([]);
    expect(report.checked).toContain("my-book");

    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    expect(catalog.plugins.get("my-book")?.manifest.distribution).toBe(
      "private",
    );
    const loaded: LoadResult = await loadRun(storage, catalog, systems, [
      "my-book",
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    expect(loaded.registry.content("my-book:spell/fire-bolt")).toMatchObject({
      name: "Fire Bolt",
      level: 0,
      automation: "partial",
    });
  });

  it("reports slugs that don't exist", async () => {
    const storage = await drafted();
    const result = await approveImport({
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      slugs: ["nope"],
      requires: [],
    });
    expect(result).toEqual({ approved: [], missing: ["nope"], kept: [] });
  });

  it("can approve everything at once, skipping the report", async () => {
    const storage = await drafted();
    const result = await approveImport({
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "spells",
      slugs: "all",
      requires: [],
    });
    expect(result.approved).toEqual(["fire-bolt"]);
  });

  it("keeps an approved entry that has fields added by hand", async () => {
    const storage = await drafted();
    const approve = () =>
      approveImport({
        storage,
        system: dnd55e,
        pluginId: "my-book",
        folder: "spells",
        slugs: "all",
        requires: [],
      });
    await approve();
    const path = "books/rules/my-book/spells/fire-bolt.yaml";
    const [entry] = parse((await storage.read(path)) ?? "") as object[];
    const edited = stringify([
      { ...entry, cantrip: { perTier: { addDice: "1d10" } } },
    ]);
    await storage.replaceAtomically(path, edited);
    expect(await approve()).toEqual({
      approved: [],
      missing: [],
      kept: ["fire-bolt"],
    });
    expect(await storage.read(path)).toBe(edited);
  });
});

async function readAllSrd(): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const root = "plugins/rules/srd52";
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    files[path] = await readFile(path, "utf8");
  }
  return files;
}

describe("parsing a character book page", () => {
  const casterRow = (level: number, features: string, slots: string[]) =>
    `<tr><td>${String(level)}</td><td>+2</td><td>${features}</td><td>D${String(4 + 2 * level)}</td><td>${String(level + 1)}</td>${slots.map((slot) => `<td>${slot}</td>`).join("")}</tr>`;
  const page = `
    <h1>Chapter 3: Callings</h1>
    <h2 id="Warden">Warden</h2>
    <table><caption><h3>Core Warden Traits</h3></caption><tbody>
      <tr><th>Primary Ability</th><td>Wisdom and Strength</td></tr>
      <tr><td>Hit Point Die</td><td>D10 per Warden level</td></tr>
      <tr><td>Saving Throw Proficiencies</td><td>Wisdom and Charisma</td></tr>
      <tr><td>Skill Proficiencies</td><td>Choose 2: Arcana, Sleight of Hand, or Nature</td></tr>
      <tr><td>Weapon Proficiencies</td><td>Simple and Martial weapons</td></tr>
      <tr><td>Armor Training</td><td>Light armor and Shields</td></tr>
    </tbody></table>
    <h3>Warden Class Features</h3>
    <table><caption><h3>Warden Features</h3></caption><thead>
      <tr><th colspan="5"></th><th colspan="2">Spell Slots per Spell Level</th></tr>
      <tr><th>Level</th><th>Proficiency Bonus</th><th>Class Features</th><th>Oak Die</th><th>Cantrips</th><th>1</th><th>2</th></tr>
    </thead><tbody>
      ${casterRow(1, '<a href="#WardenLevel1Roots">Roots</a>, <a href="#WardenLevel1Spellcasting">Spellcasting</a>', ["2", "—"])}
      ${casterRow(2, 'Subclass feature, <a href="#WardenLevel2Boost">Bark Boost</a>', ["3", "1"])}
      ${casterRow(3, '<a href="#WardenLevel3Boost">Bark Boost</a>', ["3", "2"])}
    </tbody></table>
    <h4 id="WardenLevel1Roots">Level 1: Roots</h4>
    <figure><figcaption>Painted by nobody</figcaption></figure>
    <p>Your feet take root.</p>
    <h5>Deep Roots</h5>
    <p>They go down a long way.</p>
    <h4 id="WardenLevel1Spellcasting">Level 1: Spellcasting</h4>
    <p>Wisdom is your spellcasting ability for Warden spells.</p>
    <h4 id="WardenLevel2Boost">Level 2: Bark Boost</h4>
    <p>Your skin hardens.</p>
    <h4 id="WardenLevel3Boost">Level 3: Bark Boost</h4>
    <p>Your skin hardens more.</p>
    <h4>Sap Options</h4>
    <p>Pick a sap.</p>
    <h3>Warden Spell List</h3>
    <h4>Not a Feature</h4>
    <p>Spell names go here.</p>
    <h3>Warden Subclasses</h3>
    <h4 class="h3-override">Grove of Ash</h4>
    <p>Ash wardens tend ash trees.</p>
    <h5 class="h4-override">Level 3: Ash Skin</h5>
    <p>You resist soot.</p>
    <table><caption><h5>Ash Spells</h5></caption><tbody><tr><td>3</td><td>Cinder</td></tr></tbody></table>
    <h4>Stray Heading</h4>
    <p>Still part of Ash Skin.</p>
    <h1>Chapter 3: Callings (Continued)</h1>
    <p>This is outside the Warden.</p>
    <h2 id="Drifter">Drifter</h2>
    <table><caption><h3>Core Drifter Traits</h3></caption><tbody>
      <tr><th>Primary Ability</th><td>Dexterity</td></tr>
      <tr><td>Hit Point Die</td><td>D6 per Drifter level</td></tr>
      <tr><td>Saving Throw Proficiencies</td><td>Dexterity and Intelligence</td></tr>
      <tr><td>Weapon Proficiencies</td><td>Simple weapons and Martial weapons that have the Light property</td></tr>
      <tr><td>Armor Training</td><td>None</td></tr>
    </tbody></table>
    <h3>Drifter Class Features</h3>
    <table><caption><h3>Drifter Features</h3></caption><thead>
      <tr><th>Level</th><th>Proficiency Bonus</th><th>Class Features</th><th>Stab</th><th>Fists</th><th>Stride</th><th>Spell Slots</th><th>Slot Level</th></tr>
    </thead><tbody>
      <tr><td>1</td><td>+2</td><td><a href="#Nowhere">Lost Link</a></td><td>1d6</td><td>1d4</td><td>—</td><td>1</td><td>1</td></tr>
      <tr><td>2</td><td>+2</td><td>—</td><td>2d6</td><td>1d8</td><td>+10 ft.</td><td>2</td><td>3</td></tr>
    </tbody></table>
    <h1>Chapter 4: Origins</h1>
    <h2>Origin Components</h2>
    <h3>Acrobat</h3>
    <p><strong>Feat:</strong> Not a background.</p>
    <h2>Background Descriptions</h2>
    <h3>Tinker</h3>
    <figure><figcaption>Painted by nobody</figcaption></figure>
    <div><p><strong>Ability Scores:</strong> Intelligence, Wisdom, Charisma</p>
    <p><strong>Feat:</strong> Spark Touched (Warden) (see <a href="#x">chapter 5</a>)</p>
    <p><strong>Skill Proficiencies:</strong> <a>Sleight of Hand</a> and <a>Arcana</a></p>
    <p><strong>Tool Proficiency:</strong> Choose one kind of Pliers (see <a href="#y">chapter 6</a>)</p>
    <p><strong>Equipment:</strong> Pliers, 8 GP</p></div>
    <h2>Species Descriptions</h2>
    <h3>Mossfolk</h3>
    <p>Mossfolk grow slowly.</p>
    <h4>Mossfolk Traits</h4>
    <div><p><strong>Creature Type:</strong> Plant</p>
    <p><strong>Size:</strong> Medium (about 5 feet tall) or Small (about 3 feet tall)</p>
    <p><strong>Speed:</strong> 35 feet</p></div>
    <p>As a Mossfolk, you have these special traits.</p>
    <p><strong><em>Damp.</em></strong> You stay damp.</p>
    <p><strong><em>Spores.</em></strong> You release spores.</p>
    <div><p><strong>Red Spores.</strong> They are red.</p></div>
    <h3>Pebbleling</h3>
    <p>Pebblelings are small.</p>
    <h4>Pebbleling Traits</h4>
    <div><p><strong>Creature Type:</strong> Humanoid</p>
    <p><strong>Size:</strong> Small (about 2 feet tall)</p>
    <p><strong>Speed:</strong> 30 feet</p></div>
    <p><strong><em>Damp.</em></strong> Pebbles get damp too.</p>
    <h1>Chapter 5: Feats</h1>
    <h2>Feat Descriptions</h2>
    <h3>Feat List</h3>
    <p>This is not a feat.</p>
    <h2>Origin Feats</h2>
    <h3 class="with-metadata">Spark Touched</h3>
    <p><em>Origin Feat</em></p>
    <p>You give off sparks.</p>
    <h2>Epic Boon Feats</h2>
    <h3 class="with-metadata">Boon of Bark</h3>
    <p><em>Epic Boon Feat (Prerequisite: Level 19+)</em></p>
    <p>Your bark is thick.</p>
    <h1>Chapter 6: Equipment</h1>
    <table><caption><h3>Weapons</h3></caption><thead>
      <tr><th>Name</th><th>Damage</th><th>Properties</th><th>Mastery</th><th>Weight</th><th>Cost</th></tr>
    </thead><tbody>
      <tr><td colspan="6"><em>Simple Melee Weapons</em></td></tr>
      <tr><td><a>Twig</a></td><td>1d4 Piercing</td><td>—</td><td><a>Nick</a></td><td>1 lb.</td><td>1 SP</td></tr>
      <tr><td colspan="6"><em>Martial Ranged Weapons</em></td></tr>
      <tr><td><a>Long Twig</a></td><td>1d8 Piercing</td><td><a>Ammunition</a> (Range 80/320; Seed), <a>Two-Handed</a>, <a>Versatile</a> (1d10)</td><td><a>Slow</a></td><td>2 lb.</td><td>5 GP</td></tr>
      <tr><td><a>Seed Spitter</a></td><td>1 Piercing</td><td>—</td><td><a>Vex</a></td><td>1 lb.</td><td>9 GP</td></tr>
    </tbody></table>
    <table><caption><h3>Armor</h3></caption><thead>
      <tr><th>Armor</th><th>Armor Class (AC)</th><th>Strength</th><th>Stealth</th><th>Weight</th><th>Cost</th></tr>
    </thead><tbody>
      <tr><td colspan="6"><em>Medium Armor (5 Minutes to Don)</em></td></tr>
      <tr><td><a>Bark Vest</a></td><td>13 + Dex modifier (max 2)</td><td>—</td><td>—</td><td>9 lb.</td><td>5 GP</td></tr>
      <tr><td colspan="6"><em>Heavy Armor (10 Minutes to Don)</em></td></tr>
      <tr><td><a>Log Plate</a></td><td>17</td><td>Str 15</td><td><a>Disadvantage</a></td><td>60 lb.</td><td>9 GP</td></tr>
      <tr><td colspan="6"><em>Shield</em></td></tr>
      <tr><td><a>Lid</a></td><td>+2</td><td>—</td><td>—</td><td>6 lb.</td><td>1 GP</td></tr>
    </tbody></table>`;

  const classes = parseClassesFromHtml(page, "my-book");
  const features = parseFeaturesFromHtml(page, "my-book");
  const species = parseSpeciesFromHtml(page, "my-book");
  const backgrounds = parseBackgroundsFromHtml(page, "my-book");
  const feats = parseFeatsFromHtml(page, "my-book");
  const equipment = parseEquipmentFromHtml(page, "my-book");
  const featureText = (slug: string) =>
    FeatureSchema.parse(features.find((item) => item.slug === slug)?.entry)
      .text;

  it("reads a caster's traits and level table", () => {
    const warden = ClassSchema.parse(classes[0]?.entry);
    expect(warden).toMatchObject({
      id: "my-book:class/warden",
      hitDie: "d10",
      primaryAbilities: ["wis", "str"],
      savingThrows: ["wis", "cha"],
      weapons: ["simple", "martial"],
      armor: ["light", "shield"],
      spellcasting: { ability: "wis" },
    });
    expect(warden.levels.map((level) => level.slots)).toEqual([
      [2],
      [3, 1],
      [3, 2],
    ]);
    expect(warden.levels[1]?.scaling).toEqual({ oakDie: 8, cantrips: 3 });
    expect(warden.levels[0]?.grants).toEqual([
      "my-book:feature/warden-roots",
      "my-book:feature/warden-spellcasting",
    ]);
    // Two headings with one name stay apart, so each level gets the one it links to.
    expect(warden.levels[1]?.grants).toEqual([
      "my-book:feature/warden-bark-boost",
    ]);
    expect(warden.levels[2]?.grants).toEqual([
      "my-book:feature/warden-bark-boost-3",
    ]);
  });

  it("reads dice columns, pact slots and limits it can't hold", () => {
    const parsed = classes[1];
    const drifter = ClassSchema.parse(parsed?.entry);
    expect(drifter.armor).toEqual([]);
    expect(drifter.spellcasting).toBeUndefined();
    expect(drifter.levels[0]?.scaling).toEqual({ stabD6: 1, fistsDie: 4 });
    expect(drifter.levels[1]?.scaling).toEqual({
      stabD6: 2,
      fistsDie: 8,
      stride: 10,
    });
    expect(drifter.levels[0]?.slots).toEqual([1]);
    expect(drifter.levels[1]?.slots).toEqual([0, 0, 2]);
    expect(parsed?.notes.join(" ")).toContain("Lost Link");
    expect(parsed?.notes.join(" ")).toContain("short rest");
    expect(drifter.martialWeaponProperties).toEqual(["light"]);
  });

  it("reads a class's skill choice into its first level", () => {
    const warden = ClassSchema.parse(classes[0]?.entry);
    expect(warden.martialWeaponProperties).toBeUndefined();
    expect(warden.levels[0]?.choices).toEqual([
      {
        kind: "skills",
        id: "skills",
        count: 2,
        from: ["arcana", "sleightOfHand", "nature"],
      },
    ]);
    expect(warden.levels[1]?.choices).toEqual([]);
  });

  it("groups subclass features by subclass and level", () => {
    const [ash] = parseSubclassesFromHtml(page, "my-book");
    expect(ash?.notes).toEqual([]);
    expect(SubclassSchema.parse(ash?.entry)).toMatchObject({
      id: "my-book:subclass/warden-grove-of-ash",
      name: "Grove of Ash",
      class: "my-book:class/warden",
      levels: [
        { level: 3, grants: ["my-book:feature/warden-grove-of-ash-ash-skin"] },
      ],
    });
  });

  it("copies feature text up to the feature's own end", () => {
    expect(features.map((item) => item.slug)).toEqual([
      "warden-roots",
      "warden-spellcasting",
      "warden-bark-boost",
      "warden-bark-boost-3",
      "warden-sap-options",
      "warden-grove-of-ash-ash-skin",
      "mossfolk-damp",
      "mossfolk-spores",
      "pebbleling-damp",
    ]);
    expect(featureText("warden-roots")).toBe(
      "Your feet take root.\nDeep Roots\nThey go down a long way.",
    );
    const skin = featureText("warden-grove-of-ash-ash-skin");
    expect(skin).toContain("Cinder");
    expect(skin).toContain("Still part of Ash Skin.");
    expect(skin).not.toContain("outside the Warden");
    expect(featureText("mossfolk-spores")).toBe(
      "You release spores.\nRed Spores. They are red.",
    );
    for (const item of features) {
      expect(FeatureSchema.parse(item.entry).automation).toBe("text");
    }
  });

  it("links every reference to an entry another parser wrote", () => {
    const ids = new Set(
      [...features, ...feats].map(
        (item) => (item.entry as { readonly id: string }).id,
      ),
    );
    const references = [
      ...classes.flatMap((item) =>
        ClassSchema.parse(item.entry).levels.flatMap((level) => level.grants),
      ),
      ...species.flatMap((item) => SpeciesSchema.parse(item.entry).traits),
      ...backgrounds.map((item) => BackgroundSchema.parse(item.entry).feat),
    ];
    expect(references.length).toBeGreaterThan(5);
    expect(references.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("reads species, and keeps a choice of size in the text", () => {
    const moss = SpeciesSchema.parse(species[0]?.entry);
    expect(moss).toMatchObject({
      creatureType: "Plant",
      size: "medium",
      speed: 35,
      traits: [
        "my-book:feature/mossfolk-damp",
        "my-book:feature/mossfolk-spores",
      ],
    });
    expect(moss.text).toContain("Mossfolk grow slowly.");
    expect(moss.text).toContain("or Small");
    expect(species[0]?.notes).toHaveLength(1);
    const pebble = SpeciesSchema.parse(species[1]?.entry);
    expect(pebble.size).toBe("small");
    expect(pebble.text).toBe("Pebblelings are small.");
  });

  it("reads backgrounds only from their own section", () => {
    expect(backgrounds).toHaveLength(1);
    expect(BackgroundSchema.parse(backgrounds[0]?.entry)).toEqual({
      id: "my-book:background/tinker",
      name: "Tinker",
      abilities: ["int", "wis", "cha"],
      feat: "my-book:feat/spark-touched",
      skills: ["sleightOfHand", "arcana"],
      tool: "Choose one kind of Pliers",
    });
    expect(backgrounds[0]?.notes.join(" ")).toContain("Warden");
  });

  it("files feats under the category of their section", () => {
    const parsed = feats.map((item) => FeatSchema.parse(item.entry));
    expect(parsed.map((feat) => [feat.name, feat.category])).toEqual([
      ["Spark Touched", "origin"],
      ["Boon of Bark", "epicBoon"],
    ]);
    expect(parsed[1]?.text).toContain("Level 19+");
  });

  it("reads weapons and armor, including a weapon with flat damage", () => {
    const item = (slug: string) =>
      equipment.find((entry) => entry.slug === slug);
    expect(ItemSchema.parse(item("long-twig")?.entry)).toEqual({
      id: "my-book:item/long-twig",
      name: "Long Twig",
      type: "weapon",
      category: "martial",
      damage: { dice: "1d8", type: "piercing" },
      properties: ["ammunition", "twoHanded", "versatile"],
      mastery: "slow",
      costCp: 500,
      weightLb: 2,
    });
    expect(item("long-twig")?.notes).toHaveLength(2);
    expect(ItemSchema.parse(item("seed-spitter")?.entry)).toMatchObject({
      damage: { flat: 1, type: "piercing" },
    });
    expect(ItemSchema.parse(item("bark-vest")?.entry)).toMatchObject({
      armorType: "medium",
      base: 13,
      addDex: true,
      maxDex: 2,
    });
    expect(ItemSchema.parse(item("log-plate")?.entry)).toMatchObject({
      armorType: "heavy",
      base: 17,
      addDex: false,
      costCp: 900,
      weightLb: 60,
    });
    expect(ItemSchema.parse(item("lid")?.entry)).toMatchObject({
      type: "shield",
      bonus: 2,
      costCp: 100,
      weightLb: 6,
    });
  });

  it("marks text features as text only in the draft", async () => {
    const storage = memoryStorage({});
    await importParsed({
      storage,
      system: dnd55e,
      pluginId: "my-book",
      folder: "features",
      html: page,
    });
    expect(
      await storage.read("books/import/my-book/features/warden-roots.yaml"),
    ).toContain("status: textOnly");
  });
});
