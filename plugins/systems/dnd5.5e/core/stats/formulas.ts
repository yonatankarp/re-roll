// Formulas worked out from a creature's stats, and slot-level terms.
import type { Formula } from "../schemas.ts";
import type { Stats } from "./model.ts";
import { modifierFor, spellModifier, spellSaveDc } from "./bonuses.ts";

// Effects with their `slotLevel` terms worked out for a cast with this slot.
export function atSlotLevel<T>(value: T, slot: number): T {
  return slotted(value, slot) as T;
}

function slotted(value: unknown, slot: number): unknown {
  if (Array.isArray(value)) return value.map((item) => slotted(item, slot));
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, slotted(item, slot)]),
  );
  const terms: unknown[] = Array.isArray(copy.add) ? copy.add : [];
  const isSlot = (term: unknown) =>
    typeof term === "object" &&
    term !== null &&
    "kind" in term &&
    term.kind === "slotLevel";
  const count = terms.filter(isSlot).length;
  return count === 0
    ? copy
    : {
        ...copy,
        base: (typeof copy.base === "number" ? copy.base : 0) + count * slot,
        add: terms.filter((term) => !isSlot(term)),
      };
}

export function evaluateFormula(formula: Formula, stats: Stats): number {
  let total = formula.base;
  for (const term of formula.add) {
    switch (term.kind) {
      case "abilityMod":
        total += modifierFor(stats, term.ability);
        break;
      case "proficiency":
        total += stats.proficiency;
        break;
      case "classLevel":
        total +=
          (term.roundUp ? Math.ceil : Math.floor)(
            (stats.classLevels[term.class] ?? 0) / (term.half ? 2 : 1),
          ) * (term.times ?? 1);
        break;
      case "level":
        total += term.half ? Math.floor(stats.level / 2) : stats.level;
        break;
      case "scaling":
        total += stats.scaling[term.key] ?? 0;
        break;
      case "bestAbilityMod":
        total += Math.max(
          ...term.abilities.map((ability) => modifierFor(stats, ability)),
        );
        break;
      case "spellMod":
        total += term.ability
          ? modifierFor(stats, term.ability)
          : spellModifier(stats);
        break;
      case "spellSaveDc":
        total += term.ability
          ? 8 +
            stats.proficiency +
            modifierFor(stats, term.ability) +
            stats.itemBonuses.spellDc
          : spellSaveDc(stats);
        break;
      case "maxHp":
        total += term.half ? Math.floor(stats.maxHp / 2) : stats.maxHp;
        break;
      case "abilityScore":
        total += Math.max(
          ...term.abilities.map((ability) => stats.abilities[ability]),
        );
        break;
      case "dealt": // filled in by the reaction it's part of
      case "slotLevel": // filled in by the cast it's part of (atSlotLevel)
        break;
      default:
        term satisfies never;
    }
  }
  return formula.min === undefined ? total : Math.max(total, formula.min);
}
