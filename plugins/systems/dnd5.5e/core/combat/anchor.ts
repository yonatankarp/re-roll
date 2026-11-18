import type { SystemEvent } from "#sdk";
import { distanceFeet, type Square } from "../grid.ts";
import type { LeafEffect, Resolution } from "../schemas.ts";
import { type Actor, dndEvent, NS } from "../state.ts";
import type { KnownAction } from "../stats.ts";

// Objects a spell keeps on the map and acts from (activation `anchor`), as Spiritual Weapon's force, Mordenkainen's
// Sword or Bigby's Hand: the object moves to the creature it acts on, and its reach counts from there.

// The spell whose object an action acts from: its own, or the spell a lasting or sphere action belongs to.
export function anchorSource(action: KnownAction): string {
  if (action.id.startsWith("lasting:")) {
    return `spell:${action.id.slice("lasting:".length)}`;
  }
  const sphere = /^spheres:(.+):\d+$/.exec(action.id);
  return sphere?.[1] ?? action.id;
}

// Where the bearer's object for this action stands now, or null before it's placed.
export function anchorAt(actor: Actor, action: KnownAction): Square | null {
  const source = anchorSource(action);
  for (const { sourceId, modifier } of actor.activeEffects) {
    if (sourceId === source && modifier.kind === "zone") return modifier.at;
  }
  return null;
}

// Whether the object can get within reach of `at`: it moves, or is placed, up to its `moves` first.
export function anchorReaches(
  actor: Actor,
  action: KnownAction,
  at: Square | null,
): boolean {
  const anchor = action.activation.anchor;
  if (!anchor) return false;
  const from = anchorAt(actor, action) ?? actor.position;
  return distanceFeet(from, at) <= anchor.moves + anchor.reach;
}

// Where the object goes to act on `target`: where it is when that's within reach, else the square nearest it within
// reach of the target and within its move.
export function anchorSquare(
  actor: Actor,
  action: KnownAction,
  target: Square,
  grid: { readonly width: number; readonly height: number },
): Square | null {
  const anchor = action.activation.anchor;
  const from = anchorAt(actor, action) ?? actor.position;
  if (!anchor || !from) return null;
  if (distanceFeet(from, target) <= anchor.reach && anchorAt(actor, action)) {
    return from;
  }
  const steps = Math.floor(anchor.reach / 5);
  let best: Square | null = null;
  for (let dx = -steps; dx <= steps; dx += 1) {
    for (let dy = -steps; dy <= steps; dy += 1) {
      const square = { x: target.x + dx, y: target.y + dy };
      if (square.x < 0 || square.y < 0) continue;
      if (square.x >= grid.width || square.y >= grid.height) continue;
      if (square.x === target.x && square.y === target.y) continue;
      if (distanceFeet(square, target) > anchor.reach) continue;
      if (distanceFeet(square, from) > anchor.moves) continue;
      if (!best || distanceFeet(square, from) < distanceFeet(best, from)) {
        best = square;
      }
    }
  }
  return best;
}

// The zone leaves an anchored action places as its object, wherever they sit in its resolution.
export function anchorLeaves(resolution: Resolution): LeafEffect[] {
  const leaves =
    resolution.kind === "automatic"
      ? resolution.effects
      : resolution.kind === "save"
        ? [...resolution.onFail, ...resolution.onSuccess]
        : [...resolution.onHit, ...resolution.onMiss];
  return leaves.filter((effect) => effect.kind === "zone");
}

// Moving the object that's already there.
export const anchorMoved = (
  actor: Actor,
  action: KnownAction,
  to: Square,
): SystemEvent[] => {
  const at = anchorAt(actor, action);
  return at && (at.x !== to.x || at.y !== to.y)
    ? [
        dndEvent(`${NS}:zoneMoved`, {
          actor: actor.id,
          sourceId: anchorSource(action),
          to,
        }),
      ]
    : [];
};
