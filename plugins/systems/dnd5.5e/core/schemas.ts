import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export const AbilitySchema = z.enum(ABILITIES);
export type Ability = z.infer<typeof AbilitySchema>;
export const ABILITY_NAMES = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
} as const satisfies Record<Ability, string>;

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

export const ALL_SKILLS = Object.keys(SKILL_ABILITIES) as [Skill, ...Skill[]];
const SKILLS = ALL_SKILLS;
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

// The creature types, lowercase, each a monster-manual creature-type entity (#187).
export const CREATURE_TYPES = [
  "aberration",
  "beast",
  "celestial",
  "construct",
  "dragon",
  "elemental",
  "fey",
  "fiend",
  "giant",
  "humanoid",
  "monstrosity",
  "ooze",
  "plant",
  "undead",
] as const;
const isCreatureType = (type: string) =>
  (CREATURE_TYPES as readonly string[]).includes(type);
// Checked against the list, though read as a string, so code may compare it with any stats' type.
const CreatureTypeSchema = z
  .string()
  .refine(isCreatureType, "must be a lowercase creature type");
// A book may print it capitalized ("Humanoid"), and stats read it lowercase.
const PrintedCreatureTypeSchema = z
  .string()
  .refine(
    (type) => isCreatureType(type.toLowerCase()),
    "must be a creature type",
  );
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
export type Condition = z.infer<typeof ConditionSchema>;

export const AutomationSchema = z.enum(["full", "partial", "text"]);

export const WeaponPropertySchema = z.enum([
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
]);

export const WeaponMasterySchema = z.enum([
  "cleave",
  "graze",
  "nick",
  "push",
  "sap",
  "slow",
  "topple",
  "vex",
]);
export type WeaponMastery = z.infer<typeof WeaponMasterySchema>;

// The rules glossary (#132): terms, conditions, actions and the rest, each text a book prints. Keyed by
// content folder, with the id kinds coverage files name.
export const GLOSSARY_KINDS = {
  "rule-terms": "rule-term",
  conditions: "condition",
  actions: "action",
  senses: "sense",
  skills: "skill",
  "creature-types": "creature-type",
  "areas-of-effect": "area-of-effect",
  "weapon-properties": "weapon-property",
  "weapon-masteries": "weapon-mastery",
  attitudes: "attitude",
} as const;

export const GlossaryEntrySchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  source: z.string().min(1), // the book's title
  // shortcut: optional, since the imported library has no printed page numbers. Require it once it does (#181).
  page: z.number().int().positive().optional(),
  text: z.string(),
}).strict();

// Monster families and lairs (#133), text kinds like the glossary's, keyed by content folder.
export const MONSTER_TEXT_KINDS = {
  "monster-families": "monster-family",
  lairs: "lair",
} as const;

// Kinds for what a book describes beside its rules (#134–#136), each entry the glossary's shape: content folder ->
// id kind. Environmental effects, diseases and dungeon features play (#191, their schemas below); curses stay text.
export const ENVIRONMENT_KINDS = {
  "environmental-effects": "environmental-effect",
  diseases: "disease",
  curses: "curse",
  "dungeon-features": "dungeon-feature",
} as const;
export const DOWNTIME_KINDS = {
  "downtime-activities": "downtime-activity",
  lifestyles: "lifestyle",
  services: "service",
  "renown-tracks": "renown-track",
  "group-patrons": "group-patron",
  "marks-of-prestige": "mark-of-prestige",
  "bastion-orders": "bastion-order",
  "vehicle-upgrades": "vehicle-upgrade",
} as const;
// A variant rule is a switch a run could turn on; here it is only its text.
export const OPTION_KINDS = {
  "supernatural-gifts": "supernatural-gift",
  "epic-destinies": "epic-destiny",
  "survivor-talents": "survivor-talent",
  "circle-casting-options": "circle-casting-option",
  "beast-shape-lists": "beast-shape-list",
  "variant-rules": "variant-rule",
} as const;

// A family heading (Bandits, Black Dragons): the stat blocks and families it holds or, for a group, lists.
export const MonsterFamilySchema = GlossaryEntrySchema.extend({
  members: z.array(ContentIdSchema).default([]),
}).strict();

// A monster's lair: its regional effects as printed, and whose lair it is. A 2024 stat block prints its
// in-Lair numbers itself, so play reads nothing here.
export const LairSchema = GlossaryEntrySchema.extend({
  owners: z.array(ContentIdSchema).default([]),
}).strict();

// An engine value as the name in its entity's id: "twoHanded" is weapon-property/two-handed.
export const glossaryName = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const DiceSchema = z
  .string()
  .regex(/^[1-9][0-9]*d[1-9][0-9]*$/, "must look like 2d6");

const FormulaTermSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("abilityMod"), ability: AbilitySchema }),
  z.strictObject({ kind: z.literal("proficiency") }),
  z.strictObject({
    kind: z.literal("classLevel"),
    class: ContentIdSchema,
    half: z.boolean().optional(), // rounded down, as for Rally
    roundUp: z.literal(true).optional(), // with `half`, rounded up instead, as for Arcane Recovery
    times: z.number().int().min(2).optional(), // multiplied, as Lay On Hands' five times the Paladin level
  }),
  // character level, halved and rounded down with `half`, as for an item that can't name the class of a book it
  // doesn't require
  z.strictObject({
    kind: z.literal("level"),
    half: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal("scaling"), key: z.string() }),
  // The best of these abilities' modifiers, as "the score increased by this feat" when the feat raised one of them.
  z.strictObject({
    kind: z.literal("bestAbilityMod"),
    abilities: z.array(AbilitySchema).min(1),
  }),
  // With `ability`, the one a feat's spells use instead of the character's (stats.ts castWith).
  z.strictObject({
    kind: z.literal("spellMod"),
    ability: AbilitySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("spellSaveDc"),
    ability: AbilitySchema.optional(),
  }),
  // The best of these ability scores themselves, as Overwhelming Strike's damage.
  z.strictObject({
    kind: z.literal("abilityScore"),
    abilities: z.array(AbilitySchema).min(1),
  }),
  // The Hit Point maximum, halved and rounded down with `half`, as Boon of Recovery's Last Stand.
  z.strictObject({
    kind: z.literal("maxHp"),
    half: z.literal(true).optional(),
  }),
  // The damage that set a reaction off, as Rebuke the Violent's (combat/reactions.ts takeReaction); 0 anywhere else.
  z.strictObject({ kind: z.literal("dealt") }),
  // The level of the slot the spell is cast with, as Blessed Healer's 2 plus the slot's level (combat/school.ts
  // castRiders); 0 anywhere else.
  z.strictObject({ kind: z.literal("slotLevel") }),
]);

export const FormulaSchema = z.strictObject({
  base: z.number().int().default(0),
  add: z.array(FormulaTermSchema).default([]),
  min: z.number().int().optional(),
});
export type Formula = z.infer<typeof FormulaSchema>;

export const AmountSchema = z.strictObject({
  dice: DiceSchema.optional(),
  diceCount: z.string().optional(), // a scaling key holding the number of dice, such as sneakAttackD6
  dieSize: z.string().optional(), // a scaling key holding the die size, such as martialArtsDie
  // a scaling key holding a die size used where it's bigger, as a Monk weapon's Martial Arts die
  dieAtLeast: z.string().optional(),
  bonus: FormulaSchema.optional(),
  reroll: z.number().int().min(1).optional(), // dice rolled again once when below average, as with Empowered Spell
  rerollOnes: z.literal(true).optional(), // a die that rolls 1 is rolled again and the new roll stands
  halfDice: z.literal(true).optional(), // half the dice, rounded up, as Wails from the Grave's half the Sneak Attack
  highest: z.literal(true).optional(), // the dice count their highest numbers, as Overchannel's maximum damage
  // a die showing its highest face adds another die, at most this many more, as Sorcerous Burst's 8s up to the
  // spellcasting modifier
  explode: FormulaSchema.optional(),
});
export type Amount = z.infer<typeof AmountSchema>;

const SizeSchema = z.enum([
  "tiny",
  "small",
  "medium",
  "large",
  "huge",
  "gargantuan",
]);

// Read where a resolution's damage is rolled (combat/effects.ts, combat/attack.ts): `types` deals the one of them the
// target resists least, as Chromatic Orb's chosen orb; `hurtDie` is the die size against a target missing Hit
// Points, as Toll the Dead's d12; `vs` adds dice against creatures of these lowercase types, as Divine Smite's
// against a Fiend or an Undead, which a higher slot leaves alone.
export const DamageSchema = z.strictObject({
  amount: AmountSchema,
  type: DamageTypeSchema,
  types: z.array(DamageTypeSchema).min(2).optional(),
  hurtDie: z.number().int().min(2).optional(),
  vs: z
    .strictObject({
      creatureTypes: z.array(z.string()).min(1),
      dice: DiceSchema,
    })
    .optional(),
  // creatures of these types take none of it, as Hurl Through Hell's Psychic damage spares a Fiend
  except: z.array(z.string()).min(1).optional(),
  // only creatures of these types take it, as a Holy Avenger's Radiant against a Fiend or an Undead
  only: z.array(z.string()).min(1).optional(),
  // The type is the one of these a die of it rolled, by the die's face (the first for a 1), picked from its dice as
  // the one the target resists least, and the hit's other damage takes it too, as Chaos Bolt's d8s (combat/attack.ts).
  rolledTypes: z.array(DamageTypeSchema).min(2).optional(),
  // the attacker gains as many Temporary Hit Points as it deals, as an Executioner's Axe's extra damage
  tempHp: z.literal(true).optional(),
  // only a creature in a shape not its own, changed by its own trait or by magic, takes it, as a Silvered Weapon's die
  shapeShifted: z.literal(true).optional(),
});
export type Damage = z.infer<typeof DamageSchema>;

// How a spell changes the weapon attacks it makes or lasts on (combat/weapon-spell.ts): only these weapons (by id,
// or the plain weapon of a magic one) or ranged ones, made with the spellcasting ability, with `dice` in place of
// the weapon's own (one for each tier from character level 1, 5, 11 and 17, the last listed standing), dealing
// `type` in place of the weapon's own, and `extra` damage of `perTier` dice for each tier reached past the first.
export const WeaponChangeSchema = z.strictObject({
  weapons: z.array(ContentIdSchema).min(1).optional(),
  ranged: z.literal(true).optional(), // only a weapon that fires ammunition, as Swift Quiver's
  spellAbility: z.literal(true).optional(),
  dice: z.array(DiceSchema).min(1).optional(),
  type: DamageTypeSchema.optional(),
  extra: z
    .strictObject({ type: DamageTypeSchema, perTier: DiceSchema })
    .optional(),
});
export type WeaponChange = z.infer<typeof WeaponChangeSchema>;

// What a scene check acts on, so a spell, item or tool that deals with it can help (core/explore.ts): a lock to pick,
// something stuck or barred to force, a wall or barricade to get through, a climb, water to swim or cross, a gap to
// leap or balance over, a trap to disarm, something heavy to lift or shove, and a chase to get away from; and, read
// from a check's skill, swaying someone (Persuasion, Deception, Intimidation, Performance: "influence"), seeing through
// a lie (Insight: "truth"), dealing with an animal (Animal Handling: "beast"), finding what's hidden (Perception,
// Investigation: "hidden"), knowing about something (Arcana, History, Nature, Religion: "lore") and finding the way
// (Survival: "way").
export const ObstacleSchema = z.enum([
  "lock",
  "stuck",
  "wall",
  "climb",
  "water",
  "gap",
  "trap",
  "heavy",
  "chase",
  "influence",
  "truth",
  "beast",
  "hidden",
  "lore",
  "way",
]);
export type Obstacle = z.infer<typeof ObstacleSchema>;

// The weather an environmental effect is, which magic that changes the weather calms (environment.ts).
export const WeatherSchema = z.enum(["cold", "heat", "rain", "wind"]);

// "attacksAgainst" sits on the creature being attacked, as with Faerie Fire or Blur.
const RollFlagSchema = z.enum(["attacks", "saves", "checks", "attacksAgainst"]);

export const ModifierSchema = z.discriminatedUnion("kind", [
  // "once" ends the effect after the next attack roll it adds to, as with Bardic Inspiration.
  z.strictObject({
    kind: z.literal("bonus"),
    to: z.enum([
      "ac",
      "attacks",
      "saves",
      "checks",
      "speed",
      "initiative",
      "maxHp",
      "attacksAgainst", // an attacker's roll against the bearer, as Blade Ward's -1d4 with `subtract`
      "spellDc", // the bearer's spell save DC, as Innate Sorcery's +1 (stats.ts)
    ]),
    amount: AmountSchema,
    once: z.boolean().optional(),
    subtract: z.boolean().optional(), // taken off attack rolls, saves or checks instead, as with Bane
    skill: SkillSchema.optional(), // only checks with this skill, as Pass without Trace's Stealth
    // only checks with this tool, as a Mark's die on its Herbalism Kit, or "artisan" with any Artisan's Tools
    tool: z.union([ContentIdSchema, z.literal("artisan")]).optional(),
    ability: AbilitySchema.optional(), // only saves with this ability, as Slow's Dexterity saves
    melee: z.literal(true).optional(), // AC against melee attack rolls only, as a pirate admiral's Defensive Stance
    ranged: z.literal(true).optional(), // AC against ranged attack rolls only, as an Arrow-Catching Shield's
    weapon: z.literal(true).optional(), // weapon attack rolls only, as Magic Weapon's
    // A Speed bonus that also goes to these Speeds the bearer has, as Superior Mobility's (core/movement-modes.ts).
    modes: z
      .array(z.enum(["fly", "climb", "burrow", "swim"]))
      .min(1)
      .optional(),
    // AC only while the bearer wears armor ("any"), or Heavy armor, as the Defense feat's or Soul of the Forge's
    armor: z.enum(["any", "heavy"]).optional(),
    concentration: z.literal(true).optional(), // saves to keep Concentration only, as Bladesong's Focus
  }),
  // "once" ends the effect after the next attack roll it applies to, as with Guiding Bolt.
  // "ability" limits it to rolls with that ability, as with Strength-based D20 Tests.
  z.strictObject({
    kind: z.literal("advantage"),
    on: RollFlagSchema,
    once: z.boolean().optional(),
    ability: AbilitySchema.optional(),
    // only on saves to avoid or end these conditions, as a sivis scribe's Words of Reason
    conditions: z.array(ConditionSchema).min(1).optional(),
    magical: z.literal(true).optional(), // only on saves against spells and magic, as Circle of Power
    // attacksAgainst only for the effect's caster, as Lords' Alliance Agent's Reassert Honor.
    casterOnly: z.literal(true).optional(),
    skills: z.array(SkillSchema).min(1).optional(), // only checks with these skills, as Remarkable Athlete's Athletics
    spellAttacks: z.literal(true).optional(), // attacks only spell attacks, as Innate Sorcery's (combat/attack.ts)
    halfMove: z.literal(true).optional(), // only once it has moved no more than half its Speed this turn, as Steady Eye
    // checks only with a creature a scene check names (CheckSchema `with`) of these types, of this kin or of this
    // Challenge Rating or lower, as a Belt of Dwarvenkind's Persuasion with dwarves (core/explore.ts)
    with: z
      .strictObject({
        creatureTypes: z.array(CreatureTypeSchema).min(1).optional(),
        kin: z.array(z.string().min(1)).min(1).optional(),
        maxCr: z.number().min(0).optional(),
      })
      .optional(),
  }),
  // "attackers" limits attacksAgainst to creatures of these lowercase types, as with Protection from Evil and Good.
  z.strictObject({
    kind: z.literal("disadvantage"),
    on: RollFlagSchema,
    once: z.boolean().optional(),
    ability: AbilitySchema.optional(),
    attackers: z.array(z.string()).min(1).optional(),
    skills: z.array(SkillSchema).min(1).optional(), // only checks with these skills
    spells: z.literal(true).optional(), // attacksAgainst only from spells, as a Spellguard Shield's
    except: AbilitySchema.optional(), // saves with any ability but this one, as Power Word Pain's
    casterOnly: z.literal(true).optional(), // attacks only against the effect's caster, as Bestow Curse's
    // attacks only with a ranged weapon, as a strong wind's, or only spell attacks, as a dampened magic zone's
    ranged: z.literal(true).optional(),
    spellAttacks: z.literal(true).optional(),
    weapon: z.literal(true).optional(), // weapon attack rolls only, as Frostbite's
    concentration: z.literal(true).optional(), // saves only to keep Concentration, as an eerie chanting zone's
    // saves only against a spell of the effect's caster, as Eldritch Strike's (combat/effects.ts rollSave)
    casterSpells: z.literal(true).optional(),
    opportunity: z.literal(true).optional(), // attacksAgainst only Opportunity Attacks, as Escape the Horde
  }),
  z.strictObject({ kind: z.literal("resistance"), damage: DamageTypeSchema }),
  z.strictObject({
    kind: z.literal("vulnerability"),
    damage: DamageTypeSchema,
  }),
  z.strictObject({ kind: z.literal("immunity"), damage: DamageTypeSchema }),
  // A creature within 5 feet that hits the bearer with a melee attack takes this, as Flames of Phlegethos' flames, Fire
  // Shield or a black pudding's Corrosive Form, and with `grapple` is Grappled by the bearer, as by a mimic's Adhesive.
  // shortcut: the grapple's escape DC is the bearer's Unarmed Strike one (combat/grapple.ts), not a printed number.
  // With `within`, any attack's hit from that near sets it off, as Shadow of Moil's shadows at 10 feet.
  // `anyAttack` answers any attack's hit, from anywhere, as Scornful Rebuke; `marked` only an attacker under the
  // bearer's effect from these, as Shadowmoor Hexer's Hex; `oncePerTurn` once a turn for each attacker; `able` only
  // while the bearer isn't Incapacitated; `halfDealt` adds half the damage the hit dealt, as Emissary of Redemption.
  z.strictObject({
    kind: z.literal("retaliate"),
    damage: z.array(DamageSchema).default([]),
    grapple: z.literal(true).optional(),
    within: z.number().int().min(5).optional(),
    anyAttack: z.literal(true).optional(),
    marked: z.array(ContentIdSchema).min(1).optional(),
    oncePerTurn: z.literal(true).optional(),
    able: z.literal(true).optional(),
    halfDealt: DamageTypeSchema.optional(),
  }),
  // A creature of the bearer's foes takes this the first time on a turn its walk comes within 5 feet of it, the type
  // it resists least of `types`, as Elemental Epitome's Destructive Stride (combat/movement.ts).
  z.strictObject({
    kind: z.literal("strideDamage"),
    damage: AmountSchema,
    types: z.array(DamageTypeSchema).min(1),
  }),
  // The spell's `spheres` actions are the bearer's while it lasts.
  z.strictObject({ kind: z.literal("spheres") }),
  // A spell stolen by Spell Thief: the bearer has it prepared ("stolen") or its caster can't cast it ("lost").
  z.strictObject({
    kind: z.literal("stolenSpell"),
    spell: ContentIdSchema,
    lost: z.literal(true).optional(),
  }),
  // Can't gain this condition while it lasts, as Lordly Resolve's bolstered targets.
  z.strictObject({
    kind: z.literal("conditionImmunity"),
    condition: ConditionSchema,
  }),
  // `unarmored` only while the bearer wears no armor, and `noShield` only while it holds no Shield, as Unarmored
  // Defense's.
  z.strictObject({
    kind: z.literal("acFormula"),
    formula: FormulaSchema,
    unarmored: z.literal(true).optional(),
    noShield: z.literal(true).optional(),
  }),
  // Expertise in these skills while it lasts, where the bearer is proficient, as Skill Empowerment's.
  z.strictObject({
    kind: z.literal("expertise"),
    skills: z.array(SkillSchema).min(1).optional(), // set by the cast's `pick`
  }),
  // A check's d20 roll below `value` counts as `value`, as Reliable Talent's 10 on a check it's proficient in or
  // Glibness's 15 on Charisma checks. `ability` and `skills` limit which checks.
  z.strictObject({
    kind: z.literal("checkFloor"),
    value: z.number().int().min(2).max(20),
    ability: AbilitySchema.optional(),
    skills: z.array(SkillSchema).min(1).optional(),
    proficient: z.literal(true).optional(),
    all: z.literal(true).optional(), // every D20 Test: attack rolls and saves too, as Trance of Order's 10
    concentration: z.literal(true).optional(), // saves to keep Concentration too, as Starry Form's Dragon
  }),
  // Attack rolls against the bearer can't have Advantage, with `able` only while it isn't Incapacitated, as Elusive.
  z.strictObject({
    kind: z.literal("noAdvantageAgainst"),
    able: z.literal(true).optional(),
    within: z.number().int().min(5).optional(), // only from attackers this near, as Wildhunt's 30 feet
  }),
  // The first creature to hit the bearer on a turn saves with `ability` against the bearer's spell save DC or
  // misses, as Unbreakable Majesty; with `before`, it saves as it attacks, and on a failure the attack is lost, and
  // on a success it has Disadvantage on saves against the bearer's spells until the bearer's next turn ends.
  z.strictObject({
    kind: z.literal("majesty"),
    ability: AbilitySchema.default("cha"),
    before: z.literal(true).optional(),
  }),
  // Seeing creatures that have the Invisible condition as if they were visible, as See Invisibility does.
  z.strictObject({ kind: z.literal("seeInvisible") }),
  // A scene check about one of these goes better (core/explore.ts): it succeeds without a roll, as a door Knock opened,
  // or rolls with Advantage, as a climb with a Rope of Climbing. `once` is spent on the check it helps.
  // `chance` is the percent it works, rolled on the check, and an item with `spends` is gone once it has, as a
  // Mystery Key's.
  z.strictObject({
    kind: z.literal("sceneAid"),
    about: z.array(ObstacleSchema).min(1),
    aid: z.enum(["success", "advantage"]),
    once: z.literal(true).optional(),
    chance: z.number().int().min(1).max(99).optional(),
    spends: z.literal(true).optional(),
  }),
  // Environmental effects of these kinds of weather don't touch the party while it lasts, as Control Weather calms a
  // storm or a heat wave (environment.ts).
  z.strictObject({
    kind: z.literal("weather"),
    ends: z.array(WeatherSchema).min(1),
  }),
  // Carries this many pounds of the bearer's gear for it, weightless, as a Bag of Holding or a Floating Disk (carry.ts).
  z.strictObject({ kind: z.literal("holds"), pounds: z.number().int().min(1) }),
  // Drinkable water for the party while it lasts, against an exposure that spares those with water (environment.ts).
  z.strictObject({ kind: z.literal("water") }),
  // Damage at the start or end of the bearer's turn, such as Moonbeam or Searing Smite.
  z.strictObject({
    kind: z.literal("lingeringDamage"),
    when: z.enum(["turnStart", "turnEnd"]),
    damage: z.array(DamageSchema).min(1),
    near: z.number().int().min(5).optional(), // only while within this many feet of the caster, as Transfix's
    save: z
      .strictObject({
        ability: AbilitySchema,
        dc: FormulaSchema,
        onSuccess: z.enum(["half", "none", "full"]).default("half"),
        endsEffect: z.boolean().default(false), // a successful save ends the effect
      })
      .optional(),
    once: z.boolean().default(false), // fires one time and then ends, as with Acid Arrow
  }),
  // Extra damage on a hit. "bearer" means whoever has the effect deals it (Divine Favor);
  // "caster" means the effect's caster deals it when hitting whoever has the effect (Hex).
  z.strictObject({
    kind: z.literal("hitDamage"),
    // "side" means the caster or any creature on its side deals it once, hitting whoever has the effect, which ends
    // it, as Path to the Grave's curse
    dealtBy: z.enum(["bearer", "caster", "side"]),
    weaponOnly: z.boolean().default(false),
    damage: DamageSchema,
    within: z.number().int().min(5).optional(), // only against a creature this near the bearer
    // the type picked for each hit, the one the target resists least, as Conjure Minor Elementals' acid to lightning
    types: z.array(DamageTypeSchema).min(2).optional(),
    // ends after the bearer's next attack roll, as a bandit crime lord's Deadly Aim; dealt by the caster, with its
    // next hit on the bearer, as Feinting Attack's die
    once: z.boolean().optional(),
    // all the hit's own damage takes this type, as Planar Warrior's Force
    retype: DamageTypeSchema.optional(),
    oncePerTurn: z.literal(true).optional(), // on one hit a turn, as a Mythallar Cloak's 1d4 Radiant
    melee: z.literal(true).optional(), // melee attacks only, as Fount of Moonlight's
    // Ammunition weapons only, the bearer's next `uses` attacks with them, hit or miss, as Flame Arrows' quiver
    ammunition: z.literal(true).optional(),
    uses: z.number().int().min(1).optional(),
    unarmed: z.literal(true).optional(), // only with an Unarmed Strike, as a Potion of Pugilism's
  }),
  // The bearer's size: `set` to this one, or `grow` categories larger (smaller when negative), as Enlarge/Reduce or
  // Large Form (combat/queries.ts sizeOf).
  z.strictObject({
    kind: z.literal("size"),
    set: SizeSchema.optional(),
    grow: z.number().int().min(-2).max(2).optional(),
  }),
  // Limits on what the bearer can do on its turns, as Slow gives: `oneAction` is an action or a Bonus Action, not
  // both; `noActions` neither; `oneAttack` one attack with the Attack action; `speed` halves, doubles or stops its
  // Speed; `spellFailure` is the percent chance a spell with a Somatic component fails.
  z.strictObject({
    kind: z.literal("actionLimit"),
    oneAction: z.literal(true).optional(),
    noActions: z.literal(true).optional(),
    noReactions: z.literal(true).optional(),
    noOpportunityAttacks: z.literal(true).optional(), // as Shocking Grasp's
    noDisengage: z.literal(true).optional(), // as Hunter's Rime's on a creature Hunter's Mark marks
    oneAttack: z.literal(true).optional(),
    speed: z.enum(["half", "double", "none"]).optional(),
    spellFailure: z.number().int().min(1).max(100).optional(),
    noSpells: z.literal(true).optional(), // it can't cast spells, as Befuddlement's
    noAttacks: z.literal(true).optional(), // it can't attack, as in Gaseous Form
    cantripsOnly: z.literal(true).optional(), // it casts no spell but a cantrip, as after Arcane Deflection
    speedMax: z.number().int().min(0).optional(), // its Speed is at most this many feet, as Power Word Pain's
    // only one of moving, an action and a Bonus Action on its turns, as Abjure Foes' or Devious Strikes' Daze
    // (combat/durations.ts)
    oneThing: z.literal(true).optional(),
  }),
  // Before casting a spell the bearer saves against `dc` (the caster's spell save DC, filled in as it's cast, when
  // left out), or the spell fails and its action is wasted, its slot spent unless `keepSlot`, as Power Word Pain's or
  // Gehennan Cruelty's (combat/actions.ts).
  z.strictObject({
    kind: z.literal("castSave"),
    ability: AbilitySchema,
    dc: z.number().int().optional(),
    keepSlot: z.literal(true).optional(),
  }),
  // Taking damage other than Psychic gives the bearer this save, whose failure deals `damage` and Incapacitates it
  // until it saves at the end of a turn, as Cackle Fever's laughter (environment.ts).
  z.strictObject({
    kind: z.literal("laughter"),
    dc: z.number().int(),
    damage: z.array(DamageSchema).min(1),
  }),
  // Being moved out of its space, or making a melee attack, deals `damage` to the bearer and ends the spell on it, as
  // Mental Prison's illusory cell (combat/fear.ts).
  // shortcut: only a push or pull moves it out, as Restrained it walks nowhere.
  z.strictObject({
    kind: z.literal("prison"),
    damage: z.array(DamageSchema).min(1),
  }),
  // As each of its turns starts the bearer saves against `dc` (filled in as cast) or takes the Dodge action, which
  // spends its action, as Bestow Curse's (combat/fear.ts).
  z.strictObject({
    kind: z.literal("dodgeSave"),
    ability: AbilitySchema,
    dc: z.number().int().optional(),
  }),
  // Haste's additional action each turn: the Attack (one attack only), Dash, Disengage or Hide action. When it
  // ends, the bearer is Incapacitated with a Speed of 0 until the end of its next turn, unless `noLethargy`, as a
  // Potion of Speed's.
  z.strictObject({
    kind: z.literal("hasted"),
    noLethargy: z.literal(true).optional(),
  }),
  // Shut away where nothing reaches it and it reaches nothing, as in Otiluke's Resilient Sphere, a Forcecage box
  // or Maze, or on the Ethereal Plane with Etherealness. With `escape` it can spend its action on that check to end the effect, as Maze's DC 20 Intelligence.
  z.strictObject({
    kind: z.literal("sealed"),
    escape: z
      .strictObject({
        ability: AbilitySchema,
        dc: z.number().int(),
        skill: SkillSchema,
      })
      .optional(),
    // it can teleport out after a save of this ability against its caster's spell save DC, as from a Forcecage
    teleportSave: AbilitySchema.optional(),
    rolls: z.literal(true).optional(), // it moves at half Speed, its prison with it, as Resilient Sphere's
    // it spends an action to end the effect at will, as one on the Ethereal Plane with Etherealness comes back
    leave: z.literal(true).optional(),
  }),
  // Shut in a cage that stops it walking out but lets sight, attacks and spells through its bars, as Forcecage's
  // cage, whose walls are its caster's zone. It can teleport out after this save against the caster's spell save DC.
  z.strictObject({ kind: z.literal("caged"), teleportSave: AbilitySchema }),
  // The bearer is this far up, lifted by the effect of the same source without ":aloft", and falls once that's gone,
  // as with Reverse Gravity (combat/falling.ts). With `mode` it went up itself, flying or climbing, and stays while it
  // has that Speed (and, flying, while it isn't Prone or Incapacitated, unless it can hover). `gentle` comes down
  // unhurt, as from Levitate.
  z.strictObject({
    kind: z.literal("aloft"),
    feet: z.number().int(),
    mode: z.enum(["fly", "climb"]).optional(),
    gentle: z.literal(true).optional(),
  }),
  // The bearer can't attack with this action's weapon while it lasts, as one caught by a kuo-toa's Sticky Shield.
  z.strictObject({ kind: z.literal("stuck"), action: z.string() }),
  // The first time on each turn the bearer walks 1 foot or more, it takes this damage, as Grasping Arrow's brambles.
  z.strictObject({
    kind: z.literal("moveDamage"),
    damage: z.array(DamageSchema).min(1),
    once: z.literal(true).optional(), // it ends once dealt, as Booming Blade's thunder
  }),
  // The damage the bearer's weapon attacks deal is halved, as Enfeebling Arrow's, or with `exceptCaster` only against
  // creatures other than the effect's caster, as Ancestral Protectors' spectral warriors.
  z.strictObject({
    kind: z.literal("weakened"),
    exceptCaster: z.literal(true).optional(),
  }),
  // The next attack that hits the bearer from its caster's side deals it double damage, which spends it, as Path to
  // the Grave's (2014) curse.
  z.strictObject({ kind: z.literal("exposed") }),
  // The bearer sees nothing farther than this many feet away, as Shadow Arrow's.
  z.strictObject({
    kind: z.literal("sightLimit"),
    feet: z.number().int().min(5),
  }),
  // The bearer can't benefit from the Invisible condition, as with a sahuagin baron's Fiendish Blood.
  // Its Fiends sensing the bearer's location adds nothing, since hiding is the Invisible condition too.
  z.strictObject({ kind: z.literal("outlined") }),
  // Kept by a creature that saved against an area or a reaction, which no longer affects it, as a ghast's Stench
  // or a chain devil's Unnerving Gaze.
  z.strictObject({ kind: z.literal("areaImmunity") }),
  // A flat increase to a weapon's own damage, optionally only with one ability, such as Rage.
  z.strictObject({
    kind: z.literal("damageBonus"),
    amount: AmountSchema,
    ability: AbilitySchema.optional(),
    subtract: z.boolean().optional(), // a penalty, as a gold dragon's Weakening Breath
    once: z.literal(true).optional(), // ends after the bearer's next attack roll, as Riposte's Superiority Die
  }),
  // A Speed of another kind, as a Fly Speed: these feet, or without them equal to the bearer's Speed
  // (core/movement-modes.ts).
  z.strictObject({
    kind: z.literal("movementMode"),
    mode: z.enum(["fly", "climb", "burrow", "swim"]),
    feet: z.number().int().min(5).optional(),
    times: z.number().int().min(2).optional(), // with no feet, this many times its Speed, as Perfected Armor's flight
    hover: z.literal(true).optional(), // a flyer that doesn't fall while Prone or Incapacitated, as with Fly
    ceiling: z.literal(true).optional(), // a climber that goes along ceilings, not only walls, as with Spider Climb
  }),
  // It has no Speed of this kind while it lasts, and comes down from flying unhurt, as Earthbind's (core/movement-modes.ts).
  // With `feet`, that Speed is at most this instead, as Wind Soul's own flight lowered to 30 feet.
  z.strictObject({
    kind: z.literal("grounded"),
    mode: z.enum(["fly", "climb", "burrow", "swim"]),
    feet: z.number().int().min(5).optional(),
  }),
  // Effects can't lower its Speed, as Freedom of Movement keeps magic from doing (stats.ts).
  z.strictObject({ kind: z.literal("steadySpeed") }),
  // Difficult Terrain costs it no extra movement, and it escapes a grapple with 5 feet of movement, as with Freedom of
  // Movement.
  // With `terrainOnly` it's only the Difficult Terrain, as Speedy's Dash over it.
  z.strictObject({
    kind: z.literal("unhindered"),
    terrainOnly: z.literal(true).optional(),
  }),
  // Once on each of its turns it can jump up to `feet` for only `movement` feet of its movement, as with the Jump spell
  // or Boots of Striding and Springing (stats.ts jumpActions).
  z.strictObject({
    kind: z.literal("jumpBoost"),
    feet: z.number().int().min(5),
    movement: z.number().int().min(0),
  }),
  // Its Speed is at least this, as Boots of Striding and Springing's 30 feet (stats.ts).
  // shortcut: a higher Speed that carrying weight or Heavy armor lowers isn't kept at its own.
  z.strictObject({
    kind: z.literal("speedFloor"),
    feet: z.number().int().min(5),
  }),
  // Walking across water as if it were ground, as with Water Walk (core/combat/queries.ts).
  z.strictObject({ kind: z.literal("waterWalk") }),
  // Breathing underwater, as with Water Breathing, so an underwater fight never runs its breath out (combat/water.ts).
  z.strictObject({ kind: z.literal("waterBreathing") }),
  // Holding its breath this many minutes, as Aberrant Anatomy's Breathless hour, instead of 1 plus its Constitution
  // modifier.
  z.strictObject({
    kind: z.literal("holdBreath"),
    minutes: z.number().int().min(1),
  }),
  // Its moving provokes no Opportunity Attacks while it lasts, as Zephyr Strike's.
  z.strictObject({ kind: z.literal("unprovoking") }),
  // Knowing where creatures on the ground are, this far, through walls and darkness, as Stonecunning's Tremorsense.
  z.strictObject({
    kind: z.literal("tremorsense"),
    feet: z.number().int().min(5),
  }),
  // Regaining no Hit Points, as in a death tyrant's Negative Energy Cone.
  z.strictObject({ kind: z.literal("noHealing") }),
  // The first drop to 0 Hit Points is a drop to 1 instead, and the effect ends, as with Death Ward.
  z.strictObject({ kind: z.literal("deathWard") }),
  // Dash as a Bonus Action, as Expeditious Retreat gives.
  z.strictObject({ kind: z.literal("bonusDash") }),
  // Darkvision this far, and with `truesight` seeing through magical darkness and invisibility, as Darkvision or True
  // Seeing give.
  z.strictObject({
    kind: z.literal("darkvision"),
    feet: z.number().int().min(5),
    truesight: z.literal(true).optional(),
  }),
  // A sense this far (core/sight.ts sensesOf): Darkvision, Blindsight (seeing without light, through fog, past the
  // Invisible condition and while Blinded) or Truesight (through magical darkness and the Invisible condition), as
  // Blind Fighting's or Witch Sight's. `extend` is what it adds to Darkvision the bearer already has instead, as
  // Umbral Sight's 60 feet.
  z.strictObject({
    kind: z.literal("sense"),
    // "xray" sees through solid walls this far, as a Ring of X-ray Vision's 30 feet (core/fog.ts)
    sense: z.enum(["darkvision", "blindsight", "truesight", "xray"]),
    feet: z.number().int().min(5),
    extend: z.number().int().min(5).optional(),
  }),
  // The bearer sheds light this far round itself wherever it goes, Bright ("light") or Dim, with `dim` feet of Dim
  // Light beyond Bright, as Faerie Fire's 10 feet of Dim Light (core/zones.ts).
  z.strictObject({
    kind: z.literal("sheds"),
    light: z.enum(["light", "dim"]),
    feet: z.number().int().min(5),
    dim: z.number().int().min(5).optional(),
  }),
  // Heavily Obscured to everyone else, which only Blindsight sees past, as Shadow of Moil's shadows (core/sight.ts).
  z.strictObject({ kind: z.literal("shrouded") }),
  // Illusory duplicates, each of which a hit may land on instead, as Mirror Image's (combat/attack.ts).
  z.strictObject({
    kind: z.literal("images"),
    count: z.number().int().min(1),
  }),
  // An attacker must pass a Wisdom save against `dc` (the caster's, filled in as it's cast) or lose the attack, as
  // Sanctuary. With `creatureTypes` only those attackers, with `ability` another save, and with `lasting` the bearer's
  // own attacks don't end it and an attacker that saves is free of it, as a Scroll of Protection's ward.
  // shortcut: a Scroll of Protection's save is made as the attack is, not with a Magic action, and it wards only
  // its reader.
  z.strictObject({
    kind: z.literal("sanctuary"),
    dc: z.number().int().optional(),
    ability: AbilitySchema.optional(),
    creatureTypes: z.array(z.string()).min(1).optional(),
    lasting: z.literal(true).optional(),
  }),
  // Damage of this type the bearer takes is cut by `amount`, once a turn, as with Resistance (the cantrip). As a
  // passive with no `damage`, any type; `magical` only a spell's, `oncePerTurn` once a turn and `able` only while the
  // bearer isn't Incapacitated, as Spellfire Spark's Magic Absorption.
  z.strictObject({
    kind: z.literal("damageReduction"),
    damage: DamageTypeSchema.optional(),
    amount: AmountSchema,
    magical: z.literal(true).optional(),
    oncePerTurn: z.literal(true).optional(),
    able: z.literal(true).optional(),
    // up to this many of the bearer's Hit Point Dice spent and rolled, added to `amount`, as Crown of Spellfire's
    // Burning Life Force. shortcut: any damage once a turn, not only an attack's hit.
    hitDice: FormulaSchema.optional(),
  }),
  // The bearer can take its spell's `granted` action, dealing this type at the save DC it was cast with (filled in
  // as it's cast), as Dragon's Breath's breath, or an item's, as a Potion of Fire Breath's, `uses` times at most.
  z.strictObject({
    kind: z.literal("grantedAction"),
    damage: DamageTypeSchema.optional(), // none for an action that deals none of a chosen type, as Fount of Moonlight's
    dc: z.number().int().optional(),
    uses: z.number().int().min(1).optional(),
  }),
  // The bearer's next weapon hit that deals damage also makes its target make this save, which spends it, as a
  // Poisoner's dose (combat/attack.ts). Its DC is worked out from the bearer's numbers as it hits.
  z.strictObject({
    kind: z.literal("coating"),
    ability: AbilitySchema,
    dc: FormulaSchema,
    damage: z.array(DamageSchema).min(1),
    condition: ConditionSchema.optional(), // on a failed save, until the end of the bearer's next turn
    minutes: z.number().int().min(1).optional(), // the condition lasts this long instead, as a Dagger of Venom's minute
  }),
  // The bearer's weapon attacks are changed while it lasts, as by Shillelagh; with `once`, only its next one, as
  // True Strike's.
  z.strictObject({
    kind: z.literal("weaponSpell"),
    ...WeaponChangeSchema.shape,
    once: z.literal(true).optional(),
  }),
  // Disadvantage on attacks against anyone but the effect's caster, and no moving willingly more than `feet` from
  // it, as Compelled Duel's; what the caster does can end it (combat/duel.ts). With `leashOnly` it's only the leash,
  // which holds while the caster can act, as Champion Challenge's.
  z.strictObject({
    kind: z.literal("duel"),
    feet: z.number().int().min(5).default(30),
    leashOnly: z.literal(true).optional(),
    unleashed: z.literal(true).optional(), // no leash, as Goading Attack's Disadvantage alone
  }),
  // Casting a spell with a slot, the bearer rolls as many of its Hit Point Dice as the slot's level and regains the
  // roll plus `bonus`, worked out from the caster's numbers, as Simbul's Synostodweomer (combat/school.ts).
  z.strictObject({ kind: z.literal("castHitDice"), bonus: FormulaSchema }),
  // The bearer can cast this spell once without its costs, as Wish's copy of it (combat/wish.ts).
  z.strictObject({ kind: z.literal("wished"), spell: ContentIdSchema }),
  // At the start of each of its turns the bearer rolls a d8: on 1-6 it does nothing, on 7-8 it makes a melee attack
  // against a random creature in reach, and it takes no Reactions, as an umber hulk's Confusing Gaze (combat/turn.ts).
  // shortcut: the 5-6 random walk is spent standing still, as wandering off is close to doing nothing on the grid.
  // With `spell`, the d10 of Confusion the spell instead, whose 1 walks off and whose 9-10 acts freely
  // (combat/confusion.ts).
  z.strictObject({
    kind: z.literal("confused"),
    spell: z.literal(true).optional(),
  }),
  // A face rolled on the table `from` holds, kept until it's unleashed by a `rollTable` with `channeled`, as a
  // spirit channeled with Spirits from Beyond (combat/effects.ts).
  z.strictObject({
    kind: z.literal("channeled"),
    from: ContentIdSchema,
    face: z.number().int().min(1),
  }),
  // Each spell the bearer casts deals it `dice` Necrotic damage for each of the spell's levels, which nothing reduces,
  // as Wish's stress (combat/school.ts).
  z.strictObject({ kind: z.literal("castRecoil"), dice: DiceSchema }),
  // A ward readied between a scene's choices, set off as the next fight there starts (combat/start.ts wardsSet): with
  // `alert` the party isn't surprised, as with Alarm or a Faithful Hound; `activation` (an ActivationSchema, parsed as
  // it's used) is resolved by the bearer at the first foe in the Initiative order, or at itself with `self` targeting,
  // as a Glyph of Warding's explosion or a Magic Circle's zone. It lasts until the next scene (lingering 0).
  z.strictObject({
    kind: z.literal("prepared"),
    alert: z.literal(true).optional(),
    activation: z.unknown().optional(),
  }),
  // A shelter round the party, as Leomund's Tiny Hut: the harm the place does to a rest stays outside (environment.ts).
  z.strictObject({ kind: z.literal("sheltered") }),
  // In a fury (passive `fury`): on its turns it attacks the nearest creature it reaches, friend or foe, or with `at`
  // that creature until either drops (combat/madness.ts).
  z.strictObject({ kind: z.literal("furious"), at: z.string().optional() }),
  // Under its caster's control, as Dominate Person's: while it lasts the bearer fights on the caster's side and plays by
  // that side's tactics, a player's character too (state.ts settleSides).
  // shortcut: the caster's orders are its side's tactics, with no orders given by hand.
  z.strictObject({ kind: z.literal("controlled") }),
  // Out of the fight, as Calm Emotions' Indifferent or a Suggestion to stop fighting: no action, Bonus Action or
  // Reaction and no moving (combat/durations.ts), the party's tactics leave it be, and a fight with no foe left but
  // such is won (combat/turn.ts).
  z.strictObject({ kind: z.literal("pacified") }),
  // Understands any language it hears or reads, as Comprehend Languages or Tongues (core/explore.ts understands).
  z.strictObject({ kind: z.literal("comprehension") }),
  // As each of its turns starts the bearer spends its movement going away from the caster, or `toward` it until
  // within 5 feet, Dashing first with `dash`; with `endsTurn` it then does nothing more that turn, which `toward` ends
  // only once within 5 feet, as Command's Approach and Flee (combat/fear.ts).
  z.strictObject({
    kind: z.literal("compelled"),
    toward: z.literal(true).optional(),
    dash: z.literal(true).optional(),
    endsTurn: z.literal(true).optional(),
  }),
  // No teleporting or travel to another plane, as with Dimensional Shackles on.
  z.strictObject({ kind: z.literal("anchored") }),
  // Spells of `maxLevel` or lower, of one of these classes' lists, cast without a slot while it lasts, as a Candle of
  // Invocation's light for a Cleric or Druid.
  z.strictObject({
    kind: z.literal("freeSpells"),
    maxLevel: z.number().int().min(1).max(9),
    classes: z.array(z.string().min(1)).min(1),
  }),
  // The bearer speaks from elsewhere, so Silence round it stops none of its Verbal spells, as through a Spell-Slinger's
  // Puppet. shortcut: the voice is always somewhere the Silence isn't.
  z.strictObject({ kind: z.literal("voiceElsewhere") }),
  // The item whose activation gave it is a Thrown weapon of this range that comes back once thrown, as a
  // Martialist's Quarterstaff's Throw (stats.ts imbuedRange).
  z.strictObject({
    kind: z.literal("thrownWeapon"),
    normal: z.number().int().min(5),
    long: z.number().int().min(5),
  }),
  // A character's ability score is this while it lasts, unless its own is higher, as a Potion of Giant Strength's
  // Strength (stats.ts).
  z.strictObject({
    kind: z.literal("setScore"),
    ability: AbilitySchema,
    score: z.number().int().min(1),
    exact: z.literal(true).optional(), // lowering a higher score too, as Wish's stress Strength of 3
  }),
  // No rule of its own: a curse, a mark or a hold that another of its giver's actions looks for (a targeting's
  // `afflicted`), as a nightmare's Haunter's Spear curse.
  // `curse` makes it a curse, which Remove Curse ends with everything else the same action gave.
  z.strictObject({
    kind: z.literal("mark"),
    curse: z.literal(true).optional(),
  }),
  // Its Exhaustion can't increase while it lasts, as Iron Body's.
  z.strictObject({ kind: z.literal("noExhaustion") }),
  // The bearer has seen through the illusion of `source` its `caster` made (core/zones.ts).
  z.strictObject({
    kind: z.literal("discerned"),
    source: z.string(),
    caster: z.string(),
  }),
  // Disguised: it looks like someone else, which a Study with Investigation against `dc` sees through, and in a
  // scene its Deception checks have Advantage (core/explore.ts), as Disguise Self's.
  z.strictObject({
    kind: z.literal("disguise"),
    dc: z.number().int().min(1).optional(),
  }),
  // Which of a transformation's options the bearer has taken, by name, for what holds only `whileAspect` it lasts, as
  // Starry Form's Archer, Chalice or Dragon.
  z.strictObject({ kind: z.literal("aspect"), name: z.string().min(1) }),
]);
export type Modifier = z.infer<typeof ModifierSchema>;

export const DurationSchema = z.union([
  z.literal("instantaneous"),
  z.strictObject({ concentration: z.literal(true), minutes: z.number() }),
  // "its" counts the target's turns, not the caster's, and "turnEnd" is the end of the turn it happens on. "rest"
  // lasts until a Short or Long Rest, which is the whole fight.
  z.strictObject({
    until: z.enum([
      "yourNextTurnStart",
      "yourNextTurnEnd",
      "itsNextTurnStart",
      "itsNextTurnEnd",
      "turnEnd",
      "rest",
      "longRest", // until the next Long Rest, outlasting fights and scenes, as Blessing of the Trickster
    ]),
  }),
  z.strictObject({ minutes: z.number() }),
  z.strictObject({ text: z.string().min(1) }), // not tracked by the rules, such as Until dispelled
]);
export type Duration = z.infer<typeof DurationSchema>;

export const ZoneKindSchema = z.enum([
  "darkness",
  "fog",
  "thorns",
  "light",
  "dim",
  "sunlight",
  "area",
  "wall",
  // Light one step dimmer in it, Bright Light Dim and Dim Light Darkness, as round Shadow of Moil's caster.
  "shade",
  // An illusion: it hides what's in it from whoever hasn't seen through it, as Silent Image's (core/zones.ts).
  "image",
]);
export type ZoneKind = z.infer<typeof ZoneKindSchema>;

export const LeafEffectSchema = z.discriminatedUnion("kind", [
  // `full` restores all its Hit Points, as Resurrection. `divided` rolls the amount once and shares it among the
  // targets, the most hurt first, as Mass Heal, and `half` heals none past half its Hit Point maximum, as Preserve
  // Life. `pool` spends a resource for each `amount` it heals, as many as the target needs and at most `most`, as
  // Lay On Hands' Hit Points or Healing Light's dice, and can't be used with that resource spent.
  z.strictObject({
    kind: z.literal("heal"),
    amount: AmountSchema,
    creatureTypes: z.array(z.string().min(1)).min(1).optional(), // only these, as Blackrazor's healing of an Undead
    full: z.literal(true).optional(),
    divided: z.literal(true).optional(),
    half: z.literal(true).optional(),
    perSlot: z.number().int().min(1).optional(), // this much more for each level of the slot, as Undead Vitality's
    halfMax: z.literal(true).optional(), // half the target's own Hit Point maximum, as Master Transmuter's Panacea
    pool: z
      .strictObject({
        resource: z.string().min(1),
        most: FormulaSchema.optional(),
        temp: z.literal(true).optional(), // and a Temporary Hit Point for each spent, as Balm of the Summer Court
      })
      .optional(),
  }),
  // Coming back from the dead: the target takes `penalty` off its D20 Tests, one less after each Long Rest, as
  // Raise Dead's ordeal.
  z.strictObject({
    kind: z.literal("ordeal"),
    penalty: z.number().int().min(1),
  }),
  // A corpse kept from decay: the time it has been dead stops counting against `diedWithin`, as Gentle Repose.
  // shortcut: it lasts until the creature is raised, as the spell's 10 days outlast an adventure.
  z.strictObject({ kind: z.literal("repose") }),
  // The target gains a Short Rest's benefits: it spends Hit Dice until healed and gets back what a Short Rest
  // restores, as Prayer of Healing (rest.ts).
  // Not again until the creature's Long Rest. shortcut: the player's Hit Dice are spent as a companion's are.
  z.strictObject({ kind: z.literal("shortRest") }),
  // The target regains spent uses of a resource, a spell slot ("slot:<level>"), or its spell slots ("slots", highest
  // first, `half` being half its slots rounded up), as Font of Inspiration's use for a slot or Magical Cunning.
  z.strictObject({
    kind: z.literal("regain"),
    resource: z.string().min(1),
    count: z
      .union([z.number().int().min(1), z.enum(["half", "all"])])
      .default(1),
    // "slots" of this level or lower only, as a Pearl of Power's 3, or half the level it's cast with, rounded down,
    // as Mordenkainen's Lucubration's
    maxLevel: z
      .union([z.number().int().min(1).max(9), z.literal("halfSlot")])
      .optional(),
    // this many for each level of the slot spent on it instead, as Arcane Ward's twice the slot's level
    perSlot: z.number().int().min(1).optional(),
  }),
  // The target's magic item carried whose charges come back at dawn, the one with most spent, regains `amount` of
  // them, as from an Arcane Battery.
  z.strictObject({ kind: z.literal("rechargeItem"), amount: AmountSchema }),
  // The hit that set the reaction off deals one of these types in place of its first damage's, as a Brooch of the
  // Elements makes it (combat/attack.ts retypedHit).
  z.strictObject({
    kind: z.literal("retypeHit"),
    types: z.array(DamageTypeSchema).min(2),
  }),
  // The party gets away from the fight, as with Teleport or Plane Shift, where the encounter can be fled; anywhere else
  // it does nothing (combat/effects.ts, legendary.ts runEscape).
  z.strictObject({ kind: z.literal("escape") }),
  // The oldest item the caster replicated vanishes, giving back a spell slot of level 1 for a Common item or 2 for
  // another, as Magic Item Tinker's Drain (combat/effects.ts).
  z.strictObject({ kind: z.literal("drainReplicated") }),
  // A roll on the table the content entry `from` holds (its `table`, TableSchema), as a Wand of Wonder's effects
  // (combat/reactions.ts tableRoll), aimed at the action's target.
  // With `channeled` the face kept by `channel` is used, and the channeled effect ends.
  z.strictObject({
    kind: z.literal("rollTable"),
    from: ContentIdSchema,
    channeled: z.literal(true).optional(),
  }),
  // A face of the table `from` holds, rolled on a d`dieSize` (a scaling key, as `bardicDie`) and kept on the target
  // until a rest or until it's unleashed, as Spirits from Beyond's spirit; with `pick` the bearer picks the face, as
  // Controlled Channeling. A new one replaces the one kept. shortcut: with a pick of two (`tableTwice`), the higher
  // face is kept, or on doubles the highest the die allows, as Mystical Connection.
  z.strictObject({
    kind: z.literal("channel"),
    from: ContentIdSchema,
    dieSize: z.string().min(1),
    pick: z.literal(true).optional(),
  }),
  // Damage to the one taking the action, with `creatureTypes` only when the target is one of these, as Blackrazor's
  // 1d10 Necrotic to its wielder for hitting an Undead or a Book of Vile Darkness's Vile Speech to its reader.
  z.strictObject({
    kind: z.literal("recoil"),
    damage: z.array(DamageSchema).min(1),
    creatureTypes: z.array(z.string().min(1)).min(1).optional(),
  }),
  // A `chance` percent the item used breaks, dealing this to its user, as a Horn of Blasting's explosion.
  z.strictObject({
    kind: z.literal("mishap"),
    chance: z.number().int().min(1).max(100),
    damage: z.array(DamageSchema).min(1),
  }),
  // The item used's `untilLongRest` passives, which the target keeps until it finishes a Long Rest, in a fight or out
  // of one, as a Potion of Vitality's highest Hit Point Dice.
  // shortcut: "24 hours" lasts until the next Long Rest, the only clock between scenes.
  z.strictObject({ kind: z.literal("untilLongRest") }),
  // Items handed to the target, `count` of them worked out from the caster's numbers, as the potions Tasha's
  // Bubbling Cauldron makes, none of an item no loaded book has. shortcut: they come at once rather than a Bonus Action each, and stay after a recast.
  z.strictObject({
    kind: z.literal("createItems"),
    item: ContentIdSchema,
    count: FormulaSchema,
  }),
  // Ends every curse on the target, with all else the action that cursed it gave, as Remove Curse.
  z.strictObject({ kind: z.literal("uncurse") }),
  // With `reaction` the target spends its Reaction to gain them, and gains none without one, as a death's head tree's
  // Head Fruits.
  z.strictObject({
    kind: z.literal("tempHp"),
    amount: AmountSchema,
    reaction: z.literal(true).optional(),
    divided: z.literal(true).optional(), // shared evenly among the targets, as Power Word Fortify's 120
  }),
  z.strictObject({
    kind: z.literal("applyCondition"),
    condition: ConditionSchema,
    duration: DurationSchema,
    repeatSave: z.boolean().default(false), // the target repeats the save at the end of each of its turns
    // A save at the end of each of its turns for a condition that came with none, as with Power Word Stun.
    endSave: z
      .strictObject({ ability: AbilitySchema, dc: FormulaSchema })
      .optional(),
    hpAtMost: z.number().int().min(1).optional(), // only a target with this many Hit Points or fewer
    hpAbove: z.number().int().min(1).optional(), // only a target with more Hit Points than this, as Divine Word's bands
    // One of the caster's choices, by label: the effects sharing a label make one option, picked as the effect lands
    // (combat/options.ts), as Blindness/Deafness's Blinded or Deafened.
    option: z.string().min(1).optional(),
    // On each of its turns it Dashes away from the caster by the longest way it can (combat/fear.ts). `unseen` makes its
    // repeat save only at the end of a turn out of the caster's sight, as Fear's; `far` ends it once that many feet
    // away and out of sight, as Eyebite's Panicked; `casterDown` ends it once the caster is Incapacitated or dead, as
    // Turn Undead's.
    flee: z
      .strictObject({
        unseen: z.literal(true).optional(),
        far: z.number().int().min(5).optional(),
        casterDown: z.literal(true).optional(),
      })
      .optional(),
    // Another creature within 5 feet can take an action to end it, as shaking a creature out of Sleep (combat/fear.ts).
    shake: z.literal(true).optional(),
    cantStand: z.literal(true).optional(), // Prone it can't end on itself, as Hideous Laughter's
    // It can spend its action to repeat the save, as Irresistible Dance's (combat/fear.ts).
    actionSave: z.literal(true).optional(),
    // It, or another creature within 5 feet, can take an action to make this check against the save's DC (or `dc`),
    // ending every effect of its source on a success, as Ensnaring Strike's Strength (Athletics) (combat/fear.ts).
    escape: z
      .strictObject({
        ability: AbilitySchema,
        skill: SkillSchema.optional(),
        dc: z.number().int().min(1).optional(),
      })
      .optional(),
    failExhaustion: z.literal(true).optional(), // each failed repeat save gives a level of Exhaustion
    // Something that would end it does so only after the save it came with, as Contagion's Poisoned.
    clings: z.literal(true).optional(),
    web: z.literal(true).optional(), // webs hold it, which a Web Walker ignores, as with Web
    // only a target this size or smaller, as an Energy Pulse knocks only a Medium or smaller creature Prone
    maxSize: z
      .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
      .optional(),
    endsOnDamage: z.boolean().default(false),
    endsOnSpell: z.boolean().optional(), // ends when another spell targets the creature, as Modify Memory's
    // Ends when the creature attacks or deals damage ("attack"), also when it casts a spell ("spell"), as a Potion of
    // Invisibility's, or takes any action ("action"), as Fade Away's.
    endsOn: z.enum(["attack", "action", "spell"]).optional(),
    // Ends as the creature's turn ends in Bright Light, as Cloak of Shadows' (combat/turn.ts).
    endsInLight: z.literal(true).optional(),
    // Ends once the creature has the Incapacitated condition, as Draconic Flight's wings (combat/turn.ts).
    untilIncapacitated: z.literal(true).optional(),
    // Taking damage gives it a save to end it, as Dragon Fear's, using the save it came with, with Advantage on
    // "advantage", as Hideous Laughter's.
    saveOnDamage: z.union([z.literal(true), z.literal("advantage")]).optional(),
    // What a failed repeat save turns it into, as a cockatrice's Restrained becoming Petrified.
    secondFailure: z
      .strictObject({
        condition: ConditionSchema,
        duration: DurationSchema,
        endsOnDamage: z.boolean().default(false),
        // Saves of a kind it takes: this many failures leave the worse condition, and as many successes end it,
        // whatever their order, as Prismatic Spray's indigo ray.
        count: z.number().int().min(2).optional(),
      })
      .optional(),
    // A save with this ability as the caster's next turn starts: a success ends it, and a failure ends it and
    // sends the creature away for good, shut away as `sealed` is, as Prismatic Spray's violet ray.
    banish: z.strictObject({ ability: AbilitySchema }).optional(),
  }),
  z.strictObject({
    kind: z.literal("removeCondition"),
    condition: ConditionSchema,
    option: z.string().min(1).optional(), // as an applyCondition's, as Calm Emotions' calm
  }),
  z.strictObject({
    kind: z.literal("modifier"),
    modifier: ModifierSchema,
    duration: DurationSchema,
    // as an applyCondition's
    option: z.string().min(1).optional(),
    hpAtMost: z.number().int().min(1).optional(),
    hpAbove: z.number().int().min(1).optional(),
    endsOnDamage: z.literal(true).optional(), // as Hypnotic Pattern's Speed 0
    saveOnDamage: z.literal(true).optional(), // taking damage repeats its save, as Enemies Abound's
    // A save at the end of each of its turns that ends it, as an applyCondition's, for an effect that came with none,
    // as Power Word Pain's (2014).
    endSave: z
      .strictObject({ ability: AbilitySchema, dc: FormulaSchema })
      .optional(),
    // Not on a creature immune to this condition, as Power Word Pain's on one that can't be Charmed.
    immuneWith: ConditionSchema.optional(),
    // On a creature of these lowercase types it runs out only with Concentration, so held for its whole duration the
    // creature doesn't come back and counts as beaten meanwhile, as Banishment's (combat/turn.ts shutAway).
    gone: z.array(z.string()).min(1).optional(),
    repeatSave: z.boolean().optional(), // as an applyCondition's
    whileTempHp: z.literal(true).optional(), // ends once the bearer has no Temporary Hit Points, as Armor of Agathys
    endsInLight: z.literal(true).optional(), // as an applyCondition's
    untilIncapacitated: z.literal(true).optional(), // as an applyCondition's
    // The creature can take the Study action to end it with an Investigation check against the save's DC, as
    // Phantasmal Force's phantasm (actions.ts).
    studyEnds: z.literal(true).optional(),
    // The caster picks the modifier's damage type from these as it casts (combat/damage-choice.ts), as with
    // Protection from Energy. A cast's lists of the same length are picked together, by place, as Fire Shield's
    // warm or chill shield sets both its Resistance and its flames.
    choose: z.array(DamageTypeSchema).min(2).optional(),
    // The caster picks the skill or ability the modifier is limited to as it casts (combat/check-choice.ts), as
    // Guidance's skill or Enhance Ability's ability.
    pick: z
      .array(z.union([AbilitySchema, SkillSchema]))
      .min(2)
      .optional(),
  }),
  // Pushed straight away from the caster or pulled toward it, as Thunderous Smite or Thorn Whip, only when this size
  // or smaller with `maxSize`; or moved north, south, east or west by a d4, as by Infestation.
  z.strictObject({
    kind: z.literal("forcedMove"),
    feet: z.number(),
    direction: z.enum(["away", "toward", "random"]),
    maxSize: SizeSchema.optional(),
    largerBy: z.number().int().min(0).optional(), // only a target at most this many sizes larger than the caster
    option: z.string().min(1).optional(), // as an applyCondition's, as Telekinetic Thrust's push or Prone
  }),
  z.strictObject({ kind: z.literal("note"), text: z.string() }),
  // The caster's most hurt ally within `within` feet of it, other than the target, regains `amount`, as Blessing of
  // Moonlight's 2d4 when a creature fails its save against the Moonbeam.
  z.strictObject({
    kind: z.literal("allyHeal"),
    amount: AmountSchema,
    within: z.number().int().min(5),
  }),
  // The bearer teleports up to `feet` to an open square it can see, or with `movement` jumps there for that much
  // of the turn's movement (a monster's Leap), provoking Opportunity Attacks as a walk would.
  z.strictObject({
    kind: z.literal("teleport"),
    feet: z.number().int().min(5),
    // As far as `times` the roll of a d`dieSize` (a class scaling key) in place of `feet`, as Psychic Teleportation.
    rolled: z
      .strictObject({
        dieSize: z.string().min(1),
        times: z.number().int().min(1),
      })
      .optional(),
    movement: z.number().int().min(0).default(0),
    // Paid for with half the bearer's Speed (rounded down) in place of `movement`, as Portal Jump.
    halfSpeed: z.literal(true).optional(),
    // The target it's used on moves instead of the bearer, as a willing ally with Telekinetic Movement.
    others: z.literal(true).optional(),
    // A teleport paid for with movement that still provokes nothing, as Portal Step's.
    provokes: z.literal(false).optional(),
    // It flies there instead, round walls, as Tempestuous Magic's 10 feet (combat/movement.ts teleportSquares).
    fly: z.literal(true).optional(),
    // Only to a square it stood on this turn, as Boots of the Winding Path's.
    retrace: z.literal(true).optional(),
    // Up to `count` willing allies within `within` feet of where it left come too, each landing within `near` feet of
    // where it lands, as Travel along the Tree's six (combat/movement.ts bringFrame).
    bring: z
      .strictObject({
        count: z.number().int().min(1),
        within: z.number().int().min(5),
        near: z.number().int().min(5),
      })
      .optional(),
    // it lands within this many feet of the one using it, as an Energy Bow's Arrow of Transport brings a friend near
    beside: z.number().int().min(5).optional(),
    // Creatures within `within` feet of where it lands, or with `origin` of where it left, get `conditions` and
    // `modifiers` for `duration`, after a save when `save` is set: Whirlwind of Sand's Blinded, Toxic Escape's
    // Poisoned, Temporal Disruption's halved Speed. `foes` keeps it to the bearer's foes, the creatures of its choice.
    // `damage` is dealt too, half on a successful save, as Warping Implosion's Force; a formula DC is the bearer's.
    around: z
      .strictObject({
        origin: z.literal(true).optional(),
        within: z.number().int().min(5),
        foes: z.literal(true).optional(),
        save: z
          .strictObject({
            ability: AbilitySchema,
            dc: z.union([z.number().int(), FormulaSchema]),
          })
          .optional(),
        damage: z.array(DamageSchema).min(1).optional(),
        conditions: z.array(ConditionSchema).default([]),
        modifiers: z.array(ModifierSchema).default([]),
        duration: DurationSchema,
        // a failed save pulls the creature straight toward the space left, as Warping Implosion's
        pull: z.literal(true).optional(),
      })
      .optional(),
  }),
  // The caster carries the target, a willing ally, along until its turn ends: after each of its moves the target lands
  // beside it, provoking nothing, as Heightened Focus's Step of the Wind (combat/movement.ts).
  z.strictObject({ kind: z.literal("carry") }),
  // The Dash action as part of another, as with Adrenaline Rush, or the Disengage action, as a clay golem's Hasten.
  // `half` adds only half the Speed, and `safe` makes the turn's moving provoke no Opportunity Attacks, as
  // Tactical Shift's move of half the Speed. shortcut: the move comes as Speed for the turn, not at once.
  z.strictObject({
    kind: z.literal("dash"),
    half: z.literal(true).optional(),
    safe: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal("disengage") }),
  z.strictObject({ kind: z.literal("dodge") }), // the Dodge action as part of another, as Patient Defense's
  // The Hide action as part of another, where it could Hide, as Spell Subterfuge's Shrouding Spells.
  z.strictObject({ kind: z.literal("hide") }),
  // Action Surge: once a turn, after the action is spent, and the action it gives can't be a Magic action.
  z.strictObject({ kind: z.literal("extraAction") }),
  // Ends one of these conditions on the target, the one that hampers it most, as Lesser Restoration does.
  // With none of them on it, Greater Restoration ends one curse (`curse`), else restores a lowered Hit Point maximum
  // (`maxHp`), else takes away a level of Exhaustion (`exhaustion`), in that order.
  // shortcut: Greater Restoration picks what it ends in that order, not as the caster chooses.
  z.strictObject({
    kind: z.literal("cure"),
    conditions: z.array(ConditionSchema).min(1),
    exhaustion: z.literal(true).optional(),
    curse: z.literal(true).optional(),
    maxHp: z.literal(true).optional(),
    // and it ends a spell that keeps the target from casting, as Greater Restoration and Heal end Befuddlement
    befuddled: z.literal(true).optional(),
    // and the diseases magic cures, as Lesser Restoration ends Mudpox (environment.ts)
    disease: z.literal(true).optional(),
    // each of them on the target ends instead, `per` of the caster's `resource` apiece while it lasts, as Restoring
    // Touch's 5 Hit Points of Lay On Hands' pool for each condition
    pool: z
      .strictObject({ resource: z.string(), per: z.number().int().min(1) })
      .optional(),
  }),
  // An area left where the spell is aimed, or round the caster: magical darkness that only Blindsight, Truesight
  // or Devil's Sight see through (Darkness), fog only Blindsight sees through (Fog Cloud), or thorns that cost
  // double to cross and deal `damage` for each 5 feet walked in them (Spike Growth), Bright Light (Light), or Dim Light (Dancing Lights).
  // It ends with the spell.
  // "sunlight" is Bright Light that is sunlight (Daylight), "area" has no ground or light of its own and only does
  // what its activation's `area` says (Spirit Guardians), and "wall" rings the area with squares no one can pass
  // (Wall of Force). With `follows` it moves with the caster, as an Emanation does.
  z.strictObject({
    kind: z.literal("zone"),
    zone: ZoneKindSchema,
    radius: z.number().int().min(0), // 0 for the one square it's on, as Mold Earth's 5-foot square
    duration: DurationSchema,
    damage: z.array(DamageSchema).optional(),
    follows: z.literal(true).optional(),
    perSlot: z.number().int().min(5).optional(), // feet more radius for each slot level above the spell's
    bare: z.literal(true).optional(), // it carries none of the spell's area, which another of its zones does
    // its area's damage takes one of these types, which the caster picks as it casts (combat/damage-choice.ts), as
    // Conjure Elemental's element
    choose: z.array(DamageTypeSchema).min(2).optional(),
    // a wall that encloses a creature lets it make this save to get out first, as Wall of Stone's Dexterity
    escape: AbilitySchema.optional(),
    // a wall that stops only walking, as Forcecage's cage, or only sight, as Wall of Fire; both when left out
    walls: z.enum(["walking", "sight"]).optional(),
    // light: Dim Light this many feet beyond its Bright, as Light's 20 more feet (core/zones.ts)
    dim: z.number().int().min(5).optional(),
    // darkness its caster sees through, as Shadow Arts' (core/sight.ts)
    ownerSees: z.literal(true).optional(),
    // light: creatures in its Bright Light can't benefit from the Invisible condition, as a Lantern of Revealing's
    reveals: z.literal(true).optional(),
    // an image: the Investigation DC to see through it, the caster's spell save DC when left out
    dc: z.number().int().min(1).optional(),
    // an image of its caster that hides nothing, whose eyes the caster sees through, as Invoke Duplicity's
    decoy: z.literal(true).optional(),
  }),
  // The target takes the shape of the weakest Beast its level or Challenge Rating allows, with that form's Hit
  // Points as Temporary Hit Points, until they run out or the spell ends, as Polymorph does on a foe. A caster
  // choosing for itself or an ally picks the form (core/forms.ts), as Shapechange or Animal Shapes.
  z.strictObject({
    kind: z.literal("polymorph"),
    duration: DurationSchema,
    // Which stat blocks it can become, when not only Beasts: `types` (lowercase; any when left out), never `except`,
    // and at most `maxCr` and `maxSize` instead of the target's own level or Challenge Rating.
    forms: z
      .strictObject({
        types: z.array(z.string()).min(1).optional(),
        except: z.array(z.string()).min(1).optional(),
        maxCr: z.number().min(0).optional(),
        maxSize: z
          .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
          .optional(),
        noFly: z.literal(true).optional(), // only a form without a Fly Speed, as Wild Shape's before level 8
        // The highest Challenge Rating by the bearer's level in `class`: the last of `tiers` it has reached (a
        // form with a Fly Speed only from a tier with `fly`), as Wild Shape's, or the level divided by `per`, as
        // Circle Forms'.
        byLevel: z
          .strictObject({
            class: ContentIdSchema,
            tiers: z
              .array(
                z.strictObject({
                  level: z.number().int().min(1),
                  maxCr: z.number().min(0),
                  fly: z.literal(true).optional(),
                }),
              )
              .min(1)
              .optional(),
            per: z.number().int().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
    // What the creature keeps of its own: its Intelligence, Wisdom and Charisma ("mind"), its spellcasting, and its
    // features, feats and skill and save proficiencies ("features"), as Wild Shape keeps them.
    keep: z
      .array(z.enum(["mind", "spells", "features"]))
      .min(1)
      .optional(),
    tempHp: z.boolean().default(true), // the form's Hit Points as Temporary Hit Points
    // this many Temporary Hit Points instead, as Wild Shape's Druid level, with `tempHpPlus` more than the form's
    tempHpAmount: AmountSchema.optional(),
    tempHpPlus: z.number().int().min(1).optional(), // as Hardy Transformation's 20
    // it doesn't end when its Temporary Hit Points run out, nor take what's left of them when it ends, as Wild Shape
    lasting: z.literal(true).optional(),
    // the form's AC is at least this, worked out as it's taken, as Circle Forms' 13 plus the Wisdom modifier
    acFloor: FormulaSchema.optional(),
    untilIncapacitated: z.literal(true).optional(), // it ends once the bearer is Incapacitated, as Wild Shape does
  }),
  // Ends every spell of this level or lower that is on the target, as Dispel Magic does.
  z.strictObject({
    kind: z.literal("dispel"),
    maxLevel: z.number().int().min(0).max(9),
    // only spells cast by the target's foes, so a friend keeps its own, as Clockwork Cavalcade's chosen creatures
    hostile: z.literal(true).optional(),
    // each higher spell ends on a spellcasting ability check against 10 plus its level, as Dispel Magic's
    check: z.literal(true).optional(),
  }),
  // Lessens the hit that triggered a reaction, such as Uncanny Dodge or Deflect Attacks. With `deflect`, damage
  // brought to 0 is sent at a creature within `range`, which saves or takes `damage`, as Deflect Missile's force.
  // With `toNear`, what it takes off goes to a creature of that kind within `within` instead, and the reaction needs
  // one there, as Transfer Harm's podling.
  z.strictObject({
    kind: z.literal("reduceDamage"),
    halve: z.boolean().default(false),
    amount: AmountSchema.optional(),
    // `dc` as a formula is the bearer's; `resource` is spent to send it, as Deflect Attacks' Focus Point; `melee` is
    // the range against a melee attack, and `sameType` deals the type of the attack's damage instead.
    deflect: z
      .strictObject({
        range: z.number().int().min(5),
        melee: z.number().int().min(5).optional(),
        ability: AbilitySchema,
        dc: z.union([z.number().int(), FormulaSchema]),
        damage: z.array(DamageSchema).min(1),
        resource: z.string().min(1).optional(),
        sameType: z.literal(true).optional(),
      })
      .optional(),
    toNear: z
      .strictObject({ monster: ContentIdSchema, within: z.number().int() })
      .optional(),
    // Before damage lands on another creature (combat/reactions.ts beforeDamage): the bearer takes it all instead,
    // and nothing lessens it, as Divine Allegiance; or what this takes off is dealt back to the creature that dealt
    // it, as this type, as Vengeful Ancestors' Force.
    takes: z.literal(true).optional(),
    echo: DamageTypeSchema.optional(),
    perSlot: z.number().int().min(1).optional(), // this much more for each level of the slot spent, as Song of Defense's 5
    // the bearer's ward pool (a `wardPool` resource) takes it instead, as Projected Ward
    pool: z.string().min(1).optional(),
  }),
  // Adds to AC against the hit that triggered a reaction only, possibly turning it into a miss, as with Parry.
  z.strictObject({
    kind: z.literal("acAgainstHit"),
    // A formula is the reactor's, as a familiar's Intercept Attack adding its owner's Proficiency Bonus.
    bonus: z.union([z.number().int().min(0), FormulaSchema]),
    dice: DiceSchema.optional(), // rolled and added, as Warding Maneuver's 1d8
  }),
  // The caster's familiar takes its action of this name, which has the `commanded` trigger, spending its Reaction,
  // when it is within `range` feet, as a familiar's Energy Pulse (combat/familiar.ts).
  z.strictObject({
    kind: z.literal("commandFamiliar"),
    action: z.string().min(1),
    range: z.number().int().min(5),
  }),
  // The spell that triggered the reaction fails, as Counterspell's does on a failed save (combat/counter.ts). In an
  // automatic resolution it fails outright, only of `maxLevel` or lower, spending as many of `levels` as its level,
  // with what cast it wasted, slot and all, as an Ioun Stone of Absorption's 20 levels.
  // With `gains`, `levels` gains as many as the spell's level instead, only for a spell aimed at the bearer alone,
  // and past its maximum the item breaks as its `retribution` does, as a Staff of the Magi's Spell Absorption.
  z.strictObject({
    kind: z.literal("counter"),
    maxLevel: z.number().int().min(0).max(9).optional(),
    levels: z.string().min(1).optional(),
    gains: z.literal(true).optional(),
  }),
  // The item used breaks in an explosion as wide as `radius` round its bearer, dealing Force damage by the charges
  // left in its `resource`: `self` times them to the bearer, unless a d100 of 50 or less sends it away first, and
  // `others` times them to each other creature there, halved by a Dexterity save against `dc`, as a Staff of Power's
  // Retributive Strike. shortcut: a bearer sent away stays in the fight, as other planes aren't played.
  z.strictObject({
    kind: z.literal("retribution"),
    resource: z.string().min(1),
    radius: z.number().int().min(5),
    self: z.number().int().min(1),
    others: z.number().int().min(1),
    dc: z.number().int().min(1),
  }),
  // Responses to a d20 roll made before its result applies (combat/reactions.ts): the roller rolls the die again
  // and must use the new roll, as with Bountiful Luck; the roll gains or loses `amount`, as with Boon of Fate
  // (`either`) or a sphinx's Burst of Ingenuity; or the bearer rolls a d20 that may stand in for it, as with
  // Portent.
  // `advantage` rerolls with Advantage, as Countercharm; `straight` with neither edge, as Restore Balance takes the
  // roll's Advantage or Disadvantage away; `tempHp` goes to the roller if the new roll succeeds, as Reweave Fate's.
  z.strictObject({
    kind: z.literal("reroll"),
    advantage: z.literal(true).optional(),
    straight: z.literal(true).optional(),
    tempHp: AmountSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("rollBonus"),
    amount: AmountSchema,
    either: z.boolean().default(false),
  }),
  // With `value`, the d20 shows that instead, as Stroke of Luck's 20.
  z.strictObject({
    kind: z.literal("replaceRoll"),
    value: z.number().int().min(1).max(20).optional(),
    foretold: z.literal(true).optional(), // one of the bearer's foretelling rolls, as Portent's
  }),
  // The roll succeeds instead, as Noble Scion's Minor Wish.
  z.strictObject({ kind: z.literal("succeed") }),
  // The bearer makes one attack against the creature that set the reaction off: the action named, or else an
  // Opportunity Attack with its melee weapon. `approach` moves it next to the creature first without provoking,
  // as with Bloodthirsty Slash.
  z.strictObject({
    kind: z.literal("strike"),
    action: z.string().optional(),
    advantage: z.boolean().default(false),
    approach: z.boolean().default(false),
    // A teleport it uses lands within this many feet of the creature that set it off, as with Pursuit.
    near: z.number().int().min(5).optional(),
    ranged: z.literal(true).optional(), // with its ranged weapon instead, as Masterful Shots' shot back
    damage: AmountSchema.optional(), // added to the attack's damage, as Riposte's Superiority Die
    // the attack is with the weapon whose item's activation this is, and its damage ignores Resistance and
    // Immunity, as a Sword of Answering's
    ownWeapon: z.literal(true).optional(),
    overcomes: z.literal(true).optional(),
  }),
  // A Small or Medium ally within 5 feet trades places with the bearer and becomes the attack's target, as with
  // Redirect Attack; with `charmed`, any Charmed creature there instead.
  // With `cover`, a creature within 5 feet that stands between the attacker and the bearer becomes the target
  // instead, nobody moving, as Misdirection.
  z.strictObject({
    kind: z.literal("redirect"),
    charmed: z.boolean().default(false),
    cover: z.literal(true).optional(),
  }),
  // The bearer becomes the attack's target instead of the ally it was made against, as with an Arrow-Catching
  // Shield (combat/attack.ts).
  z.strictObject({ kind: z.literal("drawAttack") }),
  // The weapon of the attack that missed sticks for as long as the grapple this reaction makes holds, as with
  // Sticky Shield (combat/reactions.ts).
  z.strictObject({ kind: z.literal("stickWeapon") }),
  // The triggering attack misses instead, as with Jinx on a failed save or Illusory Self. With `retarget`, it goes on
  // at another creature within its reach or range, with the same roll, as Instinctive Charm turns it.
  z.strictObject({
    kind: z.literal("negateHit"),
    retarget: z.literal(true).optional(),
  }),
  // The spell that set the reaction off passes the bearer by, and one of level 1 or more that the bearer has slots
  // for is stolen: the bearer has it prepared, and its caster can't cast it, for `minutes`, as Spell Thief.
  z.strictObject({
    kind: z.literal("stealSpell"),
    minutes: z.number().int().min(1).default(480),
  }),
  // Up to `creatures` of the bearer's foes it can see within `range`, the nearest, take this damage, as Deflecting
  // Shroud's Force.
  z.strictObject({
    kind: z.literal("foesTake"),
    creatures: z.number().int().min(1),
    range: z.number().int().min(5),
    damage: z.array(DamageSchema).min(1),
  }),
  // The target's Concentration ends, as entering a Rage does.
  z.strictObject({ kind: z.literal("endConcentration") }),
  // The caster picks one of these sets of modifiers for the target, for `duration`, as Alter Self's options or
  // Enlarge/Reduce's (combat/effects.ts). The player is asked; anyone else takes the first.
  z.strictObject({
    kind: z.literal("choose"),
    duration: DurationSchema,
    options: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          modifiers: z.array(ModifierSchema).min(1),
          foe: z.literal(true).optional(), // offered first, and taken, for a target of the other side, as Reduce
          tempHp: AmountSchema.optional(), // Temporary Hit Points with it, as Guardian of Nature's Great Tree
        }),
      )
      .min(2),
  }),
  // The target is lost to its side, turned for good into this monster fighting for the other one, as swallowing an
  // Orb of Damara (combat/effects.ts). With `chance`, only that percent for each time before plus this one, counted
  // by spending a use of `counter`, as the Crown of Horns' 10 percent more each use.
  z.strictObject({
    kind: z.literal("becomeMonster"),
    monster: ContentIdSchema,
    chance: z.number().int().min(1).max(100).optional(),
    counter: z.string().min(1).optional(),
  }),
  // The caster senses how many illusions, creatures in a shape not their own and disguises are within `feet`, but
  // nothing more about them, as Unerring Eye (combat/effects.ts).
  z.strictObject({
    kind: z.literal("senseDeceptions"),
    feet: z.number().int().min(5),
  }),
  // An object of the caster's illusions from spells cast with a slot becomes real for `minutes`, a wall where its
  // image stands, as Illusory Reality.
  z.strictObject({
    kind: z.literal("realImage"),
    minutes: z.number().int().min(1),
  }),
  // The caster swaps places with its image of one of these features or spells, as Trickster's Transposition.
  z.strictObject({
    kind: z.literal("swapImage"),
    sources: z.array(ContentIdSchema).min(1),
  }),
  // The target's effects from these features' activations end, as leaving Wild Shape or taking another Starry Form.
  z.strictObject({
    kind: z.literal("endOwn"),
    features: z.array(ContentIdSchema).min(1),
  }),
  // The triggering Critical Hit is a normal hit instead, as Sentinel at Death's Door makes it.
  z.strictObject({ kind: z.literal("noCritical") }),
  // The melee attack that missed the bearer hits another creature of its choice within 5 feet of it instead, as
  // Tipsy Sway's Redirect Attack (combat/reactions.ts).
  z.strictObject({ kind: z.literal("redirectMiss") }),
  // Lifts the target `feet` up, where it can't move and nothing below reaches it, until `duration` is over and it
  // falls, as with Reverse Gravity (combat/falling.ts). With `grab`, a creature beside a wall may save to hold on.
  z.strictObject({
    kind: z.literal("lift"),
    feet: z.number().int().min(10),
    duration: DurationSchema,
    gentle: z.literal(true).optional(), // floats down unhurt once it ends, as with Levitate
    grab: z
      .strictObject({ ability: AbilitySchema, dc: FormulaSchema })
      .optional(),
  }),
  // Up to `creatures` falling creatures land without taking damage, as with Feather Fall (combat/falling.ts).
  // With `reduce`, the fall's damage is only lessened by that much, worked out from the bearer, as Slow Fall's five
  // times the Monk level.
  z.strictObject({
    kind: z.literal("slowFall"),
    creatures: z.number().int().min(1).default(5),
    reduce: FormulaSchema.optional(),
  }),
  // The bearer splits in two, each with half its Hit Points, as a black pudding does, while it has at least `minHp`
  // and has split fewer than `times` times (once for each size it can shrink).
  z.strictObject({
    kind: z.literal("split"),
    minHp: z.number().int().min(1).default(10),
    times: z.number().int().min(1).default(1),
  }),
  // The bearer and the target trade places, which provokes nothing, as with Bait and Switch.
  z.strictObject({ kind: z.literal("swapPlaces") }),
  // The bearer trades Initiative with a willing ally, as with Alert's Initiative Swap.
  z.strictObject({ kind: z.literal("swapInitiative") }),
  // The bearer gains Heroic Inspiration, as with Tireless Reveler.
  z.strictObject({ kind: z.literal("inspiration") }),
  // Resistance to the damage that set the reaction off, as with Elemental Absorption, and with `lasting` to that type
  // for so long, as Superior Hunter's Defense to the end of the turn; `hitDamage` of that type goes on the bearer's
  // next weapon hit, as Absorb Elements' 1d6.
  z.strictObject({
    kind: z.literal("resistTrigger"),
    lasting: DurationSchema.optional(),
    hitDamage: AmountSchema.optional(),
  }),
  // Creatures that join the fight on the caster's side, using a companion stat block's `play` numbers at the
  // slot's level, in open squares within `range` feet nearest the foes. They take their turns right after the
  // caster's, and vanish at 0 Hit Points or when the spell ends. `dc` is the caster's spell save DC, which their
  // saves and spell attacks use, and `count` how many come, as Animate Objects' spellcasting modifier.
  z.strictObject({
    kind: z.literal("summon"),
    companion: ContentIdSchema,
    duration: DurationSchema,
    range: z.number().int().min(5),
    count: FormulaSchema.default({ base: 1, add: [] }),
    dc: FormulaSchema.default({ base: 0, add: [{ kind: "spellSaveDc" }] }),
    form: z.string().min(1).optional(), // one of the companion's forms, by name, picked through the cast's `shapes`
    halfHp: z.literal(true).optional(), // each with half its Hit Point maximum, as Splintered Summons
    // the level its numbers grow with, from the caster's numbers, for a feature's, as an Eldritch Cannon's Artificer level
    level: FormulaSchema.optional(),
  }),
  // A strong wind: it ends the gas and vapour zones in its area, as Gust of Wind does Fog Cloud.
  // With `zones`, it ends the spells' zones of those kinds in its area instead, as Sunburst does Darkness.
  // With `maxLevel`, it ends those of a spell of that level or lower whose area overlaps its own, as Daylight ends
  // Darkness of level 3 or lower.
  z.strictObject({
    kind: z.literal("disperse"),
    zones: z.array(ZoneKindSchema).min(1).optional(),
    maxLevel: z.number().int().min(0).max(9).optional(),
  }),
  // The caster takes this many turns in a row, ending once something it does reaches another creature, as Time Stop.
  z.strictObject({ kind: z.literal("extraTurns"), turns: AmountSchema }),
  // A failed save's damage also lowers the target's Hit Point maximum by as much, until a Long Rest and never below 1,
  // as Harm's (combat/effects.ts, by the save's own damage).
  z.strictObject({ kind: z.literal("drainMaxHp") }),
  // A failed save's damage that drops the target to 0 Hit Points turns it to dust, dead outright, as Disintegrate.
  // Only a raising whose targeting has `dust` brings it back, as True Resurrection.
  z.strictObject({ kind: z.literal("disintegrate") }),
  // The target drops what it holds, as from Fear (combat/fear.ts).
  z.strictObject({
    kind: z.literal("drop"),
    option: z.string().min(1).optional(), // as an applyCondition's, as Command's Drop
  }),
  // The target is sent off to another plane, gone from the fight for good: only one of these lowercase types with
  // `creatureTypes`, as Divine Word's Celestials and Fiends, and with `crByLevel` only one whose Challenge Rating is at
  // most the one for the caster's level in `class`, as Arcane Abjuration's banishing (combat/fear.ts).
  z.strictObject({
    kind: z.literal("sendAway"),
    creatureTypes: z.array(z.string()).min(1).optional(),
    crByLevel: z
      .strictObject({
        class: ContentIdSchema,
        at: z
          .array(z.strictObject({ level: z.number().int(), cr: z.number() }))
          .min(1),
      })
      .optional(),
  }),
  // The target spends one of its Hit Point Dice and regains what it rolls plus `bonus`, as with Healer's Battle Medic.
  // Rolls up to `dice` of the target's Hit Point Dice (stopping once it is whole) and adds `bonus` once.
  z.strictObject({
    kind: z.literal("hitDieHeal"),
    bonus: FormulaSchema,
    dice: z.number().int().min(2).optional(),
  }),
  // The bearer takes another of its stat block's own shapes, by name, or goes back to its true one (core/forms.ts).
  z.strictObject({ kind: z.literal("shapeShift"), shape: z.string().min(1) }),
  // One of the bearer's own actions picked at random, `times` over, never one already used this turn, at the same
  // target, as a beholder zombie's Eye Rays (combat/effects.ts). Those actions are marked `rolled`.
  // A spell's own `rolled` activations are picked from instead, by label, as Prismatic Spray's rays, where
  // `repeats` lets each target get any of them, and `twiceOnTop` rolls a die one larger than the list whose top
  // face picks two, rolling that face again.
  z.strictObject({
    kind: z.literal("randomAction"),
    of: z.array(z.string().min(1)).min(2),
    times: z.number().int().min(1).default(1),
    repeats: z.literal(true).optional(),
    twiceOnTop: z.literal(true).optional(),
  }),
  // The caster makes `times` attacks with a weapon of its own that reaches the target, changed as `change` says,
  // as True Strike or Swift Quiver (combat/weapon-spell.ts).
  z.strictObject({
    kind: z.literal("weaponAttack"),
    times: z.number().int().min(1).default(1),
    change: WeaponChangeSchema.default({}),
  }),
  // The caster picks another spell of this level or lower that plays on the grid, and it takes effect without its
  // costs, as Wish's (combat/wish.ts).
  // With `classes`, only spells of these classes' lists (by name after the plugin), and with `noReaction` none cast
  // as a Reaction, as Divine Intervention's Cleric spells; with `spells` only these, as Greater Divine Intervention's
  // Wish.
  z.strictObject({
    kind: z.literal("copySpell"),
    maxLevel: z.number().int().min(0).max(9),
    classes: z.array(z.string().min(1)).min(1).optional(),
    noReaction: z.literal(true).optional(),
    spells: z.array(ContentIdSchema).min(1).optional(),
    // Other choices beside a copied spell, as Wish's Instant Health: `effects` on the caster, and with `allies` on
    // each of its allies standing too; `stress` puts these on the caster after, as Wish's stress (combat/wish.ts).
    extras: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          effects: z.array(z.unknown()).min(1), // leaf effects, parsed as used (combat/wish.ts)
          allies: z.literal(true).optional(),
        }),
      )
      .min(1)
      .optional(),
    stress: z.array(z.unknown()).min(1).optional(), // leaf effects too
  }),
  // A corpse of these types within `range` rises as this monster on the bearer's side, as a wraith's Create Specter.
  // A dying creature becomes Stable, as with Spare the Dying.
  z.strictObject({ kind: z.literal("stabilize") }),
  // The target drops the weapon it holds: a character's lands in its space to pick up again, and a monster can't use
  // its weapon attack until its next turn starts, when it takes it up again, as Disarming Attack.
  z.strictObject({ kind: z.literal("disarm") }),
  // The caster takes `amount` of `type` damage, which nothing lessens, and the target regains `times` as much, as
  // Life Transference.
  z.strictObject({
    kind: z.literal("transference"),
    amount: AmountSchema,
    type: DamageTypeSchema,
    times: z.number().int().min(1).default(2),
  }),
  // A dead creature comes back in a new body of a species rolled from these, in order, and picks what that species
  // asks for (core/reincarnate.ts), as Reincarnate.
  z.strictObject({
    kind: z.literal("reincarnate"),
    species: z.array(ContentIdSchema).min(2),
  }),
  // A clone of the target starts growing, ready after `days`; once it is, the target dying wakes in it whole, as Clone.
  // shortcut: a day passes with each Long Rest, the only clock between scenes, and the clone keeps the gear.
  z.strictObject({ kind: z.literal("clone"), days: z.number().int().min(1) }),
  // Moves the bearer's area of the spell `source` to where this is aimed, as Moonbeam moved with a Magic action.
  z.strictObject({ kind: z.literal("moveZone"), source: z.string() }),
  // The target takes its Reaction to make a melee attack against a creature in its reach, one of its own side
  // first, or takes this damage when none is, as a gallows speaker's Aura of Violence.
  z.strictObject({
    kind: z.literal("forcedAttack"),
    otherwise: z.array(DamageSchema).default([]),
  }),
  // A target with this many Hit Points or fewer dies outright instead of taking the damage, as Power Word Kill.
  z.strictObject({
    kind: z.literal("slay"),
    hpAtMost: z.number().int().min(1),
    chance: z.number().int().min(1).max(100).optional(), // only this many percent of the time, as the Eye of Vecna's doom
    creatureTypes: z.array(z.string()).min(1).optional(), // only these types, as a Mace of Smiting's Construct
  }),
  // A concentrating target saves with Constitution against this DC or its Concentration ends, as a Thunderous
  // Greatclub's Earthquake shakes it.
  z.strictObject({
    kind: z.literal("concentrationSave"),
    dc: z.number().int().min(1),
  }),
  // A Vorpal Sword's beheading: the target dies, unless it has Immunity to the damage's type, is of a type in
  // `spares` that has or needs no head, or spends a Legendary Resistance, and then takes `damage` instead.
  // shortcut: no creature is too big for the sword.
  z.strictObject({
    kind: z.literal("behead"),
    damage: z.array(DamageSchema).min(1),
    spares: z.array(z.string()).min(1).optional(),
  }),
  // Damage to another creature within `feet` of the target, the nearest of the caster's foes there, and `perTier` dice
  // more for each cantrip tier past the first, as Green-Flame Blade's leaping fire. shortcut: the nearest foe, not
  // the one the player picks.
  z.strictObject({
    kind: z.literal("splash"),
    feet: z.number().int().min(5),
    damage: z.array(DamageSchema).min(1),
    perTier: DiceSchema.optional(),
  }),
  // The target gains this many levels of Exhaustion, as a sphinx's Weight of Years, or with `clear` loses them
  // all, as from a Potion of Vitality.
  z
    .strictObject({
      kind: z.literal("exhaustion"),
      levels: z.number().int().min(1).optional(),
      clear: z.literal(true).optional(),
    })
    .refine((effect) => (effect.levels === undefined) !== !effect.clear, {
      message: "needs levels or clear",
    }),
  // `count` of this monster (the bearer's own stat block when left out) come to life in open squares within `range`
  // on the bearer's side, without the actions named in `lacks`, taking their turns right after the bearer's, as a
  // treant's Animate Trees or a priest's Soul Tattoo.
  // Creatures the caster keeps between fights, `count` of this monster worked out from its numbers (a `slotLevel` term
  // is the slot's level), joining each fight beside it until they drop or, with `lasts: "longRest"`, the next Long Rest,
  // as Animate Dead's undead (combat/familiar.ts retinueActors).
  // shortcut: no corpse or bones are needed, and control isn't reasserted; a Long Rest ends it.
  z.strictObject({
    kind: z.literal("retain"),
    monster: ContentIdSchema,
    count: FormulaSchema.default({ base: 1, add: [] }),
    lasts: z.enum(["longRest", "ever"]).default("longRest"),
  }),
  // With `duration` they last as long as the spell or item use that called them, vanishing when its Concentration ends,
  // as an elemental from a Bowl of Commanding Water Elementals; `hostile` puts them on the other side, as a Staff of
  // the Lost's Minotaurs.
  z.strictObject({
    kind: z.literal("animate"),
    monster: ContentIdSchema.optional(),
    count: z.number().int().min(1).default(1),
    range: z.number().int().min(5),
    lacks: z.array(z.string().min(1)).default([]),
    duration: DurationSchema.optional(),
    hostile: z.literal(true).optional(),
    chance: z.number().int().min(1).max(100).optional(), // only this many percent of the time, as a Staff of the Lost's 1 in 20
  }),
  // The target spends its Reaction on one melee attack against a foe in its reach, as a gnoll pack lord's Incite
  // Rampage.
  z.strictObject({ kind: z.literal("reactionAttack") }),
  // The target spends its Reaction to move up to its Speed beside its nearest foe, without provoking Opportunity
  // Attacks, as Ez d'Avenir's Inspiring Rally. With `away` it moves as far from the caster as it can instead, as
  // Dissonant Whispers drives it.
  z.strictObject({
    kind: z.literal("reactionMove"),
    away: z.literal(true).optional(),
    half: z.literal(true).optional(), // up to half its Speed, as Maneuvering Attack's comrade
  }),
  z.strictObject({
    kind: z.literal("raiseCorpse"),
    monster: ContentIdSchema,
    range: z.number().int().min(5),
    creatureTypes: z.array(CreatureTypeSchema).min(1),
    all: z.boolean().default(false), // every such corpse, not one
    // only the target, once this action has killed it, as Finger of Death's Humanoid rising as a Zombie
    slain: z.literal(true).optional(),
  }),
]);
export type LeafEffect = z.infer<typeof LeafEffectSchema>;

const LeafEffectsSchema = z.array(LeafEffectSchema).default([]);

// Nesting stops at one level on purpose: a small model can only produce non-recursive output reliably.
// Each of the caster's foes within `radius` of a target saves or takes `damage`, half on a success with `half`: Ice
// Knife's shard round an attack's target, or Jolt to Life's lightning round the creature it revives.
const BurstSchema = z.strictObject({
  radius: z.number().int().min(5),
  ability: AbilitySchema,
  dc: FormulaSchema,
  damage: z.array(DamageSchema).min(1),
  half: z.literal(true).optional(),
  others: z.literal(true).optional(), // only those round the target, not the target itself, as Detonate's explosion
  // the saves have Disadvantage when the spell dropped the target to 0 Hit Points, as Detonate's
  dropped: z.literal("disadvantage").optional(),
  everyone: z.literal(true).optional(), // each creature there, of either side, as Detonate's
});

export const OnHitSaveSchema = z.strictObject({
  ability: AbilitySchema,
  dc: FormulaSchema,
  damage: z.array(DamageSchema).default([]),
  onSuccessDamage: z.enum(["half", "none", "full"]).default("none"),
  onFail: LeafEffectsSchema,
  onSuccess: LeafEffectsSchema,
  exempt: z.array(z.string()).optional(),
  // Only once a turn, on the attacker's own turn, as Feral Pounce's Shove or Punch and Grab's Grapple.
  oncePerTurn: z.literal(true).optional(),
  onceKey: z.string().min(1).optional(), // the once-a-turn use it shares with other attacks, as Feral Pounce's two
  orDex: z.literal(true).optional(), // the target saves with Strength or Dexterity, whichever is better
  only: z.array(z.string()).min(1).optional(), // only creatures of these types make it, as a Giant Slayer's Giants
  // only a target the hit leaves with this many Hit Points or fewer makes it, as a Mace of Disruption's 25
  hpAtMost: z.number().int().min(1).optional(),
  // a failed save spends one of this resource, and with none left there's no save, as a Nine Lives Stealer's charges
  resource: z.string().min(1).optional(),
  // every other creature within this many feet of the target makes it too, but not the attacker, as a Hammer of
  // Thunderbolts' thunderclap
  radius: z.number().int().min(5).optional(),
  // only once each of the action's projectiles has hit the target this turn, as a Tentacle Rod's three tentacles
  allHit: z.literal(true).optional(),
});

// What a hit whose d20 rolled a 20 adds, or with `critical` any Critical Hit, as a Vorpal Sword's beheading or a
// Silvered Weapon's die against a shape-shifted creature (combat/attack.ts).
export const NaturalTwentySchema = z.strictObject({
  critical: z.literal(true).optional(),
  // only while the bearer is attuned to one of these too (or a version of it), as a Hammer of Thunderbolts' Giant's
  // Bane with a Belt of Giant Strength
  attunedTo: z.array(ContentIdSchema).min(1).optional(),
  damage: z.array(DamageSchema).default([]),
  onHit: LeafEffectsSchema,
  onHitSave: OnHitSaveSchema.optional(),
});

export const ResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("automatic"),
    damage: z.array(DamageSchema).default([]),
    effects: LeafEffectsSchema,
    burst: BurstSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("attack"),
    attack: z.strictObject({
      type: z.enum(["weapon", "spell"]),
      ability: AbilitySchema.optional(),
      flatBonus: z.number().int().optional(),
      proficient: z.boolean().optional(), // false for a weapon the wielder has no training with
      itemBonus: z.number().int().min(1).optional(), // a magic weapon's own bonus to hit
      // Beyond this many feet, out to the targeting's range, the roll has Disadvantage, as a thrown weapon's long range.
      normalRange: z.number().int().min(5).optional(),
      bypassCover: z.literal(true).optional(), // ignores Half and Three-Quarters Cover, as Spellfire Flare's blasts
      unarmed: z.literal(true).optional(), // an Unarmed Strike, as Martial Arts' or Vampiric Bite's
      finesse: z.literal(true).optional(), // a Finesse weapon a feature makes, as a Psychic Blade, for Sneak Attack
      // Advantage against a target in Dim Light or Darkness, as Shadow Blade's sword
      shadowAdvantage: z.literal(true).optional(),
    }),
    damage: z.array(DamageSchema).min(1),
    onHit: LeafEffectsSchema,
    onMiss: LeafEffectsSchema,
    // A save the target makes after a hit, as a ghoul's paralysing claw. Creatures of an `exempt` type or species
    // (lowercase) never make it.
    onHitSave: OnHitSaveSchema.optional(),
    // Effects on a hit once a turn, on the attacker's own turn, as Tavern Brawler's push.
    onHitOncePerTurn: z.array(LeafEffectSchema).min(1).optional(),
    // A hit heals the attacker by the damage dealt, spending a use, as a Dhampir's Vampiric Bite.
    drain: z.strictObject({ resource: z.string() }).optional(),
    missDamage: z.literal("half").optional(), // a miss still deals half the damage, as Acid Arrow's splash
    // Hit or miss, the target and each creature within `radius` of it then save or take `damage`, as Ice Knife's shard.
    burst: BurstSchema.optional(),
    natural20: NaturalTwentySchema.optional(),
    // A creature it damages has Disadvantage on the save to keep Concentration, as a Mage Breaker's.
    breaksConcentration: z.literal(true).optional(),
    // more to hit against creatures of these types, as a Mace of Smiting's +3 against a Construct
    vs: z
      .strictObject({
        creatureTypes: z.array(z.string()).min(1),
        bonus: z.number().int(),
      })
      .optional(),
    // Against a creature under an effect of this item's (its sworn enemy), the roll has Advantage, ignores Half and
    // Three-Quarters Cover and long range, and a hit deals `damage` too; while that creature lives, the bearer's other
    // weapon attacks have Disadvantage, as an Oathbow's (combat/attack.ts).
    sworn: z
      .strictObject({
        item: ContentIdSchema,
        damage: z.array(DamageSchema).default([]),
      })
      .optional(),
    // When two of its first damage's dice show the same number, the attack leaps to another creature within `feet` of
    // the one hit, never one it struck before, with a new roll: as often as the slot's level with `slotLevel`, as
    // Chromatic Orb's, or with no limit, as Chaos Bolt's (combat/leap.ts).
    leap: z
      .strictObject({
        feet: z.number().int().min(5),
        max: z.literal("slotLevel").optional(),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("save"),
    ability: AbilitySchema,
    dc: FormulaSchema,
    advantage: z.boolean().optional(), // the target saves with Advantage, as when its caster is fighting it
    // How the save goes for creatures of these lowercase types or this size or larger, as a Plant failing against
    // Blight, a Construct's Disadvantage against Shatter, a Large creature's Advantage against Ensnaring Strike or
    // an Undead succeeding against Wardaway.
    edges: z
      .array(
        z.strictObject({
          creatureTypes: z.array(z.string()).min(1).optional(),
          minSize: SizeSchema.optional(),
          // a creature whose score in this ability is at most this much, as Psychic Scream's Intelligence 2
          maxScore: z
            .strictObject({ ability: AbilitySchema, score: z.number().int() })
            .optional(),
          // a creature immune to this condition, as Mental Prison's that can't be Charmed
          immuneTo: ConditionSchema.optional(),
          // a creature its caster has Charmed, as Mantle of Majesty's Command fails on
          charmedByCaster: z.literal(true).optional(),
          // "immune" leaves the creature out altogether, as Cause Fear's Constructs and Undead
          roll: z.enum([
            "advantage",
            "disadvantage",
            "fail",
            "succeed",
            "immune",
          ]),
        }),
      )
      .min(1)
      .optional(),
    // A creature of the caster's side fails it by choice, as a willing target of Polymorph.
    willing: z.literal(true).optional(),
    // Only a target its damage leaves with this many Hit Points or fewer saves, as Banishing Smite's.
    hpAtMost: z.number().int().min(1).optional(),
    // A target with this many Hit Points or fewer dies outright instead, without a save, as Wail of the Banshee's 50.
    slayAtMost: z.number().int().min(1).optional(),
    // A target that can't hear (Deafened) is spared, as Wail of the Banshee's.
    heard: z.literal(true).optional(),
    damage: z.array(DamageSchema).default([]),
    // "full" deals the damage either way, and the save is only for its effects, as with Trip Attack.
    onSuccessDamage: z.enum(["half", "none", "full"]).default("none"),
    onFail: LeafEffectsSchema,
    onSuccess: LeafEffectsSchema,
    // with an area, one creature of the caster's choice in it, the most hurt of its side, also gets these, as Wither
    // and Bloom's Hit Point Dice
    chosen: z.array(LeafEffectSchema).min(1).optional(),
    // the damage lands only on a target that ends this near the caster once its effects are done, as Lightning Lure's
    damageWithin: z.number().int().min(5).optional(),
    burst: BurstSchema.optional(), // a save round each target once its own is done, as Detonate's explosion
  }),
]);
export type Resolution = z.infer<typeof ResolutionSchema>;

// What a lasting area does to the creatures in it (core/zones.ts). `side` counts from the creature it belongs to,
// and everyone is affected when it's left out; a moving area never affects its own bearer. `when` resolves
// `resolution` on a creature in it as that creature's turn starts or ends, or on everyone in it (up to `targets`)
// as its owner's turn starts or ends. `grants` are modifiers those in it have, as Marshal Undead's Advantage.
export const AreaEffectSchema = z.strictObject({
  side: z.enum(["enemy", "ally"]).optional(),
  creatureTypes: z.array(CreatureTypeSchema).min(1).optional(), // only these types, as Marshal Undead's undead
  exceptTypes: z.array(CreatureTypeSchema).min(1).optional(), // never these, as Antilife Shell's undead and constructs
  when: z
    .enum(["turnStart", "turnEnd", "ownerTurnStart", "ownerTurnEnd"])
    .optional(),
  resolution: ResolutionSchema.optional(),
  // it also acts on a creature that walks into it, and on each creature only once a turn, as Spirit Guardians
  enters: z.literal(true).optional(),
  bloodied: z.literal(true).optional(), // only on Bloodied creatures, as a Dead Three scion's Culling Aura
  // a success against a spell or magic that halves damage takes none, as Circle of Power
  magicWard: z.literal(true).optional(),
  // spellShield blocks one level higher for each slot level above the spell's, as Globe of Invulnerability
  shieldGrows: z.literal(true).optional(),
  // conditions those it affects have while in it, as Silence's Deafened
  conditions: z.array(ConditionSchema).min(1).optional(),
  // it moves this far away from its owner as each of the owner's turns starts, as Cloudkill
  drifts: z.number().int().min(5).optional(),
  // its owner can take an action on later turns to move it up to this far, as Moonbeam's Magic action
  moves: z.number().int().min(5).optional(),
  // moving it takes a Bonus Action instead, as Dancing Lights', or nothing, once a turn, as Shadow Arts' Darkness
  moveWith: z.enum(["bonusAction", "free"]).optional(),
  // while a creature has a condition from it, it acts only on that one, with this as that creature's turns start,
  // as Conjure Elemental's spirit holding the one it Restrained
  holding: ResolutionSchema.optional(),
  // a spell cast in it fails and is wasted unless the caster makes this save, as a haunting revenant's Haunted Zone
  foilsSpells: z
    .strictObject({ ability: AbilitySchema, dc: z.number().int().min(1) })
    .optional(),
  targets: z.number().int().min(1).optional(),
  grants: z.array(ModifierSchema).min(1).optional(),
  noHealing: z.literal(true).optional(), // no Hit Points regained in it, as Life Suppression
  difficult: z.literal(true).optional(), // costs double to cross, as Spirit Guardians' halved Speed
  noSpells: z.enum(["verbal", "all"]).optional(), // Silence's Verbal spells, or Antimagic Field's every spell
  spellShield: z.number().int().min(0).max(9).optional(), // spells this level or lower from outside can't reach in
  barrier: z.literal(true).optional(), // those it affects can't move into it, as Antilife Shell
  awake: z.literal(true).optional(), // only while its owner doesn't have the Incapacitated condition
  self: z.literal(true).optional(), // a moving area that covers its own bearer too, as Globe of Invulnerability
  maxDamage: z.number().int().min(1).optional(), // it ends once it has dealt this much, as Guardian of Faith
  disperses: z.literal(true).optional(), // a strong wind ends it, as Fog Cloud or Stinking Cloud
  grappling: z.literal(true).optional(), // only creatures its owner grapples or that grapple it, as Barbed Hide
  // what a creature it affects meets as it walks into the spell's wall, one after another, as Prismatic Wall's layers
  layers: z.array(ResolutionSchema).min(1).optional(),
});
export type AreaEffect = z.infer<typeof AreaEffectSchema>;

// Which hits a rider answers (combat/queries.ts hitFits): "unarmed" an Unarmed Strike, "monkWeapon" one or a Simple
// Melee or Light Martial Melee weapon, "magicWeapon" a magic one, "strength" a Strength-based one, "heavy" a Heavy
// weapon's ("heavyOrVersatile" or a Versatile one's), "finesseOrRanged" a Finesse or Ranged weapon's (a monster's any), as Sneak Attack's, and "attack" any
// attack roll, a spell's too, as Hurl Through Hell's.
export const HitKindSchema = z.enum([
  "weapon",
  "pactWeapon", // the melee weapon a Warlock's Pact of the Blade bonds with: the first one it holds
  "heldMelee", // the melee weapon it holds, the first one, as Sacred Weapon's
  "meleeWeapon",
  "rangedWeapon",
  "unarmed",
  "monkWeapon",
  "magicWeapon",
  "strength",
  "heavy",
  "heavyOrVersatile",
  "finesseOrRanged",
  "meleeSpell", // a melee spell attack, as a Spell Duelist's Trophy's Dispelling Touch
  "attack",
]);
export type HitKind = z.infer<typeof HitKindSchema>;

const CostSchema = z.union([
  z.enum(["action", "bonusAction", "reaction", "slot"]),
  // `count` spends that many at once, as Lay On Hands' 5 Hit Points to end Poisoned.
  z.strictObject({
    resource: z.string(),
    count: z.number().int().min(2).optional(),
  }),
  // A costly material component the spell consumes, paid from the party's gold, as Revivify's 300 GP diamond.
  z.strictObject({ gold: z.number().min(0) }),
]);
export type Cost = z.infer<typeof CostSchema>;

const SideSchema = z.enum(["enemy", "ally"]);
const RangeSchema = z.union([z.number(), z.enum(["self", "touch"])]);

export const TargetingSchema = z.union([
  z.strictObject({ self: z.literal(true) }),
  z.strictObject({
    creatures: z.number().int().min(1),
    // as many as this ability's modifier when more, as Abjure Foes' Charisma modifier (stats.ts)
    creaturesBy: AbilitySchema.optional(),
    // this ability's modifier more, as Wind Soul's 3 plus the Charisma modifier
    creaturesPlus: AbilitySchema.optional(),
    range: RangeSchema,
    // "any" is a creature of either side, as Dispel Magic aimed at a friend's curse or a foe's spell
    side: z.enum(["enemy", "ally", "any"]),
    creatureTypes: z.array(CreatureTypeSchema).optional(), // only these types can be targeted
    targetConditions: z.array(ConditionSchema).min(1).optional(), // only a creature with one of these, as for Trample
    dead: z.literal(true).optional(), // only a dead creature, as for Revivify
    // with `dead`, only one dead no longer than this many hours, as Raise Dead's 10 days (240). Rests pass time
    // (state.ts REST_HOURS) and so does going to another scene (an hour), so 0 is a death in this scene since the
    // last rest; `diedWithinRounds` also counts the rounds of the fight it died in, as Revivify's minute (10).
    diedWithin: z.number().int().min(0).optional(),
    diedWithinRounds: z.number().int().min(0).optional(),
    dust: z.literal(true).optional(), // with `dead`, even one turned to dust, as True Resurrection
    // only a creature this size or smaller, as for a giant frog's Swallow
    maxSize: z
      .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
      .optional(),
    bloodied: z.literal(true).optional(), // only a Bloodied creature, as for a gnoll's Rampage
    swimmers: z.literal(true).optional(), // only a creature with a Swim Speed, as a Trident of Fish Command's
    downed: z.literal(true).optional(), // only a living creature at 0 Hit Points, as for a will-o'-wisp's Consume Life
    // only a creature under an effect of the bearer's action of this name, as a nightmare's spear curse for Narcotize
    afflicted: z.string().min(1).optional(),
    // a melee attack that reaches past 5 feet, as a Glaive's, so its range is its reach (combat/queries.ts isMelee)
    reach: z.literal(true).optional(),
  }),
  z.strictObject({
    area: z.strictObject({
      shape: z.enum(["sphere", "cone", "cube", "line", "emanation"]),
      radius: z.number(),
      width: z.number().int().min(10).optional(), // a line this many feet wide, as Festering Blast's 10, not 5
    }),
    range: RangeSchema,
    side: SideSchema,
    creatureTypes: z.array(CreatureTypeSchema).optional(),
    targetConditions: z.array(ConditionSchema).min(1).optional(), // only those with one of these, as Intensify Poison
    afflicted: z.string().min(1).optional(), // as a creature target's, as an arch-hag's Witch Strike
    choice: z.literal(true).optional(), // only the creatures of the caster's choice in it, its `side`, as Conjure Barrage
    bloodied: z.literal(true).optional(), // only the Bloodied in it, as Turn the Tide's creatures at half Hit Points
  }),
]);
export type Targeting = z.infer<typeof TargetingSchema>;

// A table rolled on (combat/reactions.ts tableRoll), as Mythal Ward's or the Wild Magic Surge table. The row the die
// lands on is resolved at the bearer (`self`), the creature that set it off (`source`), the creature the roll is aimed
// at (`target`), and with `within` each creature that near the bearer. `perSpellLevel` multiplies its damage dice by
// the level of the spell that set it off; `negate` makes that spell do nothing to the bearer. A row's `spell` is cast
// at its targets with `dc`, `attack` and `level` (the bearer's own numbers when left out), and a row's `table` is
// rolled on in turn, as a surge's d10 of spells. `harmful` rows are the ones a pick of two avoids (tactics.ts).
// shortcut: an area spell from a row hits only the row's targets.
const TableRowSchema = z.strictObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
  targets: z.array(z.enum(["self", "source", "target"])).default([]),
  within: z.number().int().min(5).optional(),
  perSpellLevel: z.literal(true).optional(),
  negate: z.literal(true).optional(),
  harmful: z.literal(true).optional(),
  resolution: ResolutionSchema.optional(),
  spell: ContentIdSchema.optional(),
  dc: z.number().int().min(1).optional(),
  attack: z.number().int().optional(),
  level: z.number().int().min(0).max(9).optional(),
});
const InnerTableSchema = z.strictObject({
  die: z.number().int().min(2),
  rows: z.array(TableRowSchema).min(1),
});
export const TableSchema = z.strictObject({
  die: z.number().int().min(2),
  rows: z
    .array(TableRowSchema.extend({ table: InnerTableSchema.optional() }))
    .min(1),
});
export type Table = z.infer<typeof TableSchema>;
export type TableRow = z.infer<typeof TableRowSchema>;

export const ActivationSchema = z.strictObject({
  cost: z.array(CostSchema),
  trigger: z
    .strictObject({
      hitByAttack: z.literal(true).optional(),
      melee: z.literal(true).optional(), // only a melee attack's hit triggers it, as with Parry
      // Taken when this spell of a foe's is aimed at the bearer, which it then passes by, as Shield against Magic
      // Missile; or with `spellTargets` any spell that targets it or catches it in its area, before it lands on it, as
      // Spell Thief (combat/reactions.ts spellAimedAt).
      targetedBySpell: z.string().optional(),
      spellTargets: z.literal(true).optional(),
      // Taken when a foe it can see within the activation's range casts a spell, as with Counterspell.
      spellCast: z.literal(true).optional(),
      teleports: z.literal(true).optional(), // with `spellCast`, a teleport too, as Magic-User's Nemesis
      // Taken right after hitting with a weapon, as with the smite spells. An area it targets is centred on the
      // creature hit, as Hail of Thorns' is.
      afterHit: HitKindSchema.optional(),
      // With `afterHit`, a strike option chosen before the damage is rolled, giving up this many of the hit's Sneak
      // Attack dice, as Cunning Strike's Poison (combat/strikes.ts). It's offered only when Sneak Attack lands.
      forgo: z.number().int().min(1).optional(),
      // With `afterHit`, a strike option chosen before an attack roll that has Advantage, which then has none, as
      // Brutal Strike's (combat/strikes.ts).
      forgoAdvantage: z.literal(true).optional(),
      // With `afterHit`, a strike option chosen before an attack roll without Advantage, which then has it, as a
      // Martialist's Quarterstaff's Trip (combat/strikes.ts). shortcut: its cost is paid only on a hit.
      gainsAdvantage: z.literal(true).optional(),
      // With `afterHit`, an option chosen before an attack roll without Advantage whose d20 then shows this, unrolled,
      // as a Clockwork Amulet's 10. Its cost is paid as it's picked.
      fixedRoll: z.number().int().min(1).max(20).optional(),
      // With `afterHit`, only once the hit has dealt Sneak Attack damage, as Wails from the Grave.
      sneakAttack: z.literal(true).optional(),
      // With `afterHit`, offered only right after an `afterHit` activation of this feature or spell lands on the same
      // hit, as Stalker's Flurry's effects after Dreadful Strike or Elemental Smite's after Divine Smite.
      following: z.array(ContentIdSchema).min(1).optional(),
      // With `afterHit`, only on the bearer's own turn, as Shield Bash or Charge Attack.
      ownTurn: z.literal(true).optional(),
      // With `afterHit`, only right after a walk of at least this many feet in a straight line toward the target, as
      // Charge Attack.
      charge: z.number().int().min(5).optional(),
      // With `afterHit`, only a hit that can deal this damage type, as Burst of Sunlight's Radiant.
      dealing: DamageTypeSchema.optional(),
      // With `afterHit`, only a hit with this feature's own attacks, as Rend Mind's Psychic Blades.
      withFeature: ContentIdSchema.optional(),
      // With `afterHit`, aimed at another creature within this many feet of the one hit (of the targeting's side,
      // within its range), as Sweeping Attack, and with `sameRoll` only one the hit's attack roll would also hit.
      near: z.number().int().min(5).optional(),
      sameRoll: z.literal(true).optional(),
      // With `afterHit`, only a hit on a creature under an effect of the bearer's from one of these, as Superior
      // Hunter's Prey's Hunter's Mark.
      marked: z.array(ContentIdSchema).min(1).optional(),
      // With `afterHit`, taken as the attack hits or misses, in place of what it does: the target takes this, or
      // half on a miss, and an area is round the target without it, as Lightning Arrow.
      // An empty list deals nothing to the target itself, as Piercing Arrow's line or Seeking Arrow's save.
      replacesHit: z.array(DamageSchema).optional(),
      hitOnly: z.literal(true).optional(), // with `replacesHit`, offered only on a hit, as an Energy Bow's Arrow of Restraint
      // With `afterHit`, a strike option picked before the damage that makes the hit a Critical Hit, as a Namer's
      // Needle's Named Target (combat/strikes.ts).
      critical: z.literal(true).optional(),
      // Taken for another creature within 5 feet that a creature the bearer can see attacks, before the roll, or hits,
      // as with Protection and Interception. It's taken as soon as it can be.
      allyAttacked: z.literal(true).optional(),
      allyHit: z.literal(true).optional(),
      // what the bearer must hold to take it; "polearm" is a Quarterstaff, a Spear or a Heavy weapon with Reach,
      // and "finesse" a Finesse weapon, as Defensive Duelist's
      holding: z
        .enum(["shield", "shieldOrWeapon", "polearm", "finesse"])
        .optional(),
      // Taken by the bearer when a creature attacks it, before the roll, giving that roll Disadvantage, as with
      // Lucky. It's taken on its own once the bearer is at half its Hit Points or fewer, or the attacker has
      // Advantage.
      attacked: z.literal(true).optional(),
      noAdvantage: z.literal(true).optional(), // with `attacked`, only a roll without Advantage, as XGE's Shadowy Dodge
      // Taken right after a creature's attack damages the bearer, against that creature, as with Storm's Thunder.
      damaged: z.literal(true).optional(),
      damagedBy: z.array(DamageTypeSchema).min(1).optional(), // only damage of these types, as with Delicious Pain
      // With `damaged`, taken before the damage applies, so it can lessen it, as with Vitality Ward. With `ownSave`,
      // taken before a failed save's effect lands, as with Mythal Ward.
      before: z.literal(true).optional(),
      // With `damaged` and `damagedBy`, damage of any type that leaves the bearer Bloodied also counts, as with a
      // black pudding's Split.
      bloodied: z.literal(true).optional(),
      // Only a ranged attack's hit triggers it, as with Deflect Missile.
      ranged: z.literal(true).optional(),
      // How near the creature that sets it off must be, in feet: the attacker for `damaged` or `struck`, the
      // roller for `rolled`, the ally for `allyAttacked` and `allyHit` (5 when unset), the walker for
      // `entersReach`, `endsMove` and `turnStart`.
      within: z.number().int().min(5).optional(),
      // Taken after a d20 roll and before its result applies, as with Bountiful Luck or Portent (combat/reactions.ts).
      // `by` is whose roll, from the bearer's side; `when` what it must show: a natural 1, a hit on the bearer or
      // its ally (`hit`), a failure, or anything; `magical` only a save against a spell or magic. `hitOrFailed` is
      // a foe's hit on an ally or an ally's failed save, as Defensive Divination answers.
      rolled: z
        .strictObject({
          rolls: z.array(z.enum(["attack", "save", "check"])).min(1),
          // "others" is anyone but the bearer, as Bend Luck's
          by: z.enum(["self", "ally", "selfOrAlly", "foe", "any", "others"]),
          // "succeeded" only a roll that succeeds, as a Crystal Ball of Ominous Portent's turning it into a 1
          when: z
            .enum([
              "natural1",
              "hit",
              "failed",
              "hitOrFailed",
              "succeeded",
              "any",
            ])
            .default("any"),
          magical: z.literal(true).optional(),
          // only a save to avoid or end one of these conditions, as Countercharm's Charmed or Frightened
          conditions: z.array(ConditionSchema).min(1).optional(),
          // only a roll with Advantage or Disadvantage, as Restore Balance
          edged: z.literal(true).optional(),
        })
        .optional(),
      // Taken right after an attack hits the bearer (`struck`) or misses it (`missed`), as with Counterattack or
      // Sticky Shield; or after a foe within `within` hits someone else, as with Sentinel's Guardian.
      struck: z.literal(true).optional(),
      missed: z.literal(true).optional(),
      foeHitsOther: z.literal(true).optional(),
      // Taken when another creature this Bloodied takes damage within `within`, as with Bloodthirsty Slash.
      otherDamaged: z.literal("bloodied").optional(),
      // Taken when an enemy walks into the bearer's reach, or within `within`, as with Polearm Master's Reactive
      // Strike; when one ends its move within `within`, as with Pursuit; or when one starts its turn there and can
      // see the bearer, as with Unnerving Gaze.
      entersReach: z.literal(true).optional(),
      endsMove: z.literal(true).optional(),
      turnStart: z.literal(true).optional(),
      // With `turnStart`, only a Frightened creature sets it off, as Boon of Terror's Flee, Fools!
      frightened: z.literal(true).optional(),
      // Taken after the bearer's own save against a creature's effect fails or succeeds, as with Mind Corrosion, or
      // an ally's within `within`, as with Beguiling Twist; with `conditions`, only a save against one of these.
      ownSave: z.enum(["failed", "succeeded"]).optional(),
      allySave: z.enum(["failed", "succeeded"]).optional(),
      conditions: z.array(ConditionSchema).min(1).optional(),
      // With `damaged`, only right after a trait such as Relentless Endurance leaves the bearer at 1 Hit Point instead
      // of 0, as Orcish Fury's attack.
      endured: z.literal(true).optional(),
      // Taken when a creature under the bearer's Compelled Duel-like mark (a `duel` effect it put there) damages
      // anyone but the bearer, as Unwavering Mark.
      dueledDamages: z.literal(true).optional(),
      // Taken when an enemy ends its turn within `within`, as with Skirmisher.
      turnEnds: z.literal(true).optional(),
      // Taken right after a foe within `within` hits or misses anyone with an attack roll; with `marked`, only one
      // under an effect of the bearer's from one of those, as Soul of Vengeance's foe under Vow of Enmity.
      foeAttacks: z.literal(true).optional(),
      // With `ownSave`, `missed` or `struck`, only a spell sets it off, as with Spell Reflection.
      bySpell: z.literal(true).optional(),
      // Taken when a creature within `within` makes a save to keep Concentration, or takes the Study action, as
      // with Warp Mind.
      concentrationSave: z.literal(true).optional(),
      studied: z.literal(true).optional(),
      // Taken when the bearer or a creature it can see within `within` (60 feet unless set) falls, as with Feather
      // Fall.
      falls: z.literal(true).optional(),
      // Taken when an ally within `within` spends Heroic Inspiration, as with Tireless Reveler.
      inspirationSpent: z.literal(true).optional(),
      // Taken when a creature the bearer can see within `within` hits a target with an attack roll, before its
      // damage, as with a Brooch of the Elements. It's taken only when it changes that damage for the bearer's side.
      hitDamages: z.literal(true).optional(),
      // Taken right after Initiative is rolled, as with Alert's Initiative Swap.
      initiative: z.literal(true).optional(),
      // Taken only when its owner's `commandFamiliar` effect calls for it, never on its own.
      commanded: z.literal(true).optional(),
    })
    .optional(),
  carrying: ContentIdSchema.optional(), // an item the bearer must carry to use it, as Battle Medic's Healer's Kit
  // A `slot` cost spends one of at least this level, as a level 2+ slot restoring Illusory Self's use.
  minSlot: z.number().int().min(1).max(9).optional(),
  // only in Dim Light or Darkness ("shadows"), as Merge with Shadows, or in sunlight, as Light Bringer's Sun's Healing
  whileIn: z.enum(["shadows", "sunlight"]).optional(),
  // only once the bearer has taken its action, as Sudden Strike after the Attack action ("attack") or Blink Steps after
  // the Attack or the Magic action ("attackOrMagic")
  afterAction: z
    .union([z.literal(true), z.enum(["attack", "attackOrMagic"])])
    .optional(),
  beforeAction: z.literal(true).optional(), // only before it takes its action, as Reckless Attack's first attack roll
  afterBonusAction: z.literal(true).optional(), // only once it has taken its Bonus Action, as Fleet Step
  // only after casting a spell with a casting time of an action this turn, as Battle Magic; "slot" one cast with a
  // spell slot too, as Spell Subterfuge; "leveled" any spell of level 1 or higher, as Tempestuous Magic
  afterCast: z.union([z.literal(true), z.enum(["slot", "leveled"])]).optional(),
  unmoved: z.literal(true).optional(), // only if the bearer hasn't moved this turn, as Steady Aim
  bloodied: z.literal(true).optional(), // only while the bearer has under half its Hit Points, as Unearthly Recovery
  // Once a turn for all its feature's activations, as Stunning Strike, or with a name, for all activations of that
  // name, as Brutal Strike's and Improved Brutal Strike's options (queries.ts gatesOpen).
  oncePerTurn: z.union([z.literal(true), z.string().min(1)]).optional(),
  withShield: z.literal(true).optional(), // only while the bearer holds a Shield, as Shield Bash
  // Its damage is one of the hit weapon's damage dice, of the weapon's type, as Orcish Fury's.
  weaponDie: z.literal(true).optional(),
  // A spell attack that's one of the Attack action's attacks all the same, so Extra Attack repeats it, as Radiant Sun
  // Bolt.
  withExtraAttack: z.literal(true).optional(),
  // Its resolution deals the damage of the weapon whose shot it takes the place of too, as Piercing Arrow's.
  weaponDamage: z.literal(true).optional(),
  // Its first damage entry's dice while the bearer holds no weapon or Shield, as Unarmed Fighting's d8.
  emptyHanded: DiceSchema.optional(),
  // Only as the bearer takes the Attack action: while its action is unspent or Attack-action attacks are left, as
  // Vow of Enmity or Sacred Weapon.
  withAttack: z.literal(true).optional(),
  // With targeting's `afflicted`, it ends that action's effects on the target, as Quivering Palm's end does the
  // vibrations.
  endsAffliction: z.literal(true).optional(),
  // Its effects stay on one creature at a time: using it again ends them on the one before, as Quivering Palm's
  // vibrations or Vow of Enmity.
  oneTarget: z.literal(true).optional(),
  // When a creature under its effects drops to 0 Hit Points, they move to the foe nearest the bearer within this many
  // feet of it, as Vow of Enmity's or Master of Hexes' curse.
  transfers: z.number().int().min(5).optional(),
  // A strike option that keeps its bearer hidden after an attack from hiding, while it ends the turn behind
  // Three-Quarters or Total Cover from every foe, as Supreme Sneak's Stealth Attack.
  keepsHidden: z.literal(true).optional(),
  // What the bearer gets as an `afterHit` activation is taken, as Cunning Strike's Withdraw move.
  selfEffects: z.array(LeafEffectSchema).min(1).optional(),
  // Effects on the bearer too, whatever its targets, as the Dash and Disengage of Heightened Focus's Step of the Wind
  // carrying an ally.
  alsoSelf: z.array(LeafEffectSchema).min(1).optional(),
  // Taking it ends the spell that granted it, as Holy Weapon's burst of radiance.
  dismisses: z.literal(true).optional(),
  // Once its attacks are made, the bearer teleports to a square within this many feet of the first creature it aimed
  // at, as Steel Wind Strike. shortcut: the first such creature, not the one the player picks.
  teleportAfter: z.number().int().min(5).optional(),
  // What its user gets every time it's taken, whatever it does to its targets, as a Robe of Scintillating Colors'
  // Disadvantage on attacks against its wearer or a Horn of Blasting's chance to explode (combat/actions.ts).
  userEffects: z.array(LeafEffectSchema).min(1).optional(),
  // only while an effect of one of these features' activations is on the bearer, as Travel along the Tree in a Rage,
  // or while it concentrates on one of these spells, as Telekinetic Master's attack
  while: z.array(ContentIdSchema).min(1).optional(),
  whileAspect: z.string().min(1).optional(), // only while the bearer has this `aspect`, as Starry Form's Archer's arrows
  // Only between fights, from the character sheet (camp.ts), as a spell that takes an hour to cast, as Raise Dead,
  // which needs a scene with time to rest, or "scene" for one in any scene, as Knock on a scene's lock (explore.ts).
  outOfCombat: z.union([z.literal(true), z.literal("scene")]).optional(),
  label: z.string().min(1).optional(), // added to its feature's name, to tell two of a feature's activations apart
  projectiles: z.number().int().min(1).optional(), // separate darts, rays or beams, each aimed on its own
  distinct: z.literal(true).optional(), // with `projectiles`, each at a different creature, as Intoxicated Frenzy's
  // Only from this level in the class, as Searing Arc Strike's spell raised by more Focus Points, up to half the Monk
  // level.
  minLevel: z
    .strictObject({ class: ContentIdSchema, level: z.number().int().min(1) })
    .optional(),
  // Only once the bearer has attacked this many different creatures this turn, and only at one it hasn't, as Distant
  // Strike's third attack (combat/actions.ts actionKindMarks).
  afterTargets: z.number().int().min(1).optional(),
  // Only once this turn its bearer has used the activation of this feature with this label, as Hand of Healing's heal
  // in place of a Flurry of Blows strike (combat/actions.ts actionKindMarks).
  afterUse: z
    .strictObject({ feature: ContentIdSchema, label: z.string().optional() })
    .optional(),
  targeting: TargetingSchema,
  resolution: ResolutionSchema,
  area: AreaEffectSchema.optional(), // what the zone its resolution leaves does later
  // Shapes the caster picks between as it casts, as Forcecage's cage or box (combat/actions.ts): the first is the
  // resolution as written, and another's `effects` take the place of an automatic resolution's effects.
  shapes: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        effects: z.array(LeafEffectSchema).optional(),
        // or a whole resolution of its own in place of the one written, as Pyrotechnics' Smoke
        resolution: ResolutionSchema.optional(),
      }),
    )
    .min(2)
    .optional(),
  // Rolled on as the reaction is taken, as Mythal Ward's table (combat/reactions.ts rollOnTable).
  table: TableSchema.optional(),
});
export type Activation = z.infer<typeof ActivationSchema>;

export const SpellSchoolSchema = z.enum([
  "abjuration",
  "conjuration",
  "divination",
  "enchantment",
  "evocation",
  "illusion",
  "necromancy",
  "transmutation",
]);

// What a save is against, for a passive that holds only then: a spell of one of `schools`, or the effect of a
// creature of one of `creatureTypes` (lowercase), with `breath` only its breath weapon, as Dragon Scale Mail's.
// shortcut: a breath weapon is an action with "Breath" in its name.
const SaveFromSchema = z.strictObject({
  schools: z.array(SpellSchoolSchema).min(1).optional(),
  creatureTypes: z.array(z.string()).min(1).optional(),
  breath: z.literal(true).optional(),
});
export type SaveFrom = z.infer<typeof SaveFromSchema>;

// `bloodied` on a passive means it only holds while the bearer is Bloodied, as a cultist of Myrkul's Nearer to the Dead.
const WhileBloodied = z.literal(true).optional();

export const PassiveSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("modifier"),
    modifier: ModifierSchema,
    bloodied: WhileBloodied,
    // only while wearing no Heavy armor ("noHeavy"), as Fast Movement's Speed, or no armor and no Shield ("none"), as
    // Unarmored Movement's (stats.ts)
    armor: z.enum(["noHeavy", "none"]).optional(),
    // only while an effect of one of these features' activations is on the bearer, as Stride of the Elements' Speeds
    // in Elemental Attunement
    while: z.array(ContentIdSchema).min(1).optional(),
    whileAspect: z.string().min(1).optional(), // only while the bearer has this `aspect`, as Starry Form's Dragon's
    concentrating: z.literal(true).optional(), // only while the bearer concentrates on a spell, as Durable Magic
  }),
  // Saves against the bearer's spells that deal one of these types have Disadvantage, as Storm's Strength.
  z.strictObject({
    kind: z.literal("stormStrength"),
    damage: z.array(DamageTypeSchema).min(1),
  }),
  // An area round the bearer that moves with it, as a ghast's Stench, a balor's Fire Aura or a flameskull's
  // Illumination ("light" or "dim" for the light it sheds).
  z.strictObject({
    kind: z.literal("aura"),
    // only while an effect of one of these features' activations is on the bearer, as Power of the Wilds' Lion in a
    // Rage, and with `whileAspect` only while it has that aspect, as Celestial Revelation's Inner Radiance
    while: z.array(ContentIdSchema).min(1).optional(),
    whileAspect: z.string().min(1).optional(),
    // only while the bearer has none of these features, as Unnerving Aura before Rot and Violence's takes its place
    without: z.array(ContentIdSchema).min(1).optional(),
    name: z.string().min(1),
    zone: ZoneKindSchema.default("area"),
    radius: z.number().int().min(5),
    area: AreaEffectSchema.default({}),
    // this wide instead from a level in one class (its name after the plugin), as a Holy Avenger's 30 feet for a
    // Paladin of level 17
    wider: z
      .strictObject({
        class: z.string().min(1),
        level: z.number().int().min(1),
        radius: z.number().int().min(5),
      })
      .optional(),
  }),
  // What happens round the bearer when it takes damage of these types, once a turn, as a spore of Moander's
  // Explosive Core.
  z.strictObject({
    kind: z.literal("damageBurst"),
    name: z.string().min(1),
    damage: z.array(DamageTypeSchema).min(1),
    radius: z.number().int().min(5),
    resolution: ResolutionSchema,
  }),
  // Conditions it has inside fog or mist and outside it, as a mist horror's One with the Mists.
  z.strictObject({
    kind: z.literal("fogBound"),
    inside: z.array(ConditionSchema).default([]),
    outside: z.array(ConditionSchema).default([]),
  }),
  // What happens round the square where the bearer dies, as a flaming skeleton's Death Burst.
  z.strictObject({
    kind: z.literal("deathBurst"),
    name: z.string().min(1),
    radius: z.number().int().min(5),
    resolution: ResolutionSchema,
  }),
  // In sunlight, or in Bright Light of any kind: Disadvantage on these rolls, and damage as its turn starts there, as
  // Sunlight Sensitivity or a vampire's Sunlight.
  z.strictObject({
    kind: z.literal("lightSensitive"),
    light: z.enum(["sunlight", "bright"]),
    disadvantage: z.array(z.enum(["attacks", "saves", "checks"])).default([]),
    damage: z.array(DamageSchema).default([]),
  }),
  z.strictObject({
    kind: z.literal("extraDamage"),
    dice: DiceSchema.optional(),
    diceCount: z.string().optional(), // a class scaling key that replaces the number of dice
    dieSize: z.string().optional(), // a class scaling key that replaces the die size
    bonus: FormulaSchema.optional(), // added to the dice, as Divine Fury's half the Barbarian level
    // "advantageOrAlly" also counts an ally within 5 feet of the target, as Sneak Attack does. "targetHurt" is a
    // target missing any Hit Points, as Circle of Mortality's Pull of Death. "always" is every hit `with` allows.
    // "natural20" is a hit whose d20 rolled a 20, as Overwhelming Strike's.
    when: z.enum([
      "advantage",
      "advantageOrAlly",
      "targetHurt",
      "always",
      "natural20",
    ]),
    // which hits carry it: unset, a Finesse or Ranged weapon's for Advantage, and any other hit
    with: HitKindSchema.optional(),
    type: DamageTypeSchema.optional(), // the damage's own type, not the weapon's, as Pull of Death's Necrotic
    // the type of these its target resists least, as Divine Fury's Necrotic or Radiant
    types: z.array(DamageTypeSchema).min(2).optional(),
    oncePerTurn: z.boolean().default(false),
    ownTurn: z.literal(true).optional(), // only on the bearer's own turn, as Divine Fury's first hit each turn
    firstRound: z.literal(true).optional(), // only in a fight's first round, as Assassinate's Surprising Strikes
    // only while an effect of each of these features' activations is on the bearer, as Divine Fury's Rage, or
    // Frenzy's Rage and Reckless Attack
    while: z.array(ContentIdSchema).min(1).optional(),
    // only against a creature under an effect of the bearer's from one of these spells or features, as Guided
    // Precision's Faerie Fire
    against: z.array(ContentIdSchema).min(1).optional(),
    whileAspect: z.string().min(1).optional(), // only with this aspect, as Wondrous Alteration's Natural Weapons
    targetCondition: ConditionSchema.optional(), // only against a creature with this condition, as Ominous Strikes'
    // one more die of the hit's own damage of this type, as Dreaded Necrosis' Necrotic die
    oneDieOf: DamageTypeSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("packTactics") }),
  // Moving through other creatures' spaces or through walls, as a swarm, a ghost's Incorporeal Movement or Halfling
  // Nimbleness: `creatures` any, or only ones larger than it; `walls` through walls, at double cost with `costly`;
  // `squeeze` slips between walls meeting at a corner; `open` lets others through its own space, as a swarm's;
  // `terrain` crosses difficult terrain at no extra cost, as Freedom of Movement or a gas spore's Rolling Mass.
  z.strictObject({
    kind: z.literal("moveThrough"),
    creatures: z.enum(["any", "larger"]).optional(),
    walls: z.boolean().default(false),
    costly: z.boolean().default(false),
    squeeze: z.boolean().default(false),
    open: z.boolean().default(false),
    terrain: z.boolean().default(false),
    // only while an effect of one of these features' activations is on it, as Cloak of Shadows' shroud
    while: z.array(ContentIdSchema).min(1).optional(),
    whileAspect: z.string().min(1).optional(), // only while it has this aspect, as Revelation in Flesh's Wormlike Movement
  }),
  // A longer Long Jump, as a frog's Standing Leap (`feet` 20, `runUp` 0) or Athlete's Jumping (`runUp` 5): its feet
  // after a run-up of `runUp` feet, instead of the Strength score after 10.
  z.strictObject({
    kind: z.literal("jump"),
    feet: z.number().int().min(5).optional(),
    runUp: z.number().int().min(0).default(10),
    ability: z.literal("dex").optional(), // jumps by Dexterity instead of Strength, as a cat's Jumper
    times: z.number().int().min(2).optional(), // its jumps go this many times as far, as in a Low Gravity Zone
  }),
  // Webs never hold it (applyCondition `web`), as a spider's Web Walker.
  z.strictObject({ kind: z.literal("webWalker") }),
  // Leaving a foe's reach never provokes an Opportunity Attack, as with Flyby or Agile.
  z.strictObject({ kind: z.literal("noOpportunityAttacks") }),
  // A successful save against a spell of this level or lower means the spell does nothing to the bearer, as a Ring of
  // Spell Turning's level 7. shortcut: only a spell's own save, not a save its lasting effects call for later.
  z.strictObject({
    kind: z.literal("spellTurning"),
    upTo: z.number().int().min(1).max(9),
    // A spell that targeted only the bearer and made no area is turned back at its caster with the bearer's
    // Reaction, the caster saving against its own spell save DC (combat/effects.ts).
    deflect: z.literal(true).optional(),
    // Only spells of these schools, only the deflection, and a use of this resource for it, as a Staff of
    // Charming's Reflect Enchantment.
    schools: z.array(SpellSchoolSchema).min(1).optional(),
    deflectOnly: z.literal(true).optional(),
    resource: z.string().min(1).optional(),
  }),
  // A save for half damage deals none on a success and half on a failure, as with Evasion. `anySave` makes it every
  // save, as a displacer beast's Avoidance does, instead of Dexterity saves only.
  z.strictObject({
    kind: z.literal("evasion"),
    anySave: z.boolean().default(false),
  }),
  // Advantage on attack rolls while Bloodied, against a target missing Hit Points, or against a Frightened or Charmed
  // one, as Treacherous Allure's.
  // "marked" is against a creature under an effect of the bearer's from one of `against`, as Precise Hunter's Hunter's
  // Mark (the spell's or Favored Enemy's),
  // and "unacted" against one yet to take a turn in a fight's first round, as Assassinate's.
  z.strictObject({
    kind: z.literal("attackAdvantage"),
    when: z.enum([
      "bloodied",
      "targetHurt",
      "targetFrightened",
      "targetCharmed",
      "marked",
      "unacted",
      "creatureType", // against a creature of one of `creatureTypes`, as a Ring of Elemental Command's Elementals
    ]),
    against: z.array(ContentIdSchema).min(1).optional(),
    creatureTypes: z.array(CreatureTypeSchema).min(1).optional(),
  }),
  // Its shape can't change, so Polymorph does nothing to it, as with a golem's Immutable Form.
  z.strictObject({ kind: z.literal("immutableForm") }),
  // `except` is the damage it never holds against (Radiant when left out), as a wonder's Mechanical Determination's
  // Lightning.
  z.strictObject({
    kind: z.literal("undeadFortitude"),
    except: z.array(DamageTypeSchema).min(1).optional(),
  }),
  z.strictObject({ kind: z.literal("magicResistance") }),
  z.strictObject({
    kind: z.literal("conditionImmunity"),
    condition: ConditionSchema,
    bloodied: WhileBloodied,
  }),
  // Hit Points regained at the start of each of its turns, as a troll does. With `cures` it also ends the condition
  // that hampers it most, as an inquisitor's Metabolic Control. `hp` may be rolled, as Survivor's Heroic Rally's 5
  // plus the Constitution modifier, and with `turnEnd` it comes as the turn ends instead, while it can act, as
  // Protective Spirit's.
  z.strictObject({
    kind: z.literal("regeneration"),
    hp: z.union([z.number().int().min(1), AmountSchema]),
    turnEnd: z.literal(true).optional(),
    // only while an effect from this source is on it, as Boon of Misty Escape's Gaseous Form (dropToOne's resource)
    whileEffect: z.string().optional(),
    stoppedBy: z.array(DamageTypeSchema).default([]), // damage that stops it for a turn
    bloodied: WhileBloodied,
    cures: z.literal(true).optional(),
  }),
  // A Critical Hit on this natural roll or higher, as with Improved Critical.
  z.strictObject({
    kind: z.literal("criticalRange"),
    from: z.number().int().min(2).max(19),
    // only against a creature under an effect of the bearer's from one of these, as Hexblade's Curse
    against: z.array(ContentIdSchema).min(1).optional(),
    // only while an effect of one of these features is on the bearer, as Invincible Conqueror
    while: z.array(ContentIdSchema).min(1).optional(),
  }),
  // Advantage on saving throws with these abilities, or against these conditions, as with Gnomish Cunning or Brave.
  z.strictObject({
    kind: z.literal("saveAdvantage"),
    abilities: z.array(AbilitySchema).default([]),
    conditions: z.array(ConditionSchema).default([]),
    shapeChange: z.literal(true).optional(), // against an effect that changes its shape, as Transmuted Anatomy's
    bloodied: z.literal(true).optional(), // only while Bloodied, as with Bloodied Frenzy
    while: ConditionSchema.optional(), // only while the bearer has it, as a Dream Weaver's Mind Wall while Unconscious
    // never while the bearer has it ("incapacitated" counting what Incapacitates), as Danger Sense
    notWhile: ConditionSchema.optional(),
    from: SaveFromSchema.optional(), // only a save against this, which every save then counts
  }),
  // Heroic Inspiration as a rest ends, for the bearer or for its allies, as with Resourceful or Musician.
  z.strictObject({
    kind: z.literal("restInspiration"),
    rests: z.array(z.enum(["short", "long"])).min(1),
    allies: z.boolean().default(false),
  }),
  // Dropping to 1 Hit Point instead of 0 while the resource lasts, as with Relentless Endurance.
  // With `effects` it gains these as it does, for the rest of the fight, as Boon of Misty Escape's Gaseous Form.
  // `hp` is the Hit Points it changes to instead, as Relentless Rage's twice the Barbarian level, and `while` holds it
  // only while an effect of one of these features' activations is on it, as Relentless Rage's Rage. A `save` must
  // succeed first, its DC `step` higher for each use spent and with `plusDamage` the damage taken more, as Strength of
  // the Grave's; only a success spends a use. It can't hold against `except` damage, or a Critical Hit with
  // `notCritical`. A `burst` deals damage to the bearer's foes within `radius` feet, halved by a save against its spell
  // save DC, as Necrotic Husk's, which also gives `exhaustion` levels. With `allies` the bearer's allies have it too,
  // spending the bearer's use, as Gift of the Protectors.
  z.strictObject({
    kind: z.literal("dropToOne"),
    resource: z.string(),
    // the bearer's Uncommon and Rare replicated items vanish instead of a use, and it's left with this many Hit Points
    // for each, as Soul of Artifice's Cheat Death
    replicated: z.number().int().min(1).optional(),
    effects: z.array(ModifierSchema).default([]),
    hp: FormulaSchema.optional(),
    while: z.array(ContentIdSchema).min(1).optional(),
    save: z
      .strictObject({
        ability: AbilitySchema,
        dc: z.number().int(),
        step: z.number().int().min(1).optional(),
        plusDamage: z.literal(true).optional(),
      })
      .optional(),
    except: z.array(DamageTypeSchema).min(1).optional(),
    notCritical: z.literal(true).optional(),
    burst: z
      .strictObject({
        radius: z.number().int().min(5),
        save: AbilitySchema,
        damage: AmountSchema,
        type: DamageTypeSchema,
      })
      .optional(),
    exhaustion: z.number().int().min(1).optional(),
    allies: z.literal(true).optional(),
    // it takes the bearer's Reaction, for a creature within `within` feet of it, as Rage of the Gods' Revivification
    reaction: z.literal(true).optional(),
    within: z.number().int().min(5).optional(),
  }),
  // An attacker of these types must pass a Wisdom save against the bearer's spell save DC or lose its attack; passing,
  // or being attacked by the bearer, frees it of this until a Long Rest, as Among the Dead's undead.
  // shortcut: a spell's save aimed at the bearer alone isn't turned aside, only an attack roll.
  z.strictObject({
    kind: z.literal("deterAttackers"),
    creatureTypes: z.array(CreatureTypeSchema).min(1),
  }),
  // Dropping to 0 Hit Points leaves the bearer conscious: while an effect of one of the `while` features' activations
  // is on it, as Rage beyond Death's Rage, still making Death Saving Throws but dying of three failures only once that
  // ends; or, spending `resource` and its Reaction, until its next turn ends, as Strength before Death.
  // shortcut: Strength before Death's extra turn is the samurai's next turn, not one that interrupts the current turn.
  z.strictObject({
    kind: z.literal("fightOn"),
    while: z.array(ContentIdSchema).min(1).optional(),
    resource: z.string().optional(),
  }),
  // Dropping to 0 Hit Points, or with `incapacitated` being Incapacitated by a foe, spends `resource` for these
  // effects on the bearer, as Faithful Summons' beasts (an `animate` of a beast's stat block).
  // shortcut: the beasts are the stat block given, not the bearer's pick of any Challenge Rating 2 or lower.
  z.strictObject({
    kind: z.literal("whenDowned"),
    resource: z.string(),
    effects: z.array(LeafEffectSchema).min(1),
    incapacitated: z.literal(true).optional(),
  }),
  // Changes to the bearer's damaging cantrip that deals the most, as Agonizing, Repelling Blast or Eldritch Spear do:
  // damage added to each roll, effects on a hit, and range for each level of a class.
  z.strictObject({
    kind: z.literal("cantripRider"),
    attackOnly: z.boolean().default(false), // only a cantrip that makes an attack roll
    damage: FormulaSchema.optional(),
    onHit: z.array(LeafEffectSchema).default([]),
    rangePerLevel: z
      .strictObject({ class: ContentIdSchema, feet: z.number().int().min(1) })
      .optional(),
    // Every damaging cantrip on this class's spell list instead of the best one, as Potent Spellcasting's.
    list: ContentIdSchema.optional(),
    // Feet added to the range of a cantrip that reaches 10 feet or more, as Improved Elemental Fury's.
    range: z.number().int().min(5).optional(),
    // What the caster gets once the cantrip deals damage, as Improved Blessed Strikes' Temporary Hit Points.
    selfEffects: z.array(LeafEffectSchema).min(1).optional(),
  }),
  // Seeing normally through the Darkness of its own spells, as Power of Shadow's Eyes of the Dark.
  z.strictObject({ kind: z.literal("seesOwnDarkness") }),
  // While in Darkness, Invisible to a creature that sees it there only by Darkvision, as Umbral Sight.
  z.strictObject({ kind: z.literal("umbral") }),
  // Seeing through Darkness and Dim Light this far, as with Devil's Sight.
  z.strictObject({
    kind: z.literal("seesInDarkness"),
    feet: z.number().int().min(5),
  }),
  // Melee weapons are pact weapons: trained, with Charisma when it's better, and this damage added on a hit.
  z.strictObject({
    kind: z.literal("pactWeapon"),
    damage: z.array(DamageSchema).default([]),
  }),
  // Dash, Disengage or Hide as a Bonus Action, as with Cunning Action or a goblin's Nimble Escape.
  z.strictObject({
    kind: z.literal("bonusTactics"),
    // "search" and "study" as Observant's Quick Search and Keen Mind's Quick Study
    tactics: z
      .array(
        z.enum([
          "dash",
          "disengage",
          "hide",
          "dodge",
          "search",
          "study",
          "help",
        ]),
      )
      .min(1),
    half: z.literal(true).optional(), // its Dash adds half its Speed, as a troll's Charge
    safe: z.literal(true).optional(), // its Dash provokes no Opportunity Attacks, as a warrior commander's Tactical Charge
    resource: z.string().optional(), // each use spends one, as Timely Retreat's
  }),
  // Advantage on saves to keep Concentration, as with Eldritch Mind.
  z.strictObject({
    kind: z.literal("concentrationAdvantage"),
    whileAspect: z.string().min(1).optional(), // only with this aspect, as Wondrous Alteration's with Natural Weapons
  }),
  // The bearer's spells that make an attack roll reach this much farther when their range is 10 feet or more, as
  // Spell Sniper's Increased Range.
  z.strictObject({
    kind: z.literal("spellRange"),
    feet: z.number().int().min(5),
  }),
  // A creature Charmed by one of these spells of the bearer's can't cast spells with Verbal components, as Boon of
  // Revelry's Sing Out with Otto's Irresistible Dance (zones.ts silencedSpells).
  z.strictObject({
    kind: z.literal("singOut"),
    spells: z.array(ContentIdSchema).min(1),
  }),
  // Once a turn, a spell the bearer casts that deals one of these types gets up to two of its Hit Point Dice, rolled,
  // added to its damage, as Spellfire Adept's Fueled Spellfire with Radiant (combat/school.ts fueledDamage).
  z.strictObject({
    kind: z.literal("fueledSpell"),
    types: z.array(DamageTypeSchema).min(1),
  }),
  // The healing dice of a spell cast by the bearer or an ally within 5 feet of it are rolled again once when low, for
  // a use of `resource` once a turn, as Empowered Healing's Sorcery Point (combat/effects.ts).
  z.strictObject({ kind: z.literal("empoweredHealing"), resource: z.string() }),
  // Helping a dying creature to stabilize gives the bearer Heroic Inspiration, spending a use, as Arcane Undertaker's
  // Understanding of Death (actions.ts).
  z.strictObject({
    kind: z.literal("stabilizeInspiration"),
    resource: z.string(),
  }),
  // A spell ended with Dispel Magic, or one countered, gives a use of `resource` back, as Power Surge's surges.
  z.strictObject({ kind: z.literal("stopRegain"), resource: z.string() }),
  // A change the bearer can make to a spell as it casts it, paying `cost` (cast-options.ts), as Overchannel's maximum
  // damage, Enhanced Necromancy's second target for a Channel Divinity, or Split Enchantment's level more for a use.
  // Which spells: `spells`, `schools`, `list`'s, cast with a slot (`slot`), of levels `minLevel` to `maxLevel`, that
  // deal damage (`damaging`), call for a save (`saving`), make neither an attack roll nor a save (`plain`), target one
  // creature (`oneTarget`) or allies (`allies`), or reach more creatures from a higher slot (`upcastTargets`). What
  // changes: `levels` more of its upcast, `addTargets` more creatures, `maxDamage`, Temporary Hit Points for its
  // targets (`tempHp`), or `saveDice` taken off each target's first save. With `escalate`, every use after the first
  // until `escalate.resource` comes back deals the caster `dice` for each slot level, one die more for each use, of
  // `type`, ignoring Resistance and Immunity, as Overchannel's Necrotic.
  z.strictObject({
    kind: z.literal("castOption"),
    label: z.string().min(1),
    cost: z.array(CostSchema).default([]),
    spells: z.array(ContentIdSchema).min(1).optional(),
    schools: z.array(SpellSchoolSchema).min(1).optional(),
    list: ContentIdSchema.optional(),
    slot: z.literal(true).optional(),
    minLevel: z.number().int().min(0).max(9).optional(),
    maxLevel: z.number().int().min(0).max(9).optional(),
    damaging: z.literal(true).optional(),
    saving: z.literal(true).optional(),
    plain: z.literal(true).optional(),
    oneTarget: z.literal(true).optional(),
    allies: z.literal(true).optional(),
    upcastTargets: z.literal(true).optional(),
    levels: z.number().int().min(1).optional(),
    addTargets: z.number().int().min(1).optional(),
    maxDamage: z.literal(true).optional(),
    // its summons come two at once, each with half its Hit Points, as Splintered Summons
    splinter: z.literal(true).optional(),
    tempHp: AmountSchema.optional(),
    saveDice: DiceSchema.optional(),
    // effects added to the failed saves its lasting area calls for, as Blessing of Moonlight's healing on Moonbeam
    areaOnFail: z.array(LeafEffectSchema).min(1).optional(),
    // effects on the caster as it casts, ending with the spell, as Blessing of Moonlight's faint glow
    userEffects: z.array(LeafEffectSchema).min(1).optional(),
    escalate: z
      .strictObject({
        resource: z.string().min(1),
        dice: z.number().int().min(1),
        die: z.number().int().min(2),
        type: DamageTypeSchema,
      })
      .optional(),
  }),
  // The bearer's spells that deal damage may deal these types instead, the one a target resists least (DamageSchema
  // `types`), as Psychic Spells' Psychic for Warlock spells (`list`); `oncePerTurn` once a turn, as Grave Touched's
  // Necrotic, or `resource` spending a use, as a Prismatic Rune's charge.
  z.strictObject({
    kind: z.literal("spellTypes"),
    add: z.array(DamageTypeSchema).min(1),
    list: ContentIdSchema.optional(),
    oncePerTurn: z.literal(true).optional(),
    resource: z.string().min(1).optional(),
  }),
  // These spells, when they target creatures, reach this many more, as Words of Creation's second creature for
  // Power Word Heal and Power Word Kill. shortcut: how near the first target the others are isn't checked.
  z.strictObject({
    kind: z.literal("extraTarget"),
    spells: z.array(ContentIdSchema).min(1),
    creatures: z.number().int().min(1).default(1),
  }),
  // These spells are cast with no Verbal, Somatic or Material components, so they give a hidden caster away to no one
  // and can't be seen to be countered: of these `schools`, of `list`'s, these `spells`, only with a slot (`slot`), or
  // only cast by spending `via` in place of a slot, as Psionic Sorcery's Sorcery Points.
  z.strictObject({
    kind: z.literal("silentCasting"),
    schools: z.array(SpellSchoolSchema).min(1).optional(),
    list: ContentIdSchema.optional(),
    spells: z.array(ContentIdSchema).min(1).optional(),
    slot: z.literal(true).optional(),
    via: z.string().min(1).optional(),
  }),
  // Dispel Magic adds the Proficiency Bonus to its check, and a slot spent on Dispel Magic or Counterspell comes back
  // when the spell stops nothing, as Spell Breaker's (combat/effects.ts, combat/counter.ts).
  z.strictObject({ kind: z.literal("spellBreaker") }),
  // A spell the bearer counters gives back these dice of `resource`, as Absorb Spells' 1d4 Sorcery Points.
  z.strictObject({
    kind: z.literal("counterRegain"),
    resource: z.string().min(1),
    dice: DiceSchema,
  }),
  // These spells' action is a Bonus Action instead, as Spell Breaker's Dispel Magic.
  z.strictObject({
    kind: z.literal("castsAs"),
    spells: z.array(ContentIdSchema).min(1),
    cost: z.literal("bonusAction"),
  }),
  // While the bearer is Invisible, the saves against its spells as it casts them have Disadvantage, as Magical Ambush.
  // shortcut: only the saves the casting asks for, not ones the spell asks for later in the turn.
  z.strictObject({ kind: z.literal("magicalAmbush") }),
  // The bearer's damaging cantrips deal half their damage on a miss or a successful save, as Potent Cantrip.
  // shortcut: the cantrip's other effects still come on a miss or save only where the cantrip says so.
  z.strictObject({ kind: z.literal("potentCantrip") }),
  // Ritual spells on this class's list, of a level it has slots for, can be cast as Rituals between fights without
  // being prepared, as Ritual Adept's from a Wizard's spellbook (camp.ts).
  z.strictObject({ kind: z.literal("ritualAdept"), list: ContentIdSchema }),
  // A creature leaving the bearer's reach can be answered with a one-target spell of one action instead of an
  // Opportunity Attack, as with War Caster's Reactive Spell.
  z.strictObject({ kind: z.literal("reactiveSpell") }),
  // Attacks per Attack action, such as Extra Attack.
  z.strictObject({
    kind: z.literal("multiattack"),
    attacks: z.number().int().min(2),
  }),
  // More attacks with each Attack action: while an effect of one of `while`'s features is on the bearer, as Invincible
  // Conqueror, or on its first turn of a fight, as Dread Ambusher's (2014).
  z.strictObject({
    kind: z.literal("extraAttacks"),
    count: z.number().int().min(1),
    while: z.array(ContentIdSchema).min(1).optional(),
    firstTurn: z.literal(true).optional(),
  }),
  // The Attack action can trade `attacks` of its attacks for one of these taken with its action (combat/trade.ts):
  // a cantrip (`cantrips`), a spell of these `levels`, or an activation that spends this `resource`, as Valor's
  // Extra Attack, War Magic, Improved War Magic and Breath Weapon.
  // shortcut: any such spell the bearer knows, not only those of one class's list.
  z.strictObject({
    kind: z.literal("attackReplacement"),
    attacks: z.number().int().min(1).default(1),
    cantrips: z.literal(true).optional(),
    levels: z.array(z.number().int().min(1).max(9)).min(1).optional(),
    resource: z.string().min(1).optional(),
    feature: ContentIdSchema.optional(), // or an activation of this feature, as Quivering Palm's end
  }),
  // A 1 on the d20 of a D20 Test is rolled again, and the new roll stands, as with Halfling Luck.
  z.strictObject({ kind: z.literal("rerollOnes") }),
  // A creature at least one size larger is cover enough to Hide behind, as with Naturally Stealthy.
  z.strictObject({ kind: z.literal("hideBehindLarger") }),
  // A spell's sunlight placed within `within` feet Blinds the bearer for a minute, saving with Constitution against
  // `dc` at the end of each of its turns, as a Robe of Eyes' drawback (combat/effects.ts).
  // shortcut: a Light spell cast on the robe isn't played, as no one in a fight casts it there.
  z.strictObject({
    kind: z.literal("dazzledBy"),
    within: z.number().int().min(0),
    dc: z.number().int(),
  }),
  // Starting its turn underwater at 0 Hit Points, it regains `amount`, spending a use of `resource`, as a Mariner's
  // Armor's 1d4 (combat/water.ts).
  z.strictObject({
    kind: z.literal("underwaterRevive"),
    amount: AmountSchema,
    resource: z.string().min(1),
  }),
  // Falling never hurts it, as a Ring of Feather Falling's slow descent (combat/falling.ts).
  z.strictObject({ kind: z.literal("featherFall") }),
  // A teleport of one of these spells or features' activations brings willing allies along, as Misty Wanderer's
  // Misty Step (combat/movement.ts).
  z.strictObject({
    kind: z.literal("teleportRider"),
    actions: z.array(ContentIdSchema).min(1),
    bring: z.strictObject({
      count: z.number().int().min(1),
      within: z.number().int().min(5),
      near: z.number().int().min(5),
    }),
  }),
  // Taking the Dash or Disengage action gives the bearer these until its turn ends, as Speedy's Unhindered Dash over
  // Difficult Terrain or Fairy Trickster's Faerie Trod Trotter (combat/effects.ts tacticRiderEvents).
  z.strictObject({
    kind: z.literal("tacticRider"),
    tactic: z.enum(["dash", "disengage"]),
    modifiers: z.array(ModifierSchema).min(1),
  }),
  // A creature it makes a melee attack against can't make Opportunity Attacks against it for the rest of its turn,
  // as Fancy Footwork (combat/movement.ts).
  z.strictObject({ kind: z.literal("fancyFootwork") }),
  // A spell it casts doesn't give away a hiding place unless it ends the turn out of Three-Quarters or Total Cover, as
  // Spell Subterfuge's Sneaky Casting (combat/turn.ts outOfCover).
  z.strictObject({ kind: z.literal("sneakyCasting") }),
  // Its spells of these levels on this class's list that take an action can be cast with these costs instead, as
  // Improved Mystic Fighting Style's casting in place of two Flurry of Blows strikes (stats.ts).
  z.strictObject({
    kind: z.literal("castWith"),
    levels: z.array(z.number().int().min(0).max(9)).min(1),
    list: ContentIdSchema,
    cost: z
      .array(
        z.union([
          z.enum(["action", "bonusAction", "reaction"]),
          z.strictObject({
            resource: z.string(),
            count: z.number().int().min(2).optional(),
          }),
        ]),
      )
      .min(1),
    label: z.string().min(1),
  }),
  // Its weapons can't be knocked from its hand unless it's Incapacitated, and one it has thrown or let fall comes back
  // to its hand for a Bonus Action, as War Bond's. shortcut: every weapon it carries is taken to be bonded.
  z.strictObject({ kind: z.literal("warBond") }),
  // Sneak Attack a second time in a turn, on a creature it hasn't dealt it to, once it has used an activation of this
  // feature this turn, as Sudden Strike's Bonus Action attack (combat/attack.ts).
  z.strictObject({
    kind: z.literal("secondSneak"),
    feature: ContentIdSchema,
  }),
  // A second turn in a fight's first round, at its Initiative less `minus`, as Thief's Reflexes (state.ts advanceTurn).
  z.strictObject({
    kind: z.literal("secondTurn"),
    minus: z.number().int().min(1),
  }),
  // Advantage on the Stealth check of the Hide action, as Skulker's Fog of War.
  z.strictObject({ kind: z.literal("hideAdvantage") }),
  // An attack roll made while hidden that misses doesn't give the bearer away, as Skulker's Sniper.
  z.strictObject({ kind: z.literal("quietMiss") }),
  // In Dim Light it can Hide as a Bonus Action, even with a foe watching, as a Nature's Mantle allows.
  z.strictObject({ kind: z.literal("hideInDim") }),
  // A Perception check made to find the bearer has Disadvantage, as with a Cloak of Elvenkind.
  z.strictObject({ kind: z.literal("perceivedDisadvantage") }),
  // Once a turn, a weapon hit's damage dice are rolled twice and the higher kept, as with Savage Attacker.
  z.strictObject({ kind: z.literal("savageAttacker") }),
  // Proficiency in these saving throws, or with `increased` in the one its feat raised, as with Resilient.
  z.strictObject({
    kind: z.literal("saveProficiency"),
    abilities: z.array(AbilitySchema).default([]),
    increased: z.boolean().default(false),
    // already proficient in all of `abilities`, the first of these it isn't instead, as Elegant Courtier's
    orElse: z.array(AbilitySchema).min(1).optional(),
  }),
  // Advantage on Death Saving Throws, as with Durable, or Disadvantage with `worse`, as Touch of Death's Pull of the
  // Grave.
  z.strictObject({
    kind: z.literal("deathSaveAdvantage"),
    worse: z.literal(true).optional(),
  }),
  // A Death Saving Throw's roll counts as a 20 from `twentyFrom` up, as Survivor's 18-20, and as at least `floor`, as
  // a Periapt of Wound Closure's 10.
  z.strictObject({
    kind: z.literal("deathSaveRoll"),
    twentyFrom: z.number().int().min(2).max(20).optional(),
    floor: z.number().int().min(2).max(20).optional(),
  }),
  // A successful Death Saving Throw heals this much, spending a use, as the Undying's Defy Death.
  z.strictObject({
    kind: z.literal("deathSaveHeal"),
    resource: z.string(),
    amount: AmountSchema,
  }),
  // As the bearer, or with `within` an ally that near it, starts a turn about to make a Death Saving Throw, a use
  // spent gives it half its Hit Point maximum and ends Prone on it, and its foes within `radius` feet take this
  // damage and are Blinded until the turn ends, as Searing Vengeance.
  z.strictObject({
    kind: z.literal("deathSaveRescue"),
    resource: z.string(),
    within: z.number().int().min(5).optional(),
    radius: z.number().int().min(5),
    damage: AmountSchema,
    type: DamageTypeSchema,
  }),
  // Temporary Hit Points as a rest ends, for the bearer and with `allies` the whole party, as with Inspiring Leader.
  // A 1 or 2 on a damage die of a Two-Handed melee weapon counts as a 3, as with Great Weapon Fighting.
  z.strictObject({ kind: z.literal("greatWeaponFighting") }),
  z.strictObject({
    kind: z.literal("restTempHp"),
    rests: z.array(z.enum(["short", "long"])).min(1),
    amount: FormulaSchema,
    allies: z.boolean().default(false),
    alliesAmount: FormulaSchema.optional(), // the allies' own, as Celestial Resilience's half the Warlock level
  }),
  // As the bearer's turn starts, while an effect of one of these features' activations is on it, another creature of
  // its side within `within` feet gains these Temporary Hit Points, as Vitality of the Tree's Life-Giving Force.
  z.strictObject({
    kind: z.literal("turnTempHp"),
    while: z.array(ContentIdSchema).min(1),
    within: z.number().int().min(5),
    amount: AmountSchema,
  }),
  // A Short Rest takes a level of Exhaustion off the bearer, as the Ranger's Tireless.
  z.strictObject({ kind: z.literal("restExhaustion") }),
  // Hit Points regained every so many minutes while it has at least 1, as a Ring of Regeneration's 1d6 every 10.
  // Only rests pass time, so they come over a Short Rest's hour (rest.ts); a Long Rest heals fully anyway.
  z.strictObject({
    kind: z.literal("slowRegeneration"),
    dice: DiceSchema,
    minutes: z.number().int().min(1),
  }),
  // A Short Rest ends with spent spell slots back, of combined levels up to `levels` and none above 5, spending a use
  // of the resource, as Arcane Recovery (rest.ts).
  z.strictObject({
    kind: z.literal("slotRecovery"),
    levels: FormulaSchema,
    resource: z.string().min(1),
  }),
  // A spell slot can be spent in a fight, with no action, for as many of `resource` back as its level, as Mystic
  // Focus' Focus Points (class-options.ts).
  z.strictObject({ kind: z.literal("slotToPoints"), resource: z.string() }),
  // A Short Rest ends with one spent slot back for `resource`, its cost by `costs` (the slot's level, what it costs
  // and the level in `class` it needs), as Mystic Focus' Recovering Spell Slots (rest.ts).
  z.strictObject({
    kind: z.literal("pointsToSlot"),
    resource: z.string(),
    class: ContentIdSchema,
    costs: z
      .array(
        z.strictObject({
          level: z.number().int().min(1).max(9),
          points: z.number().int().min(1),
          from: z.number().int().min(1).max(20),
        }),
      )
      .min(1),
  }),
  // A spell the bearer casts heals this much more on each creature it heals, as Disciple of Life's 2 plus the slot's
  // level (`perSlot`), only cast with a slot (`slot`) or of this class's list (`list`).
  // shortcut: the bonus goes to every creature a spell heals, not to one roll, as Alchemical Savant says.
  z.strictObject({
    kind: z.literal("spellHealing"),
    bonus: FormulaSchema,
    perSlot: z.literal(true).optional(),
    slot: z.literal(true).optional(),
    list: ContentIdSchema.optional(),
  }),
  // Healing dice of the bearer's spells and Channel Divinity count as their highest faces, as Supreme Healing.
  z.strictObject({ kind: z.literal("maxHealingDice") }),
  // Recovering slots that way also heals, as the Scarlet Spellbook's Arcane Stamina.
  z.strictObject({ kind: z.literal("recoveryHeal"), amount: AmountSchema }),
  // Each party member's first Hit Point Die spent in a Short Rest heals this much more, as Chef's Replenishing Meal.
  z.strictObject({ kind: z.literal("restMeal"), amount: AmountSchema }),
  // A Long Rest takes the bearer only this many hours, as Trance. The party rests as long as its slowest member.
  z.strictObject({
    kind: z.literal("restHours"),
    hours: z.number().int().min(1).max(7),
  }),
  // Heroic Inspiration at the start of each of the bearer's turns in a fight, if it has none, as Heroic Warrior.
  z.strictObject({ kind: z.literal("turnInspiration") }),
  // While an effect of one of these features' activations is on the bearer, a spell can take two Metamagic options,
  // as Sorcery Incarnate with Innate Sorcery.
  z.strictObject({
    kind: z.literal("doubleMetamagic"),
    while: z.array(ContentIdSchema).min(1),
  }),
  // While an effect of these features' activations is on the bearer, one Metamagic option a turn costs no Sorcery
  // Points, as Arcane Apotheosis with Innate Sorcery (metamagic.ts).
  z.strictObject({
    kind: z.literal("freeMetamagic"),
    while: z.array(ContentIdSchema).min(1),
  }),
  // The bearer's spells of this type ignore Resistance to it, and a 1 on their damage dice counts as a 2, as with
  // Elemental Adept.
  z.strictObject({
    kind: z.literal("energyMastery"),
    damage: DamageTypeSchema,
  }),
  // The bearer's spells cast with a slot need no Somatic component, as with a Spell Duelist's Trophy's Helping Hand.
  z.strictObject({ kind: z.literal("noSomatic") }),
  // The bearer's spells of these schools need no Verbal or Somatic component, so Silence or Slow doesn't hold them
  // back, while an effect of one of `while`'s features' activations is on it, as Superior Dread's Profane Casting.
  // shortcut: any of its spells of the school counts, not only its Warlock spells.
  z.strictObject({
    kind: z.literal("noComponents"),
    school: z.array(SpellSchoolSchema).min(1),
    while: z.array(ContentIdSchema).min(1).optional(),
  }),
  // A 1 on a damage die of the bearer's spells counts as a 2, as a Robe of Thayan Arcana's Empowered Magic or
  // Spell-Fueling Armor's Potent Spellcasting.
  z.strictObject({ kind: z.literal("empoweredSpells") }),
  // Damage of these types the bearer deals ignores Resistance, as with the Boon of Irresistible Offense.
  z.strictObject({
    kind: z.literal("overcomeResistance"),
    damage: z.array(DamageTypeSchema).min(1),
    // only damage from these spells or features, as Death Touch's Chill Touch or Envenom Weapons' poison
    sources: z.array(ContentIdSchema).min(1).optional(),
  }),
  // Effects on a creature the bearer hits with an attack dealing this type, as Crusher or Slasher give: with
  // `critical` only on a Critical Hit, with `oncePerTurn` once a turn.
  // Without `damage`, any hit `with` allows sets it off, as Eldritch Strike's weapon hit, and with `opportunity` only an
  // Opportunity Attack's, as Relentless Avenger's.
  z.strictObject({
    kind: z.literal("damageRider"),
    damage: DamageTypeSchema.optional(),
    with: HitKindSchema.optional(),
    opportunity: z.literal(true).optional(),
    critical: z.boolean().default(false),
    oncePerTurn: z.boolean().default(false),
    resource: z.string().optional(), // each use spends one, as Putrefy's once per rest
    spells: z.literal(true).optional(), // a spell's damage triggers it too, as Putrefy's
    effects: z.array(LeafEffectSchema).min(1),
    // what the bearer gets, as Relentless Avenger's move of half its Speed that provokes nothing
    selfEffects: z.array(LeafEffectSchema).min(1).optional(),
    // only while an effect of one of these features' activations is on the bearer, as Ancestral Protectors' Rage
    while: z.array(ContentIdSchema).min(1).optional(),
    ownTurn: z.literal(true).optional(), // only on the bearer's own turn
    firstRound: z.literal(true).optional(), // only in a fight's first round, as Ambush Master's
  }),
  // An attack's damage of these types lessened while the bearer wears this armor, as with Heavy Armor Master.
  z.strictObject({
    kind: z.literal("armoredReduction"),
    armor: z.enum(["light", "medium", "heavy"]),
    damage: z.array(DamageTypeSchema).min(1),
    amount: FormulaSchema.default({ base: 0, add: [] }),
    halve: z.literal(true).optional(), // Resistance instead, as Saint of Forge and Fire's
  }),
  // The most Dexterity this armor adds to AC, as Medium Armor Master raises it to 3.
  z.strictObject({
    kind: z.literal("armorDexMax"),
    armor: z.enum(["light", "medium", "heavy"]),
    max: z.number().int().min(0),
  }),
  // Ranged attacks of this kind have no Disadvantage from an enemy within 5 feet, and with `bypassCover` ignore Half and
  // Three-Quarters Cover, as Sharpshooter and Spell Sniper give. `crossbows` limits it to crossbows, as Crossbow Expert.
  z.strictObject({
    kind: z.literal("firingInMelee"),
    attack: z.enum(["weapon", "spell"]),
    crossbows: z.boolean().default(false),
    bypassCover: z.boolean().default(false),
  }),
  // A Reaction moves the bearer this many feet less when something pushes or pulls it, as Dwarven Plate's 10.
  z.strictObject({ kind: z.literal("bracing"), feet: z.number().int().min(5) }),
  // Attacks of this kind ignore Half Cover, as with a Wand of the War Mage's spell attacks.
  z.strictObject({
    kind: z.literal("ignoreHalfCover"),
    attack: z.enum(["weapon", "spell"]),
  }),
  // A healing die that rolls 1 is rolled again and the new roll stands, as with Healer's Healing Rerolls.
  z.strictObject({ kind: z.literal("healingRerolls") }),
  // Healing dice the bearer rolls for a creature at 0 Hit Points count as their highest faces, as Circle of
  // Mortality.
  z.strictObject({ kind: z.literal("maxHealingAtZero") }),
  // At the end of each of its turns the bearer ends one of these conditions on itself, as Self-Restoration. With
  // `turnStart`, as its turn starts instead, ending every one of them and spending `resource`, as Guarded Mind.
  z.strictObject({
    kind: z.literal("shakeOff"),
    conditions: z.array(ConditionSchema).min(1),
    turnStart: z.literal(true).optional(),
    resource: z.string().min(1).optional(),
  }),
  // An ally within `within` feet of the bearer treats a healing die's roll below `at` as `at`, as with a Soothing
  // Familiar's Healing Beacon.
  z.strictObject({
    kind: z.literal("healDieFloor"),
    at: z.number().int().min(2),
    within: z.number().int().min(5),
  }),
  // Spending a magic item's charges rolls a d6, and a 6 keeps them, as Use Magic Device's (combat/effects.ts payCosts).
  z.strictObject({ kind: z.literal("chargeSaver") }),
  // Reads any Spell Scroll with this ability, cantrips and level 1 spells reliably and a higher one behind a check of
  // it with Arcana of 10 plus the spell's level, whose failure wastes the scroll, as Use Magic Device's (stats.ts).
  z.strictObject({ kind: z.literal("anyScroll"), ability: AbilitySchema }),
  // Magic items made where the party could rest, from these plans, each `level` or more in `class` (by name after the
  // plugin), spending a use of `resource`, as Replicate Magic Item (gear.ts replicateActions): with more of them made
  // than `cap` (a scaling key, as `magicItems`, plus `extra`) the oldest vanishes, and with `transmute` one made can
  // become another, spending that resource instead, as Magic Item Tinker's Transmute. An item needing Attunement is
  // attuned as it's made, where there's room. shortcut: every plan the level allows is known.
  z.strictObject({
    kind: z.literal("replicate"),
    class: z.string().min(1),
    resource: z.string().min(1),
    cap: z.string().min(1),
    plans: z
      .array(
        z.strictObject({
          item: ContentIdSchema,
          level: z.number().int().min(1),
        }),
      )
      .min(1),
  }),
  // These dice added to the Initiative of the bearer and its allies, as Adventurer's Atlas's maps (combat/start.ts).
  z.strictObject({ kind: z.literal("partyInitiative"), dice: DiceSchema }),
  // More items a `replicate` makes before the oldest vanishes, as Improved Armorer's one more.
  z.strictObject({
    kind: z.literal("replicateExtra"),
    count: z.number().int().min(1),
  }),
  // A replicated item turned into another plan, spending a use of `resource`, as Magic Item Tinker's Transmute.
  z.strictObject({
    kind: z.literal("replicateTransmute"),
    resource: z.string().min(1),
  }),
  // A Short Rest lets the bearer change its prepared spells of this class (by name after the plugin) again, as Memorize
  // Spell (rest.ts, swap.ts). shortcut: every pick it changes after a Long Rest, not only one.
  z.strictObject({ kind: z.literal("memorize"), class: z.string().min(1) }),
  // Rolling on the table `from` holds, the bearer rolls twice and picks, as Controlled Chaos (combat/school.ts).
  z.strictObject({ kind: z.literal("tableTwice"), from: ContentIdSchema }),
  // Attuned to up to this many magic items at once, as an Artificer's Magic Item Adept's four (gear.ts).
  z.strictObject({
    kind: z.literal("attunementSlots"),
    count: z.number().int().min(4),
  }),
  // This much off the price of nonmagical items the bearer buys, as with Crafter.
  z.strictObject({
    kind: z.literal("shopDiscount"),
    percent: z.number().int().min(1).max(100),
  }),
  // Counts as one size larger for carrying, with Advantage on checks to escape a grapple, as with Powerful Build.
  z.strictObject({ kind: z.literal("powerfulBuild") }),
  // A failed save with one of these abilities, or against one of these conditions, succeeds instead, spending the
  // resource, as with Mage Slayer's Guarded Mind. With `bonus` it's added to the roll when that's enough, as with
  // Survivor's Steel Yourself, and with `reaction` it takes the bearer's Reaction too.
  z.strictObject({
    kind: z.literal("saveRescue"),
    abilities: z.array(AbilitySchema).default([]),
    conditions: z.array(ConditionSchema).default([]),
    bonus: FormulaSchema.optional(),
    // A die rolled and added instead, when its highest roll could be enough, as Spell Resistant's 1d6. `dieSize` is a
    // scaling key for its size, as Greater Aberrant Mark's 1d6 for Aberrant Fortitude's 1d4.
    bonusDice: DiceSchema.optional(),
    dieSize: z.string().optional(),
    // Up to this many of the bearer's Hit Point Dice rolled and added, one at a time while the highest rolls could be
    // enough, and spent, as a Ring of Dedicated Focus's two on a save to keep Concentration. `resource` is then
    // "hitDice".
    hitDice: z.number().int().min(1).optional(),
    // With `hitDice`, a use of this resource spent too, as Sustained Symbiosis's uses a Long Rest.
    uses: z.string().min(1).optional(),
    concentration: z.literal(true).optional(), // a save to keep Concentration, as the Ring of Dedicated Focus's
    magical: z.literal(true).optional(), // only a save against a spell, as Magic Resistant
    from: SaveFromSchema.optional(), // only a save against this, as a Scarab of Protection's
    reaction: z.boolean().default(false),
    resource: z.string(),
    // The item whose charges `resource` holds: spending its last one spends the item, as a Scarab of Protection
    // crumbles, with no d20.
    item: ContentIdSchema.optional(),
  }),
  // A creature the bearer damages has Disadvantage on the save to keep Concentration, as with Mage Slayer.
  z.strictObject({ kind: z.literal("concentrationBreaker") }),
  // Disengage doesn't stop the bearer's Opportunity Attacks, and a creature it hits with one stops moving, as with
  // Sentinel.
  z.strictObject({ kind: z.literal("sentinel") }),
  // Advantage on attack rolls against a creature the bearer has grappled, as with Grappler.
  // With `allies`, the bearer's allies have it too, as with Street Justice's Headlock.
  z.strictObject({
    kind: z.literal("grappledAdvantage"),
    allies: z.literal(true).optional(),
  }),
  // Once a turn, one damage die of a hit of this type is rolled again, and a Critical Hit rolls one more die, as
  // with Piercer.
  z.strictObject({ kind: z.literal("damageReroll"), damage: DamageTypeSchema }),
  // Helping, it can trade places with a willing ally within 5 feet that isn't Incapacitated, which provokes nothing, as
  // Emerald Enclave Fledgling's Tag Team.
  z.strictObject({ kind: z.literal("helpSwap") }),
  // Help distracts an enemy this far away, as with Harper Agent's Distracting Melody.
  z.strictObject({
    kind: z.literal("helpRange"),
    feet: z.number().int().min(10),
  }),
  // Once a turn, a Critical Hit gives an ally within 30 feet Heroic Inspiration, as with Lords' Alliance Agent.
  z.strictObject({ kind: z.literal("critInspiration") }),
  // An enemy that damages an ally within 5 feet of the bearer is easier to hit until the end of the bearer's next
  // turn, as with Lords' Alliance Agent's Reassert Honor.
  z.strictObject({ kind: z.literal("avengeAlly") }),
  // An Opportunity Attack's damage dice are rolled twice and the higher kept, as with Zhentarim Ruffian.
  z.strictObject({ kind: z.literal("opportunityDamage") }),
  // Heroic Inspiration held as a fight starts is spent on Advantage on the party's Initiative, as with Zhentarim
  // Ruffian's Family First.
  z.strictObject({ kind: z.literal("initiativeInspiration") }),
  // Readying an action gives the next attack against the bearer Disadvantage, as with Tyro of the Gauntlet.
  z.strictObject({ kind: z.literal("vigilant") }),
  // An Initiative d20 of this or lower is rolled again, and the new roll stands, as with Survivor's Hypervigilance.
  z.strictObject({
    kind: z.literal("initiativeReroll"),
    atMost: z.number().int().min(1).max(19),
  }),
  // Advantage on the check of a Search or Study action, spending a use of the resource only when it succeeds, as
  // with Sharp Eye.
  z.strictObject({ kind: z.literal("sharpEye"), resource: z.string() }),
  // Advantage on a check with a skill the bearer is proficient in while its familiar is within 5 feet, spending a
  // use of the resource, as with Familiar Friend's Helpful Friend. Out of a fight the familiar is always beside it.
  z.strictObject({ kind: z.literal("familiarHelp"), resource: z.string() }),
  // Another creature at least one size smaller can ride the bearer as a controlled mount (combat/mounts.ts), as a
  // Find Steed steed.
  z.strictObject({ kind: z.literal("rideable") }),
  // Proficiency in every skill, as with Boon of Skill's All-Around Adept.
  z.strictObject({ kind: z.literal("allSkills") }),
  // The Dash action adds this many feet more, as with Charger's Improved Dash.
  z.strictObject({
    kind: z.literal("dashBonus"),
    feet: z.number().int().min(5),
  }),
  // Standing up from Prone costs only 5 feet of movement, as with Athlete's Hop Up.
  z.strictObject({ kind: z.literal("quickStand") }),
  // Taking the Dodge action spends a Hit Point Die to heal by its roll plus the Constitution modifier, as with Dwarven
  // Fortitude.
  z.strictObject({ kind: z.literal("dodgeHeal") }),
  // After an attack with a Light weapon, the Bonus Action attack can use any melee weapon that isn't Two-Handed, as
  // with Dual Wielder.
  z.strictObject({ kind: z.literal("dualWielder") }),
  // After an attack with a Quarterstaff, a Spear or a Heavy weapon with Reach, a Bonus Action attack with its other
  // end, as with Polearm Master's Pole Strike.
  z.strictObject({ kind: z.literal("poleStrike") }),
  // Shield Master: once on its turn, a melee weapon hit on a creature within 5 feet knocks it Prone unless it passes
  // a Strength save, and with a Reaction a Dexterity save for half damage takes none, while it holds a Shield.
  z.strictObject({ kind: z.literal("shieldBash") }),
  z.strictObject({ kind: z.literal("interposeShield") }),
  // A miss hits instead, once until the bearer's next turn starts, as with Boon of Combat Prowess's Peerless Aim.
  z.strictObject({ kind: z.literal("peerlessAim") }),
  // A failed save is rolled again, once until the bearer's next turn starts, as with Boon of Fortune's Favor.
  z.strictObject({ kind: z.literal("saveReroll") }),
  // As a Long Rest ends, this many d20s are rolled and kept, which a `replaceRoll` with `foretold` spends, as
  // Portent's two or Greater Portent's three (the most of these passives counts).
  z.strictObject({
    kind: z.literal("foretell"),
    count: z.number().int().min(1),
  }),
  // A ward whose Hit Points are this resource's unspent uses takes the bearer's damage first, after its Resistances,
  // once `made` has been spent since its last rest, as Arcane Ward (combat/reactions.ts).
  z.strictObject({
    kind: z.literal("wardPool"),
    resource: z.string().min(1),
    made: z.string().min(1),
  }),
  // Resistance to all damage other creatures deal the bearer, but none against a creature it has attacked or cast a
  // spell on since its last Long Rest, as Emissary of Redemption (combat/reactions.ts beforeDamage).
  z.strictObject({ kind: z.literal("creatureResistance") }),
  // Psychic damage of this type a creature deals the bearer, it takes the same of, as Thought Shield.
  z.strictObject({ kind: z.literal("mirrorDamage"), damage: DamageTypeSchema }),
  // When a creature under the bearer's effect from one of these calls for its save, the bearer's Reaction makes a
  // weapon attack at it first, and a hit makes the save succeed, as Slayer's Counter (combat/reactions.ts).
  z.strictObject({
    kind: z.literal("saveCounter"),
    marked: z.array(ContentIdSchema).min(1),
  }),
  // These dice added to a save that such a creature calls for, as Supernatural Defense's 1d6.
  z.strictObject({
    kind: z.literal("preyBonus"),
    marked: z.array(ContentIdSchema).min(1),
    dice: DiceSchema,
  }),
  // Damage of this type from a failed save against a spell rolls a d`die`, and on a 1 every other creature within
  // `radius` saves with `ability` against `dc` or takes `type` damage equal to the uses left of `resources`, and
  // `item` is spent, as a Helm of Brilliance's beams from its gems (combat/effects.ts).
  z.strictObject({
    kind: z.literal("spellBackfire"),
    damage: DamageTypeSchema,
    die: z.number().int().min(2).default(20),
    radius: z.number().int().min(5),
    ability: AbilitySchema,
    dc: z.number().int().min(1),
    type: DamageTypeSchema,
    resources: z.array(z.string().min(1)).min(1),
    item: ContentIdSchema,
  }),
  // Armor's Strength requirement doesn't slow the bearer, as Arcane Armor's.
  z.strictObject({ kind: z.literal("armorStrength") }),
  // Resistance to the damage of spells, as Spell Resistance.
  z.strictObject({ kind: z.literal("spellDamageResistance") }),
  // A Sneak Attack die that rolls below this counts as this, as Murderous Intent's 3.
  z.strictObject({
    kind: z.literal("sneakFloor"),
    value: z.number().int().min(2).max(6),
  }),
  // A walk of 5 feet or more inside the bearer's reach provokes its Opportunity Attack too, as Hold the Line.
  z.strictObject({ kind: z.literal("holdTheLine") }),
  // An Opportunity Attack once on each other creature's turn once its Reaction is spent, as Vigilant Defender's
  // special reaction (combat/movement.ts).
  z.strictObject({ kind: z.literal("vigilantDefender") }),
  // Resistance to every damage type but these while Bloodied, or while in Dim Light or Darkness ("shadows"), as Boon
  // of Desperate Resilience or Boon of the Night Spirit's Shadowy Form gives.
  z.strictObject({
    kind: z.literal("resistAll"),
    while: z.enum(["bloodied", "shadows"]),
    except: z.array(DamageTypeSchema).default([]),
  }),
  // An attack roll with Advantage that uses Dexterity, Intelligence, Wisdom or Charisma rolls a third d20, as with
  // Elven Accuracy.
  z.strictObject({ kind: z.literal("elvenAccuracy") }),
  // Damage never calls for a save to keep Concentration, as with Boon of the Iron Mind.
  z.strictObject({
    kind: z.literal("unshakableFocus"),
    // only Concentration on one of these spells, as Guided Precision's Faerie Fire
    spells: z.array(ContentIdSchema).min(1).optional(),
    // only on a spell of these schools, as Focused Conjuration's Conjuration spells
    schools: z.array(SpellSchoolSchema).min(1).optional(),
  }),
  // A 1 on a damage die of this type for the bearer's spell is rolled again, as with Flames of Phlegethos.
  // Casting with a level 1-4 slot rolls a d4, and a roll equal to the slot's level keeps it, as with Boon of Spell
  // Recall.
  z.strictObject({ kind: z.literal("slotRecall") }),
  z.strictObject({
    kind: z.literal("spellRerollOnes"),
    damage: DamageTypeSchema,
  }),
  // Damage of these types heals the bearer instead, as an iron golem's Fire Absorption.
  z.strictObject({
    kind: z.literal("absorb"),
    damage: z.array(DamageTypeSchema).min(1),
  }),
  // Taking damage of these types puts these on the bearer until the end of its next turn, as a yeti's Fear of Fire.
  z.strictObject({
    kind: z.literal("onDamage"),
    damage: z.array(DamageTypeSchema).min(1),
    modifiers: z.array(ModifierSchema).min(1),
  }),
  // Attack rolls against the bearer have Disadvantage, except until its next turn after it makes one ("attacking"),
  // as a harvester devil's Diabolic Ward, or while it's Incapacitated, as an unspeakable horror's form.
  z.strictObject({
    kind: z.literal("ward"),
    // "damaged": until its next turn starts after it takes damage, and while its Speed is 0, as a Cloak of
    // Displacement
    suppressed: z.enum(["attacking", "incapacitated", "damaged"]),
  }),
  // These spells do nothing to the bearer, as a helmed horror's Spell Immunity.
  // With `rangedAttacks`, every spell that makes a ranged attack roll too, as a tarrasque's Reflective Carapace.
  z.strictObject({
    kind: z.literal("spellImmunity"),
    spells: z.array(ContentIdSchema).min(1),
    rangedAttacks: z.literal(true).optional(),
  }),
  // Dropping to 0 Hit Points the first time, it comes back at once as this monster (its own stat block when left
  // out) with all or half its Hit Points, as Gennifer's Suppressed Lycanthropy or a priest of Osybus's tattoo.
  z.strictObject({
    kind: z.literal("reborn"),
    monster: ContentIdSchema.optional(),
    hp: z.enum(["full", "half"]),
  }),
  // Advantage on its Initiative roll, as an asteroid spider's False Appearance gives one that lies still. With `allies`
  // its allies' too, as a Weapon of Warning's. shortcut: every ally, not only those within 30 feet, since a party
  // starts a fight together.
  z.strictObject({
    kind: z.literal("initiativeAdvantage"),
    allies: z.literal(true).optional(),
  }),
  // A Critical Hit against the bearer is a normal hit, as with Adamantine Armor.
  z.strictObject({ kind: z.literal("noCriticals") }),
  // Knocked Prone, an odd roll of a die leaves it Incapacitated until it passes this save at the end of a turn, as a
  // flumph's Prone Deficiency.
  z.strictObject({
    kind: z.literal("proneDeficiency"),
    ability: AbilitySchema,
    dc: z.number().int(),
  }),
  // Dispel Magic aimed at it is a Constitution save against the caster's spell save DC, or this condition for a
  // minute or until it takes damage, as a clockwork horror's Shutdown.
  z.strictObject({
    kind: z.literal("dispelShutdown"),
    condition: ConditionSchema,
  }),
  // Disadvantage on saves against these conditions, as a shoggoth's Susceptible to Charm.
  z.strictObject({
    kind: z.literal("saveDisadvantage"),
    conditions: z.array(ConditionSchema).min(1),
  }),
  // Checks to see through the bearer's illusions have Disadvantage, as Illusion Adept's.
  z.strictObject({ kind: z.literal("subtleIllusions") }),
  // While disguised, Advantage on Deception and Performance checks in a scene, as Actor's Impersonation.
  z.strictObject({ kind: z.literal("impersonation") }),
  // Attack rolls against a creature within 5 feet of the bearer's image of itself have Advantage, the bearer's own
  // once it's within 5 feet of that creature too, and with `allies` its allies' as well, as Invoke Duplicity's
  // Distract and Improved Duplicity's Shared Distraction (combat/attack.ts).
  z.strictObject({
    kind: z.literal("distract"),
    allies: z.literal(true).optional(),
  }),
  // Gains no Exhaustion levels, as a Book of Vile Darkness's Tireless Form (combat/effects.ts).
  z.strictObject({ kind: z.literal("noExhaustion") }),
  // Disadvantage on attack rolls against creatures of these types and on saves against what they call for, as Demon
  // Armor's curse against demons (combat/attack.ts, combat/effects.ts rollSave).
  z.strictObject({
    kind: z.literal("foeDisadvantage"),
    creatureTypes: z.array(z.string().min(1)).min(1),
  }),
  // Resistance to the damage of ranged weapon attacks, as a Shield of Missile Attraction's (combat/attack.ts).
  z.strictObject({ kind: z.literal("missileResistance") }),
  // A ranged weapon attack aimed at another creature within this many feet of the bearer targets the bearer instead,
  // as a Shield of Missile Attraction's curse (combat/attack.ts).
  z.strictObject({
    kind: z.literal("missileMagnet"),
    within: z.number().int().min(5),
  }),
  // Disadvantage on attack rolls with weapons other than this item and those made from it, as a Berserker Axe's curse
  // (combat/attack.ts).
  z.strictObject({ kind: z.literal("soleWeapon"), item: ContentIdSchema }),
  // Damaged by another creature in a fight, a failed save of `ability` against `dc` sends the bearer into a fury: on
  // its turns it attacks the nearest creature it reaches, friend or foe, until it starts a turn with none within 60
  // feet, as a Berserker Axe's wielder, or with `damager` the creature that damaged it, until either drops or it's out
  // of reach as a turn starts, as a Sword of Vengeance's (combat/madness.ts). shortcut: the damager is the creature
  // whose turn it is, and the fury's attack is one, its other attacks the bearer's own choice.
  z.strictObject({
    kind: z.literal("fury"),
    ability: AbilitySchema,
    dc: z.number().int().min(1),
    damager: z.literal(true).optional(),
  }),
  // Starting its turn Bloodied, a 6 on a d6 makes it berserk until it isn't Bloodied: it attacks the nearest creature
  // it can see, friend or foe, as a flesh golem's Berserk (combat/turn.ts).
  z.strictObject({ kind: z.literal("berserk") }),
  // Moving a creature it grapples costs no extra movement, as a bugbear's Abduct (combat/queries.ts).
  z.strictObject({ kind: z.literal("abduct") }),
  // Two creatures in one square: with `allies` the bearer's allies may end their moves in its space, with Half Cover
  // there under `cover`, as a death's head tree's Overhanging Branches; with `self` the bearer may enter any
  // creature's space and stop there, as a gallows speaker's Whirling Form.
  z.strictObject({
    kind: z.literal("shareSpace"),
    who: z.enum(["allies", "self"]),
    cover: z.boolean().default(false),
    // What a creature takes when the bearer first enters its space on a move, as a fire elemental's Fire Form.
    burn: z.array(DamageSchema).optional(),
  }),
  // Its area spells spare itself and up to `creatures` others of its side, as an evoker's Evocation Sculptor.
  // With `schools` only spells of those, and with `perLevel` the spell's level more, as Sculpt Spells' 1 plus the
  // level of Evocation spells; the caster then counts as one of them.
  z.strictObject({
    kind: z.literal("sculptor"),
    creatures: z.number().int().min(1),
    schools: z.array(SpellSchoolSchema).min(1).optional(),
    perLevel: z.literal(true).optional(),
  }),
  // A hydra's heads: `heads` to begin with, one dies to `damage` or more in a turn, each dead one grows `regrow` back
  // at its turn's end unless it took a `stoppedBy` type, healing `heal`. It makes one bite and, beyond the first, has
  // one Opportunity Attack Reaction a head (combat/heads.ts).
  z.strictObject({
    kind: z.literal("heads"),
    heads: z.number().int().min(1),
    damage: z.number().int().min(1),
    regrow: z.number().int().min(1),
    heal: z.number().int().min(0),
    stoppedBy: z.array(DamageTypeSchema).default([]),
  }),
  // A Reaction on every turn, as a marilith's Reactive.
  z.strictObject({ kind: z.literal("reactive") }),
  // Dropping to 0 Hit Points while not Petrified turns it to stone with this many Hit Points, as a vampire warden.
  z.strictObject({
    kind: z.literal("stoneRestoration"),
    hp: z.number().int().min(1),
  }),
  // A condition it always has, as an invisible stalker's Invisibility.
  z.strictObject({
    kind: z.literal("innateCondition"),
    condition: ConditionSchema,
  }),
  // A hit of `slashing` or more Slashing damage while Bloodied severs a limb that fights as this monster, at a level
  // of Exhaustion each until it next regains Hit Points, as a troll's Loathsome Limbs.
  z.strictObject({
    kind: z.literal("severedLimbs"),
    monster: ContentIdSchema,
    slashing: z.number().int().min(1),
    resource: z.string(), // counts the limbs lost
    uses: z.number().int().min(1), // the most it can lose, as "(4/Day)"
  }),
  // This much added to the damage of a weapon thrown with a ranged attack, as with Thrown Weapon Fighting.
  z.strictObject({
    kind: z.literal("thrownDamage"),
    bonus: z.number().int().min(1),
  }),
  // A thrown weapon's long range has no Disadvantage, as with Bomber's Long Shots.
  z.strictObject({ kind: z.literal("longShots") }),
  // Casting a spell of this school, as an Arcana Unleashed adept's: with a slot, Temporary Hit Points of twice its
  // level ("ward"), up to two Hit Point Dice of healing plus its level ("life") or 5 feet of Speed a level this turn
  // ("augment"); once a turn up to two Hit Point Dice added to its damage ("fueled"); or a bonus to keep
  // Concentration on it ("persistent"); or, with a level 2+ slot, a spent slot of a lower level up to 5 back
  // ("refund", as Expert Divination). combat/school.ts.
  z.strictObject({
    kind: z.literal("schoolCast"),
    school: SpellSchoolSchema,
    rider: z.enum([
      "ward",
      "life",
      "augment",
      "fueled",
      "persistent",
      "refund",
    ]),
  }),
  // A failed ability check gets this die added when it could be enough, spending a use, as Reborn's Knowledge from a
  // Past Life.
  // `dieSize` is a scaling key for the die, as Peerless Skill's Bardic Inspiration die; `skills` limits it to checks
  // with those, as Tactical Assessment's; and with `keep` a use isn't spent when the check still fails, as Tactical
  // Mind's Second Wind.
  z.strictObject({
    kind: z.literal("checkRescue"),
    bonusDice: DiceSchema,
    resource: z.string(),
    dieSize: z.string().optional(),
    skills: z.array(SkillSchema).min(1).optional(),
    keep: z.literal(true).optional(),
  }),
  // A check or save with this ability totals at least the bearer's score in it, as Indomitable Might's Strength.
  z.strictObject({ kind: z.literal("scoreFloor"), ability: AbilitySchema }),
  // Half the Proficiency Bonus, rounded down, on a skill check it isn't proficient in, as Jack of All Trades.
  z.strictObject({ kind: z.literal("halfProficiency") }),
  // Proficiency with these tools, by id (core/explore.ts).
  z.strictObject({
    kind: z.literal("toolProficiency"),
    tools: z.array(ContentIdSchema).default([]),
  }),
  // Counts as carrying any Artisan's Tools, proficient with them, as a Manifold Tool turns into the one needed
  // (core/explore.ts).
  z.strictObject({ kind: z.literal("anyTool") }),
  // Disadvantage on a D20 Test is cancelled by spending `cost` of `resource`, as Drunkard's Luck's Focus Points.
  z.strictObject({
    kind: z.literal("cancelDisadvantage"),
    resource: z.string().min(1),
    cost: z.number().int().min(1).default(1),
  }),
  // Right after a D20 Test of the bearer's rolls a 1, it makes this save, and on a failure `effects` land on it, as
  // Echoing Soul's Intrusive Echoes (combat/natural-one.ts). The save itself doesn't set it off again.
  z.strictObject({
    kind: z.literal("naturalOne"),
    name: z.string().min(1),
    save: z.strictObject({ ability: AbilitySchema, dc: FormulaSchema }),
    effects: z.array(LeafEffectSchema).min(1),
  }),
  // One of `resource`'s dice rolled and added to the bearer's Initiative, as Ambush's Superiority Die.
  z.strictObject({
    kind: z.literal("initiativeDie"),
    bonusDice: DiceSchema,
    dieSize: z.string().optional(),
    resource: z.string().min(1),
  }),
  // Advantage on checks to escape a grapple, as Vampire Hunter's Adroit Escape.
  z.strictObject({ kind: z.literal("escapeAdvantage") }),
  // Raises a scaling key to at least this, as a Greater Mark's 1d6 for its Mark's 1d4 (`dieSize` "intuitionDie").
  z.strictObject({
    kind: z.literal("scalingFloor"),
    key: z.string().min(1),
    value: z.number().int().min(1),
  }),
  // Advantage on saves with these abilities while within 5 feet of an ally that can act, for the bearer and that
  // ally, as Order's Resilience's Stronger Together.
  z.strictObject({
    kind: z.literal("allySaveAdvantage"),
    abilities: z.array(AbilitySchema).min(1),
  }),
  // This much more whenever a healing effect heals the bearer, once until its next turn starts, as Boon of
  // Fortitude's Fortified Health. shortcut: only healing effects, not Hit Point Dice or regeneration.
  z.strictObject({ kind: z.literal("healBonus"), amount: FormulaSchema }),
  // This many more Temporary Hit Points whenever it gains some, as Boon of Bountiful Health's Augmented Health.
  z.strictObject({
    kind: z.literal("tempHpBonus"),
    amount: z.number().int().min(1),
  }),
  // Its Hit Point Dice rolled to heal count at least `floor`, or with `highest` as their highest number, as Bloodlust's
  // Powerful Recovery and Boon of Bountiful Health's Superior Recuperation.
  z.strictObject({
    kind: z.literal("hitDieRolls"),
    floor: z.number().int().min(2).optional(),
    highest: z.literal(true).optional(),
    double: z.literal(true).optional(), // what a die heals counts twice, as with a Periapt of Wound Closure
  }),
  // A damage roll of this type uses the highest number on each die, spending a use, as Powerful Radiance.
  z.strictObject({
    kind: z.literal("maxDamageDice"),
    damage: DamageTypeSchema,
    resource: z.string().optional(),
    oncePerTurn: z.literal(true).optional(), // with no `resource`, once a turn instead, as Perfect Poisoner
  }),
  // Once a turn, an attack made while Bloodied deals the Proficiency Bonus more, as Boon of Bloodshed's Power from Pain.
  z.strictObject({ kind: z.literal("bloodiedDamage") }),
  // An enemy dropping to 0 Hit Points gives the bearer's next attack Advantage, as Boon of Bloodshed's Killer's
  // Fortune.
  z.strictObject({ kind: z.literal("killAdvantage") }),
  // A foe dropping to 0 Hit Points puts these effects on the bearer, as Dark One's Blessing's Temporary Hit Points:
  // with `within`, only a foe that near it, or with `mine` one it dropped itself; spending a use of the resource, and
  // with `reaction` its Reaction, as Boon of the Soul Drinker's Siphon Life. With `ally` they go to the most hurt of
  // the bearer and its allies within `within`, with `fallenHitDice` a heal is the foe's number of Hit Dice, and with
  // `oncePerTurn` it works once until the bearer's next turn starts and never while it's Incapacitated, as Keeper
  // of Souls.
  z.strictObject({
    kind: z.literal("onKill"),
    effects: z.array(LeafEffectSchema).min(1),
    within: z.number().int().min(5).optional(),
    mine: z.literal(true).optional(),
    resource: z.string().optional(),
    reaction: z.literal(true).optional(),
    ally: z.literal(true).optional(),
    fallenHitDice: z.literal(true).optional(),
    // Temporary Hit Points it gives are the foe's Hit Point maximum, as Blackrazor's for a soul it devours, never
    // from a Construct or an Undead
    fallenMaxHp: z.literal(true).optional(),
    oncePerTurn: z.literal(true).optional(),
    // only a foe under an effect of the bearer's from one of these, as Hexblade's Curse's healing
    marked: z.array(ContentIdSchema).min(1).optional(),
  }),
  // Helping an attack on an enemy also gives it Disadvantage on its next save, as Harper Teamwork.
  z.strictObject({ kind: z.literal("helpRider") }),
  // Ending Frightened or Paralyzed on itself with a save ends it on an ally within 30 feet, as Inspiring Willpower.
  z.strictObject({ kind: z.literal("sharedRecovery") }),
  // A slot spell's damage dice count 1s and 2s as 3s and knock the damaged Prone, spending a use, as Boon of Erupting
  // Spellpower.
  z.strictObject({ kind: z.literal("spellOverload"), resource: z.string() }),
  // Once on its turn, a melee hit after moving 10 feet closer to the target adds 1d8, as Charger's Charge Attack.
  z.strictObject({ kind: z.literal("chargeAttack") }),
  // The bearer can cast spells in a form that keeps its features, as Beast Spells in Wild Shape, only of these
  // schools when `school` names them, as Transmute Spells (stats.ts deriveStats).
  z.strictObject({
    kind: z.literal("formSpells"),
    school: z.array(SpellSchoolSchema).min(1).optional(),
  }),
  // Casting a spell that deals this type puts these effects on the bearer, as Flames of Phlegethos' flames.
  // With `school` instead, casting a spell of that school with an action and a spell slot does, as Bewitching
  // Magic's Misty Step after an Enchantment spell. With `uses`, casting one of these spells does, as Hunter's Rime's
  // Temporary Hit Points with Hunter's Mark, and `onTargets` go on the spell's targets, as its hold on the marked.
  // With `heals`, a spell that restores Hit Points to a creature other than the caster, as Blessed Healer's own
  // healing; `slot` only with a spell slot, and a `slotLevel` term in its effects is that slot's level.
  // `whileAspect` only while the bearer has that aspect, as Starry Form's Chalice, and `level` only between these
  // levels in a class.
  z.strictObject({
    kind: z.literal("castRider"),
    damage: DamageTypeSchema.optional(),
    types: z.array(DamageTypeSchema).min(1).optional(), // a spell dealing any of these, as Heart of the Storm's
    // `damage` to each foe within `within` feet of the caster, as Heart of the Storm's eruption, or with `one` to the
    // most hurt of them, as Spellfire Burst's Radiant Fire; with no foe there, `otherwise` goes on the caster, as
    // Bolstering Flames' Temporary Hit Points.
    nearby: z
      .strictObject({
        within: z.number().int().min(5),
        damage: z.array(DamageSchema).min(1),
        one: z.literal(true).optional(),
        otherwise: z.array(LeafEffectSchema).min(1).optional(),
      })
      .optional(),
    // a spell whose cost spends this, as Spellfire Burst's Sorcery Points
    spends: z.string().min(1).optional(),
    cantrip: z.literal(true).optional(), // only a cantrip, as Mark of Inspiration's
    fromFeat: ContentIdSchema.optional(), // only a spell picked for this feat, as Aberrant Surge's level 1 spell
    // `onTargets` dispels end no spell above the slot's level, as the 2014 Arcana Domain's Spell Breaker
    slotCaps: z.literal(true).optional(),
    // Hit Point Dice spent and rolled, up to `count`: with `parity` an even roll gives that many Temporary Hit Points
    // and an odd one deals it as Force damage to the most hurt foe within `within` feet (or the caster with none
    // there), as Aberrant Surge; without, both, the Temporary Hit Points with the Constitution modifier added, as Mark
    // of Inspiration.
    hitDice: z
      .strictObject({
        count: z.number().int().min(1),
        within: z.number().int().min(5),
        parity: z.literal(true).optional(),
      })
      .optional(),
    oncePerTurn: z.literal(true).optional(),
    // only while the bearer has none of these features, as Spellfire Burst before Honed Spellfire takes its place
    without: z.array(ContentIdSchema).min(1).optional(),
    school: z.array(SpellSchoolSchema).min(1).optional(),
    uses: z.array(ContentIdSchema).min(1).optional(),
    heals: z.literal(true).optional(),
    // with `school`, any spell of it, a cantrip or one cast without an action too, as Arcane Artist's Inspiring Magic
    anySpell: z.literal(true).optional(),
    selfToo: z.literal(true).optional(), // with `heals`, healing the caster counts too, as Starry Form's Chalice
    whileAspect: z.string().min(1).optional(),
    level: z
      .strictObject({
        class: ContentIdSchema,
        min: z.number().int().min(1).optional(),
        max: z.number().int().min(1).optional(),
      })
      .optional(),
    mends: z.literal(true).optional(), // a spell that restores Hit Points or ends a condition, as Dispelling Recovery's
    slot: z.literal(true).optional(),
    effects: z.array(LeafEffectSchema).default([]),
    // One of these the caster may pick once the spell is done, as Steps of the Fey's Refreshing or Taunting Step
    // (combat/school.ts): `effects` on the caster or one creature of its side within `within` feet of it, or `foes`
    // effects on each foe within that far of where it cast the spell, after this save against its spell save DC, or
    // with `one` on one foe of the caster's choice that near it, as Beguiling Magic's.
    choices: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          within: z.number().int().min(5).optional(),
          effects: z.array(LeafEffectSchema).default([]),
          foes: z
            .strictObject({
              save: AbilitySchema.optional(),
              effects: z.array(LeafEffectSchema).min(1),
              one: z.literal(true).optional(),
            })
            .optional(),
        }),
      )
      .min(1)
      .optional(),
    onTargets: z.array(LeafEffectSchema).min(1).optional(),
    resource: z.string().optional(), // spending a use, only while one is left, as Defy Death's after Spare the Dying
    // with `school`, a spell of any casting time cast with a slot, as Arcane Ward's Abjuration spells
    slotted: z.literal(true).optional(),
    // A spell of one of these classes' lists (by name after the plugin) cast with a slot, as a Sorcerer spell for
    // Wild Magic Surge; with `chance` only when a d`die` shows `at` or more, once a turn, as its d20 of 20, and with
    // `chance` and no `classes` any slot spell, as in a Wild Magic Zone.
    classes: z.array(z.string().min(1)).min(1).optional(),
    chance: z
      .strictObject({
        die: z.number().int().min(2),
        at: z.number().int().min(1),
      })
      .optional(),
    // the table the content entry `from` holds is rolled on, aimed at the spell's first target (combat/school.ts),
    // or with `pick` the caster picks its row, any but the last, as Tamed Surge
    rollTable: ContentIdSchema.optional(),
    pick: z.literal(true).optional(),
    // only while this resource has a use spent, which it gives back, as Tides of Chaos regained by a Sorcerer spell
    refills: z.string().min(1).optional(),
    // its `effects` go to the most hurt of the bearer's allies of these types within `within` instead, as Undead
    // Vitality's healing of an Undead
    toAlly: z
      .strictObject({
        creatureTypes: z.array(CreatureTypeSchema).min(1),
        within: z.number().int().min(5),
      })
      .optional(),
  }),
  // Using an activation of this feature also does these to the bearer, as Tactical Shift's move with Second Wind or
  // Arcane Charge's teleport with Action Surge; with `while`, only while an effect of one of those features'
  // activations is on it, as Reckless Abandon's Temporary Hit Points with Reckless Attack in a Rage.
  // With `label` only the activation of that label, and `damage` adds to a save's damage, dealt only on a failure,
  // as Sear Undead's Radiant on Turn Undead.
  z.strictObject({
    kind: z.literal("activationRider"),
    feature: ContentIdSchema,
    label: z.string().min(1).optional(),
    effects: z.array(LeafEffectSchema).default([]),
    // effects on the bearer, whatever the activation's targets, as Drunken Technique's Disengage with Flurry of Blows
    self: z.array(LeafEffectSchema).min(1).optional(),
    damage: z.array(DamageSchema).min(1).optional(),
    while: z.array(ContentIdSchema).min(1).optional(),
  }),
  // A Long Rest leaves one of this item with the bearer, as Vampire's Plaything's Decanting.
  z.strictObject({ kind: z.literal("restItem"), item: ContentIdSchema }),
  // A Reaction keeps an ally within 5 feet from being pushed or pulled, as Tyro of the Gauntlet's Stand as One.
  z.strictObject({ kind: z.literal("standAsOne") }),
  // Once a turn, hitting a Bloodied creature that isn't a Construct or Undead spends a Hit Point Die to heal its roll
  // plus the Constitution modifier, spending a use, as Bloodlust's Sanguine Feast.
  z.strictObject({ kind: z.literal("bloodiedFeast"), resource: z.string() }),
  // Gear used with an action takes a Bonus Action instead, as with Fast Hands (stats.ts fastHands).
  z.strictObject({ kind: z.literal("fastHands") }),
  // What weapon attacks of a kind gain (weapon-riders.ts), as Archery's +2 to hit with a Ranged weapon, Dueling's +2
  // damage with a one-handed Melee weapon, Great Weapon Master's Proficiency Bonus with a Heavy one, Pact of the
  // Blade's Necrotic, Psychic or Radiant in place of the weapon's type (the one its target resists least), or Battering
  // Roots' 10 feet more reach. `while` holds it to an effect of these features' activations, as Sacred Weapon's.
  z.strictObject({
    kind: z.literal("weaponRider"),
    with: HitKindSchema,
    oneHanded: z.literal(true).optional(), // only a weapon without the Two-Handed property, as Dueling's
    attack: z.number().int().optional(),
    damage: FormulaSchema.optional(),
    types: z.array(DamageTypeSchema).min(1).optional(),
    reach: z.number().int().min(5).optional(),
    ability: AbilitySchema.optional(), // used for the attack and damage when it's better, as Battle Ready's Intelligence
    while: z.array(ContentIdSchema).min(1).optional(),
    ownTurn: z.literal(true).optional(), // only on the bearer's own turn, as Battering Roots' reach
    attackMod: AbilitySchema.optional(), // this ability's modifier (at least +1) added to hit, as Sacred Weapon's
    // its first damage die is this scaling key's where that's bigger, as Martial Arts' die with Monk weapons
    dieAtLeast: z.string().optional(),
    armor: z.enum(["noHeavy", "none"]).optional(), // as a modifier passive's
  }),
  // In a fight's first round, a hit carrying Sneak Attack makes its target save or take the hit's damage twice, as
  // Death Strike.
  z.strictObject({
    kind: z.literal("deathStrike"),
    ability: AbilitySchema,
    dc: FormulaSchema,
  }),
  // Effects on a creature the bearer's attack roll misses, as Studied Attacks' Advantage on the next attack against it.
  z.strictObject({
    kind: z.literal("missRider"),
    effects: z.array(LeafEffectSchema).min(1),
  }),
  // An afterHit activation of `feature` (with this `label`, when set) also lands on another creature: the one hit, when
  // it was aimed at a creature near that one, as Death's Lament's Wails from the Grave, or with `other`, the nearest
  // other foe within that many feet of the bearer that its targeting fits, as Versatile Trickster's Trip.
  z.strictObject({
    kind: z.literal("alsoStrikes"),
    feature: ContentIdSchema,
    label: z.string().min(1).optional(),
    other: z.number().int().min(5).optional(),
  }),
  // A missed attack of this kind can be rolled again: with `advantage` (Master Duelist), spending a `resource`, once a
  // turn (`oncePerTurn`), only on the bearer's turn (`ownTurn`), for its Bonus Action (`bonusAction`), or at another
  // creature within `newTarget` feet of the first (Curving Shot) (class-rules.ts).
  z.strictObject({
    kind: z.literal("missReroll"),
    with: HitKindSchema,
    resource: z.string().min(1).optional(),
    oncePerTurn: z.literal(true).optional(),
    ownTurn: z.literal(true).optional(),
    bonusAction: z.literal(true).optional(),
    advantage: z.literal(true).optional(),
    newTarget: z.number().int().min(5).optional(),
    orSame: z.literal(true).optional(), // with `newTarget`, the creature missed may be picked again
    onceKey: z.string().min(1).optional(), // the once-a-turn use it shares with an activation's `oncePerTurn` name
  }),
  // On a miss that a die could still turn into a hit, one of `resource` can be rolled (a d`dieSize` from that class
  // scaling key) and added to the roll, spent only if the attack then hits, as Soul Blades' Homing Strikes with a
  // Psychic Blade (`withFeature`). Precision Attack works the same way (class-rules.ts).
  z.strictObject({
    kind: z.literal("missBoost"),
    resource: z.string().min(1),
    dieSize: z.string().min(1),
    withFeature: ContentIdSchema.optional(),
  }),
  // A spell the bearer casts adds this to its damage: only one of `spells`, or one dealing one of `types` (the bonus
  // taking that type), and with `oncePerTurn` once a turn, as Guided Precision's Cartographer spells or Radiant Soul.
  // shortcut: the bonus goes to every target of a spell that has several, not only one.
  // With `dice` the spell deals them too, in the damage's type or `type`, as Alchemical Eruption's 2d8 Force or Arcane
  // Firearm's 1d8. `list` keeps it to spells on that class's list and `schools` to those schools, as Empowered
  // Evocation's Wizard evocations; `slot` to casts with a spell slot; and `resource` spends a use each cast, while one
  // is left, as Arcane Overload's Power Surge.
  z.strictObject({
    kind: z.literal("spellDamage"),
    bonus: FormulaSchema.optional(),
    dice: DiceSchema.optional(),
    type: DamageTypeSchema.optional(),
    spells: z.array(ContentIdSchema).min(1).optional(),
    types: z.array(DamageTypeSchema).min(1).optional(),
    list: ContentIdSchema.optional(),
    schools: z.array(SpellSchoolSchema).min(1).optional(),
    slot: z.literal(true).optional(),
    resource: z.string().min(1).optional(),
    oncePerTurn: z.literal(true).optional(),
  }),
  // Right after a Critical Hit with a melee weapon, or one that drops a creature to 0 Hit Points, one attack with that
  // weapon as a Bonus Action, as Great Weapon Master's Hew (actions.ts).
  z.strictObject({ kind: z.literal("hew") }),
  // Feet added to its Speed on its turn once it has taken its action, as Blade Flourish's after the Attack action.
  z.strictObject({
    kind: z.literal("attackSpeed"),
    feet: z.number().int().min(5),
  }),
  // Feet added to its Speed on its first turn of a fight, as Ambusher's Leap.
  z.strictObject({
    kind: z.literal("firstTurnSpeed"),
    feet: z.number().int().min(5),
  }),
  // The Light property's extra attack with a Light crossbow adds the ability modifier to its damage, as Crossbow
  // Expert's Dual Wielding.
  z.strictObject({ kind: z.literal("crossbowDualWielding") }),
  // Languages the bearer knows, as Thieves' Cant or a Belt of Dwarvenkind's Dwarvish (core/explore.ts understands).
  // shortcut: a language "of your choice" isn't asked for; only the named ones are known.
  z.strictObject({
    kind: z.literal("languages"),
    languages: z.array(z.string().regex(/^[a-z][a-z-]*$/)).min(1),
  }),
  // What a creature the bearer summons or raises gets as it appears (combat/summon.ts boosted): only one called by a
  // spell of these schools, cast with a slot with `slot`, or of these types; `tempHp`, with Resistance to all but
  // Force, Necrotic, Psychic and Radiant damage with `resistant`, as Durable Summons; `hp` more Hit Points, as Undead
  // Fortitude; and `hitDamage` on its hits, as Withering Strike. They're worked out from the bearer's numbers.
  // shortcut: `resistant` lasts the fight, not only while the Temporary Hit Points do.
  z.strictObject({
    kind: z.literal("summonBoost"),
    schools: z.array(SpellSchoolSchema).min(1).optional(),
    slot: z.literal(true).optional(),
    creatureTypes: z.array(CreatureTypeSchema).min(1).optional(),
    tempHp: FormulaSchema.optional(),
    resistant: z.literal(true).optional(),
    hp: FormulaSchema.optional(),
    hitDamage: DamageSchema.optional(),
  }),
  // No Disadvantage on a check to influence a Hostile creature, as Boon of Communication's Cunning Speaker.
  z.strictObject({ kind: z.literal("cunningSpeaker") }),
  // As its turn starts, this damage to one creature it grapples, as Unarmed Fighting's 1d4.
  z.strictObject({
    kind: z.literal("grappleDamage"),
    dice: DiceSchema,
    type: DamageTypeSchema,
  }),
  // Sneak Attack without Advantage, but never with Disadvantage: while the bearer stands within 5 feet of the target and
  // no other creature within 5 feet of it (`alone`), as Rakish Audacity, or against a creature under an effect of one
  // of `against`'s features, as Insightful Fighting.
  z.strictObject({
    kind: z.literal("sneakOpening"),
    alone: z.literal(true).optional(),
    against: z.array(ContentIdSchema).min(1).optional(),
  }),
  // Training with Martial weapons, as Battle Ready's Weapon Knowledge.
  z.strictObject({ kind: z.literal("martialTraining") }),
  // Mounted Combatant: while it rides, Advantage against an unmounted creature within 5 feet of its mount and smaller
  // than the mount; its mount takes no damage on a successful Dexterity save for half; and a hit on its mount can be
  // made to hit it instead (combat/attack.ts, trait-rules.ts).
  z.strictObject({ kind: z.literal("mountedCombatant") }),
  // A hit of this kind on the bearer's own turn also uses one of these mastery properties, besides its weapon's own,
  // as Battering Roots' Push or Topple.
  z.strictObject({
    kind: z.literal("extraMastery"),
    with: HitKindSchema,
    masteries: z.array(WeaponMasterySchema).min(1),
    // only while an effect of one of these features' activations is on the bearer, as Strangling Roots in Wrath of
    // the Wild, and then on any turn
    while: z.array(ContentIdSchema).min(1).optional(),
  }),
  // A hit with a mastered weapon can use one of these mastery properties in place of the weapon's own, as Tactical
  // Master's Push, Sap or Slow (actions.ts runMasteryHit).
  z.strictObject({
    kind: z.literal("masterySwap"),
    masteries: z.array(WeaponMasterySchema).min(1),
  }),
  // A hit takes this many strike options (Cunning Strike's or Brutal Strike's) instead of one, as Improved Cunning
  // Strike.
  z.strictObject({
    kind: z.literal("strikeEffects"),
    count: z.number().int().min(2),
  }),
  // A vial or flask is thrown this far, as with Bomber's Far Lobber.
  z.strictObject({
    kind: z.literal("farLobber"),
    feet: z.number().int().min(5),
  }),
  // A spell or feature of the bearer's that makes the creatures in its area save spares another creature with this
  // passive from the same `item`: it succeeds and takes no damage where it would take half, spending a use, as Boon
  // Companions' Bands. shortcut: each band has its own use a dawn, not one shared by the pair.
  z.strictObject({
    kind: z.literal("pairedBand"),
    item: ContentIdSchema,
    resource: z.string(),
  }),
  // Attack rolls against the bearer's mount have Disadvantage, and nothing moves the bearer off it against its will
  // while it can act, as a Saddle of the Cavalier.
  z.strictObject({ kind: z.literal("protectedMount") }),
  // Effects can't lower the bearer's Speed, as a Ring of Free Action stops magic doing. shortcut: every effect counts as
  // magic, while a weapon's Slow mastery, which isn't, still slows it.
  z.strictObject({ kind: z.literal("steadySpeed") }),
  // A trap's damage comes off the uses of `resource` instead, as a Thief's Thimble's 30 Hit Points, and spending the
  // last spends `item`, the bearer taking what's left (scene.ts).
  z.strictObject({
    kind: z.literal("trapShield"),
    resource: z.string(),
    item: ContentIdSchema,
  }),
]);
export type Passive = z.infer<typeof PassiveSchema>;

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

const ScaleStepSchema = z.union([
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
}).strict();
export type Feature = z.infer<typeof FeatureSchema>;

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
    // Picked again after a Long Rest, as Weapon Master's weapons (swap.ts).
    swap: z.literal("longRest").optional(),
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

// When the picks a class's levels asked for can be changed (swap.ts): its cantrips, its prepared spells and its
// options such as Eldritch Invocations. "levelUp" is one pick each time it gains a level, "longRest" one after each
// Long Rest, and "prepare" any of them after each Long Rest, as a Cleric changes its list.
const SwapWhenSchema = z.enum(["levelUp", "longRest", "prepare"]);
export const ClassSwapsSchema = z.strictObject({
  cantrips: SwapWhenSchema.optional(),
  spells: SwapWhenSchema.optional(),
  options: SwapWhenSchema.optional(),
});
export type ClassSwaps = z.infer<typeof ClassSwapsSchema>;

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
  // When set, only Martial weapons with one of these properties count, as for a Rogue or Monk.
  martialWeaponProperties: z.array(WeaponPropertySchema).min(1).optional(),
  armor: z.array(z.enum(["light", "medium", "heavy", "shield"])),
  spellcasting: z.strictObject({ ability: AbilitySchema }).optional(),
  swaps: ClassSwapsSchema.optional(),
  tools: z.array(ContentIdSchema).optional(), // tool proficiencies it gives at level 1, by id, as a Rogue's Thieves' Tools
  // Spells the class's own chapter names, for a class newer than the books that print them.
  spellList: z.array(ContentIdSchema).optional(),
  // shortcut: fewer than 20 levels are allowed while content is being added, require 20 once step 5 is done.
  levels: z.array(ClassLevelSchema).min(1),
}).strict();
export type ClassDef = z.infer<typeof ClassSchema>;

// Same level structure as a class, and each level's grants apply at that level of the parent class.
export const SubclassSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  class: ContentIdSchema,
  // Printed for the 2014 rules, whose levels don't line up with these classes, so character creation doesn't offer it.
  edition: z.literal("2014").optional(),
  // Spellcasting the subclass gives a class without its own, from `list`'s spells, as an Eldritch Knight's Wizard
  // spells. Its levels' `slots` and `cantrips` and `preparedSpells` scaling then ask for picks as a class's do.
  spellcasting: z
    .strictObject({
      ability: AbilitySchema,
      list: ContentIdSchema,
      swaps: ClassSwapsSchema.optional(),
    })
    .optional(),
  levels: z.array(ClassLevelSchema).min(1),
}).strict();
export type Subclass = z.infer<typeof SubclassSchema>;

export const SpeciesSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  text: z.string().min(1),
  creatureType: PrintedCreatureTypeSchema,
  size: z.enum(["tiny", "small", "medium", "large"]),
  speed: z.number().int(),
  traits: z.array(ContentIdSchema).default([]),
  choices: z.array(ChoiceDefSchema).default([]), // asked at character creation, such as a Draconic Ancestry
}).strict();
export type Species = z.infer<typeof SpeciesSchema>;

export const BackgroundSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  abilities: z.array(AbilitySchema).length(3),
  feat: ContentIdSchema,
  skills: z.array(SkillSchema).length(2),
  tool: z.string().min(1),
  // Its feat, or one of this category instead, as with "Survivor or a Dark Gift feat of your choice".
  featOr: z.literal("darkGift").optional(),
}).strict();
export type Background = z.infer<typeof BackgroundSchema>;

export const FeatSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  category: z.enum([
    "origin",
    "general",
    "fightingStyle",
    "epicBoon",
    "darkGift",
    "dragonmark",
    "racial",
  ]),
  text: z.string().min(1),
  grants: z.array(ContentIdSchema).default([]),
  choices: z.array(ChoiceDefSchema).default([]), // asked when the feat is taken
  abilityIncrease: z.array(AbilitySchema).min(1).optional(), // its Ability Score Increase: +1 to one of these
  // Its prerequisite, met by any of these: the species, a trait or lineage it has, or a feat taken.
  requires: z.array(ContentIdSchema).min(1).optional(),
  // The rest of its Prerequisite line: a score of 13 or more in one of these abilities, the Spellcasting or Pact
  // Magic feature, armor training, or a campaign in a setting, matched with the adventure's.
  prerequisite: z
    .strictObject({
      abilities: z.array(AbilitySchema).min(1).optional(),
      min: z.number().int().min(1).max(30).optional(),
      spellcasting: z.literal(true).optional(),
      armor: z.enum(["light", "medium", "heavy"]).optional(),
      campaign: z.enum(["eberron", "ravenloft"]).optional(),
    })
    .optional(),
  // The spellcasting ability of the spells it gives: this one, the one it raised ("increased"), the one chosen for
  // a feat taken earlier (`like`, matched by id or by version as Magic Initiate's), or with none, its spellAbility
  // choice, else the character's own.
  spellAbility: z
    .union([
      AbilitySchema,
      z.literal("increased"),
      z.strictObject({ like: ContentIdSchema }),
    ])
    .optional(),
}).strict();
export type Feat = z.infer<typeof FeatSchema>;

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
    })
    .optional(),
  // What its `randomAction` picks from, each named by its label, as Prismatic Spray's rays.
  rolled: z.array(ActivationSchema).min(2).optional(),
  // Why a spell with no activation needs none: it takes longer than a turn to cast ("castingTime"), or does
  // nothing a grid fight plays, such as travel, senses, talk or downtime ("utility").
  outOfCombat: z.enum(["castingTime", "utility"]).optional(),
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

// In copper pieces, so prices compare without converting coins.
const CostCpSchema = z.number().int().min(0);

const ItemBaseSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  costCp: CostCpSchema.optional(), // what a merchant asks; missing for "Varies" and for magic items
  weightLb: z.number().min(0).optional(),
});

// A curse attuning to an item puts on its bearer, until Remove Curse ends that Attunement, or with `wish` only a Wish
// spell (gear.ts): with `bound` the Attunement can't be ended nor the item stowed, as a Berserker Axe kept within reach,
// and `passives` work while attuned, worn or not, as Armor of Vulnerability's Vulnerabilities.
export const CurseSchema = z.strictObject({
  bound: z.literal(true).optional(),
  passives: z.array(PassiveSchema).min(1).optional(),
  wish: z.literal(true).optional(),
});

// Who can attune to an item, as a Talisman of Pure Good's Cleric or Paladin: a creature with a level in one of
// `classes`, or of one of `species` (both by their names after the plugin) or `creatureTypes`, or attuned to one of
// `attunedTo`, as Whelm's Dwarf or bearer of a Belt of Dwarvenkind (gear.ts).
export const AttuneBySchema = z.strictObject({
  classes: z.array(z.string().min(1)).min(1).optional(),
  species: z.array(z.string().min(1)).min(1).optional(),
  creatureTypes: z.array(z.string().min(1)).min(1).optional(),
  attunedTo: z.array(ContentIdSchema).min(1).optional(),
});

const MagicBonusSchema = z.strictObject({
  to: z.enum([
    "attack",
    "damage",
    "ac",
    "savingThrows",
    "spellAttack",
    "spellDc", // spell save DCs, as a Robe of Thayan Arcana's
    "checks", // ability checks, as a Stone of Good Luck's
    "proficiency", // the Proficiency Bonus, as an Ioun Stone of Mastery's
  ]),
  amount: z.number().int().min(1),
  unarmored: z.literal(true).optional(), // only while wearing no armor and using no Shield, as Bracers of Defense
  // Only for the spells of this class, by its name after the plugin, as a Rod of the Pact Keeper's DC for Warlock
  // spells: those its levels of that class gave (stats.ts).
  class: z.string().min(1).optional(),
  // Only with these weapons, or a magic one made from them, by their names after the plugin, as Bracers of
  // Archery's "longbow" and "shortbow", so any book's Longbow counts. It adds to a magic weapon's own bonus,
  // which other bonuses to attack and damage don't.
  weapons: z.array(z.string().min(1)).min(1).optional(),
});

// Spells a magic item casts (stats.ts itemCasts): each spends charges from the item's first resource, or from
// `resource`, another of its own, as a Blossom Rod's Plant Growth once a dawn. Its version is `level`, as
// "Fireball (level 5 version)", raised by one for each charge spent beyond `charges` up to `upTo`, as a Wand of
// Fireballs' "no more than 3 charges". Its numbers are the item's `dc` and `attack` where it prints them, as "save
// DC 15", or else the bearer's. The spell is named after its plugin, as a bonus's `weapons` are, so the book that
// leads plays it.
const ItemCastSchema = z.strictObject({
  spell: z.string().min(1),
  // Limits on the cast: on its caster only (`self`), as a Hag Eye's Darkvision; an area this many feet across
  // (`radius`), as a Wand of Fear's 60-foot Cone; only creatures of these types (`creatureTypes`), as a Ring of Animal
  // Influence's Fear on Beasts, and with a Swim Speed (`swimmers`), as a Trident of Fish Command's; and how its save
  // goes for some creatures (`edges`), as an Arcanist's Bestiary's Disadvantage for one not Humanoid.
  self: z.literal(true).optional(),
  radius: z.number().int().min(5).optional(),
  creatureTypes: z.array(CreatureTypeSchema).min(1).optional(),
  swimmers: z.literal(true).optional(),
  edges: z
    .array(
      z.strictObject({
        creatureTypes: z.array(z.string()).min(1).optional(),
        minSize: SizeSchema.optional(),
        roll: z.enum(["advantage", "disadvantage", "fail", "succeed"]),
      }),
    )
    .min(1)
    .optional(),
  // Each use after the first since its pool came back has this many percent more chance to fail, tearing the item
  // apart, as a Wind Fan's 20.
  tears: z.number().int().min(1).max(100).optional(),
  // This many percent chance with each cast that its caster dies outright, as the Eye of Vecna's 5, Vecna tearing
  // its soul away.
  doom: z.number().int().min(1).max(100).optional(),
  // What its user gets with each cast, as a Staff of the Lost's Minotaurs that may come (Activation `userEffects`).
  userEffects: z.array(LeafEffectSchema).min(1).optional(),
  bonusAction: z.literal(true).optional(), // cast as a Bonus Action, as a Necklace of Prayer Beads' beads
  charges: z.number().int().min(0).default(1), // 0 casts it whenever
  resource: z.string().min(1).optional(),
  level: z.number().int().min(0).max(9).optional(),
  upTo: z.number().int().min(2).optional(),
  dc: z.number().int().min(1).optional(),
  attack: z.number().int().optional(), // the spell attack bonus; `dc` less 8 when only that is printed
  gold: z.number().int().min(0).optional(), // its costly component costs this instead, as Cauldron of Rebirth's salt
});
export type ItemCast = z.infer<typeof ItemCastSchema>;

// What a magic item with charges has, carried into a magic weapon, armor or Shield made from it (variants.ts):
// its pools, recharged as a feature's are, the spells they cast, and what spending the first pool's last charge
// does: a d20 that on a 1 destroys the item, or leaves this plain item in its place, as an Enspelled Staff's
// Quarterstaff.
export const ChargedSchema = {
  resources: z.array(ResourceDefSchema).min(1).optional(),
  // An action its user can take while a `grantedAction` its activation gave lasts, as a Potion of Fire Breath's or a
  // Staff of the Adder's snake head.
  granted: ActivationSchema.optional(),
  // Pieces rolled as the item is found, each a type its own d`die` row names, counted into that row's pool, as a
  // Necklace of Prayer Beads' 1d4 + 2 beads of six types (gear.ts gainRolls).
  // shortcut: they're rolled when it's found as treasure or bought; one come by any other way has none.
  split: z
    .strictObject({
      count: z.strictObject({
        dice: DiceSchema,
        base: z.number().int().min(0),
      }),
      die: z.number().int().min(2),
      rows: z
        .array(
          z.strictObject({
            min: z.number().int().min(1),
            max: z.number().int().min(1),
            resource: z.string().min(1),
          }),
        )
        .min(1),
    })
    .optional(),
  // Passives that hold only while one of the item's pools has a use left, as a Helm of Brilliance's Resistance to
  // Fire while it has a ruby.
  whileCharged: z
    .array(
      z.strictObject({
        resource: z.string().min(1),
        passives: z.array(PassiveSchema).min(1),
      }),
    )
    .min(1)
    .optional(),
  casts: z.array(ItemCastSchema).min(1).optional(),
  // What it does when used, as a Pearl of Power's spell slot back once a dawn (stats.ts itemUses): an activation that
  // spends its pools as a feature's spends its own. shortcut: one on the bearer's person or held works whenever it's
  // worn.
  activations: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        activation: ActivationSchema,
        // only while this pool of its own has a use left, as a Helm of Brilliance's flames while it has a fire opal
        whileCharged: z.string().min(1).optional(),
        // taken only when a `randomAction` picks it by its name, as a Rival Coin's heads or tails
        rolled: z.literal(true).optional(),
      }),
    )
    .min(1)
    .optional(),
  // "vanishes" is gone with its last charge, with no d20, as an Arcane Chatelaine with its last key.
  lastCharge: z
    .union([
      z.literal("destroyed"),
      z.literal("vanishes"),
      z.strictObject({ becomes: ContentIdSchema }),
    ])
    .optional(),
  // The last charge's d20 on a 20 gives back this many, as a Staff of Power's 1d8 + 2.
  lastChargeTwenty: z
    .strictObject({ dice: DiceSchema, base: z.number().int().min(0) })
    .optional(),
};

// What a magic weapon's hits do past its damage, carried from its magic item into the weapons made from it
// (variants.ts) and into their attacks (stats.ts weaponActivation), as an attack's own fields are.
const WeaponRiders = {
  hitSave: OnHitSaveSchema.optional(), // as a Giant Slayer's Prone
  hitEffects: z.array(LeafEffectSchema).min(1).optional(), // as a Life-Sapping Blade's lack of healing
  natural20: NaturalTwentySchema.optional(), // as a Sword of Sharpness's 14 Slashing and Exhaustion
  breaksConcentration: z.literal(true).optional(), // as a Mage Breaker's
  // an Oathbow's sworn enemy, the creature its item's activation marks, and what a hit on it adds
  sworn: z
    .strictObject({
      item: ContentIdSchema.optional(), // filled in from the magic item (variants.ts)
      damage: z.array(DamageSchema).default([]),
    })
    .optional(),
  vs: z
    .strictObject({
      creatureTypes: z.array(z.string()).min(1),
      bonus: z.number().int(),
    })
    .optional(), // more to hit against these creature types, as a Mace of Smiting's
  // Thrown with this range, its throw spending one of `resource` and making its target save as `hitSave`, as a
  // Hammer of Thunderbolts' hurl; `damage` is added to a throw's hit only, as a Dwarven Thrower's Force.
  thrown: z
    .strictObject({
      normal: z.number().int().min(5),
      long: z.number().int().min(5),
      resource: z.string().min(1).optional(),
      hitSave: OnHitSaveSchema.optional(),
      damage: z.array(DamageSchema).min(1).optional(),
    })
    .optional(),
  // with that class (its name after the plugin), its attack rolls may use this ability, as a Bard's Charisma with a
  // Lute of Thunderous Thumping
  classAbility: z
    .strictObject({ class: z.string().min(1), ability: AbilitySchema })
    .optional(),
};

// A magic item's damage on a hit: without a `type`, the weapon's own, and with `weaponDie` one of the weapon's dice,
// as a Vicious Weapon's 2d6 or a Silvered Weapon's die.
const ItemDamageSchema = DamageSchema.extend({
  type: DamageTypeSchema.optional(),
  weaponDie: z.literal(true).optional(),
});

// An ability score an item sets while worn, as Gauntlets of Ogre Power's Strength 19, which does nothing to a higher
// score, or raises, as an Ioun Stone's +2 to a maximum of 20.
const ItemAbilitySchema = z.union([
  z.strictObject({ ability: AbilitySchema, set: z.number().int().min(1) }),
  z.strictObject({
    ability: AbilitySchema,
    raise: z.number().int().min(1),
    max: z.number().int().min(1),
  }),
  // Raises the score another item sets, while the bearer is attuned to one of `attunedTo` (or a version of it), as a
  // Hammer of Thunderbolts' Might of Giants on a Belt of Giant Strength's Strength.
  z.strictObject({
    ability: AbilitySchema,
    boost: z.number().int().min(1),
    max: z.number().int().min(1),
    attunedTo: z.array(ContentIdSchema).min(1),
  }),
]);

export const WeaponSchema = ItemBaseSchema.extend({
  type: z.literal("weapon"),
  category: z.enum(["simple", "martial"]),
  // A few weapons, like the Blowgun, deal a flat number instead of rolling.
  damage: z
    .strictObject({
      dice: DiceSchema.optional(),
      flat: z.number().int().min(1).optional(),
      type: DamageTypeSchema,
    })
    .refine(
      (damage) => (damage.dice === undefined) !== (damage.flat === undefined),
      {
        message: "needs either dice or a flat number",
      },
    ),
  properties: z.array(WeaponPropertySchema).default([]),
  mastery: WeaponMasterySchema,
  // A magic weapon made from a plain one, as a +2 Longsword: the plain weapon, and its own bonuses.
  baseWeapon: ContentIdSchema.optional(),
  bonuses: z.array(MagicBonusSchema).min(1).optional(),
  attunement: z.literal(true).optional(), // its bonuses work only while attuned, as a Keyholes Dagger's
  curse: CurseSchema.optional(), // its magic item's
  attuneBy: AttuneBySchema.optional(),
  returning: z.literal(true).optional(), // back in hand once thrown, as a Returning Weapon
  forms: z.array(z.string().min(1)).min(1).optional(), // its magic item's, as a Keyholes Dagger's
  // types its own damage can take instead, the one the target resists least, as a Javelin of Lightning's Lightning
  altTypes: z.array(DamageTypeSchema).min(1).optional(),
  passives: z.array(PassiveSchema).min(1).optional(), // its magic item's, as Frost Brand's Resistance to Fire
  hitDamage: z.array(DamageSchema).min(1).optional(), // its magic item's, as Frost Brand's 1d6 Cold
  abilities: z.array(ItemAbilitySchema).min(1).optional(), // its magic item's, as a Thunderous Greatclub's Strength
  ...ChargedSchema,
  ...WeaponRiders,
  // A Thrown or Ammunition weapon's range in feet: normal, and long with Disadvantage.
  range: z
    .strictObject({
      normal: z.number().int().min(5),
      long: z.number().int().min(5),
    })
    .optional(),
}).strict();
export type Weapon = z.infer<typeof WeaponSchema>;

export const ArmorSchema = ItemBaseSchema.extend({
  type: z.literal("armor"),
  armorType: z.enum(["light", "medium", "heavy"]),
  base: z.number().int(),
  addDex: z.boolean(),
  maxDex: z.number().int().optional(),
  strength: z.number().int().optional(), // a lower Strength score costs 10 feet of speed
  // Magic armor made from a plain one, as +1 Chain Mail (variants.ts): the plain armor, and its own bonuses.
  baseArmor: ContentIdSchema.optional(),
  bonuses: z.array(MagicBonusSchema).min(1).optional(),
  anyTraining: z.literal(true).optional(), // worn as if trained with it, as Elven Chain
  // From its magic item: its bonuses and passives work only while attuned, and its passives, as Armor of Resistance's.
  attunement: z.literal(true).optional(),
  passives: z.array(PassiveSchema).min(1).optional(),
  curse: CurseSchema.optional(), // its magic item's
  attuneBy: AttuneBySchema.optional(),
  ...ChargedSchema,
}).strict();
export type Armor = z.infer<typeof ArmorSchema>;

const ShieldItemSchema = ItemBaseSchema.extend({
  type: z.literal("shield"),
  bonus: z.number().int(),
  baseArmor: ContentIdSchema.optional(), // a magic Shield's plain one, as a +1 Shield's (variants.ts)
  bonuses: z.array(MagicBonusSchema).min(1).optional(),
  attunement: z.literal(true).optional(), // as armor's
  curse: CurseSchema.optional(), // its magic item's
  attuneBy: AttuneBySchema.optional(),
  passives: z.array(PassiveSchema).min(1).optional(),
  ...ChargedSchema,
}).strict();

const GearSchema = ItemBaseSchema.extend({
  type: z.literal("gear"),
  text: z.string().optional(),
  category: z
    .enum([
      "adventuring",
      "ammunition",
      "explosive",
      "focus",
      "mount",
      "pack",
      "tack",
      "treasure",
      "vehicle",
    ])
    .optional(),
  healing: AmountSchema.optional(), // drinking it heals, as a Potion of Healing does
  // What using it does, as throwing a flask of Acid: an action that spends the item.
  activation: ActivationSchema.optional(),
  // Uses before it's gone, spent by activations that need it carried, as a Healer's Kit's ten.
  uses: z.number().int().min(1).optional(),
}).strict();

const ToolSchema = ItemBaseSchema.extend({
  type: z.literal("tool"),
  ability: AbilitySchema.optional(), // 2014 books print no ability for a tool
  // What it deals with, so a check about that counts its proficiency when it's carried, as Thieves' Tools a lock.
  handles: z.array(ObstacleSchema).min(1).optional(),
  artisan: z.literal(true).optional(), // one of the Artisan's Tools, which a Manifold Tool can become
  text: z.string().min(1),
}).strict();

const RaritySchema = z.enum([
  "common",
  "uncommon",
  "rare",
  "veryRare",
  "legendary",
  "artifact",
]);

// Numbers read from the book's text, which the engine applies where it can; `automation` says how much plays.
const MagicItemSchema = ItemBaseSchema.extend({
  type: z.literal("magicItem"),
  category: z.enum([
    "armor",
    "potion",
    "ring",
    "rod",
    "scroll",
    "staff",
    "wand",
    "weapon",
    "wondrousItem",
  ]),
  rarity: z.union([RaritySchema, z.literal("varies")]),
  attunement: z.boolean(),
  attunementBy: z.string().min(1).optional(),
  attuneBy: AttuneBySchema.optional(), // what `attunementBy` asks, as the engine checks it
  table: TableSchema.optional(), // a table it rolls on, which `rollTable` names it for, as a Wand of Wonder's
  // Rolls made on these roll tables as it's found, `count` of each, whose rows' passives work while it does, as an
  // artifact's random properties or a Moonblade's runes (gear.ts gainRolls). shortcut: one come by other than as
  // treasure or bought has none.
  properties: z
    .array(
      z.strictObject({
        table: ContentIdSchema,
        count: z.strictObject({
          base: z.number().int().min(0).default(0),
          dice: DiceSchema.optional(),
        }),
      }),
    )
    .min(1)
    .optional(),
  curse: CurseSchema.optional(),
  // A save attuning to it calls for, whose failure is the attuner's end, as the Wand of Orcus's Constitution save
  // (actions.ts attuneSave): a creature of one of `unless` makes none, and a success takes `saved`, as the wand's 10d6
  // Necrotic. Weapons and armor made from it take it from the item.
  attuneSave: z
    .strictObject({
      ability: AbilitySchema,
      dc: z.number().int().min(1),
      unless: z.array(z.string().min(1)).min(1).optional(),
      saved: z.array(DamageSchema).default([]),
    })
    .optional(),
  text: z.string().min(1),
  automation: AutomationSchema,
  bonuses: z.array(MagicBonusSchema).min(1).optional(),
  abilities: z.array(ItemAbilitySchema).min(1).optional(),
  // Always-on rules while it works (worn, and attuned where it needs it), as Eyes of the Eagle's Advantage on Perception.
  passives: z.array(PassiveSchema).min(1).optional(),
  // A score studying it raises for good, as a Manual of Bodily Health's Constitution by 2 to a maximum of 30.
  // Studying spends its magic, so the item is gone after.
  // An item needing Attunement is studied only while attuned to it. With `any` the score is the reader's choice, as
  // the Book of Vile Darkness's; `lower` takes from the reader's lowest other score down to `min`; `keep` leaves the
  // item, studied once; and `passives` are the reader's for good after, as the Book of Exalted Deeds' Halo (gear.ts).
  study: z
    .strictObject({
      ability: z.union([AbilitySchema, z.literal("any")]),
      raise: z.number().int().min(1),
      max: z.number().int().min(1),
      lower: z
        .strictObject({
          amount: z.number().int().min(1),
          min: z.number().int().min(1),
        })
        .optional(),
      keep: z.literal(true).optional(),
      passives: z.array(PassiveSchema).min(1).optional(),
    })
    .optional(),
  // Skills its bearer picks one of to be proficient in while it works, changed only where the party could rest, as an
  // Arcanist's Bestiary's Extensive Knowledge (gear.ts).
  chooseSkill: z.array(SkillSchema).min(2).optional(),
  // Weapons it trains its wearer with, and magic ones made from them, named as a bonus's `weapons` are.
  weaponTraining: z.array(z.string().min(1)).min(1).optional(),
  // Magic armor made from a plain one: worn as if trained with it, as Elven Chain, or with no Strength it needs,
  // as Mithral Armor. Carried into the armor content names as `<id>--<n>--<armor>` (variants.ts).
  anyTraining: z.literal(true).optional(),
  noStrength: z.literal(true).optional(),
  // Magic ammunition, one piece of it: its bonuses go to a shot from an Ammunition weapon, and a hit spends it, as
  // +1 Ammunition (stats.ts). Several pieces are several of it carried.
  ammunition: z.literal(true).optional(),
  // Weapons a magic weapon made from it changes into as it attacks, by their names after the plugin, attacking with
  // Strength or Dexterity in any of them, as a Keyholes Dagger's Handaxe or Mace, carried the same way (stats.ts).
  forms: z.array(z.string().min(1)).min(1).optional(),
  // Types a magic weapon made from it can deal its own damage as, the one the target resists least, as a Javelin of
  // Lightning's Lightning in place of Piercing, carried the same way.
  altTypes: z.array(DamageTypeSchema).min(1).optional(),
  // A magic weapon that comes back once thrown, as a Returning Weapon, carried the same way.
  returning: z.literal(true).optional(),
  // Damage a magic weapon made from it adds on a hit, as Frost Brand's 1d6 Cold, carried the same way.
  hitDamage: z.array(ItemDamageSchema).min(1).optional(),
  ...WeaponRiders,
  // its damage may name the weapon's type or die, as `hitDamage`'s
  natural20: NaturalTwentySchema.extend({
    damage: z.array(ItemDamageSchema).default([]),
  }).optional(),
  // A magic weapon made from it deals this instead of the weapon's own type, and has these properties too, as a Sun
  // Blade's Radiant and Finesse.
  damageType: DamageTypeSchema.optional(),
  addProperties: z.array(WeaponPropertySchema).min(1).optional(),
  healing: AmountSchema.optional(), // drinking it heals, as a Potion of Healing does
  // What using it up does, as drinking a Potion of Speed or throwing a Bead of Force (stats.ts itemAction): an
  // action that spends the item, named with `verb` ("Drink" for a potion, "Read" for a scroll, else "Use").
  activation: ActivationSchema.optional(),
  verb: z.string().min(1).optional(),
  // What an `untilLongRest` effect of its activation gives, as a Potion of Vitality's highest Hit Point Dice.
  untilLongRest: z.array(PassiveSchema).min(1).optional(),
  // Casting a spell its bearer doesn't know, from a class's list (by its name after the plugin), behind an
  // Intelligence (Arcana) check of `dc` (plus the spell's level with `perLevel`), as a Hat of Wizardry's (stats.ts
  // unknownSpells): cantrips, or spells of a level its slots reach, spending one; with `action` only those cast with
  // an action. Each use spends `resource`, kept on a failure with `keepOnFailure`, as a Hat of Many Spells' is.
  unknownSpell: z
    .strictObject({
      class: z.string().min(1),
      cantrips: z.literal(true).optional(),
      action: z.literal(true).optional(),
      dc: z.number().int().min(1),
      perLevel: z.literal(true).optional(),
      resource: z.string().min(1),
      keepOnFailure: z.literal(true).optional(),
      // a failure rolls on the item's own `table`, as a Hat of Many Spells' random effects
      failTable: z.literal(true).optional(),
    })
    .optional(),
  spell: ContentIdSchema.optional(), // the spell a Spell Scroll holds
  // What applying it between fights makes of a plain weapon or ammunition carried, the oil used up, as Oil of
  // Sharpness: a Melee weapon dealing one of `damage` becomes `weapon` made from it (`<weapon>--<its slug>`), and
  // one ammunition item becomes `pieces` of `ammunition` (gear.ts).
  // shortcut: any ammunition counts, though Sling Bullets deal Bludgeoning damage.
  coats: z
    .strictObject({
      weapon: ContentIdSchema,
      damage: z.array(DamageTypeSchema).min(1),
      ammunition: ContentIdSchema,
      pieces: z.number().int().min(1),
    })
    .optional(),
  // Spells cast into it between fights, up to `levels` levels of them, each of level `maxLevel` or lower, which its
  // attuned bearer casts with the slot level, DC, attack and modifier they were stored with, as a Ring of Spell
  // Storing (gear.ts, stats.ts storedCasts). shortcut: it's found empty, rather than holding what the DM chose.
  storesSpells: z
    .strictObject({
      levels: z.number().int().min(1),
      maxLevel: z.number().int().min(1).max(9),
    })
    .optional(),
  // A spell bound into it as it's made, named after its plugin by the content id's last part, as
  // "dmg:item/enspelled-staff--fireball" or "dmg:item/enspelled-armor--1--chain-mail--shield" (variants.ts), with
  // the DC and attack its level gives (stats.ts boundNumbers): read once as a Spell Scroll's ("scroll"), cast with
  // the item's charges as an Enspelled Staff's ("charges"), or kept prepared and cast once without a slot, the item
  // gone after, as a Thayan Spell Tattoo's ("tattoo"). The levels and schools are those it can hold.
  boundSpell: z
    .strictObject({
      as: z.enum(["scroll", "charges", "tattoo"]),
      minLevel: z.number().int().min(0).max(9).default(0),
      maxLevel: z.number().int().min(0).max(9).default(9),
      schools: z.array(SpellSchoolSchema).min(1).optional(),
    })
    .optional(),
  ...ChargedSchema,
  // An evolving item, whose each version keeps the properties of the versions before it (their passives, casts,
  // pools and activations) and adds its own, as a Staff of Skulls' Rare version keeps its Uncommon one's Chill Touch.
  evolving: z.literal(true).optional(),
  // Set when one entry covers several rarities, such as +1, +2 or +3. Content names one as `<id>--<n>` (variants.ts).
  variants: z
    .array(
      z.strictObject({
        rarity: RaritySchema,
        name: z.string().min(1).optional(),
        bonuses: z.array(MagicBonusSchema).min(1).optional(),
        abilities: z.array(ItemAbilitySchema).min(1).optional(),
        healing: AmountSchema.optional(),
        activation: ActivationSchema.optional(), // in place of the item's own, as a Potion of Resistance's type
        granted: ActivationSchema.optional(),
        // added to the item's own, as a Ring of Resistance's one damage type
        passives: z.array(PassiveSchema).min(1).optional(),
        casts: z.array(ItemCastSchema).min(1).optional(), // added to the item's own, as a Staff of Skulls' Chill Touch
        resources: z.array(ResourceDefSchema).min(1).optional(), // added to the item's own too
        // added to the item's own too, as a Staff of Skulls' Pulverizing
        activations: ChargedSchema.activations,
        forms: z.array(z.string().min(1)).min(1).optional(), // added too, as a Keyholes Dagger's
        // in place of the item's own, as an Ioun Stone of Reserve's
        storesSpells: z
          .strictObject({
            levels: z.number().int().min(1),
            maxLevel: z.number().int().min(1).max(9),
          })
          .optional(),
        hitDamage: z.array(DamageSchema).min(1).optional(), // added too
        hitSave: OnHitSaveSchema.optional(), // in place of the item's own, as Ammunition of Slaying's for one type
        curse: CurseSchema.optional(), // in place of the item's own, as Armor of Vulnerability's for its type
      }),
    )
    .min(1)
    .optional(),
}).strict();

export const ItemSchema = z.discriminatedUnion("type", [
  WeaponSchema,
  ArmorSchema,
  ShieldItemSchema,
  GearSchema,
  ToolSchema,
  MagicItemSchema,
]);
export type Item = z.infer<typeof ItemSchema>;

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
    })
    .strict()
    .optional(),
}).strict();
export type Companion = z.infer<typeof CompanionSchema>;

const AbilityIncreaseSchema = z.partialRecord(
  AbilitySchema,
  z.number().int().min(1).max(2),
);

const ChoiceAnswerSchema = z.discriminatedUnion("kind", [
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
  name: z.string().min(1),
  build: CharacterBuildSchema,
  equipment: z.array(ContentIdSchema),
}).strict();

const MapSquareSchema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
]);

// A fight on a book's battle map: the part of the picture it happens on, cut to whole squares,
// with the walls, ground, cover and light, and where each side starts.
export const BattlemapSchema = z
  .strictObject({
    image: z.string().min(1), // inside the adventure plugin, such as assets/p048-79.webp
    imageWidth: z.number().int().min(1),
    imageHeight: z.number().int().min(1),
    crop: z.strictObject({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
    }),
    columns: z.number().int().min(2).max(60),
    rows: z.number().int().min(2).max(60),
    // One per row: "#" wall, "." open, "~" difficult terrain, "h" half cover, "t" three-quarters cover,
    // "d" dim light, "x" darkness, "w" water deep enough to swim in.
    walls: z.array(
      z
        .string()
        .regex(/^[#.~htdxw]*$/, "uses a code other than # . ~ h t d x w"),
    ),
    light: z.enum(["bright", "dim", "dark"]).optional(), // the light everywhere not marked d or x; bright if left out
    party: z.array(MapSquareSchema).min(1),
    monsters: z.array(MapSquareSchema).min(1),
  })
  .superRefine((map, context) => {
    const fail = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    const { crop } = map;
    if (
      crop.x + crop.width > map.imageWidth ||
      crop.y + crop.height > map.imageHeight
    ) {
      fail("The crop runs past the edge of the image");
    }
    if (map.walls.length !== map.rows) {
      fail(
        `walls has ${String(map.walls.length)} rows, not ${String(map.rows)}`,
      );
    }
    map.walls.forEach((row, index) => {
      if (row.length !== map.columns) {
        fail(
          `walls row ${String(index)} has ${String(row.length)} squares, not ${String(map.columns)}`,
        );
      }
    });
    const open = ([x, y]: readonly [number, number]): boolean =>
      x < map.columns && y < map.rows && map.walls[y]?.[x] !== "#";
    for (const [side, squares] of [
      ["party", map.party],
      ["monsters", map.monsters],
    ] as const) {
      for (const square of squares) {
        if (!open(square)) {
          fail(
            `A ${side} start, ${square.join(",")}, is off the map or in a wall`,
          );
        }
      }
    }
    // The party must be able to walk to within reach of a monster.
    const [first] = map.party;
    if (!first || !open(first)) return;
    const reached = new Set([first.join(",")]);
    const queue: (readonly [number, number])[] = [first];
    for (let next = queue.shift(); next; next = queue.shift()) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const square = [next[0] + dx, next[1] + dy] as const;
          const key = square.join(",");
          if (
            square[0] < 0 ||
            square[1] < 0 ||
            reached.has(key) ||
            !open(square)
          ) {
            continue;
          }
          reached.add(key);
          queue.push(square);
        }
      }
    }
    const reachable = map.monsters.some(([x, y]) =>
      [-1, 0, 1].some((dx) =>
        [-1, 0, 1].some((dy) =>
          reached.has(`${String(x + dx)},${String(y + dy)}`),
        ),
      ),
    );
    if (!reachable) fail("The party can't walk to any monster's start");
  });
export type Battlemap = z.infer<typeof BattlemapSchema>;

// Coins and items the party finds, from an encounter or the treasure story effect.
export const LootSchema = z.strictObject({
  gold: z.number().int().min(0).default(0),
  items: z
    .array(ContentIdSchema.regex(/:item\//, "must be an item id"))
    .default([]),
});
export type Loot = z.infer<typeof LootSchema>;

export const EncounterSchema = z.strictObject({
  id: z.string().min(1),
  battlemap: BattlemapSchema.optional(),
  monsters: z
    .array(
      z.strictObject({
        monster: ContentIdSchema,
        count: z.number().int().min(1).default(1),
      }),
    )
    .min(1),
  // The party size the counts were written for. Counts scale to the party that actually shows up.
  forPartySize: z.number().int().min(1).optional(),
  loot: LootSchema.optional(), // found when the party wins
  lair: z.boolean().optional(), // fought in a monster's lair: lair actions and its "in Lair" numbers
  surprise: z.enum(["party", "enemies"]).optional(), // the side caught unaware, which rolls initiative with disadvantage
  sunlight: z.literal(true).optional(), // fought outdoors in daylight, outside the map's shade (d) and darkness (x)
  underwater: z.literal(true).optional(), // fought underwater (combat/water.ts)
  // The environmental effects it's fought in, by id, as a slippery ice floor or a strong wind (environment.ts).
  environment: z.array(ContentIdSchema).min(1).optional(),
});

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

// A random table from a book. Each row covers the die results min to max, and its cells line up with `columns`.
export const RollTableSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  die: z.string().regex(/^\d*d\d+$/), // such as d100 or 2d6
  columns: z.array(z.string()).min(1), // the headings of the columns after the die roll
  rows: z
    .array(
      z.strictObject({
        min: z.number().int().min(1),
        max: z.number().int().min(1),
        cells: z.array(z.string()),
        // what the row gives an item it's rolled for, while the item works, as an artifact's random property
        // (MagicItemSchema `properties`)
        passives: z.array(PassiveSchema).min(1).optional(),
      }),
    )
    .min(1),
  source: z.string().min(1),
})
  .strict()
  .superRefine((table, context) => {
    for (const [index, row] of table.rows.entries()) {
      if (row.min > row.max || row.cells.length !== table.columns.length) {
        context.addIssue({
          code: "custom",
          message: `row ${String(index + 1)} doesn't fit the table`,
        });
      }
    }
  });

// A table looked up by a printed key, such as a Challenge Rating band or a theme, rather than rolled on.
export const LookupTableSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  keyedBy: z.string().min(1), // the heading of the key column
  columns: z.array(z.string()).min(1), // the headings of the columns after the key
  rows: z
    .array(
      z.strictObject({ key: z.string().min(1), cells: z.array(z.string()) }),
    )
    .min(1),
  source: z.string().min(1),
}).strict();

// A Bastion's special facility or event, for reading. Nothing runs Bastion turns yet.
export const BastionEntrySchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  type: z.enum(["facility", "event"]),
  level: z.number().int().min(1).optional(), // the level a facility becomes available at
  prerequisite: z.string().optional(),
  order: z.string().optional(), // the order a facility's hirelings can carry out
  text: z.string().min(1),
}).strict();

const LevelBandSchema = z.strictObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
});

// Traps and hazards share one shape. `text` is the printed entry as plain text, copied by code.
const DangerShape = {
  name: z.string().min(1),
  severity: z.enum(["nuisance", "deadly"]),
  levels: z.array(LevelBandSchema).min(1), // the character levels it is meant for
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

// XP an encounter may be worth per character, by character level. Nothing reads this yet.
export const EncounterBudgetSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  source: z.string().min(1),
  rows: z
    .array(
      z.strictObject({
        level: z.number().int().min(1).max(20),
        low: z.number().int().min(0),
        moderate: z.number().int().min(0),
        high: z.number().int().min(0),
      }),
    )
    .min(1),
}).strict();
