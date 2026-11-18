import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { AbilitySchema, SkillSchema } from "./basics.ts";
import { FormulaSchema } from "./dice.ts";
import { FreeCastSchema } from "./features.ts";
import { AbilityScoresSchema } from "./monsters.ts";

const AbilityIncreaseSchema = z.partialRecord(
  AbilitySchema,
  z.number().int().min(1).max(2),
);

export const ChoiceAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("skills"),
    values: z.array(SkillSchema),
    expertise: z.literal(true).optional(), // from a choice with `expertise`
    orExpertise: z.literal(true).optional(), // from a choice with `orExpertise`
    feat: ContentIdSchema.optional(), // the feat or species that asked, when it can be swapped
    bonus: FormulaSchema.optional(), // from a choice with `bonus`
  }),
  z.strictObject({
    kind: z.literal("spells"),
    values: z.array(ContentIdSchema),
    freeCast: z.lazy(() => FreeCastSchema).optional(), // from a choice with `freeCast`
    feat: ContentIdSchema.optional(), // the feat that asked, for its spells' ability
    ability: AbilitySchema.optional(), // from a choice with `ability`
  }),
  z.strictObject({
    kind: z.literal("features"),
    values: z.array(ContentIdSchema),
    feat: ContentIdSchema.optional(), // the feat or species that asked, for its spells' ability
  }),
  z.strictObject({
    kind: z.literal("weaponMastery"),
    values: z.array(ContentIdSchema),
    feat: ContentIdSchema.optional(), // the feat that asked, when it can be swapped
  }),
  z.strictObject({
    kind: z.literal("weapons"),
    values: z.array(ContentIdSchema),
    monk: z.literal(true).optional(), // from a choice with `monk`
  }),
  // Tools by id, and skills from a choice with `skills`.
  z.strictObject({
    kind: z.literal("tools"),
    values: z.array(z.string().min(1)),
    feat: ContentIdSchema.optional(), // the feat or species that asked, when it can be swapped
  }),

  z.strictObject({
    kind: z.literal("subclass"),
    values: z.array(ContentIdSchema).length(1),
  }),
  z.strictObject({
    kind: z.literal("feats"),
    values: z.array(ContentIdSchema),
  }),
  z.strictObject({
    kind: z.literal("abilities"),
    increases: AbilityIncreaseSchema,
  }),
  z.strictObject({
    kind: z.literal("spellAbility"),
    ability: AbilitySchema,
    feat: ContentIdSchema, // whose spells it's for: a feat, or the species
  }),
  // The variant picked for a feature that has them (a `variant` choice).
  z.strictObject({
    kind: z.literal("variant"),
    feature: ContentIdSchema,
    values: z.array(z.string().min(1)).min(1),
  }),
]);

export const CharacterBuildSchema = z.strictObject({
  baseAbilities: AbilityScoresSchema,
  speciesId: ContentIdSchema,
  backgroundId: ContentIdSchema,
  backgroundIncrease: AbilityIncreaseSchema,
  levels: z
    .array(
      z.strictObject({
        classId: ContentIdSchema,
        hitPointGain: z.number().int().min(1),
        answers: z.array(ChoiceAnswerSchema).default([]),
      }),
    )
    .min(1),
});
export type CharacterBuild = z.infer<typeof CharacterBuildSchema>;

export const PregenSchema = ContentEntrySchema.extend({
  name: z.string().min(1), // what it is, as the picker offers it, such as "Human Fighter"
  hero: z.string().min(1).optional(), // the character's own name, once picked
  build: CharacterBuildSchema,
  equipment: z.array(ContentIdSchema),
}).strict();
