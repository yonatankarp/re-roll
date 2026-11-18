import { ContentIdSchema } from "#sdk";
import { z } from "zod";
import {
  AbilitySchema,
  AutomationSchema,
  ConditionSchema,
  CreatureTypeSchema,
  DamageTypeSchema,
  SkillSchema,
} from "./basics.ts";
import { DamageSchema, DiceSchema } from "./dice.ts";
import { GlossaryEntrySchema } from "./glossary.ts";
import { ObstacleSchema, WeatherSchema } from "./modifiers.ts";
import { PassiveSchema } from "./passives.ts";

// `about` says what a check acts on, so what deals with that helps (core/explore.ts), as Knock with a lock.
const AboutSchema = z.array(ObstacleSchema).min(1).optional();
// The creature a check is made with, for what goes by whom it's made with (Modifier advantage `with`): its type, its
// kin (a people such as "dwarf"), its Challenge Rating, and whether it's Hostile, which gives Disadvantage on a check to
// influence it (core/explore.ts).
const WithSchema = z
  .strictObject({
    creatureType: CreatureTypeSchema.optional(),
    kin: z.string().min(1).optional(),
    cr: z.number().min(0).optional(),
    hostile: z.literal(true).optional(),
  })
  .optional();

export const CheckSchema = z.union([
  // `ability` pairs the skill with another ability, as a Constitution (Athletics) check (variant-rules.ts).
  z.strictObject({
    skill: SkillSchema,
    ability: AbilitySchema.optional(),
    dc: z.number().int(),
    about: AboutSchema,
    with: WithSchema,
  }),
  z.strictObject({
    ability: AbilitySchema,
    dc: z.number().int(),
    about: AboutSchema,
  }),
  // A dungeon feature's check, its skill and ability from the feature, at the DC the adventure prints, as picking a
  // Locked Door's lock (environment.ts).
  z.strictObject({ feature: ContentIdSchema, dc: z.number().int() }),
  // A check with a tool, by id: its ability, or the tool's, and a skill that also applies (core/explore.ts). With
  // `needs`, it can't succeed without the tool, as picking a Locked Door's lock with Thieves' Tools.
  z.strictObject({
    tool: ContentIdSchema,
    ability: AbilitySchema.optional(),
    skill: SkillSchema.optional(),
    dc: z.number().int(),
    needs: z.literal(true).optional(),
    about: AboutSchema,
  }),
]);

// What an environment does in play (#191), each entry the glossary's shape with the numbers the engine reads
// (environment.ts). A scene names one for the time the party spends in it, and an encounter for the fight in it.

// A save after each hour (or minute) spent in it, a failure giving a level of Exhaustion, as Extreme Cold's.
const ExposureSchema = z.strictObject({
  every: z.enum(["hour", "minute"]).default("hour"),
  ability: AbilitySchema,
  dc: z.number().int(),
  dcStep: z.number().int().min(1).optional(), // more for each one after the first, as Extreme Heat's 5, then 6
  graceCon: z.literal(true).optional(), // as many as its Constitution score pass first, as Frigid Water's minutes
  resist: DamageTypeSchema.optional(), // Resistance or Immunity to this type succeeds, as against Extreme Cold
  swimSpeed: z.literal(true).optional(), // a Swim Speed succeeds, as in Deep Water
  armor: z.enum(["advantage", "disadvantage"]).optional(), // Medium or Heavy armor's edge on the save
  maxExhaustion: z.number().int().min(1).optional(), // no more Exhaustion than this from it, as Pandemonium's 3
  water: z.literal(true).optional(), // drinkable water succeeds, as against Extreme Heat
});

// One roll on an environment's table for the party, as a psychic wind's: each row's effects, after a save when the
// row or the table has one. `hours` pass for a delay.
const EnvironmentRowSchema = z.strictObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
  hours: z.union([z.number().int().min(1), DiceSchema]).optional(),
  hoursTimes: z.number().int().min(1).optional(), // the hours rolled, times this, as 1d6 days
  damage: z.array(DamageSchema).optional(),
  // conditions until damage or a shake ends them, lasting this many hours beyond a fight, as 1d10 hours Unconscious
  conditions: z.array(ConditionSchema).optional(),
  lingers: DiceSchema.optional(),
});

export const EnvironmentalEffectSchema = GlossaryEntrySchema.extend({
  automation: AutomationSchema.default("text"),
  // A scene check against it names it as a dungeon feature's would (environment.ts featureCheck), as seeing through a
  // Mirage with Investigation.
  check: z
    .strictObject({
      skill: SkillSchema.optional(),
      ability: AbilitySchema,
      tool: ContentIdSchema.optional(),
      about: AboutSchema,
    })
    .optional(),
  weather: WeatherSchema.optional(), // the weather it is, as Extreme Cold's cold
  exposure: ExposureSchema.optional(),
  // In a fight fought in it, or a scene spent in it, every creature not of an `except` type has these passives, as
  // Arcadian Vitality's Immunity to Frightened.
  passives: z.array(PassiveSchema).default([]),
  except: z.array(z.string()).optional(),
  // And in a fight: these conditions on every creature, as Howling Wind's Deafened; every square Difficult Terrain;
  // a save as each turn starts or the condition, as Slippery Ice's; an Antimagic Field everywhere, as a Dead Magic
  // Zone; a flyer comes down at the end of its turn, as in a Strong Wind; falls hurt half, as in Low Gravity; force
  // dice of 1 or 2 count as 3; Reverse Gravity's lift at this DC every few rounds, as Unstable Gravity's.
  fight: z
    .strictObject({
      conditions: z.array(ConditionSchema).optional(),
      difficult: z.literal(true).optional(),
      turnSave: z
        .strictObject({
          ability: AbilitySchema,
          dc: z.number().int(),
          condition: ConditionSchema,
        })
        .optional(),
      deadMagic: z.literal(true).optional(),
      grounded: z.literal(true).optional(),
      halfFalls: z.literal(true).optional(),
      forceFloor: z.number().int().min(2).optional(),
      reverseGravity: z.strictObject({ dc: z.number().int() }).optional(),
      halfDurations: z.literal(true).optional(), // a spell lasting a minute or more lasts half as long
    })
    .optional(),
  // After a Long Rest in it: Exhaustion isn't lessened, as in Pandemonium's winds; conditions a Lesser Restoration
  // would end are, as with Blessed Beneficence; or this condition comes for the next fight, as a psionic field's fright.
  rest: z
    .strictObject({
      keepExhaustion: z.literal(true).optional(),
      restore: z.literal(true).optional(),
      condition: ConditionSchema.optional(),
    })
    .optional(),
  // Thin Ice: each party member's square holds this roll times `times` pounds, and one heavier breaks through into
  // `into`, spending the scene's minutes in it, as Frigid Water.
  breaks: z
    .strictObject({
      dice: DiceSchema,
      times: z.number().int().min(1),
      into: ContentIdSchema,
    })
    .optional(),
  // Tables rolled once it comes, as a psychic wind's: once for the party, or with `save` once for each traveler
  // that fails it.
  tables: z
    .array(
      z.strictObject({
        save: z
          .strictObject({ ability: AbilitySchema, dc: z.number().int() })
          .optional(),
        die: z.number().int().min(2),
        rows: z.array(EnvironmentRowSchema).min(1),
      }),
    )
    .optional(),
}).strict();
export type EnvironmentalEffect = z.infer<typeof EnvironmentalEffectSchema>;

// A disease (#191): caught on a failed save, its symptoms after `onsetRests` Long Rests (days count as Long Rests),
// then fought with a save after each Long Rest.
export const DiseaseSchema = GlossaryEntrySchema.extend({
  automation: AutomationSchema.default("text"),
  // who can catch it, by lowercase type, and species that can't, as Cackle Fever's gnomes
  creatureTypes: z.array(z.string()).optional(),
  immuneSpecies: z.array(z.string()).optional(),
  catch: z
    .strictObject({ ability: AbilitySchema, dc: z.number().int() })
    .optional(),
  onsetRests: z.number().int().min(0).default(0),
  symptoms: z
    .strictObject({
      exhaustion: z.number().int().min(0).default(0), // levels at onset
      holdsExhaustion: z.literal(true).optional(), // a Long Rest takes no Exhaustion away while it lasts
      blinded: z.literal(true).optional(), // as 2024 Sight Rot
      sightPenalty: z.literal(true).optional(), // -1 to sight-based attack rolls and checks, 1 worse each Long Rest
      halfHitDice: z.literal(true).optional(), // half healing from Hit Point Dice while Exhausted, as Sewer Plague's
      noRestHealing: z.literal(true).optional(), // a Long Rest restores no Hit Points while Exhausted
      keepExhaustion: z.literal(true).optional(), // a Long Rest takes no Exhaustion away while Exhausted
      // Taking damage (other than Psychic) gives this save, whose failure deals `damage` and Incapacitates it until
      // it saves at the end of a turn, as Cackle Fever's laughter.
      laughter: z
        .strictObject({
          dc: z.number().int(),
          damage: z.array(DamageSchema).min(1),
        })
        .optional(),
    })
    .default({ exhaustion: 0 }),
  // The save after each Long Rest: a failure adds a level of Exhaustion with `failExhaustion`, a success takes one
  // away with `successLessens`; it ends after `cureAt` successes (in a row with `streak`), or once its Exhaustion is
  // gone with `cureAtZero`.
  fight: z
    .strictObject({
      ability: AbilitySchema,
      dc: z.number().int(),
      failExhaustion: z.literal(true).optional(),
      successLessens: z.literal(true).optional(),
      cureAt: z.number().int().min(1).optional(),
      streak: z.literal(true).optional(),
      cureAtZero: z.literal(true).optional(),
      dcDrop: DiceSchema.optional(), // a success lowers the DC by this roll, ending it at 0, as 2014 Cackle Fever's
    })
    .optional(),
  cureSpells: z.literal(true).optional(), // Lesser Restoration or Heal ends it
}).strict();
export type Disease = z.infer<typeof DiseaseSchema>;

// A dungeon feature (#191): the check a scene's choice makes against it, at the DC the adventure prints.
export const DungeonFeatureSchema = GlossaryEntrySchema.extend({
  automation: AutomationSchema.default("text"),
  // `tool` is needed for the check, as Thieves' Tools to pick a Locked Door's lock; `about` is what it acts on.
  check: z
    .strictObject({
      skill: SkillSchema.optional(),
      ability: AbilitySchema,
      tool: ContentIdSchema.optional(),
      about: AboutSchema,
    })
    .optional(),
}).strict();
export type DungeonFeature = z.infer<typeof DungeonFeatureSchema>;
export type Check = z.infer<typeof CheckSchema>;
