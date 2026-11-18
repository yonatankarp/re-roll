// What an action does once it lands: paying its costs, saving throws, damage, conditions and the other effects.
// Each family of effects has its own module in effects/; this module re-exports them for their importers.

export { payCosts } from "./effects/costs.ts";
export { concentrationFrame } from "./effects/concentration.ts";
export { lingersFor, effectEnds, actingEnds } from "./effects/lasting.ts";
export {
  DAMAGE_TO_PARTY,
  damageToParty,
  damageEvents,
  ENDURED,
  burstEvents,
  dealEvents,
  siphoned,
} from "./effects/damage.ts";
export { leastResisted, typeAgainst, retyped } from "./effects/damage-types.ts";
export { downedEvents, incapacitatedEvents } from "./effects/zero-hp.ts";
export {
  tempHpBonus,
  sharedHealing,
  poolHealing,
  stopRegains,
} from "./effects/healing.ts";
export { rollSave, naturalOneEvents } from "./effects/saves.ts";
export { braced, heldInPlace } from "./effects/forced-movement.ts";
export { protectedMount, retributionEvents } from "./effects/magic-items.ts";
export {
  damageRiders,
  tacticRiderEvents,
  alliesRiderEvents,
} from "./effects/riders.ts";
export { channelEvents, leafEvents } from "./effects/leaf.ts";
export { zoneEvents } from "./effects/spell-zones.ts";
export { aimSquare, resolveTargets } from "./effects/targets.ts";
export { commandedFamiliar, resolveAction } from "./effects/resolution.ts";
export { reactionMove } from "./effects/forced-reactions.ts";
export { multiattackExtras } from "./effects/multiattack.ts";
