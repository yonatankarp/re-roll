import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { ActivationSchema } from "./activation.ts";
import { AutomationSchema, SpellSchoolSchema } from "./basics.ts";
import { DurationSchema } from "./effects.ts";
import { ScaleStepSchema } from "./features.ts";

export const SpellSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  level: z.number().int().min(0).max(9),
  school: SpellSchoolSchema,
  classes: z.array(ContentIdSchema),
  castingTime: z.string().min(1),
  ritual: z.boolean().default(false),
  range: z.string().min(1),
  components: z.string().min(1),
  duration: DurationSchema,
  text: z.string().min(1),
  automation: AutomationSchema,
  activation: ActivationSchema.optional(),
  // In a fight it takes the action of this many turns in a row to cast, concentrating throughout, as a spell of a
  // minute's casting does (Longer Casting Times, combat/casting.ts).
  castRounds: z.number().int().min(2).optional(),
  // An action its caster can take while concentrating on it, as Flame Blade's attack or Heat Metal's Bonus Action.
  lasting: ActivationSchema.optional(),
  // What it does outside a fight that its fight's activation doesn't, as Freezing Sphere's frozen water, cast only
  // between fights from the sheet (camp.ts, explore.ts).
  scene: ActivationSchema.optional(),
  // An action its target can take while a `grantedAction` it gave lasts, as Dragon's Breath's breath.
  granted: ActivationSchema.optional(),
  // Uses its caster spends on these activations while its `spheres` effect lasts: `count`, and `perSlot` more for
  // each slot level above the spell's, as Elminster's Effulgent Spheres (stats.ts). Casting it again gives them all
  // back with a `regain` of "spheres:<spell id>".
  spheres: z
    .strictObject({
      count: z.number().int().min(1),
      perSlot: z.number().int().min(0).default(0),
      actions: z.array(ActivationSchema).min(1),
      // It starts empty, and each foe that dies in its zone fills one, up to `count`, or the caster's spellcasting
      // modifier with `countMod` (cast from an item, `count`), as Spirit Lantern's soul fragments (combat/areas.ts).
      gathered: z.literal(true).optional(),
      countMod: z.literal(true).optional(),
    })
    .optional(),
  // What its `randomAction` picks from, each named by its label, as Prismatic Spray's rays.
  rolled: z.array(ActivationSchema).min(2).optional(),
  // Why a spell with no activation needs none: it takes longer than a turn to cast ("castingTime"), or does
  // nothing a grid fight plays, such as travel, senses, talk or downtime ("utility").
  outOfCombat: z.enum(["castingTime", "utility"]).optional(),
  // Knowing it gives the caster a lasting companion, as a feature's `lastingCompanion` passive would, with the spell's
  // level for its numbers, as Homunculus Servant's (combat/companions.ts).
  companion: z
    .strictObject({
      companion: ContentIdSchema,
      monster: z.literal(true).optional(),
    })
    .optional(),
  // Knowing it gives the caster a familiar in this monster's form, which joins each fight (combat/familiar.ts).
  // shortcut: the form is the one given here rather than the caster's choice, and its type is Fey.
  familiar: z.strictObject({ form: ContentIdSchema }).optional(),
  upcast: z
    .strictObject({
      perSlotLevel: ScaleStepSchema,
    })
    .optional(),
  // Added once per step at character levels 5, 11 and 17.
  cantrip: z.strictObject({ perTier: ScaleStepSchema }).optional(),
}).strict();
export type Spell = z.infer<typeof SpellSchema>;
