import {
  AWAIT_FRAME,
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";
import { loadAdventure } from "../app/cli/load-adventure.ts";
import type { Dice } from "../engine/kernel/dice.ts";
import type { RunContext } from "../engine/run/turn.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  applyDndEvent,
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
const reacting = (
  id: string,
  cost: readonly unknown[],
  trigger: object,
  effects: readonly object[],
  targeting: object = { self: true },
) =>
  trait(id, [], {
    resources: [
      { id, max: { base: 1 }, recharge: [{ on: "longRest", amount: "all" }] },
    ],
    activations: [
      {
        cost: [...cost, { resource: id }],
        trigger,
        targeting,
        resolution: { kind: "automatic", effects },
      },
    ],
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
  // Reactions to rolls, damage, walks and attacks on others (combat/reactions.ts).
  reacting(
    "bountiful-luck",
    ["reaction"],
    {
      rolled: {
        rolls: ["attack", "save", "check"],
        by: "ally",
        when: "natural1",
      },
      within: 30,
    },
    [{ kind: "reroll" }],
  ),
  reacting(
    "second-chance",
    ["reaction"],
    {
      rolled: { rolls: ["attack"], by: "foe", when: "hit" },
    },
    [{ kind: "reroll" }],
  ),
  reacting(
    "fate",
    [],
    {
      rolled: { rolls: ["attack", "save", "check"], by: "any", when: "any" },
      within: 60,
    },
    [{ kind: "rollBonus", amount: { dice: "2d4" }, either: true }],
  ),
  reacting(
    "lucky-saves",
    [],
    {
      rolled: { rolls: ["save", "check"], by: "self", when: "failed" },
    },
    [{ kind: "reroll" }],
  ),
  reacting(
    "omen",
    ["reaction"],
    {
      rolled: {
        rolls: ["attack", "save", "check"],
        by: "selfOrAlly",
        when: "any",
      },
    },
    [{ kind: "replaceRoll" }],
  ),
  reacting(
    "polearm",
    ["reaction"],
    { entersReach: true },
    [{ kind: "strike" }],
    {
      creatures: 1,
      range: 10,
      side: "enemy",
    },
  ),
  reacting(
    "guardian",
    ["reaction"],
    { foeHitsOther: true, within: 5 },
    [{ kind: "strike" }],
    {
      creatures: 1,
      range: 5,
      side: "enemy",
    },
  ),
  reacting(
    "retaliate",
    ["reaction"],
    { struck: true, melee: true, within: 5 },
    [{ kind: "strike" }],
    {
      creatures: 1,
      range: 5,
      side: "enemy",
    },
  ),
  reacting(
    "ward",
    ["reaction"],
    { damaged: true, before: true, damagedBy: ["necrotic"] },
    [
      {
        kind: "reduceDamage",
        halve: false,
        amount: { dice: "1d6", diceCount: "proficiency" },
      },
    ],
  ),
  reacting("reveler", [], { inspirationSpent: true, within: 60 }, [
    { kind: "inspiration" },
  ]),
  reacting("alert-swap", [], { initiative: true }, [
    { kind: "swapInitiative" },
  ]),
  reacting("swap", ["reaction"], { attacked: true }, [{ kind: "redirect" }]),
  reacting("split", ["reaction"], { damaged: true, damagedBy: ["slashing"] }, [
    { kind: "split", minHp: 10, times: 1 },
  ]),
  reacting("riposte", ["reaction"], { hitByAttack: true, melee: true }, [
    { kind: "acAgainstHit", bonus: 10 },
    { kind: "strike" },
  ]),
  reacting("pursue", ["reaction"], { endsMove: true, within: 120 }, [
    { kind: "teleport", feet: 60, movement: 0 },
  ]),
  reacting(
    "slash",
    ["reaction"],
    { otherDamaged: "bloodied", within: 40 },
    [{ kind: "strike", approach: true }],
    { creatures: 1, range: 40, side: "enemy" },
  ),
  trait("corrode", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { ownSave: "failed" },
        targeting: { creatures: 1, range: 120, side: "enemy" },
        resolution: {
          kind: "automatic",
          damage: [{ amount: { dice: "1d6" }, type: "psychic" }],
          effects: [],
        },
      },
    ],
  }),
  trait("war-caster", [{ kind: "reactiveSpell" }], {
    spells: { "1": ["srd52:spell/fire-bolt"] },
  }),
  // A table rolled as the reaction is taken, as Mythal Ward's: a burst scaled by the spell's level, +2 AC, or the
  // spell turned aside.
  trait("mythal", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: {
          hitByAttack: true,
          bySpell: true,
          ownSave: "failed",
          before: true,
        },
        targeting: { self: true },
        resolution: { kind: "automatic", effects: [] },
        table: {
          die: 20,
          rows: [
            {
              min: 1,
              max: 5,
              within: 15,
              perSpellLevel: true,
              resolution: {
                kind: "save",
                ability: "dex",
                dc: { base: 30 },
                damage: [{ amount: { dice: "1d8" }, type: "force" }],
                onSuccessDamage: "half",
                onFail: [],
              },
            },
            {
              min: 6,
              max: 10,
              targets: ["self"],
              resolution: {
                kind: "automatic",
                effects: [
                  {
                    kind: "modifier",
                    modifier: {
                      kind: "bonus",
                      to: "ac",
                      amount: { bonus: { base: 2 } },
                    },
                    duration: { minutes: 1 },
                  },
                ],
              },
            },
            { min: 11, max: 19 },
            { min: 20, max: 20, negate: true },
          ],
        },
      },
    ],
  }),
  trait("jinx", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { hitByAttack: true },
        targeting: { creatures: 1, range: 120, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 30, add: [] },
          onFail: [{ kind: "negateHit" }],
        },
      },
    ],
  }),
  trait("gaze", [], {
    activations: [
      {
        cost: ["reaction"],
        trigger: { turnStart: true, within: 30 },
        targeting: { creatures: 1, range: 30, side: "enemy" },
        resolution: {
          kind: "save",
          ability: "wis",
          dc: { base: 30, add: [] },
          onFail: [
            {
              kind: "applyCondition",
              condition: "frightened",
              duration: { until: "yourNextTurnStart" },
            },
          ],
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
  trait("harper", [{ kind: "helpRange", feet: 30 }]),
  trait("lords", [{ kind: "critInspiration" }, { kind: "avengeAlly" }]),
  trait("zhent", [
    { kind: "opportunityDamage" },
    { kind: "initiativeInspiration" },
  ]),
  trait("tyro", [{ kind: "vigilant" }]),
  // A Weapon of Warning's passive, on a trait.
  trait("warned", [{ kind: "initiativeAdvantage", allies: true }]),
  trait(
    "survivor",
    [
      { kind: "initiativeReroll", atMost: 9 },
      {
        kind: "saveRescue",
        conditions: ["charmed", "frightened"],
        bonus: { add: [{ kind: "proficiency" }] },
        reaction: true,
        resource: "steel",
      },
    ],
    {
      resources: [
        {
          id: "steel",
          max: { base: 1 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
    },
  ),
  trait("keen", [{ kind: "sharpEye", resource: "keen" }], {
    resources: [
      {
        id: "keen",
        max: { add: [{ kind: "proficiency" }] },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  }),
  trait("charger", [{ kind: "dashBonus", feet: 10 }]),
  trait("hop", [{ kind: "quickStand" }]),
  trait("fortitude", [{ kind: "dodgeHeal" }]),
  trait("dual", [{ kind: "dualWielder" }]),
  trait("pole", [{ kind: "poleStrike" }]),
  trait("shield-master", [{ kind: "shieldBash" }, { kind: "interposeShield" }]),
  trait("prowess", [{ kind: "peerlessAim" }]),
  trait("fortune", [{ kind: "saveReroll" }]),
  trait("night", [
    { kind: "resistAll", while: "shadows", except: ["psychic", "radiant"] },
  ]),
  trait("desperate", [
    { kind: "resistAll", while: "bloodied", except: ["force"] },
  ]),
  trait("elven", [{ kind: "elvenAccuracy" }]),
  trait("iron-mind", [{ kind: "unshakableFocus" }]),
  trait("phlegethos", [{ kind: "spellRerollOnes", damage: "fire" }]),
  trait("adept-all", [{ kind: "allSkills" }]),
  trait("recall", [{ kind: "slotRecall" }]),
  trait(
    "retreat",
    [
      {
        kind: "bonusTactics",
        tactics: ["dash", "disengage"],
        resource: "retreat",
      },
    ],
    {
      resources: [
        {
          id: "retreat",
          max: { base: 1 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
    },
  ),
  trait("shadow-dodge", [{ kind: "bonusTactics", tactics: ["dodge"] }]),
  trait("toughened", [], {
    resources: [
      {
        id: "tough",
        max: { base: 1 },
        recharge: [{ on: "shortRest", amount: "all" }],
      },
    ],
    activations: [
      {
        cost: ["reaction", { resource: "tough" }],
        trigger: {
          damaged: true,
          damagedBy: ["bludgeoning", "piercing", "slashing"],
        },
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          effects: ["bludgeoning", "piercing", "slashing"].map((damage) => ({
            kind: "modifier",
            duration: { until: "yourNextTurnStart" },
            modifier: { kind: "resistance", damage },
          })),
        },
      },
    ],
  }),
  trait(
    "putrefy",
    [
      {
        kind: "damageRider",
        damage: "slashing",
        resource: "rot",
        effects: [
          {
            kind: "applyCondition",
            condition: "poisoned",
            duration: { until: "yourNextTurnStart" },
          },
        ],
      },
    ],
    {
      resources: [
        {
          id: "rot",
          max: { base: 1 },
          recharge: [{ on: "shortRest", amount: "all" }],
        },
      ],
    },
  ),
  {
    id: "test:item/spear",
    name: "Spear",
    type: "weapon",
    category: "simple",
    damage: { dice: "1d6", type: "piercing" },
    properties: ["thrown", "versatile"],
    mastery: "sap",
  },
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
  // #167: a cantrip swapped after a Long Rest, a feat's spells changed each level or picked between scenes, free casts
  // at a slot level, by another resource, or each spell its own way.
  trait("high", [], {
    spells: { 1: ["srd52:spell/prestidigitation"] },
    swapCantrip: ["srd52:class/wizard"],
  }),
  trait("gift-again", [], {
    spells: { 1: ["srd52:spell/burning-hands"] },
    freeCast: true,
  }),
  trait("wishing", [], {
    resources: [
      {
        id: "wish",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  }),
  trait("drowish", [], {
    spells: { 1: ["srd52:spell/bless", "srd52:spell/burning-hands"] },
    freeCast: {
      "srd52:spell/bless": "atWill",
      "srd52:spell/burning-hands": true,
    },
  }),
  trait("dragonmarked", [], {
    spells: { 1: ["srd52:spell/burning-hands"] },
    freeCast: true,
    preparedWith: {
      feat: "test:feat/potent",
      spells: { 1: ["srd52:spell/bless"] },
      freeCast: { resource: "potent", slotLevel: { 1: 1, 3: 2 } },
    },
  }),
  trait("potent", [], {
    resources: [
      {
        id: "potent",
        max: { base: 1 },
        recharge: [{ on: "shortRest", amount: "all" }],
      },
    ],
  }),
  trait("rituals", [], {
    resources: [
      {
        id: "quick-ritual",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
  }),
  trait("bringer", [], { spells: { 1: ["srd52:spell/light"] } }),
  trait("lit", [], { spells: { 1: ["srd52:spell/light"] } }),
  trait("wishes", [], {
    resources: [
      {
        id: "wishes",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    castsOnly: ["srd52:spell/burning-hands", "srd52:spell/magic-missile"],
    freeCast: { resource: "wishes" },
  }),
  trait("climber", [], {
    resources: [
      {
        id: "climb",
        max: { base: 1 },
        recharge: [{ on: "longRest", amount: "all" }],
      },
    ],
    spells: { 1: ["srd52:spell/spider-climb"] },
    freeCast: { resource: "climb", self: true },
  }),
  trait(
    "fortitude",
    [
      {
        kind: "saveRescue",
        abilities: ["con"],
        bonusDice: "1d4",
        dieSize: "fortitudeDie",
        reaction: true,
        resource: "fortitude",
      },
    ],
    {
      resources: [
        {
          id: "fortitude",
          max: { base: 1 },
          recharge: [{ on: "longRest", amount: "all" }],
        },
      ],
    },
  ),
  trait(
    "greater-fortitude",
    [{ kind: "scalingFloor", key: "fortitudeDie", value: 6 }],
    {
      resources: [
        {
          id: "fortitude",
          max: { base: 1 },
          recharge: [{ on: "shortRest", amount: "all" }],
        },
      ],
    },
  ),
  trait("allure", [{ kind: "attackAdvantage", when: "targetCharmed" }]),
  {
    id: "test:feat/later",
    name: "Later",
    category: "origin",
    text: "Test.",
    choices: [
      {
        kind: "spells",
        id: "cantrips",
        count: 2,
        maxLevel: 0,
        list: "srd52:class/wizard",
        late: true,
      },
    ],
  },
  {
    id: "test:feat/potent",
    name: "Potent",
    category: "general",
    text: "Test.",
    grants: ["test:feature/potent"],
  },
  {
    id: "test:feat/rituals",
    name: "Rituals",
    category: "general",
    text: "Test.",
    grants: ["test:feature/rituals"],
    abilityIncrease: ["int", "wis", "cha"],
    spellAbility: "increased",
    choices: [
      {
        kind: "spells",
        id: "rituals",
        count: 1,
        maxLevel: 1,
        ritual: true,
        grows: "proficiency",
        freeCast: { resource: "quick-ritual" },
      },
    ],
  },
  {
    id: "test:feat/bringer",
    name: "Bringer",
    category: "general",
    text: "Test.",
    grants: ["test:feature/bringer"],
    spellAbility: "increased",
    choices: [
      {
        kind: "spells",
        id: "other",
        count: 1,
        maxLevel: 0,
        list: "srd52:class/cleric",
        ifKnown: "srd52:spell/light",
      },
    ],
  },
  {
    id: "test:feat/changing",
    name: "Changing",
    category: "general",
    text: "Test.",
    spellAbility: "int",
    choices: [
      {
        kind: "spells",
        id: "cantrips",
        count: 2,
        maxLevel: 0,
        list: "srd52:class/wizard",
        swap: "levelUp",
      },
      {
        kind: "spells",
        id: "table",
        count: 1,
        maxLevel: 1,
        list: "srd52:class/cleric",
        also: ["srd52:spell/magic-missile"],
      },
    ],
  },
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
    ...(id === "test:feat/initiate-cleric"
      ? {
          choices: [
            {
              kind: "spells",
              id: "spell",
              count: 1,
              maxLevel: 1,
              list: "srd52:class/cleric",
            },
          ],
        }
      : {}),
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
    id: "test:background/gifted",
    name: "Gifted",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/chosen",
    skills: ["athletics", "survival"],
    tool: "Test Tools",
  },
  {
    id: "test:background/plain",
    name: "Plain",
    abilities: ["str", "dex", "con"],
    feat: "test:feat/initiated",
    skills: ["athletics", "survival"],
    tool: "Test Tools",
  },
  {
    id: "test:species/gifted",
    name: "Gifted",
    text: "A test species.",
    creatureType: "Humanoid",
    size: "medium",
    speed: 30,
    traits: ["test:feature/touched"],
    choices: [
      { kind: "spellAbility", id: "spellcasting", from: ["int", "cha"] },
    ],
  },
  trait("touched", [], { spells: { "1": ["srd52:spell/burning-hands"] } }),
  trait("adept-table", [], {
    spellsBySlot: {
      "1": ["srd52:spell/burning-hands"],
      "2": ["srd52:spell/fear"],
    },
  }),
  {
    id: "test:feat/touched",
    name: "Touched",
    category: "general",
    text: "Test.",
    grants: ["test:feature/touched"],
    abilityIncrease: ["int", "wis", "cha"],
    spellAbility: "increased",
  },
  {
    id: "test:feat/chosen",
    name: "Chosen",
    category: "origin",
    text: "Test.",
    choices: [
      { kind: "spellAbility", id: "ability", from: ["int", "wis", "cha"] },
      {
        kind: "spells",
        id: "spell",
        count: 1,
        maxLevel: 1,
        list: "srd52:class/wizard",
      },
    ],
  },
  {
    id: "test:feat/connoisseur",
    name: "Connoisseur",
    category: "general",
    text: "Test.",
    spellAbility: { like: "test:feat/chosen" },
    choices: [
      {
        kind: "spells",
        id: "spell",
        count: 1,
        maxLevel: 1,
        listOf: "test:feat/initiate",
        from: ["srd52:spell/burning-hands", "srd52:spell/cure-wounds"],
      },
    ],
  },
  trait("warding", [
    { kind: "schoolCast", school: "abjuration", rider: "ward" },
  ]),
  trait("augmenting", [
    { kind: "schoolCast", school: "abjuration", rider: "augment" },
  ]),
  trait("life", [{ kind: "schoolCast", school: "abjuration", rider: "life" }]),
  trait("fueled", [
    { kind: "schoolCast", school: "evocation", rider: "fueled" },
  ]),
  trait("necrosis", [
    {
      kind: "damageRider",
      damage: "slashing",
      spells: true,
      effects: [
        {
          kind: "applyCondition",
          condition: "poisoned",
          duration: { until: "yourNextTurnStart" },
        },
      ],
    },
  ]),
  {
    id: "test:feat/master",
    name: "Master",
    category: "general",
    text: "Test.",
    choices: [
      { kind: "weaponMastery", id: "mastery", count: 1, swap: "longRest" },
    ],
  },
  trait("brawler", [], {
    activations: [
      {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", ability: "str" },
          damage: [{ amount: { dice: "1d4" }, type: "bludgeoning" }],
          onHitOncePerTurn: [
            { kind: "forcedMove", feet: 5, direction: "away" },
          ],
          onHitSave: {
            ability: "str",
            orDex: true,
            oncePerTurn: true,
            dc: { base: 30 },
            onFail: [
              {
                kind: "applyCondition",
                condition: "grappled",
                duration: { minutes: 1 },
              },
            ],
          },
        },
      },
    ],
  }),
  trait("bloodshed", [{ kind: "bloodiedDamage" }, { kind: "killAdvantage" }]),
  trait("overload", [{ kind: "spellOverload", resource: "overload" }], {
    resources: [{ id: "overload", max: { base: 1 }, recharge: [] }],
  }),
  trait("charge-attack", [{ kind: "chargeAttack" }]),
  trait("stand-as-one", [{ kind: "standAsOne" }]),
  trait("biter", [], {
    resources: [{ id: "bite", max: { base: 1 }, recharge: [] }],
    activations: [
      {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution: {
          kind: "attack",
          attack: { type: "weapon", ability: "str" },
          damage: [{ amount: { dice: "1d4" }, type: "piercing" }],
          drain: { resource: "bite" },
        },
        label: "bite",
      },
    ],
  }),
  trait("cold-fire", [], {
    spells: { "1": ["srd52:spell/burning-hands"] },
    retype: { "srd52:spell/burning-hands": "cold" },
  }),
  {
    id: "test:feat/clever",
    name: "Clever",
    category: "general",
    text: "Test.",
    prerequisite: { abilities: ["int", "wis"], min: 13 },
  },
  {
    id: "test:feat/strong",
    name: "Strong",
    category: "general",
    text: "Test.",
    prerequisite: { abilities: ["str"], min: 13, armor: "heavy" },
  },
  {
    id: "test:feat/caster",
    name: "Caster",
    category: "general",
    text: "Test.",
    prerequisite: { spellcasting: true },
  },
  {
    id: "test:feat/marked",
    name: "Marked",
    category: "general",
    text: "Test.",
    prerequisite: { campaign: "eberron" },
  },
  {
    id: "test:feat/gifted",
    name: "Gifted",
    category: "general",
    text: "Test.",
    prerequisite: { campaign: "ravenloft" },
  },
  trait("marked", [], {
    preparedWith: {
      feat: "test:feat/greater",
      spells: { "1": ["srd52:spell/burning-hands"] },
    },
  }),
  trait("together", [{ kind: "allySaveAdvantage", abilities: ["str"] }]),
  trait("bountiful", [
    { kind: "tempHpBonus", amount: 5 },
    { kind: "hitDieRolls", highest: true },
  ]),
  trait("recovery", [{ kind: "hitDieRolls", floor: 3 }]),
  trait(
    "radiance",
    [{ kind: "maxDamageDice", damage: "radiant", resource: "radiance" }],
    { resources: [{ id: "radiance", max: { base: 1 }, recharge: [] }] },
  ),
  trait(
    "resistant",
    [
      {
        kind: "saveRescue",
        abilities: ["wis"],
        bonusDice: "1d6",
        magical: true,
        resource: "resistant",
      },
    ],
    { resources: [{ id: "resistant", max: { base: 1 }, recharge: [] }] },
  ),
  trait(
    "past-life",
    [{ kind: "checkRescue", bonusDice: "1d6", resource: "past-life" }],
    { resources: [{ id: "past-life", max: { base: 1 }, recharge: [] }] },
  ),
  trait("thrower", [{ kind: "thrownDamage", bonus: 2 }]),
  trait("bomber", [{ kind: "longShots" }, { kind: "farLobber", feet: 40 }]),
  {
    id: "test:item/acid",
    name: "Acid",
    type: "gear",
    activation: {
      cost: ["action"],
      targeting: { creatures: 1, range: 20, side: "enemy" },
      resolution: {
        kind: "save",
        ability: "dex",
        dc: {
          base: 8,
          add: [
            { kind: "abilityMod", ability: "dex" },
            { kind: "proficiency" },
          ],
        },
        damage: [{ amount: { dice: "2d6" }, type: "acid" }],
        onFail: [],
        onSuccess: [],
      },
    },
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

// Runs frames to the end, answering each decision as `answer` says (the first option by default), and keeps what
// they produced.
export function settle(
  run: RunContext,
  start: readonly Actor[] | DndState,
  frames: readonly Frame[],
  dice: Dice,
  answer: (decision: Decision) => string = (decision) =>
    decision.options[0]?.id ?? "",
): { state: DndState; events: SystemEvent[]; decisions: Decision[] } {
  let state = "actors" in start ? start : contextOf(run, start, dice).state;
  const events: SystemEvent[] = [];
  const decisions: Decision[] = [];
  const stack = [...frames].reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    if (top.kind === AWAIT_FRAME) {
      const { decision } = top.payload as { decision: Decision };
      decisions.push(decision);
      stack.push({
        kind: decision.resume.kind,
        payload: { ...decision.resume.payload, answer: answer(decision) },
      });
      continue;
    }
    const definition = run.system.frames[top.kind];
    if (!definition) throw new Error(`Unknown frame ${top.kind}`);
    const result = definition.run(top.payload, {
      state,
      dice,
      content: run.content,
      contentIds: run.contentIds,
    });
    for (const event of result.events ?? []) {
      events.push(event);
      state = applyDndEvent(state, event);
    }
    stack.push(...[...(result.frames ?? [])].reverse());
  }
  return { state, events, decisions };
}
