// A creature's derived stats, split by concept into the modules in ./stats/ and re-exported here.

export {
  lookup,
  maybeLookup,
  featureOf,
  circleOptions,
} from "./stats/content.ts";
export type { KnownAction, Stats } from "./stats/model.ts";
export { passiveModifiers } from "./stats/model.ts";
export {
  abilityModifier,
  proficiencyBonus,
  ownAbilities,
  buildAbilities,
} from "./stats/abilities.ts";
export { doesSomething } from "./stats/resolution.ts";
export { cantripTier, scaleActivation } from "./stats/scaling.ts";
export {
  exhaustionOf,
  modifierFor,
  spellModifier,
  attackBonus,
  saveBonus,
  checkBonus,
  scoreFloor,
  spellAttackBonus,
  spellSaveDc,
} from "./stats/bonuses.ts";
export { atSlotLevel, evaluateFormula } from "./stats/formulas.ts";
export {
  diceCount,
  rollDiceNotation,
  scaledDice,
  rerollingOnes,
  rollAmount,
  rollExploding,
} from "./stats/dice.ts";
export {
  traitCantrips,
  latePickKey,
  spellNamed,
  onList,
  onClassList,
} from "./stats/spell-lists.ts";
export { castsSilently } from "./stats/spell-changes.ts";
export {
  chargesOf,
  withItemNumbers,
  itemHealing,
  boundNumbers,
} from "./stats/items.ts";
export {
  weaponProficient,
  imbuedRange,
  UNARMED_STRIKE,
  weaponActivation,
  weaponAttackOf,
  weaponFits,
} from "./stats/weapons.ts";
export { pickedVariants, withVariant } from "./stats/features.ts";
export { auraBuilds, ownFirstTurn } from "./stats/character.ts";
export { livingHeads } from "./stats/monsters.ts";
export { MOVE_ZONE, JUMP_BOOST, hasSteadySpeed } from "./stats/movement.ts";
export { grantedKey, wishedKey } from "./stats/effect-actions.ts";
export { deriveStats, bareSpell } from "./stats/derive.ts";
export { immuneToCondition, damageResponses } from "./stats/resistances.ts";
