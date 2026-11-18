import { z } from "zod";

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export const AbilitySchema = z.enum(ABILITIES);
export type Ability = z.infer<typeof AbilitySchema>;
export const ABILITY_NAMES = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
} as const satisfies Record<Ability, string>;

export const SKILL_ABILITIES = {
  acrobatics: "dex",
  animalHandling: "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  sleightOfHand: "dex",
  stealth: "dex",
  survival: "wis",
} as const satisfies Record<string, Ability>;
export type Skill = keyof typeof SKILL_ABILITIES;

export const ALL_SKILLS = Object.keys(SKILL_ABILITIES) as [Skill, ...Skill[]];
const SKILLS = ALL_SKILLS;
export const SkillSchema = z.enum(SKILLS);

export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export const DamageTypeSchema = z.enum(DAMAGE_TYPES);

// The creature types, lowercase, each a monster-manual creature-type entity (#187).
export const CREATURE_TYPES = [
  "aberration",
  "beast",
  "celestial",
  "construct",
  "dragon",
  "elemental",
  "fey",
  "fiend",
  "giant",
  "humanoid",
  "monstrosity",
  "ooze",
  "plant",
  "undead",
] as const;
const isCreatureType = (type: string) =>
  (CREATURE_TYPES as readonly string[]).includes(type);
// Checked against the list, though read as a string, so code may compare it with any stats' type.
export const CreatureTypeSchema = z
  .string()
  .refine(isCreatureType, "must be a lowercase creature type");
// A book may print it capitalized ("Humanoid"), and stats read it lowercase.
export const PrintedCreatureTypeSchema = z
  .string()
  .refine(
    (type) => isCreatureType(type.toLowerCase()),
    "must be a creature type",
  );
export type DamageType = z.infer<typeof DamageTypeSchema>;

export const ConditionSchema = z.enum([
  "blinded",
  "charmed",
  "deafened",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const AutomationSchema = z.enum(["full", "partial", "text"]);

export const WeaponPropertySchema = z.enum([
  "ammunition",
  "finesse",
  "heavy",
  "light",
  "loading",
  "range",
  "reach",
  "thrown",
  "twoHanded",
  "versatile",
]);

export const WeaponMasterySchema = z.enum([
  "cleave",
  "graze",
  "nick",
  "push",
  "sap",
  "slow",
  "topple",
  "vex",
]);
export type WeaponMastery = z.infer<typeof WeaponMasterySchema>;

export const SpellSchoolSchema = z.enum([
  "abjuration",
  "conjuration",
  "divination",
  "enchantment",
  "evocation",
  "illusion",
  "necromancy",
  "transmutation",
]);
