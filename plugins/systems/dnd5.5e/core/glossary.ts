import { ConditionSchema, DAMAGE_TYPES } from "./schemas.ts";
import { TACTICS } from "./state.ts";
import { TACTIC_WORDS } from "./tactics.ts";

// The rules terms the game can explain from a book's Rules Glossary: each term's id, the glossary
// heading that explains it (a name, matched by code), and the words the game's own text uses for it.

export interface GlossaryTerm {
  readonly id: string;
  readonly heading: string;
  readonly words: readonly string[];
}

// Books whose Rules Glossary may explain a term, best first. 2014 books are left out, as their rules differ.
export const GLOSSARY_BOOKS = ["phb", "dmg", "basic-rules", "srd52"] as const;

const capital = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1);
// The game writes a word lower-case in running text and capitalized in a label.
const both = (...words: string[]): string[] =>
  words.flatMap((word) => [word, capital(word)]);

// Actions anyone can take, by the option kind that offers each (TACTIC_DETAILS in the ui).
// Common words such as "help" or "ready" match capitalized only, so a sentence's own word isn't linked.
const ACTIONS: readonly GlossaryTerm[] = [
  { id: "action:dash", heading: "Dash [Action]", words: ["Dash"] },
  {
    id: "action:disengage",
    heading: "Disengage [Action]",
    words: ["Disengage"],
  },
  { id: "action:dodge", heading: "Dodge [Action]", words: ["Dodge"] },
  { id: "action:help", heading: "Help [Action]", words: ["Help"] },
  { id: "action:hide", heading: "Hide [Action]", words: ["Hide"] },
  { id: "action:ready", heading: "Ready [Action]", words: ["Ready"] },
  { id: "action:search", heading: "Search [Action]", words: ["Search"] },
  { id: "action:study", heading: "Study [Action]", words: ["Study"] },
  {
    id: "action:influence",
    heading: "Influence [Action]",
    words: ["Influence"],
  },
  { id: "action:utilize", heading: "Utilize [Action]", words: ["Utilize"] },
  { id: "action:grapple", heading: "Grappling", words: ["Grapple"] },
  {
    id: "action:shove",
    heading: "Unarmed Strike",
    words: ["Shove", "Unarmed Strike"],
  },
];

// How a tactic reads on a creature ("dodging"), and the action it comes from.
const TACTIC_ACTIONS: Readonly<
  Record<(typeof TACTICS)[number], string | null>
> = {
  dodge: "action:dodge",
  disengage: "action:disengage",
  dash: "action:dash",
  hidden: "action:hide",
  ready: "action:ready",
  slowed: null, // a weapon's Slow mastery, which the Rules Glossary doesn't cover
  metamagic: null, // a Sorcerer feature, not in the Rules Glossary
};

const RULES: readonly GlossaryTerm[] = [
  { id: "rule:advantage", heading: "Advantage", words: both("advantage") },
  {
    id: "rule:disadvantage",
    heading: "Disadvantage",
    words: both("disadvantage"),
  },
  {
    id: "rule:opportunity-attack",
    heading: "Opportunity Attacks",
    words: both("opportunity attacks", "opportunity attack").concat(
      "Opportunity Attacks",
      "Opportunity Attack",
    ),
  },
  {
    id: "rule:saving-throw",
    heading: "Saving Throw",
    words: both("saving throws", "saving throw", "save", "saves").concat(
      "Saving Throws",
      "Saving Throw",
    ),
  },
  {
    id: "rule:death-saving-throw",
    heading: "Death Saving Throw",
    words: both("death saving throw", "death save", "dying").concat(
      "Death Saving Throw",
    ),
  },
  {
    id: "rule:bonus-action",
    heading: "Bonus Action",
    words: both("bonus action").concat("Bonus Action"),
  },
  { id: "rule:reaction", heading: "Reaction", words: both("reaction") },
  {
    id: "rule:concentration",
    heading: "Concentration",
    words: both("concentration", "concentrating"),
  },
  {
    id: "rule:cover",
    heading: "Cover",
    words: both("half cover", "three-quarters cover", "total cover"),
  },
  {
    id: "rule:difficult-terrain",
    heading: "Difficult Terrain",
    words: both("difficult terrain").concat("Difficult Terrain"),
  },
  {
    id: "rule:critical-hit",
    heading: "Critical Hit",
    words: both("critical hit").concat("Critical Hit"),
  },
  {
    id: "rule:temporary-hit-points",
    heading: "Temporary Hit Points",
    words: both("temporary hit points", "temp HP").concat(
      "Temporary Hit Points",
      "Temp HP",
    ),
  },
  {
    id: "rule:resistance",
    heading: "Resistance",
    words: both("resistance", "resists", "resistant"),
  },
  {
    id: "rule:vulnerability",
    heading: "Vulnerability",
    words: both("vulnerability", "vulnerable"),
  },
  {
    id: "rule:immunity",
    heading: "Immunity",
    words: both("immunity", "immune"),
  },
  { id: "rule:bloodied", heading: "Bloodied", words: both("bloodied") },
  { id: "rule:stable", heading: "Stable", words: both("stable", "stabilized") },
  { id: "rule:dead", heading: "Dead", words: both("dead") },
  { id: "rule:initiative", heading: "Initiative", words: both("initiative") },
  {
    id: "rule:exhaustion",
    heading: "Exhaustion [Condition]",
    words: both("exhaustion", "exhausted"),
  },
  { id: "rule:armor-class", heading: "Armor Class", words: ["Armor Class"] },
  {
    id: "rule:hit-points",
    heading: "Hit Points",
    words: ["Hit Points", "hit points"],
  },
  { id: "rule:surprise", heading: "Surprise", words: both("surprised") },
  { id: "rule:darkvision", heading: "Darkvision", words: both("darkvision") },
  { id: "rule:speed", heading: "Speed", words: ["Speed"] },
  { id: "rule:reach", heading: "Reach", words: both("reach") },
  {
    id: "rule:heroic-inspiration",
    heading: "Heroic Inspiration",
    words: both("heroic inspiration").concat("Heroic Inspiration"),
  },
  {
    id: "rule:short-rest",
    heading: "Short Rest",
    words: both("short rest").concat("Short Rest"),
  },
  {
    id: "rule:long-rest",
    heading: "Long Rest",
    words: both("long rest").concat("Long Rest"),
  },
  {
    id: "rule:hit-point-dice",
    heading: "Hit Point Dice",
    words: ["Hit Dice", "Hit Point Dice", "hit dice"],
  },
  { id: "rule:proficiency", heading: "Proficiency", words: ["Proficiency"] },
];

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  ...ConditionSchema.options.map((condition) => ({
    id: `condition:${condition}`,
    heading: `${capital(condition)} [Condition]`,
    words: both(condition),
  })),
  // Lower-case only, as in "7 fire damage", so names such as Fire Bolt aren't linked.
  ...DAMAGE_TYPES.map((type) => ({
    id: `damage:${type}`,
    heading: "Damage Types",
    words: [type],
  })),
  ...ACTIONS.map((action) => {
    const tactic = TACTICS.find((item) => TACTIC_ACTIONS[item] === action.id);
    return tactic
      ? { ...action, words: [...action.words, ...both(TACTIC_WORDS[tactic])] }
      : action;
  }),
  ...RULES,
];
