import { z } from "zod";

export const AttackSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
  noModifier: z.boolean().optional(), // an off-hand or Cleave attack, whose damage leaves out the ability modifier
  poleStrike: z.boolean().optional(), // Polearm Master's attack with the other end: a d4 of Bludgeoning
  // The d20 already rolled, held while a reaction to it was decided (combat/reactions.ts): its natural, the bonus
  // the roll had, what reactions added, and whether it had Advantage or Disadvantage.
  rolled: z
    .object({
      natural: z.number(),
      base: z.number(),
      bonus: z.number(),
      advantage: z.boolean(),
      disadvantage: z.boolean(),
    })
    .optional(),
  passed: z.array(z.string()).optional(), // creatures that already answered the roll or turned it down
  strikes: z.array(z.string()).optional(), // strike options picked in place of the roll's Advantage, as Brutal Strike's
  hits: z.boolean().optional(), // it hits outright, as a missed attack Redirect Attack turns on another creature
  leapt: z.array(z.string()).optional(), // the creatures a leaping attack struck before this one, as Chromatic Orb's
  spell: z.string().optional(), // the spell source whose weapon attack this is, as Booming Blade's
  overcomes: z.boolean().optional(), // its damage ignores Resistance and Immunity, as a Sword of Answering's answer
  advantaged: z.boolean().optional(), // a strike option picked gives the roll Advantage, as a Martialist's Trip
  fixed: z.number().int().min(1).max(20).optional(), // the d20 shows this, unrolled, as a Clockwork Amulet's 10
});

export const HitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  hadAdvantage: z.boolean(),
  hadDisadvantage: z.boolean().optional(), // older saves' hits have none
  total: z.number(),
  natural: z.number(),
  slotLevel: z.number().optional(),
  halve: z.boolean().optional(), // set by a reaction like Uncanny Dodge
  reduceBy: z.number().optional(), // set by a reaction like Deflect Attacks
  acBonus: z.number().optional(), // set by a reaction like Parry, against this hit only
  noModifier: z.boolean().optional(),
  poleStrike: z.boolean().optional(),
  riposte: z.string().optional(), // the attack the target makes back if this now misses, as with Riposte ("" for its weapon)
  riposter: z.string().optional(), // who makes it, when not the target, as Glorious Defense's paladin
  kept: z.boolean().optional(), // a spell to take the hit's place, as Lightning Arrow, was already offered
  forgone: z.number().optional(), // Sneak Attack dice given up for strike options, as Cunning Strike's
  hidden: z.number().optional(), // the Stealth total the attacker was hidden with, for Supreme Sneak's Stealth Attack
  strikes: z.array(z.string()).optional(), // the strike options chosen for this hit, resolved after its damage
  deflect: z.string().optional(), // the reaction that sends the force back out if the damage drops to 0, as Deflect Missile
  echo: z.string().optional(), // the target's reaction whose save the attacker makes once the damage lands, as Elemental Rebuke's
  transfer: z.string().optional(), // the creature that takes what a reaction took off, as Transfer Harm's podling
  leapt: z.array(z.string()).optional(), // as the attack's
  spell: z.string().optional(), // as the attack's
  overcomes: z.boolean().optional(), // as the attack's
});
