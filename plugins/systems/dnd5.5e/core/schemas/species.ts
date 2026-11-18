import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { PrintedCreatureTypeSchema } from "./basics.ts";
import { ChoiceDefSchema } from "./features.ts";

export const SpeciesSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  text: z.string().min(1),
  // A 2014 race prints none, as every one of them is a Humanoid.
  creatureType: PrintedCreatureTypeSchema.default("Humanoid"),
  size: z.enum(["tiny", "small", "medium", "large"]),
  speed: z.number().int(),
  traits: z.array(ContentIdSchema).default([]),
  choices: z.array(ChoiceDefSchema).default([]), // asked at character creation, such as a Draconic Ancestry
}).strict();
export type Species = z.infer<typeof SpeciesSchema>;
