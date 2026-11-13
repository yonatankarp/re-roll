import { PLAYER_ACTOR } from "#sdk";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  type DndState,
  freshActor,
} from "../plugins/systems/dnd5.5e/core/state.ts";

// Made-up traits and feats for the shared mechanics feats and species use: ids and mechanics only.
export const trait = (id: string, passives: readonly object[], extra = {}) => ({
  id: `test:feature/${id}`,
  name: id,
  text: "Test.",
  automation: "full",
  passives,
  ...extra,
});
const FIXTURES = [
  {
    id: "test:species/plain",
    name: "Plain",
    text: "A test species.",
    creatureType: "Humanoid",
    size: "medium",
    speed: 30,
    traits: [],
  },
  trait("luck", [{ kind: "rerollOnes" }]),
  trait("savage", [{ kind: "savageAttacker" }]),
  trait("defy-death", [{ kind: "deathSaveAdvantage" }]),
  trait("great-weapon", [{ kind: "greatWeaponFighting" }]),
  trait("adept", [{ kind: "energyMastery", damage: "fire" }]),
  trait("overcome", [
    {
      kind: "overcomeResistance",
      damage: ["bludgeoning", "piercing", "slashing"],
    },
  ]),
  trait("slashproof", [
    { kind: "modifier", modifier: { kind: "resistance", damage: "slashing" } },
  ]),
  trait("armored", [
    {
      kind: "armoredReduction",
      armor: "heavy",
      damage: ["bludgeoning", "piercing", "slashing"],
      amount: { add: [{ kind: "proficiency" }] },
    },
  ]),
  trait("hamstring", [
    {
      kind: "damageRider",
      damage: "slashing",
      oncePerTurn: true,
      effects: [
        {
          kind: "modifier",
          duration: { until: "yourNextTurnStart" },
          modifier: {
            kind: "bonus",
            to: "speed",
            amount: { bonus: { base: 10 } },
            subtract: true,
          },
        },
      ],
    },
  ]),
  trait("sharpshooter", [
    { kind: "firingInMelee", attack: "weapon", bypassCover: true },
  ]),
  trait("protector", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { allyAttacked: true, holding: "shield" },
        targeting: { creatures: 1, range: 5, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "modifier",
              duration: { until: "yourNextTurnStart" },
              modifier: { kind: "disadvantage", on: "attacksAgainst" },
            },
          ],
        },
      },
    ],
  }),
  trait("interceptor", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { allyHit: true, holding: "shieldOrWeapon" },
        targeting: { creatures: 1, range: 5, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [
            {
              kind: "reduceDamage",
              amount: {
                dice: "1d10",
                bonus: { add: [{ kind: "proficiency" }] },
              },
            },
          ],
        },
      },
    ],
  }),
  trait("fireproof", [
    { kind: "modifier", modifier: { kind: "resistance", damage: "fire" } },
  ]),
  trait("lucky", [], {
    resources: [
      {
        id: "luck",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: [{ resource: "luck" }],
        trigger: { attacked: true },
        targeting: { self: true },
        resolution: { kind: "automatic", effects: [] },
      },
    ],
  }),
  trait("thunder", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { damaged: true },
        targeting: { creatures: 1, range: 60, side: "enemy" },
        resolution: {
          kind: "automatic",
          damage: [{ amount: { dice: "1d8" }, type: "thunder" }],
          effects: [],
        },
      },
    ],
  }),
  trait("medic", [{ kind: "healingRerolls" }], {
    activations: [
      {
        cost: ["action"],
        carrying: "test:item/kit",
        targeting: { creatures: 1, range: 5, side: "ally" },
        resolution: {
          kind: "automatic",
          effects: [
            { kind: "hitDieHeal", bonus: { add: [{ kind: "proficiency" }] } },
          ],
        },
      },
    ],
  }),
  trait("crafter", [{ kind: "shopDiscount", percent: 20 }]),
  trait("mighty", [{ kind: "powerfulBuild" }]),
  trait(
    "mage-slayer",
    [
      { kind: "concentrationBreaker" },
      {
        kind: "saveRescue",
        abilities: ["int", "wis", "cha"],
        resource: "mind",
      },
    ],
    {
      resources: [
        {
          id: "mind",
          max: { base: 1 },
          recharge: [{ on: "shortRest", amount: "all" }],
        },
      ],
    },
  ),
  trait("sentinel", [{ kind: "sentinel" }]),
  trait("grappler", [{ kind: "grappledAdvantage" }]),
  trait("piercer", [{ kind: "damageReroll", damage: "piercing" }]),
  {
    id: "test:item/kit",
    name: "Kit",
    type: "gear",
    category: "adventuring",
    costCp: 500,
    text: "Test.",
  },
  {
    id: "test:item/maul",
    name: "Maul",
    type: "weapon",
    category: "martial",
    damage: { dice: "2d6", type: "bludgeoning" },
    properties: ["heavy", "twoHanded"],
    mastery: "push",
  },
  trait("rally", [
    {
      kind: "restTempHp",
      rests: ["short"],
      amount: { add: [{ kind: "level" }] },
      allies: true,
    },
  ]),
  trait("gift", [], {
    spells: { 1: ["srd52:spell/burning-hands"] },
    freeCast: true,
  }),
  trait("sturdy", [{ kind: "saveProficiency", increased: true }]),
  trait("blessed", [], {
    spells: { 1: ["srd52:spell/bless"] },
    freeCast: true,
  }),
  {
    id: "test:feat/sturdy",
    name: "Sturdy",
    category: "general",
    text: "Test.",
    grants: ["test:feature/sturdy"],
    abilityIncrease: ["wis", "cha"],
  },
  ...(
    [
      ["test:feat/initiate", "Initiate"],
      ["test:feat/initiate-cleric", "Initiate (Cleric)"],
      ["test:feat/initiated", "Initiated"],
    ] as const
  ).map(([id, name]) => ({
    id,
    name,
    category: "origin",
    text: "Test.",
  })),
  ...(
    [
      ["test:feat/gift", "Gift", "darkGift", { grants: ["test:feature/luck"] }],
      ["test:feat/kin", "Kin", "racial", { requires: ["test:species/plain"] }],
      ["test:feat/far", "Far", "racial", { requires: ["test:species/far"] }],
      ["test:feat/mark", "Mark", "dragonmark", {}],
      ["test:feat/other-mark", "Other Mark", "dragonmark", {}],
      [
        "test:feat/greater",
        "Greater",
        "general",
        { requires: ["test:feat/mark"] },
      ],
      [
        "test:feat/steady",
        "Steady",
        "origin",
        { grants: ["test:feature/savage"] },
      ],
    ] as const
  ).map(([id, name, category, extra]) => ({
    id,
    name,
    category,
    text: "Test.",
    ...extra,
  })),
  {
    id: "test:background/haunted",
    name: "Haunted",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/steady",
    skills: ["athletics", "survival"],
    tool: "Test Tools",
    featOr: "darkGift",
  },
  {
    id: "test:background/plain",
    name: "Plain",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/initiated",
    skills: ["athletics", "survival"],
    tool: "Test Tools",
  },
];

export async function testRun(): Promise<RunContext> {
  const { run } = await loadAdventure("goblin-ambush");
  const byId = new Map(FIXTURES.map((entry) => [entry.id, entry]));
  return {
    ...run,
    content: (id) => byId.get(id) ?? run.content(id),
    contentIds: () => [...run.contentIds(), ...byId.keys()].sort(),
  };
}

export type Answers = CharacterBuild["levels"][number]["answers"];

export function hero(
  traits: readonly string[],
  {
    level = 1,
    answers = [] as Answers,
    id = PLAYER_ACTOR,
    background = "test:background/plain",
  } = {},
): Actor {
  const build: CharacterBuild = {
    baseAbilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    speciesId: "test:species/plain",
    backgroundId: background,
    backgroundIncrease: { str: 2, con: 1 },
    levels: Array.from({ length: level }, (_, index) => ({
      classId: "srd52:class/fighter",
      hitPointGain: 10,
      answers: [
        ...(index === 0
          ? [
              {
                kind: "features" as const,
                values: traits.map((name) => `test:feature/${name}`),
              },
            ]
          : []),
        ...(index === level - 1 ? answers : []),
      ],
    })),
  };
  return freshActor({
    id,
    name: "Hero",
    side: "party",
    source: { kind: "character", build },
    hp: 10,
    inventory: ["srd52:item/longsword"],
  });
}

// Dice that give these rolls in turn, then 10s, and count how often each die is rolled.
export function scripted(rolls: readonly number[]) {
  const queue = [...rolls];
  const counts: Record<number, number> = {};
  const dice: Dice = {
    below: () => 0,
    roll: (sides) => {
      counts[sides] = (counts[sides] ?? 0) + 1;
      return queue.shift() ?? 10;
    },
  };
  return { dice, counts };
}

export function contextOf(
  run: RunContext,
  actors: readonly Actor[],
  dice: Dice,
) {
  const state: DndState = {
    actors: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
    combat: {
      encounter: "arena",
      order: actors.map((actor) => actor.id),
      index: 0,
      round: 1,
    },
  };
  return { state, dice, content: run.content, contentIds: run.contentIds };
}

export const NO_EDGE = { advantage: false, disadvantage: false };
