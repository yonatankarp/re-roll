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

const WeaponPropertySchema = z.enum([
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
  }),
  z.strictObject({ kind: z.literal("level") }), // character level
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
  bonus: FormulaSchema.optional(),
  reroll: z.number().int().min(1).optional(), // dice rolled again once when below average, as with Empowered Spell
  rerollOnes: z.literal(true).optional(), // a die that rolls 1 is rolled again and the new roll stands
});
export type Amount = z.infer<typeof AmountSchema>;

export const DamageSchema = z.strictObject({
  amount: AmountSchema,
  type: DamageTypeSchema,
});
export type Damage = z.infer<typeof DamageSchema>;

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
    ]),
    amount: AmountSchema,
    once: z.boolean().optional(),
    subtract: z.boolean().optional(), // taken off attack rolls, saves or checks instead, as with Bane
    skill: SkillSchema.optional(), // only checks with this skill, as Pass without Trace's Stealth
    ability: AbilitySchema.optional(), // only saves with this ability, as Slow's Dexterity saves
  }),
  // "once" ends the effect after the next attack roll it applies to, as with Guiding Bolt.
  // "ability" limits it to rolls with that ability, as with Strength-based D20 Tests.
  z.strictObject({
    kind: z.literal("advantage"),
    on: RollFlagSchema,
    once: z.boolean().optional(),
    ability: AbilitySchema.optional(),
    // attacksAgainst only for the effect's caster, as Lords' Alliance Agent's Reassert Honor.
    casterOnly: z.literal(true).optional(),
  }),
  // "attackers" limits attacksAgainst to creatures of these lowercase types, as with Protection from Evil and Good.
  z.strictObject({
    kind: z.literal("disadvantage"),
    on: RollFlagSchema,
    once: z.boolean().optional(),
    ability: AbilitySchema.optional(),
    attackers: z.array(z.string()).min(1).optional(),
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
  z.strictObject({
    kind: z.literal("retaliate"),
    damage: z.array(DamageSchema).default([]),
    grapple: z.literal(true).optional(),
  }),
  // Can't gain this condition while it lasts, as Lordly Resolve's bolstered targets.
  z.strictObject({
    kind: z.literal("conditionImmunity"),
    condition: ConditionSchema,
  }),
  z.strictObject({ kind: z.literal("acFormula"), formula: FormulaSchema }),
  // Seeing creatures that have the Invisible condition as if they were visible, as See Invisibility does.
  z.strictObject({ kind: z.literal("seeInvisible") }),
  // Damage at the start or end of the bearer's turn, such as Moonbeam or Searing Smite.
  z.strictObject({
    kind: z.literal("lingeringDamage"),
    when: z.enum(["turnStart", "turnEnd"]),
    damage: z.array(DamageSchema).min(1),
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
    dealtBy: z.enum(["bearer", "caster"]),
    weaponOnly: z.boolean().default(false),
    damage: DamageSchema,
    once: z.boolean().optional(), // ends after the bearer's next attack roll, as a bandit crime lord's Deadly Aim
  }),
  // Limits on what the bearer can do on its turns, as Slow gives: `oneAction` is an action or a Bonus Action, not
  // both; `noActions` neither; `oneAttack` one attack with the Attack action; `speed` halves, doubles or stops its
  // Speed; `spellFailure` is the percent chance a spell with a Somatic component fails.
  z.strictObject({
    kind: z.literal("actionLimit"),
    oneAction: z.literal(true).optional(),
    noActions: z.literal(true).optional(),
    noReactions: z.literal(true).optional(),
    oneAttack: z.literal(true).optional(),
    speed: z.enum(["half", "double", "none"]).optional(),
    spellFailure: z.number().int().min(1).max(100).optional(),
  }),
  // Haste's additional action each turn: the Attack (one attack only), Dash, Disengage or Hide action. When it
  // ends, the bearer is Incapacitated with a Speed of 0 until the end of its next turn.
  z.strictObject({ kind: z.literal("hasted") }),
  // Shut away where nothing reaches it and it reaches nothing, as in Otiluke's Resilient Sphere, a Forcecage box
  // or Maze. With `escape` it can spend its action on that check to end the effect, as Maze's DC 20 Intelligence.
  z.strictObject({
    kind: z.literal("sealed"),
    escape: z
      .strictObject({
        ability: AbilitySchema,
        dc: z.number().int(),
        skill: SkillSchema,
      })
      .optional(),
  }),
  // Kept by a creature that saved against an area, which no longer affects it, as a ghast's Stench.
  z.strictObject({ kind: z.literal("areaImmunity") }),
  // A flat increase to a weapon's own damage, optionally only with one ability, such as Rage.
  z.strictObject({
    kind: z.literal("damageBonus"),
    amount: AmountSchema,
    ability: AbilitySchema.optional(),
    subtract: z.boolean().optional(), // a penalty, as a gold dragon's Weakening Breath
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
  // Illusory duplicates, each of which a hit may land on instead, as Mirror Image's (combat/attack.ts).
  z.strictObject({
    kind: z.literal("images"),
    count: z.number().int().min(1),
  }),
  // An attacker must pass a Wisdom save against `dc` (the caster's, filled in as it's cast) or lose the attack, as
  // Sanctuary.
  z.strictObject({
    kind: z.literal("sanctuary"),
    dc: z.number().int().optional(),
  }),
  // At the start of each of its turns the bearer rolls a d8: on 1-6 it does nothing, on 7-8 it makes a melee attack
  // against a random creature in reach, and it takes no Reactions, as an umber hulk's Confusing Gaze (combat/turn.ts).
  // shortcut: the 5-6 random walk is spent standing still, as wandering off is close to doing nothing on the grid.
  z.strictObject({ kind: z.literal("confused") }),
  // No rule of its own: a curse, a mark or a hold that another of its giver's actions looks for (a targeting's
  // `afflicted`), as a nightmare's Haunter's Spear curse.
  z.strictObject({ kind: z.literal("mark") }),
]);
export type Modifier = z.infer<typeof ModifierSchema>;

export const DurationSchema = z.union([
  z.literal("instantaneous"),
  z.strictObject({ concentration: z.literal(true), minutes: z.number() }),
  // "its" counts the target's turns, not the caster's, and "turnEnd" is the end of the turn it happens on.
  z.strictObject({
    until: z.enum([
      "yourNextTurnStart",
      "yourNextTurnEnd",
      "itsNextTurnStart",
      "itsNextTurnEnd",
      "turnEnd",
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
]);
export type ZoneKind = z.infer<typeof ZoneKindSchema>;

export const LeafEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("heal"), amount: AmountSchema }),
  z.strictObject({ kind: z.literal("tempHp"), amount: AmountSchema }),
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
    // only a target this size or smaller, as an Energy Pulse knocks only a Medium or smaller creature Prone
    maxSize: z
      .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
      .optional(),
    endsOnDamage: z.boolean().default(false),
    endsOnSpell: z.boolean().optional(), // ends when another spell targets the creature, as Modify Memory's
    // Ends when the creature attacks or deals damage ("attack"), or takes any action ("action"), as Fade Away's.
    endsOn: z.enum(["attack", "action"]).optional(),
    // Taking damage gives it a save to end it, as Dragon Fear's, using the save it came with.
    saveOnDamage: z.literal(true).optional(),
    // What a failed repeat save turns it into, as a cockatrice's Restrained becoming Petrified.
    secondFailure: z
      .strictObject({
        condition: ConditionSchema,
        duration: DurationSchema,
        endsOnDamage: z.boolean().default(false),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("removeCondition"),
    condition: ConditionSchema,
  }),
  z.strictObject({
    kind: z.literal("modifier"),
    modifier: ModifierSchema,
    duration: DurationSchema,
    repeatSave: z.boolean().optional(), // as an applyCondition's
  }),
  z.strictObject({
    kind: z.literal("forcedMove"),
    feet: z.number(),
    direction: z.enum(["away", "toward"]),
  }),
  z.strictObject({ kind: z.literal("note"), text: z.string() }),
  // The bearer teleports up to `feet` to an open square it can see, or with `movement` jumps there for that much
  // of the turn's movement (a monster's Leap), provoking Opportunity Attacks as a walk would.
  z.strictObject({
    kind: z.literal("teleport"),
    feet: z.number().int().min(5),
    movement: z.number().int().min(0).default(0),
    // A teleport paid for with movement that still provokes nothing, as Portal Step's.
    provokes: z.literal(false).optional(),
  }),
  // The Dash action as part of another, as with Adrenaline Rush, or the Disengage action, as a clay golem's Hasten.
  z.strictObject({ kind: z.literal("dash") }),
  z.strictObject({ kind: z.literal("disengage") }),
  z.strictObject({ kind: z.literal("extraAction") }), // Action Surge
  // Ends one of these conditions on the target, the one that hampers it most, as Lesser Restoration does.
  z.strictObject({
    kind: z.literal("cure"),
    conditions: z.array(ConditionSchema).min(1),
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
    radius: z.number().int().min(5),
    duration: DurationSchema,
    damage: z.array(DamageSchema).optional(),
    follows: z.literal(true).optional(),
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
      })
      .optional(),
    // What the creature keeps of its own: its Intelligence, Wisdom and Charisma ("mind"), and its spellcasting.
    keep: z
      .array(z.enum(["mind", "spells"]))
      .min(1)
      .optional(),
    tempHp: z.boolean().default(true), // the form's Hit Points as Temporary Hit Points
  }),
  // Ends every spell of this level or lower that is on the target, as Dispel Magic does.
  z.strictObject({
    kind: z.literal("dispel"),
    maxLevel: z.number().int().min(0).max(9),
  }),
  // Lessens the hit that triggered a reaction, such as Uncanny Dodge or Deflect Attacks.
  z.strictObject({
    kind: z.literal("reduceDamage"),
    halve: z.boolean().default(false),
    amount: AmountSchema.optional(),
  }),
  // Adds to AC against the hit that triggered a reaction only, possibly turning it into a miss, as with Parry.
  z.strictObject({
    kind: z.literal("acAgainstHit"),
    // A formula is the reactor's, as a familiar's Intercept Attack adding its owner's Proficiency Bonus.
    bonus: z.union([z.number().int().min(1), FormulaSchema]),
  }),
  // The caster's familiar takes its action of this name, which has the `commanded` trigger, spending its Reaction,
  // when it is within `range` feet, as a familiar's Energy Pulse (combat/familiar.ts).
  z.strictObject({
    kind: z.literal("commandFamiliar"),
    action: z.string().min(1),
    range: z.number().int().min(5),
  }),
  // The spell that triggered the reaction fails, as Counterspell's does on a failed save (combat/counter.ts).
  z.strictObject({ kind: z.literal("counter") }),
  // Responses to a d20 roll made before its result applies (combat/reactions.ts): the roller rolls the die again
  // and must use the new roll, as with Bountiful Luck; the roll gains or loses `amount`, as with Boon of Fate
  // (`either`) or a sphinx's Burst of Ingenuity; or the bearer rolls a d20 that may stand in for it, as with
  // Portent.
  z.strictObject({ kind: z.literal("reroll") }),
  z.strictObject({
    kind: z.literal("rollBonus"),
    amount: AmountSchema,
    either: z.boolean().default(false),
  }),
  z.strictObject({ kind: z.literal("replaceRoll") }),
  // The bearer makes one attack against the creature that set the reaction off: the action named, or else an
  // Opportunity Attack with its melee weapon. `approach` moves it next to the creature first without provoking,
  // as with Bloodthirsty Slash.
  z.strictObject({
    kind: z.literal("strike"),
    action: z.string().optional(),
    advantage: z.boolean().default(false),
    approach: z.boolean().default(false),
  }),
  // A Small or Medium ally within 5 feet trades places with the bearer and becomes the attack's target, as with
  // Redirect Attack; with `charmed`, any Charmed creature there instead.
  z.strictObject({
    kind: z.literal("redirect"),
    charmed: z.boolean().default(false),
  }),
  // The triggering attack misses instead, as with Jinx on a failed save.
  z.strictObject({ kind: z.literal("negateHit") }),
  // The bearer splits in two, each with half its Hit Points, as a black pudding does, while it has at least `minHp`
  // and has split fewer than `times` times (once for each size it can shrink).
  z.strictObject({
    kind: z.literal("split"),
    minHp: z.number().int().min(1).default(10),
    times: z.number().int().min(1).default(1),
  }),
  // The bearer trades Initiative with a willing ally, as with Alert's Initiative Swap.
  z.strictObject({ kind: z.literal("swapInitiative") }),
  // The bearer gains Heroic Inspiration, as with Tireless Reveler.
  z.strictObject({ kind: z.literal("inspiration") }),
  // Resistance to the damage that set the reaction off, as with Elemental Absorption.
  z.strictObject({ kind: z.literal("resistTrigger") }),
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
  }),
  // A strong wind: it ends the gas and vapour zones in its area, as Gust of Wind does Fog Cloud.
  z.strictObject({ kind: z.literal("disperse") }),
  // The caster takes this many turns in a row, ending once something it does reaches another creature, as Time Stop.
  z.strictObject({ kind: z.literal("extraTurns"), turns: AmountSchema }),
  // The target spends one of its Hit Point Dice and regains what it rolls plus `bonus`, as with Healer's Battle Medic.
  z.strictObject({ kind: z.literal("hitDieHeal"), bonus: FormulaSchema }),
  // The bearer takes another of its stat block's own shapes, by name, or goes back to its true one (core/forms.ts).
  z.strictObject({ kind: z.literal("shapeShift"), shape: z.string().min(1) }),
  // One of the bearer's own actions picked at random, `times` over, never one already used this turn, at the same
  // target, as a beholder zombie's Eye Rays (combat/effects.ts). Those actions are marked `rolled`.
  z.strictObject({
    kind: z.literal("randomAction"),
    of: z.array(z.string().min(1)).min(2),
    times: z.number().int().min(1).default(1),
  }),
  // A corpse of these types within `range` rises as this monster on the bearer's side, as a wraith's Create Specter.
  // A dying creature becomes Stable, as with Spare the Dying.
  z.strictObject({ kind: z.literal("stabilize") }),
  // A target with this many Hit Points or fewer dies outright instead of taking the damage, as Power Word Kill.
  z.strictObject({
    kind: z.literal("slay"),
    hpAtMost: z.number().int().min(1),
  }),
  // The target gains this many levels of Exhaustion, as a sphinx's Weight of Years.
  z.strictObject({
    kind: z.literal("exhaustion"),
    levels: z.number().int().min(1),
  }),
  // `count` of this monster (the bearer's own stat block when left out) come to life in open squares within `range`
  // on the bearer's side, without the actions named in `lacks`, taking their turns right after the bearer's, as a
  // treant's Animate Trees or a priest's Soul Tattoo.
  z.strictObject({
    kind: z.literal("animate"),
    monster: ContentIdSchema.optional(),
    count: z.number().int().min(1).default(1),
    range: z.number().int().min(5),
    lacks: z.array(z.string().min(1)).default([]),
  }),
  // The target spends its Reaction on one melee attack against a foe in its reach, as a gnoll pack lord's Incite
  // Rampage.
  z.strictObject({ kind: z.literal("reactionAttack") }),
  // The target spends its Reaction to move up to its Speed beside its nearest foe, without provoking Opportunity
  // Attacks, as Ez d'Avenir's Inspiring Rally.
  z.strictObject({ kind: z.literal("reactionMove") }),
  z.strictObject({
    kind: z.literal("raiseCorpse"),
    monster: ContentIdSchema,
    range: z.number().int().min(5),
    creatureTypes: z.array(z.string()).min(1),
    all: z.boolean().default(false), // every such corpse, not one
  }),
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
      proficient: z.boolean().optional(), // false for a weapon the wielder has no training with
      itemBonus: z.number().int().min(1).optional(), // a magic weapon's own bonus to hit
      // Beyond this many feet, out to the targeting's range, the roll has Disadvantage, as a thrown weapon's long range.
      normalRange: z.number().int().min(5).optional(),
    }),
    damage: z.array(DamageSchema).min(1),
    onHit: LeafEffectsSchema,
    onMiss: LeafEffectsSchema,
    // A save the target makes after a hit, as a ghoul's paralysing claw. Creatures of an `exempt` type or species
    // (lowercase) never make it.
    onHitSave: z
      .strictObject({
        ability: AbilitySchema,
        dc: FormulaSchema,
        damage: z.array(DamageSchema).default([]),
        onSuccessDamage: z.enum(["half", "none", "full"]).default("none"),
        onFail: LeafEffectsSchema,
        onSuccess: LeafEffectsSchema,
        exempt: z.array(z.string()).optional(),
        // Only once a turn, on the attacker's own turn, as Feral Pounce's Shove or Punch and Grab's Grapple.
        oncePerTurn: z.literal(true).optional(),
        orDex: z.literal(true).optional(), // the target saves with Strength or Dexterity, whichever is better
      })
      .optional(),
    // Effects on a hit once a turn, on the attacker's own turn, as Tavern Brawler's push.
    onHitOncePerTurn: z.array(LeafEffectSchema).min(1).optional(),
    // A hit heals the attacker by the damage dealt, spending a use, as a Dhampir's Vampiric Bite.
    drain: z.strictObject({ resource: z.string() }).optional(),
  }),
  z.strictObject({
    kind: z.literal("save"),
    ability: AbilitySchema,
    dc: FormulaSchema,
    advantage: z.boolean().optional(), // the target saves with Advantage, as when its caster is fighting it
    damage: z.array(DamageSchema).default([]),
    // "full" deals the damage either way, and the save is only for its effects, as with Trip Attack.
    onSuccessDamage: z.enum(["half", "none", "full"]).default("none"),
    onFail: LeafEffectsSchema,
    onSuccess: LeafEffectsSchema,
  }),
]);
export type Resolution = z.infer<typeof ResolutionSchema>;

// What a lasting area does to the creatures in it (core/zones.ts). `side` counts from the creature it belongs to,
// and everyone is affected when it's left out; a moving area never affects its own bearer. `when` resolves
// `resolution` on a creature in it as that creature's turn starts or ends, or on everyone in it (up to `targets`)
// as its owner's turn starts or ends. `grants` are modifiers those in it have, as Marshal Undead's Advantage.
export const AreaEffectSchema = z.strictObject({
  side: z.enum(["enemy", "ally"]).optional(),
  creatureTypes: z.array(z.string()).min(1).optional(), // only these lowercase types, as Marshal Undead's undead
  exceptTypes: z.array(z.string()).min(1).optional(), // never these, as Antilife Shell's undead and constructs
  when: z
    .enum(["turnStart", "turnEnd", "ownerTurnStart", "ownerTurnEnd"])
    .optional(),
  resolution: ResolutionSchema.optional(),
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
});
export type AreaEffect = z.infer<typeof AreaEffectSchema>;

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
    creatureTypes: z.array(z.string()).optional(), // only these lowercase types can be targeted
    targetConditions: z.array(ConditionSchema).min(1).optional(), // only a creature with one of these, as for Trample
    dead: z.literal(true).optional(), // only a dead creature, as for Revivify
    // only a creature this size or smaller, as for a giant frog's Swallow
    maxSize: z
      .enum(["tiny", "small", "medium", "large", "huge", "gargantuan"])
      .optional(),
    bloodied: z.literal(true).optional(), // only a Bloodied creature, as for a gnoll's Rampage
    downed: z.literal(true).optional(), // only a living creature at 0 Hit Points, as for a will-o'-wisp's Consume Life
    // only a creature under an effect of the bearer's action of this name, as a nightmare's spear curse for Narcotize
    afflicted: z.string().min(1).optional(),
  }),
  z.strictObject({
    area: z.strictObject({
      shape: z.enum(["sphere", "cone", "cube", "line", "emanation"]),
      radius: z.number(),
    }),
    range: RangeSchema,
    side: SideSchema,
    creatureTypes: z.array(z.string()).optional(),
    targetConditions: z.array(ConditionSchema).min(1).optional(), // only those with one of these, as Intensify Poison
    afflicted: z.string().min(1).optional(), // as a creature target's, as an arch-hag's Witch Strike
  }),
]);
export type Targeting = z.infer<typeof TargetingSchema>;

export const ActivationSchema = z.strictObject({
  cost: z.array(CostSchema),
  trigger: z
    .strictObject({
      hitByAttack: z.literal(true).optional(),
      melee: z.literal(true).optional(), // only a melee attack's hit triggers it, as with Parry
      targetedBySpell: z.string().optional(),
      // Taken when a foe it can see within the activation's range casts a spell, as with Counterspell.
      spellCast: z.literal(true).optional(),
      // Taken right after hitting with a weapon, as with the smite spells.
      afterHit: z.enum(["weapon", "meleeWeapon"]).optional(),
      // Taken for another creature within 5 feet that a creature the bearer can see attacks, before the roll, or hits,
      // as with Protection and Interception. It's taken as soon as it can be.
      allyAttacked: z.literal(true).optional(),
      allyHit: z.literal(true).optional(),
      // what the bearer must hold to take it; "polearm" is a Quarterstaff, a Spear or a Heavy weapon with Reach
      holding: z.enum(["shield", "shieldOrWeapon", "polearm"]).optional(),
      // Taken by the bearer when a creature attacks it, before the roll, giving that roll Disadvantage, as with
      // Lucky. It's taken on its own once the bearer is at half its Hit Points or fewer, or the attacker has
      // Advantage.
      attacked: z.literal(true).optional(),
      // Taken right after a creature's attack damages the bearer, against that creature, as with Storm's Thunder.
      damaged: z.literal(true).optional(),
      damagedBy: z.array(DamageTypeSchema).min(1).optional(), // only damage of these types, as with Delicious Pain
      // With `damaged`, taken before the damage applies, so it can lessen it, as with Vitality Ward.
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
      // its ally (`hit`), a failure, or anything; `magical` only a save against a spell or magic.
      rolled: z
        .strictObject({
          rolls: z.array(z.enum(["attack", "save", "check"])).min(1),
          by: z.enum(["self", "ally", "selfOrAlly", "foe", "any"]),
          when: z.enum(["natural1", "hit", "failed", "any"]).default("any"),
          magical: z.literal(true).optional(),
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
      // Taken after the bearer's own save against a creature's effect fails or succeeds, as with Mind Corrosion.
      ownSave: z.enum(["failed", "succeeded"]).optional(),
      // With `ownSave`, `missed` or `struck`, only a spell sets it off, as with Spell Reflection.
      bySpell: z.literal(true).optional(),
      // Taken when a creature within `within` makes a save to keep Concentration, as with Warp Mind.
      concentrationSave: z.literal(true).optional(),
      // Taken when an ally within `within` spends Heroic Inspiration, as with Tireless Reveler.
      inspirationSpent: z.literal(true).optional(),
      // Taken right after Initiative is rolled, as with Alert's Initiative Swap.
      initiative: z.literal(true).optional(),
      // Taken only when its owner's `commandFamiliar` effect calls for it, never on its own.
      commanded: z.literal(true).optional(),
    })
    .optional(),
  carrying: ContentIdSchema.optional(), // an item the bearer must carry to use it, as Battle Medic's Healer's Kit
  whileIn: z.literal("shadows").optional(), // only in Dim Light or Darkness, as Merge with Shadows
  afterAction: z.literal(true).optional(), // only once the bearer has taken its action, as Blink Steps
  label: z.string().min(1).optional(), // added to its feature's name, to tell two of a feature's activations apart
  projectiles: z.number().int().min(1).optional(), // separate darts, rays or beams, each aimed on its own
  targeting: TargetingSchema,
  resolution: ResolutionSchema,
  area: AreaEffectSchema.optional(), // what the zone its resolution leaves does later
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

// `bloodied` on a passive means it only holds while the bearer is Bloodied, as a cultist of Myrkul's Nearer to the Dead.
const WhileBloodied = z.literal(true).optional();

export const PassiveSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("modifier"),
    modifier: ModifierSchema,
    bloodied: WhileBloodied,
  }),
  // An area round the bearer that moves with it, as a ghast's Stench, a balor's Fire Aura or a flameskull's
  // Illumination ("light" or "dim" for the light it sheds).
  z.strictObject({
    kind: z.literal("aura"),
    name: z.string().min(1),
    zone: ZoneKindSchema.default("area"),
    radius: z.number().int().min(5),
    area: AreaEffectSchema.default({}),
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
    dice: DiceSchema,
    diceCount: z.string().optional(), // a class scaling key that replaces the number of dice
    dieSize: z.string().optional(), // a class scaling key that replaces the die size
    // "advantageOrAlly" also counts an ally within 5 feet of the target, as Sneak Attack does.
    when: z.enum(["advantage", "advantageOrAlly"]),
    oncePerTurn: z.boolean().default(false),
  }),
  z.strictObject({ kind: z.literal("packTactics") }),
  // Leaving a foe's reach never provokes an Opportunity Attack, as with Flyby or Agile.
  z.strictObject({ kind: z.literal("noOpportunityAttacks") }),
  // A save for half damage deals none on a success and half on a failure, as with Evasion. `anySave` makes it every
  // save, as a displacer beast's Avoidance does, instead of Dexterity saves only.
  z.strictObject({
    kind: z.literal("evasion"),
    anySave: z.boolean().default(false),
  }),
  // Advantage on attack rolls while Bloodied, against a target missing Hit Points, or against a Frightened one.
  z.strictObject({
    kind: z.literal("attackAdvantage"),
    when: z.enum(["bloodied", "targetHurt", "targetFrightened"]),
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
  // that hampers it most, as an inquisitor's Metabolic Control.
  z.strictObject({
    kind: z.literal("regeneration"),
    hp: z.number().int().min(1),
    stoppedBy: z.array(DamageTypeSchema).default([]), // damage that stops it for a turn
    bloodied: WhileBloodied,
    cures: z.literal(true).optional(),
  }),
  // A Critical Hit on this natural roll or higher, as with Improved Critical.
  z.strictObject({
    kind: z.literal("criticalRange"),
    from: z.number().int().min(2).max(19),
  }),
  // Advantage on saving throws with these abilities, or against these conditions, as with Gnomish Cunning or Brave.
  z.strictObject({
    kind: z.literal("saveAdvantage"),
    abilities: z.array(AbilitySchema).default([]),
    conditions: z.array(ConditionSchema).default([]),
    bloodied: z.literal(true).optional(), // only while Bloodied, as with Bloodied Frenzy
  }),
  // Heroic Inspiration as a rest ends, for the bearer or for its allies, as with Resourceful or Musician.
  z.strictObject({
    kind: z.literal("restInspiration"),
    rests: z.array(z.enum(["short", "long"])).min(1),
    allies: z.boolean().default(false),
  }),
  // Dropping to 1 Hit Point instead of 0 while the resource lasts, as with Relentless Endurance.
  z.strictObject({ kind: z.literal("dropToOne"), resource: z.string() }),
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
  }),
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
    tactics: z.array(z.enum(["dash", "disengage", "hide", "dodge"])).min(1),
    half: z.literal(true).optional(), // its Dash adds half its Speed, as a troll's Charge
    safe: z.literal(true).optional(), // its Dash provokes no Opportunity Attacks, as a warrior commander's Tactical Charge
    resource: z.string().optional(), // each use spends one, as Timely Retreat's
  }),
  // Advantage on saves to keep Concentration, as with Eldritch Mind.
  z.strictObject({ kind: z.literal("concentrationAdvantage") }),
  // A creature leaving the bearer's reach can be answered with a one-target spell of one action instead of an
  // Opportunity Attack, as with War Caster's Reactive Spell.
  z.strictObject({ kind: z.literal("reactiveSpell") }),
  // Attacks per Attack action, such as Extra Attack.
  z.strictObject({
    kind: z.literal("multiattack"),
    attacks: z.number().int().min(2),
  }),
  // A 1 on the d20 of a D20 Test is rolled again, and the new roll stands, as with Halfling Luck.
  z.strictObject({ kind: z.literal("rerollOnes") }),
  // Once a turn, a weapon hit's damage dice are rolled twice and the higher kept, as with Savage Attacker.
  z.strictObject({ kind: z.literal("savageAttacker") }),
  // Proficiency in these saving throws, or with `increased` in the one its feat raised, as with Resilient.
  z.strictObject({
    kind: z.literal("saveProficiency"),
    abilities: z.array(AbilitySchema).default([]),
    increased: z.boolean().default(false),
  }),
  // Advantage on Death Saving Throws, as with Durable.
  z.strictObject({ kind: z.literal("deathSaveAdvantage") }),
  // Temporary Hit Points as a rest ends, for the bearer and with `allies` the whole party, as with Inspiring Leader.
  // A 1 or 2 on a damage die of a Two-Handed melee weapon counts as a 3, as with Great Weapon Fighting.
  z.strictObject({ kind: z.literal("greatWeaponFighting") }),
  z.strictObject({
    kind: z.literal("restTempHp"),
    rests: z.array(z.enum(["short", "long"])).min(1),
    amount: FormulaSchema,
    allies: z.boolean().default(false),
  }),
  // The bearer's spells of this type ignore Resistance to it, and a 1 on their damage dice counts as a 2, as with
  // Elemental Adept.
  z.strictObject({
    kind: z.literal("energyMastery"),
    damage: DamageTypeSchema,
  }),
  // Damage of these types the bearer deals ignores Resistance, as with the Boon of Irresistible Offense.
  z.strictObject({
    kind: z.literal("overcomeResistance"),
    damage: z.array(DamageTypeSchema).min(1),
  }),
  // Effects on a creature the bearer hits with an attack dealing this type, as Crusher or Slasher give: with
  // `critical` only on a Critical Hit, with `oncePerTurn` once a turn.
  z.strictObject({
    kind: z.literal("damageRider"),
    damage: DamageTypeSchema,
    critical: z.boolean().default(false),
    oncePerTurn: z.boolean().default(false),
    resource: z.string().optional(), // each use spends one, as Putrefy's once per rest
    spells: z.literal(true).optional(), // a spell's damage triggers it too, as Putrefy's
    effects: z.array(LeafEffectSchema).min(1),
  }),
  // An attack's damage of these types lessened while the bearer wears this armor, as with Heavy Armor Master.
  z.strictObject({
    kind: z.literal("armoredReduction"),
    armor: z.enum(["light", "medium", "heavy"]),
    damage: z.array(DamageTypeSchema).min(1),
    amount: FormulaSchema,
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
  // A healing die that rolls 1 is rolled again and the new roll stands, as with Healer's Healing Rerolls.
  z.strictObject({ kind: z.literal("healingRerolls") }),
  // An ally within `within` feet of the bearer treats a healing die's roll below `at` as `at`, as with a Soothing
  // Familiar's Healing Beacon.
  z.strictObject({
    kind: z.literal("healDieFloor"),
    at: z.number().int().min(2),
    within: z.number().int().min(5),
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
    // A die rolled and added instead, when its highest roll could be enough, as Spell Resistant's 1d6.
    bonusDice: DiceSchema.optional(),
    magical: z.literal(true).optional(), // only a save against a spell, as Magic Resistant
    reaction: z.boolean().default(false),
    resource: z.string(),
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
  z.strictObject({ kind: z.literal("unshakableFocus") }),
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
    suppressed: z.enum(["attacking", "incapacitated"]),
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
  // Advantage on its Initiative roll, as an asteroid spider's False Appearance gives one that lies still.
  z.strictObject({ kind: z.literal("initiativeAdvantage") }),
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
  // Starting its turn Bloodied, a 6 on a d6 makes it berserk until it isn't Bloodied: it attacks the nearest creature
  // it can see, friend or foe, as a flesh golem's Berserk (combat/turn.ts).
  z.strictObject({ kind: z.literal("berserk") }),
  // Its area spells spare itself and up to `creatures` others of its side, as an evoker's Evocation Sculptor.
  z.strictObject({
    kind: z.literal("sculptor"),
    creatures: z.number().int().min(1),
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
  // Concentration on it ("persistent"). combat/school.ts.
  z.strictObject({
    kind: z.literal("schoolCast"),
    school: SpellSchoolSchema,
    rider: z.enum(["ward", "life", "augment", "fueled", "persistent"]),
  }),
  // A failed ability check gets this die added when it could be enough, spending a use, as Reborn's Knowledge from a
  // Past Life.
  z.strictObject({
    kind: z.literal("checkRescue"),
    bonusDice: DiceSchema,
    resource: z.string(),
  }),
  // Advantage on saves with these abilities while within 5 feet of an ally that can act, for the bearer and that
  // ally, as Order's Resilience's Stronger Together.
  z.strictObject({
    kind: z.literal("allySaveAdvantage"),
    abilities: z.array(AbilitySchema).min(1),
  }),
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
  }),
  // A damage roll of this type uses the highest number on each die, spending a use, as Powerful Radiance.
  z.strictObject({
    kind: z.literal("maxDamageDice"),
    damage: DamageTypeSchema,
    resource: z.string(),
  }),
  // Once a turn, an attack made while Bloodied deals the Proficiency Bonus more, as Boon of Bloodshed's Power from Pain.
  z.strictObject({ kind: z.literal("bloodiedDamage") }),
  // An enemy dropping to 0 Hit Points gives the bearer's next attack Advantage, as Boon of Bloodshed's Killer's
  // Fortune.
  z.strictObject({ kind: z.literal("killAdvantage") }),
  // Helping an attack on an enemy also gives it Disadvantage on its next save, as Harper Teamwork.
  z.strictObject({ kind: z.literal("helpRider") }),
  // Ending Frightened or Paralyzed on itself with a save ends it on an ally within 30 feet, as Inspiring Willpower.
  z.strictObject({ kind: z.literal("sharedRecovery") }),
  // A slot spell's damage dice count 1s and 2s as 3s and knock the damaged Prone, spending a use, as Boon of Erupting
  // Spellpower.
  z.strictObject({ kind: z.literal("spellOverload"), resource: z.string() }),
  // Once on its turn, a melee hit after moving 10 feet closer to the target adds 1d8, as Charger's Charge Attack.
  z.strictObject({ kind: z.literal("chargeAttack") }),
  // Casting a spell that deals this type puts these effects on the bearer, as Flames of Phlegethos' flames.
  z.strictObject({
    kind: z.literal("castRider"),
    damage: DamageTypeSchema,
    effects: z.array(LeafEffectSchema).min(1),
  }),
  // A Long Rest leaves one of this item with the bearer, as Vampire's Plaything's Decanting.
  z.strictObject({ kind: z.literal("restItem"), item: ContentIdSchema }),
  // A Reaction keeps an ally within 5 feet from being pushed or pulled, as Tyro of the Gauntlet's Stand as One.
  z.strictObject({ kind: z.literal("standAsOne") }),
  // Once a turn, hitting a Bloodied creature that isn't a Construct or Undead spends a Hit Point Die to heal its roll
  // plus the Constitution modifier, spending a use, as Bloodlust's Sanguine Feast.
  z.strictObject({ kind: z.literal("bloodiedFeast"), resource: z.string() }),
  // A vial or flask is thrown this far, as with Bomber's Far Lobber.
  z.strictObject({
    kind: z.literal("farLobber"),
    feet: z.number().int().min(5),
  }),
]);
export type Passive = z.infer<typeof PassiveSchema>;

export const ResourceDefSchema = z.strictObject({
  id: z.string().min(1),
  max: FormulaSchema,
  recharge: z.array(
    z.strictObject({
      // "initiative" comes back as a fight starts, as Boon of Fate's Improve Fate does.
      on: z.enum(["turnStart", "shortRest", "longRest", "dawn", "initiative"]),
      amount: z.union([z.literal("all"), z.number().int()]),
      rollAtLeast: z.number().int().optional(),
    }),
  ),
});

const ScaleStepSchema = z.union([
  z.strictObject({ addDice: DiceSchema }),
  z.strictObject({ addTargets: z.number().int().min(1) }),
]);
export type ScaleStep = z.infer<typeof ScaleStepSchema>;

export const FeatureSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  text: z.string().min(1),
  automation: AutomationSchema,
  passives: z.array(PassiveSchema).default([]),
  activations: z.array(ActivationSchema).default([]),
  resources: z.array(ResourceDefSchema).default([]),
  fromLevel: z.number().int().min(1).max(20).optional(), // the character level it starts working at
  // Dice added to its activations at character levels 5, 11 and 17, as a cantrip's are.
  perTier: ScaleStepSchema.optional(),
  // Spells it always gives, from the character level in the key.
  spells: z.record(z.string(), z.array(ContentIdSchema)).optional(),
  // Spells it gives once the character has spell slots of the level in the key, as an Arcana Unleashed adept's table.
  spellsBySlot: z.record(z.string(), z.array(ContentIdSchema)).optional(),
  // Spells by slot level, as `spellsBySlot`, given only once this feat is taken too, as a Dragonmark's Spells of the
  // Mark with Potent Dragonmark.
  preparedWith: z
    .strictObject({
      feat: ContentIdSchema,
      spells: z.record(z.string(), z.array(ContentIdSchema)),
    })
    .optional(),
  // These spells' damage takes this type instead, as Rimekin's Cold Fire Magic.
  retype: z.record(ContentIdSchema, DamageTypeSchema).optional(),
  // Each leveled spell in `spells` can also be cast once per Long Rest without a slot, as with Fey Touched.
  freeCast: z.literal(true).optional(),
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
    // Picked again after a Long Rest, as Weapon Master's weapons (swap.ts).
    swap: z.literal("longRest").optional(),
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
    freeCast: z.literal(true).optional(), // each leveled spell picked is also cast once per Long Rest without a slot
    from: z.array(ContentIdSchema).min(1).optional(), // only these, as a feat's own table
    // The list of the version of this feat the character took, as "the list you chose for Magic Initiate".
    listOf: ContentIdSchema.optional(),
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
]);

export type ChoiceDef = z.infer<typeof ChoiceDefSchema>;

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
  levels: z.array(ClassLevelSchema).min(1),
}).strict();
export type Subclass = z.infer<typeof SubclassSchema>;

export const SpeciesSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  text: z.string().min(1),
  creatureType: z.string().min(1),
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

const MagicBonusSchema = z.strictObject({
  to: z.enum(["attack", "damage", "ac", "savingThrows", "spellAttack"]),
  amount: z.number().int().min(1),
});

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
  // A magic weapon made from a plain one, as a +2 Longsword: the plain weapon, and its own bonuses.
  baseWeapon: ContentIdSchema.optional(),
  bonuses: z.array(MagicBonusSchema).min(1).optional(),
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
}).strict();
export type Armor = z.infer<typeof ArmorSchema>;

const ShieldItemSchema = ItemBaseSchema.extend({
  type: z.literal("shield"),
  bonus: z.number().int(),
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
  ability: AbilitySchema,
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

// Numbers read from the book's text. The engine doesn't apply them yet, so `automation` says what actually happens.
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
  text: z.string().min(1),
  automation: AutomationSchema,
  bonuses: z.array(MagicBonusSchema).min(1).optional(),
  healing: AmountSchema.optional(), // drinking it heals, as a Potion of Healing does
  spell: ContentIdSchema.optional(), // the spell a Spell Scroll holds
  // Set when one entry covers several rarities, such as +1, +2 or +3. Content names one as `<id>--<n>` (variants.ts).
  variants: z
    .array(
      z.strictObject({
        rarity: RaritySchema,
        name: z.string().min(1).optional(),
        bonuses: z.array(MagicBonusSchema).min(1).optional(),
        healing: AmountSchema.optional(),
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
  creatureType: z.string().optional(), // lowercase, such as undead
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
    feat: ContentIdSchema.optional(), // the feat or species that asked, when it can be swapped
  }),
  z.strictObject({
    kind: z.literal("spells"),
    values: z.array(ContentIdSchema),
    freeCast: z.literal(true).optional(), // from a choice with `freeCast`
    feat: ContentIdSchema.optional(), // the feat that asked, for its spells' ability
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
    // "d" dim light, "x" darkness.
    walls: z.array(
      z.string().regex(/^[#.~htdx]*$/, "uses a code other than # . ~ h t d x"),
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
});

export const CheckSchema = z.union([
  z.strictObject({ skill: SkillSchema, dc: z.number().int() }),
  z.strictObject({ ability: AbilitySchema, dc: z.number().int() }),
]);
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
