import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export const AbilitySchema = z.enum(ABILITIES);
export type Ability = z.infer<typeof AbilitySchema>;

export const SKILL_ABILITIES = {
  acrobatics: "dex",
  animalHandling: "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  sleightOfHand: "dex",
  stealth: "dex",
  survival: "wis",
} as const satisfies Record<string, Ability>;
export type Skill = keyof typeof SKILL_ABILITIES;

const SKILLS = Object.keys(SKILL_ABILITIES) as [Skill, ...Skill[]];
export const SkillSchema = z.enum(SKILLS);

export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export const DamageTypeSchema = z.enum(DAMAGE_TYPES);
export type DamageType = z.infer<typeof DamageTypeSchema>;

export const ConditionSchema = z.enum([
  "blinded",
  "charmed",
  "deafened",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
]);

export const AutomationSchema = z.enum(["full", "partial", "text"]);

export const DiceSchema = z
  .string()
  .regex(/^[1-9][0-9]*d[1-9][0-9]*$/, "must look like 2d6");

const FormulaTermSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("abilityMod"), ability: AbilitySchema }),
  z.strictObject({ kind: z.literal("proficiency") }),
  z.strictObject({ kind: z.literal("classLevel"), class: ContentIdSchema }),
  z.strictObject({ kind: z.literal("scaling"), key: z.string() }),
  z.strictObject({ kind: z.literal("spellMod") }),
  z.strictObject({ kind: z.literal("spellSaveDc") }),
]);

export const FormulaSchema = z.strictObject({
  base: z.number().int().default(0),
  add: z.array(FormulaTermSchema).default([]),
  min: z.number().int().optional(),
});
export type Formula = z.infer<typeof FormulaSchema>;

export const AmountSchema = z.strictObject({
  dice: DiceSchema.optional(),
  bonus: FormulaSchema.optional(),
});
export type Amount = z.infer<typeof AmountSchema>;

export const DamageSchema = z.strictObject({
  amount: AmountSchema,
  type: DamageTypeSchema,
});
export type Damage = z.infer<typeof DamageSchema>;

const RollTargetSchema = z.enum(["attacks", "saves", "checks"]);

export const ModifierSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("bonus"),
    to: z.enum(["ac", "attacks", "saves", "checks"]),
    amount: AmountSchema,
  }),
  z.strictObject({ kind: z.literal("advantage"), on: RollTargetSchema }),
  z.strictObject({ kind: z.literal("disadvantage"), on: RollTargetSchema }),
  z.strictObject({ kind: z.literal("resistance"), damage: DamageTypeSchema }),
  z.strictObject({
    kind: z.literal("vulnerability"),
    damage: DamageTypeSchema,
  }),
  z.strictObject({ kind: z.literal("immunity"), damage: DamageTypeSchema }),
  z.strictObject({ kind: z.literal("acFormula"), formula: FormulaSchema }),
]);
export type Modifier = z.infer<typeof ModifierSchema>;

export const DurationSchema = z.union([
  z.literal("instantaneous"),
  z.strictObject({ concentration: z.literal(true), minutes: z.number() }),
  z.strictObject({ until: z.literal("yourNextTurnStart") }),
  z.strictObject({ minutes: z.number() }),
]);
export type Duration = z.infer<typeof DurationSchema>;

export const LeafEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("heal"), amount: AmountSchema }),
  z.strictObject({ kind: z.literal("tempHp"), amount: AmountSchema }),
  z.strictObject({
    kind: z.literal("applyCondition"),
    condition: ConditionSchema,
    duration: DurationSchema,
  }),
  z.strictObject({
    kind: z.literal("removeCondition"),
    condition: ConditionSchema,
  }),
  z.strictObject({
    kind: z.literal("modifier"),
    modifier: ModifierSchema,
    duration: DurationSchema,
  }),
  z.strictObject({
    kind: z.literal("forcedMove"),
    feet: z.number(),
    direction: z.enum(["away", "toward"]),
  }),
  z.strictObject({ kind: z.literal("note"), text: z.string() }),
]);
export type LeafEffect = z.infer<typeof LeafEffectSchema>;

const LeafEffectsSchema = z.array(LeafEffectSchema).default([]);

// Nesting stops at one level on purpose: a small model can only produce non-recursive output reliably.
export const ResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("automatic"),
    damage: z.array(DamageSchema).default([]),
    effects: LeafEffectsSchema,
  }),
  z.strictObject({
    kind: z.literal("attack"),
    attack: z.strictObject({
      type: z.enum(["weapon", "spell"]),
      ability: AbilitySchema.optional(),
      flatBonus: z.number().int().optional(),
    }),
    damage: z.array(DamageSchema).min(1),
    onHit: LeafEffectsSchema,
    onMiss: LeafEffectsSchema,
  }),
  z.strictObject({
    kind: z.literal("save"),
    ability: AbilitySchema,
    dc: FormulaSchema,
    damage: z.array(DamageSchema).default([]),
    onSuccessDamage: z.enum(["half", "none"]).default("none"),
    onFail: LeafEffectsSchema,
    onSuccess: LeafEffectsSchema,
  }),
]);
export type Resolution = z.infer<typeof ResolutionSchema>;

const CostSchema = z.union([
  z.enum(["action", "bonusAction", "reaction", "slot"]),
  z.strictObject({ resource: z.string() }),
]);
export type Cost = z.infer<typeof CostSchema>;

const SideSchema = z.enum(["enemy", "ally"]);
const RangeSchema = z.union([z.number(), z.enum(["self", "touch"])]);

export const TargetingSchema = z.union([
  z.strictObject({ self: z.literal(true) }),
  z.strictObject({
    creatures: z.number().int().min(1),
    range: RangeSchema,
    side: SideSchema,
  }),
  z.strictObject({
    area: z.strictObject({
      shape: z.enum(["sphere", "cone", "cube", "line", "emanation"]),
      radius: z.number(),
    }),
    range: RangeSchema,
    side: SideSchema,
  }),
]);
export type Targeting = z.infer<typeof TargetingSchema>;

export const ActivationSchema = z.strictObject({
  cost: z.array(CostSchema),
  trigger: z
    .strictObject({
      hitByAttack: z.literal(true),
      targetedBySpell: z.string().optional(),
    })
    .optional(),
  targeting: TargetingSchema,
  resolution: ResolutionSchema,
});
export type Activation = z.infer<typeof ActivationSchema>;

export const PassiveSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("modifier"), modifier: ModifierSchema }),
  z.strictObject({
    kind: z.literal("extraDamage"),
    dice: DiceSchema,
    // shortcut: "ally" means any living ally, since there are no positions until the grid in step 6.
    when: z.enum(["advantage", "advantageOrAlly"]),
    oncePerTurn: z.boolean().default(false),
  }),
]);
export type Passive = z.infer<typeof PassiveSchema>;

export const ResourceDefSchema = z.strictObject({
  id: z.string().min(1),
  max: FormulaSchema,
  recharge: z.array(
    z.strictObject({
      on: z.enum(["turnStart", "shortRest", "longRest", "dawn"]),
      amount: z.union([z.literal("all"), z.number().int()]),
      rollAtLeast: z.number().int().optional(),
    }),
  ),
});

export const FeatureSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  text: z.string().min(1),
  automation: AutomationSchema,
  passives: z.array(PassiveSchema).default([]),
  activations: z.array(ActivationSchema).default([]),
  resources: z.array(ResourceDefSchema).default([]),
}).strict();
export type Feature = z.infer<typeof FeatureSchema>;

export const ChoiceDefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("subclass"), id: z.string() }),
  z.strictObject({
    kind: z.literal("feat"),
    id: z.string(),
    category: z.enum(["origin", "general", "fightingStyle", "epicBoon"]),
  }),
  z.strictObject({
    kind: z.literal("skills"),
    id: z.string(),
    count: z.number().int().min(1),
    from: z.array(SkillSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("weaponMastery"),
    id: z.string(),
    count: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal("spells"),
    id: z.string(),
    count: z.number().int().min(1),
    maxLevel: z.number().int().min(0).max(9),
    list: ContentIdSchema,
  }),
  z.strictObject({
    kind: z.literal("option"),
    id: z.string(),
    count: z.number().int().min(1),
    from: z.array(ContentIdSchema).min(1),
  }),
]);

const ClassLevelSchema = z.strictObject({
  level: z.number().int().min(1).max(20),
  grants: z.array(ContentIdSchema).default([]),
  choices: z.array(ChoiceDefSchema).default([]),
  slots: z.array(z.number().int().min(0)).default([]), // index 0 holds level 1 slots
  scaling: z.record(z.string(), z.number()).default({}),
});

export const ClassSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  hitDie: z.enum(["d6", "d8", "d10", "d12"]),
  primaryAbilities: z.array(AbilitySchema).min(1),
  savingThrows: z.array(AbilitySchema),
  weapons: z.array(z.enum(["simple", "martial"])),
  armor: z.array(z.enum(["light", "medium", "heavy", "shield"])),
  spellcasting: z.strictObject({ ability: AbilitySchema }).optional(),
  // shortcut: fewer than 20 levels are allowed while content is being added, require 20 once step 5 is done.
  levels: z.array(ClassLevelSchema).min(1),
}).strict();
export type ClassDef = z.infer<typeof ClassSchema>;

export const SpeciesSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  text: z.string().min(1),
  creatureType: z.string().min(1),
  size: z.enum(["tiny", "small", "medium", "large"]),
  speed: z.number().int(),
  traits: z.array(ContentIdSchema).default([]),
}).strict();
export type Species = z.infer<typeof SpeciesSchema>;

export const BackgroundSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  abilities: z.array(AbilitySchema).length(3),
  feat: ContentIdSchema,
  skills: z.array(SkillSchema).length(2),
  tool: z.string().min(1),
}).strict();
export type Background = z.infer<typeof BackgroundSchema>;

export const FeatSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  category: z.enum(["origin", "general", "fightingStyle", "epicBoon"]),
  text: z.string().min(1),
  grants: z.array(ContentIdSchema).default([]),
}).strict();
export type Feat = z.infer<typeof FeatSchema>;

export const SpellSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  level: z.number().int().min(0).max(9),
  school: z.enum([
    "abjuration",
    "conjuration",
    "divination",
    "enchantment",
    "evocation",
    "illusion",
    "necromancy",
    "transmutation",
  ]),
  classes: z.array(ContentIdSchema),
  castingTime: z.string().min(1),
  ritual: z.boolean().default(false),
  range: z.string().min(1),
  components: z.string().min(1),
  duration: DurationSchema,
  text: z.string().min(1),
  automation: AutomationSchema,
  activation: ActivationSchema.optional(),
  upcast: z
    .strictObject({
      perSlotLevel: z.union([
        z.strictObject({ addDice: DiceSchema }),
        z.strictObject({ addTargets: z.number().int().min(1) }),
      ]),
    })
    .optional(),
}).strict();
export type Spell = z.infer<typeof SpellSchema>;

const ItemBaseSchema = ContentEntrySchema.extend({ name: z.string().min(1) });

export const WeaponSchema = ItemBaseSchema.extend({
  type: z.literal("weapon"),
  category: z.enum(["simple", "martial"]),
  damage: z.strictObject({ dice: DiceSchema, type: DamageTypeSchema }),
  properties: z
    .array(
      z.enum([
        "ammunition",
        "finesse",
        "heavy",
        "light",
        "loading",
        "range",
        "reach",
        "thrown",
        "twoHanded",
        "versatile",
      ]),
    )
    .default([]),
  mastery: z.enum([
    "cleave",
    "graze",
    "nick",
    "push",
    "sap",
    "slow",
    "topple",
    "vex",
  ]),
}).strict();
export type Weapon = z.infer<typeof WeaponSchema>;

export const ArmorSchema = ItemBaseSchema.extend({
  type: z.literal("armor"),
  armorType: z.enum(["light", "medium", "heavy"]),
  base: z.number().int(),
  addDex: z.boolean(),
  maxDex: z.number().int().optional(),
}).strict();
export type Armor = z.infer<typeof ArmorSchema>;

const ShieldItemSchema = ItemBaseSchema.extend({
  type: z.literal("shield"),
  bonus: z.number().int(),
}).strict();

const GearSchema = ItemBaseSchema.extend({
  type: z.literal("gear"),
  text: z.string().optional(),
}).strict();

export const ItemSchema = z.discriminatedUnion("type", [
  WeaponSchema,
  ArmorSchema,
  ShieldItemSchema,
  GearSchema,
]);
export type Item = z.infer<typeof ItemSchema>;

const AbilityScoresSchema = z.strictObject({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});
export type AbilityScores = z.infer<typeof AbilityScoresSchema>;

export const MonsterSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  ac: z.number().int(),
  hp: z.number().int().min(1),
  speed: z.number().int(),
  abilities: AbilityScoresSchema,
  proficiency: z.number().int(),
  saves: z.array(AbilitySchema).default([]),
  initiative: z.number().int(),
  features: z.array(ContentIdSchema).default([]),
  passives: z.array(PassiveSchema).default([]),
  multiattack: z.number().int().min(1).default(1),
  actions: z
    .array(
      z.strictObject({ name: z.string().min(1), activation: ActivationSchema }),
    )
    .min(1),
}).strict();
export type Monster = z.infer<typeof MonsterSchema>;

const ChoiceAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("skills"), values: z.array(SkillSchema) }),
  z.strictObject({
    kind: z.literal("spells"),
    values: z.array(ContentIdSchema),
  }),
  z.strictObject({
    kind: z.literal("features"),
    values: z.array(ContentIdSchema),
  }),
  z.strictObject({
    kind: z.literal("weaponMastery"),
    values: z.array(ContentIdSchema),
  }),
]);

export const CharacterBuildSchema = z.strictObject({
  baseAbilities: AbilityScoresSchema,
  speciesId: ContentIdSchema,
  backgroundId: ContentIdSchema,
  backgroundIncrease: z.partialRecord(
    AbilitySchema,
    z.number().int().min(1).max(2),
  ),
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
  name: z.string().min(1),
  build: CharacterBuildSchema,
  equipment: z.array(ContentIdSchema),
}).strict();
export type Pregen = z.infer<typeof PregenSchema>;

export const EncounterSchema = z.strictObject({
  id: z.string().min(1),
  monsters: z
    .array(
      z.strictObject({
        monster: ContentIdSchema,
        count: z.number().int().min(1).default(1),
      }),
    )
    .min(1),
});

export const CheckSchema = z.union([
  z.strictObject({ skill: SkillSchema, dc: z.number().int() }),
  z.strictObject({ ability: AbilitySchema, dc: z.number().int() }),
]);
export type Check = z.infer<typeof CheckSchema>;
