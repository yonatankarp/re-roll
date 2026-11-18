import { z } from "zod";
import {
  type Actor,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import { DECLINE } from "../ids.ts";
import { distanceFeet } from "../../grid.ts";
import {
  awaitDecision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import {
  type Edge,
  playerTakes,
  rollRewards,
  respond,
  type Roll,
  rollResponder,
  inspiredSwing,
} from "../reactions.ts";
import { deriveStats, type KnownAction, evaluateFormula } from "../../stats.ts";
import { markedBy } from "../../trait-rules.ts";
import { actorOf, canAfford, type Context, findAction } from "../queries.ts";
import { acBonusOf, kinNear, holds, redirects } from "./guards.ts";
import { AttackSchema } from "./payloads.ts";

// Reports whether a reaction could still change the result of this attack.
export function reactionFor(
  target: Actor,
  total: number,
  ac: number,
  context: Context,
  critical: boolean,
  melee: boolean,
  spell = false,
  attacker?: Actor,
  types: readonly string[] = [],
): KnownAction | null {
  if (
    !target.budget.reaction ||
    isDown(target) ||
    hasCondition(target, ...INCAPACITATING)
  ) {
    return null;
  }
  const stats = deriveStats(target, context);
  return (
    stats.actions.find((action) => {
      const { activation } = action;
      if (!activation.trigger?.hitByAttack || !canAfford(action, target, stats))
        return false;
      if (activation.trigger.melee && !melee) return false;
      if (activation.trigger.ranged && melee) return false;
      if (activation.trigger.bySpell && !spell) return false;
      if (!holds(target, activation.trigger.holding, context)) return false;
      // Armor of Hexes: only a creature the bearer cursed; Instinctive Charm: only one this near.
      if (
        activation.trigger.marked &&
        (!attacker || !markedBy(attacker, target, activation.trigger.marked))
      ) {
        return false;
      }
      if (
        activation.trigger.within !== undefined &&
        (!attacker ||
          distanceFeet(attacker.position, target.position) >
            activation.trigger.within)
      ) {
        return false;
      }
      // Deflect Attacks: only an attack dealing one of these types.
      if (
        activation.trigger.damagedBy &&
        !activation.trigger.damagedBy.some((type) => types.includes(type))
      ) {
        return false;
      }
      // Mythal Ward's table may turn the spell aside, so a spell attack's hit is always offered to it.
      if (activation.table) return true;
      const { resolution } = activation;
      // Jinx or Warding Charm: the attacker's save may make even a Critical Hit miss. Elemental Rebuke halves the
      // hit, then the attacker saves.
      if (resolution.kind === "save") {
        return (
          resolution.onFail.some((effect) => effect.kind === "negateHit") ||
          (activation.selfEffects ?? []).some(
            (effect) => effect.kind === "reduceDamage",
          )
        );
      }
      if (resolution.kind !== "automatic") return false;
      // Illusory Self: the hit misses outright; Sentinel at Death's Door: a Critical Hit is a normal one.
      if (resolution.effects.some((effect) => effect.kind === "negateHit")) {
        return true;
      }
      if (
        critical &&
        resolution.effects.some((effect) => effect.kind === "noCritical")
      ) {
        return true;
      }
      const reduce = resolution.effects.find(
        (effect) => effect.kind === "reduceDamage",
      );
      if (reduce) {
        return (
          !reduce.toNear || kinNear(target, reduce.toNear, context) !== null
        );
      }
      if (critical) return false;
      const acBonus = resolution.effects.reduce((sum, effect) => {
        if (effect.kind === "acAgainstHit") {
          return sum + acBonusOf(effect, stats);
        }
        return effect.kind === "modifier" &&
          effect.modifier.kind === "bonus" &&
          effect.modifier.to === "ac" &&
          (!effect.modifier.melee || melee) &&
          (!effect.modifier.ranged || !melee)
          ? sum +
              evaluateFormula(
                effect.modifier.amount.bonus ?? { base: 0, add: [] },
                stats,
              )
          : sum;
      }, 0);
      return total < ac + acBonus;
    }) ?? null
  );
}

// The bearer's own activation for this trigger that it can pay for now, as Lucky's.
export function ownTrigger(
  actor: Actor,
  when: "attacked",
  context: Context,
  advantage = false, // the attack roll has Advantage
  pressed = true, // the bearer is hurt or the attack has Advantage, when a use worth keeping is spent
): KnownAction | null {
  const stats = deriveStats(actor, context);
  return (
    stats.actions.find((item) => {
      const trigger = item.activation.trigger;
      const cheap = item.activation.cost.every((cost) => cost === "reaction");
      return (
        trigger?.[when] &&
        !(trigger.noAdvantage && advantage) &&
        (pressed || cheap) &&
        !redirects(item) &&
        canAfford(item, actor, stats) &&
        (actor.id !== PLAYER_ACTOR ||
          playerTakes(
            when,
            `You're attacked. Use ${item.name}?`,
            item,
            context,
          ))
      );
    }) ?? null
  );
}

// Settles the reactions to an attack roll before it lands. Monsters and companions answer by tactics; the player
// is asked, and the roll is held in the attack's payload until they answer (runRollReaction).
export function rollWindow(
  attack: z.infer<typeof AttackSchema>,
  roll: Roll,
  held: Edge & { readonly base: number; readonly bonus: number },
  judge: (
    natural: number,
    bonus: number,
  ) => { total: number; success: boolean; critical: boolean },
  context: Context,
):
  | {
      readonly events: SystemEvent[];
      readonly natural: number;
      readonly bonus: number;
    }
  | { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const passed = [...(attack.passed ?? [])];
  const events: SystemEvent[] = [];
  let current = { ...roll, edged: held.advantage !== held.disadvantage };
  let bonus = held.bonus;
  for (;;) {
    const found = rollResponder(current, passed, context);
    if (!found) {
      const inspired = inspiredSwing(current, context);
      return {
        events: [...events, ...inspired.events],
        natural: current.natural,
        bonus: bonus + inspired.bonus,
      };
    }
    const { reactor, action } = found;
    if (reactor.id === PLAYER_ACTOR) {
      const rolled = {
        natural: current.natural,
        base: held.base,
        bonus,
        advantage: held.advantage,
        disadvantage: held.disadvantage,
      };
      return {
        events,
        frames: [
          awaitDecision({
            id: `${NS}:reaction:${reactor.id}`,
            actor: reactor.id,
            prompt: `${roll.roller.name} rolls ${String(current.natural)} (${String(current.total)}) against ${roll.against?.name ?? "its target"}: ${current.success ? "a hit" : "a miss"}. Use ${action.name}?`,
            options: [
              { id: action.id, label: action.name },
              { id: DECLINE, label: "Let it stand" },
            ],
            resume: frame("rollReaction", {
              ...attack,
              rolled,
              passed,
              reactor: reactor.id,
            }),
          }),
        ],
      };
    }
    passed.push(reactor.id);
    const taken = respond(reactor, action, current, held, context);
    events.push(...taken.events);
    bonus += taken.bonus;
    current = {
      ...current,
      natural: taken.natural,
      ...judge(taken.natural, bonus),
    };
    events.push(
      ...rollRewards(
        reactor,
        action,
        roll.roller,
        taken.tempHp,
        current.success,
        context,
      ),
    );
  }
}

export const RollReactionSchema = AttackSchema.extend({
  reactor: z.string(),
  answer: z.string(),
});

// The player's answer to an attack roll: the roll goes on with the reaction's change, or as it was.
export function runRollReaction(
  payload: z.infer<typeof RollReactionSchema>,
  context: Context,
): SystemResult {
  const { reactor: reactorId, answer, ...attack } = payload;
  const passed = [...(attack.passed ?? []), reactorId];
  const { rolled } = attack;
  if (answer === DECLINE || !rolled) {
    return { frames: [frame("attackRoll", { ...attack, passed })] };
  }
  const { state } = context;
  const reactor = actorOf(state, reactorId);
  const action = findAction(reactor, answer, context);
  const roller = actorOf(state, attack.attacker);
  const total = rolled.natural + rolled.base + rolled.bonus;
  const taken = respond(
    reactor,
    action,
    {
      roller,
      kind: "attack",
      natural: rolled.natural,
      total,
      success: false,
      goal: 0,
      against: actorOf(state, attack.target),
    },
    rolled,
    context,
  );
  return {
    events: taken.events,
    frames: [
      frame("attackRoll", {
        ...attack,
        passed,
        rolled: {
          ...rolled,
          natural: taken.natural,
          bonus: rolled.bonus + taken.bonus,
        },
      }),
    ],
  };
}
