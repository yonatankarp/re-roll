import { deriveStats } from "../../stats.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  mountOf,
  isDown,
  NS,
} from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { distanceFeet, type Square } from "../../grid.ts";
import { type Context, hasPassive } from "../queries.ts";

// Pushes and pulls, and what holds a creature in place against them.

// A push along the ground made shorter by the target's Reaction, as Dwarven Plate's 10 feet less: the feet it's
// still moved, and the Reaction spent. shortcut: the Reaction is always taken when it can be.
export function braced(
  target: Actor,
  feet: number,
  context: Pick<Context, "state" | "content" | "contentIds">,
): { readonly feet: number; readonly events: SystemEvent[] } {
  const brace = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "bracing",
  );
  if (
    brace?.kind !== "bracing" ||
    !target.budget.reaction ||
    isDown(target) ||
    hasCondition(target, ...INCAPACITATING)
  ) {
    return { feet, events: [] };
  }
  return {
    feet: Math.max(0, feet - brace.feet),
    events: [
      dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    ],
  };
}

// Tyro of the Gauntlet's Stand as One: an ally within 5 feet spends its Reaction to keep the target from being moved.
export function heldInPlace(
  target: Actor,
  context: Pick<Context, "state" | "content" | "contentIds">,
): SystemEvent[] {
  if (hasCondition(target, ...INCAPACITATING)) return [];
  // A Saddle of the Cavalier's Secure Rider: nothing moves its rider off its mount.
  if (
    mountOf(target) !== null &&
    hasPassive(deriveStats(target, context), "protectedMount")
  ) {
    return [
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: target.id,
        key: "secure-rider",
      }),
    ];
  }
  const guard = Object.values(context.state.actors).find(
    (other) =>
      other.id !== target.id &&
      other.side === target.side &&
      other.budget.reaction &&
      !isDown(other) &&
      !hasCondition(other, ...INCAPACITATING) &&
      distanceFeet(other.position, target.position) <= 5 &&
      hasPassive(deriveStats(other, context), "standAsOne"),
  );
  return guard
    ? [
        dndEvent(`${NS}:budgetSpent`, {
          actor: guard.id,
          kind: "reaction",
          label: "Stand as One",
        }),
      ]
    : [];
}

// The square a creature is pushed away from to go north, south, east or west, by a d4's 1 to 4, as Infestation moves
// it. shortcut: a creature that can't move or has no Speed is moved all the same.
export function randomFrom(target: Actor, face: number): Square | null {
  const at = target.position;
  if (!at) return null;
  const [dx, dy] = [
    [0, 1],
    [0, -1],
    [-1, 0],
    [1, 0],
  ][face - 1] ?? [0, 1];
  return { x: at.x + (dx ?? 0), y: at.y + (dy ?? 0) };
}
