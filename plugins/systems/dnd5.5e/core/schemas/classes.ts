import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { AbilitySchema, WeaponPropertySchema } from "./basics.ts";
import { ChoiceDefSchema } from "./features.ts";

// When the picks a class's levels asked for can be changed (swap.ts): its cantrips, its prepared spells and its
// options such as Eldritch Invocations. "levelUp" is one pick each time it gains a level, "longRest" one after each
// Long Rest, and "prepare" any of them after each Long Rest, as a Cleric changes its list.
const SwapWhenSchema = z.enum(["levelUp", "longRest", "prepare"]);
export const ClassSwapsSchema = z.strictObject({
  cantrips: SwapWhenSchema.optional(),
  spells: SwapWhenSchema.optional(),
  options: SwapWhenSchema.optional(),
  weaponMastery: SwapWhenSchema.optional(), // its Weapon Mastery's weapons, as a Fighter's one after a Long Rest
});
export type ClassSwaps = z.infer<typeof ClassSwapsSchema>;

const ClassLevelSchema = z.strictObject({
  level: z.number().int().min(1).max(20),
  grants: z.array(ContentIdSchema).default([]),
  choices: z.array(ChoiceDefSchema).default([]),
  slots: z.array(z.number().int().min(0)).default([]), // index 0 holds level 1 slots
  scaling: z.record(z.string(), z.number()).default({}),
});

export const ClassSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  hitDie: z.enum(["d6", "d8", "d10", "d12"]),
  primaryAbilities: z.array(AbilitySchema).min(1),
  savingThrows: z.array(AbilitySchema),
  weapons: z.array(z.enum(["simple", "martial"])),
  // When set, only Martial weapons with one of these properties count, as for a Rogue or Monk.
  martialWeaponProperties: z.array(WeaponPropertySchema).min(1).optional(),
  armor: z.array(z.enum(["light", "medium", "heavy", "shield"])),
  spellcasting: z.strictObject({ ability: AbilitySchema }).optional(),
  swaps: ClassSwapsSchema.optional(),
  tools: z.array(ContentIdSchema).optional(), // tool proficiencies it gives at level 1, by id, as a Rogue's Thieves' Tools
  // Spells the class's own chapter names, for a class newer than the books that print them.
  spellList: z.array(ContentIdSchema).optional(),
  // shortcut: fewer than 20 levels are allowed while content is being added, require 20 once step 5 is done.
  levels: z.array(ClassLevelSchema).min(1),
}).strict();
export type ClassDef = z.infer<typeof ClassSchema>;

// Same level structure as a class, and each level's grants apply at that level of the parent class.
export const SubclassSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  class: ContentIdSchema,
  // Printed for the 2014 rules, whose levels don't line up with these classes, so character creation doesn't offer it.
  edition: z.literal("2014").optional(),
  // Only a character of one of these species takes it, as the Battlerager's dwarves.
  requires: z.array(ContentIdSchema).min(1).optional(),
  // Spellcasting the subclass gives a class without its own, from `list`'s spells, as an Eldritch Knight's Wizard
  // spells. Its levels' `slots` and `cantrips` and `preparedSpells` scaling then ask for picks as a class's do.
  spellcasting: z
    .strictObject({
      ability: AbilitySchema,
      list: ContentIdSchema,
      swaps: ClassSwapsSchema.optional(),
    })
    .optional(),
  levels: z.array(ClassLevelSchema).min(1),
}).strict();
export type Subclass = z.infer<typeof SubclassSchema>;
