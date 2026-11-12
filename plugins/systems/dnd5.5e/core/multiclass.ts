// The Multiclass Spellcaster table, which is also a full caster's own slot table. Row n is caster level n.
const MULTICLASS_SLOTS: readonly (readonly number[])[] = [
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

const sameRow = (a: readonly number[], b: readonly number[]): boolean =>
  a.join() === b.join();

// A full caster's row is the table's row for its class level. Slots from a subclass (Eldritch Knight, Arcane
// Trickster) count a third of the class level, rounded down, and any other class (Paladin, Ranger) half, rounded up.
function casterLevel(caster: Caster): number {
  const { slots, level, subclass } = caster;
  if (!MULTICLASS_SLOTS.some((full) => sameRow(full, slots))) return 0;
  if (subclass) return Math.floor(level / 3);
  const full = MULTICLASS_SLOTS[level - 1];
  return full && sameRow(full, slots) ? level : Math.ceil(level / 2);
}

export interface Caster {
  readonly slots: readonly number[]; // the class's own slots at its level
  readonly level: number;
  readonly subclass: boolean; // the slots come from its subclass
}

// Slots from two or more classes with Spellcasting add their caster levels on the table above. With one
// casting class, or a row that isn't on it, there's no multiclass table to use. Pact Magic isn't Spellcasting,
// so the caller leaves a Warlock out.
// shortcut: Pact Magic and another class's slots don't make two pools, add one with Warlock multiclassing.
export function multiclassSlots(
  casters: readonly Caster[],
): readonly number[] | null {
  const levels = casters.map(casterLevel);
  if (levels.length < 2 || levels.some((level) => level === 0)) return null;
  const total = Math.min(
    MULTICLASS_SLOTS.length,
    levels.reduce((a, b) => a + b, 0),
  );
  return MULTICLASS_SLOTS[total - 1] ?? null;
}
