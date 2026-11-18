import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { ActivationSchema, TableSchema } from "./activation.ts";
import {
  AbilitySchema,
  AutomationSchema,
  DamageTypeSchema,
  SkillSchema,
  SpellSchoolSchema,
  WeaponPropertySchema,
} from "./basics.ts";
import { AmountSchema, DiceSchema, FormulaSchema } from "./dice.ts";
import { DurationSchema, LeafEffectSchema } from "./effects.ts";
import { GlossaryEntrySchema } from "./glossary.ts";
import { PassiveSchema } from "./passives.ts";

// How a spell is cast without a slot (stats.ts freeCastActions): `true` once per Long Rest each; "shortRest" once per
// Short or Long Rest each, as Signature Spells; "atWill" at its lowest level whenever, as Spell Mastery; or by spending
// a use of `resource`, as War God's Blessing's Channel Divinity, then lasting `minutes` without Concentration. With
// `slotLevel`, it's cast as with a slot of the level keyed by the highest character level reached, as Genie Magic's
// level 2 slot from level 11, and only a spell of that level or lower is cast so.
export const FreeCastSchema = z.union([
  z.literal(true),
  z.enum(["shortRest", "atWill"]),
  // Without `resource` it's cast so whenever, as Ascendant Step's Levitate on the caster.
  z.strictObject({
    resource: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    minutes: z.number().int().min(1).optional(),
    slotLevel: z.record(z.string(), z.number().int().min(1).max(9)).optional(),
    self: z.literal(true).optional(), // cast so only on the caster, as Vampire Touched's Spider Climb
    perLevel: z.literal(true).optional(), // as many of `resource` as the spell's level, as Psionic Sorcery's points
    // only in Dim Light or Darkness, as One with Shadows' Invisibility
    whileIn: z.enum(["shadows", "sunlight"]).optional(),
    // cast with a Bonus Action in place of an action, a cantrip too, as Spellfire Spark's Sacred Flame
    bonusAction: z.literal(true).optional(),
    count: z.number().int().min(2).optional(), // as many of `resource`, as a Charm of Restoration's 2 for Greater Restoration
  }),
]);
export type FreeCast = z.infer<typeof FreeCastSchema>;

export const ResourceDefSchema = z.strictObject({
  id: z.string().min(1),
  max: FormulaSchema,
  // Dice rolled once, as it's first spent, and added to `max` for good, as Keoghtom's Ointment's 1d4 + 1 doses
  // (combat/effects.ts payCosts). Until then they count at their least.
  // shortcut: a second item with the same pool keeps the first one's roll.
  rolled: DiceSchema.optional(),
  // Uses it holds as it's found, as a Rod of Absorption's 1d10 levels of energy, the rest of `max` spent then
  // (gear.ts gainRolls). shortcut: as with `rolled`, one come by other than as treasure or bought starts full.
  startsWith: DiceSchema.optional(),
  recharge: z.array(
    z.strictObject({
      // "initiative" comes back as a fight starts, as Boon of Fate's Improve Fate does.
      on: z.enum(["turnStart", "shortRest", "longRest", "dawn", "initiative"]),
      // A formula is worked out from the bearer's numbers, as Sorcerous Restoration's half the Sorcerer level.
      amount: z.union([z.literal("all"), z.number().int(), FormulaSchema]),
      rollAtLeast: z.number().int().optional(),
      // No more come back than leave this many unspent, as Superior Inspiration's "until you have two".
      upTo: z.number().int().min(1).optional(),
      // Each time it applies it spends a use of this other resource, and it doesn't apply without one, as Persistent
      // Rage's once per Long Rest. Only on its own trigger: a Long Rest doesn't count as a Short Rest for it.
      uses: z.string().min(1).optional(),
      // Hit Points regained as it applies, as Uncanny Metabolism's Martial Arts die plus the Monk level.
      heal: z.lazy(() => AmountSchema).optional(),
      // Dice rolled and added to `amount`, as a wand's 1d6 + 1 charges at dawn (rest.ts).
      roll: DiceSchema.optional(),
      // Only once this many of its trigger have passed since the use was spent, as Cauldron of Rebirth's 7 days.
      // shortcut: a day passes with each Long Rest, the only clock between scenes.
      every: z.number().int().min(2).optional(),
      // With `every` left out, once as many of its trigger have passed as a roll of this die, rolled as the first
      // of them passes, as Lethargy Resilience's 1d4 Long Rests.
      everyDie: z.number().int().min(2).optional(),
    }),
  ),
});

export type ResourceDef = z.infer<typeof ResourceDefSchema>;

export const ScaleStepSchema = z.union([
  // With `every`, once for each that many levels, at most `max` times; `addBonus` also raises a flat bonus a modifier
  // gives, as Elemental Weapon's +1 to hit becomes +2 with its 1d4 becoming 2d4.
  // Without `addDice`, `addBonus` alone raises a flat number: healing, Temporary Hit Points, a damage bonus, a
  // retaliation's damage or Dispel Magic's level, as Heal's 10 more. `at` adds once at each of these slot levels
  // above the spell's instead, as Magic Weapon's +2 and +3. `initial` leaves damage that lingers alone, as Vitriolic
  // Sphere's 5d4, and `hitDice` lets its Hit Point Dice healing roll that many more, as Wither and Bloom's.
  z.strictObject({
    addDice: DiceSchema.optional(),
    every: z.number().int().min(2).optional(),
    max: z.number().int().min(1).optional(),
    addBonus: z.number().int().min(1).optional(),
    at: z.array(z.number().int().min(1)).min(1).optional(),
    initial: z.literal(true).optional(),
    hitDice: z.number().int().min(1).optional(),
  }),
  z.strictObject({ addTargets: z.number().int().min(1) }),
  z.strictObject({ addRadius: z.number().int().min(5) }), // an area's radius, as Confusion's Sphere
  // Nothing grows but what reads the slot's level, as Mordenkainen's Lucubration's `regain` `maxLevel`.
  z.strictObject({ slotOnly: z.literal(true) }),
  // Its effects last longer from a slot this many levels above the spell's, the highest reached counting, as Bestow
  // Curse's 10 minutes, then 8 hours without Concentration (stats.ts scaleActivation).
  z.strictObject({
    durations: z
      .array(
        z.strictObject({
          at: z.number().int().min(1),
          duration: DurationSchema,
        }),
      )
      .min(1),
  }),
]);
export type ScaleStep = z.infer<typeof ScaleStepSchema>;

export const FeatureSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  text: z.string().min(1),
  automation: AutomationSchema,
  passives: z.array(PassiveSchema).default([]),
  activations: z.array(ActivationSchema).default([]),
  resources: z.array(ResourceDefSchema).default([]),
  table: TableSchema.optional(), // a table it rolls on, which `rollTable` names it for, as Wild Magic Surge's
  fromLevel: z.number().int().min(1).max(20).optional(), // the character level it starts working at
  // Dice added to its activations at character levels 5, 11 and 17, as a cantrip's are.
  perTier: ScaleStepSchema.optional(),
  // `step` added once at each of these levels in `class`, as Jolt to Life's lightning at Artificer levels 11 and 17.
  classTiers: z
    .strictObject({
      class: ContentIdSchema,
      at: z.array(z.number().int().min(1).max(20)).min(1),
      step: ScaleStepSchema,
    })
    .optional(),
  // Items it gives as it's gained, as Assassin's Tools' Disguise Kit and Poisoner's Kit (character.ts advanceEvents).
  items: z.array(ContentIdSchema).min(1).optional(),
  // Spells it always gives, from the level in the key: the level of the class that granted it, else the character's.
  spells: z.record(z.string(), z.array(ContentIdSchema)).optional(),
  // Passives it gives only while an effect of these features' activations is on the bearer, as Crown of Spellfire's
  // Spell Avoidance while its Innate Sorcery lasts (stats.ts).
  whileActive: z
    .strictObject({
      features: z.array(ContentIdSchema).min(1),
      passives: z.array(PassiveSchema).min(1),
    })
    .optional(),
  // The ability its `spells` are cast with, as Manipulate Elements' Wisdom for a Monk's Elementalism.
  spellAbility: AbilitySchema.optional(),
  // Its class's spell picks (and swaps) may also come from these classes' lists or these spells, as Magical Secrets'
  // Cleric, Druid and Wizard lists or a 2014 patron's Expanded Spell List; with `cantrips` its cantrip picks too.
  widens: z
    .strictObject({
      lists: z.array(ContentIdSchema).min(1).optional(),
      spells: z.array(ContentIdSchema).min(1).optional(),
      cantrips: z.literal(true).optional(),
    })
    .optional(),
  // Each level 1+ spell of another feature's can be cast without a slot by spending `resource`, as Natural
  // Recovery's free Circle spell once a Long Rest.
  freeCastsFrom: z
    .strictObject({
      feature: ContentIdSchema,
      resource: z.string().min(1),
      perLevel: z.literal(true).optional(), // spending as many as the spell's level, as Psionic Sorcery
      schools: z.array(SpellSchoolSchema).min(1).optional(), // only these, as Mind Magic's Divination spells
    })
    .optional(),
  // Spells it gives once the character has spell slots of the level in the key, as an Arcana Unleashed adept's table.
  spellsBySlot: z.record(z.string(), z.array(ContentIdSchema)).optional(),
  // Spells by slot level, as `spellsBySlot`, given only once this feat is taken too, as a Dragonmark's Spells of the
  // Mark with Potent Dragonmark.
  preparedWith: z
    .strictObject({
      feat: ContentIdSchema,
      spells: z.record(z.string(), z.array(ContentIdSchema)),
      // Its own and these spells are also cast so with that feat, as Potent Dragonmark's extra slot.
      freeCast: z.lazy(() => FreeCastSchema).optional(),
    })
    .optional(),
  // These spells' damage takes this type instead, as Rimekin's Cold Fire Magic.
  retype: z.record(ContentIdSchema, DamageTypeSchema).optional(),
  // These spells' extra damage on a hit rolls this die instead, as Foe Slayer's d10 for Hunter's Mark (stats.ts).
  redice: z.record(ContentIdSchema, DiceSchema).optional(),
  // These spells do these too, with the options their effects name, as Eldritch Hex's Disadvantage on saves of the
  // ability chosen for Hex (stats.ts).
  addsTo: z
    .record(ContentIdSchema, z.array(LeafEffectSchema).min(1))
    .optional(),
  // Each leveled spell in `spells` can also be cast once per Long Rest without a slot, as with Fey Touched, or each
  // as its own entry says, as Drow High Magic's at-will Detect Magic beside its once-a-day spells.
  freeCast: z
    .union([
      z.lazy(() => FreeCastSchema),
      z.record(
        ContentIdSchema,
        z.lazy(() => FreeCastSchema),
      ),
    ])
    .optional(),
  // Spells it casts only by its free cast, never known, as Genie Magic's level 1 Sorcerer spells, picked as cast.
  castsOnly: z.array(ContentIdSchema).min(1).optional(),
  // Its cantrip can be replaced after a Long Rest by one from these class lists, as a High Elf's Prestidigitation
  // (swap.ts).
  swapCantrip: z.array(ContentIdSchema).min(1).optional(),
  // Its damage is added to a hit's, so it takes that hit's damage type, as a Battle Master maneuver's die does.
  hitType: z.literal(true).optional(),
  // Dice its slot-spending activations add for each slot level, as with Eldritch Smite.
  upcast: z.strictObject({ perSlotLevel: ScaleStepSchema }).optional(),
  // What taking it as a class option needs, read from its Prerequisite line: a level in the class choosing it,
  // other features, and a known cantrip that deals damage (by an attack roll for "attack").
  prerequisite: z
    .strictObject({
      level: z.number().int().min(1).max(20).optional(),
      features: z.array(ContentIdSchema).min(1).optional(),
      cantrip: z.enum(["damage", "attack"]).optional(),
    })
    .optional(),
  choices: z.lazy(() => z.array(ChoiceDefSchema)).default([]), // asked when it's taken as a class option
  // Options printed inside the feature, one picked when it's gained (a `variant` choice), as Blessed Strikes' Divine
  // Strike or Potent Spellcasting. The pick's passives, activations and resources join the feature's own.
  variants: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1),
        passives: z.array(PassiveSchema).default([]),
        activations: z.array(ActivationSchema).default([]),
        resources: z.array(ResourceDefSchema).default([]),
        // Spells the pick gives, from the level in the key, as a land's Circle spells, a Vestige's domain or Dread
        // Allegiance's cantrip for each of the Dead Three.
        spells: z.record(z.string(), z.array(ContentIdSchema)).optional(),
        // Labels of the followed feature's activations these take the place of, as Perfected Armor's bigger weapons.
        replaces: z.array(z.string().min(1)).min(1).optional(),
        // Asked once it's picked, as a Thaumaturge's extra Cleric cantrip or a Fighting Style's feat (character.ts).
        choices: z.lazy(() => z.array(ChoiceDefSchema)).optional(),
      }),
    )
    .min(2)
    .optional(),
  // Activations of another feature, by label, it takes the place of while the bearer has it, as Envenom Weapons'
  // Poison for Cunning Strike's.
  overrides: z
    .strictObject({
      feature: ContentIdSchema,
      labels: z.array(z.string().min(1)).min(1),
    })
    .optional(),
  // How many variants it gives when gained, and the levels in the class whose subclass grants it where it gives one
  // more, as Arcane Shot's two options and one more at Fighter levels 7, 10, 15 and 18.
  variantPicks: z
    .strictObject({
      count: z.number().int().min(1),
      more: z.array(z.number().int().min(1).max(20)).default([]),
    })
    .optional(),
  // Its variants follow the pick made for this feature instead of asking, as Improved Blessed Strikes'.
  follows: ContentIdSchema.optional(),
  // The variant picked can be changed outside a fight after a rest, as Hunter's Prey's (swap.ts).
  // With "longRest", only after a Long Rest, as Circle of the Land's land.
  variantSwap: z.enum(["shortRest", "longRest"]).optional(),
  // What it gives the bearer's familiar (combat/familiar.ts): Hit Points added to its maximum when it is found,
  // worked out from the bearer's numbers, and passives and actions of its own.
  familiar: z
    .strictObject({
      hp: FormulaSchema.optional(),
      // its attacks are Reactions its owner commands, as Pact of the Chain's (combat/effects.ts commandFamiliar)
      attacks: z.literal(true).optional(),
      damageTypes: z.array(DamageTypeSchema).min(1).optional(), // to pick for its attacks, as Necrotic or Radiant
      ownerDc: z.literal(true).optional(), // its saves use its owner's spell save DC
      passives: z.array(PassiveSchema).default([]),
      actions: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            activation: ActivationSchema,
          }),
        )
        .default([]),
    })
    .optional(),
  // What it gives its bearer's lasting companions (combat/companions.ts): passives, actions (replacing those it
  // names), a Multiattack of this many, and these damage types to pick for its attacks, as Exceptional Training's
  // Force or Bestial Fury's second Beast's Strike.
  companion: z
    .strictObject({
      passives: z.array(PassiveSchema).default([]),
      actions: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            activation: ActivationSchema,
          }),
        )
        .default([]),
      replaces: z.array(z.string().min(1)).min(1).optional(),
      multiattack: z.number().int().min(2).optional(),
      damageTypes: z.array(DamageTypeSchema).min(1).optional(),
    })
    .optional(),
}).strict();
export type Feature = z.infer<typeof FeatureSchema>;

// A character option a story grants (#192): a supernatural gift, an epic destiny, a survivor talent, a Circle casting
// option or a list of beast shapes. Its text is the book's; what it does is a feature's (stats.ts featureOf).
export const CharacterOptionSchema = GlossaryEntrySchema.extend({
  automation: AutomationSchema.default("text"),
  passives: z.array(PassiveSchema).default([]),
  activations: z.array(ActivationSchema).default([]),
  resources: z.array(ResourceDefSchema).default([]),
  spells: z.record(z.string(), z.array(ContentIdSchema)).optional(),
  freeCast: FeatureSchema.shape.freeCast,
  castsOnly: FeatureSchema.shape.castsOnly, // spells it casts only by its free cast, as a Charm's
  // Options printed inside it, one picked as it's granted, as Resilience's ability.
  variants: FeatureSchema.shape.variants,
  choices: z.lazy(() => z.array(ChoiceDefSchema)).default([]), // asked as it's granted
  beasts: z.array(ContentIdSchema).min(1).optional(), // a list of beast shapes' Beasts
  underwater: z.literal(true).optional(), // the list for a fight underwater, the only place a fight names
}).strict();
export type CharacterOption = z.infer<typeof CharacterOptionSchema>;

export const ChoiceDefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("subclass"), id: z.string() }),
  z.strictObject({
    kind: z.literal("feat"),
    id: z.string(),
    category: z.enum([
      "origin",
      "general",
      "fightingStyle",
      "epicBoon",
      "darkGift",
    ]),
  }),
  z.strictObject({
    kind: z.literal("skills"),
    id: z.string(),
    count: z.number().int().min(1),
    from: z.array(SkillSchema).min(1),
    // Expertise in the skills picked instead of proficiency: in one the character is proficient in ("proficient"), as
    // Skill Expert gives, or in any ("any"), when the same feat makes it proficient in all, as Boon of Skill.
    expertise: z.enum(["proficient", "any"]).optional(),
    // Expertise in a skill picked that the character is already proficient in, else proficiency, as Keen Mind.
    orExpertise: z.literal(true).optional(),
    // Picked again after a Long Rest, as Weapon Master's weapons (swap.ts).
    swap: z.literal("longRest").optional(),
    // added to checks with the skills picked, as Enchanting Conversationalist's Intelligence modifier
    bonus: FormulaSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("weaponMastery"),
    id: z.string(),
    count: z.number().int().min(1),
    melee: z.literal(true).optional(), // only melee weapons, as a Barbarian's
    // Picked again after a Long Rest, as Weapon Master's weapons (swap.ts).
    swap: z.literal("longRest").optional(),
  }),
  // Proficiency with kinds of Simple or Martial weapons picked: only melee or ranged ones (by Ammunition), none with a
  // property in `without`, and these too, as a Kensei's weapons, which with `monk` are Monk weapons for the character.
  z.strictObject({
    kind: z.literal("weapons"),
    id: z.string(),
    count: z.number().int().min(1),
    melee: z.literal(true).optional(),
    ranged: z.literal(true).optional(),
    without: z.array(WeaponPropertySchema).min(1).optional(),
    also: z.array(ContentIdSchema).min(1).optional(),
    monk: z.literal(true).optional(),
  }),
  // Tool proficiencies: from these tools, or with `artisan` any Artisan's Tools, else any tool, and with `skills` one of
  // these skills instead, as Khoravar's Skill Versatility. With `instead` it asks one only for each of those tools the
  // character already has, as Tools of the Trade's other Artisan's Tools.
  z.strictObject({
    kind: z.literal("tools"),
    id: z.string(),
    count: z.number().int().min(1),
    from: z.array(ContentIdSchema).min(1).optional(),
    artisan: z.literal(true).optional(),
    skills: z.array(SkillSchema).min(1).optional(),
    instead: z.array(ContentIdSchema).min(1).optional(),
    // Picked again after a Long Rest, or after any rest, as Whispers of the Dead's (swap.ts).
    swap: z.enum(["longRest", "shortRest"]).optional(),
  }),

  z.strictObject({
    kind: z.literal("spells"),
    id: z.string(),
    count: z.number().int().min(1),
    maxLevel: z.number().int().min(0).max(9),
    list: ContentIdSchema.optional(), // a class whose spell list it is; any spell when absent
    schools: z.array(SpellSchoolSchema).min(1).optional(),
    ritual: z.boolean().optional(), // only spells with the Ritual tag
    freeCast: z.lazy(() => FreeCastSchema).optional(), // each leveled spell picked is also cast without a slot
    minLevel: z.number().int().min(1).max(9).optional(), // no spell below this level, as Signature Spells' level 3
    from: z.array(ContentIdSchema).min(1).optional(), // only these, as a feat's own table
    // The list of the version of this feat the character took, as "the list you chose for Magic Initiate".
    listOf: ContentIdSchema.optional(),
    also: z.array(ContentIdSchema).min(1).optional(), // these too, beside the list, as Boon of Siberys' own table
    // One of the picks can be replaced each time the character gains a level, as Magic Initiate's, or with
    // "shortRest" all of them after any rest, as Pact of the Tome's (swap.ts).
    swap: z.enum(["levelUp", "shortRest"]).optional(),
    // As many picks as the Proficiency Bonus, made between scenes and one more as it rises, as Ritual Caster's
    // (swap.ts). Such a choice and an `ifKnown` one are never asked as the feat is taken, so old saves replay.
    grows: z.literal("proficiency").optional(),
    late: z.literal(true).optional(), // picked between scenes, as a background's feat added after saves were made
    // Picked between scenes, only by a character who knows this spell from elsewhere, as Light Bringer's Cleric
    // cantrip in place of a Light already known.
    ifKnown: ContentIdSchema.optional(),
    lists: z.array(ContentIdSchema).min(1).optional(), // these classes' lists too, as Magical Discoveries'
    cantrips: z.literal(true).optional(), // cantrips too, beside spells up to `maxLevel`
    upToSlots: z.literal(true).optional(), // `maxLevel` is the highest slot the class has at that level
    ability: AbilitySchema.optional(), // the spells' casting ability, as Arcane Archer Lore's Intelligence
    // only spells of the school of the one picked for that choice, as Boon of Magic School Mastery's
    sameSchoolAs: z.string().optional(),
  }),
  // The spellcasting ability of the feat's spells, as Magic Initiate's "Intelligence, Wisdom, or Charisma".
  z.strictObject({
    kind: z.literal("spellAbility"),
    id: z.string(),
    from: z.array(AbilitySchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("option"),
    id: z.string(),
    count: z.number().int().min(1),
    from: z.array(ContentIdSchema).min(1),
    // Picked again after a Long Rest, as Weapon Master's weapons (swap.ts).
    swap: z.literal("longRest").optional(),
  }),
  // One of a feature's own `variants`, asked when a level grants it.
  z.strictObject({
    kind: z.literal("variant"),
    id: z.string(),
    feature: ContentIdSchema,
    count: z.number().int().min(1).default(1),
  }),
]);

export type ChoiceDef = z.infer<typeof ChoiceDefSchema>;
