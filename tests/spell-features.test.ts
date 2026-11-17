import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { RunContext } from "../engine/run/turn.ts";
import { levelChoices } from "../plugins/systems/dnd5.5e/core/character.ts";
import { swappable } from "../plugins/systems/dnd5.5e/core/swap.ts";
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
    spellList: ["srd52:spell/sacred-flame", "srd52:spell/light"],
    levels: [
      { level: 1, slots: [2], scaling: { cantrips: 2, preparedSpells: 2 } },
      { level: 2, slots: [3], scaling: { cantrips: 2, preparedSpells: 3 } },
      { level: 3, slots: [4, 2], scaling: { cantrips: 2, preparedSpells: 4 } },
    ],
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
    source: {
      kind: "character",
      build: {
        baseAbilities: { str: 10, dex: 12, con: 13, int: 8, wis: 16, cha: 14 },
        speciesId: "srd52:species/human",
        backgroundId: "srd52:background/acolyte",
        backgroundIncrease: { wis: 2, con: 1 },
        levels: levels.map((answers) => ({
          classId: PRIEST,
          hitPointGain: 8,
          answers,
        })),
      },
    },
    hp: 20,
    inventory: [],
  });
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
      [{ kind: "spells", values: ["srd52:spell/shield-of-faith"] }],
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
    const spells = swappable(two, run).find((item) => item.key === "1:0");
    expect(spells?.choices[0]).toMatchObject({ maxLevel: 1, list: PRIEST });
  });
});
