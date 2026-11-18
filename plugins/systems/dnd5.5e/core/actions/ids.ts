import { frame } from "../state.ts";
import { GRAPPLE_SOURCE, HIDE_SOURCE, MASTERY, TACTIC } from "../tactics.ts";

// The option ids of the actions in actions.ts, and the DCs they roll against.
export const DASH = `${TACTIC}dash`;
export const DISENGAGE = `${TACTIC}disengage`;
// The same as a Bonus Action, through Cunning Action or Nimble Escape.
export const BONUS_DASH = `${TACTIC}bonus-dash`;
export const BONUS_DISENGAGE = `${TACTIC}bonus-disengage`;
export const BONUS_HIDE = `${TACTIC}bonus-hide`;
export const BONUS_DODGE = `${TACTIC}bonus-dodge`;
export const BONUS_SEARCH = `${TACTIC}bonus-search`;
export const BONUS_STUDY = `${TACTIC}bonus-study`;
export const BONUS_HELP = `${TACTIC}bonus-help`;
export const DODGE = `${TACTIC}dodge`;
export const HIDE = HIDE_SOURCE;
export const SEARCH = `${TACTIC}search`;
export const STUDY = `${TACTIC}study`;
export const STUDY_IMAGE = `${TACTIC}study-image`;
export const STUDY_PHANTASM = `${TACTIC}study-phantasm`;
export const HELP = `${TACTIC}help`;
export const GRAPPLE = GRAPPLE_SOURCE;
export const SHOVE = `${TACTIC}shove`;
export const READY = `${TACTIC}ready`;
export const STAND = `${TACTIC}stand`;
// Going up or down 10 feet: `rise:fly`, `sink:climb` and the like (combat/falling.ts).
export const RISE = `${TACTIC}rise`;
export const SINK = `${TACTIC}sink`;
export const ESCAPE = `${TACTIC}escape`;
// Freedom of Movement's escape from a grapple, for 5 feet of movement.
export const SLIP = `${TACTIC}slip`;
export const BREAK_OUT = `${TACTIC}break-out`;
export const OFFHAND = `${TACTIC}offhand`;
export const POLE_STRIKE = `${TACTIC}pole-strike`;
export const HEW = `${TACTIC}hew`;
export const MOVE_HURT = "move-hurt:";
export const OFFHAND_USED = "offhand";
export const NICK_USED = `${MASTERY}nick`;
export const CLEAVE_USED = `${MASTERY}cleave`;
export const HIDE_DC = 15;
export const STABILIZE_DC = 10;
export const STUDY_DC = 15;

export const CHECK_END = frame("checkCombatEnd", {});
