import { describe, expect, it } from "vitest";
import { parseMonstersFromHtml } from "../plugins/systems/dnd5.5e/core/import/monsters.ts";
import {
  type Monster,
  MonsterSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";

// Stat blocks and spells made up for these tests, in the shapes books print.
const row = (name: string, score: number) => {
  const mod = Math.floor((score - 10) / 2);
  return `<tr><th>${name}</th><td>${String(score)}</td><td>${String(mod)}</td><td>${String(mod)}</td></tr>`;
};

function block(name: string, paragraphs: string): string {
  return `<div class="stat-block">
    <h3>${name}</h3>
    <p>Medium Humanoid, Neutral</p>
    <p><strong>AC</strong> 12</p>
    <p><strong>HP</strong> 40 (9d8)</p>
    <p><strong>Speed</strong> 30 ft.</p>
    <table>${row("Str", 10)}${row("Dex", 14)}${row("Con", 12)}${row("Int", 18)}${row("Wis", 12)}${row("Cha", 10)}</table>
    <p><strong>CR</strong> 6 (XP 2,300; PB +3)</p>
    ${paragraphs}
  </div>`;
}

const entry = (label: string, text: string): string =>
  `<p><strong><em>${label}.</em></strong> ${text}</p>`;
const header = (title: string): string =>
  `<p class="monster-header">${title}</p>`;

const spells: Record<string, unknown> = {
  "lib:spell/hush": {
    id: "lib:spell/hush",
    name: "Hush",
    level: 3,
    school: "abjuration",
    classes: [],
    castingTime: "Reaction",
    range: "60 feet",
    components: "S",
    duration: "instantaneous",
    text: "Stops a spell.",
    automation: "full",
    activation: {
      cost: ["reaction", "slot"],
      trigger: { spellCast: true },
      targeting: { creatures: 1, range: 60, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "con",
        dc: { add: [{ kind: "spellSaveDc" }] },
        onFail: [{ kind: "counter" }],
      },
    },
  },
  "lib:spell/ember-burst": {
    id: "lib:spell/ember-burst",
    name: "Ember Burst",
    level: 3,
    school: "evocation",
    classes: [],
    castingTime: "Action",
    range: "120 feet",
    components: "V, S",
    duration: "instantaneous",
    text: "Sparks.",
    automation: "full",
    activation: {
      cost: ["action", "slot"],
      targeting: {
        area: { shape: "sphere", radius: 20 },
        range: 120,
        side: "enemy",
      },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: { add: [{ kind: "spellSaveDc" }] },
        damage: [{ amount: { dice: "6d6" }, type: "fire" }],
        onSuccessDamage: "half",
      },
    },
    upcast: { perSlotLevel: { addDice: "1d6" } },
  },
  "lib:spell/frost-needle": {
    id: "lib:spell/frost-needle",
    name: "Frost Needle",
    level: 0,
    school: "evocation",
    classes: [],
    castingTime: "Action",
    range: "60 feet",
    components: "V, S",
    duration: "instantaneous",
    text: "Cold.",
    automation: "full",
    activation: {
      cost: ["action"],
      targeting: { creatures: 1, range: 60, side: "enemy" },
      resolution: {
        kind: "attack",
        attack: { type: "spell" },
        damage: [{ amount: { dice: "1d8" }, type: "cold" }],
      },
    },
  },
  "lib:spell/mending-word": {
    id: "lib:spell/mending-word",
    name: "Mending Word",
    level: 1,
    school: "abjuration",
    classes: [],
    castingTime: "Bonus Action",
    range: "60 feet",
    components: "V",
    duration: "instantaneous",
    text: "Heals.",
    automation: "full",
    activation: {
      cost: ["bonusAction", "slot"],
      targeting: { creatures: 1, range: 60, side: "ally" },
      resolution: {
        kind: "automatic",
        effects: [
          {
            kind: "heal",
            amount: { dice: "2d4", bonus: { add: [{ kind: "spellMod" }] } },
          },
        ],
      },
    },
  },
  "lib:spell/glow": {
    id: "lib:spell/glow",
    name: "Glow",
    level: 0,
    school: "evocation",
    classes: [],
    castingTime: "Action",
    range: "Touch",
    components: "V",
    duration: { minutes: 60 },
    text: "Light.",
    automation: "text",
  },
  "lib:spell/create-or-destroy-water": {
    id: "lib:spell/create-or-destroy-water",
    name: "Create or Destroy Water",
    level: 1,
    school: "transmutation",
    classes: [],
    castingTime: "Action",
    range: "30 feet",
    components: "V, S",
    duration: "instantaneous",
    text: "Water.",
    automation: "text",
    outOfCombat: "utility",
  },
};
const knownIds = Object.keys(spells);
const contentOf = (id: string): unknown => spells[id];

function parse(paragraphs: string, withSpells = true): Monster {
  const [parsed] = parseMonstersFromHtml(
    block("Test Caster", paragraphs),
    "my-book",
    withSpells ? knownIds : undefined,
    withSpells ? contentOf : undefined,
  );
  return MonsterSchema.parse(parsed?.entry);
}

const byName = (monster: Monster, name: string) =>
  monster.actions.find((action) => action.name === name);

describe("monster bonus actions that take an action anyone can", () => {
  it("reads Nimble Escape and Cunning Action as Bonus Action tactics", () => {
    const club = entry(
      "Club",
      "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
    );
    const goblin = parseMonstersFromHtml(
      block(
        "Goblin",
        `${header("Actions")}${club}${header("Bonus Actions")}${entry("Nimble Escape", "The goblin takes the Disengage or Hide action.")}`,
      ),
      "my-book",
    )[0];
    expect(goblin?.notes).toEqual([]);
    expect(MonsterSchema.parse(goblin?.entry).passives).toContainEqual({
      kind: "bonusTactics",
      tactics: ["disengage", "hide"],
    });
    const spy = parse(
      `${header("Actions")}${club}${header("Bonus Actions")}${entry("Cunning Action", "The spy takes the Dash, Disengage, or Hide action.")}`,
    );
    expect(spy.passives).toContainEqual({
      kind: "bonusTactics",
      tactics: ["dash", "disengage", "hide"],
    });
  });

  it("reads Charge as a Dash, of half the Speed when it says so", () => {
    const club = entry(
      "Club",
      "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
    );
    const troll = parse(
      `${header("Actions")}${club}${header("Bonus Actions")}${entry("Charge", "The troll moves up to half its Speed straight toward an enemy it can see.")}`,
    );
    expect(troll.passives).toContainEqual({
      kind: "bonusTactics",
      tactics: ["dash"],
      half: true,
    });
    const xorn = parse(
      `${header("Actions")}${club}${header("Bonus Actions")}${entry("Charge", "The xorn moves up to its Speed or Burrow Speed straight toward an enemy it can sense.")}`,
    );
    expect(xorn.passives).toContainEqual({
      kind: "bonusTactics",
      tactics: ["dash"],
    });
  });
});

describe("monster reactions that cast a spell", () => {
  it("keeps a spell with its own trigger, as a reaction with the entry's uses", () => {
    const club = entry(
      "Club",
      "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
    );
    const mage = parse(
      `${header("Actions")}${club}${header("Reactions")}${entry("Protective Magic (3/Day)", "The mage casts Hush in response to the spell’s trigger, using Intelligence (spell save DC 17).")}`,
    );
    const hush = byName(mage, "Hush");
    expect(hush?.perDay).toBe(3);
    expect(hush?.activation.cost).toEqual([
      "reaction",
      { resource: "day:protective-magic" },
    ]);
    expect(hush?.activation.trigger).toEqual({ spellCast: true });
    expect(hush?.activation.resolution).toMatchObject({ dc: { base: 17 } });
  });
});

describe("monster teleports and leaps", () => {
  it("reads Teleport, Leap and Misty Step as a move to a chosen square", () => {
    const club = entry(
      "Club",
      "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
    );
    const parsed = parseMonstersFromHtml(
      block(
        "Blinker",
        `${header("Actions")}${club}${header("Bonus Actions")}${entry("Teleport (Recharge 4–6)", "The dog teleports up to 40 feet to an unoccupied space it can see.")}${entry("Leap", "The bulette jumps up to 30 feet by spending 10 feet of movement.")}${entry("Misty Step (3/Day)", "The mage casts Misty Step, using the same spellcasting ability as Spellcasting.")}`,
      ),
      "my-book",
    )[0];
    expect(parsed?.notes).toEqual([]);
    const monster = MonsterSchema.parse(parsed?.entry);
    const move = (name: string) => byName(monster, name)?.activation.resolution;
    expect(byName(monster, "Teleport")).toMatchObject({
      recharge: 4,
      activation: {
        cost: ["bonusAction", { resource: "recharge:teleport" }],
        targeting: { self: true },
      },
    });
    expect(move("Teleport")).toMatchObject({
      effects: [{ kind: "teleport", feet: 40, movement: 0 }],
    });
    expect(move("Leap")).toMatchObject({
      effects: [{ kind: "teleport", feet: 30, movement: 10 }],
    });
    expect(byName(monster, "Misty Step")).toMatchObject({ perDay: 3 });
    expect(move("Misty Step")).toMatchObject({
      effects: [{ kind: "teleport", feet: 30, movement: 0 }],
    });
  });
});

describe("monster saves after a lead-in", () => {
  it("takes the range from the lead-in and the area from the save", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Rock Hurl (Recharge 6)",
        "The caster flings a rock at a point within 60 feet. Dexterity Saving Throw: DC 14, each creature in a 10-foot-radius Sphere centered on that point. Failure: 10 (3d6) Bludgeoning damage. Success: Half damage.",
      )}`,
    );
    expect(byName(monster, "Rock Hurl")?.activation).toMatchObject({
      targeting: {
        area: { shape: "sphere", radius: 10 },
        range: 60,
        side: "enemy",
      },
      resolution: { kind: "save", dc: { base: 14 }, onSuccessDamage: "half" },
    });
  });

  it("reads an area around the monster from a lead-in with no clause", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Blink Burst",
        "The caster teleports up to 30 feet, and each creature within 10 feet of where it arrives is subjected to the following effect. Constitution Saving Throw: DC 13. Failure: 7 (2d6) Thunder damage.",
      )}`,
    );
    expect(byName(monster, "Blink Burst")?.activation.targeting).toEqual({
      area: { shape: "emanation", radius: 10 },
      range: "self",
      side: "enemy",
    });
  });
});

describe("monster actions aimed only at a creature with a condition", () => {
  it("reads a Prone target", () => {
    const monster = parse(
      `${header("Bonus Actions")}${entry(
        "Stomp",
        "Dexterity Saving Throw: DC 15, one creature within 5 feet that has the Prone condition. Failure: 11 (2d10) Bludgeoning damage. Success: Half damage.",
      )}`,
    );
    expect(byName(monster, "Stomp")?.activation).toMatchObject({
      cost: ["bonusAction"],
      targeting: { creatures: 1, range: 5, targetConditions: ["prone"] },
    });
  });

  it("reads a target the monster is grappling, and a list of conditions", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Squeeze",
        "Strength Saving Throw: DC 14, one creature Grappled by the caster. Failure: 9 (2d8) Bludgeoning damage.",
      )}${entry(
        "Drain",
        "Constitution Saving Throw: DC 14, one creature within 5 feet that is willing or that has the Grappled, Incapacitated, or Restrained condition. Failure: 7 (2d6) Necrotic damage.",
      )}`,
    );
    expect(byName(monster, "Squeeze")?.activation.targeting).toMatchObject({
      targetConditions: ["grappled"],
    });
    expect(byName(monster, "Drain")?.activation.targeting).toMatchObject({
      targetConditions: ["grappled", "incapacitated", "restrained"],
    });
  });
});

describe("gated actions outside the action list", () => {
  it("reads a gated legendary action, as its targets are checked", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Test Caster",
        `${header("Actions")}${entry(
          "Slam",
          "Melee Attack Roll: +5, reach 5 ft. Hit: 7 (1d8 + 3) Bludgeoning damage.",
        )}${header("Legendary Actions")}<p>Legendary Action Uses: 3.</p>${entry(
          "Stomp",
          "Dexterity Saving Throw: DC 15, one creature within 5 feet that has the Prone condition. Failure: 11 (2d10) Bludgeoning damage.",
        )}`,
      ),
      "my-book",
    );
    expect(
      MonsterSchema.parse(parsed?.entry).legendary?.actions[0]?.activation
        ?.targeting,
    ).toMatchObject({ targetConditions: ["prone"] });
    expect(parsed?.notes).not.toContain(
      "not automated: legendary action Stomp",
    );
  });
});

describe("more monster save shapes", () => {
  it("reads a condition before the creature, or one the monster caused", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Dread Glare",
        "Wisdom Saving Throw: DC 12, one Frightened creature the caster can see within 30 feet. Failure: 9 (2d8) Psychic damage.",
      )}${entry(
        "Siphon",
        "Constitution Saving Throw: DC 12, one creature Charmed by the caster within 5 feet. Failure: 9 (2d8) Psychic damage.",
      )}`,
    );
    expect(byName(monster, "Dread Glare")?.activation.targeting).toEqual({
      creatures: 1,
      range: 30,
      side: "enemy",
      targetConditions: ["frightened"],
    });
    expect(byName(monster, "Siphon")?.activation.targeting).toEqual({
      creatures: 1,
      range: 5,
      side: "enemy",
      targetConditions: ["charmed"],
    });
  });

  it("keeps the damage of a save that also fells a weakened target", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Test Caster",
        `${header("Actions")}${entry(
          "Doom Word",
          "Constitution Saving Throw: DC 13, one creature within 30 feet. Failure: If the target has 20 Hit Points or fewer, it drops to 0 Hit Points. Otherwise, the target takes 10 (3d6) Necrotic damage.",
        )}`,
      ),
      "my-book",
    );
    const monster = MonsterSchema.parse(parsed?.entry);
    expect(byName(monster, "Doom Word")?.activation.resolution).toMatchObject({
      damage: [{ amount: { dice: "3d6" }, type: "necrotic" }],
    });
    expect(parsed?.notes).toContain(
      "partial: Doom Word: left out a Hit Point threshold",
    );
  });
});

describe("how long a monster's condition lasts", () => {
  it("reads a time, an end on damage, and the end of the monster's next turn", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Lull",
        "Wisdom Saving Throw: DC 13, one creature within 30 feet. Failure: The target has the Charmed condition for 1 hour or until it takes damage.",
      )}${entry(
        "Flash",
        "Constitution Saving Throw: DC 13, one creature within 30 feet. Failure: The target has the Blinded condition until the end of the caster’s next turn.",
      )}`,
    );
    expect(byName(monster, "Lull")?.activation.resolution).toMatchObject({
      onFail: [
        {
          condition: "charmed",
          duration: { minutes: 60 },
          endsOnDamage: true,
        },
      ],
    });
    expect(byName(monster, "Flash")?.activation.resolution).toMatchObject({
      onFail: [
        { condition: "blinded", duration: { until: "yourNextTurnEnd" } },
      ],
    });
  });
});

describe("monster spellcasting", () => {
  const spellcasting = `${header("Actions")}${entry(
    "Spellcasting",
    "The caster casts one of the following spells, using Intelligence as the spellcasting ability (spell save DC 15, +7 to hit with spell attacks):",
  )}<p>At Will: Frost Needle, Glow</p><p>2/Day Each: Ember Burst (level 5 version), Warding Skin (included in AC)</p>`;

  it("turns each castable spell into an action with the monster's numbers", () => {
    const monster = parse(spellcasting);
    expect(monster.actions.map((action) => action.name)).toEqual([
      "Frost Needle",
      "Ember Burst",
    ]);
    expect(byName(monster, "Frost Needle")).toEqual({
      name: "Frost Needle",
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 60, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "spell", flatBonus: 7 },
          damage: [{ amount: { dice: "1d8" }, type: "cold" }],
          onHit: [],
          onMiss: [],
        },
      },
    });
  });

  it("casts a higher-level version as printed, a number of times a day", () => {
    expect(byName(parse(spellcasting), "Ember Burst")).toMatchObject({
      perDay: 2,
      activation: {
        cost: ["action", { resource: "day:ember-burst" }],
        resolution: {
          kind: "save",
          dc: { base: 15, add: [] },
          damage: [{ amount: { dice: "8d6" }, type: "fire" }],
        },
      },
    });
  });

  it("reads spell lists printed in the same paragraph", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Spellcasting",
        "The caster casts one of the following spells, using Intelligence as the spellcasting ability (spell save DC 15): At Will: Glow 1/Day: Ember Burst",
      )}`,
    );
    expect(byName(monster, "Ember Burst")).toMatchObject({ perDay: 1 });
  });

  it("reads a list run into the one before it with no break", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Spellcasting",
        "The caster casts one of the following spells, using Intelligence as the spellcasting ability (spell save DC 15): At Will: Frost Needle, Glow2/Day Each: Ember Burst",
      )}`,
    );
    expect(byName(monster, "Ember Burst")).toMatchObject({ perDay: 2 });
    expect(byName(monster, "Frost Needle")?.perDay).toBeUndefined();
  });

  it("reads an action that casts one of several spells, sharing its uses", () => {
    const monster = parse(
      `${spellcasting}${header("Bonus Actions")}${entry(
        "Field Aid (3/Day)",
        "The caster casts Glow or Mending Word, using the same spellcasting ability as Spellcasting.",
      )}`,
    );
    expect(byName(monster, "Mending Word")).toMatchObject({
      perDay: 3,
      activation: {
        cost: ["bonusAction", { resource: "day:field-aid" }],
        resolution: {
          effects: [
            {
              kind: "heal",
              amount: { dice: "2d4", bonus: { base: 4, add: [] } },
            },
          ],
        },
      },
    });
  });

  it("shares an older spell slot among the spells of its level", () => {
    const monster = parse(
      `${header("Traits")}${entry(
        "Spellcasting",
        "The caster is a 9th-level spellcaster. Its spellcasting ability is Intelligence (spell save DC 14, +6 to hit with spell attacks). It has the following wizard spells prepared:",
      )}<p>Cantrips (at will): frost needle</p><p>3rd level (3 slots): ember burst</p>${header("Actions")}${entry(
        "Staff",
        "Melee Weapon Attack: +3 to hit, reach 5 ft., one target. Hit: 3 (1d6) bludgeoning damage.",
      )}`,
    );
    expect(byName(monster, "Ember Burst")).toMatchObject({
      perDay: 3,
      activation: {
        cost: ["action", { resource: "day:level-3-slots" }],
        resolution: { dc: { base: 14 } },
      },
    });
    expect(
      byName(monster, "Frost Needle")?.activation.resolution,
    ).toMatchObject({ attack: { flatBonus: 6 } });
  });

  it("notes no combat use for a list of spells a fight never needs, and keeps an unplayed one a gap", () => {
    const notesOf = (list: string): readonly string[] =>
      parseMonstersFromHtml(
        block(
          "Test Caster",
          `${header("Actions")}${entry(
            "Spellcasting",
            `The caster casts one of the following spells, using Intelligence as the spellcasting ability (spell save DC 15): At Will: ${list}`,
          )}`,
        ),
        "my-book",
        knownIds,
        contentOf,
      )[0]?.notes ?? [];
    expect(notesOf("Create or Destroy Water")).toContain(
      "no combat use: Spellcasting",
    );
    expect(notesOf("Create or Destroy Water, Glow")).toContain(
      "not automated: Spellcasting",
    );
  });

  it("leaves Spellcasting as text when no spells are loaded", () => {
    const [parsed] = parseMonstersFromHtml(
      block("Test Caster", spellcasting),
      "my-book",
    );
    expect(parsed?.notes).toContain("not automated: Spellcasting");
    expect(parse(spellcasting, false).actions).toEqual([]);
  });
});

describe("monster actions read in round 3", () => {
  it("swallows a grappled target: blinded and restrained, with damage each turn", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Gulp",
        "Strength Saving Throw: DC 15, one creature Grappled by the caster. Failure: The target is pulled inside and is no longer Grappled. While swallowed, the target has the Blinded and Restrained conditions. It takes 5 (2d4) Acid damage at the start of each of the caster’s turns.",
      )}`,
    );
    const gulp = byName(monster, "Gulp")?.activation;
    expect(gulp?.targeting).toMatchObject({ targetConditions: ["grappled"] });
    expect(gulp?.resolution).toMatchObject({
      onFail: [
        { kind: "removeCondition", condition: "grappled" },
        { kind: "applyCondition", condition: "blinded" },
        { kind: "applyCondition", condition: "restrained" },
        {
          kind: "modifier",
          modifier: {
            kind: "lingeringDamage",
            when: "turnStart",
            damage: [{ amount: { dice: "2d4" }, type: "acid" }],
          },
        },
      ],
    });
  });

  it("reads an older save, its area from the lead-in, and an older condition", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Spark",
        "Sparks leap from the caster toward one creature within 60 feet. The target must make a DC 13 Dexterity saving throw, taking 9 (2d8) lightning damage on a failed save, or half as much damage on a successful one.",
      )}${entry(
        "Wail",
        "A shriek fills a 30-foot cone. Any creature in that area must succeed on a DC 12 Wisdom saving throw or take 7 (2d6) psychic damage and be frightened until the end of the caster’s next turn.",
      )}`,
    );
    expect(byName(monster, "Spark")?.activation).toMatchObject({
      targeting: { creatures: 1, range: 60 },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: { base: 13 },
        damage: [{ amount: { dice: "2d8" }, type: "lightning" }],
        onSuccessDamage: "half",
      },
    });
    expect(byName(monster, "Wail")?.activation).toMatchObject({
      targeting: { area: { shape: "cone", radius: 30 } },
      resolution: {
        onSuccessDamage: "none",
        onFail: [
          { condition: "frightened", duration: { until: "yourNextTurnEnd" } },
        ],
      },
    });
  });

  it("holds size limits a hero always meets, and keeps an Advantage rider out", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Lash",
        "Melee Attack Roll: + 6, reach 10 ft. Hit: 8 (1d8 + 4) Bludgeoning damage. If the target is the caster’s size or smaller, it has the Grappled condition.",
      )}${entry(
        "Wrap",
        "Melee Attack Roll: +6, reach 5 ft. Hit: 8 (1d8 + 4) Bludgeoning damage. If the target is a Medium or smaller creature and the caster had Advantage on the attack roll, the target has the Blinded condition.",
      )}${entry(
        "Pull",
        "Strength Saving Throw: DC 14, one Medium or Small creature within 5 feet. Failure: The target has the Prone condition.",
      )}`,
    );
    expect(byName(monster, "Lash")?.activation.resolution).toMatchObject({
      attack: { flatBonus: 6 },
      onHit: [{ condition: "grappled" }],
    });
    expect(byName(monster, "Wrap")?.activation.resolution).toMatchObject({
      onHit: [],
    });
    expect(byName(monster, "Pull")?.activation.resolution).toMatchObject({
      onFail: [{ condition: "prone" }],
    });
  });

  it("leaves a critical-hit rider and reads an end on any damage", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Test Caster",
        `${header("Actions")}${entry(
          "Jolt",
          "Melee Attack Roll: +6, reach 5 ft. Hit: 8 (1d8 + 4) Lightning damage. Critical Hit: The target has the Stunned condition until the end of its next turn.",
        )}${entry(
          "Lull",
          "Wisdom Saving Throw: DC 13, each creature in a 30-foot Emanation originating from the caster. Failure: The target has the Charmed condition for 1 minute. The effect ends on the target if it takes any damage.",
        )}`,
      ),
      "my-book",
    );
    const monster = MonsterSchema.parse(parsed?.entry);
    expect(byName(monster, "Jolt")?.activation.resolution).toMatchObject({
      onHit: [],
    });
    expect(parsed?.notes).toContain(
      "partial: Jolt: left out a Critical Hit rider",
    );
    expect(byName(monster, "Lull")?.activation.resolution).toMatchObject({
      onFail: [{ condition: "charmed", endsOnDamage: true }],
    });
  });
});

describe("monster actions read in round 4", () => {
  it("swallows with Total Cover and two damage types each turn", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Gobble",
        "Strength Saving Throw: DC 16, one Large or smaller creature Grappled by the caster. Failure: The target is swallowed, and the Grappled condition ends. A swallowed creature has the Blinded and Restrained conditions, has Total Cover against attacks and other effects outside the caster, and takes 7 (2d6) Acid damage plus 3 (1d6) Cold damage at the start of each of the caster’s turns.",
      )}`,
    );
    expect(byName(monster, "Gobble")?.activation.resolution).toMatchObject({
      onFail: [
        { kind: "removeCondition", condition: "grappled" },
        { condition: "blinded" },
        { condition: "restrained" },
        {
          modifier: {
            kind: "lingeringDamage",
            damage: [
              { amount: { dice: "2d6" }, type: "acid" },
              { amount: { dice: "1d6" }, type: "cold" },
            ],
          },
        },
      ],
    });
  });

  it("swallows a creature it is grappling with no roll", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Gulp",
        "The caster swallows a Medium or smaller target it is grappling. While swallowed, the target isn’t Grappled but has the Blinded and Restrained conditions. In addition, the target takes 4 (1d8) Acid damage at the end of each of the caster’s turns.",
      )}`,
    );
    expect(byName(monster, "Gulp")?.activation).toMatchObject({
      targeting: { creatures: 1, targetConditions: ["grappled"] },
      resolution: {
        kind: "automatic",
        effects: [
          { kind: "removeCondition", condition: "grappled" },
          { condition: "blinded" },
          { condition: "restrained" },
          { modifier: { kind: "lingeringDamage", when: "turnEnd" } },
        ],
      },
    });
  });
  it("keeps a swallow's size limit when it leaves out some heroes", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Gulp",
        "The caster swallows a Small or smaller target it is grappling. While swallowed, the target isn’t Grappled but has the Blinded and Restrained conditions.",
      )}`,
    );
    expect(byName(monster, "Gulp")?.activation.targeting).toMatchObject({
      targetConditions: ["grappled"],
      maxSize: "small",
    });
  });
  it("reads a save a hit brings, its creature gate, and a condition lasting as another does", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Claw",
        "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage. If the target is a creature that isn’t an Undead or elf, it is subjected to the following effect. Constitution Saving Throw: DC 10. Failure: The target has the Poisoned condition and repeats the save at the end of each of its turns, ending the effect on itself on a success. While Poisoned, the target has the Stunned condition.",
      )}${entry(
        "Sting",
        "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Poison damage. If this damage reduces the target to 0 Hit Points, it has the Poisoned condition for 1 hour. While Poisoned, the target also has the Paralyzed condition.",
      )}`,
    );
    expect(byName(monster, "Claw")?.activation.resolution).toMatchObject({
      onHit: [],
      onHitSave: {
        ability: "con",
        dc: { base: 10 },
        exempt: ["undead", "elf"],
        onFail: [
          { condition: "poisoned", duration: { minutes: 1 }, repeatSave: true },
          { condition: "stunned", duration: { minutes: 1 }, repeatSave: true },
        ],
      },
    });
    // The Poisoned it would last as is left out, so it is too.
    expect(byName(monster, "Sting")?.activation.resolution).toMatchObject({
      onHit: [],
    });
  });

  it("reads Disadvantage on one ability's D20 Tests and a damage penalty, saved against each turn", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Sap Breath",
        "Strength Saving Throw: DC 15, each creature in a 30-foot Cone. Failure: The target has Disadvantage on Strength-based D20 Tests and subtracts 2 (1d4) from its damage rolls. It repeats the save at the end of each of its turns, ending the effect on itself on a success.",
      )}`,
    );
    const onFail = byName(monster, "Sap Breath")?.activation.resolution;
    expect(onFail).toMatchObject({
      onFail: [
        {
          modifier: { kind: "disadvantage", on: "attacks", ability: "str" },
          repeatSave: true,
        },
        { modifier: { kind: "disadvantage", on: "saves", ability: "str" } },
        { modifier: { kind: "disadvantage", on: "checks", ability: "str" } },
        {
          modifier: {
            kind: "damageBonus",
            amount: { dice: "1d4" },
            subtract: true,
          },
          repeatSave: true,
        },
      ],
    });
  });

  it("turns a condition into a worse one on a failed repeat save", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Stone Gaze",
        "Constitution Saving Throw: DC 12, each creature in a 30-foot Cone. First Failure: The target has the Restrained condition and repeats the save at the end of its next turn if it is still Restrained, ending the effect on itself on a success. Second Failure: The target has the Petrified condition instead of the Restrained condition.",
      )}${entry(
        "Drowse Breath",
        "Constitution Saving Throw: DC 12, each creature in a 15-foot Cone. Failure: The target has the Incapacitated condition until the end of its next turn, at which point it repeats the save. Second Failure: The target has the Unconscious condition for 1 minute. This effect ends for the target if it takes damage.",
      )}`,
    );
    expect(byName(monster, "Stone Gaze")?.activation.resolution).toMatchObject({
      onFail: [
        {
          condition: "restrained",
          repeatSave: true,
          secondFailure: { condition: "petrified" },
        },
      ],
    });
    expect(
      byName(monster, "Drowse Breath")?.activation.resolution,
    ).toMatchObject({
      onFail: [
        {
          condition: "incapacitated",
          repeatSave: true,
          secondFailure: {
            condition: "unconscious",
            duration: { minutes: 1 },
            endsOnDamage: true,
          },
        },
      ],
    });
  });
  it("wakes only the Unconscious on damage, and reads a Restrained state's damage each turn", () => {
    const monster = parse(
      `${header("Actions")}${entry(
        "Dart",
        "Ranged Attack Roll: +5, range 30/120 ft. Hit: 5 (1d6 + 2) Piercing damage, and the target makes a saving throw. Constitution Saving Throw: DC 13. Failure: The target has the Poisoned condition for 1 hour. While Poisoned in this way, the target also has the Unconscious condition. The target wakes up if it takes damage.",
      )}${entry(
        "Gnaw",
        "Dexterity Saving Throw: DC 14, one creature Grappled by the caster. Failure: The caster bites down. The target is no longer Grappled but has the Restrained condition. While Restrained in this way, the target has Half Cover against attacks and other effects not originating from the caster and takes 7 (2d6) Piercing damage at the start of each of the caster’s turns.",
      )}`,
    );
    expect(byName(monster, "Dart")?.activation.resolution).toMatchObject({
      onHitSave: {
        onFail: [
          {
            condition: "poisoned",
            duration: { minutes: 60 },
            endsOnDamage: false,
          },
          {
            condition: "unconscious",
            duration: { minutes: 60 },
            endsOnDamage: true,
          },
        ],
      },
    });
    expect(byName(monster, "Gnaw")?.activation.resolution).toMatchObject({
      onFail: [
        { kind: "removeCondition", condition: "grappled" },
        { condition: "restrained" },
        {
          modifier: {
            kind: "lingeringDamage",
            damage: [{ amount: { dice: "2d6" }, type: "piercing" }],
          },
        },
      ],
    });
  });
});

describe("legendary actions that cast a spell", () => {
  const caster = `${header("Actions")}${entry(
    "Club",
    "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
  )}${entry(
    "Spellcasting",
    "The caster casts one of the following spells, using Intelligence as the spellcasting ability (spell save DC 15):",
  )}<p>At Will: Frost Needle</p>${header("Legendary Actions")}<p>Legendary Action Uses: 3. Right after another creature’s turn, the caster spends a use on one of these.</p>`;

  it("reads the spell, at the level it names, with the block's numbers and no cost of its own", () => {
    const monster = parse(
      `${caster}${entry(
        "Flare",
        "The caster uses Spellcasting to cast Ember Burst (level 5 version). The caster can’t take this action again until the start of its next turn.",
      )}${entry(
        "Hex Bolt",
        "The caster casts Frost Needle or Ember Burst, using the same spellcasting ability as Spellcasting.",
      )}`,
    );
    const actions = monster.legendary?.actions ?? [];
    expect(actions.map((item) => item.name)).toEqual([
      "Flare",
      "Hex Bolt (Frost Needle)",
      "Hex Bolt (Ember Burst)",
    ]);
    expect(actions[0]).toMatchObject({
      oncePerRound: true,
      activation: {
        cost: [],
        resolution: {
          kind: "save",
          dc: { base: 15 },
          damage: [{ amount: { dice: "8d6" } }],
        },
      },
    });
    expect(actions[1]?.activation?.resolution).toMatchObject({
      attack: { type: "spell", flatBonus: 7 },
    });
  });

  it("notes what a cast leaves out, and keeps a flight as its move", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Test Caster",
        `${caster}${entry(
          "Cold Turn",
          "The caster uses Spellcasting to cast Ember Burst, and if the target fails its save, it also has the Stunned condition.",
        )}${entry(
          "Veiled Flight",
          "The caster uses Spellcasting to cast Frost Needle, and it can fly up to half its Fly Speed.",
        )}`,
      ),
      "my-book",
      knownIds,
      contentOf,
    );
    expect(parsed?.notes).toContain(
      "partial: Cold Turn: left out what follows it",
    );
    expect(parsed?.notes.join(" ")).not.toContain("Veiled Flight");
    const legend = MonsterSchema.parse(parsed?.entry).legendary;
    expect(legend?.actions[1]).toMatchObject({ moves: true });
  });
});

describe("monster traits read as passives", () => {
  const traits = (items: string) =>
    parseMonstersFromHtml(
      block(
        "Test Beast",
        `${header("Traits")}${items}${header("Actions")}${entry(
          "Club",
          "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
        )}`,
      ),
      "my-book",
    )[0];

  it("reads traits that move through creatures, walls and gaps, and leaps", () => {
    const parsed = traits(
      [
        entry(
          "Swarm",
          "The swarm can occupy another creature’s space and vice versa, and the swarm can move through any opening large enough for a Tiny beast.",
        ),
        entry(
          "Incorporeal Movement",
          "The beast can move through other creatures and objects as if they were Difficult Terrain.",
        ),
        entry(
          "Air Form",
          "The beast can enter an enemy’s space and stop there. It can move through a space as narrow as 1 inch without expending extra movement to do so.",
        ),
        entry(
          "Earth Glide",
          "The beast can burrow through nonmagical, unworked earth and stone.",
        ),
        entry(
          "Tunneler",
          "The beast can burrow through solid rock at half its Burrow Speed.",
        ),
        entry(
          "Standing Leap",
          "The beast’s Long Jump is up to 20 feet and its High Jump is up to 10 feet with or without a running start.",
        ),
        entry(
          "Running Leap",
          "With a 10-foot running start, the beast can Long Jump up to 25 feet.",
        ),
        entry(
          "Spider Climb",
          "The beast can climb difficult surfaces, including along ceilings, without needing to make an ability check.",
        ),
        entry(
          "Fire Form",
          "The beast can move through a space as narrow as 1 inch without expending extra movement to do so, and it can enter a creature’s space and stop there. The first time it enters a creature’s space on a turn, that creature takes 5 (1d10) Fire damage.",
        ),
        entry(
          "Ephemeral Movement",
          "The beast can move through other creatures and objects as if they were Difficult Terrain, and its movement doesn’t provoke Opportunity Attacks. It takes 5 (1d10) Force damage if it ends its turn inside an object.",
        ),
        entry(
          "Jumper",
          "The beast’s jump distance is determined using its Dexterity rather than its Strength.",
        ),
      ].join(""),
    );
    const through = (fields: object) => ({
      kind: "moveThrough",
      walls: false,
      costly: false,
      squeeze: false,
      open: false,
      terrain: false,
      ...fields,
    });
    const shares = { kind: "shareSpace", who: "self", cover: false };
    expect(MonsterSchema.parse(parsed?.entry).passives).toEqual([
      through({ creatures: "any", squeeze: true, open: true }),
      shares,
      through({ creatures: "any", walls: true, costly: true }),
      through({ creatures: "any", squeeze: true }),
      shares,
      through({ walls: true }),
      through({ walls: true, costly: true }),
      { kind: "jump", feet: 20, runUp: 0 },
      { kind: "jump", feet: 25, runUp: 10 },
      through({ creatures: "any", squeeze: true }),
      {
        ...shares,
        burn: [{ amount: { dice: "1d10" }, type: "fire" }],
      },
      through({ creatures: "any", walls: true, costly: true }),
      { kind: "noOpportunityAttacks" },
      { kind: "jump", runUp: 10, ability: "dex" },
    ]);
    // Spider Climb is the stat block's Climb Speed, so nothing is left out.
    expect(parsed?.notes).toEqual([
      "partial: Tunneler: left out the tunnel it leaves",
    ]);
  });

  it("reads movement, saves and Advantage traits", () => {
    const parsed = traits(
      [
        entry(
          "Flyby",
          "The beast doesn’t provoke an Opportunity Attack when it flies out of an enemy’s reach.",
        ),
        entry(
          "Evasion",
          "If the beast is subjected to an effect that allows it to make a Dexterity saving throw to take only half damage, it takes no damage on a success and half on a failure.",
        ),
        entry(
          "Blood Frenzy",
          "The beast has Advantage on attack rolls against any creature that doesn’t have all its Hit Points.",
        ),
        entry(
          "Bloodied Frenzy",
          "While Bloodied, the beast has Advantage on attack rolls and saving throws.",
        ),
        entry(
          "Terrorizer",
          "The beast has Advantage on attack rolls against targets that have the Frightened condition.",
        ),
        entry("Immutable Form", "The beast can’t shape-shift."),
        entry(
          "Fey Ancestry",
          "The beast has Advantage on saving throws it makes to avoid or end the Charmed condition, and magic can’t put it to sleep.",
        ),
        entry(
          "Lucky",
          "When the beast rolls a 1 on the d20 of a D20 Test, it rerolls the die and uses the new roll.",
        ),
        entry(
          "Greater Magic Resistance",
          "The beast automatically succeeds on saves against spells.",
        ),
        entry(
          "Displacement",
          "Attack rolls against the beast have Disadvantage.",
        ),
      ].join(""),
    );
    expect(MonsterSchema.parse(parsed?.entry).passives).toEqual([
      { kind: "noOpportunityAttacks" },
      { kind: "evasion", anySave: false },
      { kind: "attackAdvantage", when: "targetHurt" },
      { kind: "attackAdvantage", when: "bloodied" },
      {
        kind: "saveAdvantage",
        abilities: ["str", "dex", "con", "int", "wis", "cha"],
        conditions: [],
        bloodied: true,
      },
      { kind: "attackAdvantage", when: "targetFrightened" },
      { kind: "immutableForm" },
      { kind: "saveAdvantage", abilities: [], conditions: ["charmed"] },
      { kind: "spellImmunity", spells: ["srd52:spell/sleep"] },
      { kind: "rerollOnes" },
      { kind: "magicResistance" },
      {
        kind: "modifier",
        modifier: { kind: "disadvantage", on: "attacksAgainst" },
      },
    ]);
    expect(parsed?.notes).toEqual([
      "partial: Greater Magic Resistance: left out succeeding on every save against spells",
      "partial: Displacement: left out its end while Incapacitated",
    ]);
  });

  it("reads absorbing, warding, reacting, flinching and striking-back traits", () => {
    const parsed = traits(
      [
        entry(
          "Fire Absorption",
          "Whenever the golem is subjected to Fire damage, it regains a number of Hit Points equal to the Fire damage dealt.",
        ),
        entry(
          "Diabolic Ward",
          "Attack rolls against the devil have Disadvantage. If the devil makes an attack roll, this trait is suppressed until the start of its next turn.",
        ),
        entry(
          "Incomprehensible Form",
          "Attack rolls against the horror have Disadvantage. This trait is suppressed while the horror has the Incapacitated condition.",
        ),
        entry(
          "Reactive",
          "The marilith can take one Reaction on every turn of combat.",
        ),
        entry("Invisibility", "The stalker has the Invisible condition."),
        entry(
          "Fear of Fire",
          "If the yeti takes Fire damage, it has Disadvantage on attack rolls and ability checks until the end of its next turn.",
        ),
        entry(
          "Corrosive Form",
          "A creature that hits the pudding with a melee attack roll takes 4 (1d8) Acid damage. Nonmagical ammunition is destroyed.",
        ),
        entry(
          "Immobile Restoration",
          "If the vampire drops to 0 Hit Points while it doesn’t have the Petrified condition, it turns to stone, regains 50 Hit Points, and has the Petrified condition for 1 hour.",
        ),
      ].join(""),
    );
    expect(MonsterSchema.parse(parsed?.entry).passives).toEqual([
      { kind: "absorb", damage: ["fire"] },
      { kind: "ward", suppressed: "attacking" },
      { kind: "ward", suppressed: "incapacitated" },
      { kind: "reactive" },
      { kind: "innateCondition", condition: "invisible" },
      {
        kind: "onDamage",
        damage: ["fire"],
        modifiers: [
          { kind: "disadvantage", on: "attacks" },
          { kind: "disadvantage", on: "checks" },
        ],
      },
      {
        kind: "modifier",
        modifier: {
          kind: "retaliate",
          damage: [{ amount: { dice: "1d8" }, type: "acid" }],
        },
      },
      { kind: "stoneRestoration", hp: 50 },
    ]);
    expect(parsed?.notes).toEqual([
      "partial: Corrosive Form: left out what it does to weapons and ammunition",
    ]);
  });

  it("reads other wordings of Bloodied Fury and Regeneration", () => {
    const parsed = traits(
      [
        entry(
          "Bloodied Fury",
          "The beast has Advantage on melee attack rolls while it is Bloodied.",
        ),
        entry(
          "Regeneration",
          "The beast gains 5 Hit Points at the start of each of its turns. If it takes Fire damage, this trait doesn’t function at the start of its next turn.",
        ),
      ].join(""),
    );
    expect(MonsterSchema.parse(parsed?.entry).passives).toEqual([
      { kind: "attackAdvantage", when: "bloodied" },
      { kind: "regeneration", hp: 5, stoppedBy: ["fire"] },
    ]);
  });

  it("reads Avoidance as Evasion on every save", () => {
    const parsed = traits(
      entry(
        "Avoidance",
        "If the beast is subjected to an effect that allows it to make a saving throw to take only half damage, it takes none on a success.",
      ),
    );
    expect(MonsterSchema.parse(parsed?.entry).passives).toEqual([
      { kind: "evasion", anySave: true },
    ]);
  });

  it("marks traits a grid fight never needs, and leaves the rest as not automated", () => {
    const parsed = traits(
      [
        entry("Amphibious", "The beast can breathe air and water."),
        entry(
          "Abyssal Restoration",
          "If the beast dies, it revives with all its Hit Points in 1d10 days far away.",
        ),
        entry("Shark Telepathy", "The beast can talk to sharks."),
        entry(
          "Undead Restoration",
          "If the beast is destroyed, it reforms and regains all its Hit Points in 1d10 days.",
        ),
        entry("Last Stand", "If the beast dies, it explodes."),
        entry("Web Walker", "The beast ignores webs."),
      ].join(""),
    );
    expect(parsed?.notes).toEqual([
      "no combat use: Amphibious",
      "no combat use: Abyssal Restoration",
      "no combat use: Shark Telepathy",
      "no combat use: Undead Restoration",
      "not automated: Last Stand",
      "not automated: Web Walker",
    ]);
  });

  it("reads traits an older book prints before any heading", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Old Beast",
        `${entry("Amphibious", "The beast can breathe air and water.")}${entry(
          "Flyby",
          "The beast doesn't provoke opportunity attacks when it flies out of an enemy's reach.",
        )}${header("Actions")}${entry(
          "Club",
          "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 4 (1d6 + 1) bludgeoning damage.",
        )}`,
      ),
      "my-book",
    );
    expect(parsed?.notes).toEqual(["no combat use: Amphibious"]);
    expect(MonsterSchema.parse(parsed?.entry).passives).toEqual([
      { kind: "noOpportunityAttacks" },
    ]);
  });
});

describe("monster reactions to being hit", () => {
  const club = entry(
    "Club",
    "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
  );
  it("reads Parry, Uncanny Dodge and an AC reaction that does more", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Test Duelist",
        `${header("Actions")}${club}${header("Reactions")}${[
          entry(
            "Parry",
            "Trigger: The duelist is hit by a melee attack roll while holding a weapon. Response: The duelist adds 3 to its AC against that attack, possibly causing it to miss.",
          ),
          entry(
            "Uncanny Dodge (2/Day)",
            "Trigger: The duelist is hit by an attack roll. Response: The duelist halves the damage (round down) it takes from that attack.",
          ),
          entry(
            "Riposte",
            "Trigger: The duelist is hit by a melee attack roll. Response: The duelist adds 2 to its AC against that attack, possibly causing it to miss. On a miss, it strikes back.",
          ),
        ].join("")}`,
      ),
      "my-book",
    );
    const monster = MonsterSchema.parse(parsed?.entry);
    expect(byName(monster, "Parry")?.activation).toMatchObject({
      cost: ["reaction"],
      trigger: { hitByAttack: true, melee: true },
      targeting: { self: true },
      resolution: { effects: [{ kind: "acAgainstHit", bonus: 3 }] },
    });
    expect(byName(monster, "Uncanny Dodge")).toMatchObject({
      perDay: 2,
      activation: {
        cost: ["reaction", { resource: "day:uncanny-dodge" }],
        trigger: { hitByAttack: true },
        resolution: { effects: [{ kind: "reduceDamage", halve: true }] },
      },
    });
    expect(
      byName(monster, "Uncanny Dodge")?.activation.trigger?.melee,
    ).toBeUndefined();
    expect(parsed?.notes).toEqual([
      "partial: Riposte: left out what follows it",
    ]);
  });

  it("reads reactions to rolls, damage, walks and attacks on others", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Test Warden",
        `${header("Actions")}${club}${header("Reactions")}${[
          entry(
            "Swap",
            "Trigger: A creature the warden can see makes an attack roll against it. Response: The warden chooses a Small or Medium ally within 5 feet of itself. The warden and that ally swap places, and the ally becomes the target of the attack instead.",
          ),
          entry(
            "Hit Back",
            "Trigger: The warden is hit by an attack roll. Response: The warden makes one Club attack against the triggering creature.",
          ),
          entry(
            "Sting (Recharge 5–6)",
            "Trigger: The warden takes damage from a creature within 5 feet. Response: The warden makes one Club attack, targeting the triggering creature.",
          ),
          entry(
            "Omen",
            "Trigger: The warden or an ally it can see makes a D20 Test. Response: The warden rolls 1d20 and chooses whether to use that roll in place of the d20 rolled for the D20 Test.",
          ),
          entry(
            "Wave",
            "Trigger: An enemy the warden can see enters a space within 5 feet of the warden. Response—Strength Saving Throw: DC 12, the triggering enemy. Failure: 7 (2d6) Cold damage. If the target is Large or smaller, it is pushed up to 10 feet straight away from the warden.",
          ),
          entry(
            "Hex",
            "Trigger: A creature the warden can see hits it with an attack roll. Response—Wisdom Saving Throw: DC 11, the triggering creature. Failure: The attack misses instead.",
          ),
          entry(
            "Backlash",
            "Trigger: The warden fails a saving throw against a spell or another magical effect created by a creature. Response: The triggering creature takes 2 (1d4) Psychic damage.",
          ),
          entry(
            "Soak (1/Day)",
            "Trigger: The warden takes Fire or Cold damage. Response: The warden gives itself Resistance to that instance of damage and gains 5 Temporary Hit Points.",
          ),
        ].join("")}`,
      ),
      "my-book",
    );
    const monster = MonsterSchema.parse(parsed?.entry);
    const effects = (name: string) => {
      const resolution = byName(monster, name)?.activation.resolution;
      return resolution?.kind === "automatic"
        ? resolution.effects
        : resolution?.kind === "save"
          ? resolution.onFail
          : [];
    };
    expect(byName(monster, "Swap")?.activation.trigger).toEqual({
      attacked: true,
    });
    expect(effects("Swap")).toEqual([{ kind: "redirect", charmed: false }]);
    expect(byName(monster, "Hit Back")?.activation).toMatchObject({
      trigger: { struck: true },
      targeting: { creatures: 1, side: "enemy" },
    });
    expect(effects("Hit Back")).toEqual([
      { kind: "strike", action: "Club", advantage: false, approach: false },
    ]);
    expect(byName(monster, "Sting")).toMatchObject({
      recharge: 5,
      activation: {
        cost: ["reaction", { resource: "recharge:sting" }],
        trigger: { damaged: true, within: 5 },
      },
    });
    expect(byName(monster, "Omen")?.activation.trigger).toEqual({
      rolled: {
        rolls: ["attack", "save", "check"],
        by: "selfOrAlly",
        when: "any",
      },
    });
    expect(effects("Omen")).toEqual([{ kind: "replaceRoll" }]);
    expect(byName(monster, "Wave")?.activation.trigger).toEqual({
      entersReach: true,
      within: 5,
    });
    expect(effects("Wave")).toContainEqual({
      kind: "forcedMove",
      feet: 10,
      direction: "away",
    });
    expect(byName(monster, "Hex")?.activation.trigger).toEqual({
      hitByAttack: true,
    });
    expect(effects("Hex")).toEqual([{ kind: "negateHit" }]);
    expect(byName(monster, "Soak")?.activation.trigger).toEqual({
      damaged: true,
      damagedBy: ["fire", "cold"],
      before: true,
    });
    expect(effects("Soak")).toEqual([
      { kind: "resistTrigger" },
      { kind: "tempHp", amount: { bonus: { base: 5, add: [] } } },
    ]);
    expect(byName(monster, "Backlash")?.activation).toMatchObject({
      trigger: { ownSave: "failed" },
      targeting: { creatures: 1, side: "enemy" },
      resolution: { damage: [{ amount: { dice: "1d4" }, type: "psychic" }] },
    });
    expect(parsed?.notes).toEqual([]);
  });
});

describe("a stat block's own shapes", () => {
  it("gates form-only entries and gives each shape a Shape-Shift", () => {
    const [parsed] = parseMonstersFromHtml(
      block(
        "Test Were",
        `${header("Traits")}${entry(
          "Flyby (Bat Form Only)",
          "The were doesn’t provoke an Opportunity Attack when it flies out of an enemy’s reach.",
        )}${header("Actions")}${entry(
          "Bite (Bat Form Only)",
          "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Piercing damage.",
        )}${entry(
          "Club",
          "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
        )}${header("Bonus Actions")}${entry(
          "Shape-Shift",
          "The were shape-shifts into a Tiny bat (Speed 5 ft., Fly Speed 30 ft.), or it returns to its true humanoid form.",
        )}`,
      ),
      "my-book",
    );
    const monster = MonsterSchema.parse(parsed?.entry);
    expect(monster.actions.map(({ name, shapes }) => [name, shapes])).toEqual([
      ["Bite", ["bat"]],
      ["Club", undefined],
      ["Shape-Shift (humanoid)", undefined],
      ["Shape-Shift (bat)", undefined],
    ]);
    expect(monster.passives).toEqual([]);
    expect(
      monster.shapes?.map(({ name, passives }) => [name, passives]),
    ).toEqual([
      ["humanoid", []],
      ["bat", [{ kind: "noOpportunityAttacks" }]],
    ]);
    expect(parsed?.notes).toEqual([]);
  });
});
