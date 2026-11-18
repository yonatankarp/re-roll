import { ContentEntrySchema, ContentIdSchema } from "#sdk";
import { z } from "zod";
import { ActivationSchema, TableSchema } from "./activation.ts";
import {
  AbilitySchema,
  AutomationSchema,
  CreatureTypeSchema,
  DamageTypeSchema,
  SkillSchema,
  SpellSchoolSchema,
  WeaponMasterySchema,
  WeaponPropertySchema,
} from "./basics.ts";
import { AmountSchema, DamageSchema, DiceSchema, SizeSchema } from "./dice.ts";
import {
  LeafEffectSchema,
  NaturalTwentySchema,
  OnHitSaveSchema,
} from "./effects.ts";
import { ResourceDefSchema } from "./features.ts";
import { ObstacleSchema } from "./modifiers.ts";
import { PassiveSchema } from "./passives.ts";

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
  stealthDisadvantage: z.literal(true).optional(), // Disadvantage on Dexterity (Stealth) checks while worn
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
