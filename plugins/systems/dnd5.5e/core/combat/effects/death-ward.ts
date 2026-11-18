import { type Actor, dndEvent, NS } from "../../state.ts";
import { type SystemEvent } from "#sdk";

// Death Ward negating an effect that would kill outright.

// Death Ward: an effect that would kill its bearer outright without damage is negated, and the ward ends.
// shortcut: a Wail of the Banshee it negates still calls for the save its other targets make.
export const warded = (target: Actor): boolean =>
  target.activeEffects.some(({ modifier }) => modifier.kind === "deathWard");

export const wardBroken = (target: Actor): SystemEvent[] =>
  target.activeEffects
    .filter(({ modifier }) => modifier.kind === "deathWard")
    .map(({ sourceId }) =>
      dndEvent(`${NS}:effectEnded`, { actor: target.id, sourceId }),
    );
