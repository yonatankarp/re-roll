import { type Context, meleeReach } from "../combat.ts";
import { encodeOption } from "../combat/ids.ts";
import { canAfford, hasPassive, inReach } from "../combat/queries.ts";
import {
  attacksAfter,
  attacksLeft,
  STRIKE,
  TRADE,
  tradeFits,
  tradesOf,
} from "../combat/trade.ts";
import { knownFoes } from "../fog.ts";
import { distanceFeet } from "../grid.ts";
import {
  type Actor,
  type DndState,
  equipped,
  hasCondition,
  INCAPACITATING,
  isDown,
} from "../state.ts";
import { deriveStats, type Stats } from "../stats.ts";
import {
  hasTactic,
  HEW_READY,
  HEW_USED,
  isPolearm,
  LIGHT_USED,
  masteryOf,
  POLE_STRUCK,
  POLE_USED,
  weaponOf,
} from "../tactics.ts";
import { standing } from "./common.ts";
import { HEW, NICK_USED, OFFHAND, OFFHAND_USED, POLE_STRIKE } from "./ids.ts";
import { type ContentAccess } from "#sdk";

// With the Two-Weapon Fighting style, the off-hand attack keeps the ability modifier.
export function twoWeaponStyle(actor: Actor): boolean {
  const build = actor.source.kind === "character" ? actor.source.build : null;
  return (build?.levels ?? []).some((level) =>
    level.answers.some(
      (answer) =>
        answer.kind === "feats" &&
        answer.values.some((id) => id.endsWith("/two-weapon-fighting")),
    ),
  );
}

// After an attack with a Light weapon, a different Light weapon (or a second of the same) can attack as a
// Bonus Action, or as part of the Attack action with Nick.
function offhandOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  const used = actor.usedThisTurn.flatMap((key) =>
    key.startsWith(LIGHT_USED) ? [key.slice(LIGHT_USED.length)] : [],
  );
  if (used.length === 0 || actor.usedThisTurn.includes(OFFHAND_USED)) return [];
  const carried = equipped(actor);
  // Dual Wielder: the second weapon can be any melee weapon that isn't Two-Handed.
  const dual = hasPassive(stats, "dualWielder");
  return stats.actions.flatMap((action) => {
    const weapon = weaponOf(action.id, access);
    const reach = meleeReach(action);
    if (!weapon || reach === null) return [];
    const light = weapon.properties.includes("light");
    if (!light && !(dual && !weapon.properties.includes("twoHanded"))) {
      return [];
    }
    const itemId = action.id.slice(action.id.indexOf(":") + 1);
    const another =
      used.some((id) => id !== action.id) ||
      carried.filter((id) => id === itemId).length > 1;
    const nick =
      light &&
      masteryOf(actor, action.id, access) === "nick" &&
      !actor.usedThisTurn.includes(NICK_USED);
    if (!another || (!nick && !actor.budget.bonusAction)) return [];
    return standing(knownFoes(state, actor, access))
      .filter((foe) => distanceFeet(actor.position, foe.position) <= reach)
      .map((foe) => ({
        id: encodeOption(OFFHAND, foe.id, action.id),
        label: `Off-hand ${action.name}: ${foe.name} (${String(foe.hp)} HP)${nick ? ", with Nick" : ""}`,
      }));
  });
}

// Crossbow Expert's Dual Wielding: the extra attack with a Light crossbow keeps its ability modifier.
export function lightCrossbow(
  actor: Actor,
  actionId: string,
  access: ContentAccess,
): boolean {
  const weapon = weaponOf(actionId, access);
  return (
    weapon !== null &&
    /crossbow/i.test(weapon.name) &&
    weapon.properties.includes("light") &&
    hasPassive(deriveStats(actor, access), "crossbowDualWielding")
  );
}

// Polearm Master's Pole Strike: after attacking with a polearm, a Bonus Action attack with its other end.
function poleStrikeOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  if (
    !hasPassive(stats, "poleStrike") ||
    !actor.budget.bonusAction ||
    !actor.usedThisTurn.includes(POLE_USED) ||
    actor.usedThisTurn.includes(POLE_STRUCK)
  ) {
    return [];
  }
  return stats.actions.flatMap((action) => {
    const weapon = weaponOf(action.id, access);
    const reach = meleeReach(action);
    if (!weapon || !isPolearm(weapon) || reach === null) return [];
    return standing(knownFoes(state, actor, access))
      .filter((foe) => distanceFeet(actor.position, foe.position) <= reach)
      .map((foe) => ({
        id: encodeOption(POLE_STRIKE, foe.id, action.id),
        label: `Pole Strike with the ${weapon.name}'s other end: ${foe.name} (${String(foe.hp)} HP)`,
      }));
  });
}

// Great Weapon Master's Hew: after a Critical Hit or a drop with a melee weapon, a Bonus Action attack with it.
function hewOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  if (
    !hasPassive(stats, "hew") ||
    !actor.budget.bonusAction ||
    actor.usedThisTurn.includes(HEW_USED)
  ) {
    return [];
  }
  return actor.usedThisTurn.flatMap((key) => {
    if (!key.startsWith(HEW_READY)) return [];
    const action = stats.actions.find(
      ({ id }) => id === key.slice(HEW_READY.length),
    );
    if (!action) return [];
    return standing(inReach(action, actor, state, access))
      .filter((foe) => foe.side !== actor.side)
      .map((foe) => ({
        id: encodeOption(HEW, foe.id, action.id),
        label: `Hew with the ${action.name}: ${foe.name} (${String(foe.hp)} HP)`,
      }));
  });
}

// The Bonus Action attacks that follow an attack: off-hand, Pole Strike and Hew.
export function bonusAttackOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  return [
    ...strikeOptions(actor, state, access, stats),
    ...offhandOptions(actor, state, access, stats),
    ...poleStrikeOptions(actor, state, access, stats),
    ...hewOptions(actor, state, access, stats),
  ];
}

// The Attack action's attacks a trade left (combat/trade.ts), one weapon attack at a time.
function strikeOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  const left = attacksLeft(actor);
  if (left === 0) return [];
  return stats.actions.flatMap((action) => {
    const { cost, resolution } = action.activation;
    if (
      action.spellLevel !== null ||
      !cost.includes("action") ||
      resolution.kind !== "attack" ||
      resolution.attack.type !== "weapon"
    ) {
      return [];
    }
    return standing(inReach(action, actor, state, access))
      .filter((foe) => foe.side !== actor.side)
      .map((foe) => ({
        id: encodeOption(STRIKE, foe.id, action.id),
        label: `${action.name}: ${foe.name} (${String(foe.hp)} HP), ${String(left)} ${left === 1 ? "attack" : "attacks"} left`,
      }));
  });
}

// Readying a trade of attacks for a spell or Breath Weapon, while the Attack action keeps one to make.
export function tradeOptions(
  actor: Actor,
  stats: Stats,
): { id: string; label: string }[] {
  if (hasTactic(actor, "trading")) return [];
  return tradesOf(stats).flatMap((trade, index) => {
    const fits = stats.actions.filter(
      (action) =>
        tradeFits(trade, action) &&
        !action.activation.trigger &&
        canAfford(action, actor, stats),
    );
    if (attacksAfter(trade, stats) < 1 || fits.length === 0) return [];
    const what = trade.cantrips
      ? "a cantrip"
      : trade.levels
        ? `a level ${trade.levels.join(" or ")} spell`
        : [...new Set(fits.map(({ name }) => name))].join(" or ");
    return [
      {
        id: encodeOption(TRADE, actor.id, String(index)),
        label: `Trade ${trade.attacks === 1 ? "an attack" : `${String(trade.attacks)} attacks`} for ${what}`,
      },
    ];
  });
}

// After an attack, the turn waits for the off-hand attack it allows, rather than ending.
export function keepsActing(actorId: string, context: Context): boolean {
  const actor = context.state.actors[actorId];
  if (!actor || !context.state.combat || isDown(actor)) return false;
  if (hasCondition(actor, ...INCAPACITATING)) return false;
  return (
    bonusAttackOptions(
      actor,
      context.state,
      context,
      deriveStats(actor, context),
    ).length > 0
  );
}
