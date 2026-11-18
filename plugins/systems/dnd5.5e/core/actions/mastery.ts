import {
  concentrationFrame,
  type Context,
  dealEvents,
  HitSchema,
  meleeReach,
  within5,
} from "../combat.ts";
import {
  currentActor,
  hitFits,
  sizeOf,
  SIZES,
  underEffect,
} from "../combat/queries.ts";
import { afterDamage } from "../combat/reactions.ts";
import { knownFoes } from "../fog.ts";
import { distanceFeet } from "../grid.ts";
import {
  type Ability,
  type WeaponMastery,
  WeaponMasterySchema,
} from "../schemas.ts";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  frame,
  hasCondition,
  isDown,
  NS,
} from "../state.ts";
import {
  damageResponses,
  deriveStats,
  type KnownAction,
  modifierFor,
} from "../stats.ts";
import { hasTactic, MASTERY, masteryOf } from "../tactics.ts";
import { effect, standing } from "./common.ts";
import { pushEvents, reportedSave, saveDc } from "./contests.ts";
import { CHECK_END, CLEAVE_USED } from "./ids.ts";
import { awaitDecision, type SystemResult } from "#sdk";
import { z } from "zod";

// `answer` is the mastery property picked in place of the weapon's own, as with Tactical Master.
export const MasteryHitSchema = HitSchema.extend({
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
    (passive.while
      ? underEffect(attacker, passive.while)
      : currentActor(state)?.id === attacker.id)
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
        amount: amount,
        response: damageResponses(target, context),
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
