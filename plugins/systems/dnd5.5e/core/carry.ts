import type { ContentAccess } from "#sdk";
import { ItemSchema, type Species } from "./schemas.ts";
import type { Actor } from "./state.ts";

// 2024 rules: Strength times a factor for size.
const CAPACITY_PER_STRENGTH: Readonly<Record<Species["size"], number>> = {
  tiny: 7.5,
  small: 15,
  medium: 15,
  large: 30,
};

export function carryingCapacity(
  strength: number,
  size: Species["size"],
): number {
  return strength * CAPACITY_PER_STRENGTH[size];
}

// shortcut: coins weigh nothing (the book has 50 to the pound); count them if a hoard ever matters.
export function carriedWeight(actor: Actor, access: ContentAccess): number {
  return actor.inventory.reduce((total, id) => {
    const item = ItemSchema.safeParse(access.content(id));
    return total + (item.success ? (item.data.weightLb ?? 0) : 0);
  }, 0);
}

// Past capacity the load can only be dragged, at a Speed of no more than 5 feet, and past twice it, not at all.
export function encumberedSpeed(
  speed: number,
  carried: number,
  capacity: number,
): number {
  if (carried > capacity * 2) return 0;
  return carried > capacity ? Math.min(speed, 5) : speed;
}
