import { afterDamage, reactFrames } from "./reactions.ts";
import {
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
  frameHandler,
} from "#sdk";
import {
  type Actor,
  type ActiveEffect,
  applyDndEvent,
  cannotHeal,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
  frame,
} from "../state.ts";
import { treasure } from "../gear.ts";
import {
  damageResponses,
  deriveStats,
  evaluateFormula,
  immuneToCondition,
  lookup,
  rollAmount,
} from "../stats.ts";
import { z } from "zod";
import { finalDamage, halved } from "../rules.ts";
import { betweenTurns, legendaryResistance } from "../legendary.ts";
import { turnRecharge } from "../class-rules.ts";
import { MonsterSchema } from "../schemas.ts";
import {
  masteredDice,
  masteredTypes,
  rerolledTypes,
  piercing,
  repeatSaveConditions,
  rescuedSave,
} from "../trait-rules.ts";
import {
  actorOf,
  canAfford,
  CHECK_END,
  combatEnded,
  type Context,
  currentActor,
  hasPassive,
} from "./queries.ts";
import { concentrationFrame, dealEvents, rollSave } from "./effects.ts";
import { releasedGrapples } from "./grapple.ts";
import { distanceFeet } from "../grid.ts";
import { regurgitationEvents, releasedSwallows } from "./swallow.ts";
import {
  expiredEvents,
  extraTurnEvents,
  turnStartEvents,
} from "./durations.ts";
import {
  burstResult,
  FRESH,
  fogBoundEvents,
  sunlightFrames,
  zoneFrames,
} from "./areas.ts";
import { antimagicEvents, healingStopped } from "../zones.ts";

// The turn order: ending a fight, lingering effects, and the start and end of each turn.

// Run after nearly every step of a fight, so it's also where grapples whose grappler fell or moved away end.
// Harper Teamwork's Inspiring Willpower: saving out of Frightened or Paralyzed frees an ally within 30 feet of it too.
function sharedRecovery(
  saver: Actor,
  modifier: ActiveEffect["modifier"],
  context: Context,
): SystemEvent[] {
  if (
    modifier.kind !== "condition" ||
    (modifier.condition !== "frightened" &&
      modifier.condition !== "paralyzed") ||
    !hasPassive(deriveStats(saver, context), "sharedRecovery")
  ) {
    return [];
  }
  const { condition } = modifier;
  const ally = Object.values(context.state.actors).find(
    (other) =>
      other.id !== saver.id &&
      other.side === saver.side &&
      distanceFeet(other.position, saver.position) <= 30 &&
      hasCondition(other, condition),
  );
  const held = ally?.activeEffects.find(
    (effect) =>
      effect.modifier.kind === "condition" &&
      effect.modifier.condition === condition,
  );
  return ally && held
    ? [
        dndEvent(`${NS}:effectEnded`, {
          actor: ally.id,
          sourceId: held.sourceId,
          casterId: held.casterId,
        }),
      ]
    : [];
}

export function runCheckCombatEnd(context: Context): SystemResult {
  const burst = burstResult(context);
  if (burst) return burst;
  const released = [
    ...releasedGrapples(context.state, context),
    ...releasedSwallows(context.state, context),
  ];
  const result = fightOver(context);
  return released.length > 0
    ? { ...result, events: [...released, ...(result.events ?? [])] }
    : result;
}

// Sealed away past the stand-off window, or for good.
function shutAway(actor: Actor, state: DndState): boolean {
  const round = state.combat?.round ?? 0;
  return actor.activeEffects.some(
    ({ modifier, lasts }) =>
      modifier.kind === "sealed" &&
      (!lasts || lasts.round - round > STAND_OFF_ROUNDS),
  );
}

function fightOver(context: Context): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const fighters = state.combat.order.map((id) => actorOf(state, id));
  // A foe shut away for longer than a stand-off takes counts as beaten, so a fight never waits out a Maze or a
  // Forcecage; a shorter prison, as Resilient Sphere's minute, is waited out.
  const enemyStanding = fighters.some(
    (actor) =>
      actor.side === "enemy" && !isDown(actor) && !shutAway(actor, state),
  );
  const partyFree = fighters.some(
    (actor) =>
      actor.side === "party" && !isDown(actor) && !shutAway(actor, state),
  );
  // With the whole party shut away, its foes wait it out: the time passes, and what holds them ends.
  if (!partyFree && enemyStanding) {
    const freed = fighters.flatMap((actor) =>
      actor.side === "party" && !isDown(actor)
        ? actor.activeEffects.flatMap(({ modifier, sourceId, casterId }) =>
            modifier.kind === "sealed"
              ? [
                  dndEvent(`${NS}:effectEnded`, {
                    actor: actor.id,
                    sourceId,
                    casterId,
                  }),
                ]
              : [],
          )
        : [],
    );
    if (freed.length > 0) return { events: freed };
  }
  const partyStanding = fighters.some(
    (actor) => actor.side === "party" && !isDown(actor),
  );
  // The story follows the player's character, so their death ends the run even if companions win.
  const playerDead = isDead(actorOf(state, PLAYER_ACTOR));
  if (playerDead || (!partyStanding && enemyStanding)) {
    // shortcut: a party with nobody standing is defeated, even if someone could still recover.
    return !playerDead && state.combat.defeatContinues
      ? { events: combatEnded(state, "defeat") }
      : { events: [{ kind: "partyDefeated" }] };
  }
  if (!enemyStanding) {
    const { loot } = state.combat;
    const found = loot ? treasure(loot, context) : {};
    return {
      events: [...combatEnded(state), ...(found.events ?? [])],
      ...(found.frames ? { frames: found.frames } : {}),
    };
  }
  return {};
}

export function runAfterAction(
  payload: { readonly actor: string },
  context: Context,
): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const actor = actorOf(state, payload.actor);
  const stats = deriveStats(actor, context);
  // The turn carries on only while something other than ending it is still possible.
  const canContinue =
    stats.actions.some(
      (action) => !action.activation.trigger && canAfford(action, actor, stats),
    ) ||
    (actor.budget.bonusAction &&
      stats.passives.some((passive) => passive.kind === "bonusTactics"));
  return canContinue &&
    !isDown(actor) &&
    !hasCondition(actor, ...INCAPACITATING)
    ? {}
    : endOfTurn(context);
}

// One frame per source, as the same spell from two casters doesn't stack and a creature saves only once a turn.
// These are the older cast-time effects, as Moonbeam's: everyone it was cast on keeps it until it ends, wherever it
// walks. Areas that act on whoever stands in them are zones (combat/areas.ts).
function lingeringFrames(actor: Actor, when: "turnStart" | "turnEnd"): Frame[] {
  const seen = new Set<string>();
  return actor.activeEffects.flatMap(({ modifier, sourceId }) => {
    if (
      modifier.kind !== "lingeringDamage" ||
      modifier.when !== when ||
      seen.has(sourceId)
    ) {
      return [];
    }
    seen.add(sourceId);
    return [frame("lingeringTick", { actor: actor.id, sourceId, when })];
  });
}

export const LingeringSchema = z.object({
  actor: z.string(),
  sourceId: z.string(),
  when: z.enum(["turnStart", "turnEnd"]),
});

export function runLingeringTick(
  payload: z.infer<typeof LingeringSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  // The fight may have ended, removing the monsters, with this tick still queued.
  const target = state.actors[payload.actor];
  if (!target) return {};
  const effect = target.activeEffects.find(
    ({ modifier, sourceId }) =>
      sourceId === payload.sourceId &&
      modifier.kind === "lingeringDamage" &&
      modifier.when === payload.when,
  );
  if (effect?.modifier.kind !== "lingeringDamage" || isDead(target)) return {};
  const { damage, save, once } = effect.modifier;
  const stats = deriveStats(state.actors[effect.casterId] ?? target, context);
  const { saved, events: rolled } = save
    ? rollSave(
        target,
        save.ability,
        evaluateFormula(save.dc, stats),
        context,
        effect.sourceId.startsWith("spell:"),
      )
    : { saved: false, events: [] };
  const scale = (amount: number): number => {
    if (!saved || save?.onSuccess === "full") return amount;
    return save?.onSuccess === "half" ? halved(amount) : 0;
  };
  const caster = state.actors[effect.casterId];
  const mastered = caster
    ? masteredTypes(stats, effect.sourceId.startsWith("spell:"))
    : [];
  const responses = caster
    ? piercing(damageResponses(target, context), mastered, stats)
    : damageResponses(target, context);
  const { events, dealt } = dealEvents(
    target,
    damage.map(({ amount, type }) => ({
      amount: finalDamage(
        scale(
          rollAmount(
            amount,
            stats,
            masteredDice(
              dice,
              type,
              mastered,
              caster
                ? rerolledTypes(stats, effect.sourceId.startsWith("spell:"))
                : [],
            ),
          ),
        ),
        type,
        responses,
      ),
      type,
    })),
    false,
    context,
  );
  events.unshift(...rolled);
  if (once || (saved && save?.endsEffect)) {
    events.push(
      dndEvent(`${NS}:effectEnded`, {
        actor: target.id,
        sourceId: effect.sourceId,
      }),
    );
  }
  return {
    events,
    frames: [
      ...afterDamage(
        target,
        dealt,
        {
          ...(caster ? { source: caster.id } : {}),
          types: damage.map(({ type }) => type),
          spell: effect.sourceId.startsWith("spell:"),
        },
        concentrationFrame(target, dealt),
        { ...context, state: events.reduce(applyDndEvent, state) },
      ),
      CHECK_END,
    ],
  };
}

// A monster killed by something at the start of its own turn has no turn to take.
export function runAfterTurnStart(context: Context): SystemResult {
  const actor = currentActor(context.state);
  return actor && isDead(actor) ? endOfTurn(context) : {};
}

function endOfTurn(context: Context): SystemResult {
  const actor = currentActor(context.state);
  const ticks =
    actor && !isDead(actor)
      ? [
          ...lingeringFrames(actor, "turnEnd"),
          ...zoneFrames(actor, "end", context),
        ]
      : [];
  return ticks.length > 0
    ? { frames: [...ticks, frame("finishTurn", {})] }
    : runFinishTurn(context);
}

// A target repeats its save at the end of each of its turns, ending that spell's effects on itself on a success.
export function runFinishTurn(context: Context): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const actor = currentActor(state);
  const repeated = (actor?.activeEffects ?? []).flatMap((effect) =>
    actor &&
    effect.repeatSave &&
    !isDown(actor) &&
    !actor.usedThisTurn.includes(`${FRESH}${effect.sourceId}`)
      ? [{ actor, effect, save: effect.repeatSave }]
      : [],
  );
  const seen = new Set<string>();
  const events: SystemEvent[] = [];
  for (const { actor: target, effect, save } of repeated) {
    const { sourceId, casterId, modifier } = effect;
    // Each caster's effect is saved against on its own, as two snakes' grapples are two grapples.
    if (seen.has(`${casterId}|${sourceId}`)) continue;
    seen.add(`${casterId}|${sourceId}`);
    const rolled = rollSave(
      target,
      save.ability,
      save.dc,
      context,
      sourceId.startsWith("spell:"),
      0,
      repeatSaveConditions(target, sourceId),
    );
    events.push(...rolled.events);
    const resisted = rolled.saved
      ? null
      : legendaryResistance(
          target,
          modifier.kind === "condition" ? [modifier.condition] : [],
          context,
          events,
        );
    if (resisted) events.push(resisted);
    const rescued =
      rolled.saved || resisted
        ? []
        : rescuedSave(
            target,
            save.ability,
            repeatSaveConditions(target, sourceId),
            deriveStats(target, context),
            rolled.events,
            events,
            context.dice,
          );
    events.push(...rescued);
    const worse = (
      target.activeEffects.find(
        (item) =>
          item.sourceId === sourceId &&
          item.casterId === casterId &&
          item.secondFailure,
      ) ?? effect
    ).secondFailure;
    if (rolled.saved || resisted || rescued.length > 0 || worse) {
      events.push(
        dndEvent(`${NS}:effectEnded`, {
          actor: target.id,
          sourceId,
          casterId,
        }),
      );
    }
    if (!worse && (rolled.saved || resisted || rescued.length > 0)) {
      events.push(...sharedRecovery(target, modifier, context));
    }
    // A second failure leaves the worse condition instead, with no more saves.
    if (
      worse &&
      !rolled.saved &&
      !resisted &&
      rescued.length === 0 &&
      !immuneToCondition(deriveStats(target, context), worse.condition)
    ) {
      events.push(
        dndEvent(`${NS}:effectAdded`, {
          actor: target.id,
          effect: {
            sourceId,
            casterId,
            modifier: { kind: "condition", condition: worse.condition },
            ends: worse.ends,
            ...(worse.endsOnDamage ? { endsOnDamage: true } : {}),
          },
        }),
      );
    }
  }
  const ending = [
    ...events,
    ...regurgitationEvents(context),
    ...(actor ? rechargeEvents(actor, context) : []),
    ...(actor ? expiredEvents(state, actor.id, "end") : []),
  ];
  // Time Stop: another turn of its own, with nothing else between.
  let after = state;
  for (const event of ending) after = applyDndEvent(after, event);
  const stopped = actor ? after.actors[actor.id] : undefined;
  const again = stopped && !isDown(stopped) ? extraTurnEvents(stopped) : null;
  if (again) return { events: [...ending, ...again] };
  const between = betweenTurns(state, ending, context);
  return between.length > 0
    ? { events: ending, frames: [...between, frame("advanceTurn", {})] }
    : runAdvanceTurn(context, ending);
}

// The next turn begins, with its start-of-turn effects.
// A minute of fighting with no one hurt, after which a fight ends as a stand-off.
export const STAND_OFF_ROUNDS = 10;

export function runAdvanceTurn(
  context: Context,
  ending: readonly SystemEvent[] = [],
): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const finished = [...ending, dndEvent(`${NS}:turnAdvanced`, {})];
  // Look ahead through the same events, so nothing happens at all unless the next creature has a start-of-turn effect.
  let after = state;
  for (const event of finished) after = applyDndEvent(after, event);
  // A stand-off: nobody has taken damage for a minute, as when neither side can reach or see the other.
  // The party withdraws where the story allows it; otherwise the fight ends as won, without treasure, since
  // that's the only outcome sure to lead the story on rather than back to the scene that started the fight.
  if ((after.combat?.calmRounds ?? 0) >= STAND_OFF_ROUNDS) {
    return {
      events: [
        ...finished,
        ...combatEnded(state, state.combat.canFlee ? "flee" : undefined),
      ],
    };
  }
  const starting = currentActor(after);
  // What runs out as the turn starts goes first, so nothing that ended acts on it.
  const expired = starting ? expiredEvents(after, starting.id, "start") : [];
  for (const event of expired) after = applyDndEvent(after, event);
  const next = currentActor(after);
  const events = [
    ...finished,
    ...expired,
    ...(next ? turnStartEvents(next, after) : []),
    ...(next ? regenerationEvents(next, context) : []),
    ...(next ? fogBoundEvents(next, { ...context, state: after }) : []),
    ...antimagicEvents(after),
    ...reactiveEvents(after, context),
  ];
  const starts = { ...context, state: after };
  const ticks = next
    ? [
        ...lingeringFrames(next, "turnStart"),
        ...sunlightFrames(next, starts),
        ...zoneFrames(next, "start", starts),
      ]
    : [];
  // A reaction to a creature starting its turn nearby, as with Unnerving Gaze.
  const watched = next
    ? reactFrames(
        { kind: "turnStart", actor: next.id },
        { ...context, state: events.reduce(applyDndEvent, state) },
      )
    : [];
  return ticks.length + watched.length > 0
    ? {
        events,
        frames: [...ticks, ...watched, frame("afterTurnStart", {})],
      }
    : { events };
}

// shortcut: Regeneration isn't stopped by the damage types that should stop it, as no damage type taken is kept yet.
function regenerationEvents(actor: Actor, context: Context): SystemEvent[] {
  if (isDown(actor) || healingStopped(actor, context.state, context)) return [];
  const stats = deriveStats(actor, context);
  const hp = stats.passives.reduce(
    (sum, passive) => sum + (passive.kind === "regeneration" ? passive.hp : 0),
    0,
  );
  const amount = cannotHeal(actor) ? 0 : Math.min(hp, stats.maxHp - actor.hp);
  if (amount <= 0) return [];
  // shortcut: all of a troll's Exhaustion is taken as its missing limbs, which grow back as it heals.
  const regrown =
    actor.exhaustion > 0 && hasPassive(stats, "severedLimbs")
      ? [
          dndEvent(`${NS}:exhaustionChanged`, {
            actor: actor.id,
            levels: -actor.exhaustion,
          }),
        ]
      : [];
  return [
    dndEvent(`${NS}:healed`, { actor: actor.id, amount, max: stats.maxHp }),
    ...regrown,
  ];
}

// Reactive: a creature that has one Reaction on every turn gets it back as each turn starts.
function reactiveEvents(state: DndState, context: Context): SystemEvent[] {
  return Object.values(state.actors).flatMap((actor) =>
    !actor.budget.reaction &&
    !isDown(actor) &&
    actor.source.kind === "monster" &&
    hasPassive(deriveStats(actor, context), "reactive")
      ? [dndEvent(`${NS}:reactionRegained`, { actor: actor.id })]
      : [],
  );
}

// shortcut: the roll happens at the end of the monster's turn rather than the start of its next one,
// which gives the same chance, as nothing else can change it in between.
function rechargeEvents(actor: Actor, context: Context): SystemEvent[] {
  if (actor.source.kind !== "monster") return turnRecharge(actor, context);
  const monster = lookup(context, MonsterSchema, actor.source.statBlockId);
  return monster.actions.flatMap((action) => {
    if (action.recharge === undefined) return [];
    const cost = action.activation.cost.find(
      (item) => typeof item === "object",
    );
    if (typeof cost !== "object") return [];
    return (actor.resourcesSpent[cost.resource] ?? 0) > 0 &&
      context.dice.roll(6) >= action.recharge
      ? [
          dndEvent(`${NS}:resourceRestored`, {
            actor: actor.id,
            resource: cost.resource,
          }),
        ]
      : [];
  });
}

export function runEndTurn(context: Context): SystemResult {
  return context.state.combat ? endOfTurn(context) : {};
}

const EmptyPayload = z.object({});

export const turnFrames = {
  [`${NS}:advanceTurn`]: frameHandler({
    schema: EmptyPayload,
    run: (_payload, context: Context) => runAdvanceTurn(context),
  }),
  [`${NS}:lingeringTick`]: frameHandler({
    schema: LingeringSchema,
    run: runLingeringTick,
  }),
  [`${NS}:finishTurn`]: frameHandler({
    schema: EmptyPayload,
    run: (_payload, context: Context) => runFinishTurn(context),
  }),
  [`${NS}:afterTurnStart`]: frameHandler({
    schema: EmptyPayload,
    run: (_payload, context: Context) => runAfterTurnStart(context),
  }),
  [`${NS}:checkCombatEnd`]: frameHandler({
    schema: EmptyPayload,
    run: (_payload, context: Context) => runCheckCombatEnd(context),
  }),
  [`${NS}:endTurn`]: frameHandler({
    schema: EmptyPayload,
    run: (_payload, context: Context) => runEndTurn(context),
  }),
};
