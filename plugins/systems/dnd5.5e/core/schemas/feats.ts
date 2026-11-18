import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { AbilitySchema } from "./basics.ts";
import { ChoiceDefSchema } from "./features.ts";

export const FeatSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  category: z.enum([
    "origin",
    "general",
    "fightingStyle",
    "epicBoon",
    "darkGift",
    "dragonmark",
    "racial",
  ]),
  text: z.string().min(1),
  grants: z.array(ContentIdSchema).default([]),
  choices: z.array(ChoiceDefSchema).default([]), // asked when the feat is taken
  abilityIncrease: z.array(AbilitySchema).min(1).optional(), // its Ability Score Increase: +1 to one of these
  // Its prerequisite, met by any of these: the species, a trait or lineage it has, or a feat taken.
  requires: z.array(ContentIdSchema).min(1).optional(),
  // The rest of its Prerequisite line: a score of 13 or more in one of these abilities, the Spellcasting or Pact
  // Magic feature, armor training, or a campaign in a setting, matched with the adventure's.
  prerequisite: z
    .strictObject({
      abilities: z.array(AbilitySchema).min(1).optional(),
      min: z.number().int().min(1).max(30).optional(),
      spellcasting: z.literal(true).optional(),
      armor: z.enum(["light", "medium", "heavy"]).optional(),
      campaign: z.enum(["eberron", "ravenloft"]).optional(),
    })
    .optional(),
  // The spellcasting ability of the spells it gives: this one, the one it raised ("increased"), the one chosen for
  // a feat taken earlier (`like`, matched by id or by version as Magic Initiate's), or with none, its spellAbility
  // choice, else the character's own.
  spellAbility: z
    .union([
      AbilitySchema,
      z.literal("increased"),
      z.strictObject({ like: ContentIdSchema }),
    ])
    .optional(),
}).strict();
export type Feat = z.infer<typeof FeatSchema>;
