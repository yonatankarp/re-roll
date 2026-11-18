import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { AbilitySchema, SkillSchema } from "./basics.ts";
import { ChoiceDefSchema } from "./features.ts";

export const BackgroundSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  // An older book's background lists all six: its increases go to any of them.
  abilities: z
    .array(AbilitySchema)
    .refine(
      (list) => list.length === 3 || list.length === 6,
      "must list 3 or 6",
    ),
  // An older book's background names none, and gives an Origin feat of the player's choice.
  feat: ContentIdSchema.optional(),
  // An older book's background may give fewer, and its `choices` ask for the rest.
  skills: z.array(SkillSchema).max(2),
  choices: z.array(ChoiceDefSchema).default([]), // asked at character creation, as "one from among Arcana and History"
  // An older book's background may print none.
  tool: z.string().min(1).optional(),
  // Its feat, or one of this category instead, as with "Survivor or a Dark Gift feat of your choice".
  featOr: z.literal("darkGift").optional(),
}).strict();
export type Background = z.infer<typeof BackgroundSchema>;
