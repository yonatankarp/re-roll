// Attack rolls and what follows a hit: reactions, damage, riders, smites and concentration saves, one module per
// step in combat/attack/. ranged-smite.ts and spell-riders.ts import this barrel, which loads frames.ts last, so
// code outside combat/attack/ imports from here rather than from a module in it.

export { AttackSchema, HitSchema } from "./attack/payloads.ts";
export { runProjectile } from "./attack/projectile.ts";
export {
  RollReactionSchema,
  runRollReaction,
} from "./attack/roll-reactions.ts";
export {
  runAttackRoll,
  AdvantageForgoneSchema,
  runAdvantageForgone,
  runAdvantageGained,
} from "./attack/attack-roll.ts";
export {
  ReactionSchema,
  runAfterReaction,
  runRecheckHit,
} from "./attack/hit-reactions.ts";
export { missOutcome, runMissRider } from "./attack/miss.ts";
export { distracted } from "./attack/advantage.ts";
export {
  runApplyHit,
  runCriticalChosen,
  StrikeChosenSchema,
  runStrikeChosen,
} from "./attack/hit.ts";
export {
  AfterHitSchema,
  runAfterHit,
  SmiteSchema,
  runSmite,
} from "./attack/smite.ts";
export {
  ConcentrationSchema,
  runConcentrationSave,
} from "./attack/concentration.ts";
export { attackFrames } from "./attack/frames.ts";
