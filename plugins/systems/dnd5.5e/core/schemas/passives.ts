import { ContentIdSchema } from "#sdk";
import { z } from "zod";
import {
  AbilitySchema,
  ConditionSchema,
  CreatureTypeSchema,
  DamageTypeSchema,
  SkillSchema,
  SpellSchoolSchema,
  WeaponMasterySchema,
  WeaponPropertySchema,
} from "./basics.ts";
import {
  AmountSchema,
  DamageSchema,
  DiceSchema,
  FormulaSchema,
} from "./dice.ts";
import {
  AlliesRiderSchema,
  AreaEffectSchema,
  CostSchema,
  HitKindSchema,
  LeafEffectSchema,
  ResolutionSchema,
  ZoneKindSchema,
} from "./effects.ts";
import { ModifierSchema } from "./modifiers.ts";

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
  // What the bearer's casting of one of these spells adds to the area it leaves, as Grasping Mist's lower Speed for
  // foes in its Fog Cloud (combat/effects.ts).
  z.strictObject({
    kind: z.literal("areaRider"),
    spells: z.array(ContentIdSchema).min(1),
    area: AreaEffectSchema,
  }),
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
    dim: z.number().int().min(5).optional(), // light: feet of Dim Light beyond its Bright, as Corona of Light's 30
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
    // only against a creature of one of these types or kin, as a Charm of the Slayer's dragons (combat/queries.ts)
    only: z.array(z.string().min(1)).min(1).optional(),
    // only while the bearer has this condition, as Adrenaline Surge's Frightened (stats.ts)
    whileCondition: ConditionSchema.optional(),
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
  // With `leading`, creatures of the bearer's side within 5 feet of it evade so too, as Leading Evasion.
  // shortcut: whether the bearer makes the same save isn't asked.
  z.strictObject({
    kind: z.literal("evasion"),
    anySave: z.boolean().default(false),
    leading: z.literal(true).optional(),
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
    count: FormulaSchema.optional(), // at most this many allies, as Musician's Proficiency Bonus
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
    // only a weapon without these properties, as Hex Warrior's that isn't Two-Handed (invocations.ts)
    without: z.array(WeaponPropertySchema).min(1).optional(),
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
    whileCondition: ConditionSchema.optional(), // only while the bearer has this condition, as Adrenaline Surge's
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
    // A Circle casting option (#192): offered while another of the party's casters within 30 feet can join, each
    // spending its Reaction, and with `slot` a spell slot ("spellLevel": one at least the spell's level). What
    // follows grows with how many join: `range` feet more each up to `max` (a spell with a range), `area` feet more
    // on its area's size, `prolong` minutes more from the first row whose `from` they reach (a spell lasting a minute
    // or more), `goldOff` gold off its costly component; `spare` keeps the caster's side out of its area, and
    // `share` gives Advantage on Constitution saves while the spell lasts, as the casters share its Concentration.
    // shortcut: the others join at once, with their Reactions, rather than with their Magic actions before the
    // caster's next turn.
    circle: z
      .strictObject({ slot: z.enum(["any", "spellLevel"]).optional() })
      .optional(),
    range: z
      .strictObject({
        perCaster: z.number().int().min(5),
        max: z.number().int().min(5),
      })
      .optional(),
    area: z.number().int().min(5).optional(),
    prolong: z
      .array(
        z.strictObject({
          from: z.number().int().min(1),
          minutes: z.number().int().min(1),
        }),
      )
      .min(1)
      .optional(),
    goldOff: z.number().int().min(1).optional(),
    spare: z.literal(true).optional(),
    share: z.literal(true).optional(),
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
  // These spells' action is a Bonus Action instead, as Spell Breaker's Dispel Magic, or every spell's with none named,
  // as Elder Champion's Swift Spells.
  z.strictObject({
    kind: z.literal("castsAs"),
    spells: z.array(ContentIdSchema).min(1).optional(),
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
  // `dice` are rolled and added too, as Power from Beyond's 1d6 on a Bard spell.
  z.strictObject({
    kind: z.literal("spellHealing"),
    bonus: FormulaSchema.default({ base: 0, add: [] }),
    dice: DiceSchema.optional(),
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
  // Mounting or getting off a mount costs only 5 feet of movement, as Born to the Saddle (combat/mounts.ts).
  z.strictObject({ kind: z.literal("quickMount") }),
  // The bearer's lasting companions have these passives, as a mount wearing Horseshoes of Speed.
  z.strictObject({
    kind: z.literal("companionGear"),
    passives: z.array(z.lazy((): z.ZodType => PassiveSchema)).min(1),
  }),
  // The bearer's familiar takes this form, as one of Pact of the Chain's special forms picked as a variant.
  z.strictObject({ kind: z.literal("familiarForm"), form: ContentIdSchema }),
  // The bearer has this companion for good: it's found before the first fight and again after a Long Rest once it
  // has died, and fights beside the bearer, acting right after it and taking only the Dodge action unless commanded
  // (combat/companions.ts), as a Steel Defender or a Primal Companion.
  z.strictObject({
    kind: z.literal("lastingCompanion"),
    companion: ContentIdSchema,
    // a monster's stat block, as Create Homunculus's; needing no command, and with a spell's level for its numbers,
    // as Homunculus Servant's
    monster: z.literal(true).optional(),
    free: z.literal(true).optional(),
    level: z.number().int().min(1).max(9).optional(),
  }),
  // A spell the bearer casts on itself also lands on its lasting companions within `within` feet, as Share Spells.
  z.strictObject({
    kind: z.literal("shareSpells"),
    within: z.number().int().min(5),
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
  // One of `resource`'s dice rolled and added to the bearer's Initiative, as Ambush's Superiority Die, and with
  // `allies` to its allies' too, as Tandem Footwork's Bardic Inspiration die (combat/start.ts).
  z.strictObject({
    kind: z.literal("initiativeDie"),
    bonusDice: DiceSchema,
    dieSize: z.string().optional(),
    resource: z.string().min(1),
    allies: z.literal(true).optional(),
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
          // offered only with a use left, spent once picked, as Inspiring Smite's Channel Divinity
          resource: z.string().min(1).optional(),
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
    allies: AlliesRiderSchema.optional(), // on the caster's allies near it, as Unicorn Spirit's healing
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
    allies: AlliesRiderSchema.optional(), // effects on the bearer's allies near it, as Rallying Cry's
  }),
  // The Bardic Inspiration dice the bearer gives can go to AC against a hit or to a hit's damage, as Combat
  // Inspiration (combat/reactions.ts inspiredSwing, combat/attack.ts).
  z.strictObject({ kind: z.literal("combatInspiration") }),
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
  // No Disadvantage on a check to influence a Hostile creature, as Boon of Communication's Cunning Speaker, or only on
  // checks with these skills, as Street Justice's Tough Talk with Intimidation.
  z.strictObject({
    kind: z.literal("cunningSpeaker"),
    skills: z.array(SkillSchema).min(1).optional(),
  }),
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
  // Training with Martial weapons, as Battle Ready's Weapon Knowledge: only ranged or melee ones, and none with a
  // property in `without`, as a Bladesinger's Melee Martial weapons that aren't Two-Handed or Heavy (stats.ts).
  z.strictObject({
    kind: z.literal("martialTraining"),
    ranged: z.literal(true).optional(),
    melee: z.literal(true).optional(),
    without: z.array(WeaponPropertySchema).min(1).optional(),
  }),
  // Proficiency with these kinds of weapons, by the id's name after the plugin, as College of Swords' scimitar.
  z.strictObject({
    kind: z.literal("weaponTraining"),
    weapons: z.array(z.string().min(1)).min(1),
  }),
  // Training with these armor types, as Forge Domain's Heavy armor (stats.ts).
  z.strictObject({
    kind: z.literal("armorTraining"),
    armor: z.array(z.enum(["light", "medium", "heavy", "shield"])).min(1),
  }),
  // Proficiency in these skills, and with `expertise` Expertise in them too, as Survivalist's Nature and Survival.
  z.strictObject({
    kind: z.literal("skillProficiency"),
    skills: z.array(SkillSchema).min(1),
    expertise: z.literal(true).optional(),
  }),
  // Checks with these skills can use this ability instead, when it's better, while an effect of one of `while`'s
  // features is on the bearer, as Primal Knowledge's Strength in a Rage (actions.ts abilityCheck).
  z.strictObject({
    kind: z.literal("checkAbility"),
    ability: AbilitySchema,
    skills: z.array(SkillSchema).min(1),
    while: z.array(ContentIdSchema).min(1).optional(),
  }),
  // As a fight starts, while `resource` lasts, it spends one and gives Heroic Inspiration to as many of the party as
  // its Proficiency Bonus, as Purple Dragon Rook's Rallying Cry (combat/start.ts).
  // shortcut: the bearer and those without Heroic Inspiration first, all within 30 feet as a party starts together.
  z.strictObject({
    kind: z.literal("initiativeRally"),
    resource: z.string().min(1),
  }),
  // These scores rise by `amount`, to at most `max`, as Primal Champion's Strength and Constitution (stats.ts).
  z.strictObject({
    kind: z.literal("scoreIncrease"),
    abilities: z.array(AbilitySchema).min(1),
    amount: z.number().int().min(1),
    max: z.number().int().min(1).max(30),
  }),
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
