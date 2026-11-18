import { afterDamage, reactFrames } from "./reactions.ts";
import { deathSaveEvents } from "./actions.ts";
import { duelStrayed } from "./duel.ts";
import { castingTurn } from "./casting.ts";
import { confusedBy } from "./confusion.ts";
import {
  groundedEvents,
  reverseGravityEvents,
  turnSaveEvents,
} from "../environment.ts";
import {
  dodgeSaveEvents,
  fledEvents,
  fleeingFrom,
  repeatsNow,
} from "./fear.ts";
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
  familiarOwner,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  fightingOn,
  isStable,
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
  rollDiceNotation,
} from "../stats.ts";
import { z } from "zod";
import { finalDamage, halved } from "../rules.ts";
import { betweenTurns, legendaryResistance } from "../legendary.ts";
import { turnInspiration, turnRecharge } from "../class-rules.ts";
import { ConditionSchema, MonsterSchema } from "../schemas.ts";
import { cureFor } from "./dispel.ts";
import {
  masteredDice,
  masteredTypes,
  flooredTypes,
  rerolledTypes,
  piercing,
  repeatSaveConditions,
  rescuedSave,
  saveSourceOf,
} from "../trait-rules.ts";
import {
  actorOf,
  canAfford,
  quickenedBars,
  CHECK_END,
  combatEnded,
  type Context,
  currentActor,
  hasPassive,
  pacified,
} from "./queries.ts";
import {
  burstEvents,
  concentrationFrame,
  dealEvents,
  leafEvents,
  rollSave,
} from "./effects.ts";
import { grapplesOn, releasedGrapples } from "./grapple.ts";
import { distanceFeet } from "../grid.ts";
import { coverFor, lightAt } from "../sight.ts";
import { reviveUnderwater, suffocationEvents } from "./water.ts";
import { hasTactic, revealEvents, STEALTH_ATTACK } from "../tactics.ts";
import { regurgitationEvents, releasedSwallows } from "./swallow.ts";
import {
  expiredEvents,
  extraTurnEvents,
  turnStartEvents,
} from "./durations.ts";
import {
  burstResult,
  driftResult,
  FRESH,
  fogBoundEvents,
  sunlightFrames,
  zoneFrames,
} from "./areas.ts";
import { fallFrames } from "./falling.ts";
import {
  antimagicEvents,
  healingStopped,
  placedConditionEvents,
  zoneCureEvents,
} from "../zones.ts";
import { madnessStart } from "./madness.ts";
import { headsLeft, headsOf, regrowEvents } from "./heads.ts";

const ALL_CONDITIONS = ConditionSchema.options;

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
  // Those whose lift just ended, or who can't stay up, fall (combat/falling.ts).
  const falls = context.state.combat ? fallFrames(context) : [];
  return {
    ...result,
    events: [...released, ...(result.events ?? [])],
    frames: [...falls, ...(result.frames ?? [])],
  };
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
  // A foe under the party's control counts as beaten, and a friend under a foe's still fights for the party, its
  // control able to end.
  const ownSide = (actor: Actor): Actor["side"] => actor.ownSide ?? actor.side;
  // A foe shut away for longer than a stand-off takes counts as beaten, so a fight never waits out a Maze or a
  // Forcecage; a shorter prison, as Resilient Sphere's minute, is waited out.
  const enemyStanding = fighters.some(
    (actor) =>
      actor.side === "enemy" &&
      ownSide(actor) === "enemy" &&
      !isDown(actor) &&
      !pacified(actor) &&
      !shutAway(actor, state),
  );
  const partyFree = fighters.some(
    (actor) =>
      ownSide(actor) === "party" && !isDown(actor) && !shutAway(actor, state),
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
  // A familiar can't fight on alone.
  const partyStanding = fighters.some(
    (actor) =>
      ownSide(actor) === "party" &&
      !isDown(actor) &&
      familiarOwner(actor) === null,
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
      (action) =>
        !action.activation.trigger &&
        canAfford(action, actor, stats) &&
        !quickenedBars(action, actor),
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
  const { damage, save, once, near } = effect.modifier;
  if (
    near !== undefined &&
    distanceFeet(
      target.position,
      state.actors[effect.casterId]?.position ?? null,
    ) > near
  ) {
    return {};
  }
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
    ? piercing(
        damageResponses(target, context),
        mastered,
        stats,
        effect.sourceId,
      )
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
              caster
                ? flooredTypes(stats, effect.sourceId.startsWith("spell:"))
                : mastered,
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

// Stealth Attack kept the bearer hidden only while it ends the turn behind Three-Quarters or Total Cover from every
// foe standing.
function outOfCover(actor: Actor, context: Context): SystemEvent[] {
  const { state } = context;
  if (
    !actor.usedThisTurn.includes(STEALTH_ATTACK) ||
    !hasTactic(actor, "hidden")
  ) {
    return [];
  }
  const exposed = Object.values(state.actors).some((foe) => {
    if (foe.side === actor.side || isDown(foe) || !foe.position) return false;
    const cover = coverFor(state, foe.position, actor, [foe.id], context);
    return cover !== 5 && cover !== "total";
  });
  return exposed ? revealEvents(actor) : [];
}

// Effects that end as the bearer's turn ends in Bright Light, as Cloak of Shadows', and those of anyone who has become
// Incapacitated, as Draconic Flight's wings, or whose caster has, as Bulwark of Force's. shortcut: the second is checked as each turn ends, not the moment it comes.
function lightAndWakeEnds(
  actor: Actor | undefined,
  context: Context,
): SystemEvent[] {
  const { state } = context;
  return Object.values(state.actors).flatMap((bearer) =>
    bearer.activeEffects.flatMap(
      ({
        endsInLight,
        untilIncapacitated,
        casterIncapacitated,
        sourceId,
        casterId,
      }) =>
        (endsInLight &&
          bearer.id === actor?.id &&
          lightAt(bearer.position, state, context) === "bright") ||
        (untilIncapacitated && hasCondition(bearer, ...INCAPACITATING)) ||
        (casterIncapacitated &&
          ((caster) =>
            !caster ||
            isDead(caster) ||
            isDown(caster) ||
            hasCondition(caster, ...INCAPACITATING))(state.actors[casterId]))
          ? [
              dndEvent(`${NS}:effectEnded`, {
                actor: bearer.id,
                sourceId,
                casterId,
              }),
            ]
          : [],
    ),
  );
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
    !actor.usedThisTurn.includes(`${FRESH}${effect.sourceId}`) &&
    repeatsNow(actor, effect, context)
      ? [{ actor, effect, save: effect.repeatSave }]
      : [],
  );
  const seen = new Set<string>();
  const events: SystemEvent[] = [
    ...(actor ? outOfCover(actor, context) : []),
    ...lightAndWakeEnds(actor, context),
    ...suffocationEvents(actor, context),
    ...(actor ? blinkEvents(actor, context) : []),
  ];
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
      // Heightened Spell's Disadvantage, kept for as long as the spell holds.
      target.activeEffects.some(
        (item) =>
          item.sourceId === sourceId &&
          item.casterId === casterId &&
          item.modifier.kind === "disadvantage" &&
          item.modifier.on === "saves" &&
          item.modifier.casterSpells === true,
      ),
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
            false,
            {
              ...(context.state.actors[casterId]
                ? {
                    source: saveSourceOf(
                      actorOf(context.state, casterId),
                      sourceId,
                      "",
                      context,
                    ),
                  }
                : {}),
              access: context,
            },
          );
    events.push(...rescued);
    // Vision of Elapsing Eons: each failed repeat save is a level of Exhaustion.
    if (
      effect.failExhaustion &&
      !rolled.saved &&
      !resisted &&
      rescued.length === 0
    ) {
      events.push(
        dndEvent(`${NS}:exhaustionChanged`, { actor: target.id, levels: 1 }),
      );
    }
    const holder =
      target.activeEffects.find(
        (item) =>
          item.sourceId === sourceId &&
          item.casterId === casterId &&
          item.secondFailure,
      ) ?? effect;
    const worse = holder.secondFailure;
    // Saves of a kind are counted until there are enough of one, as for Prismatic Spray's indigo ray.
    if (worse?.count) {
      const passed = rolled.saved || resisted !== null || rescued.length > 0;
      const tally = {
        saved: (holder.tally?.saved ?? 0) + (passed ? 1 : 0),
        failed: (holder.tally?.failed ?? 0) + (passed ? 0 : 1),
      };
      if (tally.saved < worse.count && tally.failed < worse.count) {
        events.push(
          dndEvent(`${NS}:effectEnded`, {
            actor: target.id,
            sourceId,
            casterId,
          }),
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: { ...holder, tally },
          }),
        );
        continue;
      }
    }
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
    // A second failure leaves the worse condition instead, with no more saves, and the source's other effects stay,
    // as Contagion's Disadvantage on the chosen ability's saves.
    // shortcut: a worse condition kept by Concentration ends with it, so Flesh to Stone held its whole minute doesn't
    // petrify for good.
    if (
      worse &&
      !rolled.saved &&
      !resisted &&
      rescued.length === 0 &&
      !immuneToCondition(deriveStats(target, context), worse.condition)
    ) {
      for (const companion of target.activeEffects) {
        if (
          companion.sourceId === sourceId &&
          companion.casterId === casterId &&
          companion.modifier.kind !== "condition"
        ) {
          events.push(
            dndEvent(`${NS}:effectAdded`, {
              actor: target.id,
              effect: companion,
            }),
          );
        }
      }
      events.push(
        dndEvent(`${NS}:effectAdded`, {
          actor: target.id,
          effect: {
            sourceId,
            casterId,
            modifier: { kind: "condition", condition: worse.condition },
            ends: worse.ends,
            ...(worse.endsOnDamage ? { endsOnDamage: true } : {}),
            ...(holder.shake ? { shake: true } : {}),
            ...(holder.clings ? { clings: holder.clings } : {}),
            ...(holder.lingers === undefined
              ? {}
              : { lingers: holder.lingers }),
          },
        }),
      );
    }
  }
  const ending = [
    ...events,
    ...(actor ? fledEvents(actor, context) : []),
    ...(actor ? groundedEvents(actor, state) : []),
    ...(actor ? duelStrayed(actor, state) : []),
    ...regurgitationEvents(context),
    ...(actor ? rechargeEvents(actor, context) : []),
    ...(actor ? shakeOffEvents(actor, context) : []),
    ...(actor ? regenerationEvents(actor, context, true) : []),
    ...(actor ? regrowEvents(actor, context) : []),
    ...(actor ? expiredEvents(state, actor.id, "end") : []),
  ];
  // Time Stop: another turn of its own, with nothing else between.
  let after = state;
  for (const event of ending) after = applyDndEvent(after, event);
  const stopped = actor ? after.actors[actor.id] : undefined;
  const again = stopped && !isDown(stopped) ? extraTurnEvents(stopped) : null;
  if (again) return { events: [...ending, ...again] };
  // A reaction to a creature ending its turn nearby, as with Skirmisher.
  const watched =
    actor && stopped && !isDown(stopped)
      ? reactFrames(
          { kind: "turnEnd", actor: actor.id },
          { ...context, state: after },
        )
      : [];
  const between = [...watched, ...betweenTurns(state, ending, context)];
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
  const drifted = next
    ? driftResult(next, { ...context, state: after })
    : { events: [], frames: [] };
  const grappled = next
    ? grappleDamage(next, { ...context, state: after })
    : { events: [], frames: [] };
  // A spell being cast over several turns takes this turn's action too (combat/casting.ts).
  const casting = next ? castingTurn(next) : { events: [], frames: [] };
  const events = [
    ...finished,
    ...expired,
    ...(next ? reviveUnderwater(next, { ...context, state: after }) : []),
    ...(next ? rescueEvents(next, { ...context, state: after }) : []),
    // Rage beyond Death: conscious at 0 Hit Points, still dying.
    ...(next && next.hp <= 0 && fightingOn(next)?.delayDeath && !isStable(next)
      ? deathSaveEvents(next, { ...context, state: after })
      : []),
    ...(next ? banishEvents(next, { ...context, state: after }) : []),
    ...(next ? dodgeSaveEvents(next, { ...context, state: after }) : []),
    ...(next ? turnSaveEvents(next, { ...context, state: after }) : []),
    ...(next ? shakeOffEvents(next, { ...context, state: after }, true) : []),
    ...(next ? reverseGravityEvents(next, { ...context, state: after }) : []),
    ...(next ? turnStartEvents(next, after) : []),
    ...(next ? turnTempHpEvents(next, { ...context, state: after }) : []),
    ...(next ? regenerationEvents(next, context) : []),
    ...grappled.events,
    ...casting.events,
    ...(next ? sharedTempHp(next, { ...context, state: after }) : []),
    ...(next ? turnInspiration(next, { ...context, state: after }) : []),
    ...(next ? fogBoundEvents(next, { ...context, state: after }) : []),
    ...antimagicEvents(after),
    ...placedConditionEvents(after),
    ...zoneCureEvents(after, context),
    ...drifted.events,
    ...reactiveEvents(after, context),
  ];
  const starts = { ...context, state: after };
  const mad = next ? madnessStart(next, starts) : { events: [], frames: [] };
  events.push(...mad.events);
  const ticks = next
    ? [
        ...drifted.frames,
        ...grappled.frames,
        ...casting.frames,
        ...mad.frames,
        ...lingeringFrames(next, "turnStart"),
        ...sunlightFrames(next, starts),
        ...zoneFrames(next, "start", starts),
        ...(confusedBy(next) ? [frame("confusedTurn", {})] : []),
      ]
    : [];
  // A reaction to a creature starting its turn nearby, as with Unnerving Gaze.
  const watched = next
    ? reactFrames(
        { kind: "turnStart", actor: next.id },
        { ...context, state: events.reduce(applyDndEvent, state) },
      )
    : [];
  // Fleeing comes after the reactions, which may set it off, as Flee, Fools! does.
  const fleeing =
    next && (fleeingFrom(next) || watched.length > 0)
      ? [frame("fleeTurn", {})]
      : [];
  return ticks.length + watched.length + fleeing.length > 0
    ? {
        events,
        frames: [...ticks, ...watched, ...fleeing, frame("afterTurnStart", {})],
      }
    : { events };
}

// Unarmed Fighting: damage to one creature the bearer grapples as its turn starts.
function grappleDamage(
  actor: Actor,
  context: Context,
): { events: SystemEvent[]; frames: Frame[] } {
  if (isDown(actor) || hasCondition(actor, ...INCAPACITATING)) {
    return { events: [], frames: [] };
  }
  const stats = deriveStats(actor, context);
  const passive = stats.passives.find((item) => item.kind === "grappleDamage");
  const held = Object.values(context.state.actors).find(
    (other) =>
      !isDead(other) &&
      grapplesOn(other).some(({ casterId }) => casterId === actor.id),
  );
  if (passive?.kind !== "grappleDamage" || !held) {
    return { events: [], frames: [] };
  }
  const { events, dealt } = dealEvents(
    held,
    [
      {
        amount: finalDamage(
          rollDiceNotation(passive.dice, context.dice),
          passive.type,
          damageResponses(held, context),
        ),
        type: passive.type,
      },
    ],
    false,
    context,
  );
  return { events, frames: [...concentrationFrame(held, dealt)] };
}

// Life-Giving Force: Temporary Hit Points for the ally nearby that has the fewest Hit Points left.
function sharedTempHp(actor: Actor, context: Context): SystemEvent[] {
  if (isDown(actor)) return [];
  const stats = deriveStats(actor, context);
  return stats.passives.flatMap((passive) => {
    if (
      passive.kind !== "turnTempHp" ||
      !actor.activeEffects.some(({ sourceId }) =>
        passive.while.some((id) => sourceId.startsWith(`feature:${id}:`)),
      )
    ) {
      return [];
    }
    const [ally] = Object.values(context.state.actors)
      .filter(
        (other) =>
          other.id !== actor.id &&
          other.side === actor.side &&
          !isDead(other) &&
          distanceFeet(actor.position, other.position) <= passive.within,
      )
      .sort((a, b) => a.hp + a.tempHp - (b.hp + b.tempHp));
    return ally
      ? [
          dndEvent(`${NS}:tempHpGained`, {
            actor: ally.id,
            amount: rollAmount(passive.amount, stats, context.dice),
          }),
        ]
      : [];
  });
}

// Searing Vengeance: a creature about to make a Death Saving Throw as its turn starts springs back up instead, with
// half its Hit Points, and a burst of light round it.
function rescueEvents(actor: Actor, context: Context): SystemEvent[] {
  if (actor.side !== "party" || actor.hp > 0 || isDead(actor)) return [];
  if (isStable(actor)) return [];
  for (const bearer of Object.values(context.state.actors)) {
    if (bearer.side !== actor.side || isDead(bearer)) continue;
    const stats = deriveStats(bearer, context);
    const rescue = stats.passives.find(
      (passive) =>
        passive.kind === "deathSaveRescue" &&
        (bearer.resourcesSpent[passive.resource] ?? 0) <
          (stats.resources[passive.resource] ?? 0) &&
        (bearer.id === actor.id ||
          (passive.within !== undefined &&
            !isDown(bearer) &&
            distanceFeet(bearer.position, actor.position) <= passive.within)),
    );
    if (rescue?.kind !== "deathSaveRescue") continue;
    const { maxHp } = deriveStats(actor, context);
    return [
      dndEvent(`${NS}:resourceSpent`, {
        actor: bearer.id,
        resource: rescue.resource,
      }),
      dndEvent(`${NS}:healed`, {
        actor: actor.id,
        amount: halved(maxHp),
        max: maxHp,
      }),
      ...(hasCondition(actor, "prone")
        ? [
            dndEvent(`${NS}:conditionRemoved`, {
              actor: actor.id,
              condition: "prone",
            }),
          ]
        : []),
      ...burstEvents(actor, bearer, { ...rescue, blind: true }, context),
    ];
  }
  return [];
}

// Prismatic Spray's violet ray: as the caster's next turn starts, each creature it blinded saves again, and a
// failure sends it to another plane for good, shut away as a sealed creature is.
function banishEvents(caster: Actor, context: Context): SystemEvent[] {
  return Object.values(context.state.actors).flatMap((actor) => {
    const effect = actor.activeEffects.find(
      (item) => item.banish && item.casterId === caster.id,
    );
    if (!effect?.banish || isDead(actor)) return [];
    const { sourceId, casterId } = effect;
    const save = rollSave(
      actor,
      effect.banish.ability,
      effect.banish.dc,
      context,
      true,
    );
    return [
      ...save.events,
      dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId, casterId }),
      ...(save.saved
        ? []
        : [
            dndEvent(`${NS}:effectAdded`, {
              actor: actor.id,
              effect: {
                sourceId,
                casterId,
                modifier: { kind: "sealed" },
                ends: "spellDuration",
              },
            }),
          ]),
    ];
  });
}

// shortcut: Regeneration isn't stopped by the damage types that should stop it, as no damage type taken is kept yet.
// Self-Restoration: at the end of its turn the bearer ends the worst of these conditions on itself.
function shakeOffEvents(
  actor: Actor,
  context: Context,
  start = false,
): SystemEvent[] {
  if (isDown(actor)) return [];
  const stats = deriveStats(actor, context);
  return stats.passives.flatMap((passive) => {
    if (passive.kind !== "shakeOff" || (passive.turnStart === true) !== start) {
      return [];
    }
    // Guarded Mind: every one of them ends, for a use of the resource.
    if (start) {
      const held = passive.conditions.filter((item) =>
        hasCondition(actor, item),
      );
      const { resource } = passive;
      if (
        held.length === 0 ||
        (resource !== undefined &&
          (actor.resourcesSpent[resource] ?? 0) >=
            (stats.resources[resource] ?? 0))
      ) {
        return [];
      }
      return [
        ...(resource
          ? [dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource })]
          : []),
        ...held.map((condition) =>
          dndEvent(`${NS}:conditionRemoved`, { actor: actor.id, condition }),
        ),
      ];
    }
    const condition = cureFor(actor, passive.conditions);
    return condition
      ? [dndEvent(`${NS}:conditionRemoved`, { actor: actor.id, condition })]
      : [];
  });
}

function regenerationEvents(
  actor: Actor,
  context: Context,
  turnEnd = false,
): SystemEvent[] {
  if (isDown(actor) || healingStopped(actor, context.state, context)) return [];
  if (turnEnd && hasCondition(actor, ...INCAPACITATING)) return [];
  const stats = deriveStats(actor, context);
  const bloodied = actor.hp * 2 <= stats.maxHp;
  const hp = stats.passives.reduce(
    (sum, passive) =>
      passive.kind !== "regeneration" ||
      (passive.turnEnd ?? false) !== turnEnd ||
      (passive.bloodied && !bloodied) ||
      (passive.whileEffect !== undefined &&
        !actor.activeEffects.some(
          ({ sourceId }) => sourceId === passive.whileEffect,
        ))
        ? sum
        : sum +
          (typeof passive.hp === "number"
            ? passive.hp
            : rollAmount(passive.hp, stats, context.dice)),
    0,
  );
  const amount = cannotHeal(actor) ? 0 : Math.min(hp, stats.maxHp - actor.hp);
  // Metabolic Control also ends the condition that hampers it most.
  const cured =
    !turnEnd &&
    stats.passives.some(
      (passive) => passive.kind === "regeneration" && passive.cures,
    )
      ? cureFor(actor, ALL_CONDITIONS)
      : null;
  const curing = cured
    ? [
        dndEvent(`${NS}:conditionRemoved`, {
          actor: actor.id,
          condition: cured,
        }),
      ]
    : [];
  if (amount <= 0) return curing;
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
    ...curing,
  ];
}

// Reactive Heads: a hydra with heads to spare, whose only Reaction is an Opportunity Attack, has one a head.
// shortcut: it gets its Reaction back on every turn, as Reactive gives, rather than counting one a head.
function reactsEveryTurn(
  actor: Actor,
  stats: ReturnType<typeof deriveStats>,
): boolean {
  const heads = headsOf(stats);
  return (
    hasPassive(stats, "reactive") ||
    (heads !== undefined && headsLeft(actor, heads) > 1)
  );
}

// Reactive: a creature that has one Reaction on every turn gets it back as each turn starts.
function reactiveEvents(state: DndState, context: Context): SystemEvent[] {
  return Object.values(state.actors).flatMap((actor) =>
    !actor.budget.reaction &&
    !isDown(actor) &&
    actor.source.kind === "monster" &&
    reactsEveryTurn(actor, deriveStats(actor, context))
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
      (item) => typeof item === "object" && "resource" in item,
    );
    if (typeof cost !== "object" || !("resource" in cost)) return [];
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

// Heroism: Temporary Hit Points as the bearer's turn starts, from its caster's numbers, the best of them.
function turnTempHpEvents(actor: Actor, context: Context): SystemEvent[] {
  const gains = actor.activeEffects.flatMap(({ modifier, casterId }) =>
    modifier.kind === "turnTempHp"
      ? [
          rollAmount(
            modifier.amount,
            deriveStats(context.state.actors[casterId] ?? actor, context),
            context.dice,
          ),
        ]
      : [],
  );
  const most = Math.max(0, ...gains);
  return most > actor.tempHp && !isDead(actor)
    ? [dndEvent(`${NS}:tempHpGained`, { actor: actor.id, amount: most })]
    : [];
}

// Blink: a d6 as the bearer's turn ends, and on a 4 or more it's on the Ethereal Plane, shut away until its next turn.
function blinkEvents(actor: Actor, context: Context): SystemEvent[] {
  const blink = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "blink",
  );
  if (!blink || isDown(actor) || context.dice.roll(6) < 4) return [];
  return leafEvents(
    [
      {
        kind: "modifier",
        modifier: { kind: "sealed" },
        duration: { until: "yourNextTurnStart" },
      },
    ],
    `${blink.sourceId}:ethereal`,
    actor,
    actor,
    context,
  );
}
