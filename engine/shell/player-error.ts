// An error whose message is written for the player, so the shell shows it as it is.
// Any other error shows a friendly line, with its own message folded away under Details.
export class PlayerError extends Error {}
