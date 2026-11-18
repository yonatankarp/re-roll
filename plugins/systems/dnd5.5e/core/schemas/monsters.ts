import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { ActivationSchema } from "./activation.ts";
import { AbilitySchema, PrintedCreatureTypeSchema } from "./basics.ts";
import { FormulaSchema } from "./dice.ts";
import { PassiveSchema } from "./passives.ts";

export const AbilityScoresSchema = z.strictObject({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});
export type AbilityScores = z.infer<typeof AbilityScoresSchema>;

// One legendary action: either some of the monster's own actions, by name, or an effect of its own.
export const LegendaryActionSchema = z
  .strictObject({
    name: z.string().min(1),
    cost: z.number().int().min(1).default(1), // uses it spends
    oncePerRound: z.boolean().default(false), // not again until the start of the monster's next turn
    moves: z.boolean().default(false), // it may move up to half its Speed first
    makes: z.array(z.string().min(1)).optional(), // its own actions it takes, once each, such as two Bites
    activation: ActivationSchema.optional(),
  })
  .refine((item) => item.makes !== undefined || item.activation, {
    message: "needs makes or an activation",
  });

export const MonsterSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  ac: z.number().int(),
  hp: z.number().int().min(1),
  speed: z.number().int(), // walking
  speeds: z // every speed in the stat block, when it has more than walking
    .strictObject({
      walk: z.number().int(),
      fly: z.number().int().optional(),
      swim: z.number().int().optional(),
      climb: z.number().int().optional(),
      burrow: z.number().int().optional(),
    })
    .optional(),
  size: z
    .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
    .optional(),
  abilities: AbilityScoresSchema,
  proficiency: z.number().int(),
  saves: z.array(AbilitySchema).default([]),
  initiative: z.number().int(),
  creatureType: PrintedCreatureTypeSchema.optional(),
  features: z.array(ContentIdSchema).default([]),
  passives: z.array(PassiveSchema).default([]),
  multiattack: z.number().int().min(1).default(1),
  actions: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        recharge: z.number().int().min(2).max(6).optional(), // ready again on this d6 roll or higher
        perDay: z.number().int().min(1).optional(), // uses of its resource cost, back after a Long Rest
        shapes: z.array(z.string().min(1)).min(1).optional(), // the shapes it can be used in, as "(Wolf Form Only)"
        rolled: z.literal(true).optional(), // taken only when a randomAction picks it, as one eye ray
        activation: ActivationSchema,
      }),
    )
    .default([]), // empty when nothing it does can be automated, as for a creature that only has traits
  // Every shape its Shape-Shift takes, its true one first: what each changes from the stat block (core/forms.ts).
  shapes: z
    .array(
      z.strictObject({
        name: z.string().min(1), // lowercase, as its "(… Form Only)" entries name it
        size: z
          .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
          .optional(),
        speed: z.number().int().optional(), // walking
        speeds: z
          .strictObject({
            walk: z.number().int(),
            fly: z.number().int().optional(),
            swim: z.number().int().optional(),
            climb: z.number().int().optional(),
            burrow: z.number().int().optional(),
          })
          .optional(),
        passives: z.array(PassiveSchema).default([]), // traits printed for this shape only
        multiattack: z.boolean().default(true), // false when its Multiattack is printed for other shapes only
      }),
    )
    .min(2)
    .optional(),
  // Taken right after another creature's turn, spending uses that come back at the start of its own.
  legendary: z
    .strictObject({
      uses: z.number().int().min(1),
      usesInLair: z.number().int().min(1).optional(),
      actions: z.array(LegendaryActionSchema).min(1),
    })
    .optional(),
  legendaryResistance: z // turns a failed save into a success, so many times a day
    .strictObject({
      perDay: z.number().int().min(1),
      inLair: z.number().int().min(1).optional(),
    })
    .optional(),
  // Taken on initiative count 20, losing ties, when the encounter is in its lair.
  lairActions: z
    .array(
      z.strictObject({ name: z.string().min(1), activation: ActivationSchema }),
    )
    .optional(),
  text: z.string().optional(), // the stat block as printed, for reading
}).strict();
export type Monster = z.infer<typeof MonsterSchema>;

// A creature whose numbers depend on who brought it, such as a summoned spirit, so it isn't a monster yet.
export const CompanionSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  size: z
    .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
    .optional(),
  ac: z.string().min(1), // as printed, because it's a formula
  hp: z.string().min(1), // as printed, because it's a formula
  speed: z.string().min(1),
  abilities: AbilityScoresSchema,
  text: z.string().min(1),
  // How a spell's `summon` effect plays it: its numbers as printed for the spell's own `level`, and what each
  // level above adds. Its attacks of type "spell" use the caster's spell attack, and its save DCs the caster's.
  play: MonsterSchema.pick({
    ac: true,
    hp: true,
    speed: true,
    speeds: true,
    saves: true,
    creatureType: true,
    passives: true,
    multiattack: true,
    actions: true,
  })
    .extend({
      level: z.number().int().min(1).max(9),
      acPerLevel: z.number().int().default(0),
      hpPerLevel: z.number().int().default(0),
      // Its Multiattack makes half the spell's level in attacks, rounded down.
      halfLevelAttacks: z.boolean().default(false),
      // The forms the caster picks from as it casts (LeafEffect summon `form`), as Summon Undead's Ghostly, Putrid or
      // Skeletal: each changes these numbers and adds its own traits, and an action whose `shapes` name forms is that
      // form's alone (stats.ts summonStats). The first is the one when none is named.
      forms: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            ac: z.number().int().optional(),
            hp: z.number().int().optional(),
            speed: z.number().int().optional(),
            speeds: z
              .strictObject({
                walk: z.number().int(),
                fly: z.number().int().optional(),
                swim: z.number().int().optional(),
                climb: z.number().int().optional(),
                burrow: z.number().int().optional(),
              })
              .optional(),
            passives: z.array(PassiveSchema).default([]),
          }),
        )
        .min(2)
        .optional(),
      // A lasting companion's numbers from its owner's, worked out as it's found (combat/companions.ts), as a Steel
      // Defender's 5 plus five times the Artificer level and AC 12 plus the Intelligence modifier.
      owner: z
        .strictObject({ hp: FormulaSchema, ac: FormulaSchema.optional() })
        .optional(),
    })
    .strict()
    .optional(),
}).strict();
export type Companion = z.infer<typeof CompanionSchema>;
