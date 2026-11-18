import { ContentEntrySchema } from "#sdk";
import { z } from "zod";

const LevelBandSchema = z.strictObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
});

// Traps and hazards share one shape. `text` is the printed entry as plain text, copied by code.
const DangerShape = {
  name: z.string().min(1),
  // A 2014 trap prints a threat (setback, moderate, dangerous or deadly) instead, and a glossary hazard neither.
  severity: z
    .enum(["nuisance", "deadly", "setback", "moderate", "dangerous"])
    .optional(),
  levels: z.array(LevelBandSchema).min(1).optional(), // the character levels it is meant for
  trigger: z.string().optional(),
  duration: z.string().optional(),
  // How the numbers change with character level, one row per band of the book's scaling table.
  scaling: z
    .array(
      z.strictObject({
        levels: LevelBandSchema,
        dc: z.number().int().optional(),
        damage: z.string().optional(), // as printed, such as "22 (4d10)"
        values: z.record(z.string(), z.string()), // every column of the row
      }),
    )
    .default([]),
  dcs: z.array(z.number().int()), // every DC in the text, in order
  text: z.string().min(1),
};
export const TrapSchema = ContentEntrySchema.extend(DangerShape).strict();
export type Trap = z.infer<typeof TrapSchema>;
export const HazardSchema = ContentEntrySchema.extend(DangerShape).strict();
export type Hazard = z.infer<typeof HazardSchema>;

export const PoisonSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  costGp: z.number().int().min(0),
  delivery: z.enum(["contact", "ingested", "inhaled", "injury"]),
  dc: z.number().int().optional(), // the first save DC in the text
  text: z.string().min(1),
}).strict();
export type Poison = z.infer<typeof PoisonSchema>;
