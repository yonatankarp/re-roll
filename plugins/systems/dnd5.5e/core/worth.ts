import { type Dice, PLAYER_ACTOR } from "#sdk";
import {
  type Actor,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
} from "./state.ts";
import {
  attackBonus,
  damageResponses,
  deriveStats,
  evaluateFormula,
  immuneToCondition,
  type KnownAction,
  rollAmount,
  saveBonus,
  type Stats,
} from "./stats.ts";
import type { Condition, LeafEffect, Modifier, Resolution } from "./schemas.ts";
import { finalDamage } from "./rules.ts";
import type { Square } from "./grid.ts";
import { dodging } from "./tactics.ts";
import { AIM_AREA, PICK } from "./targeting.ts";
import { ALL, ITEM_PREFIX } from "./combat/ids.ts";
import { DAMAGE_TO_PARTY } from "./combat/effects.ts";
import {
  aimsFor,
  allies,
  attackRoutine,
  canAfford,
  type Context,
  enemies,
  exemptFrom,
  findAction,
  hasFlag,
  hasPassive,
  inReach,
  meleeReach,
  moveSquares,
  slotLevelFor,
  targetCount,
  within5,
} from "./combat/queries.ts";

// What a party member's choices in a fight are worth, as a sensible player weighs them. Everything is in one
// unit, the damage a round one side takes off the other for the rest of the fight: hurting a foe is worth the
// share of its HP taken times what it deals a round, so the dangerous and the nearly dead go first; bringing an
// ally back gives its own damage back; an effect that lasts a round of the fight's few counts that share.
// Averages only, never the game's dice: companions' choices run on them, and a roll here would shift the game.

export const AVERAGE: Dice = {
  below: () => 0,
  roll: (sides: number) => (sides + 1) / 2,
};

// How much of a creature's threat each condition takes away while it lasts.
const CONDITION_WORTH: Readonly<Partial<Record<Condition, number>>> = {
  paralyzed: 1.2, // it loses its turns, and every hit on it in reach is a critical
  petrified: 1,
  stunned: 1,
  unconscious: 1,
  incapacitated: 0.9,
  restrained: 0.45,
  blinded: 0.4,
  charmed: 0.35,
  frightened: 0.35,
  poisoned: 0.25,
  prone: 0.15,
  grappled: 0.1,
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const withEdge = (chance: number, edge: number): number =>
  edge > 0 ? 1 - (1 - chance) ** 2 : edge < 0 ? chance ** 2 : chance;

export interface Judge {
  readonly context: Context;
  readonly stats: (actor: Actor) => Stats;
  // The damage a round a creature deals the other side with its best action.
  readonly threat: (actor: Actor) => number;
  // The same, using only what costs nothing it can run out of: cantrips and weapons.
  readonly freeThreat: (actor: Actor) => number;
  // Rounds the fight is likely to last, 1 to 4.
  readonly horizon: number;
  // How dear a spell slot is: high in a fight the party is winning easily, near 0 in one it's losing.
  readonly slotPrice: number;
  // Taking the Dodge action instead.
  readonly dodgeWorth: (actor: Actor) => number;
  readonly worth: (
    actor: Actor,
    actionId: string,
    targetId: string,
    slot: string | undefined,
  ) => number;
}

function cached<T>(make: (actor: Actor) => T): (actor: Actor) => T {
  const known = new Map<Actor, T>();
  return (actor) => {
    let value = known.get(actor);
    if (value === undefined) {
      value = make(actor);
      known.set(actor, value);
    }
    return value;
  };
}

const standing = (list: readonly Actor[]): Actor[] =>
  list.filter((item) => !isDown(item));

export function makeJudge(context: Context, side: Actor): Judge {
  const { state } = context;
  const damageToParty = DAMAGE_TO_PARTY[state.difficulty ?? "normal"];
  const stats = cached((actor) => deriveStats(actor, context));
  const responses = cached((actor) => damageResponses(actor, context));

  // Advantage (1), Disadvantage (-1) or neither on an attack, as attack.ts rolls it, leaving out sight.
  const attackEdge = (
    attacker: Actor,
    target: Actor,
    action: KnownAction,
  ): number => {
    const close = within5(attacker, target);
    const crowded =
      meleeReach(action) === null &&
      enemies(state, attacker).some(
        (item) =>
          !isDown(item) &&
          !hasCondition(item, ...INCAPACITATING) &&
          within5(item, attacker),
      );
    const up =
      hasFlag(attacker, "advantage", "attacks", stats(attacker)) ||
      hasFlag(target, "advantage", "attacksAgainst", stats(target)) ||
      hasCondition(attacker, "invisible") ||
      hasCondition(
        target,
        "blinded",
        "paralyzed",
        "petrified",
        "restrained",
        "stunned",
        "unconscious",
      ) ||
      (hasCondition(target, "prone") && close);
    const down =
      crowded ||
      dodging(target) ||
      (hasCondition(target, "prone") && !close) ||
      hasFlag(attacker, "disadvantage", "attacks", stats(attacker)) ||
      hasFlag(target, "disadvantage", "attacksAgainst", stats(target)) ||
      hasCondition(
        attacker,
        "blinded",
        "frightened",
        "poisoned",
        "prone",
        "restrained",
      ) ||
      hasCondition(target, "invisible");
    return Number(up) - Number(down);
  };

  const hitChance = (
    attacker: Actor,
    target: Actor,
    action: KnownAction,
    resolution: Extract<Resolution, { kind: "attack" }>,
  ): number => {
    const need = stats(target).ac - attackBonus(resolution, stats(attacker));
    return withEdge(
      clamp((21 - need) / 20, 0.05, 0.95),
      attackEdge(attacker, target, action),
    );
  };

  const saveChance = (
    caster: Actor,
    target: Actor,
    action: KnownAction,
    resolution: Pick<Extract<Resolution, { kind: "save" }>, "ability" | "dc">,
  ): number => {
    const targetStats = stats(target);
    const dc = evaluateFormula(resolution.dc, stats(caster));
    const chance = clamp(
      (21 + saveBonus(targetStats, resolution.ability) - dc) / 20,
      0,
      1,
    );
    const resists =
      action.spellLevel !== null && hasPassive(targetStats, "magicResistance");
    return resists ? 1 - (1 - chance) ** 2 : chance;
  };

  const averageDamage = (
    attacker: Actor,
    target: Actor,
    damage: readonly {
      amount: Parameters<typeof rollAmount>[0];
      type: Parameters<typeof finalDamage>[1];
    }[],
  ): number =>
    damage.reduce(
      (total, { amount, type }) =>
        total +
        finalDamage(
          rollAmount(amount, stats(attacker), AVERAGE),
          type,
          responses(target),
        ),
      0,
    );

  // Extra damage a hit carries from effects already in place: the attacker's Hunter's Mark on the target,
  // or its own Divine Favor or Rage.
  const riders = (
    attacker: Actor,
    target: Actor,
    resolution: Extract<Resolution, { kind: "attack" }>,
  ): number => {
    const weapon = resolution.attack.type === "weapon";
    const extra = [
      ...target.activeEffects.filter(
        ({ casterId, modifier }) =>
          casterId === attacker.id &&
          modifier.kind === "hitDamage" &&
          modifier.dealtBy === "caster",
      ),
      ...attacker.activeEffects.filter(
        ({ modifier }) =>
          modifier.kind === "hitDamage" && modifier.dealtBy === "bearer",
      ),
    ].flatMap(({ modifier }) =>
      modifier.kind === "hitDamage" && (weapon || !modifier.weaponOnly)
        ? [modifier.damage]
        : [],
    );
    const bonus = weapon
      ? attacker.activeEffects.reduce(
          (total, { modifier }) =>
            modifier.kind === "damageBonus"
              ? total + rollAmount(modifier.amount, stats(attacker), AVERAGE)
              : total,
          0,
        )
      : 0;
    return averageDamage(attacker, target, extra) + bonus;
  };

  // The save a hit brings, as a ghoul's claw: the chance the target makes it, or null when it never has to.
  const hitSave = (
    attacker: Actor,
    target: Actor,
    action: KnownAction,
  ): number | null => {
    const { resolution } = action.activation;
    const save =
      resolution.kind === "attack" ? resolution.onHitSave : undefined;
    if (!save || exemptFrom(save.exempt, target, stats(target))) return null;
    return saveChance(attacker, target, action, save);
  };

  // The damage that save adds, on average, once the attack has hit.
  const hitSaveDamage = (
    attacker: Actor,
    target: Actor,
    action: KnownAction,
  ): number => {
    const { resolution } = action.activation;
    const save =
      resolution.kind === "attack" ? resolution.onHitSave : undefined;
    const saved = hitSave(attacker, target, action);
    if (!save || saved === null) return 0;
    const dealt = averageDamage(attacker, target, save.damage);
    const kept =
      save.onSuccessDamage === "full"
        ? 1
        : save.onSuccessDamage === "half"
          ? 0.5
          : 0;
    return (1 - saved) * dealt + saved * kept * dealt;
  };

  // Average damage one use deals one target, before its HP caps it.
  // With `sure`, as if every attack hit and every save failed.
  const expectedDamage = (
    attacker: Actor,
    target: Actor,
    action: KnownAction,
    sure = false,
  ): number => {
    const { resolution } = action.activation;
    switch (resolution.kind) {
      case "attack": {
        const hit = sure ? 1 : hitChance(attacker, target, action, resolution);
        // A critical hit doubles the dice, about one hit in twenty.
        const dealt =
          averageDamage(attacker, target, resolution.damage) +
          riders(attacker, target, resolution);
        return hit * (dealt * 1.05 + hitSaveDamage(attacker, target, action));
      }
      case "save": {
        const saved = sure
          ? 0
          : saveChance(attacker, target, action, resolution);
        const dealt = averageDamage(attacker, target, resolution.damage);
        const half = resolution.onSuccessDamage === "half" ? dealt / 2 : 0;
        return (1 - saved) * dealt + saved * half;
      }
      case "automatic":
        return averageDamage(attacker, target, resolution.damage);
      default:
        return resolution satisfies never;
    }
  };

  const harms = (action: KnownAction): boolean => {
    const { targeting, trigger } = action.activation;
    return (
      !trigger &&
      "side" in targeting &&
      targeting.side === "enemy" &&
      "damage" in action.activation.resolution &&
      action.activation.resolution.damage.length > 0
    );
  };

  const roundDamage = (actor: Actor, free: boolean, sure = false): number => {
    const own = stats(actor);
    const foes = standing(enemies(state, actor)).slice(0, 6);
    if (foes.length === 0) return 0;
    const against = (action: KnownAction): number =>
      foes.reduce(
        (total, foe) => total + expectedDamage(actor, foe, action, sure),
        0,
      ) / foes.length;
    const byId = new Map(own.actions.map((item) => [item.id, item]));
    let best = 0;
    for (const action of own.actions) {
      const { cost, targeting, projectiles } = action.activation;
      if (!harms(action) || !cost.includes("action")) continue;
      if (free && cost.some((item) => item !== "action")) continue;
      // Resources and slots it still has, whatever is left of this turn.
      const affordable = canAfford(
        action,
        {
          ...actor,
          budget: { action: true, bonusAction: true, reaction: true },
        },
        own,
      );
      if (!affordable) continue;
      const routine = attackRoutine(action, actor, own);
      const each = routine.reduce((total, id) => {
        const step = byId.get(id) ?? action;
        return total + against(step);
      }, 0);
      const spread =
        "area" in targeting
          ? Math.min(2, foes.length)
          : (projectiles ??
            Math.min(
              "creatures" in targeting ? targeting.creatures : 1,
              foes.length,
            ));
      best = Math.max(best, each * spread);
    }
    // The difficulty setting scales only the damage the party takes (core/combat/effects.ts).
    return actor.side === "party" ? best : best * damageToParty;
  };
  const threat = cached((actor) => roundDamage(actor, false));
  const freeThreat = cached((actor) => roundDamage(actor, true));
  const hardestRound = cached((actor) => roundDamage(actor, false, true));

  const party = standing(allies(state, side));
  const foes = standing(enemies(state, side));
  const sum = (list: readonly Actor[], of: (actor: Actor) => number): number =>
    list.reduce((total, item) => total + of(item), 0);
  const partyDamage = Math.max(1, sum(party, threat));
  const foesDamage = Math.max(1, sum(foes, threat));
  const toWin = sum(foes, (item) => item.hp) / partyDamage;
  const toLose = sum(party, (item) => item.hp) / foesDamage;
  const horizon = clamp(toWin, 1, 4);
  // Losing (toWin above toLose): spend everything. Winning in a round or two: save slots for later fights.
  const pressure = toWin / Math.max(0.5, toLose);
  const slotPrice = clamp(0.6 - 0.6 * pressure, 0.03, 0.5);
  const meanFoeThreat = foes.length > 0 ? foesDamage / foes.length : 1;
  // The most one foe could deal in a round if everything hit.
  const worstFoe = Math.max(1, ...foes.map(hardestRound));
  // What a point of damage on an average foe is worth.
  const rate =
    meanFoeThreat /
    Math.max(1, sum(foes, (item) => item.hp) / Math.max(1, foes.length));
  // An effect lasting `span` rounds does that share of the fight.
  const lasting = (span: number): number => Math.min(span, horizon) / horizon;

  // A foe's share of HP taken, times what it deals a round. A harmless foe still has to go.
  const hurtWorth = (target: Actor, dealt: number, foe: boolean): number => {
    if (isDown(target) || dealt <= 0) return 0;
    const share = Math.min(1, dealt / Math.max(1, target.hp + target.tempHp));
    if (foe) return share * Math.max(threat(target), 0.25 * meanFoeThreat);
    // Catching a friend costs more than the same blow on a foe gains.
    return (
      -1.5 *
      share *
      (Math.max(threat(target), meanFoeThreat) +
        (target.id === side.id ? meanFoeThreat : 0))
    );
  };

  // The run ends if the player's character dies, so keeping it up counts for more.
  const playerWeight = (target: Actor): number =>
    target.id === PLAYER_ACTOR ? 2 : 1;

  // Bringing a downed ally back gives its turns back, and stops its death saves. Topping up a standing one
  // counts only while the hardest hitter could drop it before it acts again.
  const healWorth = (target: Actor, amount: number): number => {
    if (isDead(target) || amount <= 0) return 0;
    const maxHp = stats(target).maxHp;
    const value = Math.max(threat(target), 0.5 * meanFoeThreat);
    if (isDown(target)) return value * playerWeight(target);
    return keepUpWorth(target, Math.min(amount, maxHp - target.hp));
  };

  // HP kept on a standing creature, by healing it or by sparing it hits.
  function keepUpWorth(target: Actor, kept: number): number {
    if (kept <= 0 || isDown(target)) return 0;
    const value = Math.max(threat(target), 0.5 * meanFoeThreat);
    const risk = clamp(1.25 - target.hp / worstFoe, 0, 1);
    return (
      (risk * value * playerWeight(target) + 0.05 * value) *
      (kept / stats(target).maxHp)
    );
  }

  // Whether a foe could attack the creature on its next turn: awake, and with a harmful action that reaches it
  // now or from a square it can walk to.
  const canReach = (foe: Actor, target: Actor): boolean => {
    if (hasCondition(foe, ...INCAPACITATING)) return false;
    if (!foe.position || !target.position) return true;
    const own = stats(foe);
    const harmful = own.actions.filter(harms);
    const reachesFrom = (square: Square): boolean =>
      harmful.some((action) => {
        const moved = { ...foe, position: square };
        return inReach(action, moved, state, context).some(
          (item) => item.id === target.id,
        );
      });
    return (
      reachesFrom(foe.position) ||
      moveSquares(foe, state, own).some(({ square }) => reachesFrom(square))
    );
  };

  // Dodge spares about two hits in five, worth something to whoever the foes go for: the one lowest on HP.
  const dodgeWorth = (actor: Actor): number => {
    const lowest = Math.min(...party.map((item) => item.hp));
    if (!actor.budget.action || actor.hp > lowest) return 0;
    const coming = foes.filter((foe) => canReach(foe, actor));
    return keepUpWorth(actor, 0.4 * sum(coming, threat));
  };

  const rounds = (
    duration: Extract<LeafEffect, { duration: unknown }>["duration"],
    saved: number,
    repeatSave: boolean,
    endsOnDamage: boolean,
  ): number => {
    if (endsOnDamage) return 1;
    const lasting =
      duration === "instantaneous"
        ? 0.5
        : typeof duration === "object" && "until" in duration
          ? 1
          : horizon;
    return repeatSave ? Math.min(lasting, 1 / Math.max(0.25, saved)) : lasting;
  };

  const modifierWorth = (
    modifier: Modifier,
    target: Actor,
    foe: boolean,
    span: number,
  ): number => {
    const own = threat(target);
    if (foe) {
      switch (modifier.kind) {
        case "lingeringDamage":
          return hurtWorth(
            target,
            averageDamage(side, target, modifier.damage) *
              Math.min(span, horizon) *
              0.75,
            true,
          );
        case "hitDamage":
          // Hunter's Mark or Hex: each of the caster's hits a round adds it.
          return hurtWorth(
            target,
            averageDamage(side, target, [modifier.damage]) *
              Math.max(1, stats(side).multiattack) *
              0.6 *
              Math.min(span, horizon),
            true,
          );
        case "disadvantage":
          return modifier.on === "attacks"
            ? 0.35 * own * lasting(span)
            : 0.1 * own * lasting(span);
        case "advantage":
          return modifier.on === "attacksAgainst"
            ? 0.15 * Math.max(own, meanFoeThreat) * lasting(span)
            : 0;
        case "vulnerability":
          return 0.2 * Math.max(own, meanFoeThreat) * lasting(span);
        default:
          return 0;
      }
    }
    switch (modifier.kind) {
      case "bonus":
        return ["attacks", "ac", "saves"].includes(modifier.to)
          ? 0.12 * Math.max(own, meanFoeThreat * 0.5) * lasting(span)
          : modifier.to === "maxHp"
            ? 0.05 * meanFoeThreat * lasting(span)
            : 0;
      case "advantage":
        return (modifier.on === "attacks" ? 0.25 : 0.05) * own * lasting(span);
      case "disadvantage":
        return modifier.on === "attacksAgainst"
          ? 0.2 * meanFoeThreat * lasting(span)
          : 0;
      case "hitDamage":
      case "damageBonus":
        return 0.2 * own * lasting(span);
      case "resistance":
        return 0.08 * meanFoeThreat * lasting(span);
      case "acFormula":
        return 0.05 * meanFoeThreat * lasting(span);
      default:
        return 0;
    }
  };

  const effectWorth = (
    effect: LeafEffect,
    actor: Actor,
    target: Actor,
    action: KnownAction,
    saved: number,
  ): number => {
    const foe = target.side !== actor.side;
    switch (effect.kind) {
      case "heal":
        return foe
          ? 0
          : healWorth(target, rollAmount(effect.amount, stats(actor), AVERAGE));
      case "tempHp":
        return foe || isDown(target)
          ? 0
          : 0.5 *
              healWorth(
                target,
                rollAmount(effect.amount, stats(actor), AVERAGE),
              );
      case "applyCondition": {
        const { condition } = effect;
        const weight = CONDITION_WORTH[condition] ?? 0;
        if (
          hasCondition(target, condition) ||
          immuneToCondition(stats(target), condition) ||
          isDown(target)
        ) {
          return 0;
        }
        const span = rounds(
          effect.duration,
          saved,
          effect.repeatSave,
          effect.endsOnDamage,
        );
        if (foe) {
          return (
            weight *
            Math.max(threat(target), 0.25 * meanFoeThreat) *
            lasting(span)
          );
        }
        return condition === "invisible"
          ? 0.3 * threat(target) * lasting(span)
          : 0;
      }
      case "removeCondition":
        return !foe && hasCondition(target, effect.condition)
          ? 0.5 * Math.max(threat(target), meanFoeThreat * 0.5)
          : 0;
      case "modifier": {
        // The same effect from the same source is already doing its work.
        if (
          target.activeEffects.some(
            (item) => item.sourceId === action.id && item.casterId === actor.id,
          )
        ) {
          return 0;
        }
        // A boost to its own next attack is wasted once it has no Action left to attack with.
        const { modifier } = effect;
        const ownAttack =
          (modifier.kind === "advantage" && modifier.on === "attacks") ||
          (modifier.kind === "bonus" && modifier.to === "attacks");
        if (
          target.id === actor.id &&
          ownAttack &&
          !actor.budget.action &&
          typeof effect.duration === "object" &&
          "until" in effect.duration
        ) {
          return 0;
        }
        const span = rounds(effect.duration, saved, false, false);
        return modifierWorth(effect.modifier, target, foe, span);
      }
      case "extraAction":
        return actor.budget.action ? 0 : rate * threat(actor);
      default:
        return 0;
    }
  };

  // What one use does to one creature, with `share` of the damage aimed at it (darts split up).
  const worthOn = (
    actor: Actor,
    target: Actor,
    action: KnownAction,
    share = 1,
  ): number => {
    const { resolution } = action.activation;
    const foe = target.side !== actor.side;
    const dealt = expectedDamage(actor, target, action) * share;
    let total = hurtWorth(target, dealt, foe);
    const leaves = (
      list: readonly LeafEffect[],
      chance: number,
      saved: number,
    ): void => {
      for (const effect of list) {
        total += chance * effectWorth(effect, actor, target, action, saved);
      }
    };
    switch (resolution.kind) {
      case "attack": {
        const hit = hitChance(actor, target, action, resolution);
        leaves(resolution.onHit, hit, 1 - hit);
        leaves(resolution.onMiss, 1 - hit, 1 - hit);
        // A condition from the hit's save lasts as a failed save would leave it.
        const saved = hitSave(actor, target, action);
        if (resolution.onHitSave && saved !== null) {
          leaves(resolution.onHitSave.onFail, hit * (1 - saved), saved);
          leaves(resolution.onHitSave.onSuccess, hit * saved, saved);
        }
        break;
      }
      case "save": {
        const saved = saveChance(actor, target, action, resolution);
        leaves(resolution.onFail, 1 - saved, saved);
        leaves(resolution.onSuccess, saved, saved);
        break;
      }
      case "automatic":
        leaves(resolution.effects, 1, 0);
        break;
      default:
        resolution satisfies never;
    }
    return total;
  };

  // Several targets or darts, spent the way pickPolicy spends them: the best first, until each would drop.
  const spread = (
    actor: Actor,
    action: KnownAction,
    candidates: readonly Actor[],
    count: number,
    repeats: boolean,
  ): number => {
    const ranked = candidates
      .map((item) => ({ item, worth: worthOn(actor, item, action) }))
      .sort((a, b) => b.worth - a.worth);
    if (!repeats) {
      return ranked
        .slice(0, count)
        .reduce((total, { worth }) => total + Math.max(0, worth), 0);
    }
    let left = count;
    let total = 0;
    for (const { item } of ranked) {
      if (left <= 0) break;
      const each = expectedDamage(actor, item, action);
      const needed = Math.max(
        1,
        Math.ceil((item.hp + item.tempHp) / Math.max(1, each)),
      );
      const aimed = Math.min(left, needed);
      total += worthOn(actor, item, action, aimed);
      left -= aimed;
    }
    return total;
  };

  const worth = (
    actor: Actor,
    actionId: string,
    targetId: string,
    slot: string | undefined,
  ): number => {
    const level = slotLevelFor(actor, actionId, slot, context);
    const action = findAction(actor, actionId, context, level);
    const { targeting, projectiles } = action.activation;
    let gained: number;
    if (targetId === AIM_AREA) {
      const caught = aimsFor(action, actor, context)[0]?.caught ?? [];
      gained = caught.reduce(
        (total, item) => total + worthOn(actor, item, action),
        0,
      );
    } else if (targetId === ALL && "area" in targeting) {
      const side =
        targeting.side === "enemy"
          ? enemies(state, actor)
          : allies(state, actor);
      gained = side.reduce(
        (total, item) =>
          total + (isDead(item) ? 0 : worthOn(actor, item, action)),
        0,
      );
    } else if (targetId === PICK || targetId === ALL) {
      gained = spread(
        actor,
        action,
        inReach(action, actor, state, context),
        targetCount(findAction(actor, actionId, context), level),
        projectiles !== undefined,
      );
    } else {
      const target = state.actors[targetId];
      if (!target) return 0;
      const darts = projectiles ?? 1;
      gained = worthOn(actor, target, action, darts);
    }
    if (gained <= 0) return gained;
    // What it spends: a slot by its level, a limited use or an item a little.
    const reference =
      rate * Math.max(1, freeThreat(actor), 0.5 * threat(actor));
    const { cost } = action.activation;
    const spent =
      (level !== undefined ? slotPrice * level * reference : 0) +
      cost.filter((item) => typeof item === "object").length *
        0.15 *
        reference +
      (actionId.startsWith(ITEM_PREFIX) ? 0.3 * reference : 0);
    return gained - spent;
  };

  return {
    context,
    stats,
    threat,
    freeThreat,
    horizon,
    slotPrice,
    worth,
    dodgeWorth,
  };
}
