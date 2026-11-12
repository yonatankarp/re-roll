import type { SystemEvent } from "#sdk";
import type { Ability, DamageType } from "./schemas.ts";
import { type Actor, NS, dndEvent } from "./state.ts";
import type { Stats } from "./stats.ts";

// Species traits and feats that change rolls combat makes, kept out of combat.ts behind one call each.

// Advantage on a save from a trait, such as Gnomish Cunning, or Brave against a save that would frighten.
export function traitSaveAdvantage(
  stats: Stats,
  ability: Ability,
  conditions: readonly string[],
): boolean {
  return stats.passives.some(
    (passive) =>
      passive.kind === "saveAdvantage" &&
      (passive.abilities.includes(ability) ||
        passive.conditions.some((condition) => conditions.includes(condition))),
  );
}

// The conditions a repeated save would end, so that a trait such as Fey Ancestry gives its Advantage there as well.
export function repeatSaveConditions(actor: Actor, sourceId: string): string[] {
  return actor.activeEffects.flatMap((effect) =>
    effect.sourceId === sourceId && effect.modifier.kind === "condition"
      ? [effect.modifier.condition]
      : [],
  );
}

// Relentless Endurance: a hit that would drop the target to 0 Hit Points, without killing it outright, leaves it
// at 1 instead and spends the trait's use. Null when it doesn't apply.
export function dropToOneEvents(
  target: Actor,
  amount: number,
  remaining: number,
  hit: { readonly type: DamageType; readonly critical: boolean },
  stats: Stats,
): SystemEvent[] | null {
  const outright = target.side === "party" && remaining >= stats.maxHp;
  if (target.hp <= 0 || remaining < 0 || outright) return null;
  const trait = stats.passives.find(
    (passive) =>
      passive.kind === "dropToOne" &&
      (target.resourcesSpent[passive.resource] ?? 0) <
        (stats.resources[passive.resource] ?? 0),
  );
  if (trait?.kind !== "dropToOne") return null;
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: target.id,
      resource: trait.resource,
    }),
    dndEvent(`${NS}:damaged`, {
      actor: target.id,
      amount: amount - remaining - 1,
      ...hit,
      massive: false,
    }),
  ];
}
