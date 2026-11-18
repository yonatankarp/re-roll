import { ContentIdSchema, type Frame, type SystemEvent } from "#sdk";
import { z } from "zod";
import {
  AbilitySchema,
  type CharacterBuild,
  CharacterBuildSchema,
  ConditionSchema,
  DamageSchema,
  DamageTypeSchema,
  AreaEffectSchema,
  LootSchema,
  ModifierSchema,
  PassiveSchema,
  ResolutionSchema,
  ZoneKindSchema,
} from "./schemas.ts";
import { settleForms } from "./forms.ts";

export const NS = "dnd5.5e";

// Every frame kind the plugin registers, without its namespace. Saves store them, so none is ever renamed;
// a test checks this list against the handlers index.ts registers.
export const FRAME_KINDS = [
  "advanceParty",
  "advanceTurn",
  "afterAction",
  "afterHit",
  "afterMove",
  "afterReaction",
  "afterTurnStart",
  "aimArea",
  "applyHit",
  "attackRoll",
  "buildAnswer",
  "buildStep",
  "characterChosen",
  "checkCombatEnd",
  "companionsSpend",
  "concentrationSave",
  "chooseForm",
  "counterspell",
  "endTurn",
  "escape",
  "finishMove",
  "finishRest",
  "finishTurn",
  "gearAnswer",
  "gearStep",
  "inspiration",
  "lairAction",
  "lairTurn",
  "legendaryAction",
  "legendaryTurn",
  "lingeringTick",
  "sunlightTick",
  "damageBurst",
  "masteryHit",
  "masteryMiss",
  "metamagic",
  "metamagicSpent",
  "move",
  "pickTargets",
  "precision",
  "fall",
  "changeHeight",
  "projectile",
  "react",
  "reactAnswer",
  "recheckHit",
  "rollReaction",
  "shopAnswer",
  "shopStep",
  "shortRestAnswer",
  "shortRestStep",
  "sheetAnswer",
  "sheetStep",
  "smite",
  "strikeChosen",
  "missRider",
  "advantageForgone",
  "advantageGained",
  "swapInitiative",
  "takeAction",
  "teleport",
  "throwWeapon",
  "swapStep",
  "swapAnswer",
  "useAction",
  "useItem",
  "castCheck",
  "zoneTick",
  "chooseDamageType",
  "chooseZoneType",
  "replaceHit",
  "confusedTurn",
  "fleeTurn",
  "chooseOption",
  "copySpell",
  "wallLayer",
  "chooseShape",
  "chooseFocus",
  "castOn", // whom a spell or feature used between fights goes to (camp.ts)
  "applyMiss", // what an attack does on a miss, as Acid Arrow's splash (combat/spell-riders.ts)
  "burst", // a save round an attack's target, hit or miss, as Ice Knife's (combat/spell-riders.ts)
  "initiativeMove", // a move right after Initiative, as Unpredictable Movement's (combat/reactions.ts)
  "givenDice", // the player spends Hit Dice a spell's Short Rest gave them (rest.ts)
  "givenDiceAnswer",
  "reincarnate", // the player picks what a reincarnated body's species asks for (reincarnate.ts)
  "reincarnateAnswer",
  "missReroll", // a missed attack rolled again, or at another creature, as Master Duelist or Curving Shot (class-rules.ts)
  "bringAlong", // the allies a teleport brings land beside it, as Travel along the Tree's (combat/movement.ts)
  "riderChoice", // what a spell's cast rider does, picked once it's done, as Steps of the Fey's (combat/school.ts)
  "redirectHit", // where a missed attack lands instead, as Tipsy Sway's Redirect Attack (combat/reactions.ts)
  "hideNow", // the Hide action as part of another, as Shrouding Spells' (actions.ts)
] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

export function frame(kind: FrameKind, payload: Frame["payload"] = {}): Frame {
  return { kind: `${NS}:${kind}`, payload };
}
export const LEGENDARY_USE = "legendary";
export const PICKED_UP = "pickedUp"; // in usedThisTurn: the one free pick-up of a turn
export const CAST_ACTION = "castAction"; // in usedThisTurn: a spell with a casting time of an action was cast
export const SURGED = "surged"; // in usedThisTurn: Action Surge's extra action, which can't be a Magic action
// In usedThisTurn, kept only for a creature with an activation that waits on them (combat/actions.ts): the Attack
// action taken, the Magic action (a spell cast with an action, or a magic item used) taken, a spell cast with an action
// and a slot, and a spell of level 1 or higher cast.
export const ATTACK_ACTION = "attackAction";
export const MAGIC_ACTION = "magicAction";
export const SLOT_CAST_ACTION = "slotCastAction";
export const LEVELED_CAST = "leveledCast";
export const LEGENDARY_RESISTANCE = "legendaryResistance";

export const TACTICS = [
  "dodge",
  "disengage",
  "dash",
  "hidden",
  "ready",
  "slowed",
  "metamagic", // a Metamagic option waiting for its spell, or Extended Spell's hold on Concentration (metamagic.ts)
  "exiting", // the feet of movement climbing out of a dead swallower still costs (combat/swallow.ts)
  "trading", // attacks of the Attack action readied to trade for a spell; `value` the passive's place (combat/trade.ts)
  "attacksLeft", // the Attack action's attacks left after that trade, its `value` (combat/trade.ts)
] as const;

const EndsSchema = z.enum([
  "concentration",
  "casterNextTurn",
  "casterNextTurnEnd",
  "casterTurnEnd",
  "spellDuration",
]);

// A spell stored in an item, as cast into a Ring of Spell Storing: its slot level and its caster's numbers.
const StoredSpellSchema = z.strictObject({
  spell: z.string(),
  level: z.number().int().min(1).max(9),
  dc: z.number().int(),
  attack: z.number().int(),
  mod: z.number().int(),
});
export type StoredSpell = z.infer<typeof StoredSpellSchema>;

const ActiveEffectSchema = z.strictObject({
  sourceId: z.string(),
  casterId: z.string(),
  modifier: z.union([
    ModifierSchema,
    z.strictObject({
      kind: z.literal("condition"),
      condition: ConditionSchema,
    }),
    // Haste's lethargy, waiting for the spell to end (combat/durations.ts).
    z.strictObject({ kind: z.literal("lethargy") }),
    // Gone berserk, as a flesh golem's Berserk, until it's no longer Bloodied (combat/madness.ts).
    z.strictObject({ kind: z.literal("berserk") }),
    // Conscious at 0 Hit Points while it lasts; with `delayDeath`, three Death Saving Throw failures kill only once it
    // ends, as Rage beyond Death (combat/effects.ts fightOnEvents).
    z.strictObject({
      kind: z.literal("fightingOn"),
      delayDeath: z.literal(true).optional(),
    }),
    // Time Stop: the turns in a row its caster has left, as rolled (combat/durations.ts).
    z.strictObject({ kind: z.literal("extraTurns"), turns: z.number().int() }),
    // Another creature's shape, by its stat block (core/forms.ts).
    z.strictObject({
      kind: z.literal("form"),
      monster: ContentIdSchema,
      keep: z.array(z.enum(["mind", "spells"])).optional(), // what it keeps of its own (stats.ts)
    }),
    // Riding its caster as a mount (combat/mounts.ts).
    z.strictObject({ kind: z.literal("riding") }),
    // Carrying a willing ally along as it moves this turn, as Heightened Focus's Step of the Wind (combat/movement.ts).
    z.strictObject({ kind: z.literal("carrying"), actor: z.string() }),
    // One of its own stat block's other shapes, by name, as a werewolf's wolf form (core/forms.ts).
    z.strictObject({ kind: z.literal("shape"), shape: z.string() }),
    // An area a spell left on the map, kept on its caster (core/zones.ts). With `follows` it is centred on the
    // caster wherever it goes; `area` is what it does, with its save DC as cast; `blocks` are a wall's squares.
    z.strictObject({
      kind: z.literal("zone"),
      zone: ZoneKindSchema,
      at: z.strictObject({ x: z.number().int(), y: z.number().int() }),
      radius: z.number().int(),
      damage: z.array(DamageSchema).optional(),
      follows: z.literal(true).optional(),
      area: AreaEffectSchema.optional(),
      blocks: z.array(z.string()).optional(),
      walls: z.enum(["walking", "sight"]).optional(), // what alone its wall stops, when not both
      layers: z.array(ResolutionSchema).optional(), // what walking into its wall does, in order, its DCs as cast
      name: z.string().optional(), // the action that left it
      dim: z.number().int().optional(), // light: feet of Dim Light beyond its Bright
      ownerSees: z.literal(true).optional(), // darkness its caster sees through
      reveals: z.literal(true).optional(), // light: no benefit from the Invisible condition in its Bright Light
    }),
    // What an action anyone can take, such as Dodge, or a weapon mastery, leaves behind (core/tactics.ts).
    z.strictObject({
      kind: z.literal("tactic"),
      tactic: z.enum(TACTICS),
      value: z.number().int().optional(), // hidden: the Stealth total a Search must beat
      action: z.string().optional(), // ready: the attack it makes; metamagic: the spell it changes
    }),
  ]),
  // "casterNextTurnEnd" becomes "casterTurnEnd" when the caster's next turn starts, and ends with that turn.
  ends: EndsSchema,
  // When it runs out, counted in rounds: at the start or end of `actor`'s turn in `round`, or once a later round
  // begins if that turn never comes (combat/durations.ts). Missing in older saves, whose timed effects lasted the fight.
  lasts: z
    .strictObject({
      actor: z.string(),
      round: z.number().int(),
      at: z.enum(["start", "end"]),
    })
    .optional(),
  repeatSave: z
    .strictObject({ ability: AbilitySchema, dc: z.number().int() })
    .optional(),
  endsOnDamage: z.boolean().optional(),
  endsWithTempHp: z.boolean().optional(), // ends once damage leaves the creature no Temporary Hit Points
  endsOnSpell: z.boolean().optional(), // ends when another spell targets the creature
  // ends when the creature attacks or deals damage, also when it casts a spell, or when it acts
  endsOn: z.enum(["attack", "action", "spell"]).optional(),
  endsInLight: z.literal(true).optional(), // ends as the creature's turn ends in Bright Light
  untilIncapacitated: z.literal(true).optional(), // ends once the creature is Incapacitated
  // Taking damage gives this save, ending it on a success, as Dragon Fear's.
  saveOnDamage: z
    .strictObject({
      ability: AbilitySchema,
      dc: z.number().int(),
      advantage: z.literal(true).optional(), // rolled with Advantage, as Hideous Laughter's
    })
    .optional(),
  // As an applyCondition's (core/schemas.ts): fleeing the caster on its turns, ended by another's action, Prone it
  // can't end, saved against with its action, Exhaustion on a failed repeat save, and ended only after a save.
  flee: z
    .strictObject({
      unseen: z.literal(true).optional(),
      far: z.number().int().optional(),
      casterDown: z.literal(true).optional(),
    })
    .optional(),
  shake: z.literal(true).optional(),
  cantStand: z.literal(true).optional(),
  actionSave: z.literal(true).optional(),
  failExhaustion: z.literal(true).optional(),
  clings: z
    .strictObject({ ability: AbilitySchema, dc: z.number().int() })
    .optional(),
  // Hours it outlasts a fight by, counted down by rests, "cured" for one that lasts until magic ends it (rest.ts), or
  // "longRest" for one that lasts through fights and scenes until a Long Rest, as Blessing of the Trickster. Missing
  // for an effect that ends with the fight. Cast between fights (camp.ts), 0 lasts until the next scene.
  lingers: z
    .union([z.number().int(), z.literal("cured"), z.literal("longRest")])
    .optional(),
  level: z.number().int().optional(), // the slot a spell was cast with, when it was given one
  // Inside its caster, as swallowed (combat/swallow.ts): what took the creature out of a grapple and into itself.
  swallowed: z.boolean().optional(),
  // The condition a failed repeat save leaves instead of this one (combat/turn.ts).
  secondFailure: z
    .strictObject({
      condition: ConditionSchema,
      ends: EndsSchema,
      endsOnDamage: z.boolean().optional(),
      count: z.number().int().optional(), // saves of a kind it takes, as Prismatic Spray's indigo ray
    })
    .optional(),
  tally: z
    .strictObject({ saved: z.number().int(), failed: z.number().int() })
    .optional(), // the repeat saves made so far, toward secondFailure's count
  // A save as its caster's next turn starts, whose failure sends the creature away (combat/turn.ts).
  banish: z
    .strictObject({ ability: AbilitySchema, dc: z.number().int() })
    .optional(),
});
export type ActiveEffect = z.infer<typeof ActiveEffectSchema>;

// A disease caught (environment.ts): Long Rests left before its symptoms, and its saves so far.
const DiseaseRecordSchema = z.strictObject({
  disease: ContentIdSchema,
  onset: z.number().int().min(0),
  saved: z.number().int().default(0),
  failed: z.number().int().default(0),
  streak: z.number().int().default(0), // successes in a row
  dc: z.number().int().optional(), // a DC lowered by its saves, as 2014 Cackle Fever's
  penalty: z.number().int().optional(), // 2014 Sight Rot's growing penalty
});
export type DiseaseRecord = z.infer<typeof DiseaseRecordSchema>;

// What the environmental effects a fight is fought in do there (environment.ts): their ids, and what they make of
// the fight, as worked out when it starts.
export const FightEnvironmentSchema = z.strictObject({
  ids: z.array(ContentIdSchema),
  difficult: z.literal(true).optional(),
  deadMagic: z.literal(true).optional(),
  grounded: z.literal(true).optional(),
  halfFalls: z.literal(true).optional(),
  forceFloor: z.number().int().optional(),
  halfDurations: z.literal(true).optional(),
  turnSave: z
    .strictObject({
      ability: AbilitySchema,
      dc: z.number().int(),
      condition: ConditionSchema,
    })
    .optional(),
  reverseGravity: z.strictObject({ dc: z.number().int() }).optional(),
});
export type FightEnvironment = z.infer<typeof FightEnvironmentSchema>;

const SquareSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
});
const DroppedSchema = z.strictObject({
  item: ContentIdSchema,
  at: SquareSchema,
  by: z.string(), // who threw it
});
const GridSchema = z.strictObject({
  width: z.number().int(),
  height: z.number().int(),
});
const SecondTurnSchema = z.strictObject({
  actor: z.string(),
  before: z.string().nullable(),
});

// Whose turn it is: a creature taking a second turn between others', or the one the order is at.
export function turnId(
  combat:
    | {
        readonly order: readonly string[];
        readonly index: number;
        readonly interlude?: { readonly actor: string } | undefined;
      }
    | null
    | undefined,
): string | undefined {
  return combat
    ? (combat.interlude?.actor ?? combat.order[combat.index])
    : undefined;
}

// A battle map's ground, cover and light, as "x,y" squares. Missing in fights on plain maps and older saves.
export const TerrainSchema = z.strictObject({
  difficult: z.array(z.string()),
  half: z.array(z.string()), // half cover
  threeQuarters: z.array(z.string()),
  dim: z.array(z.string()),
  dark: z.array(z.string()),
  light: z.enum(["bright", "dim", "dark"]), // everywhere else
  // water to swim in, each foot costing double without a Swim Speed (core/combat/queries.ts). Missing in older saves.
  water: z.array(z.string()).optional(),
});
export type Terrain = z.infer<typeof TerrainSchema>;
// The picture a fight is drawn on, when its encounter has a battle map.
const FightMapSchema = z.strictObject({
  image: z.string(),
  imageWidth: z.number().int(),
  imageHeight: z.number().int(),
  crop: z.strictObject({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  }),
});

const ActorSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  side: z.enum(["party", "enemy"]),
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("character"),
      build: CharacterBuildSchema.nullable(), // null until the player has chosen
    }),
    z.strictObject({
      kind: z.literal("monster"),
      statBlockId: ContentIdSchema,
      // the creature that animated, raised or called it, so it dies at 0 Hit Points as a monster does
      calledBy: z.string().optional(),
      // A character's familiar in a fight (combat/familiar.ts): its owner, its Hit Point maximum as found, the
      // owner's features that give it something, and the owner's numbers those read, such as its spell save DC.
      familiarOf: z
        .strictObject({
          owner: z.string(),
          maxHp: z.number().int(),
          features: z.array(ContentIdSchema),
          scaling: z.record(z.string(), z.number().int()),
        })
        .optional(),
      lacks: z.array(z.string()).optional(), // actions it was made without, as an animated tree's Animate Trees
    }),
    // A creature a spell brought, by a companion stat block (stats.ts), with its caster's numbers as cast.
    z.strictObject({
      kind: z.literal("summon"),
      companion: ContentIdSchema,
      level: z.number().int(), // the spell's level, which its numbers grow with
      casterId: z.string(),
      sourceId: z.string(), // the spell, which it lasts as long as
      concentration: z.boolean(), // it vanishes when the caster stops concentrating on the spell
      proficiency: z.number().int(), // the caster's
      spellAttack: z.number().int(), // the caster's spell attack bonus
      spellDc: z.number().int(), // the caster's spell save DC
    }),
  ]),
  hp: z.number().int(),
  tempHp: z.number().int(),
  deathSaves: z.strictObject({
    successes: z.number().int(),
    failures: z.number().int(),
  }),
  exhaustion: z.number().int(),
  heroicInspiration: z.boolean(),
  budget: z.strictObject({
    action: z.boolean(),
    bonusAction: z.boolean(),
    reaction: z.boolean(),
  }),
  usedThisTurn: z.array(z.string()),
  resourcesSpent: z.record(z.string(), z.number().int()),
  activeEffects: z.array(ActiveEffectSchema),
  // Spell and item effects held off while it stands in an Antimagic Field, its magic items' powers with them
  // (zones.ts). Missing outside one.
  suppressed: z.array(ActiveEffectSchema).optional(),
  concentratingOn: z.string().nullable(),
  inventory: z.array(ContentIdSchema),
  // Copies in `inventory` carried in the pack rather than worn or wielded. Missing in older saves, where all is worn.
  stowed: z.array(ContentIdSchema).optional(),
  attuned: z.array(ContentIdSchema).optional(), // magic items attuned to, at most MAX_ATTUNED
  // Ability scores raised for good, as by studying a Manual of Bodily Health. Missing when none has been.
  raised: z.partialRecord(AbilitySchema, z.number().int()).optional(),
  xp: z.number().int().optional(), // only the player's is tracked, and the party levels together
  // Where the creature stands in a fight, null outside one. Saves from before the grid have none.
  position: SquareSchema.nullable().default(null),
  moved: z.number().int().default(0), // feet moved this turn
  // Build answers picked again after a Long Rest, by "<level>:<answer>" index (swap.ts), and those changed since the
  // last one. Missing until a first swap.
  swaps: z.record(z.string(), z.array(z.string())).optional(),
  swapped: z.array(z.string()).optional(),
  // Damage taken this turn from creatures it has swallowed. Missing until there is some.
  insideDamage: z.number().int().optional(),
  // Hit Point maximum lost until a Long Rest, as to Harm. Missing until some is.
  maxHpLoss: z.number().int().optional(),
  // The character's familiar between fights: its form and Hit Points, 0 once it has dropped until it is found
  // again. Missing until it is first found.
  familiar: z
    .strictObject({
      form: ContentIdSchema,
      hp: z.number().int(),
      maxHp: z.number().int(),
    })
    .optional(),
  // Taken off its D20 Tests after coming back from the dead, one less each Long Rest, as Raise Dead's. Missing at 0.
  ordeal: z.number().int().optional(),
  // Passives kept until the next Long Rest, as a Potion of Vitality's, by what gave them.
  restPassives: z
    .array(
      z.strictObject({ source: z.string(), passives: z.array(PassiveSchema) }),
    )
    .optional(),
  // The skill picked for an item that lets its bearer pick one, by the item's id, as an Arcanist's Bestiary's.
  itemSkills: z.record(z.string(), z.string()).optional(),
  // What a pool's `rolled` dice came to, by its id, as a Necklace of Fireballs' beads (ResourceDefSchema).
  rolledPools: z.record(z.string(), z.number().int()).optional(),
  // Spells stored in an item carried, by the item's id, with the numbers they were cast with (MagicItemSchema
  // `storesSpells`).
  storedSpells: z.record(z.string(), z.array(StoredSpellSchema)).optional(),
  // Hours a dead party member has lain dead, counted by the rests passed since, for a raising's time limit. Missing
  // while alive or just dead. `reposed` stops the count, as Gentle Repose does.
  deadHours: z.number().int().optional(),
  reposed: z.literal(true).optional(),
  dust: z.literal(true).optional(), // turned to dust, as by Disintegrate: only True Resurrection or Wish raises it
  deadRounds: z.number().int().optional(), // rounds of a fight it has lain dead, for Revivify's minute
  // A new body of another species, as Reincarnate gives: the old species' picks it lost and the new one's.
  reincarnated: z
    .strictObject({
      species: ContentIdSchema,
      drop: z.array(z.string()),
      answers: CharacterBuildSchema.shape.levels.element.shape.answers,
    })
    .optional(),
  // Days until a clone of it is ready, 0 once it is (Clone). Missing without one.
  clone: z.number().int().min(0).optional(),
  // The diseases it has caught (environment.ts). Missing while it has none.
  diseases: z.array(DiseaseRecordSchema).optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const DIFFICULTIES = ["story", "normal", "hard"] as const;

const SurpriseSchema = z.enum(["party", "enemies"]);
// A fight in a monster's lair. Lair actions come just before the turn at `at` in the order: initiative 20, losing ties.
const LairSchema = z.strictObject({ at: z.number().int() });
export const MAX_ATTUNED = 3;

export const StateSchema = z.strictObject({
  // Chosen when the game starts. Missing in saves from before there was a choice, which played as normal.
  difficulty: z.enum(DIFFICULTIES).optional(),
  // The variant rules the run plays (variant-rules.ts), chosen when it starts. Missing when it plays none.
  variantRules: z.array(ContentIdSchema).optional(),
  gold: z.number().min(0).optional(), // the party's coins, in gold pieces, with copper as hundredths
  // What each merchant has sold, by name, so limited stock stays sold on a later visit.
  shopBought: z.record(z.string(), z.array(ContentIdSchema)).optional(),
  actors: z.record(z.string(), ActorSchema),
  // The environmental effects the party is in between fights, as a scene set them (environment.ts). Missing in none.
  ambient: z.array(ContentIdSchema).optional(),
  // Hours since the last Long Rest began. Missing until the first, so the first is always allowed.
  sinceLongRest: z.number().int().optional(),
  surprise: SurpriseSchema.optional(), // set by the story for the next fight, such as after a Stealth check
  // What the party has seen of each battle map picture, as "x,y" cells of its grid (fog.ts), kept between fights.
  revealed: z.record(z.string(), z.array(z.string())).optional(),
  combat: z
    .strictObject({
      encounter: z.string(),
      order: z.array(z.string()),
      index: z.number().int(),
      round: z.number().int(),
      canFlee: z.boolean().optional(),
      defeatContinues: z.boolean().optional(),
      grid: GridSchema.optional(),
      walls: z.array(z.string()).optional(), // squares no one can enter, as "x,y"
      openCorners: z.array(z.string()).optional(), // wall corners opened as the fight started (grid.ts)
      // Rounds begun since anyone last took damage. Missing in older saves and before the first round ends.
      calmRounds: z.number().int().optional(),
      terrain: TerrainSchema.optional(),
      map: FightMapSchema.optional(),
      loot: LootSchema.optional(), // found if the party wins
      lair: LairSchema.optional(),
      // Second turns in the first round, as Thief's Reflexes': each before `before`'s turn, or at the round's end
      // with none. Missing in older saves.
      secondTurns: z.array(SecondTurnSchema).optional(),
      // A creature taking one of those turns now, between others' turns (`resume` "same" goes back to the turn it came
      // before, "advance" to the one after it). Missing outside one.
      interlude: z
        .strictObject({
          actor: z.string(),
          resume: z.enum(["same", "advance"]),
        })
        .optional(),
      // The share of damage the party takes this fight, set as it starts. Missing in older saves, which
      // played at the difficulty's own share.
      damageToParty: z.number().optional(),
      // The map is covered until the party sees it (fog.ts). Missing in older saves, whose fights show all of it.
      fog: z.literal(true).optional(),
      sunlight: z.literal(true).optional(), // fought under the sky in daylight (zones.ts)
      underwater: z.literal(true).optional(), // fought underwater (combat/water.ts)
      environment: FightEnvironmentSchema.optional(), // the environmental effects it's fought in (environment.ts)
      // Weapons thrown and lying where they landed, until picked up. They go back to their throwers as it ends.
      dropped: z.array(DroppedSchema).optional(),
    })
    .nullable(),
});
export type DndState = z.infer<typeof StateSchema>;

const CharacterChosenSchema = z.strictObject({
  actor: z.string(),
  name: z.string(),
  build: CharacterBuildSchema,
  inventory: z.array(ContentIdSchema),
  hp: z.number().int(),
});
const CharacterAdvancedSchema = z.strictObject({
  actor: z.string(),
  entry: CharacterBuildSchema.shape.levels.element,
  hp: z.number().int(),
});
const XpAwardedSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
});
const RestedSchema = z.strictObject({
  actor: z.string(),
  rest: z.enum(["short", "long"]),
  maxHp: z.number().int(),
  resourcesSpent: z.record(z.string(), z.number().int()),
  // A disease or the winds of Pandemonium keep a Long Rest from healing, or from lessening Exhaustion below this.
  keepHp: z.literal(true).optional(),
  exhaustionFloor: z.number().int().optional(),
});
// Rests are the only thing that passes time, so they're the clock for the one-Long-Rest-a-day rule.
export const REST_HOURS = { short: 1, long: 8 } as const;
const RestFinishedSchema = z.strictObject({
  rest: z.enum(["short", "long"]),
  hours: z.number().int().min(1).optional(), // a Long Rest shorter than REST_HOURS, as an all-elf party's Trance
});
const CombatStartedSchema = z.strictObject({
  encounter: z.string(),
  monsters: z.array(ActorSchema),
  order: z.array(z.string()),
  canFlee: z.boolean().optional(),
  defeatContinues: z.boolean().optional(),
  grid: GridSchema.optional(),
  positions: z.record(z.string(), SquareSchema).optional(),
  walls: z.array(z.string()).optional(),
  openCorners: z.array(z.string()).optional(),
  terrain: TerrainSchema.optional(),
  map: FightMapSchema.optional(),
  loot: LootSchema.optional(),
  surprised: SurpriseSchema.optional(),
  lair: LairSchema.optional(),
  secondTurns: z.array(SecondTurnSchema).optional(),
  damageToParty: z.number().optional(),
  fog: z.literal(true).optional(),
  sunlight: z.literal(true).optional(),
  underwater: z.literal(true).optional(),
  environment: FightEnvironmentSchema.optional(),
  // The party's familiars, who join with Initiative of their own (combat/familiar.ts).
  familiars: z.array(ActorSchema).optional(),
});
const TreasureFoundSchema = z.strictObject({
  actor: z.string(), // who carries the items
  gold: z.number().int(),
  items: z.array(ContentIdSchema),
  stowed: z.array(ContentIdSchema), // the found gear that goes in the pack
});
// Gold a scene took, such as a fare or a bribe: no more than the party had.
const GoldSpentSchema = z.strictObject({ gold: z.number().min(0) });
const GearChangedSchema = z.strictObject({
  actor: z.string(),
  stowed: z.array(ContentIdSchema),
  attuned: z.array(ContentIdSchema),
});
const TradedSchema = z.strictObject({
  actor: z.string(),
  merchant: z.string(),
  item: ContentIdSchema,
  bought: z.boolean(), // false for sold
  priceCp: z.number().int().min(0),
  stowed: z.boolean(), // bought gear goes in the pack, as found gear does
});
const WeaponThrownSchema = DroppedSchema;
const ItemPickedUpSchema = z.strictObject({
  actor: z.string(),
  index: z.number().int().min(0), // in combat.dropped
});
const AnswerSwappedSchema = z.strictObject({
  actor: z.string(),
  key: z.string(), // "<level>:<answer>" in its build, or "trait:<feature>" for a trait's own cantrip
  values: z.array(z.string()),
  mark: z.string().optional(), // kept in `swapped` in place of the key, "<feat>@<level>" for a level's swap
});
const ItemUsedSchema = z.strictObject({
  actor: z.string(),
  item: ContentIdSchema,
});
// A score raised for good, by as much as it rose, as by a Manual of Bodily Health.
const SpellStoredSchema = z.strictObject({
  actor: z.string(), // who carries the item
  item: z.string(),
  stored: z.lazy(() => StoredSpellSchema),
});
const StoredSpellUsedSchema = z.strictObject({
  actor: z.string(),
  item: z.string(),
  spell: z.string(),
});
const RestPassivesSchema = z.strictObject({
  actor: z.string(),
  source: z.string(),
  passives: z.array(PassiveSchema),
});
const ItemSkillSchema = z.strictObject({
  actor: z.string(),
  item: z.string(),
  skill: z.string(),
});
const PoolRolledSchema = z.strictObject({
  actor: z.string(),
  resource: z.string(),
  amount: z.number().int(),
});
const AbilityRaisedSchema = z.strictObject({
  actor: z.string(),
  ability: AbilitySchema,
  amount: z.number().int(),
  item: ContentIdSchema,
});
const MovedSchema = z.strictObject({
  actor: z.string(),
  to: SquareSchema,
  feet: z.number().int(),
});
const ActorOnlySchema = z.strictObject({ actor: z.string() });
// The share of damage the party takes, weighed again when it first sees more of the foes (fog.ts). Only lower.
const DamageShareLoweredSchema = z.strictObject({ share: z.number() });
// Cells of a battle map picture the party has just seen for the first time, keyed as fog.ts keys them.
const SquaresSeenSchema = z.strictObject({
  map: z.string(),
  cells: z.array(z.string()),
});
const BudgetSpentSchema = z.strictObject({
  actor: z.string(),
  kind: z.enum(["action", "bonusAction", "reaction"]),
  label: z.string().optional(), // the reaction taken on its own, as Interception is
});
const ResourceSpentSchema = z.strictObject({
  actor: z.string(),
  resource: z.string(),
  amount: z.number().int().min(1).optional(), // so many at once, as a zone's damage dealt; one when missing
});
const ResourceRestoredSchema = z.strictObject({
  actor: z.string(),
  resource: z.string(),
  amount: z.number().int().min(1).optional(), // only so many uses, as Font of Magic gives; all when missing
});
const OncePerTurnSchema = z.strictObject({
  actor: z.string(),
  key: z.string(),
});
const DamagedSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
  type: DamageTypeSchema,
  critical: z.boolean(),
  massive: z.boolean(),
});
// `hp` is where its Hit Points fall to under the lower maximum, when they must.
const MaxHpReducedSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
  hp: z.number().int().optional(),
});
const HealedSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
  max: z.number().int(),
});
// Coming back from the dead, as with Raise Dead: this much off its D20 Tests, one less each Long Rest.
const OrdealSchema = z.strictObject({
  actor: z.string(),
  penalty: z.number().int().min(1),
});
const TempHpSchema = z.strictObject({
  actor: z.string(),
  amount: z.number().int(),
});
export const EffectAddedSchema = z.strictObject({
  actor: z.string(),
  effect: ActiveEffectSchema,
});
// With casterId, only that caster's effects from the source end, so one of two snakes letting go leaves the other's
// grapple. Older saves have none, and ended every caster's.
const EffectEndedSchema = z.strictObject({
  actor: z.string(),
  sourceId: z.string(),
  casterId: z.string().optional(),
});
const DamagedFromInsideSchema = z.strictObject({
  actor: z.string(), // the swallower
  amount: z.number().int(),
});
const ConditionRemovedSchema = z.strictObject({
  actor: z.string(),
  condition: ConditionSchema,
});
const ConcentrationStartedSchema = z.strictObject({
  actor: z.string(),
  spell: z.string(),
});
const DeathSaveSchema = z.strictObject({
  actor: z.string(),
  natural: z.number().int(),
  counts: z.number().int().optional(), // the roll it counts as, as Survivor's 18 for a 20; the natural when left out
});
const RollReportSchema = z.strictObject({
  actor: z.string(),
  against: z.string(),
  natural: z.number().int(),
  total: z.number().int(),
  target: z.number().int(),
  success: z.boolean(),
  label: z.string(),
});
// A saving throw against something other than a spell, such as a Grapple, so it shows in the log.
const SaveReportSchema = z.strictObject({
  actor: z.string(),
  ability: AbilitySchema,
  dc: z.number().int(),
  success: z.boolean(),
  label: z.string(),
});

// A saving throw, recorded only for the roll history: the outcome lives in the events that follow it.
const SaveRolledSchema = z.strictObject({
  actor: z.string(),
  ability: AbilitySchema,
  natural: z.number().int(),
  total: z.number().int(),
  dc: z.number().int(),
  success: z.boolean(),
});

// `key` marks one that can't be taken again until the monster's next turn.
const LegendaryActionTakenSchema = z.strictObject({
  actor: z.string(),
  name: z.string(),
  cost: z.number().int(),
  key: z.string().optional(),
});
const LairActionTakenSchema = z.strictObject({
  actor: z.string(),
  name: z.string(),
});
// A creature joining a fight already under way, standing where `actor.position` says, its turn right after `after`'s.
// Levels of Exhaustion gained (or lost, below 0), as a troll's severed limbs give and regrowing takes away.
const ExhaustionChangedSchema = z.strictObject({
  actor: z.string(),
  levels: z.number().int(),
});

// A character finds its familiar again, at full Hit Points (combat/familiar.ts).
const FamiliarFoundSchema = z.strictObject({
  actor: z.string(),
  form: ContentIdSchema,
  maxHp: z.number().int(),
});

const SummonedSchema = z.strictObject({
  actor: ActorSchema,
  after: z.string(),
});

export const EVENT_SCHEMAS = {
  [`${NS}:characterChosen`]: CharacterChosenSchema,
  [`${NS}:characterAdvanced`]: CharacterAdvancedSchema,
  [`${NS}:xpAwarded`]: XpAwardedSchema,
  [`${NS}:rested`]: RestedSchema,
  [`${NS}:restFinished`]: RestFinishedSchema,
  [`${NS}:combatStarted`]: CombatStartedSchema,
  [`${NS}:combatEnded`]: z.strictObject({}),
  [`${NS}:turnAdvanced`]: z.strictObject({}),
  [`${NS}:moved`]: MovedSchema,
  [`${NS}:squaresSeen`]: SquaresSeenSchema,
  [`${NS}:damageShareLowered`]: DamageShareLoweredSchema,
  [`${NS}:budgetSpent`]: BudgetSpentSchema,
  [`${NS}:actionRegained`]: ActorOnlySchema,
  [`${NS}:reactionRegained`]: ActorOnlySchema,
  [`${NS}:exhaustionChanged`]: ExhaustionChangedSchema,
  [`${NS}:resourceSpent`]: ResourceSpentSchema,
  [`${NS}:resourceRestored`]: ResourceRestoredSchema,
  [`${NS}:oncePerTurnUsed`]: OncePerTurnSchema,
  [`${NS}:damaged`]: DamagedSchema,
  [`${NS}:damagedFromInside`]: DamagedFromInsideSchema,
  [`${NS}:healed`]: HealedSchema,
  [`${NS}:tempHpGained`]: TempHpSchema,
  [`${NS}:ordealBegun`]: OrdealSchema,
  [`${NS}:reposed`]: ActorOnlySchema, // its corpse's time lying dead stops counting, as with Gentle Repose
  [`${NS}:disintegrated`]: ActorOnlySchema, // turned to dust, beyond ordinary raising
  // A new body of this species, without the old species' picks in `drop` and with the new one's `answers`.
  [`${NS}:reincarnated`]: z.strictObject({
    actor: z.string(),
    species: ContentIdSchema,
    drop: z.array(z.string()),
    answers: CharacterBuildSchema.shape.levels.element.shape.answers,
  }),
  [`${NS}:cloneStarted`]: z.strictObject({
    actor: z.string(),
    days: z.number().int(),
  }),
  // Dead, it wakes in its finished clone with these Hit Points.
  [`${NS}:cloneAwakened`]: z.strictObject({
    actor: z.string(),
    hp: z.number().int(),
  }),
  // Time passed outside a fight, as the party goes to another scene: the dead lie dead that much longer.
  [`${NS}:timePassed`]: z.strictObject({ hours: z.number().int().min(1) }),
  [`${NS}:environmentEntered`]: z.strictObject({
    effects: z.array(ContentIdSchema),
  }),
  [`${NS}:diseaseCaught`]: z.strictObject({
    actor: z.string(),
    record: DiseaseRecordSchema,
  }),
  [`${NS}:diseaseChanged`]: z.strictObject({
    actor: z.string(),
    record: DiseaseRecordSchema,
  }),
  [`${NS}:diseaseCured`]: z.strictObject({
    actor: z.string(),
    disease: ContentIdSchema,
  }),
  [`${NS}:effectAdded`]: EffectAddedSchema,
  [`${NS}:effectEnded`]: EffectEndedSchema,
  [`${NS}:conditionRemoved`]: ConditionRemovedSchema,
  [`${NS}:concentrationStarted`]: ConcentrationStartedSchema,
  [`${NS}:concentrationEnded`]: ActorOnlySchema,
  [`${NS}:deathSaveRolled`]: DeathSaveSchema,
  [`${NS}:maxHpReduced`]: MaxHpReducedSchema,
  [`${NS}:rollReported`]: RollReportSchema,
  // A scene check done without a roll by what deals with its obstacle, as Knock with a lock (core/explore.ts).
  [`${NS}:obstacleCleared`]: z.strictObject({
    actor: z.string(),
    source: z.string(),
  }),
  // A scene check that needs a tool the creature doesn't have, failed without a roll (core/explore.ts).
  [`${NS}:toolMissing`]: z.strictObject({
    actor: z.string(),
    tool: ContentIdSchema,
  }),
  [`${NS}:saveReported`]: SaveReportSchema,
  [`${NS}:saveRolled`]: SaveRolledSchema,
  // A die rolled for what befalls a creature, as Confusion's d10 or Prismatic Spray's d8, kept for the log: what
  // it decides is in the events that follow.
  [`${NS}:dieRolled`]: z.strictObject({
    actor: z.string(),
    die: z.number().int(),
    rolled: z.number().int(),
    label: z.string(),
  }),
  [`${NS}:inspirationGranted`]: ActorOnlySchema,
  [`${NS}:inspirationSpent`]: ActorOnlySchema,
  [`${NS}:treasureFound`]: TreasureFoundSchema,
  [`${NS}:goldSpent`]: GoldSpentSchema,
  [`${NS}:gearChanged`]: GearChangedSchema,
  [`${NS}:itemUsed`]: ItemUsedSchema,
  [`${NS}:abilityRaised`]: AbilityRaisedSchema,
  [`${NS}:poolRolled`]: PoolRolledSchema,
  [`${NS}:itemSkillPicked`]: ItemSkillSchema,
  [`${NS}:restPassivesGained`]: RestPassivesSchema,
  [`${NS}:spellStored`]: SpellStoredSchema,
  [`${NS}:storedSpellUsed`]: StoredSpellUsedSchema,
  [`${NS}:weaponThrown`]: WeaponThrownSchema,
  [`${NS}:answerSwapped`]: AnswerSwappedSchema,
  [`${NS}:itemPickedUp`]: ItemPickedUpSchema,
  [`${NS}:legendaryActionTaken`]: LegendaryActionTakenSchema,
  [`${NS}:summoned`]: SummonedSchema,
  [`${NS}:familiarFound`]: FamiliarFoundSchema,
  [`${NS}:legendaryResistanceUsed`]: ActorOnlySchema,
  [`${NS}:lairActionTaken`]: LairActionTakenSchema,
  [`${NS}:surpriseSet`]: z.strictObject({ side: SurpriseSchema }),
  [`${NS}:traded`]: TradedSchema,
  // A dying creature someone stabilized with the Help action: Stable, as after three successes.
  [`${NS}:stabilized`]: ActorOnlySchema,
  // The creature whose turn it is takes another, as under Time Stop: its action, Bonus Action, Reaction and
  // movement come back, and the turn order stays where it is.
  [`${NS}:turnRepeated`]: ActorOnlySchema,
  // A creature in an Antimagic Field: these effects stop working until it leaves, and so do its magic items.
  [`${NS}:effectsSuppressed`]: z.strictObject({
    actor: z.string(),
    sourceIds: z.array(z.string()),
  }),
  // An area moved, as Cloudkill drifting or Moonbeam moved: its owner's zone from that spell now centres here.
  [`${NS}:zoneMoved`]: z.strictObject({
    actor: z.string(),
    sourceId: z.string(),
    to: SquareSchema,
  }),
  // Out of the field again: what was held off works once more.
  [`${NS}:effectsRestored`]: ActorOnlySchema,
  // The caster's pick of its area's element, as Conjure Elemental's: the owner's zone from that spell now does this.
  [`${NS}:zoneRetyped`]: z.strictObject({
    actor: z.string(),
    sourceId: z.string(),
    area: AreaEffectSchema,
  }),
  // A creature left with this many Hit Points, as a black pudding's half after it splits.
  [`${NS}:hpSet`]: z.strictObject({ actor: z.string(), hp: z.number().int() }),
  // Two creatures trading places in the Initiative order, as with Alert's Initiative Swap.
  [`${NS}:initiativeSwapped`]: z.strictObject({
    actor: z.string(),
    with: z.string(),
  }),
} as const;

export type EventKind = keyof typeof EVENT_SCHEMAS;

export function dndEvent<K extends EventKind>(
  kind: K,
  payload: z.infer<(typeof EVENT_SCHEMAS)[K]>,
): SystemEvent {
  return { kind: kind as `${string}:${string}`, payload };
}

export function freshActor(
  fields: Pick<Actor, "id" | "name" | "side" | "source" | "hp" | "inventory">,
): Actor {
  return {
    ...fields,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    exhaustion: 0,
    heroicInspiration: false,
    budget: { action: true, bonusAction: true, reaction: true },
    usedThisTurn: [],
    resourcesSpent: {},
    activeEffects: [],
    concentratingOn: null,
    position: null,
    moved: 0,
  };
}

// A character's build with the answers picked again after a Long Rest in place of the first ones (swap.ts).
export function effectiveBuild(actor: Actor): CharacterBuild | null {
  const printed = actor.source.kind === "character" ? actor.source.build : null;
  const { swaps, reincarnated } = actor;
  // Reincarnate's body: its species, without the old one's picks and with the new one's (reincarnate.ts).
  const build =
    printed && reincarnated
      ? {
          ...printed,
          speciesId: reincarnated.species,
          levels: printed.levels.map((entry, level) =>
            level === 0
              ? {
                  ...entry,
                  answers: [
                    ...entry.answers
                      .map((answer) =>
                        "values" in answer
                          ? ({
                              ...answer,
                              values: answer.values.filter(
                                (value) => !reincarnated.drop.includes(value),
                              ),
                            } as typeof answer)
                          : answer,
                      )
                      .filter(
                        (answer) =>
                          !("values" in answer) || answer.values.length > 0,
                      ),
                    ...reincarnated.answers,
                  ],
                }
              : entry,
          ),
        }
      : printed;
  if (!build || !swaps) return build;
  return {
    ...build,
    levels: build.levels.map((entry, level) => ({
      ...entry,
      answers: entry.answers.map((answer, index) => {
        const values = swaps[`${String(level)}:${String(index)}`];
        return values && "values" in answer
          ? ({ ...answer, values } as typeof answer)
          : answer;
      }),
    })),
  };
}

// Removes one copy of each id in `taken`, so two daggers stay two daggers.
export function without(
  list: readonly string[],
  taken: readonly string[],
): string[] {
  const left = [...taken];
  return list.filter((id) => {
    const at = left.indexOf(id);
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}

// What the actor wears and wields: everything carried that isn't stowed.
export function equipped(actor: Actor): string[] {
  return without(actor.inventory, actor.stowed ?? []);
}

type Condition = z.infer<typeof ConditionSchema>;

// Advantage limited to its caster, as Reassert Honor's, counts only for that attacker.
export function forAttacker(
  effect: ActiveEffect,
  attackerId: string | undefined,
): boolean {
  const { modifier } = effect;
  return (
    (modifier.kind !== "advantage" && modifier.kind !== "disadvantage") ||
    !modifier.casterOnly ||
    effect.casterId === attackerId
  );
}

export function hasCondition(
  actor: Actor,
  ...conditions: readonly Condition[]
): boolean {
  return actor.activeEffects.some(
    ({ modifier }) =>
      modifier.kind === "condition" && conditions.includes(modifier.condition),
  );
}

// Invisible to this viewer: it has the condition and the viewer has nothing that sees through it.
export function invisibleTo(target: Actor, viewer: Actor): boolean {
  return (
    hasCondition(target, "invisible") &&
    !target.activeEffects.some(
      ({ modifier }) => modifier.kind === "outlined",
    ) &&
    !viewer.activeEffects.some(
      ({ modifier }) =>
        modifier.kind === "seeInvisible" ||
        (modifier.kind === "darkvision" && modifier.truesight === true),
    )
  );
}

export const INCAPACITATING: readonly Condition[] = [
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
];

// Under an effect that stops it regaining Hit Points, as a death tyrant's Negative Energy Cone.
export function cannotHeal(actor: Actor): boolean {
  return actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "noHealing",
  );
}

export function isDown(actor: Actor): boolean {
  return actor.hp <= 0 && fightingOn(actor) === null;
}

// What keeps a creature at 0 Hit Points conscious, as Rage beyond Death, or null.
export function fightingOn(
  actor: Actor,
): { readonly delayDeath?: true | undefined } | null {
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "fightingOn") return modifier;
  }
  return null;
}

// The mount a creature rides, by id, or null.
export function mountOf(actor: Actor): string | null {
  return (
    actor.activeEffects.find(({ modifier }) => modifier.kind === "riding")
      ?.casterId ?? null
  );
}

// The rider controlling this mount: one riding it that can act. A controlled mount moves as its rider directs, on
// its rider's turn, and has no turn of its own.
export function controllingRider(
  state: DndState,
  mountId: string,
): Actor | null {
  return (
    Object.values(state.actors).find(
      (item) =>
        mountOf(item) === mountId &&
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING),
    ) ?? null
  );
}

// The character whose familiar this is, or null for any other creature.
export function familiarOwner(actor: Actor): string | null {
  return actor.source.kind === "monster"
    ? (actor.source.familiarOf?.owner ?? null)
    : null;
}

export function isDead(actor: Actor): boolean {
  if (actor.hp > 0) return false;
  return (
    actor.side === "enemy" ||
    actor.source.kind === "summon" ||
    (actor.source.kind === "monster" && actor.source.calledBy !== undefined) ||
    familiarOwner(actor) !== null ||
    (actor.deathSaves.failures >= 3 && !fightingOn(actor)?.delayDeath)
  );
}

// A Long Rest takes one off the ordeal of coming back from the dead, and it's gone at 0. Passives kept until a Long
// Rest go too.
// A Long Rest gives back the Hit Point maximum Harm took.
function withoutLoss({ maxHpLoss: _loss, ...actor }: Actor): Actor {
  return actor;
}

function lessOrdeal({ ordeal, restPassives: _kept, ...actor }: Actor): Actor {
  return ordeal && ordeal > 1 ? { ...actor, ordeal: ordeal - 1 } : actor;
}

// The hours of a rest added to the time each dead party member has lain dead, unless its body is reposed.
// A day passes with each Long Rest, so a living creature's clone grows a day nearer ready.
function grownClones(actors: DndState["actors"]): DndState["actors"] {
  return Object.fromEntries(
    Object.entries(actors).map(([id, actor]) => [
      id,
      actor.clone && !isDead(actor)
        ? { ...actor, clone: actor.clone - 1 }
        : actor,
    ]),
  );
}

// Effects that outlast a fight run down with the hours that pass, as a curse's 8 hours (core/combat/effects.ts
// lingersFor). Those that last until cured stay, and those that last until a Long Rest stay until one (`long`).
// Concentration on a spell whose effects have all run out ends with them.
function lingerLess(
  actors: DndState["actors"],
  hours: number,
  long = false,
): DndState["actors"] {
  const ends = (lingers: ActiveEffect["lingers"]) =>
    typeof lingers === "number" || (long && lingers === "longRest");
  if (
    !Object.values(actors).some((actor) =>
      actor.activeEffects.some(({ lingers }) => ends(lingers)),
    )
  )
    return actors;
  const after = Object.fromEntries(
    Object.entries(actors).map(([id, actor]) => [
      id,
      actor.activeEffects.some(({ lingers }) => ends(lingers))
        ? {
            ...actor,
            activeEffects: actor.activeEffects.flatMap((effect) =>
              !ends(effect.lingers)
                ? [effect]
                : typeof effect.lingers === "number" && effect.lingers > hours
                  ? [{ ...effect, lingers: effect.lingers - hours }]
                  : [],
            ),
          }
        : actor,
    ]),
  );
  const held = new Set(
    Object.values(after).flatMap((actor) =>
      actor.activeEffects.flatMap(({ casterId, ends: until }) =>
        until === "concentration" ? [casterId] : [],
      ),
    ),
  );
  return Object.fromEntries(
    Object.entries(after).map(([id, actor]) => [
      id,
      actor.concentratingOn !== null && !held.has(id)
        ? { ...actor, concentratingOn: null }
        : actor,
    ]),
  );
}

function deadLonger(state: DndState, hours: number): DndState["actors"] {
  return Object.fromEntries(
    Object.entries(state.actors).map(([id, actor]) => [
      id,
      actor.side === "party" && isDead(actor) && !actor.reposed
        ? { ...actor, deadHours: (actor.deadHours ?? 0) + hours }
        : actor,
    ]),
  );
}

// Three successes make a dying character Stable: no more death saves until healed.
export function isStable(actor: Actor): boolean {
  return (
    actor.side === "party" &&
    actor.hp <= 0 &&
    actor.deathSaves.successes >= 3 &&
    actor.deathSaves.failures < 3
  );
}

function updateActor(
  state: DndState,
  id: string,
  change: (actor: Actor) => Actor,
): DndState {
  const actor = state.actors[id];
  if (!actor) throw new Error(`Unknown actor ${id}`);
  return { ...state, actors: { ...state.actors, [id]: change(actor) } };
}

function advanceTurn(state: DndState): DndState {
  const { combat } = state;
  if (!combat) return state;
  const count = combat.order.length;
  let { index, round } = combat;
  const { interlude, ...rest } = combat;
  // A second turn ending goes back to the turn it came before, unless it came at the round's end.
  if (interlude?.resume === "same") {
    return turnStarts(state, rest, index, round, interlude.actor);
  }
  for (let step = 0; step < count; step += 1) {
    index += 1;
    if (index >= count) {
      index = 0;
      round += 1;
    }
    const next = state.actors[combat.order[index] ?? ""];
    if (
      next &&
      !isDead(next) &&
      !isStable(next) &&
      !controllingRider(state, next.id)
    ) {
      break;
    }
  }
  // Thief's Reflexes: a second turn in the first round, before the turn it comes before, or before the second round.
  // A creature it came before that's gone from the turns still has it come there, or at the round's end.
  const due = (rest.secondTurns ?? []).find(
    ({ before }) =>
      combat.round === 1 &&
      (round > 1 || (before !== null && index >= combat.order.indexOf(before))),
  );
  const thief = due ? state.actors[due.actor] : undefined;
  if (due && thief && !isDead(thief)) {
    const left = (rest.secondTurns ?? []).filter((item) => item !== due);
    const planned = { ...rest, secondTurns: left };
    return round > 1
      ? turnStarts(
          state,
          planned,
          combat.index,
          combat.round,
          interlude?.actor,
          {
            actor: due.actor,
            resume: "advance",
          },
        )
      : turnStarts(state, planned, index, round, interlude?.actor, {
          actor: due.actor,
          resume: "same",
        });
  }
  return turnStarts(state, rest, index, round, interlude?.actor);
}

// The turn coming: `index` and `round` in the order, or a second turn between them. `ended` is whoever's turn just
// ended, when it wasn't the order's at its index.
function turnStarts(
  state: DndState,
  combat: NonNullable<DndState["combat"]>,
  index: number,
  round: number,
  ended?: string,
  interlude?: { readonly actor: string; readonly resume: "same" | "advance" },
): DndState {
  const nextId = interlude?.actor ?? combat.order[index] ?? "";
  // A controlled mount's turn comes with its rider's.
  const nextActor = state.actors[nextId];
  const nextMount = nextActor ? mountOf(nextActor) : null;
  const endingId = ended ?? combat.order[combat.index];
  const actors = Object.fromEntries(
    Object.entries(state.actors).map(([id, actor]) => [
      id,
      {
        ...actor,
        // Damage from inside counts within a single turn.
        ...(actor.insideDamage ? { insideDamage: 0 } : {}),
        // The rounds a fallen party member has lain dead, for Revivify's minute.
        ...(round > combat.round &&
        actor.side === "party" &&
        isDead(actor) &&
        !actor.reposed
          ? { deadRounds: (actor.deadRounds ?? 0) + round - combat.round }
          : {}),
        // A "until your next turn" effect ends when its caster's turn comes round.
        activeEffects: actor.activeEffects
          .filter(
            (effect) =>
              (effect.ends !== "casterNextTurn" ||
                effect.casterId !== nextId) &&
              (effect.ends !== "casterTurnEnd" || effect.casterId !== endingId),
          )
          .map((effect) =>
            effect.ends === "casterNextTurnEnd" && effect.casterId === nextId
              ? { ...effect, ends: "casterTurnEnd" as const }
              : effect,
          ),
        ...(id === nextId || id === nextMount
          ? {
              budget: { action: true, bonusAction: true, reaction: true },
              usedThisTurn: [],
              moved: 0,
            }
          : {}),
      },
    ]),
  );
  const calmRounds = (combat.calmRounds ?? 0) + round - combat.round;
  return {
    ...state,
    actors,
    combat: {
      ...combat,
      index,
      round,
      ...(calmRounds > 0 ? { calmRounds } : {}),
      ...(interlude ? { interlude } : {}),
    },
  };
}

function removeConcentration(state: DndState, casterId: string): DndState {
  const actors = Object.fromEntries(
    Object.entries(state.actors).map(([id, actor]) => [
      id,
      {
        ...actor,
        activeEffects: actor.activeEffects.filter(
          (effect) =>
            effect.ends !== "concentration" || effect.casterId !== casterId,
        ),
        ...(actor.suppressed
          ? {
              suppressed: actor.suppressed.filter(
                (effect) =>
                  effect.ends !== "concentration" ||
                  effect.casterId !== casterId,
              ),
            }
          : {}),
        concentratingOn: id === casterId ? null : actor.concentratingOn,
      },
    ]),
  );
  return { ...state, actors };
}

// A summoned creature vanishes when its caster dies or, for a Concentration spell, stops concentrating on it.
// It stays in the order at 0 Hit Points, as a dead foe does, so the turn passes it by.
function settleSummons(state: DndState): DndState {
  let { actors } = state;
  for (const [id, actor] of Object.entries(state.actors)) {
    const { source } = actor;
    if (source.kind !== "summon" || actor.hp <= 0) continue;
    const caster = state.actors[source.casterId];
    const gone =
      !caster ||
      isDead(caster) ||
      (source.concentration && caster.concentratingOn !== source.sourceId);
    if (gone) actors = { ...actors, [id]: { ...actor, hp: 0, tempHp: 0 } };
  }
  return actors === state.actors ? state : { ...state, actors };
}

// What outlasts a fight, without its count in rounds (lingers): what a foe left on the creature, as a curse, and what
// lasts until cured, as a disease's symptoms. A curse that hampers attacks against its caster, or hits from it, goes
// with the caster.
// shortcut: a friend's long spell, as Mage Armor's 8 hours, still ends with the fight, and repeat saves still being
// counted when it ends stop where they are, as Contagion's.
function outlasting(
  { lasts: _lasts, ...rest }: ActiveEffect,
  bearer: Actor,
  state: DndState,
): ActiveEffect[] {
  const { modifier, lingers, casterId } = rest;
  if (lingers === undefined) return [];
  const caster = state.actors[casterId];
  if (
    lingers !== "cured" &&
    lingers !== "longRest" &&
    (!caster || caster.side === bearer.side)
  )
    return [];
  if (
    ((modifier.kind === "advantage" || modifier.kind === "disadvantage") &&
      modifier.casterOnly) ||
    (modifier.kind === "hitDamage" && modifier.dealtBy === "caster")
  ) {
    return [];
  }
  return [rest];
}

function endCombat(state: DndState): DndState {
  // Whatever was thrown is gathered up after the fight.
  const gathered = (state.combat?.dropped ?? []).reduce(
    (after, { item, by }) =>
      after.actors[by]
        ? updateActor(after, by, (actor) => ({
            ...actor,
            inventory: [...actor.inventory, item],
          }))
        : after,
    state,
  );
  // A familiar's Hit Points go back to its owner, to carry into the next fight.
  const kept = Object.values(gathered.actors).reduce((after, actor) => {
    const owner = familiarOwner(actor);
    const held = owner ? after.actors[owner]?.familiar : undefined;
    return owner && held
      ? updateActor(after, owner, (item) => ({
          ...item,
          familiar: { ...held, hp: Math.max(0, actor.hp) },
        }))
      : after;
  }, gathered);
  const actors = Object.fromEntries(
    Object.entries(kept.actors)
      .filter(
        ([, actor]) =>
          actor.side === "party" &&
          actor.source.kind !== "summon" &&
          !(actor.source.kind === "monster" && actor.source.calledBy) &&
          familiarOwner(actor) === null,
      )
      .map(([id, { suppressed: _held, ...actor }]) => [
        id,
        {
          ...actor,
          activeEffects: actor.activeEffects.flatMap((effect) =>
            outlasting(effect, actor, kept),
          ),
          concentratingOn: null,
          budget: { action: true, bonusAction: true, reaction: true },
          usedThisTurn: [],
          position: null,
          moved: 0,
          // shortcut: everyone downed but not dead gets back up, since an adventure doesn't have to offer a rest.
          hp: actor.hp <= 0 && !isDead(actor) ? 1 : actor.hp,
          deathSaves: isDead(actor)
            ? actor.deathSaves
            : { successes: 0, failures: 0 },
        },
      ]),
  );
  return { ...state, actors, combat: null };
}

function applyDamage(
  actor: Actor,
  amount: number,
  critical: boolean,
  massive: boolean,
): Actor {
  const absorbed = Math.min(actor.tempHp, amount);
  const remaining = amount - absorbed;
  const wasDown = actor.hp <= 0;
  const hp = Math.max(0, actor.hp - remaining);
  const hitWhileDown =
    wasDown && remaining > 0 && actor.side === "party" ? (critical ? 2 : 1) : 0;
  const unsettled = hitWhileDown > 0 && isStable(actor);
  return {
    ...actor,
    activeEffects:
      amount > 0
        ? actor.activeEffects.filter(
            (effect) =>
              !effect.endsOnDamage &&
              !(effect.endsWithTempHp && actor.tempHp <= absorbed),
          )
        : actor.activeEffects,
    tempHp: actor.tempHp - absorbed,
    hp,
    // Becoming Stable reset both counts, so damage that ends it starts death saves from nothing.
    deathSaves: {
      successes: unsettled ? 0 : actor.deathSaves.successes,
      // Massive damage kills outright, which three failures also represent.
      failures: massive
        ? 3
        : (unsettled ? 0 : actor.deathSaves.failures) + hitWhileDown,
    },
  };
}

function applyDeathSave(actor: Actor, natural: number): Actor {
  if (natural === 20) {
    return { ...actor, hp: 1, deathSaves: { successes: 0, failures: 0 } };
  }
  const { successes, failures } = actor.deathSaves;
  return {
    ...actor,
    deathSaves:
      natural >= 10
        ? { successes: successes + 1, failures }
        : { successes, failures: failures + (natural === 1 ? 2 : 1) },
  };
}

function payload<S extends z.ZodType>(
  schema: S,
  event: SystemEvent,
): z.infer<S> {
  return schema.parse("payload" in event ? event.payload : {});
}

export function applyDndEvent(state: DndState, event: SystemEvent): DndState {
  return settleSummons(settleForms(state, applyOne(state, event)));
}

function applyOne(state: DndState, event: SystemEvent): DndState {
  switch (event.kind) {
    case `${NS}:characterChosen`: {
      const data = payload(CharacterChosenSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        name: data.name,
        source: { kind: "character", build: data.build },
        inventory: data.inventory,
        hp: data.hp,
      }));
    }
    case `${NS}:characterAdvanced`: {
      const data = payload(CharacterAdvancedSchema, event);
      return updateActor(state, data.actor, (actor) => {
        if (actor.source.kind !== "character" || !actor.source.build) {
          throw new Error(`${actor.id} has no character build`);
        }
        const { build } = actor.source;
        return {
          ...actor,
          source: {
            kind: "character",
            build: { ...build, levels: [...build.levels, data.entry] },
          },
          hp: data.hp,
        };
      });
    }
    case `${NS}:xpAwarded`: {
      const data = payload(XpAwardedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        xp: (actor.xp ?? 0) + data.amount,
      }));
    }
    case `${NS}:rested`: {
      const data = payload(RestedSchema, event);
      return updateActor(state, data.actor, (actor) =>
        data.rest === "short"
          ? { ...actor, resourcesSpent: data.resourcesSpent }
          : {
              ...lessOrdeal(withoutLoss(actor)),
              resourcesSpent: data.resourcesSpent,
              hp: data.keepHp ? actor.hp : data.maxHp,
              tempHp: 0,
              deathSaves: { successes: 0, failures: 0 },
              exhaustion: Math.max(
                Math.min(actor.exhaustion, data.exhaustionFloor ?? 0),
                actor.exhaustion - 1,
              ),
              // Each Long Rest allows its swaps again, though not a level's.
              ...(actor.swapped
                ? { swapped: actor.swapped.filter((key) => key.includes("@")) }
                : {}),
            },
      );
    }
    case `${NS}:restFinished`: {
      const data = payload(RestFinishedSchema, event);
      const { rest } = data;
      const hours = data.hours ?? REST_HOURS[rest];
      const rested = {
        ...state,
        actors: lingerLess(
          rest === "long"
            ? grownClones(deadLonger(state, hours))
            : deadLonger(state, hours),
          hours,
          rest === "long",
        ),
      };
      if (rest === "long") return { ...rested, sinceLongRest: hours };
      return state.sinceLongRest === undefined
        ? rested
        : { ...rested, sinceLongRest: state.sinceLongRest + REST_HOURS.short };
    }
    case `${NS}:combatStarted`: {
      const data = payload(CombatStartedSchema, event);
      const actors = {
        ...state.actors,
        ...Object.fromEntries(
          [...data.monsters, ...(data.familiars ?? [])].map((item) => [
            item.id,
            item,
          ]),
        ),
      };
      // The surprise was for this fight, so it's spent now.
      const rest = Object.fromEntries(
        Object.entries(state).filter(([key]) => key !== "surprise"),
      ) as Omit<DndState, "surprise">;
      return {
        ...rest,
        actors: Object.fromEntries(
          Object.entries(actors).map(([id, actor]) => [
            id,
            { ...actor, position: data.positions?.[id] ?? null, moved: 0 },
          ]),
        ),
        combat: {
          encounter: data.encounter,
          order: data.order,
          index: 0,
          round: 1,
          ...(data.canFlee ? { canFlee: true } : {}),
          ...(data.defeatContinues ? { defeatContinues: true } : {}),
          ...(data.grid ? { grid: data.grid } : {}),
          ...(data.walls ? { walls: data.walls } : {}),
          ...(data.openCorners ? { openCorners: data.openCorners } : {}),
          ...(data.terrain ? { terrain: data.terrain } : {}),
          ...(data.map ? { map: data.map } : {}),
          ...(data.loot ? { loot: data.loot } : {}),
          ...(data.lair ? { lair: data.lair } : {}),
          ...(data.secondTurns ? { secondTurns: data.secondTurns } : {}),
          ...(data.damageToParty === undefined
            ? {}
            : { damageToParty: data.damageToParty }),
          ...(data.fog ? { fog: true as const } : {}),
          ...(data.sunlight ? { sunlight: true as const } : {}),
          ...(data.underwater ? { underwater: true as const } : {}),
          ...(data.environment ? { environment: data.environment } : {}),
        },
      };
    }
    case `${NS}:effectsSuppressed`: {
      const { actor: id, sourceIds } = payload(
        EVENT_SCHEMAS[`${NS}:effectsSuppressed`],
        event,
      );
      return updateActor(state, id, (actor) => ({
        ...actor,
        activeEffects: actor.activeEffects.filter(
          (effect) => !sourceIds.includes(effect.sourceId),
        ),
        suppressed: [
          ...(actor.suppressed ?? []),
          ...actor.activeEffects.filter((effect) =>
            sourceIds.includes(effect.sourceId),
          ),
        ],
      }));
    }
    case `${NS}:zoneMoved`: {
      const {
        actor: id,
        sourceId,
        to,
      } = payload(EVENT_SCHEMAS[`${NS}:zoneMoved`], event);
      return updateActor(state, id, (actor) => ({
        ...actor,
        activeEffects: actor.activeEffects.map((effect) =>
          effect.sourceId === sourceId &&
          effect.modifier.kind === "zone" &&
          !effect.modifier.follows
            ? { ...effect, modifier: { ...effect.modifier, at: to } }
            : effect,
        ),
      }));
    }
    case `${NS}:zoneRetyped`: {
      const {
        actor: id,
        sourceId,
        area,
      } = payload(EVENT_SCHEMAS[`${NS}:zoneRetyped`], event);
      return updateActor(state, id, (actor) => ({
        ...actor,
        activeEffects: actor.activeEffects.map((effect) =>
          effect.sourceId === sourceId &&
          effect.modifier.kind === "zone" &&
          effect.modifier.area
            ? { ...effect, modifier: { ...effect.modifier, area } }
            : effect,
        ),
      }));
    }
    case `${NS}:effectsRestored`: {
      const id = payload(ActorOnlySchema, event).actor;
      return updateActor(state, id, (actor) => {
        const { suppressed, ...rest } = actor;
        return {
          ...rest,
          activeEffects: [...actor.activeEffects, ...(suppressed ?? [])],
        };
      });
    }
    case `${NS}:turnRepeated`: {
      const data = payload(ActorOnlySchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        budget: { action: true, bonusAction: true, reaction: true },
        usedThisTurn: [],
        moved: 0,
      }));
    }
    case `${NS}:combatEnded`:
      return endCombat(state);
    case `${NS}:damageShareLowered`: {
      const { share } = payload(DamageShareLoweredSchema, event);
      return state.combat
        ? { ...state, combat: { ...state.combat, damageToParty: share } }
        : state;
    }
    case `${NS}:squaresSeen`: {
      const data = payload(SquaresSeenSchema, event);
      const seen = state.revealed ?? {};
      return {
        ...state,
        revealed: {
          ...seen,
          [data.map]: [...(seen[data.map] ?? []), ...data.cells],
        },
      };
    }
    case `${NS}:familiarFound`: {
      const data = payload(FamiliarFoundSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        familiar: { form: data.form, hp: data.maxHp, maxHp: data.maxHp },
      }));
    }
    case `${NS}:summoned`: {
      const data = payload(SummonedSchema, event);
      const { combat } = state;
      if (!combat) return state;
      const at = combat.order.indexOf(data.after) + 1;
      // Everything stored as a place in the order after the new turn moves down one.
      const shift = (index: number): number =>
        index >= at ? index + 1 : index;
      return {
        ...state,
        actors: { ...state.actors, [data.actor.id]: data.actor },
        combat: {
          ...combat,
          order: [
            ...combat.order.slice(0, at),
            data.actor.id,
            ...combat.order.slice(at),
          ],
          index: shift(combat.index),
          ...(combat.lair ? { lair: { at: shift(combat.lair.at) } } : {}),
        },
      };
    }
    case `${NS}:turnAdvanced`:
      return advanceTurn(state);
    case `${NS}:moved`: {
      const data = payload(MovedSchema, event);
      const moved = updateActor(state, data.actor, (actor) => ({
        ...actor,
        position: data.to,
        moved: actor.moved + data.feet,
        // A rider moved off its mount by anything but the mount is no longer riding it.
        activeEffects: mountOf(actor)
          ? actor.activeEffects.filter(({ modifier, casterId }) => {
              const spot = state.actors[casterId]?.position;
              return (
                modifier.kind !== "riding" ||
                (spot?.x === data.to.x && spot.y === data.to.y)
              );
            })
          : actor.activeEffects,
      }));
      // Riders go where their mount goes.
      return Object.values(moved.actors).reduce(
        (after, item) =>
          mountOf(item) === data.actor
            ? updateActor(after, item.id, (rider) => ({
                ...rider,
                position: data.to,
              }))
            : after,
        moved,
      );
    }
    case `${NS}:budgetSpent`: {
      const data = payload(BudgetSpentSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        budget: { ...actor.budget, [data.kind]: false },
      }));
    }
    case `${NS}:actionRegained`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, budget: { ...actor.budget, action: true } }),
      );
    case `${NS}:reactionRegained`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, budget: { ...actor.budget, reaction: true } }),
      );
    case `${NS}:exhaustionChanged`: {
      const data = payload(ExhaustionChangedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        exhaustion: Math.min(6, Math.max(0, actor.exhaustion + data.levels)),
      }));
    }
    case `${NS}:resourceSpent`: {
      const data = payload(ResourceSpentSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        resourcesSpent: {
          ...actor.resourcesSpent,
          [data.resource]:
            (actor.resourcesSpent[data.resource] ?? 0) + (data.amount ?? 1),
        },
      }));
    }
    case `${NS}:resourceRestored`: {
      const data = payload(ResourceRestoredSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        resourcesSpent: Object.fromEntries(
          Object.entries(actor.resourcesSpent).flatMap(([resource, spent]) => {
            if (resource !== data.resource) return [[resource, spent]];
            const left = spent - (data.amount ?? spent);
            return left > 0 ? [[resource, left]] : [];
          }),
        ),
      }));
    }
    case `${NS}:oncePerTurnUsed`: {
      const data = payload(OncePerTurnSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        usedThisTurn: [...actor.usedThisTurn, data.key],
      }));
    }
    case `${NS}:damaged`: {
      const data = payload(DamagedSchema, event);
      const hurt = updateActor(state, data.actor, (actor) =>
        applyDamage(actor, data.amount, data.critical, data.massive),
      );
      const { combat } = hurt;
      // Damage that only Temporary Hit Points take leaves a stand-off calm, or refreshed ones would stall it.
      const before = state.actors[data.actor];
      if (!combat?.calmRounds || data.amount <= (before?.tempHp ?? 0))
        return hurt;
      const calm = { ...combat };
      delete calm.calmRounds;
      return { ...hurt, combat: calm };
    }
    case `${NS}:maxHpReduced`: {
      const data = payload(MaxHpReducedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        maxHpLoss: (actor.maxHpLoss ?? 0) + data.amount,
        hp: data.hp ?? actor.hp,
      }));
    }
    case `${NS}:damagedFromInside`: {
      const data = payload(DamagedFromInsideSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        insideDamage: (actor.insideDamage ?? 0) + data.amount,
      }));
    }
    case `${NS}:hpSet`: {
      const data = payload(EVENT_SCHEMAS[`${NS}:hpSet`], event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        hp: data.hp,
      }));
    }
    case `${NS}:initiativeSwapped`: {
      const data = payload(EVENT_SCHEMAS[`${NS}:initiativeSwapped`], event);
      const { combat } = state;
      if (!combat) return state;
      const swap = (id: string): string =>
        id === data.actor ? data.with : id === data.with ? data.actor : id;
      return { ...state, combat: { ...combat, order: combat.order.map(swap) } };
    }
    case `${NS}:healed`: {
      const data = payload(HealedSchema, event);
      // Back from the dead, its time lying dead is over.
      return updateActor(
        state,
        data.actor,
        ({
          deadHours: _hours,
          reposed: _reposed,
          dust: _dust,
          deadRounds: _rounds,
          ...actor
        }) => ({
          ...actor,
          hp: Math.min(data.max, Math.max(actor.hp, 0) + data.amount),
          deathSaves: { successes: 0, failures: 0 },
        }),
      );
    }
    case `${NS}:ordealBegun`: {
      const data = payload(OrdealSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        ordeal: data.penalty,
      }));
    }
    case `${NS}:environmentEntered`: {
      const { effects } = payload(
        EVENT_SCHEMAS[`${NS}:environmentEntered`],
        event,
      );
      if (effects.length > 0) return { ...state, ambient: effects };
      return Object.fromEntries(
        Object.entries(state).filter(([key]) => key !== "ambient"),
      ) as DndState;
    }
    case `${NS}:diseaseCaught`:
    case `${NS}:diseaseChanged`: {
      const { actor: id, record } = payload(
        EVENT_SCHEMAS[`${NS}:diseaseChanged`],
        event,
      );
      return updateActor(state, id, (actor) => ({
        ...actor,
        diseases: [
          ...(actor.diseases ?? []).filter(
            (item) => item.disease !== record.disease,
          ),
          record,
        ],
      }));
    }
    case `${NS}:diseaseCured`: {
      const { actor: id, disease } = payload(
        EVENT_SCHEMAS[`${NS}:diseaseCured`],
        event,
      );
      return updateActor(state, id, ({ diseases, ...actor }) => {
        const left = (diseases ?? []).filter(
          (item) => item.disease !== disease,
        );
        return {
          ...actor,
          activeEffects: actor.activeEffects.filter(
            ({ sourceId }) => sourceId !== `disease:${disease}`,
          ),
          ...(left.length > 0 ? { diseases: left } : {}),
        };
      });
    }
    case `${NS}:timePassed`: {
      const { hours } = payload(
        z.strictObject({ hours: z.number().int().min(1) }),
        event,
      );
      return { ...state, actors: lingerLess(deadLonger(state, hours), hours) };
    }
    case `${NS}:reincarnated`: {
      const { actor: id, ...reincarnated } = payload(
        EVENT_SCHEMAS[`${NS}:reincarnated`],
        event,
      );
      return updateActor(state, id, (actor) => ({ ...actor, reincarnated }));
    }
    case `${NS}:cloneStarted`: {
      const data = payload(EVENT_SCHEMAS[`${NS}:cloneStarted`], event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        clone: data.days,
      }));
    }
    case `${NS}:cloneAwakened`: {
      const data = payload(EVENT_SCHEMAS[`${NS}:cloneAwakened`], event);
      return updateActor(
        state,
        data.actor,
        ({
          deadHours: _hours,
          reposed: _reposed,
          dust: _dust,
          deadRounds: _rounds,
          clone: _clone,
          ...actor
        }) => ({
          ...actor,
          hp: data.hp,
          deathSaves: { successes: 0, failures: 0 },
        }),
      );
    }
    case `${NS}:disintegrated`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, dust: true as const }),
      );
    case `${NS}:reposed`: {
      const data = payload(ActorOnlySchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        reposed: true as const,
      }));
    }
    case `${NS}:tempHpGained`: {
      const data = payload(TempHpSchema, event);
      // Temporary Hit Points don't stack: the higher amount is kept.
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        tempHp: Math.max(actor.tempHp, data.amount),
      }));
    }
    case `${NS}:effectAdded`: {
      const data = payload(EffectAddedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        activeEffects: [...actor.activeEffects, data.effect],
      }));
    }
    case `${NS}:effectEnded`: {
      const data = payload(EffectEndedSchema, event);
      const kept = (effect: ActiveEffect): boolean =>
        effect.sourceId !== data.sourceId ||
        (data.casterId !== undefined && effect.casterId !== data.casterId);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        activeEffects: actor.activeEffects.filter(kept),
        ...(actor.suppressed
          ? { suppressed: actor.suppressed.filter(kept) }
          : {}),
      }));
    }
    case `${NS}:conditionRemoved`: {
      const data = payload(ConditionRemovedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        activeEffects: actor.activeEffects.filter(
          ({ modifier }) =>
            modifier.kind !== "condition" ||
            modifier.condition !== data.condition,
        ),
      }));
    }
    case `${NS}:concentrationStarted`: {
      const data = payload(ConcentrationStartedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        concentratingOn: data.spell,
      }));
    }
    case `${NS}:concentrationEnded`:
      return removeConcentration(state, payload(ActorOnlySchema, event).actor);
    case `${NS}:deathSaveRolled`: {
      const data = payload(DeathSaveSchema, event);
      return updateActor(state, data.actor, (actor) =>
        applyDeathSave(actor, data.counts ?? data.natural),
      );
    }
    case `${NS}:stabilized`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, deathSaves: { successes: 3, failures: 0 } }),
      );
    case `${NS}:inspirationGranted`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({
          ...actor,
          heroicInspiration: true,
        }),
      );
    case `${NS}:inspirationSpent`:
      return updateActor(
        state,
        payload(ActorOnlySchema, event).actor,
        (actor) => ({ ...actor, heroicInspiration: false }),
      );
    case `${NS}:goldSpent`: {
      const { gold } = payload(GoldSpentSchema, event);
      return {
        ...state,
        gold: Math.max(0, Math.round(((state.gold ?? 0) - gold) * 100) / 100),
      };
    }
    case `${NS}:treasureFound`: {
      const data = payload(TreasureFoundSchema, event);
      const found = updateActor(state, data.actor, (actor) => ({
        ...actor,
        inventory: [...actor.inventory, ...data.items],
        stowed: [...(actor.stowed ?? []), ...data.stowed],
      }));
      return {
        ...found,
        gold: Math.round(((state.gold ?? 0) + data.gold) * 100) / 100,
      };
    }
    case `${NS}:gearChanged`: {
      const data = payload(GearChangedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        stowed: data.stowed,
        attuned: data.attuned,
      }));
    }
    case `${NS}:traded`: {
      const data = payload(TradedSchema, event);
      const traded = updateActor(state, data.actor, (actor) => {
        if (data.bought) {
          return {
            ...actor,
            inventory: [...actor.inventory, data.item],
            ...(data.stowed
              ? { stowed: [...(actor.stowed ?? []), data.item] }
              : {}),
          };
        }
        // A copy in the pack goes before one worn, and attunement ends with the last copy.
        const inventory = without(actor.inventory, [data.item]);
        return {
          ...actor,
          inventory,
          ...(actor.stowed
            ? { stowed: without(actor.stowed, [data.item]) }
            : {}),
          ...(actor.attuned && !inventory.includes(data.item)
            ? { attuned: actor.attuned.filter((id) => id !== data.item) }
            : {}),
        };
      });
      const change = (data.bought ? -data.priceCp : data.priceCp) / 100;
      return {
        ...traded,
        gold: Math.round(((state.gold ?? 0) + change) * 100) / 100,
        ...(data.bought
          ? {
              shopBought: {
                ...state.shopBought,
                [data.merchant]: [
                  ...(state.shopBought?.[data.merchant] ?? []),
                  data.item,
                ],
              },
            }
          : {}),
      };
    }
    case `${NS}:answerSwapped`: {
      const data = payload(AnswerSwappedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        swaps: { ...actor.swaps, [data.key]: data.values },
        swapped: [...(actor.swapped ?? []), data.mark ?? data.key],
      }));
    }
    case `${NS}:weaponThrown`: {
      const data = payload(WeaponThrownSchema, event);
      const thrown = updateActor(state, data.by, (actor) => ({
        ...actor,
        inventory: without(actor.inventory, [data.item]),
      }));
      return thrown.combat
        ? {
            ...thrown,
            combat: {
              ...thrown.combat,
              dropped: [...(thrown.combat.dropped ?? []), data],
            },
          }
        : thrown;
    }
    case `${NS}:itemPickedUp`: {
      const data = payload(ItemPickedUpSchema, event);
      const found = state.combat?.dropped?.[data.index];
      if (!state.combat || !found) return state;
      const picked = updateActor(state, data.actor, (actor) => ({
        ...actor,
        inventory: [...actor.inventory, found.item],
        usedThisTurn: [...actor.usedThisTurn, PICKED_UP],
      }));
      return {
        ...picked,
        combat: {
          ...state.combat,
          dropped: state.combat.dropped?.filter(
            (_, index) => index !== data.index,
          ),
        },
      };
    }
    case `${NS}:itemUsed`: {
      const data = payload(ItemUsedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        inventory: without(actor.inventory, [data.item]),
      }));
    }
    case `${NS}:spellStored`: {
      const data = payload(SpellStoredSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        storedSpells: {
          ...actor.storedSpells,
          [data.item]: [
            ...(actor.storedSpells?.[data.item] ?? []),
            data.stored,
          ],
        },
      }));
    }
    case `${NS}:storedSpellUsed`: {
      const data = payload(StoredSpellUsedSchema, event);
      return updateActor(state, data.actor, (actor) => {
        const held = actor.storedSpells?.[data.item] ?? [];
        const at = held.findIndex((entry) => entry.spell === data.spell);
        return at < 0
          ? actor
          : {
              ...actor,
              storedSpells: {
                ...actor.storedSpells,
                [data.item]: held.filter((_, index) => index !== at),
              },
            };
      });
    }
    case `${NS}:restPassivesGained`: {
      const data = payload(RestPassivesSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        restPassives: [
          ...(actor.restPassives ?? []).filter(
            (entry) => entry.source !== data.source,
          ),
          { source: data.source, passives: data.passives },
        ],
      }));
    }
    case `${NS}:itemSkillPicked`: {
      const data = payload(ItemSkillSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        itemSkills: { ...actor.itemSkills, [data.item]: data.skill },
      }));
    }
    case `${NS}:poolRolled`: {
      const data = payload(PoolRolledSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        rolledPools: { ...actor.rolledPools, [data.resource]: data.amount },
      }));
    }
    case `${NS}:abilityRaised`: {
      const data = payload(AbilityRaisedSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        raised: {
          ...actor.raised,
          [data.ability]: (actor.raised?.[data.ability] ?? 0) + data.amount,
        },
      }));
    }
    // Uses are marks in usedThisTurn, which clears when the monster's own turn starts, as its uses come back.
    case `${NS}:legendaryActionTaken`: {
      const data = payload(LegendaryActionTakenSchema, event);
      return updateActor(state, data.actor, (actor) => ({
        ...actor,
        usedThisTurn: [
          ...actor.usedThisTurn,
          ...Array<string>(data.cost).fill(LEGENDARY_USE),
          ...(data.key ? [data.key] : []),
        ],
      }));
    }
    case `${NS}:legendaryResistanceUsed`: {
      const { actor: id } = payload(ActorOnlySchema, event);
      return updateActor(state, id, (actor) => ({
        ...actor,
        resourcesSpent: {
          ...actor.resourcesSpent,
          [LEGENDARY_RESISTANCE]:
            (actor.resourcesSpent[LEGENDARY_RESISTANCE] ?? 0) + 1,
        },
      }));
    }
    case `${NS}:surpriseSet`:
      return {
        ...state,
        surprise: payload(z.strictObject({ side: SurpriseSchema }), event).side,
      };
    default:
      return state;
  }
}
