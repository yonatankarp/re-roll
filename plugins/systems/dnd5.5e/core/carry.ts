import type { ContentAccess } from "#sdk";
import { ItemSchema, type Species } from "./schemas.ts";
import { type Actor, without } from "./state.ts";

// 2024 rules: Strength times a factor for size.
const CAPACITY_PER_STRENGTH: Readonly<Record<Species["size"], number>> = {
  tiny: 7.5,
  small: 15,
  medium: 15,
  large: 30,
};

const SIZES = ["tiny", "small", "medium", "large"] as const;

// `larger` counts the bearer one size up, as Powerful Build does; past Large, Huge counts 60 to the point.
export function carryingCapacity(
  strength: number,
  size: Species["size"],
  larger = false,
): number {
  const up = larger ? SIZES[SIZES.indexOf(size) + 1] : size;
  return strength * (up ? CAPACITY_PER_STRENGTH[up] : 60);
}

// shortcut: coins weigh nothing (the book has 50 to the pound); count them if a hoard ever matters.
export function carriedWeight(actor: Actor, access: ContentAccess): number {
  const weigh = (ids: readonly string[]) =>
    ids.reduce((total, id) => {
      const item = ItemSchema.safeParse(access.content(id));
      return total + (item.success ? (item.data.weightLb ?? 0) : 0);
    }, 0);
  // What's in the pack goes in a Bag of Holding or onto a Floating Disk, weightless up to what they hold.
  const holders = actor.inventory.filter((id) => holdsOf(id, access) > 0);
  const packed = without(actor.stowed ?? [], holders);
  return (
    weigh(actor.inventory) -
    Math.min(weigh(packed), holding(actor, holders, access))
  );
}

function holdsOf(id: string, access: ContentAccess): number {
  const item = ItemSchema.safeParse(access.content(id)).data;
  return item?.type === "magicItem"
    ? (item.passives ?? []).reduce(
        (sum, passive) =>
          passive.kind === "modifier" && passive.modifier.kind === "holds"
            ? sum + passive.modifier.pounds
            : sum,
        0,
      )
    : 0;
}

// Pounds held for the bearer, by the items carried and the effects on it.
function holding(
  actor: Actor,
  holders: readonly string[],
  access: ContentAccess,
): number {
  return (
    holders.reduce((sum, id) => sum + holdsOf(id, access), 0) +
    actor.activeEffects.reduce(
      (sum, { modifier }) =>
        modifier.kind === "holds" ? sum + modifier.pounds : sum,
      0,
    )
  );
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

// The Encumbrance variant rule (variant-rules.ts): over 5 times Strength, a third of a Medium creature's capacity, the
// bearer is encumbered (1), and over 10 times, heavily encumbered (2). Measured against capacity, size counts as it does.
export function encumbrance(carried: number, capacity: number): 0 | 1 | 2 {
  if (carried > (capacity * 2) / 3) return 2;
  return carried > capacity / 3 ? 1 : 0;
}
