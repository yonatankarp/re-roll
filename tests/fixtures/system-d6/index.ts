import {
  ContentEntrySchema,
  ContentIdSchema,
  contentKind,
  defineSystem,
  encounterKind,
} from "#sdk";
import { z } from "zod";

// A deliberately un-D&D-like system: one d6, three outcomes, and no turns, HP or grid.
// If the engine starts assuming any of those, this fixture stops working.

const TrickSchema = ContentEntrySchema.extend({ name: z.string() }).strict();

const FoeSchema = ContentEntrySchema.extend({
  name: z.string(),
  menace: z.number().int().min(1).max(6),
  trick: ContentIdSchema.optional(),
}).strict();

const EncounterSchema = z.strictObject({
  id: z.string(),
  foes: z.array(ContentIdSchema).min(1),
});

export const d6System = defineSystem({
  id: "d6",
  version: "1.0.0",
  sdk: "^1",
  contentKinds: {
    tricks: contentKind({ idPrefix: "trick", schema: TrickSchema }),
    foes: contentKind({
      idPrefix: "foe",
      schema: FoeSchema,
      references: (foe) => (foe.trick ? [foe.trick] : []),
    }),
  },
  checkSchema: z.strictObject({ risk: z.enum(["low", "high"]) }),
  encounters: encounterKind({
    schema: EncounterSchema,
    references: (encounter) => encounter.foes,
  }),
  outcomes: {
    keys: ["hit", "mixed", "miss"],
    groups: { notMiss: ["hit", "mixed"] },
  },
  storyEffects: {
    "d6:gainLuck": z.strictObject({ amount: z.number().int().min(1) }),
  },
  storyPredicates: {
    "d6:hasLuck": z.strictObject({ atLeast: z.number().int().min(1) }),
  },
});
