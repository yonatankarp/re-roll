import {
  type ActiveEffect,
  type Actor,
  dndEvent,
  isDead,
  isDown,
  isStable,
  NS,
} from "../state.ts";
import { type SystemEvent } from "#sdk";

// At 0 HP and still making death saves.
export function dyingNow(actor: Actor): boolean {
  return (
    actor.side === "party" &&
    isDown(actor) &&
    !isDead(actor) &&
    !isStable(actor)
  );
}

export function effect(
  actor: string,
  sourceId: string,
  casterId: string,
  modifier: ActiveEffect["modifier"],
  ends: ActiveEffect["ends"],
  more: Pick<ActiveEffect, "repeatSave"> = {},
): SystemEvent {
  return dndEvent(`${NS}:effectAdded`, {
    actor,
    effect: { sourceId, casterId, modifier, ends, ...more },
  });
}

export function standing(list: readonly Actor[]): readonly Actor[] {
  return list.filter((item) => !isDown(item));
}

export function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}
