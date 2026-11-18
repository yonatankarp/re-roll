import { ContentIdSchema } from "#sdk";
import { z } from "zod";
import { AbilitySchema, DamageTypeSchema } from "./basics.ts";

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
  times: z.number().int().min(2).optional(), // what the dice roll counts this many times, as Mantle of Inspiration's two
});
export type Amount = z.infer<typeof AmountSchema>;

export const SizeSchema = z.enum([
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
