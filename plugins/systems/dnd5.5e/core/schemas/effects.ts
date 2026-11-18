import { ContentIdSchema } from "#sdk";
import { z } from "zod";
import {
  AbilitySchema,
  ConditionSchema,
  CreatureTypeSchema,
  DamageTypeSchema,
  SkillSchema,
} from "./basics.ts";
import {
  AmountSchema,
  DamageSchema,
  DiceSchema,
  FormulaSchema,
  SizeSchema,
  WeaponChangeSchema,
} from "./dice.ts";
import { ModifierSchema } from "./modifiers.ts";

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
  // Lightly Obscured, as Web's strands: seen only dimly however bright (core/sight.ts seeing).
  "haze",
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
  // With `item`, that item's instead of the source's own, as a Charm of Vitality's Potion of Vitality (#192).
  z.strictObject({
    kind: z.literal("untilLongRest"),
    item: ContentIdSchema.optional(),
  }),
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
        free: z.literal(true).optional(), // the action frees it with no check, as pulling free of Transmute Rock's mud
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
    casterIncapacitated: z.literal(true).optional(), // as a modifier's
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
    endsOn: z.enum(["attack", "action", "spell"]).optional(), // as an applyCondition's, as Sanctuary's
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
    // it ends once its caster is Incapacitated or dies, as Bulwark of Force's Half Cover (combat/turn.ts)
    casterIncapacitated: z.literal(true).optional(),
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
    // from the spell's object instead of the caster, as Grasping Vine's pull toward the vine (combat/anchor.ts)
    fromObject: z.literal(true).optional(),
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
    // it does what its activation's `areas` entry of this index says instead of its `area`
    part: z.number().int().min(0).optional(),
    // its shape when not round: "ring" the squares `radius` away (a wall's own space, as Blade Barrier's ring), "line"
    // a line `radius` long and `width` wide from its caster toward the point aimed at, as Wall of Sand or Gust of Wind
    shape: z.enum(["ring", "line"]).optional(),
    width: z.number().int().min(5).optional(),
    // this radius instead while its caster has this feature, as Aquatic Affinity's 10-foot Wrath of the Sea
    wider: z
      .strictObject({
        feature: ContentIdSchema,
        radius: z.number().int().min(5),
      })
      .optional(),
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
        // only these stat blocks, whatever their Challenge Rating, as the Apparatus of Kwalish its pilot drives
        ids: z.array(ContentIdSchema).min(1).optional(),
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
    // a 20 on its own side's roll and a 1 on a foe's, as Moment of Prescience
    extreme: z.literal(true).optional(),
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
  // A target in a shape not its own, by a spell or its own trait, goes back to its true form, as Moonbeam's light
  // forces (combat/effects.ts).
  z.strictObject({ kind: z.literal("revertShape") }),
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
  // The caster's lasting companions may take an action on their next turn, as with a Bonus Action to command a Steel
  // Defender (combat/companions.ts).
  z.strictObject({ kind: z.literal("commandCompanion") }),
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
  // With `immune`, Immunity instead, as Primordial Ward's.
  z.strictObject({
    kind: z.literal("resistTrigger"),
    immune: z.literal(true).optional(),
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
    // it stays between fights as its caster's lasting companion, until it dies or a new one replaces it, as Find
    // Steed's steed (combat/companions.ts)
    lasting: z.literal(true).optional(),
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
    // it stays between fights as its maker's lasting companion, as Find Greater Steed's mount (combat/companions.ts)
    lasting: z.literal(true).optional(),
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
// Effects on the bearer's allies within `within` feet, whatever an activation's targets, as Rallying Cry's healing
// with Second Wind: the `count` most hurt of them (all when left out). With `resource` it spends a use and does nothing
// without one, as Group Recovery's once a Short Rest; never while the bearer has one of `without`, as Group Recovery's
// 30 feet once Inspiring Commander's 60 take their place; `with` adds effects while it has that feature, as Team
// Tactics' Advantage (combat/actions.ts).
export const AlliesRiderSchema = z.strictObject({
  within: z.number().int().min(5),
  count: FormulaSchema.optional(),
  effects: z.array(LeafEffectSchema).min(1),
  resource: z.string().min(1).optional(),
  without: z.array(ContentIdSchema).min(1).optional(),
  with: z
    .array(
      z.strictObject({
        feature: ContentIdSchema,
        effects: z.array(LeafEffectSchema).min(1),
      }),
    )
    .min(1)
    .optional(),
});
export type AlliesRider = z.infer<typeof AlliesRiderSchema>;

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
    // Fissures open under `count` of the foes caught (the caster's choice: the healthiest), each making the same save
    // again or falling `depth` feet into one, as Earthquake's (combat/effects.ts)
    fissure: z
      .strictObject({
        count: z.union([z.number().int().min(1), DiceSchema]),
        depth: z.union([
          z.number().int().min(10),
          z.strictObject({ dice: DiceSchema, times: z.number().int().min(1) }),
        ]),
      })
      .optional(),
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
  downed: z.literal(true).optional(), // its `when` resolution only on creatures at 0 Hit Points, as Aura of Life's
  frightened: z.literal(true).optional(), // only on creatures its owner has Frightened, as Aura of Conquest
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
  // a spell cast in it fails and is wasted unless the caster makes this save, as a haunting revenant's Haunted Zone,
  // against the zone's caster's spell save DC as cast when `dc` is left out, as Spellfire Storm's
  foilsSpells: z
    .strictObject({
      ability: AbilitySchema,
      dc: z.number().int().min(1).optional(),
    })
    .optional(),
  // Difficult Terrain on the ground, which a flyer crosses freely, as Grease's or Entangle's; "ice" is ice or snow, as
  // Sleet Storm's, which Boots of the Winterlands ignore (core/sight.ts difficultSquares)
  terrain: z.enum(["ground", "ice"]).optional(),
  // each foot moved in it costs this many feet, as Plant Growth's 4 (core/combat/queries.ts groundFor)
  cost: z.number().int().min(3).max(4).optional(),
  // each foot moved in it toward its owner costs 2, as against Gust of Wind's blast
  headwind: z.literal(true).optional(),
  // modifiers those it affects have while in it, as Grasping Mist's Speed 5 feet lower (core/zones.ts)
  places: z.array(ModifierSchema).min(1).optional(),
  // it acts this many times in all (each creature it acts on counts one), then ends, as Cordon of Arrows' four
  // pieces of ammunition, with `usesPerSlot` more for each slot level above the spell's
  uses: z.number().int().min(1).optional(),
  usesPerSlot: z.number().int().min(1).optional(),
  // it burns away once fire damage is dealt to a creature in it, dealing this to each creature in it, as Web's
  // flammable strands (combat/areas.ts)
  burns: z.array(DamageSchema).min(1).optional(),
  // its squares give cover to a creature behind them, as Blade Barrier's Three-Quarters Cover (core/sight.ts)
  cover: z.enum(["half", "threeQuarters"]).optional(),
  // ranged weapon attacks that pass into, out of or through it miss, as past Wind Wall, or have Disadvantage, as
  // through Wall of Water (combat/attack.ts)
  deflects: z.enum(["miss", "disadvantage"]).optional(),
  // its resolution acts only on creatures flying in it, as Control Winds' downdraft, or with `ground` only on those on
  // the ground, as Earthquake's tremor
  flying: z.literal(true).optional(),
  ground: z.literal(true).optional(),
  // a foe that dies in it fills one of its spell's `spheres`, as Spirit Lantern's Dim Light gathers soul fragments
  gathers: z.literal(true).optional(),
  // it acts on those in it as it appears, as Conjure Celestial's light shines on each creature it's cast over
  appears: z.literal(true).optional(),
  // it acts on a creature its owner moves it onto, and stops there for the turn, as Flaming Sphere rolled into a foe
  whenMoved: z.literal(true).optional(),
  // the creatures it holds with a condition move with it, as Whirlwind's
  carries: z.literal(true).optional(),
  // as its owner's turn starts, it acts with the next of these each time instead of `resolution`, the last
  // repeating, as Storm of Vengeance's turns (combat/areas.ts)
  schedule: z.array(ResolutionSchema).min(1).optional(),
  // its owner-turn resolution picks the most hurt it affects first, as Aura of Vitality's healing
  mostHurt: z.literal(true).optional(),
  // its `uses` gain the caster's spellcasting modifier, at least `usesAtLeast` in all, as Healing Spirit's
  usesMod: z.literal(true).optional(),
  usesAtLeast: z.number().int().min(1).optional(),
  // a fall that ends in it deals half damage, as in Control Winds' updraft (combat/falling.ts)
  softFalls: z.literal(true).optional(),
  // no fog, smoke or other gas hides a square in it, as Warding Wind hedges them out (core/zones.ts obscuring)
  clearsFog: z.literal(true).optional(),
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

export const CostSchema = z.union([
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
      // "wall": a line `radius` long across the way to the point aimed at, centred there, as Wall of Sand's, and
      // "ring" the squares `radius` from it, a ring wall's own space, as Wall of Fire's
      shape: z.enum([
        "sphere",
        "cone",
        "cube",
        "line",
        "emanation",
        "wall",
        "ring",
      ]),
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
