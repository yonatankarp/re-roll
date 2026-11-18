import {
  deriveStats,
  evaluateFormula,
  type KnownAction,
  type Stats,
} from "../../stats.ts";
import { type Actor, dndEvent, isDead, NS, turnId } from "../../state.ts";
import { type Frame, type SystemEvent } from "#sdk";
import {
  type DamageType,
  type AlliesRider,
  type LeafEffect,
} from "../../schemas.ts";
import { distanceFeet } from "../../grid.ts";
import { allies, type Context, hitFits, underEffect } from "../queries.ts";
import { leafEvents } from "./leaf.ts";
import { reactionAttack, reactionMove } from "./forced-reactions.ts";

// Riders: what a damage type, an activation's allies or a Dash or Disengage adds.

// Riders on a creature the bearer damages with this type, as Crusher or Slasher give, from an attack or a spell.
export function damageRiders(
  attacker: Actor,
  target: Actor,
  types: ReadonlySet<DamageType>,
  critical: boolean,
  stats: Stats,
  context: Context,
  spell = false, // from a spell's damage, which only a rider with `spells` takes
  hitWith?: KnownAction, // the attack that hit, for a rider limited to some hits
): SystemEvent[] {
  const { combat } = context.state;
  return stats.passives.flatMap((passive, index) => {
    if (passive.kind !== "damageRider") return [];
    if (passive.damage !== undefined && !types.has(passive.damage)) return [];
    if (
      passive.with &&
      !(hitWith && hitFits(passive.with, hitWith, attacker, context))
    ) {
      return [];
    }
    // A hit during the target's own turn is an Opportunity Attack.
    if (passive.opportunity && combat && turnId(combat) !== target.id) {
      return [];
    }
    if (spell && !passive.spells) return [];
    if (passive.critical && !critical) return [];
    if (passive.while && !underEffect(attacker, passive.while)) return [];
    if (passive.firstRound && (combat?.round ?? 1) > 1) return [];
    if (passive.ownTurn && combat && turnId(combat) !== attacker.id) {
      return [];
    }
    const key =
      passive.damage === undefined
        ? `rider:${String(index)}`
        : `rider:${passive.damage}:${String(passive.critical)}`;
    if (passive.oncePerTurn && attacker.usedThisTurn.includes(key)) return [];
    const { resource } = passive;
    if (
      resource &&
      (attacker.resourcesSpent[resource] ?? 0) >=
        (stats.resources[resource] ?? 0)
    ) {
      return [];
    }
    return [
      ...(passive.oncePerTurn
        ? [dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key })]
        : []),
      ...(resource
        ? [dndEvent(`${NS}:resourceSpent`, { actor: attacker.id, resource })]
        : []),
      ...leafEvents(passive.effects, key, attacker, target, context),
      ...(passive.selfEffects ?? []).flatMap((effect) =>
        effect.kind === "reactionMove"
          ? reactionMove(
              { ...attacker, budget: { ...attacker.budget, reaction: true } },
              context,
              effect,
              target,
            ).filter((event) => event.kind !== `${NS}:budgetSpent`)
          : leafEvents([effect], key, attacker, attacker, context),
      ),
    ];
  });
}

// What taking the Dash or Disengage action gives its taker until its turn ends, as Speedy's Dash over Difficult Terrain.
export function tacticRiderEvents(
  actor: Actor,
  stats: Stats,
  tactic: "dash" | "disengage",
): SystemEvent[] {
  return stats.passives.flatMap((passive, index) =>
    passive.kind === "tacticRider" && passive.tactic === tactic
      ? passive.modifiers.map((modifier) =>
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              sourceId: `tactic-rider:${tactic}:${String(index)}`,
              casterId: actor.id,
              modifier,
              ends: "casterTurnEnd",
            },
          }),
        )
      : [],
  );
}

// What an activation or a spell's rider does to the bearer's allies near it, whatever its targets, as Rallying Cry's
// healing with Second Wind: the most hurt first, up to each rider's count.
export function alliesRiderEvents(
  riders: readonly AlliesRider[],
  sourceId: string,
  actor: Actor,
  context: Context,
): { events: SystemEvent[]; frames: Frame[] } {
  const stats = deriveStats(actor, context);
  const spent: Record<string, number> = {};
  const frames: Frame[] = [];
  // An ally's reaction, as a Banneret's Rallying Surge gives, is taken as the forced reactions are; the rest are leaves.
  const onAlly = (effects: readonly LeafEffect[], ally: Actor): SystemEvent[] =>
    effects.flatMap((effect) => {
      if (effect.kind === "reactionMove") {
        return reactionMove(ally, context, effect, actor);
      }
      if (effect.kind === "reactionAttack") {
        const struck = reactionAttack(ally, context);
        frames.push(...struck.frames);
        return struck.events;
      }
      return leafEvents([effect], sourceId, actor, ally, context);
    });
  const events = riders.flatMap((rider) => {
    if (rider.without?.some((id) => stats.features.includes(id))) return [];
    const effects = [
      ...rider.effects,
      ...(rider.with ?? []).flatMap((more) =>
        stats.features.includes(more.feature) ? more.effects : [],
      ),
    ];
    const near = allies(context.state, actor)
      .filter(
        (ally) =>
          ally.id !== actor.id &&
          !isDead(ally) &&
          distanceFeet(actor.position, ally.position) <= rider.within,
      )
      .sort(
        (a, b) =>
          a.hp / deriveStats(a, context).maxHp -
          b.hp / deriveStats(b, context).maxHp,
      )
      .slice(
        0,
        rider.count
          ? Math.max(1, evaluateFormula(rider.count, stats))
          : Infinity,
      );
    if (near.length === 0) return [];
    const costs: SystemEvent[] = [];
    if (rider.resource) {
      const left =
        (stats.resources[rider.resource] ?? 0) -
        (actor.resourcesSpent[rider.resource] ?? 0) -
        (spent[rider.resource] ?? 0);
      if (left <= 0) return [];
      spent[rider.resource] = (spent[rider.resource] ?? 0) + 1;
      costs.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: rider.resource,
        }),
      );
    }
    return [...costs, ...near.flatMap((ally) => onAlly(effects, ally))];
  });
  return { events, frames };
}
