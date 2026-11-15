import { describe, expect, it } from "vitest";
import { parseMonstersFromHtml } from "../plugins/systems/dnd5.5e/core/import/monsters.ts";
import { MonsterSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";

// The monster one-offs of issue #117, read from made-up stat blocks in the shapes books print.
const row = (name: string, score: number) =>
  `<tr><th>${name}</th><td>${String(score)}</td><td>0</td><td>0</td></tr>`;

function block(paragraphs: string): string {
  return `<div class="stat-block"><h3>Test Beast</h3>
    <p>Medium Beast, Neutral</p><p><strong>AC</strong> 12</p><p><strong>HP</strong> 40 (9d8)</p>
    <p><strong>Speed</strong> 30 ft.</p>
    <table>${["Str", "Dex", "Con", "Int", "Wis", "Cha"].map((name) => row(name, 10)).join("")}</table>
    <p><strong>CR</strong> 3 (XP 700; PB +2)</p>${paragraphs}</div>`;
}

const entry = (label: string, text: string): string =>
  `<p><strong><em>${label}.</em></strong> ${text}</p>`;
const header = (title: string): string =>
  `<p class="monster-header">${title}</p>`;
const club = entry(
  "Club",
  "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.",
);

function parse(traits: string, actions = "", more = "") {
  const [parsed] = parseMonstersFromHtml(
    block(
      `${traits ? `${header("Traits")}${traits}` : ""}${header("Actions")}${club}${actions}${more}`,
    ),
    "my-book",
  );
  if (!parsed) throw new Error("no block");
  return { monster: MonsterSchema.parse(parsed.entry), notes: parsed.notes };
}

const named = (monster: { actions: { name: string }[] }, name: string) =>
  monster.actions.find((action) => action.name === name) as
    | { activation: { targeting: unknown; resolution: unknown; cost: unknown } }
    | undefined;

describe("one-off monster traits", () => {
  it("reads traits that hold only while Bloodied", () => {
    const { monster, notes } = parse(
      [
        entry(
          "Grim Hold",
          "The beast regains 7 Hit Points at the start of each of its turns if it is Bloodied and has at least 1 Hit Point.",
        ),
        entry(
          "Iron Nerve",
          "While Bloodied, the beast has Advantage on saving throws.",
        ),
        entry(
          "Numb",
          "While Bloodied, the beast has Immunity to the Charmed and Frightened conditions.",
        ),
        entry(
          "Ward of Bark",
          "While Bloodied, the beast has Resistance to Cold and Fire damage.",
        ),
      ].join(""),
    );
    expect(monster.passives).toEqual([
      { kind: "regeneration", hp: 7, stoppedBy: [], bloodied: true },
      {
        kind: "saveAdvantage",
        abilities: ["str", "dex", "con", "int", "wis", "cha"],
        conditions: [],
        bloodied: true,
      },
      { kind: "conditionImmunity", condition: "charmed", bloodied: true },
      { kind: "conditionImmunity", condition: "frightened", bloodied: true },
      {
        kind: "modifier",
        modifier: { kind: "resistance", damage: "cold" },
        bloodied: true,
      },
      {
        kind: "modifier",
        modifier: { kind: "resistance", damage: "fire" },
        bloodied: true,
      },
    ]);
    expect(notes).toEqual([]);
  });

  it("reads fortitude, sleep, sculpting, slowing, warding and madness traits", () => {
    const { monster } = parse(
      [
        entry(
          "Stubborn Gears",
          "If damage reduces the beast to 0 Hit Points, it makes a Constitution saving throw with a DC of 5 plus the damage taken unless the damage is Thunder or from a Critical Hit.",
        ),
        entry("Fey Blood", "Magic can’t put the beast to sleep."),
        entry(
          "Evocation Sculptor",
          "When it casts a spell that fills an area, it can spare itself and up to three other creatures it can see.",
        ),
        entry(
          "Melts",
          "If the beast takes Fire damage, its Speed decreases by 10 feet until the end of its next turn and it has Disadvantage on saving throws.",
        ),
        entry(
          "Haze",
          "Attack rolls against the beast are made with Disadvantage unless the beast has the Incapacitated condition.",
        ),
        entry(
          "Frenzy",
          "Whenever the beast starts its turn Bloodied, roll 1d6. On a 6, the beast goes berserk and attacks whatever is nearest.",
        ),
        entry(
          "Easily Swayed",
          "The beast has Disadvantage on saving throws to avoid or end the Charmed condition.",
        ),
      ].join(""),
    );
    expect(monster.passives).toEqual([
      { kind: "undeadFortitude", except: ["thunder"] },
      { kind: "spellImmunity", spells: ["srd52:spell/sleep"] },
      { kind: "sculptor", creatures: 3 },
      {
        kind: "onDamage",
        damage: ["fire"],
        modifiers: [
          {
            kind: "bonus",
            to: "speed",
            amount: { bonus: { base: 10, add: [] } },
            subtract: true,
          },
          { kind: "disadvantage", on: "saves" },
        ],
      },
      { kind: "ward", suppressed: "incapacitated" },
      { kind: "berserk" },
      { kind: "saveDisadvantage", conditions: ["charmed"] },
    ]);
  });

  it("reads areas round it, bursts where it falls, heads and coming back", () => {
    const { monster, notes } = parse(
      [
        entry(
          "Sticky Floor",
          "The ground in a 15-foot Emanation originating from the beast is Difficult Terrain.",
        ),
        entry(
          "Thorn Coat",
          "At the start of each of its turns, the beast deals 3 (1d6) Piercing damage to any creature it is grappling or any creature grappling it.",
        ),
        entry(
          "Last Gasp",
          "Wisdom Saving Throw: DC 12, each creature in a 10-foot Emanation originating from the beast when it dies. Failure: The target is cursed. While cursed, the target has the Blinded condition.",
        ),
        entry(
          "Many Heads",
          "The beast has three heads. Whenever the beast takes 20 damage or more on a single turn, one of its heads dies. At the end of each of its turns when it has a living head, it grows two heads for each of its heads that died since its last turn, unless it has taken Acid damage since its last turn. The beast regains 10 Hit Points when it grows new heads.",
        ),
        entry(
          "Second Life",
          "If damage reduces the beast to 0 Hit Points, it receives a random boon. The beast revives at the start of its next turn with half its Hit Points.",
        ),
      ].join(""),
    );
    expect(monster.passives).toMatchObject([
      { kind: "aura", radius: 15, area: { difficult: true } },
      {
        kind: "aura",
        radius: 5,
        area: {
          when: "ownerTurnStart",
          grappling: true,
          resolution: {
            kind: "automatic",
            damage: [{ amount: { dice: "1d6" }, type: "piercing" }],
          },
        },
      },
      {
        kind: "deathBurst",
        radius: 10,
        resolution: {
          kind: "save",
          ability: "wis",
          onFail: [{ kind: "applyCondition", condition: "blinded" }],
        },
      },
      {
        kind: "heads",
        heads: 3,
        damage: 20,
        regrow: 2,
        heal: 10,
        stoppedBy: ["acid"],
      },
      { kind: "reborn", hp: "half" },
    ]);
    expect(notes).toContain("partial: Second Life: left out its random boon");
  });

  it("marks what a grid fight never needs, and plays one variant of a lord", () => {
    const { monster, notes } = parse(
      [
        entry("Wind-Up Operation", "The beast sleeps until wound with a key."),
        entry(
          "Presence",
          "Wisdom Saving Throw: DC 14, any enemy that starts its turn in a 20-foot Emanation originating from the beast. Failure: The target suffers one of the following effects:",
        ),
        entry(
          "Dazzled (Forager Only)",
          "The target has the Charmed condition until the end of its next turn.",
        ),
        entry(
          "Shaken (Hunter Only)",
          "The target has the Frightened condition until the end of its next turn.",
        ),
      ].join(""),
    );
    expect(notes).toContain("no combat use: Wind-Up Operation");
    expect(notes).toContain(
      "partial: Presence: left out the other variants' effects",
    );
    expect(notes.some((note) => note.includes("Dazzled"))).toBe(false);
    expect(monster.passives).toMatchObject([
      {
        kind: "aura",
        radius: 20,
        area: {
          resolution: {
            onFail: [{ kind: "applyCondition", condition: "frightened" }],
          },
        },
      },
    ]);
  });
});

describe("one-off monster actions", () => {
  it("reads moves, boons, unseen turns, pulls and Rampage", () => {
    const { monster, notes } = parse(
      "",
      "",
      [
        header("Bonus Actions"),
        entry(
          "Paddle",
          "While underwater, the beast moves up to half its Swim Speed without provoking Opportunity Attacks.",
        ),
        entry(
          "Brace (Recharge 5–6)",
          "The beast hunkers down. The beast gains 12 Temporary Hit Points.",
        ),
        entry(
          "Fade",
          "The beast has the Invisible condition until the start of its next turn. This invisibility ends early immediately after the beast makes an attack roll.",
        ),
        entry(
          "Haul",
          "The beast pulls each creature Grappled by it up to 20 feet straight toward it.",
        ),
        entry(
          "Rampage (1/Day)",
          "Immediately after dealing damage to a creature that is already Bloodied, the beast moves up to half its Speed, and it makes one Club attack.",
        ),
      ].join(""),
    );
    expect(monster.passives).toContainEqual({
      kind: "bonusTactics",
      tactics: ["dash"],
      half: true,
      safe: true,
    });
    expect(named(monster, "Brace")?.activation).toMatchObject({
      targeting: { self: true },
      resolution: {
        effects: [{ kind: "tempHp", amount: { bonus: { base: 12 } } }],
      },
    });
    expect(named(monster, "Fade")?.activation.resolution).toMatchObject({
      effects: [
        {
          kind: "applyCondition",
          condition: "invisible",
          duration: { until: "itsNextTurnStart" },
          endsOn: "attack",
        },
      ],
    });
    expect(named(monster, "Haul")?.activation).toMatchObject({
      targeting: { targetConditions: ["grappled"], range: 20 },
      resolution: {
        effects: [{ kind: "forcedMove", feet: 20, direction: "toward" }],
      },
    });
    expect(named(monster, "Rampage")?.activation).toMatchObject({
      cost: ["bonusAction", { resource: "day:rampage" }],
      afterAction: true,
      targeting: { bloodied: true, range: 5 },
      resolution: { kind: "attack" },
    });
    expect(notes).toContain("partial: Paddle: left out needing water");
  });

  it("rolls among numbered options, a list printed under it, and damage types", () => {
    const { monster } = parse(
      "",
      [
        entry(
          "Sputter (Recharge 6)",
          "The beast randomly creates one of the following effects (roll 1d4): 1: Sparks. Dexterity Saving Throw: DC 12, each creature within 10 feet. Failure: 7 (2d6) Fire damage. 2: Fumes. Constitution Saving Throw: DC 12, each creature within 10 feet. Failure: The target has the Poisoned condition until the start of its next turn.",
        ),
        `<p><strong><em>Stare.</em></strong> The beast shoots one of these rays at a creature it can see within 60 feet of itself (roll 1d2):</p><ol><li><strong><em>Chill Ray.</em></strong> Constitution Saving Throw: DC 13. Failure: 9 (2d8) Cold damage.</li><li><strong><em>Dread Ray.</em></strong> Wisdom Saving Throw: DC 13. Failure: The target has the Frightened condition until the end of its next turn.</li></ol>`,
        entry(
          "Wild Pulse",
          "Dexterity Saving Throw: DC 13, each creature in a 10-foot-radius Sphere centered on a point within 60 feet. Failure: 10 (3d6) damage (roll 1d2 to determine damage type: 1—Cold; 2—Thunder). Success: Half damage.",
        ),
      ].join(""),
    );
    expect(named(monster, "Sputter")?.activation.resolution).toMatchObject({
      effects: [{ kind: "randomAction", of: ["Sparks", "Fumes"] }],
    });
    expect(
      monster.actions.find((action) => action.name === "Sparks"),
    ).toMatchObject({
      rolled: true,
      activation: {
        cost: [],
        targeting: { area: { shape: "emanation", radius: 10 } },
      },
    });
    expect(named(monster, "Stare")?.activation).toMatchObject({
      targeting: { range: 60 },
      resolution: {
        effects: [{ kind: "randomAction", of: ["Chill Ray", "Dread Ray"] }],
      },
    });
    // A ray takes its target from the action it's rolled for.
    expect(named(monster, "Chill Ray")?.activation).toMatchObject({
      targeting: { creatures: 1, range: 60 },
      resolution: { damage: [{ type: "cold" }] },
    });
    expect(
      named(monster, "Wild Pulse (Thunder)")?.activation.resolution,
    ).toMatchObject({
      damage: [{ amount: { dice: "3d6" }, type: "thunder" }],
      onSuccessDamage: "half",
    });
  });

  it("makes a choice of effects into actions of their own sharing the recharge", () => {
    const { monster, notes } = parse(
      "",
      [
        entry(
          "Lullaby (Recharge 5–6)",
          "Wisdom Saving Throw: DC 13, each enemy in a 30-foot Emanation originating from the beast. Failure: The target is subjected to the tune's effect:",
        ),
        entry(
          "Dozing",
          "The target has the Incapacitated condition for 1 minute. The effect ends on the target if it takes any damage.",
        ),
        entry("Dread", "The target has the Frightened condition for 1 minute."),
        entry(
          "Bite",
          "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Piercing damage.",
        ),
      ].join(""),
    );
    expect(named(monster, "Lullaby (Dozing)")?.activation).toMatchObject({
      cost: ["action", { resource: "recharge:lullaby" }],
      resolution: {
        onFail: [{ condition: "incapacitated", endsOnDamage: true }],
      },
    });
    expect(named(monster, "Lullaby (Dread)")?.activation).toMatchObject({
      cost: ["action", { resource: "recharge:lullaby" }],
    });
    // The next attack is an action of its own, not an option.
    expect(named(monster, "Bite")).toBeDefined();
    expect(notes.filter((note) => note.startsWith("not automated"))).toEqual(
      [],
    );
  });

  it("reads saves that slay, animated copies, touches of death and a vulnerability", () => {
    const { monster, notes } = parse(
      "",
      [
        entry(
          "Snuff (Recharge 6)",
          "The beast touches one creature within 5 feet. If the creature has 30 Hit Points or fewer, it dies. Otherwise, it takes 21 (6d6) Necrotic damage.",
        ),
        entry(
          "Wake Stones (1/Day)",
          "The beast magically animates up to two stones it can see within 30 feet of itself. Each stone uses the Test Beast stat block, except it can’t speak and it lacks this action.",
        ),
        entry(
          "Feast",
          "Constitution Saving Throw: DC 11, one living creature the beast can see within 5 feet that has 0 Hit Points. Failure: The target dies, and the beast regains 7 (2d6) Hit Points.",
        ),
      ].join(""),
    );
    expect(named(monster, "Snuff")?.activation.resolution).toMatchObject({
      kind: "automatic",
      damage: [{ amount: { dice: "6d6" }, type: "necrotic" }],
      effects: [{ kind: "slay", hpAtMost: 30 }],
    });
    expect(named(monster, "Wake Stones")?.activation.resolution).toMatchObject({
      effects: [
        { kind: "animate", count: 2, range: 30, lacks: ["Wake Stones"] },
      ],
    });
    expect(named(monster, "Feast")?.activation).toMatchObject({
      targeting: { downed: true, range: 5 },
      resolution: { onFail: [{ kind: "slay", hpAtMost: 1 }] },
    });
    expect(notes).toContain("partial: Feast: left out its healing");
  });

  it("reads curses an action looks for, and riders on saves and hits", () => {
    const { monster } = parse(
      "",
      [
        entry(
          "Hex Wave",
          "Dexterity Saving Throw: DC 14, each creature in a 30-foot Cone. Failure: 10 (3d6) Lightning damage. Success: Half damage. Failure or Success: The target is cursed until the end of the beast’s next turn.",
        ),
        entry(
          "Weary Glare",
          "Wisdom Saving Throw: DC 13, one creature the beast can see within 60 feet. Failure: 7 (2d6) Psychic damage, and the target gains 1 Exhaustion level.",
        ),
      ].join(""),
      [
        header("Bonus Actions"),
        entry(
          "Hex Strike",
          "Each creature cursed by the beast and within 30 feet of it takes 7 (2d6) Lightning damage.",
        ),
      ].join(""),
    );
    const mark = { kind: "modifier", modifier: { kind: "mark" } };
    expect(named(monster, "Hex Wave")?.activation.resolution).toMatchObject({
      onFail: [mark],
      onSuccess: [mark],
    });
    expect(named(monster, "Weary Glare")?.activation.resolution).toMatchObject({
      onFail: [{ kind: "exhaustion", levels: 1 }],
    });
    expect(named(monster, "Hex Strike")?.activation.targeting).toEqual({
      area: { shape: "emanation", radius: 30 },
      range: "self",
      side: "enemy",
      afflicted: "Hex Wave",
    });
  });

  it("reads one-off legendary actions and reactions", () => {
    const { monster, notes } = parse(
      "",
      "",
      [
        header("Reactions"),
        entry(
          "Allergy (1/Day)",
          "Trigger: A creature within 30 feet of the beast casts a spell. Response: The beast regains 9 Hit Points.",
        ),
        header("Legendary Actions"),
        `<p>Legendary Action Uses: 3. Immediately after another creature’s turn, the beast can expend a use to take one of the following actions.</p>`,
        entry(
          "Age",
          "Constitution Saving Throw: DC 14, one creature the beast can see within 60 feet. Failure: The target gains 1 Exhaustion level. Failure or Success: The beast can’t take this action again until the start of its next turn.",
        ),
        entry(
          "Glimmer",
          "The beast targets itself or one creature it can see within 30 feet of itself. The target gains 7 (2d6) Temporary Hit Points, and its AC increases by 1 until the end of the beast’s next turn.",
        ),
      ].join(""),
    );
    expect(named(monster, "Allergy")?.activation).toMatchObject({
      cost: ["reaction", { resource: "day:allergy" }],
      trigger: { spellCast: true },
      targeting: { range: 30 },
      resolution: { effects: [{ kind: "heal" }] },
    });
    expect(monster.legendary?.actions).toMatchObject([
      {
        name: "Age",
        oncePerRound: true,
        activation: { resolution: { onFail: [{ kind: "exhaustion" }] } },
      },
      {
        name: "Glimmer",
        activation: {
          targeting: { creatures: 1, range: 30, side: "ally" },
          resolution: {
            effects: [
              { kind: "tempHp", amount: { dice: "2d6" } },
              {
                kind: "modifier",
                modifier: { kind: "bonus", to: "ac" },
                duration: { until: "yourNextTurnEnd" },
              },
            ],
          },
        },
      },
    ]);
    expect(notes.filter((note) => note.startsWith("not automated"))).toEqual(
      [],
    );
  });
});
