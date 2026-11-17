import { afterDamage, reactFrames, settleRoll } from "./combat/reactions.ts";
import {
  awaitDecision,
  type ContentAccess,
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { z } from "zod";
import {
  type Context,
  HitSchema,
  MOVE,
  PASS,
  allies,
  choosePolicy,
  concentrationFrame,
  dealEvents,
  enemies,
  hasFlag,
  meleeReach,
  rollBonus,
  rollSave,
  speedLeft,
  stepToward,
  within5,
} from "./combat.ts";
import { encodeOption, parseOption } from "./combat/ids.ts";
import { opportunity, provokers, teleportSquares } from "./combat/movement.ts";
import { familiarHelpUse } from "./combat/familiar.ts";
import { mountEvents, mountOptions } from "./combat/mounts.ts";
import { heldInPlace, leafEvents, naturalOneEvents } from "./combat/effects.ts";
import { heightChoices, heightOf } from "./combat/falling.ts";
import {
  SIZES,
  canAfford,
  currentActor,
  hasPassive,
  hitFits,
  inReach,
  sizeOf,
  luckyEdge,
} from "./combat/queries.ts";
import { moveOf, reachesFrom } from "./policy.ts";
import { coverFor, seeing } from "./sight.ts";
import {
  classOptionPolicy,
  classOptions,
  isClassOption,
  runClassOption,
} from "./class-options.ts";
import { escapeDc, grapplesOn } from "./combat/grapple.ts";
import {
  COLLECT,
  collectable,
  collectEvents,
  SHAKE,
  shakeable,
  shakeEvents,
} from "./combat/fear.ts";
import { unhindered } from "./movement-modes.ts";
import {
  type Square,
  coverBetween,
  distanceFeet,
  pushTo,
  squareKey,
} from "./grid.ts";

export { pushTo };
import { FLEE } from "./legendary.ts";
import { finalDamage, rollD20 } from "./rules.ts";
import {
  ABILITY_NAMES,
  type Ability,
  type Skill,
  type WeaponMastery,
  WeaponMasterySchema,
} from "./schemas.ts";
import {
  applyDndEvent,
  type ActiveEffect,
  type Actor,
  type DndState,
  INCAPACITATING,
  NS,
  dndEvent,
  equipped,
  hasCondition,
  familiarOwner,
  isDead,
  isDown,
  isStable,
  frame,
} from "./state.ts";
import {
  type KnownAction,
  type Stats,
  checkBonus,
  damageResponses,
  deriveStats,
  modifierFor,
  rollAmount,
  saveBonus,
  scoreFloor,
} from "./stats.ts";
import { checkFloor, rescuedCheck } from "./trait-rules.ts";
import {
  GRAPPLE_SOURCE,
  HIDE_SOURCE,
  LIGHT_USED,
  CHARGE_FROM,
  HEW_READY,
  HEW_USED,
  POLE_STRUCK,
  POLE_USED,
  isPolearm,
  lightAttackEvents,
  MASTERY,
  TACTIC,
  hasTactic,
  masteryOf,
  bonusDashFeet,
  tacticsOf,
  walkSpeed,
  weaponOf,
} from "./tactics.ts";
import { fogged, knownFoes, partySight } from "./fog.ts";
import { hasteActing } from "./combat/durations.ts";
import { placedFlag } from "./zones.ts";
import {
  STRIKE,
  TRADE,
  attacksAfter,
  attacksLeft,
  strikesLeft,
  tradeFits,
  tradesOf,
} from "./combat/trade.ts";

// The 2024 actions anyone can take in a fight besides attacking and casting (Dash, Disengage, Dodge, Help,
// Hide, Ready, Search, Study, Grapple, Shove, standing up, escaping a grapple), the off-hand attack of a second Light weapon,
// and the weapon masteries. Each is an option of the turn decision, so a save replays it like any other.

const DASH = `${TACTIC}dash`;
const DISENGAGE = `${TACTIC}disengage`;
// The same as a Bonus Action, through Cunning Action or Nimble Escape.
export const BONUS_DASH = `${TACTIC}bonus-dash`;
export const BONUS_DISENGAGE = `${TACTIC}bonus-disengage`;
export const BONUS_HIDE = `${TACTIC}bonus-hide`;
export const BONUS_DODGE = `${TACTIC}bonus-dodge`;
const BONUS_SEARCH = `${TACTIC}bonus-search`;
const BONUS_STUDY = `${TACTIC}bonus-study`;
const DODGE = `${TACTIC}dodge`;
const HIDE = HIDE_SOURCE;
const SEARCH = `${TACTIC}search`;
export const STUDY = `${TACTIC}study`;
const HELP = `${TACTIC}help`;
const GRAPPLE = GRAPPLE_SOURCE;
const SHOVE = `${TACTIC}shove`;
const READY = `${TACTIC}ready`;
const STAND = `${TACTIC}stand`;
// Going up or down 10 feet: `rise:fly`, `sink:climb` and the like (combat/falling.ts).
const RISE = `${TACTIC}rise`;
const SINK = `${TACTIC}sink`;
const ESCAPE = `${TACTIC}escape`;
// Freedom of Movement's escape from a grapple, for 5 feet of movement.
const SLIP = `${TACTIC}slip`;
const BREAK_OUT = `${TACTIC}break-out`;
export const OFFHAND = `${TACTIC}offhand`;
export const POLE_STRIKE = `${TACTIC}pole-strike`;
export const HEW = `${TACTIC}hew`;
const MOVE_HURT = "move-hurt:";
const OFFHAND_USED = "offhand";
const NICK_USED = `${MASTERY}nick`;
const CLEAVE_USED = `${MASTERY}cleave`;
const HIDE_DC = 15;
const STABILIZE_DC = 10;
const STUDY_DC = 15;

const CHECK_END = frame("checkCombatEnd", {});

// At 0 HP and still making death saves.
function dyingNow(actor: Actor): boolean {
  return (
    actor.side === "party" &&
    isDown(actor) &&
    !isDead(actor) &&
    !isStable(actor)
  );
}

function effect(
  actor: string,
  sourceId: string,
  casterId: string,
  modifier: ActiveEffect["modifier"],
  ends: ActiveEffect["ends"],
  more: Pick<ActiveEffect, "repeatSave"> = {},
): SystemEvent {
  return dndEvent(`${NS}:effectAdded`, {
    actor,
    effect: { sourceId, casterId, modifier, ends, ...more },
  });
}

// Sharp Eye: the resource whose use gives a Search or Study check Advantage, or null with none left.
function sharpEye(actor: Actor, stats: Stats): string | null {
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
function keenSpent(
  actor: Actor,
  resource: string | null,
  success: boolean,
): SystemEvent[] {
  return resource && success
    ? [dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource })]
    : [];
}

// An Unarmed Strike's Grapple or Shove, and a mastery's save: 8 + the ability modifier + Proficiency Bonus.
function saveDc(stats: Stats, ability: Ability): number {
  return 8 + modifierFor(stats, ability) + stats.proficiency;
}

// The target picks the better of Strength and Dexterity against a Grapple or Shove.
function betterSave(target: Actor, access: ContentAccess): "str" | "dex" {
  const stats = deriveStats(target, access);
  return saveBonus(stats, "dex") > saveBonus(stats, "str") ? "dex" : "str";
}

function reportedSave(
  target: Actor,
  ability: Ability,
  dc: number,
  label: string,
  context: Context,
): { readonly saved: boolean; readonly events: readonly SystemEvent[] } {
  // The roll for the history (and a Legendary Resistance), then the line saying what it was against.
  const { saved, events } = rollSave(target, ability, dc, context);
  return {
    saved,
    events: [
      ...events,
      dndEvent(`${NS}:saveReported`, {
        actor: target.id,
        ability,
        dc,
        success: saved,
        label,
      }),
    ],
  };
}

// An ability check, in a fight or a scene. Help's Advantage on a check is used up by it.
export function abilityCheck(
  actor: Actor,
  skill: Skill | undefined,
  ability: Ability,
  dc: number,
  label: (success: boolean) => string,
  context: Context,
  advantage = false, // from a trait, as Powerful Build gives to escape a grapple
  tool?: { readonly id: string; readonly proficient: boolean }, // a tool check's (core/explore.ts)
): {
  readonly success: boolean;
  readonly total: number;
  events: SystemEvent[];
} {
  const stats = deriveStats(actor, context);
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

// The squares a creature is pushed through, straight away from `from`, stopping at a wall, a creature or the
// map's edge. Null when it can't move at all, or there's no map.

// Forced movement uses none of the creature's own Speed and provokes no Opportunity Attacks.
function pushEvents(
  by: Actor,
  target: Actor,
  feet: number,
  context: Context,
): SystemEvent[] {
  const to = pushTo(by.position, target, feet, context.state);
  const held = to ? heldInPlace(target, context) : [];
  if (held.length > 0) return held;
  return to ? [dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 })] : [];
}

function standing(list: readonly Actor[]): readonly Actor[] {
  return list.filter((item) => !isDown(item));
}

const NO_SQUARES: ReadonlySet<string> = new Set();

// Whether `actor` may Hide: every foe that could see it sees it through at least Three-Quarters Cover or not at
// all, or, with Naturally Stealthy, past a creature at least one size larger.
function hiddenFromAll(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): boolean {
  const larger = hasPassive(deriveStats(actor, access), "hideBehindLarger")
    ? Object.values(state.actors).filter(
        (item) =>
          item.id !== actor.id &&
          item.position !== null &&
          !isDead(item) &&
          sizeOf(item, access) > sizeOf(actor, access),
      )
    : [];
  return standing(enemies(state, actor)).every((foe) => {
    if (hasCondition(foe, "blinded")) return true;
    const cover = coverFor(state, foe.position, actor, [foe.id]);
    if (cover === 5 || cover === "total") return true;
    if (seeing(foe, actor.position, state, access) === "none") return true;
    const between = larger.flatMap((item) =>
      item.id !== foe.id && item.position ? [squareKey(item.position)] : [],
    );
    return (
      between.length > 0 &&
      coverBetween(
        foe.position,
        actor.position,
        NO_SQUARES,
        { half: NO_SQUARES, threeQuarters: NO_SQUARES },
        new Set(between),
      ) !== 0
    );
  });
}

function dashBonus(stats: Stats): number {
  return stats.passives.reduce(
    (total, passive) =>
      total + (passive.kind === "dashBonus" ? passive.feet : 0),
    0,
  );
}

function halfSpeed(stats: Stats): number {
  return Math.ceil(stats.speed / 10) * 5;
}

// With the Two-Weapon Fighting style, the off-hand attack keeps the ability modifier.
function twoWeaponStyle(actor: Actor): boolean {
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
function lightCrossbow(
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
function bonusAttackOptions(
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
function tradeOptions(
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

function readyable(stats: Stats): readonly KnownAction[] {
  return stats.actions.filter(
    (action) =>
      meleeReach(action) !== null &&
      action.activation.resolution.kind === "attack" &&
      action.activation.cost.includes("action") &&
      !action.activation.trigger &&
      action.spellLevel === null,
  );
}

// Dash, Disengage or Hide for the Bonus Action, as far as the bearer's passives allow.
// What a Bonus Action tactic costs beyond the Bonus Action: nothing ([]), a use of a resource, as Timely Retreat's,
// or null when nothing lets the bearer take it.
function bonusTacticCost(
  actor: Actor,
  stats: Stats,
  tactic: "dash" | "disengage" | "hide" | "dodge" | "search" | "study",
): SystemEvent[] | null {
  // Expeditious Retreat's Dash as a Bonus Action costs nothing more.
  if (
    tactic === "dash" &&
    actor.activeEffects.some(({ modifier }) => modifier.kind === "bonusDash")
  ) {
    return [];
  }
  let cost: SystemEvent[] | null = null;
  for (const passive of stats.passives) {
    if (passive.kind !== "bonusTactics" || !passive.tactics.includes(tactic)) {
      continue;
    }
    if (!passive.resource) return [];
    if (
      (actor.resourcesSpent[passive.resource] ?? 0) <
      (stats.resources[passive.resource] ?? 0)
    ) {
      cost ??= [
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: passive.resource,
        }),
      ];
    }
  }
  return cost;
}

// Hunter's Rime: a creature Hunter's Mark marks can't take the Disengage action.
function canDisengage(actor: Actor): boolean {
  return !actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "actionLimit" && modifier.noDisengage,
  );
}

function bonusTacticOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  if (!actor.budget.bonusAction) return [];
  const allowed = new Set(
    (["dash", "disengage", "hide", "dodge", "search", "study"] as const).filter(
      (tactic) => bonusTacticCost(actor, stats, tactic) !== null,
    ),
  );
  const options: { id: string; label: string }[] = [];
  const extra = bonusDashFeet(actor, stats) + dashBonus(stats);
  if (
    allowed.has("dash") &&
    extra > 0 &&
    !hasCondition(actor, "grappled", "restrained")
  ) {
    options.push({
      id: BONUS_DASH,
      label: `Dash as a Bonus Action (${String(extra)} ft more this turn)`,
    });
  }
  if (
    allowed.has("disengage") &&
    !hasTactic(actor, "disengage") &&
    canDisengage(actor)
  ) {
    options.push({
      id: BONUS_DISENGAGE,
      label: "Disengage as a Bonus Action (no Opportunity Attacks this turn)",
    });
  }
  if (allowed.has("dodge") && !hasTactic(actor, "dodge")) {
    options.push({
      id: BONUS_DODGE,
      label: "Dodge as a Bonus Action (attacks against you have Disadvantage)",
    });
  }
  if (
    allowed.has("hide") &&
    !hasTactic(actor, "hidden") &&
    hiddenFromAll(actor, state, access)
  ) {
    options.push({
      id: BONUS_HIDE,
      label: `Hide as a Bonus Action (Stealth, DC ${String(HIDE_DC)})`,
    });
  }
  if (allowed.has("search") && searchable(actor, state, access)) {
    options.push({
      id: BONUS_SEARCH,
      label: "Search as a Bonus Action (Perception)",
    });
  }
  // Study is the player's, as its action is (tacticOptions).
  if (allowed.has("study") && actor.id === PLAYER_ACTOR) {
    for (const foe of standing(knownFoes(state, actor, access))) {
      options.push({
        id: encodeOption(BONUS_STUDY, foe.id),
        label: `Study ${foe.name} as a Bonus Action (${capitalized(studySkill(foe, access))})`,
      });
    }
  }
  return options;
}

// Searching is offered where the party saw a foe slip out of sight, not for one it never knew of.
function searchable(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): boolean {
  const sight = fogged(state) ? partySight(state, access) : null;
  return enemies(state, actor).some(
    (foe) =>
      hasTactic(foe, "hidden") &&
      (actor.side !== "party" ||
        !sight ||
        (foe.position !== null && sight.squares.has(squareKey(foe.position)))),
  );
}

export function tacticOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): { id: string; label: string }[] {
  if (!state.combat || isDown(actor) || hasCondition(actor, ...INCAPACITATING))
    return [];
  const stats = deriveStats(actor, access);
  const options: { id: string; label: string }[] = [];
  const half = halfSpeed(stats);
  // Prone that Hideous Laughter keeps it in can't be ended by standing.
  if (
    hasCondition(actor, "prone") &&
    !actor.activeEffects.some(
      ({ cantStand, modifier }) =>
        cantStand &&
        modifier.kind === "condition" &&
        modifier.condition === "prone",
    ) &&
    (!actor.position || speedLeft(actor, stats) >= half)
  ) {
    options.push({
      id: STAND,
      label: `Stand up (${String(half)} ft of movement)`,
    });
  }
  const height = heightOf(actor);
  for (const { mode, up } of heightChoices(actor, state, access)) {
    const to = height + (up ? 10 : -10);
    options.push({
      id: encodeOption(up ? RISE : SINK, mode),
      label: `${mode === "fly" ? "Fly" : "Climb"} ${up ? "up" : "down"} 10 ft (${to > 0 ? `${String(to)} ft up` : "to the ground"}, 10 ft of movement)`,
    });
  }
  // shortcut: every grapple counts as nonmagical, and the 5 feet come from its Speed before the grapple stops it.
  if (unhindered(actor, stats) && stats.speed - actor.moved >= 5) {
    for (const grapple of grapplesOn(actor)) {
      const grappler = state.actors[grapple.casterId];
      options.push({
        id: encodeOption(SLIP, grapple.casterId, grapple.sourceId),
        label: `Slip free of ${grappler ? `${grappler.name}'s` : "the"} grapple (5 ft of movement)`,
      });
    }
  }
  options.push(...mountOptions(actor, state, access));
  options.push(...bonusAttackOptions(actor, state, access, stats));
  options.push(...classOptions(actor, state, access));
  options.push(...bonusTacticOptions(actor, state, access, stats));
  if (!actor.budget.action) return options;
  options.push(...tradeOptions(actor, stats));
  // Shut away, it can only try to get out, as from a Maze.
  const seal = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "sealed",
  );
  if (seal) {
    if (seal.modifier.kind === "sealed" && seal.modifier.escape) {
      const { ability, dc, skill } = seal.modifier.escape;
      options.push({
        id: encodeOption(BREAK_OUT, seal.casterId, seal.sourceId),
        label: `Try to escape (${ABILITY_NAMES[ability]}, ${capitalized(skill)}, DC ${String(dc)})`,
      });
    }
    return options;
  }
  // Everyone else's turns are played by tacticalPolicy, so they're offered only what it can pick, which also
  // spares working out every Study and Shove on every monster's turn.
  const full = actor.id === PLAYER_ACTOR;

  const foes = standing(knownFoes(state, actor, access));
  const near = foes.filter((foe) => within5(actor, foe));
  const friends = standing(allies(state, actor)).filter(
    (item) => item.id !== actor.id,
  );
  const extra = walkSpeed(actor, stats) + dashBonus(stats);
  if (extra > 0 && !hasCondition(actor, "grappled", "restrained")) {
    options.push({
      id: DASH,
      label: `Dash (${String(extra)} ft more this turn)`,
    });
  }
  // Haste's additional action: Dash, Disengage or Hide besides its one attack.
  if (hasteActing(actor)) {
    if (canDisengage(actor)) {
      options.push({
        id: DISENGAGE,
        label: "Disengage (no Opportunity Attacks this turn)",
      });
    }
    if (!hasTactic(actor, "hidden") && hiddenFromAll(actor, state, access)) {
      options.push({
        id: HIDE,
        label: `Hide (Stealth, DC ${String(HIDE_DC)})`,
      });
    }
    return options;
  }
  options.push({
    id: DODGE,
    label: "Dodge (attacks against you have Disadvantage)",
  });
  // Shaking an ally out of a spell, as out of Sleep, and saving against a spell with an action, as Irresistible Dance.
  for (const ally of shakeable(actor, state)) {
    options.push({
      id: encodeOption(SHAKE, ally.id),
      label: `Shake ${ally.name} out of it`,
    });
  }
  for (const held of collectable(actor)) {
    options.push({
      id: encodeOption(COLLECT, held.casterId, held.sourceId),
      label: `Collect yourself (${ABILITY_NAMES[held.repeatSave?.ability ?? "wis"]} save, DC ${String(held.repeatSave?.dc ?? 10)})`,
    });
  }
  // Help also stabilizes a dying creature within 5 feet, which every companion should be able to do.
  for (const dying of allies(state, actor).filter(
    (item) => item.id !== actor.id && dyingNow(item) && within5(actor, item),
  )) {
    options.push({
      id: encodeOption(HELP, dying.id),
      label: `Stabilize ${dying.name} (Medicine, DC ${String(STABILIZE_DC)})`,
    });
  }
  if (searchable(actor, state, access)) {
    options.push({ id: SEARCH, label: "Search for hidden foes (Perception)" });
  }
  for (const grapple of grapplesOn(actor)) {
    const grappler = state.actors[grapple.casterId];
    options.push({
      id: encodeOption(ESCAPE, grapple.casterId, grapple.sourceId),
      label: `Escape ${grappler ? `${grappler.name}'s` : "the"} grapple (Athletics or Acrobatics, DC ${String(escapeDc(grapple, state, access))})`,
    });
  }
  // A familiar can't attack, but it can Help and take its other actions, which tacticalPolicy weighs for it.
  if (!full && familiarOwner(actor) === null) return options;
  if (canDisengage(actor)) {
    options.push({
      id: DISENGAGE,
      label: "Disengage (no Opportunity Attacks this turn)",
    });
  }
  if (!hasTactic(actor, "hidden") && hiddenFromAll(actor, state, access)) {
    options.push({
      id: HIDE,
      label: `Hide (Stealth, DC ${String(HIDE_DC)})`,
    });
  }
  for (const foe of foes) {
    options.push({
      id: encodeOption(STUDY, foe.id),
      label: `Study ${foe.name} (${capitalized(studySkill(foe, access))})`,
    });
  }
  // Harper Agent's Distracting Melody helps against an enemy farther off.
  const helpFeet = Math.max(
    5,
    ...stats.passives.flatMap((passive) =>
      passive.kind === "helpRange" ? [passive.feet] : [],
    ),
  );
  if (friends.length > 0) {
    for (const foe of foes.filter(
      (item) =>
        within5(actor, item) ||
        distanceFeet(actor.position, item.position) <= helpFeet,
    )) {
      options.push({
        id: encodeOption(HELP, foe.id),
        label: `Help an ally attack ${foe.name}`,
      });
    }
  }
  for (const friend of friends.filter((item) => within5(actor, item))) {
    options.push({
      id: encodeOption(HELP, friend.id),
      label: `Help ${friend.name} with a check`,
    });
  }
  if (!full) return options;
  const dc = String(saveDc(stats, "str"));
  const size = sizeOf(actor, access);
  // A Grapple or Shove is an Unarmed Strike against a creature no more than one size larger.
  // shortcut: it takes the whole Attack action, not one of its attacks, and needs no free hand.
  for (const foe of near.filter((item) => sizeOf(item, access) <= size + 1)) {
    const held = foe.activeEffects.some(
      (item) => item.sourceId === GRAPPLE && item.casterId === actor.id,
    );
    if (!held) {
      options.push({
        id: encodeOption(GRAPPLE, foe.id),
        label: `Grapple ${foe.name} (DC ${dc})`,
      });
    }
    if (!hasCondition(foe, "prone")) {
      options.push({
        id: encodeOption(SHOVE, foe.id, "prone"),
        label: `Shove ${foe.name} prone (DC ${dc})`,
      });
    }
    if (pushTo(actor.position, foe, 5, state)) {
      options.push({
        id: encodeOption(SHOVE, foe.id, "push"),
        label: `Shove ${foe.name} 5 ft away (DC ${dc})`,
      });
    }
  }
  for (const action of readyable(stats)) {
    options.push({
      id: encodeOption(READY, action.id),
      label: `Ready ${action.name} for a foe stepping into reach`,
    });
  }
  return options;
}

const STUDY_SKILLS: Readonly<Record<string, Skill>> = {
  aberration: "arcana",
  construct: "arcana",
  dragon: "arcana",
  elemental: "arcana",
  fey: "arcana",
  monstrosity: "arcana",
  beast: "nature",
  ooze: "nature",
  plant: "nature",
  celestial: "religion",
  fiend: "religion",
  undead: "religion",
};

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function studySkill(target: Actor, access: ContentAccess): Skill {
  return (
    STUDY_SKILLS[deriveStats(target, access).creatureType ?? ""] ?? "history"
  );
}

// What studying a creature tells you: its AC and how it takes damage.
function lore(target: Actor, access: ContentAccess): string {
  const { resistances, immunities, vulnerabilities } = damageResponses(
    target,
    access,
  );
  return [
    `AC ${String(deriveStats(target, access).ac)}`,
    ...(vulnerabilities.length > 0
      ? [`weak to ${vulnerabilities.join(", ")}`]
      : []),
    ...(resistances.length > 0 ? [`resists ${resistances.join(", ")}`] : []),
    ...(immunities.length > 0 ? [`immune to ${immunities.join(", ")}`] : []),
  ].join(", ");
}

// The turn decision with these actions added after Move and before fleeing and ending the turn, so the
// choices listed first stay as they were.
export function withTactics(
  decision: Decision | null,
  state: DndState,
  access: ContentAccess,
): Decision | null {
  if (!decision?.id.startsWith(`${NS}:turn:`)) return decision;
  const actor = state.actors[decision.actor];
  const extra = actor ? tacticOptions(actor, state, access) : [];
  if (extra.length === 0) return decision;
  const found = decision.options.findIndex(
    ({ id }) => id === FLEE || id === PASS,
  );
  const at = found === -1 ? decision.options.length - 1 : found;
  return {
    ...decision,
    options: [
      ...decision.options.slice(0, at),
      ...extra,
      ...decision.options.slice(at),
    ],
  };
}

export function isTactic(answer: string): boolean {
  return answer.startsWith(TACTIC);
}

export function runTactic(
  payload: { readonly actor: string; readonly answer: string },
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[payload.actor];
  if (!actor) throw new Error(`Unknown actor ${payload.actor}`);
  if (isClassOption(payload.answer)) return runClassOption(payload, context);
  const [kind = "", targetId = "", detail = ""] = parseOption(payload.answer);
  const target = state.actors[targetId];
  const stats = deriveStats(actor, context);
  const spend = (budget: "action" | "bonusAction"): SystemEvent =>
    dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: budget });
  // An action, or the Bonus Action and whatever a passive charges for it, as Observant's Quick Search.
  const actionOrBonus = (
    action: boolean,
    tactic: "search" | "study",
  ): SystemEvent[] =>
    action
      ? [spend("action")]
      : [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, tactic) ?? []),
        ];
  const self = (
    tactic: "dash" | "disengage" | "dodge" | "ready",
    action?: string,
  ): SystemEvent =>
    effect(
      actor.id,
      kind,
      actor.id,
      { kind: "tactic", tactic, ...(action ? { action } : {}) },
      "casterNextTurn",
    );
  const done: Frame[] = [CHECK_END, frame("afterAction", { actor: actor.id })];
  const needTarget = (): Actor => {
    if (!target) throw new Error(`${payload.answer} has no target`);
    return target;
  };

  const mounted = mountEvents(actor, kind, targetId, state, context);
  if (mounted) return { events: mounted };
  switch (kind) {
    case SHAKE:
      return {
        events: [spend("action"), ...shakeEvents(needTarget())],
        frames: done,
      };
    case COLLECT: {
      const held = collectable(actor).find(
        (item) => item.sourceId === detail && item.casterId === targetId,
      );
      if (!held) throw new Error(`${actor.id} has nothing to collect from`);
      return {
        events: [spend("action"), ...collectEvents(actor, held, context)],
        frames: done,
      };
    }
    case SLIP:
      return {
        events: [
          dndEvent(`${NS}:effectEnded`, {
            actor: actor.id,
            sourceId: detail,
            casterId: targetId,
          }),
          ...(actor.position
            ? [
                dndEvent(`${NS}:moved`, {
                  actor: actor.id,
                  to: actor.position,
                  feet: 5,
                }),
              ]
            : []),
        ],
      };
    // Straight up or down out of a foe's reach provokes it, as any move of the creature's own does.
    case RISE:
    case SINK: {
      const step = {
        mode: targetId === "climb" ? ("climb" as const) : ("fly" as const),
        up: kind === RISE,
      };
      const answers = actor.position
        ? provokers(
            actor,
            actor.position,
            state,
            context,
            [actor.position],
            heightOf(actor) + (step.up ? 10 : -10),
          ).map(({ foe, melee }) => opportunity(foe, melee, actor, context))
        : [];
      return {
        events: answers.flatMap((answer) => answer.events ?? []),
        frames: [
          ...answers.flatMap((answer) => answer.frames ?? []),
          frame("changeHeight", { actor: actor.id, ...step }),
        ],
      };
    }
    case STAND:
      return {
        events: [
          dndEvent(`${NS}:conditionRemoved`, {
            actor: actor.id,
            condition: "prone",
          }),
          ...(actor.position
            ? [
                dndEvent(`${NS}:moved`, {
                  actor: actor.id,
                  to: actor.position,
                  feet: hasPassive(stats, "quickStand") ? 5 : halfSpeed(stats),
                }),
              ]
            : []),
        ],
      };
    // Dash and Disengage are for moving, so the turn goes on for it.
    case DASH: {
      const extra = dashBonus(stats);
      return {
        events: [
          spend("action"),
          extra > 0
            ? effect(
                actor.id,
                kind,
                actor.id,
                {
                  kind: "tactic",
                  tactic: "dash",
                  value: walkSpeed(actor, stats) + extra,
                },
                "casterNextTurn",
              )
            : self("dash"),
        ],
      };
    }
    case DISENGAGE:
      return { events: [spend("action"), self("disengage")] };
    case BONUS_DASH: {
      const feet = bonusDashFeet(actor, stats) + dashBonus(stats);
      return {
        events: [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, "dash") ?? []),
          effect(
            actor.id,
            kind,
            actor.id,
            {
              kind: "tactic",
              tactic: "dash",
              ...(feet === walkSpeed(actor, stats) ? {} : { value: feet }),
            },
            "casterNextTurn",
          ),
          // A Tactical Charge moves without provoking Opportunity Attacks.
          ...(stats.passives.some(
            (passive) => passive.kind === "bonusTactics" && passive.safe,
          )
            ? [self("disengage")]
            : []),
        ],
      };
    }
    case BONUS_DISENGAGE:
      return {
        events: [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, "disengage") ?? []),
          self("disengage"),
        ],
      };
    case BONUS_DODGE:
      return {
        events: [
          spend("bonusAction"),
          ...(bonusTacticCost(actor, stats, "dodge") ?? []),
          self("dodge"),
        ],
      };
    case DODGE:
      return {
        events: [
          spend("action"),
          self("dodge"),
          ...(hasPassive(stats, "dodgeHeal")
            ? leafEvents(
                [
                  {
                    kind: "hitDieHeal",
                    bonus: {
                      base: 0,
                      add: [{ kind: "abilityMod", ability: "con" }],
                    },
                  },
                ],
                kind,
                actor,
                actor,
                context,
              )
            : []),
        ],
        frames: done,
      };
    case READY:
      return {
        events: [
          spend("action"),
          self("ready", targetId),
          ...(hasPassive(stats, "vigilant")
            ? [
                effect(
                  actor.id,
                  "vigilant",
                  actor.id,
                  { kind: "disadvantage", on: "attacksAgainst", once: true },
                  "casterNextTurn",
                ),
              ]
            : []),
        ],
        frames: done,
      };
    case HIDE:
    case BONUS_HIDE: {
      const rolled = abilityCheck(
        actor,
        "stealth",
        "dex",
        HIDE_DC,
        () => "stealth",
        context,
      );
      const hidden: SystemEvent[] = rolled.success
        ? [
            effect(
              actor.id,
              HIDE,
              actor.id,
              { kind: "condition", condition: "invisible" },
              "spellDuration",
            ),
            effect(
              actor.id,
              HIDE,
              actor.id,
              { kind: "tactic", tactic: "hidden", value: rolled.total },
              "spellDuration",
            ),
          ]
        : [];
      return {
        events: [
          spend(kind === HIDE ? "action" : "bonusAction"),
          ...(kind === HIDE
            ? []
            : (bonusTacticCost(actor, stats, "hide") ?? [])),
          ...rolled.events,
          ...hidden,
        ],
        frames: done,
      };
    }
    case SEARCH:
    case BONUS_SEARCH: {
      // A Perception check finds every hidden foe whose Stealth total it matches.
      const hidden = enemies(state, actor).flatMap((foe) => {
        const [mark] = tacticsOf(foe, "hidden");
        return mark ? [{ foe, dc: mark.value ?? HIDE_DC }] : [];
      });
      const lowest = Math.min(HIDE_DC, ...hidden.map(({ dc }) => dc));
      const keen = sharpEye(actor, stats);
      const rolled = abilityCheck(
        actor,
        "perception",
        "wis",
        lowest,
        () => "perception",
        context,
        keen !== null,
      );
      const found = hidden.flatMap(({ foe, dc }) =>
        rolled.total >= dc
          ? [
              dndEvent(`${NS}:effectEnded`, {
                actor: foe.id,
                sourceId: HIDE,
              }),
            ]
          : [],
      );
      return {
        events: [
          ...actionOrBonus(kind === SEARCH, "search"),
          ...rolled.events,
          ...keenSpent(actor, keen, rolled.success),
          ...found,
        ],
        frames: done,
      };
    }
    case STUDY:
    case BONUS_STUDY: {
      // shortcut: what's learned is only reported, as nothing else in the rules reads it.
      const studied = needTarget();
      const skill = studySkill(studied, context);
      const keen = sharpEye(actor, stats);
      const rolled = abilityCheck(
        actor,
        skill,
        "int",
        STUDY_DC,
        (success) =>
          success
            ? `${skill} (${studied.name}: ${lore(studied, context)})`
            : skill,
        context,
        keen !== null,
      );
      return {
        events: [
          ...actionOrBonus(kind === STUDY, "study"),
          ...rolled.events,
          ...keenSpent(actor, keen, rolled.success),
        ],
        frames: [
          ...reactFrames({ kind: "studied", actor: actor.id }, context),
          ...done,
        ],
      };
    }
    case HELP: {
      const helped = needTarget();
      // On a dying creature, a Wisdom (Medicine) check to make it Stable.
      if (helped.side === actor.side && dyingNow(helped)) {
        const rolled = abilityCheck(
          actor,
          "medicine",
          "wis",
          STABILIZE_DC,
          () => "medicine",
          context,
        );
        return {
          events: [
            spend("action"),
            ...rolled.events,
            ...(rolled.success
              ? [dndEvent(`${NS}:stabilized`, { actor: helped.id })]
              : []),
          ],
          frames: done,
        };
      }
      // On a foe, the next attack against it before your next turn has Advantage; on an ally, its next check.
      // shortcut: your own attack could use the Advantage on the foe too, though only an ally should.
      const modifier =
        helped.side === actor.side
          ? ({ kind: "advantage", on: "checks" } as const)
          : ({ kind: "advantage", on: "attacksAgainst", once: true } as const);
      // Harper Teamwork's Withering Wordplay: the foe's next save has Disadvantage too.
      const withering =
        helped.side !== actor.side && hasPassive(stats, "helpRider")
          ? [
              effect(
                helped.id,
                `${HELP}:saves`,
                actor.id,
                { kind: "disadvantage", on: "saves", once: true },
                "casterNextTurn",
              ),
            ]
          : [];
      return {
        events: [
          spend("action"),
          effect(helped.id, HELP, actor.id, modifier, "casterNextTurn"),
          ...withering,
        ],
        frames: done,
      };
    }
    case GRAPPLE: {
      // The grappled creature escapes with its action; combat/grapple.ts ends the grapple on its own.
      const held = needTarget();
      const dc = saveDc(stats, "str");
      const ability = betterSave(held, context);
      const save = reportedSave(held, ability, dc, "Grapple", context);
      return {
        events: [
          spend("action"),
          ...save.events,
          ...(save.saved
            ? []
            : [
                effect(
                  held.id,
                  GRAPPLE,
                  actor.id,
                  { kind: "condition", condition: "grappled" },
                  "spellDuration",
                ),
              ]),
        ],
        frames: done,
      };
    }
    case BREAK_OUT: {
      const seal = actor.activeEffects.find(
        (item) => item.sourceId === detail && item.casterId === targetId,
      );
      if (seal?.modifier.kind !== "sealed" || !seal.modifier.escape) {
        throw new Error(`${actor.id} isn't sealed away by ${targetId}`);
      }
      const { ability, dc, skill } = seal.modifier.escape;
      const rolled = abilityCheck(
        actor,
        skill,
        ability,
        dc,
        () => `Escape (${capitalized(skill)})`,
        context,
      );
      return {
        events: [
          spend("action"),
          ...rolled.events,
          ...(rolled.success
            ? [
                dndEvent(`${NS}:effectEnded`, {
                  actor: actor.id,
                  sourceId: seal.sourceId,
                  casterId: seal.casterId,
                }),
              ]
            : []),
        ],
        frames: done,
      };
    }
    case ESCAPE: {
      // An Athletics or Acrobatics check, whichever is better, against the grapple's escape DC.
      const grapple = grapplesOn(actor).find(
        (item) => item.sourceId === detail && item.casterId === targetId,
      );
      if (!grapple) throw new Error(`${actor.id} isn't held by ${targetId}`);
      const athletics =
        checkBonus(stats, actor, { ability: "str", skill: "athletics" }) >=
        checkBonus(stats, actor, { ability: "dex", skill: "acrobatics" });
      const rolled = abilityCheck(
        actor,
        athletics ? "athletics" : "acrobatics",
        athletics ? "str" : "dex",
        escapeDc(grapple, state, context),
        () => `Escape (${athletics ? "Athletics" : "Acrobatics"})`,
        context,
        hasPassive(stats, "powerfulBuild") ||
          hasPassive(stats, "escapeAdvantage"),
      );
      return {
        events: [
          spend("action"),
          ...rolled.events,
          ...(rolled.success
            ? [
                dndEvent(`${NS}:effectEnded`, {
                  actor: actor.id,
                  sourceId: grapple.sourceId,
                  casterId: grapple.casterId,
                }),
              ]
            : []),
        ],
        frames: done,
      };
    }
    case SHOVE: {
      const shoved = needTarget();
      const save = reportedSave(
        shoved,
        betterSave(shoved, context),
        saveDc(stats, "str"),
        "Shove",
        context,
      );
      const result = save.saved
        ? []
        : detail === "prone"
          ? [
              effect(
                shoved.id,
                SHOVE,
                actor.id,
                { kind: "condition", condition: "prone" },
                "spellDuration",
              ),
            ]
          : pushEvents(actor, shoved, 5, context);
      return {
        events: [spend("action"), ...save.events, ...result],
        frames: done,
      };
    }
    case OFFHAND: {
      const nick =
        masteryOf(actor, detail, context) === "nick" &&
        !actor.usedThisTurn.includes(NICK_USED);
      return {
        events: [
          nick
            ? dndEvent(`${NS}:oncePerTurnUsed`, {
                actor: actor.id,
                key: NICK_USED,
              })
            : spend("bonusAction"),
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: actor.id,
            key: OFFHAND_USED,
          }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
            ...(twoWeaponStyle(actor) || lightCrossbow(actor, detail, context)
              ? {}
              : { noModifier: true }),
          }),
          ...done,
        ],
      };
    }
    case TRADE:
      return {
        events: [
          effect(
            actor.id,
            TRADE,
            actor.id,
            { kind: "tactic", tactic: "trading", value: Number(detail) },
            "casterTurnEnd",
          ),
        ],
      };
    case STRIKE: {
      const left = attacksLeft(actor);
      return {
        events: [
          dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId: STRIKE }),
          ...(left > 1 ? [strikesLeft(actor, left - 1)] : []),
          ...lightAttackEvents(actor, detail, context),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
          }),
          ...done,
        ],
      };
    }
    case HEW:
      return {
        events: [
          spend("bonusAction"),
          dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key: HEW_USED }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
          }),
          ...done,
        ],
      };
    case POLE_STRIKE:
      return {
        events: [
          spend("bonusAction"),
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: actor.id,
            key: POLE_STRUCK,
          }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
            poleStrike: true,
          }),
          ...done,
        ],
      };
    default:
      throw new Error(`Unknown action ${payload.answer}`);
  }
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

const AfterMoveSchema = z.object({
  actor: z.string(),
  x: z.number(), // where the move started
  y: z.number(),
});

// A readied attack goes off at a foe stepping into reach. A grapple the move breaks ends in combat/grapple.ts.
// shortcut: a grappler doesn't drag the grappled creature along, and a readied attack fires on its own.
export function runAfterMove(
  payload: z.infer<typeof AfterMoveSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const mover = state.actors[payload.actor];
  if (!state.combat || !mover?.position || isDown(mover)) return {};
  const from = { x: payload.x, y: payload.y };
  // A charge needs to know where the last walk started.
  const charges = deriveStats(mover, context).actions.some(
    ({ activation }) => activation.trigger?.charge !== undefined,
  );
  const events: SystemEvent[] = [];
  // Grasping Arrow's brambles: the first walk on each turn hurts.
  const brambles = mover.activeEffects.find(
    ({ modifier }) => modifier.kind === "moveDamage",
  );
  if (
    brambles?.modifier.kind === "moveDamage" &&
    (from.x !== mover.position.x || from.y !== mover.position.y) &&
    !mover.usedThisTurn.includes(`${MOVE_HURT}${brambles.sourceId}`)
  ) {
    const responses = damageResponses(mover, context);
    const caster = state.actors[brambles.casterId] ?? mover;
    const casterStats = deriveStats(caster, context);
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: mover.id,
        key: `${MOVE_HURT}${brambles.sourceId}`,
      }),
      ...dealEvents(
        mover,
        brambles.modifier.damage.map(({ amount, type }) => ({
          amount: finalDamage(
            rollAmount(amount, casterStats, context.dice),
            type,
            responses,
          ),
          type,
        })),
        false,
        context,
      ).events,
    );
  }
  if (charges) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: mover.id,
        key: `${CHARGE_FROM}${String(from.x)},${String(from.y)}`,
      }),
    );
  }
  const frames: Frame[] = [];
  for (const foe of enemies(state, mover)) {
    const [ready] = tacticsOf(foe, "ready");
    if (!ready?.action || !foe.budget.reaction || isDown(foe)) continue;
    if (hasCondition(foe, ...INCAPACITATING)) continue;
    const action = deriveStats(foe, context).actions.find(
      (item) => item.id === ready.action,
    );
    const reach = action ? meleeReach(action) : null;
    if (
      reach === null ||
      distanceFeet(from, foe.position) <= reach ||
      distanceFeet(mover.position, foe.position) > reach
    ) {
      continue;
    }
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: foe.id, kind: "reaction" }),
      dndEvent(`${NS}:effectEnded`, { actor: foe.id, sourceId: READY }),
    );
    frames.push(
      frame("attackRoll", {
        attacker: foe.id,
        actionId: ready.action,
        target: mover.id,
      }),
    );
  }
  return { events, frames };
}

export { AfterMoveSchema };

// `answer` is the mastery property picked in place of the weapon's own, as with Tactical Master.
const MasteryHitSchema = HitSchema.extend({
  dealt: z.number(),
  answer: z.string().optional(),
});

function masteryAttack(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): {
  readonly attacker: Actor;
  readonly target: Actor;
  readonly action: KnownAction;
  readonly ability: Ability;
  readonly mastery: NonNullable<ReturnType<typeof masteryOf>>;
} | null {
  const { state } = context;
  const attacker = state.actors[payload.attacker];
  const target = state.actors[payload.target];
  if (!state.combat || !attacker || !target) return null;
  const mastery = masteryOf(attacker, payload.actionId, context);
  const action = deriveStats(attacker, context).actions.find(
    (item) => item.id === payload.actionId,
  );
  const resolution = action?.activation.resolution;
  if (!mastery || !action || resolution?.kind !== "attack") return null;
  const ability = resolution.attack.ability ?? "str";
  return { attacker, target, action, ability, mastery };
}

// What a mastered weapon adds to a hit. Graze works on a miss instead, and Nick on the off-hand attack.
export function runMasteryHit(
  payload: z.infer<typeof MasteryHitSchema>,
  context: Context,
): SystemResult {
  const found = masteryAttack(payload, context);
  if (!found) return {};
  const { attacker, target, action, ability } = found;
  const { state } = context;
  const stats = deriveStats(attacker, context);
  // Tactical Master: which property this hit uses is asked first.
  const swaps = [
    ...new Set(
      stats.passives.flatMap((passive) =>
        passive.kind === "masterySwap" ? passive.masteries : [],
      ),
    ),
  ].filter((item) => item !== found.mastery);
  if (swaps.length > 0 && payload.answer === undefined && !isDown(target)) {
    const label = (item: string) =>
      `${item.charAt(0).toUpperCase()}${item.slice(1)}`;
    return {
      frames: [
        awaitDecision({
          id: `${NS}:mastery:${attacker.id}`,
          actor: attacker.id,
          prompt: `${attacker.name} hits ${target.name}. Which mastery property does the hit use?`,
          options: [found.mastery, ...swaps].map((item) => ({
            id: item,
            label: label(item),
          })),
          resume: frame("masteryHit", payload),
        }),
      ],
    };
  }
  const chosen =
    WeaponMasterySchema.safeParse(payload.answer).data ?? found.mastery;
  const outcome = (mastery: WeaponMastery): SystemResult => {
    const source = `${MASTERY}${mastery}`;
    const up = !isDown(target);
    // Advantage and Disadvantage don't stack, so a second Sap or Vex before the first is used adds nothing.
    const has = (actor: Actor): boolean =>
      actor.activeEffects.some((item) => item.sourceId === source);
    switch (mastery) {
      case "sap":
        return up && !has(target)
          ? {
              events: [
                effect(
                  target.id,
                  source,
                  attacker.id,
                  { kind: "disadvantage", on: "attacks", once: true },
                  "casterNextTurn",
                ),
              ],
            }
          : {};
      case "slow":
        return up && payload.dealt > 0 && !hasTactic(target, "slowed")
          ? {
              events: [
                effect(
                  target.id,
                  source,
                  attacker.id,
                  { kind: "tactic", tactic: "slowed" },
                  "casterNextTurn",
                ),
              ],
            }
          : {};
      // shortcut: Vex's Advantage goes on the attacker's next attack against anyone, not only this target.
      case "vex":
        return payload.dealt > 0 && !has(attacker)
          ? {
              events: [
                effect(
                  attacker.id,
                  source,
                  attacker.id,
                  { kind: "advantage", on: "attacks", once: true },
                  "casterNextTurnEnd",
                ),
              ],
            }
          : {};
      case "topple": {
        if (!up || hasCondition(target, "prone")) return {};
        const save = reportedSave(
          target,
          "con",
          saveDc(stats, ability),
          "Topple",
          context,
        );
        return {
          events: [
            ...save.events,
            ...(save.saved
              ? []
              : [
                  effect(
                    target.id,
                    source,
                    attacker.id,
                    { kind: "condition", condition: "prone" },
                    "spellDuration",
                  ),
                ]),
          ],
        };
      }
      case "push":
        return up && sizeOf(target, context) <= SIZES.indexOf("large")
          ? { events: pushEvents(attacker, target, 10, context) }
          : {};
      case "cleave": {
        const reach = meleeReach(action);
        if (reach === null || attacker.usedThisTurn.includes(CLEAVE_USED)) {
          return {};
        }
        const [next] = standing(knownFoes(state, attacker, context))
          .filter(
            (item) =>
              item.id !== target.id &&
              within5(item, target) &&
              distanceFeet(attacker.position, item.position) <= reach,
          )
          .sort((a, b) => a.hp - b.hp);
        if (!next) return {};
        return {
          events: [
            dndEvent(`${NS}:oncePerTurnUsed`, {
              actor: attacker.id,
              key: CLEAVE_USED,
            }),
          ],
          frames: [
            frame("attackRoll", {
              attacker: attacker.id,
              actionId: action.id,
              target: next.id,
              noModifier: true,
            }),
          ],
        };
      }
      case "graze":
      case "nick":
        return {};
      default:
        return mastery satisfies never;
    }
  };
  // Battering Roots: Push or Topple too, besides the weapon's own on such a hit on the bearer's turn.
  const [more] = stats.passives.flatMap((passive) =>
    passive.kind === "extraMastery" &&
    hitFits(passive.with, action, attacker, context) &&
    currentActor(state)?.id === attacker.id
      ? passive.masteries.filter((item) => item !== chosen)
      : [],
  );
  const main = outcome(chosen);
  if (!more) return main;
  const extra = outcome(
    more === "topple" && hasCondition(target, "prone")
      ? (stats.passives.flatMap((passive) =>
          passive.kind === "extraMastery"
            ? passive.masteries.filter(
                (item) => item !== chosen && item !== "topple",
              )
            : [],
        )[0] ?? more)
      : more,
  );
  return {
    events: [...(main.events ?? []), ...(extra.events ?? [])],
    frames: [...(main.frames ?? []), ...(extra.frames ?? [])],
  };
}

export { MasteryHitSchema };

// Graze: a miss still deals the ability modifier as damage of the weapon's type.
export function runMasteryMiss(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const found = masteryAttack(payload, context);
  if (found?.mastery !== "graze" || isDown(found.target)) return {};
  const { attacker, target, action, ability } = found;
  const { resolution } = action.activation;
  const type = "damage" in resolution ? resolution.damage[0]?.type : undefined;
  const amount = modifierFor(deriveStats(attacker, context), ability);
  if (!type || amount <= 0) return {};
  const { events, dealt } = dealEvents(
    target,
    [
      {
        amount: finalDamage(amount, type, damageResponses(target, context)),
        type,
      },
    ],
    false,
    context,
  );
  return {
    events,
    frames: [
      ...afterDamage(
        target,
        dealt,
        {
          source: attacker.id,
          types: [type],
          melee: meleeReach(action) !== null,
        },
        concentrationFrame(target, dealt),
        { ...context, state: events.reduce(applyDndEvent, context.state) },
      ),
      CHECK_END,
    ],
  };
}

// Where a creature that spent its action on a Dash walks: toward the foe it means to fight next turn.
function dashTarget(actor: Actor, context: Context): Square | null {
  return stepToward(
    { ...actor, budget: { ...actor.budget, action: true } },
    context,
  );
}

// The system's tactics, with these actions: stand up first, escape a grapple that does more than hold, take
// the off-hand attack, walk on after a Dash, and spend an action that would otherwise go unused on an escape,
// a Search, a Dash toward the foe or a Dodge.
// Grapple, Shove, Help, Hide, Study and Ready are never picked: here each costs a whole action that an
// attack or spell uses better. Disengage would need a step away from foes, which stepToward never takes,
// so a Bonus Action Disengage is never picked either. A Bonus Action Dash or Hide is, as above.
export function tacticalPolicy(decision: Decision, context: Context): string {
  const mover = context.state.actors[decision.actor];
  if (
    decision.id.startsWith(`${NS}:moveTo:`) &&
    mover &&
    hasTactic(mover, "dash")
  ) {
    const square = dashTarget(mover, context);
    if (square) return squareKey(square);
  }
  const classOption = classOptionPolicy(decision, context);
  if (classOption !== null) return classOption;
  if (!decision.id.startsWith(`${NS}:turn:`)) {
    return choosePolicy(decision, context);
  }
  const ids = new Set(decision.options.map((option) => option.id));
  if (ids.has(STAND)) return STAND;
  const slip = decision.options.find((option) =>
    option.id.startsWith(encodeOption(SLIP, "")),
  );
  if (slip) return slip.id;
  // Shut in a Maze, getting out is all there is to do.
  const breakOut = decision.options.find((option) =>
    option.id.startsWith(encodeOption(BREAK_OUT, "")),
  );
  if (breakOut) return breakOut.id;
  const escapes = decision.options.filter((option) =>
    option.id.startsWith(encodeOption(ESCAPE, "")),
  );
  // Restrained, swallowed up or crushed each turn "until the grapple ends".
  const crushing = escapes.find(({ id }) => {
    const [, grappler, source] = parseOption(id);
    return mover?.activeEffects.some(
      ({ sourceId, casterId, modifier }) =>
        sourceId === source &&
        casterId === grappler &&
        (modifier.kind !== "condition" || modifier.condition !== "grappled"),
    );
  });
  if (crushing) return crushing.id;
  const chosen = choosePolicy(
    {
      ...decision,
      // Dodge stays, for the party to weigh against attacking (policy.ts).
      options: decision.options.filter(
        (option) => !isTactic(option.id) || option.id === DODGE,
      ),
    },
    context,
  );
  const { state } = context;
  const actor = state.actors[decision.actor];
  if (!actor) return chosen;
  // A dying friend in reach is stabilized with the Action, unless the choice already heals it or leaves the
  // Action free. The player's character first, since its death ends the run; a companion once it has failed a save.
  const [dying] = decision.options
    .flatMap((option) => {
      const [kind, id = ""] = parseOption(option.id);
      const who = state.actors[id];
      return kind === HELP && who && dyingNow(who) ? [{ option, who }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.who.id === PLAYER_ACTOR) - Number(a.who.id === PLAYER_ACTOR) ||
        b.who.deathSaves.failures - a.who.deathSaves.failures,
    );
  const [chosenId = "", chosenTarget] = parseOption(chosen);
  const chosenAction = deriveStats(actor, context).actions.find(
    (item) => item.id === chosenId,
  );
  if (
    dying &&
    chosenTarget !== dying.who.id &&
    (chosen === PASS ||
      chosen === MOVE ||
      chosenAction?.activation.cost.includes("action")) &&
    (dying.who.id === PLAYER_ACTOR ||
      dying.who.deathSaves.failures > 0 ||
      chosen === PASS)
  ) {
    return dying.option.id;
  }
  // A cantrip or Breath Weapon that can stand in for one of the Attack action's attacks is traded for it first,
  // which keeps the attacks it leaves.
  const trade = chosenAction
    ? decision.options.find((option) => {
        const [kind, , index = ""] = parseOption(option.id);
        const passive = tradesOf(deriveStats(actor, context))[Number(index)];
        return kind === TRADE && passive && tradeFits(passive, chosenAction);
      })
    : undefined;
  if (trade) return trade.id;
  // A teleport or Leap that lands in reach when walking won't get there.
  if (chosen === MOVE && actor.budget.action) {
    const step = stepToward(actor, context);
    const stats = deriveStats(actor, context);
    const leap =
      step && reachesFrom(actor, step, context)
        ? undefined
        : decision.options.find((option) => {
            const [id, target] = parseOption(option.id);
            const action = stats.actions.find((item) => item.id === id);
            const move = action && moveOf(action);
            return (
              target === actor.id &&
              move &&
              teleportSquares(
                actor,
                move.feet,
                move.movement,
                state,
                context,
              ).some((square) => reachesFrom(actor, square, context))
            );
          });
    if (leap) return leap.id;
  }
  // Cunning Action's Dash when walking alone won't bring a foe into reach this turn.
  if (chosen === MOVE && ids.has(BONUS_DASH) && actor.budget.action) {
    const step = stepToward(actor, context);
    if (!step || !reachesFrom(actor, step, context)) return BONUS_DASH;
  }
  if (chosen !== PASS) return chosen;
  if (ids.has(BONUS_HIDE)) return BONUS_HIDE;
  const offhand = decision.options
    .filter(
      (option) =>
        option.id.startsWith(encodeOption(STRIKE, "")) ||
        option.id.startsWith(encodeOption(OFFHAND, "")) ||
        option.id.startsWith(encodeOption(POLE_STRIKE, "")) ||
        option.id.startsWith(encodeOption(HEW, "")),
    )
    .sort(
      (a, b) =>
        (state.actors[parseOption(a.id)[1] ?? ""]?.hp ?? 0) -
        (state.actors[parseOption(b.id)[1] ?? ""]?.hp ?? 0),
    )[0];
  if (offhand) return offhand.id;
  if (hasTactic(actor, "dash") && ids.has(MOVE) && dashTarget(actor, context)) {
    return MOVE;
  }
  const foes = standing(knownFoes(state, actor, context));
  const [escape] = escapes;
  if (escape) return escape.id;
  if (ids.has(SEARCH)) return SEARCH;
  if (ids.has(DASH) && !ids.has(MOVE) && foes.length > 0) return DASH;
  if (ids.has(DODGE) && foes.some((foe) => within5(foe, actor))) return DODGE;
  return PASS;
}
