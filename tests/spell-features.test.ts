import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  choiceOptions,
  levelChoices,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import {
  sceneSwapActions,
  swapFrames,
  swappable,
} from "../plugins/systems/dnd5.5e/core/swap.ts";
import { sceneCastActions } from "../plugins/systems/dnd5.5e/core/camp.ts";
import {
  classOptions,
  runClassOption,
} from "../plugins/systems/dnd5.5e/core/class-options.ts";
import { recovered } from "../plugins/systems/dnd5.5e/core/rest.ts";
import { leafEvents } from "../plugins/systems/dnd5.5e/core/combat/effects.ts";
import { castRiders } from "../plugins/systems/dnd5.5e/core/combat/school.ts";
import {
  freeOption,
  withMetamagic,
} from "../plugins/systems/dnd5.5e/core/metamagic.ts";
import { castsSilently } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { quickenedBars } from "../plugins/systems/dnd5.5e/core/combat/queries.ts";
import {
  type CharacterBuild,
  ClassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  applyDndEvent,
  effectiveBuild,
  freshActor,
  NS,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";

// Class and subclass spellcasting features (#166) and features that change spells (#176), on made-up classes,
// subclasses and features: ids and numbers only, so the tests run without the private books.

const text = "Test.";
const WIZARD = "srd52:class/wizard";
const FIGHTER = "test:class/blade";
const KNIGHT = "test:subclass/spell-knight";
const PRIEST = "test:class/priest";

const FIXTURES = [
  {
    id: FIGHTER,
    name: "Test Blade",
    hitDie: "d10",
    primaryAbilities: ["str"],
    savingThrows: ["str", "con"],
    weapons: ["simple", "martial"],
    armor: ["light", "medium", "heavy", "shield"],
    levels: Array.from({ length: 10 }, (_, index) => ({
      level: index + 1,
      grants: index === 2 ? ["test:feature/blade-subclass"] : [],
    })),
  },
  {
    id: KNIGHT,
    name: "Spell Knight",
    class: FIGHTER,
    spellcasting: { ability: "int", list: WIZARD },
    levels: [
      {
        level: 3,
        grants: ["test:feature/knight-spellcasting"],
        slots: [2],
        scaling: { cantrips: 2, preparedSpells: 3 },
      },
      { level: 4, slots: [3], scaling: { cantrips: 2, preparedSpells: 4 } },
      {
        level: 7,
        slots: [4, 2],
        scaling: { cantrips: 2, preparedSpells: 5 },
      },
    ],
  },
  {
    id: PRIEST,
    name: "Test Priest",
    hitDie: "d8",
    primaryAbilities: ["wis"],
    savingThrows: ["wis", "cha"],
    weapons: ["simple"],
    armor: ["light"],
    spellcasting: { ability: "wis" },
    swaps: { cantrips: "levelUp", spells: "longRest" },
    spellList: [
      "srd52:spell/sacred-flame",
      "srd52:spell/light",
      "srd52:spell/bless",
      "srd52:spell/cure-wounds",
      "srd52:spell/shield-of-faith",
      "srd52:spell/spare-the-dying",
    ],
    levels: [
      { level: 1, slots: [2], scaling: { cantrips: 2, preparedSpells: 2 } },
      {
        level: 2,
        slots: [3],
        scaling: { cantrips: 2, preparedSpells: 3 },
        choices: [
          {
            kind: "spells",
            id: "discoveries",
            count: 2,
            maxLevel: 1,
            upToSlots: true,
            cantrips: true,
            list: WIZARD,
            lists: [PRIEST],
          },
        ],
      },
      {
        level: 3,
        grants: ["test:feature/secrets"],
        choices: [
          {
            kind: "option",
            id: "pacts",
            count: 1,
            from: ["test:feature/tome"],
          },
        ],
        slots: [4, 2],
        scaling: { cantrips: 2, preparedSpells: 4 },
      },
    ],
  },
  {
    id: "test:feature/secrets",
    name: "Secrets",
    text,
    automation: "full",
    widens: { lists: [WIZARD] },
  },
  {
    id: "test:feature/lands",
    name: "Lands",
    text,
    automation: "full",
    variants: [
      {
        id: "fire",
        name: "Fire",
        spells: { 1: ["srd52:spell/burning-hands"] },
      },
      { id: "ice", name: "Ice", spells: { 1: ["srd52:spell/ice-knife"] } },
    ],
    variantSwap: "longRest",
  },
  {
    id: "test:feature/recovery",
    name: "Recovery",
    text,
    automation: "full",
    resources: [
      {
        id: "recovery-spell",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    freeCastsFrom: {
      feature: "test:feature/lands",
      resource: "recovery-spell",
    },
  },
  {
    id: "test:feature/charmer",
    name: "Charmer",
    text,
    automation: "full",
    spells: { 1: ["srd52:spell/hold-person"] },
    spellAbility: "cha",
    passives: [{ kind: "extraTarget", spells: ["srd52:spell/hold-person"] }],
  },
  {
    id: "test:feature/tome",
    name: "Tome",
    text,
    automation: "full",
    choices: [
      {
        kind: "spells",
        id: "tome-cantrips",
        count: 1,
        maxLevel: 0,
        swap: "shortRest",
      },
    ],
  },
  {
    id: "test:feature/mystic-focus",
    name: "Mystic Focus",
    text,
    automation: "full",
    resources: [
      {
        id: "focus",
        max: { base: 6 },
        recharge: [{ on: "shortRest", amount: "all" }],
      },
    ],
    passives: [
      { kind: "slotToPoints", resource: "focus" },
      {
        kind: "pointsToSlot",
        resource: "focus",
        class: PRIEST,
        costs: [
          { level: 1, points: 2, from: 1 },
          { level: 2, points: 3, from: 3 },
        ],
      },
    ],
  },
  {
    id: "test:feature/life",
    name: "Life",
    text,
    automation: "full",
    passives: [
      {
        kind: "spellHealing",
        bonus: { base: 2 },
        perSlot: true,
        slot: true,
      },
      { kind: "maxHealingDice" },
      {
        kind: "castRider",
        heals: true,
        slot: true,
        effects: [
          {
            kind: "heal",
            amount: { bonus: { base: 2, add: [{ kind: "slotLevel" }] } },
          },
        ],
      },
    ],
  },
  {
    id: "test:feature/evoker",
    name: "Evoker",
    text,
    automation: "full",
    passives: [
      {
        kind: "spellDamage",
        bonus: { add: [{ kind: "abilityMod", ability: "wis" }] },
        schools: ["evocation"],
        list: WIZARD,
      },
      {
        kind: "spellDamage",
        dice: "2d8",
        type: "force",
        types: ["fire"],
        oncePerTurn: true,
      },
    ],
  },
  {
    id: "test:feature/evoker-tricks",
    name: "Evoker Tricks",
    text,
    automation: "full",
    passives: [
      { kind: "potentCantrip" },
      {
        kind: "castsAs",
        spells: ["srd52:spell/dispel-magic"],
        cost: "bonusAction",
      },
      { kind: "silentCasting", schools: ["enchantment"], slot: true },
    ],
  },
  {
    id: "test:feature/ritual-adept",
    name: "Ritual Adept",
    text,
    automation: "full",
    passives: [{ kind: "ritualAdept", list: WIZARD }],
  },
  {
    id: "test:feature/blade-subclass",
    name: "Blade Subclass",
    text,
    automation: "full",
  },
  {
    id: "test:feature/knight-spellcasting",
    name: "Knight Spellcasting",
    text,
    automation: "full",
  },
];

let run: RunContext;
beforeAll(async () => {
  const loaded = await loadAdventure("goblin-ambush");
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  run = {
    ...loaded.run,
    content: (id) => byId.get(id) ?? loaded.run.content(id),
    contentIds: () => [...loaded.run.contentIds(), ...byId.keys()].sort(),
  };
});

type Answers = CharacterBuild["levels"][number]["answers"];

function blade(level: number, answers: Readonly<Record<number, Answers>> = {}) {
  return freshActor({
    id: PLAYER_ACTOR,
    name: "Blade",
    side: "party",
    source: {
      kind: "character",
      build: {
        baseAbilities: { str: 15, dex: 14, con: 13, int: 16, wis: 10, cha: 8 },
        speciesId: "srd52:species/human",
        backgroundId: "srd52:background/soldier",
        backgroundIncrease: { str: 2, con: 1 },
        levels: Array.from({ length: level }, (_, index) => ({
          classId: FIGHTER,
          hitPointGain: 10,
          answers: [
            ...(index === 2
              ? [{ kind: "subclass" as const, values: [KNIGHT] }]
              : []),
            ...(answers[index + 1] ?? []),
          ],
        })),
      },
    },
    hp: 30,
    inventory: [],
  });
}

const stats = (actor: Actor) => deriveStats(actor, run);

describe("subclass Spellcasting", () => {
  it("asks for cantrips and spells from the subclass's list as its table grows", () => {
    const def = ClassSchema.parse(run.content(FIGHTER));
    const at3 = levelChoices(def, 3, KNIGHT, run);
    expect(at3).toContainEqual(
      expect.objectContaining({ id: "cantrips", count: 2, list: WIZARD }),
    );
    expect(at3).toContainEqual(
      expect.objectContaining({ id: "spells", count: 3, maxLevel: 1 }),
    );
    expect(levelChoices(def, 4, KNIGHT, run)).toContainEqual(
      expect.objectContaining({ id: "spells", count: 1, maxLevel: 1 }),
    );
    expect(levelChoices(def, 7, KNIGHT, run)).toContainEqual(
      expect.objectContaining({ id: "spells", count: 1, maxLevel: 2 }),
    );
    expect(levelChoices(def, 5, KNIGHT, run)).toEqual([]);
  });

  it("gives the subclass's slots and casts with its ability", () => {
    const knight = blade(3, {
      3: [
        {
          kind: "spells",
          values: ["srd52:spell/fire-bolt", "srd52:spell/magic-missile"],
        },
      ],
    });
    const derived = stats(knight);
    expect(derived.slots).toEqual([2]);
    expect(derived.spellAbility).toBe("int");
    expect(
      derived.actions.some((item) => item.id === "spell:srd52:spell/fire-bolt"),
    ).toBe(true);
  });
});

function priest(levels: readonly Answers[]): Actor {
  return freshActor({
    id: PLAYER_ACTOR,
    name: "Priest",
    side: "party",
    source: { kind: "character", build: priestBuild(levels) },
    hp: 20,
    inventory: [],
  });
}

function priestBuild(levels: readonly Answers[]): CharacterBuild {
  return {
    baseAbilities: { str: 10, dex: 12, con: 13, int: 8, wis: 16, cha: 14 },
    speciesId: "srd52:species/human",
    backgroundId: "srd52:background/acolyte",
    backgroundIncrease: { wis: 2, con: 1 },
    levels: levels.map((answers) => ({
      classId: PRIEST,
      hitPointGain: 8,
      answers,
    })),
  };
}

describe("class pick swaps", () => {
  const first: Answers = [
    { kind: "skills", values: ["insight", "religion"] },
    {
      kind: "spells",
      values: ["srd52:spell/light", "srd52:spell/sacred-flame"],
    },
    {
      kind: "spells",
      values: ["srd52:spell/bless", "srd52:spell/cure-wounds"],
    },
  ];

  it("changes a cantrip once a level and a prepared spell once a Long Rest", () => {
    const one = swappable(priest([first]), run);
    // At the level the picks were made there's no level gained to change a cantrip with.
    expect(one.find((item) => item.key === "0:1")?.open).toBe(false);
    expect(one.find((item) => item.key === "0:2")).toMatchObject({
      open: true,
      mark: `${PRIEST}:spells`,
    });
    const two = priest([
      first,
      [
        {
          kind: "spells",
          values: ["srd52:spell/fire-bolt", "srd52:spell/magic-missile"],
        },
        { kind: "spells", values: ["srd52:spell/shield-of-faith"] },
      ],
    ]);
    const cantrip = swappable(two, run).find((item) => item.key === "0:1");
    expect(cantrip).toMatchObject({ open: true, mark: `${PRIEST}:cantrips@2` });
    const state = applyDndEvent(
      { actors: { [PLAYER_ACTOR]: two }, combat: null },
      {
        kind: `${NS}:answerSwapped`,
        payload: {
          actor: PLAYER_ACTOR,
          key: "0:1",
          values: ["srd52:spell/light", "srd52:spell/spare-the-dying"],
          mark: `${PRIEST}:cantrips@2`,
        },
      },
    );
    const swapped = state.actors[PLAYER_ACTOR];
    if (!swapped) throw new Error("missing");
    expect(effectiveBuild(swapped)?.levels[0]?.answers[1]).toMatchObject({
      values: ["srd52:spell/light", "srd52:spell/spare-the-dying"],
    });
    expect(
      swappable(swapped, run).find((item) => item.key === "0:1")?.open,
    ).toBe(false);
    // A level taken before a choice was added to it has no answer for that choice, and its answers keep their own.
    const older = priest([
      first,
      [{ kind: "spells", values: ["srd52:spell/shield-of-faith"] }],
    ]);
    expect(
      swappable(older, run).find((item) => item.key === "1:0")?.choices[0],
    ).toMatchObject({ id: "spells" });
    // A prepared spell swap offers spells of every level it has slots for now.
    const spells = swappable(two, run).find((item) => item.key === "1:1");
    expect(spells?.choices[0]).toMatchObject({ maxLevel: 1, list: PRIEST });
  });
});

describe("wider spell lists", () => {
  const def = () => ClassSchema.parse(run.content(PRIEST));
  const options = (level: number, id: string) => {
    const choice = levelChoices(def(), level, undefined, run).find(
      (item) => item.id === id,
    );
    if (!choice) throw new Error(`no ${id}`);
    return choiceOptions(
      choice,
      { scores: [], picks: {}, backgroundId: "srd52:background/acolyte" },
      null,
      def(),
      run,
    ).options.map((item) => item.id);
  };

  it("takes a feature's extra lists into the class's spell picks", () => {
    expect(options(2, "spells")).not.toContain("srd52:spell/magic-missile");
    expect(options(3, "spells")).toContain("srd52:spell/magic-missile");
    expect(options(3, "spells")).toContain("srd52:spell/bless");
  });

  it("offers cantrips and spells from several lists up to the level's slots", () => {
    const offered = options(2, "discoveries");
    expect(offered).toContain("srd52:spell/fire-bolt");
    expect(offered).toContain("srd52:spell/magic-missile");
    expect(offered).toContain("srd52:spell/bless");
    expect(offered).not.toContain("srd52:spell/scorching-ray");
  });
});

describe("spells from a feature's pick and its free casts", () => {
  const features = (ids: string[], extra: Answers = []): Answers => [
    { kind: "features", values: ids },
    ...extra,
  ];

  it("gives the picked variant's spells, changed after a Long Rest", () => {
    const iced = priest([
      features(
        ["test:feature/lands", "test:feature/recovery"],
        [{ kind: "variant", feature: "test:feature/lands", values: ["ice"] }],
      ),
    ]);
    const derived = stats(iced);
    const ids = derived.actions.map((item) => item.id);
    expect(ids).toContain("spell:srd52:spell/ice-knife");
    expect(ids).not.toContain("spell:srd52:spell/burning-hands");
    // Recovery casts the lands' level 1+ spell without a slot.
    expect(
      ids.some((id) => id.startsWith("spell:srd52:spell/ice-knife:free")),
    ).toBe(true);
    expect(derived.resources["recovery-spell"]).toBe(1);
    const land = swappable(iced, run).find(
      (item) => item.choices[0]?.kind === "variant",
    );
    expect(land?.open).toBe(true);
    const state = applyDndEvent(
      { actors: { [PLAYER_ACTOR]: iced }, combat: null },
      {
        kind: `${NS}:answerSwapped`,
        payload: {
          actor: PLAYER_ACTOR,
          key: land?.key ?? "",
          values: ["fire"],
        },
      },
    );
    const after = state.actors[PLAYER_ACTOR];
    if (!after) throw new Error("missing");
    expect(stats(after).actions.map((item) => item.id)).toContain(
      "spell:srd52:spell/burning-hands",
    );
    expect(
      swappable(after, run).find((item) => item.key === land?.key)?.open,
    ).toBe(false);
  });

  it("casts a feature's spells with its own ability, at more targets", () => {
    const charmer = priest([features(["test:feature/charmer"])]);
    const hold = stats(charmer).actions.find(
      (item) => item.id === "spell:srd52:spell/hold-person",
    );
    expect(JSON.stringify(hold?.activation)).toContain('"ability":"cha"');
    // And reaches one creature more.
    expect(hold?.activation.targeting).toMatchObject({ creatures: 2 });
  });
});

describe("Ritual Adept", () => {
  it("casts a list's ritual it hasn't prepared, between fights and with no slot", () => {
    const adept = priest([
      [{ kind: "features", values: ["test:feature/ritual-adept"] }],
      [],
      [],
    ]);
    const fallen = freshActor({
      id: "friend",
      name: "Friend",
      side: "party",
      source: { kind: "character", build: priestBuild([[]]) },
      hp: 0,
      inventory: [],
    });
    const dead = { ...fallen, deathSaves: { successes: 0, failures: 3 } };
    const state = {
      actors: { [PLAYER_ACTOR]: adept, friend: dead },
      combat: null,
      gold: 10,
    };
    const labels = sceneCastActions(state, run).map((item) => item.label);
    expect(labels).toContain("Gentle Repose (ritual)");
    const plain = priest([[], [], []]);
    expect(
      sceneCastActions(
        { ...state, actors: { [PLAYER_ACTOR]: plain, friend: dead } },
        run,
      ).map((item) => item.label),
    ).not.toContain("Gentle Repose (ritual)");
  });
});

describe("an option's own picks", () => {
  it("can be picked again after any rest, as a Book of Shadows' spells", () => {
    const tome = priest([
      [],
      [],
      [
        { kind: "features", values: ["test:feature/tome"] },
        { kind: "spells", values: ["srd52:spell/cure-wounds"] },
        { kind: "spells", values: ["srd52:spell/fire-bolt"] },
      ],
    ]);
    expect(swappable(tome, run)).toContainEqual(
      expect.objectContaining({
        key: "2:2",
        owner: "Tome",
        values: ["srd52:spell/fire-bolt"],
        open: true,
      }),
    );
  });
});

describe("Mystic Focus", () => {
  const monk = (spent: Record<string, number>) => ({
    ...priest([
      [{ kind: "features", values: ["test:feature/mystic-focus"] }],
      [],
      [],
    ]),
    resourcesSpent: spent,
  });

  it("spends a slot in a fight for as many points back as its level", () => {
    const actor = monk({ focus: 4 });
    const state = {
      actors: { [PLAYER_ACTOR]: actor },
      combat: { encounter: "arena", order: [PLAYER_ACTOR], index: 0, round: 1 },
    };
    const option = classOptions(actor, state, run).find((item) =>
      item.label.startsWith("Turn a level 2 slot"),
    );
    if (!option) throw new Error("no option");
    const { events = [] } = runClassOption(
      { actor: PLAYER_ACTOR, answer: option.id },
      { ...run, state, dice: { below: () => 0, roll: () => 1 } },
    );
    expect(
      events.map((item) => ("payload" in item ? item.payload : null)),
    ).toEqual([
      { actor: PLAYER_ACTOR, resource: "slot:2" },
      { actor: PLAYER_ACTOR, resource: "focus", amount: 2 },
    ]);
  });

  it("buys back the highest spent slot it can afford after a Short Rest", () => {
    const actor = monk({ focus: 6, "slot:1": 2, "slot:2": 1 });
    const left = recovered(actor.resourcesSpent, stats(actor), "short");
    // The points come back, then three pay for the level 2 slot.
    expect(left).toEqual({ focus: 3, "slot:1": 2 });
  });
});

describe("a class's picks as one scene action", () => {
  it("asks which of a kind's picks to change, then what in its place", () => {
    const picks: Answers = [
      {
        kind: "spells",
        values: ["srd52:spell/light", "srd52:spell/sacred-flame"],
      },
      {
        kind: "spells",
        values: ["srd52:spell/bless", "srd52:spell/cure-wounds"],
      },
    ];
    const two = priest([
      picks,
      [{ kind: "spells", values: ["srd52:spell/shield-of-faith"] }],
    ]);
    const state = {
      actors: { [PLAYER_ACTOR]: two },
      combat: null,
      sinceLongRest: 0,
    };
    const spells = sceneSwapActions(state, run).filter((item) =>
      item.label.endsWith("Test Priest spells"),
    );
    expect(spells).toHaveLength(1);
    const key = String(spells[0]?.args.key);
    const context = { ...run, state, dice: { below: () => 0, roll: () => 1 } };
    const step = swapFrames[`${NS}:swapStep`].run(
      { actor: PLAYER_ACTOR, key },
      context,
    );
    const asked = step.frames?.[0]?.payload as {
      decision: { options: { id: string }[] };
    };
    const ids = asked.decision.options.map((item) => item.id);
    expect(ids).toContain("0:1=srd52:spell/bless");
    expect(ids).toContain("1:0=srd52:spell/shield-of-faith");
    const next = swapFrames[`${NS}:swapAnswer`].run(
      { actor: PLAYER_ACTOR, key, answer: "1:0=srd52:spell/shield-of-faith" },
      context,
    );
    const then = swapFrames[`${NS}:swapStep`].run(
      next.frames?.[0]?.payload as { actor: string; key: string; drop: string },
      context,
    );
    // The pick's own step, which asks what takes its place.
    expect(then.frames?.[0]?.payload).toEqual({
      actor: PLAYER_ACTOR,
      key: "1:0",
      drop: "srd52:spell/shield-of-faith",
    });
  });
});

describe("spells that heal more and hit harder", () => {
  const healer = () =>
    priest([[{ kind: "features", values: ["test:feature/life"] }], [], []]);
  const hurt = () => ({
    ...freshActor({
      id: "friend",
      name: "Friend",
      side: "party",
      source: { kind: "character", build: priestBuild([[]]) },
      hp: 1,
      inventory: [],
    }),
  });
  const context = (actors: readonly Actor[]) => ({
    ...run,
    state: {
      actors: Object.fromEntries(actors.map((item) => [item.id, item])),
      combat: null,
    },
    dice: { below: () => 0, roll: () => 1 },
  });
  const healed = (events: readonly { kind: string }[]) =>
    events.flatMap((item) =>
      item.kind === `${NS}:healed` && "payload" in item
        ? [item.payload as { actor: string; amount: number }]
        : [],
    );

  it("heals with the dice's highest faces and 2 plus the slot's level more", () => {
    const caster = healer();
    const friend = hurt();
    const events = leafEvents(
      [{ kind: "heal", amount: { dice: "2d8" } }],
      "spell:srd52:spell/cure-wounds",
      caster,
      friend,
      context([caster, friend]),
      undefined,
      2,
    );
    // 16 from the dice at their highest, 4 from the slot; the friend has room for 9.
    expect(healed(events)).toEqual([{ actor: "friend", amount: 9, max: 10 }]);
    const free = leafEvents(
      [{ kind: "heal", amount: { bonus: { base: 1, add: [] } } }],
      "spell:srd52:spell/cure-wounds:free",
      caster,
      friend,
      context([caster, friend]),
    );
    expect(healed(free)[0]?.amount).toBe(1);
  });

  it("heals the caster 2 plus the slot's level after healing another with a slot", () => {
    const caster = { ...healer(), hp: 5 };
    const friend = hurt();
    const cure = stats(caster).actions.find(
      (item) => item.id === "spell:srd52:spell/cure-wounds",
    );
    const known = deriveStats(
      priest([[{ kind: "spells", values: ["srd52:spell/cure-wounds"] }]]),
      run,
    ).actions.find((item) => item.id === "spell:srd52:spell/cure-wounds");
    const action = cure ?? known;
    if (!action) throw new Error("no Cure Wounds");
    const { events } = castRiders(
      caster,
      action,
      3,
      context([caster, friend]),
      [friend],
    );
    expect(healed(events)).toEqual([
      { actor: PLAYER_ACTOR, amount: 5, max: 30 },
    ]);
    expect(
      castRiders(caster, action, 3, context([caster, friend]), [caster]).events,
    ).toEqual([]);
  });

  it("adds damage to a list's school, and dice of their own type to another's", () => {
    const evoker = priest([
      [
        { kind: "features", values: ["test:feature/evoker"] },
        {
          kind: "spells",
          values: ["srd52:spell/fire-bolt", "srd52:spell/sacred-flame"],
        },
      ],
    ]);
    const actions = stats(evoker).actions;
    const bolt = actions.find(
      (item) => item.id === "spell:srd52:spell/fire-bolt",
    );
    const [fire, force] = bolt?.activation.resolution.damage ?? [];
    expect(fire?.type).toBe("fire");
    expect(fire?.amount.bonus?.add).toEqual([
      { kind: "abilityMod", ability: "wis" },
    ]);
    expect(force).toEqual({ amount: { dice: "2d8" }, type: "force" });
    expect(bolt?.activation.resolution.damage).toHaveLength(2);
    expect(bolt?.onceKeys).toContain("spellDamage:1");
    // Sacred Flame is no Wizard evocation and deals no fire.
    const flame = actions.find(
      (item) => item.id === "spell:srd52:spell/sacred-flame",
    );
    expect(flame?.activation.resolution.damage).toHaveLength(1);
    expect(
      flame?.activation.resolution.damage[0]?.amount.bonus,
    ).toBeUndefined();
  });
});

describe("spells changed as they're cast", () => {
  const tricks = () =>
    priest([
      [
        { kind: "features", values: ["test:feature/evoker-tricks"] },
        {
          kind: "spells",
          values: [
            "srd52:spell/fire-bolt",
            "srd52:spell/sacred-flame",
            "srd52:spell/dispel-magic",
            "srd52:spell/hold-person",
            "srd52:spell/bless",
          ],
        },
      ],
    ]);
  const act = (actor: Actor, id: string) => {
    const found = stats(actor).actions.find(
      (item) => item.id === `spell:srd52:spell/${id}`,
    );
    if (!found) throw new Error(`no ${id}`);
    return found;
  };

  it("deals a cantrip's half damage on a miss or a save, as Potent Cantrip", () => {
    const actor = tricks();
    expect(act(actor, "fire-bolt").activation.resolution).toMatchObject({
      missDamage: "half",
    });
    expect(act(actor, "sacred-flame").activation.resolution).toMatchObject({
      onSuccessDamage: "half",
    });
  });

  it("casts a named spell with a Bonus Action, and a school's with no components", () => {
    const actor = tricks();
    expect(act(actor, "dispel-magic").activation.cost).toContain("bonusAction");
    expect(act(actor, "dispel-magic").activation.cost).not.toContain("action");
    const derived = stats(actor);
    expect(castsSilently(actor, act(actor, "hold-person"), derived, run)).toBe(
      true,
    );
    expect(castsSilently(actor, act(actor, "fire-bolt"), derived, run)).toBe(
      false,
    );
  });

  it("doubles Extended Spell's durations, and makes a turn's option free with Arcane Apotheosis", () => {
    const sorcerer: Actor = {
      ...tricks(),
      activeEffects: [
        {
          sourceId: "phb:feature/sorcerer-metamagic-extended-spell",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "tactic",
            tactic: "metamagic",
            action: "spell:srd52:spell/bless",
          },
          ends: "casterTurnEnd",
        },
      ],
    };
    const bless = act(tricks(), "bless");
    const [paid] = withMetamagic([bless], sorcerer, 3);
    expect(JSON.stringify(paid?.activation.resolution)).toContain(
      '"minutes":2',
    );
    expect(paid?.activation.cost).toContainEqual({
      resource: "sorcery-points",
    });
    const [free] = withMetamagic([bless], sorcerer, 3, true);
    expect(free?.activation.cost).not.toContainEqual({
      resource: "sorcery-points",
    });
    expect(
      freeOption(sorcerer, [
        { kind: "freeMetamagic", while: ["test:feature/innate"] },
      ]),
    ).toBe(false);
  });

  it("bars another level 1+ spell on a Quickened Spell's turn, but not a cantrip", () => {
    const actor = { ...tricks(), usedThisTurn: ["quickened"] };
    expect(quickenedBars(act(actor, "hold-person"), actor)).toBe(true);
    expect(quickenedBars(act(actor, "fire-bolt"), actor)).toBe(false);
    expect(quickenedBars(act(tricks(), "hold-person"), tricks())).toBe(false);
  });

  it("raises the spell save DC while an effect says so, as Innate Sorcery", () => {
    const actor: Actor = {
      ...tricks(),
      activeEffects: [
        {
          sourceId: "feature:test:feature/innate:0",
          casterId: PLAYER_ACTOR,
          modifier: {
            kind: "bonus",
            to: "spellDc",
            amount: { bonus: { base: 1, add: [] } },
          },
          ends: "casterTurnEnd",
        },
      ],
    };
    expect(stats(actor).itemBonuses.spellDc).toBe(1);
  });
});
