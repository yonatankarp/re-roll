// Combat lives in core/combat/ and core/policy.ts. This barrel keeps the names other modules import from here.
export {
  AIM,
  ALL,
  CREATE_CHARACTER,
  HIT_DICE,
  MOVE,
  PASS,
} from "./combat/ids.ts";
export {
  allies,
  canAfford,
  CHECK_END,
  combatEnded,
  type Context,
  enemies,
  fitsType,
  hasFlag,
  meleeReach,
  moveSquares,
  reaches,
  rollBonus,
  speedLeft,
  squareName,
  within5,
} from "./combat/queries.ts";
export { nextDndDecision } from "./combat/decisions.ts";
export { startCombat } from "./combat/start.ts";
export {
  concentrationFrame,
  damageEvents,
  dealEvents,
  effectEnds,
  resolveAction,
  resolveTargets,
  rollSave,
} from "./combat/effects.ts";
export {
  AimSchema,
  PickSchema,
  runAimArea,
  runPickTargets,
  runTakeAction,
  TakeActionSchema,
} from "./combat/actions.ts";
export {
  AfterHitSchema,
  AttackSchema,
  ConcentrationSchema,
  HitSchema,
  ReactionSchema,
  runAfterHit,
  runAfterReaction,
  runApplyHit,
  runAttackRoll,
  runConcentrationSave,
  runProjectile,
  runRecheckHit,
  runSmite,
  SmiteSchema,
} from "./combat/attack.ts";
export {
  FinishMoveSchema,
  meleeReachOf,
  MoveSchema,
  provokers,
  runFinishMove,
  runMove,
} from "./combat/movement.ts";
export {
  LingeringSchema,
  runAdvanceTurn,
  runAfterAction,
  runAfterTurnStart,
  runCheckCombatEnd,
  runEndTurn,
  runFinishTurn,
  runLingeringTick,
} from "./combat/turn.ts";
export { shortRestEvents } from "./rest.ts";
export { choosePolicy, stepToward } from "./policy.ts";
