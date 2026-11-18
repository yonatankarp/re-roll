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
    // only attackers of these lowercase types, which save against `save` (its DC from the effect's caster) or have
    // `condition` until the end of their next turn, as Holy Aura's Blinded on a Fiend or an Undead
    creatureTypes: z.array(z.string()).min(1).optional(),
    save: z
      .strictObject({ ability: AbilitySchema, dc: FormulaSchema })
      .optional(),
    condition: ConditionSchema.optional(),
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
  // Can't gain this condition while it lasts, as Lordly Resolve's bolstered targets, or with `creatureTypes` only from
  // creatures of these lowercase types, as Protection from Evil and Good's.
  z.strictObject({
    kind: z.literal("conditionImmunity"),
    condition: ConditionSchema,
    creatureTypes: z.array(z.string()).min(1).optional(),
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
    noDash: z.literal(true).optional(), // it can't take the Dash action, as Uncertain Footing's
    oneAttack: z.literal(true).optional(),
    speed: z.enum(["half", "double", "none"]).optional(),
    spellFailure: z.number().int().min(1).max(100).optional(),
    noSpells: z.literal(true).optional(), // it can't cast spells, as Befuddlement's
    noAttacks: z.literal(true).optional(), // it can't attack, as in Gaseous Form
    dodgeOnly: z.literal(true).optional(), // its only action is Dodge, as an uncommanded Steel Defender's
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
  // With `terrainOnly` it's only the Difficult Terrain, as Speedy's Dash over it, and with `ice` only Difficult
  // Terrain of ice or snow, as Boots of the Winterlands' Winter Strider.
  z.strictObject({
    kind: z.literal("unhindered"),
    terrainOnly: z.literal(true).optional(),
    ice: z.literal(true).optional(),
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
  // Disengage as a Bonus Action, as Conjure Woodland Beings gives.
  z.strictObject({ kind: z.literal("bonusDisengage") }),
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
  // A lasting companion its owner commanded this turn, which may take more than the Dodge action.
  z.strictObject({ kind: z.literal("commanded") }),
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
  // While it lasts, the bearer turns spells as the Spell Turning passive does, as Holy Star of Mystra's mote: only
  // the deflection with `deflectOnly` (combat/effects.ts).
  z.strictObject({
    kind: z.literal("spellTurning"),
    upTo: z.number().int().min(1).max(9),
    deflect: z.literal(true).optional(),
    deflectOnly: z.literal(true).optional(),
  }),
  // The bearer has at least Half Cover against everything, as Bulwark of Force's or Smite of Protection's (sight.ts).
  z.strictObject({ kind: z.literal("halfCover") }),
  // A save for half damage the bearer makes with Dexterity deals none on a success and half on a failure, as Evasion,
  // given by an area, as Aura of Evasion's (trait-rules.ts evades).
  // Its own `anySave` and `magical` cover every save, or only saves against magic, as Elminster's Elusion.
  z.strictObject({
    kind: z.literal("evasion"),
    anySave: z.literal(true).optional(),
    magical: z.literal(true).optional(),
  }),
  // The bearer's Hit Point maximum can't be reduced, as in Aura of Life (combat/effects.ts).
  z.strictObject({ kind: z.literal("keepMaxHp") }),
  // Advantage on Death Saving Throws, as an Exalted Champion's allies near it (combat/actions.ts).
  z.strictObject({ kind: z.literal("deathSaveAdvantage") }),
  // A Bardic Inspiration die the bearer holds, its size the giver's, spent once where it turns a roll
  // (combat/reactions.ts inspiredSwing): added to a failed D20 test it makes a success, and with the giver's
  // `combatInspiration`, to AC against a hit it makes a miss for the bearer's Reaction, or to a hit's damage.
  z.strictObject({ kind: z.literal("inspired"), amount: AmountSchema }),
  // Healing the bearer regains its dice's highest numbers, as Beacon of Hope's (combat/effects.ts).
  z.strictObject({ kind: z.literal("healedMax") }),
  // As each of the bearer's turns starts it gains these Temporary Hit Points, worked out from its caster's numbers, as
  // Heroism's spellcasting modifier (combat/turn.ts).
  z.strictObject({ kind: z.literal("turnTempHp"), amount: AmountSchema }),
  // At the end of each of its turns the bearer rolls a d6, and on a 4 or more it's shut away (`sealed`) until its next
  // turn starts, as Blink's Ethereal Plane (combat/turn.ts).
  z.strictObject({ kind: z.literal("blink") }),
  // Each time the bearer takes damage, its caster takes as much, as Warding Bond's (combat/effects.ts).
  z.strictObject({ kind: z.literal("bonded") }),
  // The bearer loses any Resistance to this type, and the first time each turn it takes damage of it, it takes
  // `amount` more, as Elemental Bane's (combat/effects.ts, stats.ts).
  z.strictObject({
    kind: z.literal("bane"),
    damage: DamageTypeSchema,
    amount: AmountSchema,
  }),
  // A ward of `count` dice of `die`: when the bearer takes damage, as many as the damage needs are spent and rolled,
  // and it takes that much less, as Bastion of Law's d8s (combat/effects.ts reducedHit).
  z.strictObject({
    kind: z.literal("wardDice"),
    count: z.number().int().min(1),
    die: z.number().int().min(2),
  }),
  // Levels of Exhaustion that last only while the effect does, as Sickening Radiance's (stats.ts exhaustionOf).
  z.strictObject({
    kind: z.literal("exhausted"),
    levels: z.number().int().min(1).max(6),
    upTo: z.number().int().min(1).max(6).optional(), // it never takes the total past this, as Waves of Exhaustion's 4
  }),
]);
export type Modifier = z.infer<typeof ModifierSchema>;
