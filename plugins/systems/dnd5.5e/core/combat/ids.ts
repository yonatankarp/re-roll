// The ids of combat's options and decisions, shared by core, the UI and the tests.
// Saves store answers by these ids, so their format must not change.

export const PASS = "pass";
export const CREATE_CHARACTER = "create";
export const HIT_DICE = "hitDice";
export const DEATH_SAVE = "deathSave";
export const SEPARATOR = "|"; // between an option id's action, target and slot
export const ALL = "all"; // an area takes everyone, and projectiles go for the lowest HP
export const DECLINE = "decline";
export const MOVE = "move"; // the turn option that asks where to go
export const STAY = "stay";
export const ITEM_PREFIX = "item:"; // an action that uses up the item, such as a potion
export const AIM = "@"; // an area aimed at a square ("@x,y") or a creature ("@" and its id)
export const SQUARE = /^(\d+),(\d+)$/; // a move or aim option's id

// "action|target|slot" for a turn option; decisions that follow one up add their own parts.
export function encodeOption(...parts: readonly (string | number)[]): string {
  return parts.map(String).join(SEPARATOR);
}

export function parseOption(id: string): readonly string[] {
  return id.split(SEPARATOR);
}
