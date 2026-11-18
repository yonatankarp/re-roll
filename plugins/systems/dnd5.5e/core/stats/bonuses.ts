// Attack, check and save bonuses, spellcasting modifiers and save DCs, and Exhaustion.
import type { Actor } from "../state.ts";
import type {
  Ability,
  AbilityScores,
  Passive,
  Resolution,
  Skill,
} from "../schemas.ts";
import type { Stats } from "./model.ts";
import { abilityModifier } from "./abilities.ts";

// Its levels of Exhaustion, with those that last only while an effect does, as Sickening Radiance's.
export function exhaustionOf(actor: Actor): number {
  return Math.min(
    6,
    actor.activeEffects.reduce(
      (sum, { modifier }) =>
        modifier.kind === "exhausted"
          ? sum +
            Math.min(modifier.levels, Math.max(0, (modifier.upTo ?? 6) - sum))
          : sum,
      actor.exhaustion,
    ),
  );
}

export function modifierFor(stats: Stats, ability: Ability): number {
  return abilityModifier(stats.abilities[ability]);
}

export function spellModifier(stats: Stats): number {
  return stats.spellAbility ? modifierFor(stats, stats.spellAbility) : 0;
}

// The flat parts of a roll's bonus, shared by the rolls and the character sheet.
export function attackBonus(
  resolution: Extract<Resolution, { kind: "attack" }>,
  stats: Stats,
): number {
  const { attack } = resolution;
  const exhaustion = 2 * stats.exhaustion + stats.ordeal;
  if (attack.flatBonus !== undefined) return attack.flatBonus - exhaustion;
  // A Finesse weapon a feature or spell makes, as Shadow Blade's, uses the better of Strength and Dexterity.
  const ability =
    attack.type === "spell"
      ? (attack.ability ?? stats.spellAbility)
      : (attack.ability ??
        (attack.finesse
          ? modifierFor(stats, "dex") > modifierFor(stats, "str")
            ? "dex"
            : "str"
          : undefined));
  const proficiency = attack.proficient === false ? 0 : stats.proficiency;
  const item =
    attack.type === "spell"
      ? stats.itemBonuses.spellAttack
      : stats.itemBonuses.attack + (attack.itemBonus ?? 0);
  return (
    proficiency +
    (ability ? modifierFor(stats, ability) : 0) +
    item -
    exhaustion
  );
}

export function saveBonus(stats: Stats, ability: Ability): number {
  return (
    modifierFor(stats, ability) +
    (stats.savingThrows.includes(ability) ? stats.proficiency : 0) +
    stats.itemBonuses.savingThrows -
    2 * stats.exhaustion -
    stats.ordeal
  );
}

// Elegant Courtier: a save proficiency the character already had from elsewhere gives one of `orElse` instead, the
// highest score's it isn't proficient in.
// shortcut: the book has the player choose; the higher score is the one worth having.
export function withFallbackSaves(
  saves: Ability[],
  otherwise: readonly Ability[],
  passives: readonly Passive[],
  abilities: AbilityScores,
): Ability[] {
  const out = [...saves];
  for (const passive of passives) {
    if (
      passive.kind !== "saveProficiency" ||
      !passive.orElse ||
      !passive.abilities.every((ability) => otherwise.includes(ability))
    )
      continue;
    const pick = [...passive.orElse]
      .filter((ability) => !out.includes(ability))
      .sort((a, b) => abilities[b] - abilities[a])[0];
    if (pick) out.push(pick);
  }
  return out;
}

export function checkBonus(
  stats: Stats,
  actor: Actor,
  // A tool's proficiency counts once, as the skill's would (core/explore.ts).
  check: {
    readonly ability: Ability;
    readonly skill?: Skill;
    readonly toolProficient?: boolean;
  },
): number {
  const { skill } = check;
  const skilled = skill !== undefined && stats.skills.includes(skill);
  const proficient = skilled || check.toolProficient === true;
  const expert =
    skilled &&
    (stats.expertise.includes(skill) ||
      actor.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "expertise" && modifier.skills?.includes(skill),
      ));
  const half =
    skill !== undefined &&
    stats.passives.some(({ kind }) => kind === "halfProficiency");
  return (
    modifierFor(stats, check.ability) +
    (proficient
      ? stats.proficiency * (expert ? 2 : 1)
      : half
        ? Math.floor(stats.proficiency / 2)
        : 0) +
    stats.itemBonuses.checks -
    2 * exhaustionOf(actor) -
    (actor.ordeal ?? 0)
  );
}

// The least a check or save with this ability can total, as Indomitable Might's Strength score.
export function scoreFloor(stats: Stats, ability: Ability): number {
  return stats.passives.some(
    (passive) => passive.kind === "scoreFloor" && passive.ability === ability,
  )
    ? stats.abilities[ability]
    : -Infinity;
}

export function spellAttackBonus(stats: Stats): number {
  return (
    stats.proficiency + spellModifier(stats) + stats.itemBonuses.spellAttack
  );
}

export function spellSaveDc(stats: Stats): number {
  return (
    8 + stats.proficiency + spellModifier(stats) + stats.itemBonuses.spellDc
  );
}
