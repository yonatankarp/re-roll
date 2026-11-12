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

// A class's own slot row is a row of the full caster's table, whose number is that class's caster level:
// a Paladin 5 has the row of caster level 3, an Eldritch Knight 3 the row of caster level 1.
// Some rows repeat (11-12, 13-14, 15-16), and only a full caster reaches them, whose caster level is its class level.
function casterLevel(row: readonly number[], classLevel: number): number {
  const first = MULTICLASS_SLOTS.findIndex(
    (full) => full.join() === row.join(),
  );
  const last = MULTICLASS_SLOTS.findLastIndex(
    (full) => full.join() === row.join(),
  );
  return first < 0 ? 0 : Math.max(first, Math.min(classLevel - 1, last)) + 1;
}

// Slots from two or more classes with Spellcasting add their caster levels on the table above. With one
// casting class, or a row that isn't on it (such as Pact Magic), there's no multiclass table to use.
// shortcut: Pact Magic and another class's slots don't make two pools, add one with Warlock multiclassing.
export function multiclassSlots(
  casters: readonly {
    readonly slots: readonly number[];
    readonly level: number;
  }[],
): readonly number[] | null {
  const levels = casters.map((item) => casterLevel(item.slots, item.level));
  if (levels.length < 2 || levels.some((level) => level === 0)) return null;
  const total = Math.min(
    MULTICLASS_SLOTS.length,
    levels.reduce((a, b) => a + b, 0),
  );
  return MULTICLASS_SLOTS[total - 1] ?? null;
}
