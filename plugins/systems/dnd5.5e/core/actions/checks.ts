import { type Context, hasFlag, rollBonus } from "../combat.ts";
import { naturalOneEvents } from "../combat/effects.ts";
import { familiarHelpUse } from "../combat/familiar.ts";
import { luckyEdge } from "../combat/queries.ts";
import { settleRoll } from "../combat/reactions.ts";
import { rollD20 } from "../rules.ts";
import { type Ability, ABILITY_NAMES, type Skill } from "../schemas.ts";
import { type Actor, dndEvent, hasCondition, NS } from "../state.ts";
import { checkBonus, deriveStats, scoreFloor, type Stats } from "../stats.ts";
import { checkFloor, rescuedCheck } from "../trait-rules.ts";
import { placedFlag } from "../zones.ts";
import { capitalized } from "./common.ts";
import { HELP } from "./ids.ts";
import { type SystemEvent } from "#sdk";

// Sharp Eye: the resource whose use gives a Search or Study check Advantage, or null with none left.
export function sharpEye(actor: Actor, stats: Stats): string | null {
  for (const passive of stats.passives) {
    if (
      passive.kind === "sharpEye" &&
      (actor.resourcesSpent[passive.resource] ?? 0) <
        (stats.resources[passive.resource] ?? 0)
    ) {
      return passive.resource;
    }
  }
  return null;
}

// A use of Sharp Eye is spent only when the check succeeds.
export function keenSpent(
  actor: Actor,
  resource: string | null,
  success: boolean,
): SystemEvent[] {
  return resource && success
    ? [dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource })]
    : [];
}

// "Strength (Athletics)", for an escape check's label.
export const checkName = ({
  ability,
  skill,
}: {
  readonly ability: Ability;
  readonly skill?: Skill | undefined;
}): string =>
  skill
    ? `${ABILITY_NAMES[ability]} (${capitalized(skill)})`
    : ABILITY_NAMES[ability];

// An ability check, in a fight or a scene. Help's Advantage on a check is used up by it.
// The ability a check with this skill uses: another a feature allows, when it's better, as Primal Knowledge's
// Strength in a Rage.
function checkAbilityOf(
  actor: Actor,
  stats: Stats,
  skill: Skill | undefined,
  printed: Ability,
): Ability {
  if (skill === undefined) return printed;
  return stats.passives.reduce<Ability>(
    (best, passive) =>
      passive.kind === "checkAbility" &&
      passive.skills.includes(skill) &&
      (!passive.while ||
        actor.activeEffects.some(({ sourceId }) =>
          passive.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
        )) &&
      stats.abilities[passive.ability] > stats.abilities[best]
        ? passive.ability
        : best,
    printed,
  );
}

export function abilityCheck(
  actor: Actor,
  skill: Skill | undefined,
  printed: Ability,
  dc: number,
  label: (success: boolean) => string,
  context: Context,
  advantage = false, // from a trait, as Powerful Build gives to escape a grapple
  tool?: { readonly id: string; readonly proficient: boolean }, // a tool check's (core/explore.ts)
  disadvantage = false, // from the creature it's made against, as a Cloak of Elvenkind's wearer
): {
  readonly success: boolean;
  readonly total: number;
  events: SystemEvent[];
} {
  const stats = deriveStats(actor, context);
  const ability = checkAbilityOf(actor, stats, skill, printed);
  const befriended = familiarHelpUse(actor, stats, skill, context.state);
  const edge = {
    advantage:
      advantage ||
      befriended !== null ||
      hasFlag(
        actor,
        "advantage",
        "checks",
        stats,
        ability,
        undefined,
        undefined,
        skill,
      ) ||
      placedFlag(actor, "advantage", "checks", context.state, context, ability),
    disadvantage:
      disadvantage ||
      (stats.untrainedArmor && (ability === "str" || ability === "dex")) ||
      hasFlag(
        actor,
        "disadvantage",
        "checks",
        stats,
        ability,
        undefined,
        undefined,
        skill,
      ) ||
      placedFlag(
        actor,
        "disadvantage",
        "checks",
        context.state,
        context,
        ability,
      ) ||
      hasCondition(actor, "poisoned", "frightened"),
  };
  const lucky = luckyEdge(actor, stats, edge.advantage, edge.disadvantage);
  if (lucky) edge.disadvantage = false;
  const first = rollD20(context.dice, {
    ...edge,
    rerollOnes: stats.passives.some(({ kind }) => kind === "rerollOnes"),
  });
  const base =
    checkBonus(stats, actor, {
      ability,
      ...(skill ? { skill } : {}),
      ...(tool?.proficient ? { toolProficient: true } : {}),
    }) + rollBonus(actor, "checks", context, skill, ability, false, tool?.id);
  const floor = checkFloor(actor, stats, ability, skill, tool?.proficient);
  const least = scoreFloor(stats, ability);
  const totalOf = (natural: number, bonus: number) =>
    Math.max(Math.max(natural, floor) + base + bonus, least);
  const judge = (natural: number, bonus: number) => ({
    total: totalOf(natural, bonus),
    success: totalOf(natural, bonus) >= dc,
  });
  // Reactions to the roll before it lands, as Bountiful Luck (combat/reactions.ts).
  const settled = settleRoll(
    {
      roller: actor,
      kind: "check",
      natural: first.natural,
      goal: dc,
      ...judge(first.natural, 0),
    },
    edge,
    judge,
    context,
  );
  const roll = { natural: settled.natural };
  const rolled = judge(settled.natural, settled.bonus).total;
  // A failed check may be rescued, as by Knowledge from a Past Life (trait-rules.ts).
  const rescue = rescuedCheck(actor, stats, rolled, dc, context.dice, skill);
  const total = rolled + rescue.bonus;
  const success = total >= dc;
  const helped = actor.activeEffects.some(
    ({ sourceId, modifier }) =>
      sourceId === HELP &&
      modifier.kind === "advantage" &&
      modifier.on === "checks",
  );
  return {
    success,
    total,
    events: [
      ...(lucky ?? []),
      ...(befriended ? [befriended] : []),
      ...settled.events,
      ...rescue.events,
      dndEvent(`${NS}:rollReported`, {
        actor: actor.id,
        against: "check",
        natural: roll.natural,
        total,
        target: dc,
        success,
        label: label(success),
      }),
      ...(helped
        ? [dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId: HELP })]
        : []),
      // A bonus for the next check only, as Vampiric Bite's Strengthen, is spent on it.
      ...actor.activeEffects.flatMap(({ modifier, sourceId }) =>
        modifier.kind === "bonus" && modifier.to === "checks" && modifier.once
          ? [dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId })]
          : [],
      ),
      ...naturalOneEvents(actor, roll.natural, context),
    ],
  };
}
