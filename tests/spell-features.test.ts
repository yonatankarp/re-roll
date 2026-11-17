import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { RunContext } from "../engine/run/turn.ts";
import {
  choiceOptions,
  levelChoices,
} from "../plugins/systems/dnd5.5e/core/character.ts";
import { swappable } from "../plugins/systems/dnd5.5e/core/swap.ts";
import { sceneCastActions } from "../plugins/systems/dnd5.5e/core/camp.ts";
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
