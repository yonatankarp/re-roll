// Armor Class: the best of the ways a creature works it out, and armor's own bonus.
import type { Actor } from "../state.ts";
import type { AbilityScores, Passive } from "../schemas.ts";
import { passiveModifiers } from "./model.ts";
import { abilityModifier } from "./abilities.ts";

export function bestAc(
  actor: Actor,
  abilities: AbilityScores,
  context: {
    armorBases: readonly number[];
    flatBonus: number;
    passives: readonly Passive[];
    armorTypes?: readonly string[]; // the armor worn: none for a monster's printed AC
    shielded?: boolean;
    proficiency?: number;
  },
): number {
  const dex = abilityModifier(abilities.dex);
  const armorTypes = context.armorTypes ?? [];
  // Only one way of calculating AC applies at a time, so the best one is used.
  const bases = [10 + dex, ...context.armorBases];
  const fixed = passiveModifiers(context.passives);
  // shortcut: Mage Armor's rule about not wearing armor isn't checked, since the best calculation wins anyway.
  for (const modifier of [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...fixed,
  ]) {
    if (modifier.kind !== "acFormula") continue;
    if (modifier.unarmored && armorTypes.length > 0) continue;
    if (modifier.noShield && context.shielded) continue;
    const { base, add } = modifier.formula;
    bases.push(
      add.reduce(
        (total, term) =>
          term.kind === "abilityMod"
            ? total + abilityModifier(abilities[term.ability])
            : total,
        base,
      ),
    );
  }
  // A flat AC bonus, its ability modifiers worked out, as Bladesong's Intelligence; one tied to armor only with it on.
  const flat = (
    modifier: Actor["activeEffects"][number]["modifier"],
  ): number | null => {
    if (
      modifier.kind !== "bonus" ||
      modifier.to !== "ac" ||
      modifier.melee ||
      modifier.ranged ||
      (modifier.armor === "any" && armorTypes.length === 0) ||
      (modifier.armor === "heavy" && !armorTypes.includes("heavy"))
    ) {
      return null;
    }
    const formula = modifier.amount.bonus;
    if (!formula) return 0;
    const sum = formula.add.reduce(
      (total, term) =>
        term.kind === "abilityMod"
          ? total + abilityModifier(abilities[term.ability])
          : term.kind === "proficiency"
            ? total + (context.proficiency ?? 0)
            : total,
      formula.base,
    );
    return formula.min === undefined ? sum : Math.max(formula.min, sum);
  };
  let bonus = fixed.reduce(
    (total, modifier) => total + (flat(modifier) ?? 0),
    context.flatBonus,
  );
  const seen = new Set<string>();
  for (const effect of actor.activeEffects) {
    const amount = flat(effect.modifier);
    if (amount !== null) {
      if (!seen.has(effect.sourceId)) bonus += amount;
      seen.add(effect.sourceId);
    }
  }
  return Math.max(...bases) + bonus;
}

// A magic armor's or Shield's own bonus to AC, which an Antimagic Field, or not being attuned where it needs it,
// suppresses.
export function ownAc(
  bonuses: readonly { to: string; amount: number }[] | undefined,
  suppressed: boolean,
): number {
  if (suppressed) return 0;
  return (bonuses ?? [])
    .filter((bonus) => bonus.to === "ac")
    .reduce((total, bonus) => total + bonus.amount, 0);
}
