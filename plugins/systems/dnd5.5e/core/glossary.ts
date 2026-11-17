import {
  ALL_SKILLS,
  CREATURE_TYPES,
  ConditionSchema,
  DAMAGE_TYPES,
  WeaponMasterySchema,
  WeaponPropertySchema,
  glossaryName,
} from "./schemas.ts";
import { TACTICS } from "./state.ts";
import { TACTIC_WORDS } from "./tactics.ts";

// The rules terms the game can explain from a book's rules glossary entities (#132): each term's id,
// the entity that explains it (its id without the book, as "condition/prone"), and the words the
// game's own text uses for it.

export interface GlossaryTerm {
  readonly id: string;
  readonly entity: string;
  readonly words: readonly string[];
  readonly books?: readonly string[]; // where to look in place of GLOSSARY_BOOKS
}

// Books whose glossary entities may explain a term, best first. 2014 books are left out, as their rules differ.
export const GLOSSARY_BOOKS = ["phb", "dmg", "basic-rules", "srd52"] as const;

const capital = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1);
// A creature type for many: Fey and Undead stay as they are.
const plural = (type: string): string =>
  type === "fey" || type === "undead"
    ? type
    : type.endsWith("y")
      ? `${type.slice(0, -1)}ies`
      : `${type}s`;
// The game writes a word lower-case in running text and capitalized in a label.
const both = (...words: string[]): string[] =>
  words.flatMap((word) => [word, capital(word)]);

// Actions anyone can take, by the option kind that offers each (TACTIC_DETAILS in the ui).
// Common words such as "help" or "ready" match capitalized only, so a sentence's own word isn't linked.
const ACTIONS: readonly GlossaryTerm[] = [
  { id: "action:dash", entity: "action/dash", words: ["Dash"] },
  {
    id: "action:disengage",
    entity: "action/disengage",
    words: ["Disengage"],
  },
  { id: "action:dodge", entity: "action/dodge", words: ["Dodge"] },
  { id: "action:help", entity: "action/help", words: ["Help"] },
  { id: "action:hide", entity: "action/hide", words: ["Hide"] },
  { id: "action:ready", entity: "action/ready", words: ["Ready"] },
  { id: "action:search", entity: "action/search", words: ["Search"] },
  { id: "action:study", entity: "action/study", words: ["Study"] },
  {
    id: "action:influence",
    entity: "action/influence",
    words: ["Influence"],
  },
  { id: "action:utilize", entity: "action/utilize", words: ["Utilize"] },
  { id: "action:grapple", entity: "rule-term/grappling", words: ["Grapple"] },
  {
    id: "action:shove",
    entity: "rule-term/unarmed-strike",
    words: ["Shove", "Unarmed Strike"],
  },
];

// How a tactic reads on a creature ("dodging"), and the action or mastery it comes from.
const TACTIC_ACTIONS: Readonly<
  Record<(typeof TACTICS)[number], string | null>
> = {
  dodge: "action:dodge",
  disengage: "action:disengage",
  dash: "action:dash",
  hidden: "action:hide",
  ready: "action:ready",
  slowed: "mastery:slow",
  metamagic: null, // a Sorcerer feature, not in the Rules Glossary
  trading: null, // a feature trading attacks, not a Rules Glossary action
  attacksLeft: null,
  exiting: null, // a swallower's stat block, not the Rules Glossary
};

// A weapon's masteries and properties, as the log and the shop name them. Push, Slow, Heavy, Light and
// Range are common words, so only Slow's "slowed" stands for one.
const MASTERY_WORDS: Readonly<Record<string, readonly string[]>> = {
  cleave: ["Cleave"],
  graze: ["Graze"],
  nick: ["Nick"],
  sap: ["Sap"],
  slow: [],
  topple: ["Topple"],
  vex: ["Vex"],
};
const PROPERTY_WORDS: Readonly<Record<string, readonly string[]>> = {
  ammunition: ["Ammunition"],
  finesse: ["Finesse"],
  loading: ["Loading"],
  thrown: ["Thrown"],
  twoHanded: ["Two Handed", "Two-Handed"],
  versatile: ["Versatile"],
};
const WEAPON: readonly GlossaryTerm[] = [
  ...WeaponMasterySchema.options.flatMap((mastery) => {
    const words = MASTERY_WORDS[mastery];
    return words
      ? [
          {
            id: `mastery:${mastery}`,
            entity: `weapon-mastery/${mastery}`,
            words,
          },
        ]
      : [];
  }),
  ...WeaponPropertySchema.options.flatMap((property) => {
    const words = PROPERTY_WORDS[property];
    return words
      ? [
          {
            id: `property:${glossaryName(property)}`,
            entity: `weapon-property/${glossaryName(property)}`,
            words,
          },
        ]
      : [];
  }),
];

const RULES: readonly GlossaryTerm[] = [
  {
    id: "rule:advantage",
    entity: "rule-term/advantage",
    words: both("advantage"),
  },
  {
    id: "rule:disadvantage",
    entity: "rule-term/disadvantage",
    words: both("disadvantage"),
  },
  {
    id: "rule:opportunity-attack",
    entity: "rule-term/opportunity-attacks",
    words: both("opportunity attacks", "opportunity attack").concat(
      "Opportunity Attacks",
      "Opportunity Attack",
    ),
  },
  {
    id: "rule:saving-throw",
    entity: "rule-term/saving-throw",
    words: both("saving throws", "saving throw", "save", "saves").concat(
      "Saving Throws",
      "Saving Throw",
    ),
  },
  {
    id: "rule:death-saving-throw",
    entity: "rule-term/death-saving-throw",
    words: both("death saving throw", "death save", "dying").concat(
      "Death Saving Throw",
    ),
  },
  {
    id: "rule:bonus-action",
    entity: "rule-term/bonus-action",
    words: both("bonus action").concat("Bonus Action"),
  },
  {
    id: "rule:reaction",
    entity: "rule-term/reaction",
    words: both("reaction"),
  },
  {
    id: "rule:concentration",
    entity: "rule-term/concentration",
    words: both("concentration", "concentrating"),
  },
  {
    id: "rule:cover",
    entity: "rule-term/cover",
    words: both("half cover", "three-quarters cover", "total cover"),
  },
  {
    id: "rule:difficult-terrain",
    entity: "rule-term/difficult-terrain",
    words: both("difficult terrain").concat("Difficult Terrain"),
  },
  {
    id: "rule:critical-hit",
    entity: "rule-term/critical-hit",
    words: both("critical hit").concat("Critical Hit"),
  },
  {
    id: "rule:temporary-hit-points",
    entity: "rule-term/temporary-hit-points",
    words: both("temporary hit points", "temp HP").concat(
      "Temporary Hit Points",
      "Temp HP",
    ),
  },
  {
    id: "rule:resistance",
    entity: "rule-term/resistance",
    words: both("resistance", "resists", "resistant"),
  },
  {
    id: "rule:vulnerability",
    entity: "rule-term/vulnerability",
    words: both("vulnerability", "vulnerable"),
  },
  {
    id: "rule:immunity",
    entity: "rule-term/immunity",
    words: both("immunity", "immune"),
  },
  {
    id: "rule:bloodied",
    entity: "rule-term/bloodied",
    words: both("bloodied"),
  },
  {
    id: "rule:stable",
    entity: "rule-term/stable",
    words: both("stable", "stabilized"),
  },
  { id: "rule:dead", entity: "rule-term/dead", words: both("dead") },
  {
    id: "rule:initiative",
    entity: "rule-term/initiative",
    words: both("initiative"),
  },
  {
    id: "rule:exhaustion",
    entity: "condition/exhaustion",
    words: both("exhaustion", "exhausted"),
  },
  {
    id: "rule:armor-class",
    entity: "rule-term/armor-class",
    words: ["Armor Class"],
  },
  {
    id: "rule:hit-points",
    entity: "rule-term/hit-points",
    words: ["Hit Points", "hit points"],
  },
  {
    id: "rule:surprise",
    entity: "rule-term/surprise",
    words: both("surprised"),
  },
  {
    id: "rule:darkvision",
    entity: "sense/darkvision",
    words: both("darkvision"),
  },
  { id: "rule:speed", entity: "rule-term/speed", words: ["Speed"] },
  { id: "rule:reach", entity: "rule-term/reach", words: both("reach") },
  {
    id: "rule:heroic-inspiration",
    entity: "rule-term/heroic-inspiration",
    words: both("heroic inspiration").concat("Heroic Inspiration"),
  },
  {
    id: "rule:short-rest",
    entity: "rule-term/short-rest",
    words: both("short rest").concat("Short Rest"),
  },
  {
    id: "rule:long-rest",
    entity: "rule-term/long-rest",
    words: both("long rest").concat("Long Rest"),
  },
  {
    id: "rule:hit-point-dice",
    entity: "rule-term/hit-point-dice",
    words: ["Hit Dice", "Hit Point Dice", "hit dice"],
  },
  {
    id: "rule:proficiency",
    entity: "rule-term/proficiency",
    words: ["Proficiency"],
  },
];

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  ...ConditionSchema.options.map((condition) => ({
    id: `condition:${condition}`,
    entity: `condition/${condition}`,
    words: both(condition),
  })),
  // Lower-case only, as in "7 fire damage", so names such as Fire Bolt aren't linked.
  ...DAMAGE_TYPES.map((type) => ({
    id: `damage:${type}`,
    entity: "rule-term/damage-types",
    words: [type],
  })),
  // A tactic's word on a creature ("dodging") stands for the action or mastery it comes from.
  ...[...ACTIONS, ...WEAPON].map((term) => {
    const tactic = TACTICS.find((item) => TACTIC_ACTIONS[item] === term.id);
    return tactic
      ? { ...term, words: [...term.words, ...both(TACTIC_WORDS[tactic])] }
      : term;
  }),
  ...RULES,
  // Capitalized, one or many, from the Monster Manual's section that explains each type: the types' own entities
  // list monsters rather than explain. A name holding a type's word, as Giant Rat or Fey Step, isn't linked
  // (termFinder's names).
  ...CREATURE_TYPES.map((type) => ({
    id: `creature-type:${type}`,
    entity: "rule-term/creature-type",
    books: ["monster-manual"],
    words: [...new Set([capital(type), capital(plural(type))])],
  })),
  // Capitalized only, since "history" is a word of a sentence too.
  ...ALL_SKILLS.map((skill) => ({
    id: `skill:${skill}`,
    entity: `skill/${glossaryName(skill)}`,
    words: [
      glossaryName(skill)
        .split("-")
        .map((word) => (word === "of" ? word : capital(word)))
        .join(" "),
    ],
  })),
];
