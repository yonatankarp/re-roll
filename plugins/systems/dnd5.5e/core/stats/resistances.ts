// Resistances, immunities and vulnerabilities to damage and conditions.
import type { ContentAccess } from "#sdk";
import { type Actor, type DndState, hasCondition } from "../state.ts";
import { lightAt } from "../sight.ts";
import { DAMAGE_TYPES, type Condition, type DamageType } from "../schemas.ts";
import { zoneModifiers } from "../zones.ts";
import { type Stats, passiveModifiers } from "./model.ts";
import { deriveStats } from "./derive.ts";

export function immuneToCondition(stats: Stats, condition: Condition): boolean {
  return stats.passives.some(
    (passive) =>
      passive.kind === "conditionImmunity" && passive.condition === condition,
  );
}

export function damageResponses(
  actor: Actor,
  access: ContentAccess & { readonly state?: DndState },
): {
  readonly adjustments: readonly number[];
  readonly resistances: readonly DamageType[];
  readonly vulnerabilities: readonly DamageType[];
  readonly immunities: readonly DamageType[];
  readonly absorbs: readonly DamageType[];
} {
  const resistances: DamageType[] = [];
  const vulnerabilities: DamageType[] = [];
  const immunities: DamageType[] = [];
  // Petrified gives Resistance to all damage.
  if (hasCondition(actor, "petrified")) resistances.push(...DAMAGE_TYPES);
  const stats = deriveStats(actor, access);
  // Resistance to all but some types while Bloodied, or in Dim Light or Darkness, as Boon of Desperate Resilience or
  // Boon of the Night Spirit's Shadowy Form gives.
  for (const passive of stats.passives) {
    if (passive.kind !== "resistAll") continue;
    const active =
      passive.while === "bloodied"
        ? actor.hp * 2 <= stats.maxHp
        : access.state !== undefined &&
          lightAt(actor.position, access.state, access) !== "bright";
    if (active) {
      resistances.push(
        ...DAMAGE_TYPES.filter((type) => !passive.except.includes(type)),
      );
    }
  }
  for (const modifier of [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
    // What the areas it stands in give it, as Silence's Immunity to Thunder damage or Aura of Warding's Resistances.
    ...(access.state ? zoneModifiers(actor, access.state, access) : []),
  ]) {
    if (modifier.kind === "resistance") resistances.push(modifier.damage);
    if (modifier.kind === "vulnerability")
      vulnerabilities.push(modifier.damage);
    if (modifier.kind === "immunity") immunities.push(modifier.damage);
  }
  const absorbs = stats.passives.flatMap((passive) =>
    passive.kind === "absorb" ? passive.damage : [],
  );
  // Elemental Bane: no Resistance to its type.
  const baned = actor.activeEffects.flatMap(({ modifier }) =>
    modifier.kind === "bane" ? [modifier.damage] : [],
  );
  return {
    adjustments: [],
    resistances: resistances.filter((type) => !baned.includes(type)),
    vulnerabilities,
    immunities,
    absorbs,
  };
}
