import type { Damage } from "./schemas.ts";
import type { DndState } from "./state.ts";
import { distanceFeet, type Square, squareKey } from "./grid.ts";

// Areas a spell leaves on the map, as Darkness, Fog Cloud or Spike Growth do. Each is an effect on its caster, so
// it ends with the caster's Concentration or the caster's death.
// shortcut: a zone stays on the square it was cast at, even when the book lets it move with an object.

export type ZoneKind = "darkness" | "fog" | "thorns";

export interface Zone {
  readonly zone: ZoneKind;
  readonly at: Square;
  readonly radius: number;
  readonly damage?: readonly Damage[] | undefined;
}

export function zonesOf(state: DndState): readonly Zone[] {
  if (!state.combat) return [];
  return Object.values(state.actors).flatMap((actor) =>
    actor.activeEffects.flatMap(({ modifier }) =>
      modifier.kind === "zone" ? [modifier] : [],
    ),
  );
}

export const inZone = (zone: Zone, square: Square | null): boolean =>
  square !== null && distanceFeet(zone.at, square) <= zone.radius;

// The zone that hides a square, darkness before fog, or undefined.
export function obscuring(
  square: Square | null,
  state: DndState,
): ZoneKind | undefined {
  const zones = zonesOf(state).filter(
    (zone) => zone.zone !== "thorns" && inZone(zone, square),
  );
  return (zones.find((zone) => zone.zone === "darkness") ?? zones[0])?.zone;
}

// Squares a thorny zone covers, which cost double to walk through.
export function thornKeys(state: DndState): readonly string[] {
  const grid = state.combat?.grid;
  if (!grid) return [];
  return zonesOf(state).flatMap((zone) => {
    if (zone.zone !== "thorns") return [];
    const reach = Math.floor(zone.radius / 5);
    const keys: string[] = [];
    for (let x = zone.at.x - reach; x <= zone.at.x + reach; x += 1) {
      for (let y = zone.at.y - reach; y <= zone.at.y + reach; y += 1) {
        if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) {
          if (inZone(zone, { x, y })) keys.push(squareKey({ x, y }));
        }
      }
    }
    return keys;
  });
}

// The damage each square of a walk takes inside thorny zones, as Spike Growth's per 5 feet travelled there.
export function thornHits(
  path: readonly Square[],
  state: DndState,
): readonly Damage[] {
  const zones = zonesOf(state).filter((zone) => zone.zone === "thorns");
  return path.flatMap((square) =>
    zones.flatMap((zone) => (inZone(zone, square) ? (zone.damage ?? []) : [])),
  );
}
