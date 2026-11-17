import { prisonEvents } from "./fear.ts";
import { z } from "zod";
import { placedFlag } from "../zones.ts";
import { concentrationBonus } from "./school.ts";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  type DndState,
  hasCondition,
  equipped,
  INCAPACITATING,
  isDead,
  isDown,
  mountOf,
  NS,
  frame,
} from "../state.ts";
import { ALL, DECLINE, encodeOption, parseOption } from "./ids.ts";
import { forgoAdvantageFrame, forgoFrame, SNEAK_DICE } from "./strikes.ts";
import { lastsFor } from "./durations.ts";
import { aroundHit, replaceHitFrame, runReplaceHit } from "./ranged-smite.ts";
import { againstTarget, missFrames, runApplyMiss } from "./spell-riders.ts";
import { duelBroken, duelDamaged, duelHampers } from "./duel.ts";
import { distanceFeet } from "../grid.ts";
import { grapplesOn } from "./grapple.ts";
import {
  behindTotalCover,
  blindedTo,
  coverAgainst,
  seeing,
  unseenInvisible,
} from "../sight.ts";
import { insideDamageEvents, swallowerOf } from "./swallow.ts";
import {
  awaitDecision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
  frameHandler,
} from "#sdk";
import {
  afterDamage,
  type Edge,
  playerTakes,
  reactFrames,
  respond,
  type Roll,
  rollOnTable,
  rollResponder,
  slotRefund,
  strikeAction,
} from "./reactions.ts";
import {
  attackBonus,
  damageResponses,
  deriveStats,
  immuneToCondition,
  type KnownAction,
  lookup,
  modifierFor,
  passiveModifiers,
  evaluateFormula,
  rollAmount,
  rollDiceNotation,
  saveBonus,
  spellSaveDc,
  type Stats,
} from "../stats.ts";
import { finalDamage, halved, rollD20 } from "../rules.ts";
import {
  CHARGE_FROM,
  dodging,
  grappledAwayFrom,
  HEW_READY,
  HIDE_SOURCE,
  masteryOf,
  revealEvents,
  STEALTH_ATTACK,
  tacticsOf,
} from "../tactics.ts";
import {
  asHit,
  criticalFrom,
  offerInspiration,
  onceEnded,
} from "../class-rules.ts";
import { conditionsApplied } from "../legendary.ts";
import {
  type Damage,
  type DamageType,
  type Formula,
  ItemSchema,
  type LeafEffect,
  MonsterSchema,
  type Resolution,
} from "../schemas.ts";
import {
  armoredReduction,
  holdsShield,
  HIGHEST,
  masteredDice,
  markedBy,
  maximized,
  masteredTypes,
  rerolledTypes,
  piercing,
  rescuedSave,
  saveSourceOf,
  evades,
  steadyShot,
  traitAttackAdvantage,
  WARD_DOWN,
  warded,
  weaponDamageDice,
} from "../trait-rules.ts";
import {
  actorOf,
  allies,
  canAfford,
  extraFits,
  hitFits,
  charmersOf,
  CHECK_END,
  type Context,
  enemies,
  exemptFrom,
  findAction,
  onceKey,
  reaches,
  isStuck,
  fitsType,
  hasFlag,
  hasPassive,
  ridden,
  underEffect,
  isMelee,
  meleeReach,
  rollBonus,
  sizeOf,
  slotToSpend,
  within5,
  withUpcasts,
} from "./queries.ts";
import {
  actingEnds,
  concentrationFrame,
  damageRiders,
  dealEvents,
  leafEvents,
  payCosts,
  protectedMount,
  reactionMove,
  resolveAction,
  rollSave,
  typeAgainst,
} from "./effects.ts";

// A resource spent on the bearer: this attacker is freed of its Among the Dead until a Long Rest.
const DETERRED = "deterred:";
// Attack rolls and what follows a hit: reactions, damage, riders, smites and concentration saves.

export const AttackSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
  noModifier: z.boolean().optional(), // an off-hand or Cleave attack, whose damage leaves out the ability modifier
  poleStrike: z.boolean().optional(), // Polearm Master's attack with the other end: a d4 of Bludgeoning
  // The d20 already rolled, held while a reaction to it was decided (combat/reactions.ts): its natural, the bonus
  // the roll had, what reactions added, and whether it had Advantage or Disadvantage.
  rolled: z
    .object({
      natural: z.number(),
      base: z.number(),
      bonus: z.number(),
      advantage: z.boolean(),
      disadvantage: z.boolean(),
    })
    .optional(),
  passed: z.array(z.string()).optional(), // creatures that already answered the roll or turned it down
  strikes: z.array(z.string()).optional(), // strike options picked in place of the roll's Advantage, as Brutal Strike's
});

// Who a projectile or later attack actually goes for, given who is still standing.
function aimAt(
  id: string,
  attacker: Actor,
  state: DndState,
): Actor | undefined {
  const standing = enemies(state, attacker).filter((item) => !isDown(item));
  if (id === ALL) {
    const charmers = charmersOf(attacker);
    return standing
      .filter(
        (item) =>
          !charmers.has(item.id) && !behindTotalCover(state, attacker, item),
      )
      .sort((a, b) => a.hp - b.hp)[0];
  }
  const aimed = actorOf(state, id);
  return isDown(aimed) ? standing[0] : aimed;
}

// An automatic hit such as a Magic Missile dart: all of them land, one at a time against current HP.
const SAVAGE_ATTACKER = "savage-attacker";

export function runProjectile(
  payload: z.infer<typeof AttackSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = aimAt(payload.target, attacker, state);
  if (!target) return {};
  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const { resolution } = action.activation;
  if (resolution.kind !== "automatic") {
    throw new Error(`${action.id} isn't an automatic hit`);
  }
  const stats = deriveStats(attacker, context);
  const responses = damageResponses(target, context);
  const { events, dealt } = dealEvents(
    target,
    resolution.damage.map(({ amount, type }) => ({
      amount: finalDamage(rollAmount(amount, stats, dice), type, responses),
      type,
    })),
    false,
    context,
  );
  return {
    events,
    frames: afterDamage(
      target,
      dealt,
      {
        source: attacker.id,
        types: resolution.damage.map(({ type }) => type),
        spell: action.spellLevel !== null,
      },
      concentrationFrame(target, dealt),
      context,
    ),
  };
}

// A reaction's AC bonus against a hit: a number, or a formula of the reactor's.
function acBonusOf(bonus: number | Formula, stats: Stats): number {
  return typeof bonus === "number" ? bonus : evaluateFormula(bonus, stats);
}

// A creature of this kind beside the bearer, as the podling Transfer Harm needs.
function kinNear(
  bearer: Actor,
  near: { readonly monster: string; readonly within: number },
  context: Context,
): Actor | null {
  return (
    Object.values(context.state.actors).find(
      (item) =>
        item.id !== bearer.id &&
        !isDown(item) &&
        item.source.kind === "monster" &&
        item.source.statBlockId === near.monster &&
        distanceFeet(item.position, bearer.position) <= near.within,
    ) ?? null
  );
}

// AC that counts against melee attack rolls only, as Defensive Stance's, or ranged ones only, as an Arrow-Catching
// Shield's.
function meleeAc(target: Actor, melee: boolean, stats: Stats): number {
  const sources = new Map<string, number>();
  for (const { modifier, sourceId } of [
    ...target.activeEffects,
    // Each passive counts as a source of its own.
    ...passiveModifiers(stats.passives).map((each, at) => ({
      modifier: each,
      sourceId: `passive:${String(at)}`,
    })),
  ]) {
    if (
      modifier.kind === "bonus" &&
      modifier.to === "ac" &&
      (melee ? modifier.melee : modifier.ranged)
    ) {
      sources.set(sourceId, modifier.amount.bonus?.base ?? 0);
    }
  }
  return [...sources.values()].reduce((sum, bonus) => sum + bonus, 0);
}

// Reports whether a reaction could still change the result of this attack.
function reactionFor(
  target: Actor,
  total: number,
  ac: number,
  context: Context,
  critical: boolean,
  melee: boolean,
  spell = false,
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
      // Mythal Ward's table may turn the spell aside, so a spell attack's hit is always offered to it.
      if (activation.table) return true;
      const { resolution } = activation;
      // Jinx or Warding Charm: the attacker's save may make even a Critical Hit miss.
      if (resolution.kind === "save") {
        return resolution.onFail.some((effect) => effect.kind === "negateHit");
      }
      if (resolution.kind !== "automatic") return false;
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
          return sum + acBonusOf(effect.bonus, stats);
        }
        return effect.kind === "modifier" &&
          effect.modifier.kind === "bonus" &&
          effect.modifier.to === "ac" &&
          (!effect.modifier.melee || melee) &&
          (!effect.modifier.ranged || !melee)
          ? sum + (effect.modifier.amount.bonus?.base ?? 0)
          : sum;
      }, 0);
      return total < ac + acBonus;
    }) ?? null
  );
}

// Whether the bearer holds what a reaction needs, such as a Shield for Protection.
function holds(
  actor: Actor,
  holding: "shield" | "shieldOrWeapon" | "polearm" | undefined,
  context: Context,
): boolean {
  return (
    holding === undefined ||
    equipped(actor).some((id) => {
      const item = ItemSchema.safeParse(context.content(id)).data;
      return (
        item?.type === "shield" ||
        (holding !== "shield" && item?.type === "weapon")
      );
    })
  );
}

// An ally's reaction for a target within 5 feet: Protection before the roll, Interception after a hit. A companion
// takes it as soon as it can; the player is asked.
function guardFor(
  target: Actor,
  attacker: Actor,
  when: "allyAttacked" | "allyHit",
  context: Context,
  // A ranged attack sets off a guard that only answers those, and `draw` looks for one that takes the attack on
  // itself, as an Arrow-Catching Shield, instead of one that protects, as Protection.
  how: { readonly ranged?: boolean; readonly draw?: boolean } = {},
): { readonly guard: Actor; readonly action: KnownAction } | null {
  const { state } = context;
  for (const guard of allies(state, target)) {
    if (
      guard.id === target.id ||
      !guard.budget.reaction ||
      isDown(guard) ||
      hasCondition(guard, ...INCAPACITATING) ||
      seeing(guard, attacker.position, state, context) === "none"
    ) {
      continue;
    }
    const stats = deriveStats(guard, context);
    const action = stats.actions.find(
      (item) =>
        item.activation.trigger?.[when] &&
        (!item.activation.trigger.ranged || how.ranged === true) &&
        draws(item) === (how.draw === true) &&
        distanceFeet(guard.position, target.position) <=
          (item.activation.trigger.within ?? 5) &&
        holds(guard, item.activation.trigger.holding, context) &&
        canAfford(item, guard, stats),
    );
    if (
      action &&
      (guard.id !== PLAYER_ACTOR ||
        playerTakes(
          `${when}:${target.id}`,
          `${attacker.name} ${when === "allyHit" ? "hits" : "attacks"} ${target.name}. Use ${action.name}?`,
          action,
          context,
        ))
    ) {
      return { guard, action };
    }
  }
  return null;
}

// The bearer's own activation for this trigger that it can pay for now, as Lucky's.
function ownTrigger(
  actor: Actor,
  when: "attacked",
  context: Context,
): KnownAction | null {
  const stats = deriveStats(actor, context);
  return (
    stats.actions.find((item) => {
      const trigger = item.activation.trigger;
      return (
        trigger?.[when] &&
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

// What taking a guard's reaction costs, named so the log says which reaction it was.
function guardCosts(
  guard: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  return payCosts(action, guard, context).map((event) =>
    event.kind === `${NS}:budgetSpent`
      ? dndEvent(`${NS}:budgetSpent`, {
          actor: guard.id,
          kind: "reaction",
          label: action.name,
        })
      : event,
  );
}

// Settles the reactions to an attack roll before it lands. Monsters and companions answer by tactics; the player
// is asked, and the roll is held in the attack's payload until they answer (runRollReaction).
function rollWindow(
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
  let current = roll;
  let bonus = held.bonus;
  for (;;) {
    const found = rollResponder(current, passed, context);
    if (!found) return { events, natural: current.natural, bonus };
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

// Redirect Attack: a target that sees the attack coming trades places with a Small or Medium ally next to it, who
// becomes the target instead.
function redirect(
  attacker: Actor,
  target: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly ally: string } | null {
  const { state } = context;
  if (
    !target.budget.reaction ||
    isDown(target) ||
    hasCondition(target, ...INCAPACITATING) ||
    !target.position ||
    seeing(target, attacker.position, state, context) === "none"
  ) {
    return null;
  }
  const stats = deriveStats(target, context);
  const action = stats.actions.find(
    (item) =>
      item.activation.trigger?.attacked &&
      redirects(item) &&
      canAfford(item, target, stats),
  );
  if (!action) return null;
  const charmed =
    action.activation.resolution.kind === "automatic" &&
    action.activation.resolution.effects.some(
      (effect) => effect.kind === "redirect" && effect.charmed,
    );
  const pool = charmed
    ? Object.values(state.actors).filter((item) =>
        hasCondition(item, "charmed"),
      )
    : allies(state, target);
  const ally = pool.find((item) => {
    const size = sizeOf(item, context);
    return (
      item.id !== target.id &&
      item.id !== attacker.id &&
      !isDown(item) &&
      !hasCondition(item, ...INCAPACITATING) &&
      within5(item, target) &&
      size >= 1 &&
      size <= 2
    );
  });
  if (!ally?.position) return null;
  return {
    ally: ally.id,
    events: [
      ...guardCosts(target, action, context),
      dndEvent(`${NS}:moved`, {
        actor: target.id,
        to: ally.position,
        feet: 0,
      }),
      dndEvent(`${NS}:moved`, {
        actor: ally.id,
        to: target.position,
        feet: 0,
      }),
    ],
  };
}

const draws = (action: KnownAction): boolean => {
  const { resolution } = action.activation;
  return (
    resolution.kind === "automatic" &&
    resolution.effects.some((effect) => effect.kind === "drawAttack")
  );
};

const redirects = (action: KnownAction): boolean => {
  const { resolution } = action.activation;
  return (
    resolution.kind === "automatic" &&
    resolution.effects.some((effect) => effect.kind === "redirect")
  );
};

// How an attack came: in melee, at range, from a spell. Reactions such as Parry or Deflect Missile ask.
function attackKind(
  hit: {
    readonly attacker: string;
    readonly actionId: string;
    readonly slotLevel?: number | undefined;
  },
  context: Context,
): { melee: boolean; ranged: boolean; spell: boolean } {
  const attacker = actorOf(context.state, hit.attacker);
  const action = findAction(attacker, hit.actionId, context, hit.slotLevel);
  const melee = meleeReach(action) !== null;
  return { melee, ranged: !melee, spell: action.spellLevel !== null };
}

// What follows a miss: what the attack itself does on one, as Acid Arrow's splash, its weapon's mastery, as Graze,
// and what answers it.
export function missOutcome(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): Frame[] {
  const attacker = actorOf(context.state, hit.attacker);
  return [
    ...(deriveStats(attacker, context).passives.some(
      ({ kind }) => kind === "missRider",
    )
      ? [frame("missRider", hit)]
      : []),
    ...missFrames(hit, context),
    ...(masteryOf(attacker, hit.actionId, context)
      ? [frame("masteryMiss", hit)]
      : []),
    ...missedFrames(hit, context),
  ];
}

// What answers an attack that missed its target, as Sticky Shield does.
function missedFrames(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): Frame[] {
  return [
    ...reactFrames(
      {
        kind: "missed",
        actor: hit.target,
        source: hit.attacker,
        ...attackKind(hit, context),
        ...(attackKind(hit, context).spell ? {} : { weapon: hit.actionId }),
      },
      context,
    ),
  ];
}

// An ally's reaction to a hit on someone near it: Interception lessens the hit by what it rolls, and a shield
// guardian's Protection or Spontaneous Barrier adds to the target's AC, which may turn it into a miss.
function intercepted(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const { state, dice } = context;
  const target = actorOf(state, hit.target);
  const found = guardFor(
    target,
    actorOf(state, hit.attacker),
    "allyHit",
    context,
    { ranged: attackKind(hit, context).ranged },
  );
  if (!found) return { events: [], frames: [frame("applyHit", hit)] };
  const { guard, action } = found;
  const { resolution } = action.activation;
  const stats = deriveStats(guard, context);
  const effects = resolution.kind === "automatic" ? resolution.effects : [];
  const reduceBy = effects.reduce(
    (sum, effect) =>
      effect.kind === "reduceDamage" && effect.amount
        ? sum + rollAmount(effect.amount, stats, dice)
        : sum,
    0,
  );
  const acBonus = effects.reduce(
    (sum, effect) =>
      effect.kind === "acAgainstHit"
        ? sum + acBonusOf(effect.bonus, stats)
        : sum,
    0,
  );
  // A lasting AC bonus goes on the target, and the hit is checked again once it's there.
  const raised = effects.some(
    (effect) =>
      effect.kind === "modifier" &&
      effect.modifier.kind === "bonus" &&
      effect.modifier.to === "ac",
  );
  const lessened = {
    ...hit,
    ...(reduceBy > 0 ? { reduceBy: (hit.reduceBy ?? 0) + reduceBy } : {}),
    ...(acBonus > 0 ? { acBonus: (hit.acBonus ?? 0) + acBonus } : {}),
    ...(effects.some((effect) => effect.kind === "reduceDamage" && effect.halve)
      ? { halve: true }
      : {}),
  };
  return {
    events: [
      ...guardCosts(guard, action, context),
      ...(raised ? leafEvents(effects, action.id, guard, target, context) : []),
    ],
    frames: [
      frame(acBonus > 0 || raised ? "recheckHit" : "applyHit", lessened),
    ],
  };
}

export function runAttackRoll(
  payload: z.infer<typeof AttackSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  // A hit can end the fight with more attacks still queued, and the monsters are gone by then.
  if (!state.combat) return {};
  const attacker = actorOf(state, payload.attacker);
  if (isDead(attacker) || isDown(attacker)) return {};

  // A later attack in a multiattack moves on if its first target has already fallen, and one with a weapon that
  // got stuck, as to Sticky Shield, isn't made.
  const target = aimAt(payload.target, attacker, state);
  if (!target || isStuck(attacker, payload.actionId)) return {};

  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  // Sanctuary: an attacker that fails its Wisdom save loses the attack. One warded itself loses the ward by attacking.
  const ward = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "sanctuary",
  );
  const unwarded = attacker.activeEffects
    .filter(({ modifier }) => modifier.kind === "sanctuary")
    .map(({ sourceId }) =>
      dndEvent(`${NS}:effectEnded`, { actor: attacker.id, sourceId }),
    );
  if (ward?.modifier.kind === "sanctuary" && attacker.side !== target.side) {
    const save = rollSave(
      attacker,
      "wis",
      ward.modifier.dc ?? 10,
      context,
      true,
    );
    if (!save.saved) return { events: [...unwarded, ...save.events] };
  }
  const stats = deriveStats(attacker, context);
  const targetStats = deriveStats(target, context);
  // Among the Dead: an undead attacker saves or loses the attack, and once it saves, or the bearer attacks it, it's
  // free of this until a Long Rest.
  const deterred = (bearer: Actor, other: Actor, bearerStats: Stats) =>
    bearerStats.passives.some(
      (passive) =>
        passive.kind === "deterAttackers" &&
        (passive.creatureTypes as readonly string[]).includes(
          deriveStats(other, context).creatureType ?? "",
        ),
    ) && !bearer.resourcesSpent[`${DETERRED}${other.id}`];
  const freed = (bearer: Actor, other: Actor) =>
    dndEvent(`${NS}:resourceSpent`, {
      actor: bearer.id,
      resource: `${DETERRED}${other.id}`,
    });
  const freedOwn = deterred(attacker, target, stats)
    ? [freed(attacker, target)]
    : [];
  if (
    attacker.side !== target.side &&
    deterred(target, attacker, targetStats)
  ) {
    const save = rollSave(
      attacker,
      "wis",
      spellSaveDc(targetStats),
      context,
      true,
    );
    if (!save.saved) return { events: [...unwarded, ...save.events] };
    unwarded.push(...save.events, freed(target, attacker));
  }
  unwarded.push(...freedOwn);
  const packed =
    hasPassive(stats, "packTactics") &&
    allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id &&
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, target),
    );
  const close = within5(attacker, target);
  const steady = steadyShot(stats, action.id, resolution.attack.type);
  // A ranged attack is harder with an enemy standing next to the attacker.
  const crowded =
    meleeReach(action) === null &&
    !steady.inMelee &&
    enemies(state, attacker).some(
      (item) =>
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, attacker),
    );
  const proneFar = hasCondition(target, "prone") && !close;
  // Darkness hides a creature from anyone without Darkvision in range: attacking an unseen target has
  // Disadvantage, and a target that can't see its attacker gives Advantage.
  // From inside its swallower, the light at the creature's old square has nothing to do with it.
  const inside = swallowerOf(attacker) === target.id;
  const unseenTarget =
    !inside && seeing(attacker, target.position, state, context) === "none";
  const unseenAttacker =
    !inside && seeing(target, attacker.position, state, context) === "none";
  // A monster's flat bonus names no ability: a weapon attack is Strength-based in melee and Dexterity-based at range.
  const ability =
    resolution.attack.ability ?? (meleeReach(action) === null ? "dex" : "str");
  // Brutal Strike's options take the roll's Advantage away.
  const forgoes = (payload.strikes ?? []).length > 0;
  const advantage =
    !forgoes &&
    (packed ||
      unseenAttacker ||
      hasFlag(attacker, "advantage", "attacks", stats, ability) ||
      hasFlag(
        target,
        "advantage",
        "attacksAgainst",
        targetStats,
        undefined,
        undefined,
        attacker.id,
      ) ||
      placedFlag(attacker, "advantage", "attacks", state, context, ability) ||
      placedFlag(target, "advantage", "attacksAgainst", state, context) ||
      unseenInvisible(attacker, target, context) ||
      blindedTo(target, attacker, context) ||
      hasCondition(
        target,
        "paralyzed",
        "petrified",
        "restrained",
        "stunned",
        "unconscious",
      ) ||
      (hasCondition(target, "prone") && close) ||
      (hasPassive(stats, "grappledAdvantage") &&
        grapplesOn(target).some(({ casterId }) => casterId === attacker.id)) ||
      // Street Justice's Headlock: allies too, against a creature the bearer grapples.
      grapplesOn(target).some(({ casterId }) => {
        const grappler = state.actors[casterId];
        return (
          grappler !== undefined &&
          casterId !== attacker.id &&
          grappler.side === attacker.side &&
          deriveStats(grappler, context).passives.some(
            (passive) => passive.kind === "grappledAdvantage" && passive.allies,
          )
        );
      }) ||
      traitAttackAdvantage(stats, attacker, target, targetStats, state) ||
      mountedStrike(attacker, target, stats, context));
  const held = payload.rolled;
  // Redirect Attack: the target trades places with an ally next to it, who takes the attack instead.
  const redirected = held ? null : redirect(attacker, target, context);
  if (redirected) {
    return {
      events: redirected.events,
      frames: [frame("attackRoll", { ...payload, target: redirected.ally })],
    };
  }
  // An Arrow-Catching Shield: an ally beside the target takes a ranged attack on itself.
  const ranged = attackKind(payload, context).ranged;
  const drawn = held
    ? null
    : guardFor(target, attacker, "allyAttacked", context, {
        ranged,
        draw: true,
      });
  if (drawn) {
    return {
      events: guardCosts(drawn.guard, drawn.action, context),
      frames: [frame("attackRoll", { ...payload, target: drawn.guard.id })],
    };
  }
  // Protection: an ally's Shield gives this roll, and the others against the target, Disadvantage.
  const shielded = held
    ? null
    : guardFor(target, attacker, "allyAttacked", context, { ranged });
  const { normalRange } = resolution.attack;
  const longRange =
    normalRange !== undefined &&
    distanceFeet(attacker.position, target.position) > normalRange;
  const hampered =
    shielded !== null ||
    crowded ||
    longRange ||
    unseenTarget ||
    proneFar ||
    dodging(target) ||
    duelHampers(attacker, target) ||
    grappledAwayFrom(attacker, target) ||
    hasFlag(
      attacker,
      "disadvantage",
      "attacks",
      stats,
      ability,
      undefined,
      target.id,
    ) ||
    hasFlag(
      target,
      "disadvantage",
      "attacksAgainst",
      targetStats,
      undefined,
      stats.creatureType,
    ) ||
    placedFlag(attacker, "disadvantage", "attacks", state, context, ability) ||
    placedFlag(target, "disadvantage", "attacksAgainst", state, context) ||
    hasCondition(attacker, "frightened", "poisoned", "prone", "restrained") ||
    blindedTo(attacker, target, context) ||
    unseenInvisible(target, attacker, context) ||
    warded(target, targetStats) ||
    protectedMount(target, context) ||
    (action.spellLevel !== null &&
      passiveModifiers(targetStats.passives).some(
        (modifier) =>
          modifier.kind === "disadvantage" &&
          modifier.on === "attacksAgainst" &&
          modifier.spells,
      )) ||
    // A strong wind hampers ranged weapon attacks, and a dampened magic zone spell attacks (environment.ts).
    passiveModifiers(stats.passives).some(
      (modifier) =>
        modifier.kind === "disadvantage" &&
        modifier.on === "attacks" &&
        ((modifier.ranged === true &&
          action.spellLevel === null &&
          !isMelee(action)) ||
          (modifier.spellAttacks === true && action.spellLevel !== null)),
    );
  // Lucky: the target spends a Luck Point on its own once it's badly hurt or the attacker has Advantage.
  const luck =
    held ||
    hampered ||
    !(advantage || target.hp * 2 <= targetStats.maxHp) ||
    isDown(target)
      ? null
      : ownTrigger(target, "attacked", context);
  const disadvantage = hampered || luck !== null;
  const guarded = [
    ...(shielded
      ? [
          ...guardCosts(shielded.guard, shielded.action, context),
          ...(resolveAction(shielded.action, shielded.guard, [target], context)
            .events ?? []),
        ]
      : []),
    ...(luck
      ? [
          ...payCosts(luck, target, context),
          // Limited Foresight's Advantage is against the attacker alone, so it's aimed at it.
          ...(resolveAction(
            luck,
            target,
            ["self" in luck.activation.targeting ? target : attacker],
            context,
          ).events ?? []),
        ]
      : []),
  ];
  // An attack roll with Advantage can give it up for Brutal Strike's options, picked before it's rolled.
  const brutal =
    held || payload.strikes !== undefined || !advantage || disadvantage
      ? null
      : forgoAdvantageFrame({ ...payload, target: target.id }, context);
  if (brutal) return { frames: [brutal] };
  const edge = held ?? { advantage, disadvantage };
  const first = held
    ? { natural: held.natural }
    : rollD20(dice, {
        advantage,
        disadvantage,
        rerollOnes: hasPassive(stats, "rerollOnes"),
        thirdDie: ability !== "str" && hasPassive(stats, "elvenAccuracy"),
      });
  const hadAdvantage = edge.advantage && !edge.disadvantage;
  const hadDisadvantage = edge.disadvantage && !edge.advantage;
  const base =
    held?.base ??
    attackBonus(resolution, stats) +
      rollBonus(
        attacker,
        "attacks",
        context,
        undefined,
        undefined,
        resolution.attack.type === "weapon",
      ) +
      rollBonus(target, "attacksAgainst", context); // Blade Ward's -1d4
  const cover = coverAgainst(state, attacker, target, context);
  const ac =
    targetStats.ac +
    meleeAc(target, meleeReach(action) !== null, targetStats) +
    ((steady.bypassCover || resolution.attack.bypassCover) &&
    meleeReach(action) === null
      ? 0
      : cover);
  const critFrom = Math.min(
    criticalFrom(stats),
    ...stats.passives.flatMap((passive) =>
      passive.kind === "criticalRange" &&
      (passive.against !== undefined || passive.while !== undefined) &&
      (!passive.against || markedBy(target, attacker, passive.against)) &&
      (!passive.while ||
        (isMelee(action) && underEffect(attacker, passive.while)))
        ? [passive.from]
        : [],
    ),
  );
  const judge = (natural: number, bonus: number) => {
    const sum = natural + base + bonus;
    return {
      total: sum,
      success: natural >= critFrom || (natural !== 1 && sum >= ac),
      critical: natural >= critFrom,
    };
  };
  // Reactions to the roll before it lands, as Bountiful Luck or Second Chance (combat/reactions.ts).
  const window = rollWindow(
    { ...payload, target: target.id },
    {
      roller: attacker,
      kind: "attack",
      natural: first.natural,
      goal: ac,
      against: target,
      magical: action.spellLevel !== null,
      ...judge(first.natural, held?.bonus ?? 0),
    },
    { ...edge, base, bonus: held?.bonus ?? 0 },
    judge,
    context,
  );
  if ("frames" in window) {
    return { events: [...guarded, ...window.events], frames: window.frames };
  }
  const roll = { natural: window.natural };
  const total = judge(roll.natural, window.bonus).total;
  const struck = judge(roll.natural, window.bonus).success;
  // Boon of Combat Prowess's Peerless Aim: a miss hits instead, once until the bearer's next turn starts.
  const aimed =
    !struck &&
    hasPassive(stats, "peerlessAim") &&
    !attacker.usedThisTurn.includes(PEERLESS_AIM);
  const hits = struck || aimed;
  // A hit from within 5 feet on a Paralyzed or Unconscious target is a Critical Hit, unless the target's Adamantine
  // Armor makes it a normal one.
  const critical =
    !hasPassive(targetStats, "noCriticals") &&
    (roll.natural >= critFrom ||
      (hits &&
        isMelee(action) &&
        hasCondition(target, "paralyzed", "unconscious")));

  const report = dndEvent(`${NS}:rollReported`, {
    actor: attacker.id,
    against: target.id,
    natural: roll.natural,
    total,
    target: ac,
    success: hits,
    label: action.name,
  });
  // An effect like Guiding Bolt's lasts only until the next attack roll it applies to.
  const spent = [
    ...duelBroken(attacker, [target], state),
    ...guarded,
    ...window.events,
    ...(aimed
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: PEERLESS_AIM,
          }),
        ]
      : []),
    ...onceEnded(attacker, "attacks"),
    ...actingEnds(attacker, action),
    ...(isMelee(action) ? prisonEvents(attacker, context) : []),
    ...onceEnded(target, "attacksAgainst", attacker.id),
    // Skulker's Sniper: a miss from hiding doesn't give the attacker away.
    ...(!hits && hasPassive(stats, "quietMiss") ? [] : revealEvents(attacker)),
    ...unwarded,
    // Attacking lowers the attacker's own Diabolic Ward until its next turn.
    ...(stats.passives.some(
      (passive) =>
        passive.kind === "ward" && passive.suppressed === "attacking",
    )
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: WARD_DOWN,
          }),
        ]
      : []),
  ];
  const hiddenWith = tacticsOf(attacker, "hidden")[0]?.value;
  const hit = {
    attacker: attacker.id,
    actionId: action.id,
    target: target.id,
    critical,
    hadAdvantage,
    ...(hadDisadvantage ? { hadDisadvantage: true } : {}),
    total,
    natural: roll.natural,
    ...(payload.slotLevel === undefined
      ? {}
      : { slotLevel: payload.slotLevel }),
    ...(payload.noModifier ? { noModifier: true } : {}),
    ...(payload.poleStrike ? { poleStrike: true } : {}),
    ...(payload.strikes ? { strikes: payload.strikes } : {}),
    // The Stealth total it attacked from hiding with, for Supreme Sneak's Stealth Attack.
    ...(hiddenWith === undefined ? {} : { hidden: hiddenWith }),
  };

  if (!hits) {
    // A reroll starts the roll afresh, so what was held for a reaction goes.
    const reroll = offerInspiration(
      attacker,
      {
        attacker: payload.attacker,
        actionId: payload.actionId,
        target: target.id,
        ...(payload.slotLevel === undefined
          ? {}
          : { slotLevel: payload.slotLevel }),
        ...(payload.noModifier ? { noModifier: true } : {}),
        ...(payload.poleStrike ? { poleStrike: true } : {}),
      },
      report,
      hit,
      context,
    );
    if (reroll) {
      return {
        ...reroll,
        events: [...guarded, ...window.events, ...(reroll.events ?? [])],
      };
    }
    // Lightning Arrow takes the miss's place, so what a miss sets off waits on the answer.
    const instead = replaceHitFrame(hit, false, context);
    return {
      events: [report, ...spent, ...onceHitEnded(attacker)],
      frames: instead ? [instead] : missOutcome(hit, context),
    };
  }

  const duplicate = imageHit(attacker, target, context);
  if (duplicate) return { events: [report, ...spent, ...duplicate] };
  const reaction = reactionFor(
    target,
    total,
    ac,
    context,
    critical,
    meleeReach(action) !== null,
    action.spellLevel !== null,
  );
  if (reaction) {
    return {
      events: [report, ...spent],
      frames: [
        awaitDecision({
          id: `${NS}:reaction:${target.id}`,
          actor: target.id,
          prompt: `${attacker.name} hits ${target.name} with ${action.name}. React?`,
          options: [
            { id: reaction.id, label: reaction.name },
            { id: DECLINE, label: "Take the hit" },
          ],
          resume: frame("afterReaction", hit),
        }),
      ],
    };
  }
  const guard = intercepted(hit, context);
  return { events: [report, ...spent, ...guard.events], frames: guard.frames };
}

export const HitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  hadAdvantage: z.boolean(),
  hadDisadvantage: z.boolean().optional(), // older saves' hits have none
  total: z.number(),
  natural: z.number(),
  slotLevel: z.number().optional(),
  halve: z.boolean().optional(), // set by a reaction like Uncanny Dodge
  reduceBy: z.number().optional(), // set by a reaction like Deflect Attacks
  acBonus: z.number().optional(), // set by a reaction like Parry, against this hit only
  noModifier: z.boolean().optional(),
  poleStrike: z.boolean().optional(),
  riposte: z.string().optional(), // the attack the target makes back if this now misses, as with Riposte ("" for its weapon)
  kept: z.boolean().optional(), // a spell to take the hit's place, as Lightning Arrow, was already offered
  forgone: z.number().optional(), // Sneak Attack dice given up for strike options, as Cunning Strike's
  hidden: z.number().optional(), // the Stealth total the attacker was hidden with, for Supreme Sneak's Stealth Attack
  strikes: z.array(z.string()).optional(), // the strike options chosen for this hit, resolved after its damage
  deflect: z.string().optional(), // the reaction that sends the force back out if the damage drops to 0, as Deflect Missile
  transfer: z.string().optional(), // the creature that takes what a reaction took off, as Transfer Harm's podling
});

export const ReactionSchema = HitSchema.extend({ answer: z.string() });

export function runAfterReaction(
  payload: z.infer<typeof ReactionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const { answer, ...hit } = payload;
  if (answer === DECLINE) return intercepted(hit, context);

  const target = actorOf(state, payload.target);
  const action = findAction(target, answer, context);
  const { resolution } = action.activation;
  // Jinx or Warding Charm: the attacker saves, and on a failure the hit misses.
  if (resolution.kind === "save") {
    const attacker = actorOf(state, payload.attacker);
    const dc = evaluateFormula(resolution.dc, deriveStats(target, context));
    const save = rollSave(attacker, resolution.ability, dc, context);
    const paid = [...payCosts(action, target, context), ...save.events];
    if (save.saved) {
      const guard = intercepted(hit, context);
      return { events: [...paid, ...guard.events], frames: guard.frames };
    }
    return {
      events: [
        ...paid,
        ...leafEvents(resolution.onFail, action.id, target, attacker, context),
      ],
      frames: missedFrames(hit, context),
    };
  }
  const result = resolveAction(action, target, [target], context);
  // Mythal Ward's table: its row lands before the hit is checked again, and may turn the spell aside.
  const attacker = actorOf(state, payload.attacker);
  const attack = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const table = rollOnTable(
    action,
    target,
    attacker,
    payload.slotLevel ?? attack.spellLevel ?? 0,
    context,
  );
  if (table.negate) {
    return {
      events: [
        ...payCosts(action, target, context),
        ...(result.events ?? []),
        ...table.events,
        ...slotRefund(
          attacker,
          attack,
          payload.slotLevel ?? attack.spellLevel ?? 0,
        ),
      ],
      frames: [...table.frames, ...missedFrames(hit, context)],
    };
  }
  const strike =
    resolution.kind === "automatic"
      ? resolution.effects.find((effect) => effect.kind === "strike")
      : undefined;
  const stats = deriveStats(target, context);
  const lessened = (
    resolution.kind === "automatic" ? resolution.effects : []
  ).flatMap((effect) => (effect.kind === "reduceDamage" ? [effect] : []));
  const reduceBy = lessened.reduce(
    (sum, effect) =>
      sum +
      (effect.amount ? rollAmount(effect.amount, stats, context.dice) : 0),
    0,
  );
  const acBonus = (
    resolution.kind === "automatic" ? resolution.effects : []
  ).reduce(
    (sum, effect) =>
      effect.kind === "acAgainstHit"
        ? sum + acBonusOf(effect.bonus, stats)
        : sum,
    0,
  );
  // The rest of the attack is held here and rechecked once the reaction has taken effect.
  return {
    events: [
      ...payCosts(action, target, context),
      ...(result.events ?? []),
      ...table.events,
    ],
    frames: [
      ...(result.frames ?? []),
      ...table.frames,
      frame("recheckHit", {
        ...hit,
        ...(lessened.some((effect) => effect.halve) ? { halve: true } : {}),
        ...(reduceBy > 0 ? { reduceBy: (hit.reduceBy ?? 0) + reduceBy } : {}),
        ...(acBonus > 0 ? { acBonus: (hit.acBonus ?? 0) + acBonus } : {}),
        ...(strike?.kind === "strike" ? { riposte: strike.action ?? "" } : {}),
        ...(lessened.some((effect) => effect.deflect)
          ? { deflect: action.id }
          : {}),
        ...transferTo(lessened, target, context),
      }),
    ],
  };
}

function transferTo(
  lessened: readonly Extract<LeafEffect, { kind: "reduceDamage" }>[],
  target: Actor,
  context: Context,
): { transfer?: string } {
  const near = lessened.find((effect) => effect.toNear)?.toNear;
  const kin = near ? kinNear(target, near, context) : null;
  return kin ? { transfer: kin.id } : {};
}

export function runRecheckHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const target = actorOf(state, payload.target);
  const attacker = actorOf(state, payload.attacker);
  const targetStats = deriveStats(target, context);
  const ac =
    targetStats.ac +
    meleeAc(target, attackKind(payload, context).melee, targetStats) +
    coverAgainst(state, attacker, target, context) +
    (payload.acBonus ?? 0);
  if (!payload.critical && payload.total < ac) {
    // Riposte: on the miss, the target makes its attack back.
    const attack =
      payload.riposte === undefined
        ? undefined
        : strikeAction(target, payload.riposte || undefined, context);
    return {
      frames: [
        ...(attack
          ? [
              frame("attackRoll", {
                attacker: target.id,
                actionId: attack.id,
                target: payload.attacker,
              }),
            ]
          : []),
        ...missedFrames(payload, context),
      ],
    };
  }
  return intercepted(payload, context);
}

function deathStruck(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): { readonly doubled: boolean; readonly events: SystemEvent[] } | null {
  const passive = stats.passives.find(({ kind }) => kind === "deathStrike");
  if (
    passive?.kind !== "deathStrike" ||
    (context.state.combat?.round ?? 1) > 1
  ) {
    return null;
  }
  const save = rollSave(
    target,
    passive.ability,
    evaluateFormula(passive.dc, stats),
    context,
  );
  return { doubled: !save.saved, events: save.events };
}

// Dice less this many, as Sneak Attack's 5d6 less 1d6 for Cunning Strike's Poison.
function fewerDice(
  notation: string | undefined,
  less: number,
): string | undefined {
  const [count = "0", sides = "0"] = (notation ?? "").split("d");
  const left = Number(count) - less;
  return notation && left > 0 ? `${String(left)}d${sides}` : undefined;
}

// Pole Strike hits with the weapon's other end, whose damage die is a d4 of Bludgeoning.
function poleEnd(
  resolution: Extract<Resolution, { kind: "attack" }>,
): Extract<Resolution, { kind: "attack" }> {
  return {
    ...resolution,
    damage: resolution.damage.map((item, index) =>
      index === 0
        ? { amount: { ...item.amount, dice: "1d4" }, type: "bludgeoning" }
        : item,
    ),
  };
}

// Mounted Strike: Advantage from the saddle against an unmounted creature next to the mount and smaller than it.
function mountedStrike(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): boolean {
  const mount = hasPassive(stats, "mountedCombatant")
    ? ridden(attacker, context.state)
    : null;
  return (
    mount !== null &&
    mountOf(target) === null &&
    distanceFeet(mount.position, target.position) <= 5 &&
    sizeOf(target, context) < sizeOf(mount, context)
  );
}

// Veer: a rider with Mounted Combatant takes a hit meant for its mount.
// shortcut: taken without asking, whenever the rider has more Hit Points left than the mount.
function veered(target: Actor, context: Context): Actor | null {
  const rider = Object.values(context.state.actors).find(
    (item) => mountOf(item) === target.id,
  );
  return rider &&
    !isDown(rider) &&
    !hasCondition(rider, ...INCAPACITATING) &&
    rider.hp > target.hp &&
    hasPassive(deriveStats(rider, context), "mountedCombatant")
    ? rider
    : null;
}

export function runApplyHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const rider = veered(actorOf(context.state, payload.target), context);
  if (rider) {
    return runApplyHit({ ...payload, target: rider.id }, context);
  }
  const instead = payload.kept ? null : replaceHitFrame(payload, true, context);
  if (instead) return { frames: [instead] };
  // Cunning Strike's options are picked before the Sneak Attack dice they give up are rolled.
  const strike =
    payload.strikes === undefined ? forgoFrame(payload, context) : null;
  if (strike) return { frames: [strike] };
  return landHit(payload, context);
}

export const StrikeChosenSchema = HitSchema.extend({ answer: z.string() });

// A strike option picked for a hit: another is asked for while the hit can take more.
export function runStrikeChosen(
  { answer, ...hit }: z.infer<typeof StrikeChosenSchema>,
  context: Context,
): SystemResult {
  const chosen = hit.strikes ?? [];
  if (answer === DECLINE) return landHit({ ...hit, strikes: chosen }, context);
  const [actionId = ""] = parseOption(answer);
  const attacker = actorOf(context.state, hit.attacker);
  const action = findAction(attacker, actionId, context);
  const next = {
    ...hit,
    strikes: [...chosen, actionId],
    forgone: (hit.forgone ?? 0) + (action.activation.trigger?.forgo ?? 0),
  };
  const more = forgoFrame(next, context);
  return more ? { frames: [more] } : landHit(next, context);
}

export const AdvantageForgoneSchema = AttackSchema.extend({
  answer: z.string(),
});

// A strike option picked in place of an attack roll's Advantage, which the roll then goes without.
export function runAdvantageForgone(
  { answer, ...attack }: z.infer<typeof AdvantageForgoneSchema>,
  context: Context,
): SystemResult {
  const chosen = attack.strikes ?? [];
  if (answer === DECLINE) {
    return runAttackRoll({ ...attack, strikes: chosen }, context);
  }
  const [actionId = ""] = parseOption(answer);
  const next = { ...attack, strikes: [...chosen, actionId] };
  const more = forgoAdvantageFrame(next, context);
  if (more) return { frames: [more] };
  const rolled = runAttackRoll(next, context);
  return {
    ...rolled,
    // The roll it's picked for spends it, whether or not it hits.
    events: [
      ...next.strikes.map((id) =>
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: attack.attacker,
          key: onceKey(
            findAction(actorOf(context.state, attack.attacker), id, context),
          ),
        }),
      ),
      ...(rolled.events ?? []),
    ],
  };
}

function landHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const printed = action.activation.resolution;
  if (printed.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  // Planar Warrior: all the hit's own damage takes the type the bearer's mark on the target names.
  const retype = target.activeEffects.find(
    ({ modifier, casterId }) =>
      modifier.kind === "hitDamage" &&
      modifier.retype !== undefined &&
      casterId === attacker.id,
  )?.modifier;
  const shaped = payload.poleStrike ? poleEnd(printed) : printed;
  const resolution = againstTarget(
    retype?.kind === "hitDamage" && retype.retype
      ? {
          ...shaped,
          damage: shaped.damage.map((item) => ({
            ...item,
            type: retype.retype ?? item.type,
          })),
        }
      : shaped,
    target,
    context,
  );
  const stats = deriveStats(attacker, context);
  const multiplier = payload.critical ? 2 : 1;
  const mastered = masteredTypes(stats, action.spellLevel !== null);
  const rerolled = rerolledTypes(stats, action.spellLevel !== null);
  const responses = piercing(
    damageResponses(target, context),
    mastered,
    stats,
    action.id,
  );

  const events: SystemEvent[] = [];
  let totalDealt = 0;
  const absorbed: { amount: number; type: DamageType }[] = [];
  const firstType = resolution.damage[0]?.type;

  // Add dice-based extra damage such as Sneak Attack to the first damage roll.
  let extra = 0;
  const typedExtra: Damage[] = [];
  const edge = {
    advantage: payload.hadAdvantage,
    disadvantage: payload.hadDisadvantage === true,
    natural: payload.natural,
  };
  const sneak = { landed: false };
  stats.passives.forEach((passive, index) => {
    if (passive.kind !== "extraDamage") return;
    const key = `extra:${String(index)}`;
    if (passive.oncePerTurn && attacker.usedThisTurn.includes(key)) return;
    if (!extraFits(passive, attacker, target, action, edge, context)) return;
    if (passive.diceCount === SNEAK_DICE) sneak.landed = true;
    // Cunning Strike's options give up some of Sneak Attack's dice before they're rolled.
    const dice_ =
      passive.diceCount === SNEAK_DICE
        ? fewerDice(passive.dice, payload.forgone ?? 0)
        : passive.dice;
    const rolled =
      (dice_ ? rollDiceNotation(dice_, dice, multiplier) : 0) +
      (passive.bonus ? evaluateFormula(passive.bonus, stats) : 0);
    const type = passive.types
      ? typeAgainst(passive.types, responses)
      : passive.type;
    if (type) {
      typedExtra.push({ amount: { bonus: { base: rolled, add: [] } }, type });
    } else extra += rolled;
    if (passive.oncePerTurn) {
      events.push(
        dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key }),
      );
    }
  });

  // Savage Attacker: once a turn, a weapon's damage dice are rolled twice and the higher roll kept.
  const savage =
    resolution.attack.type === "weapon" &&
    hasPassive(stats, "savageAttacker") &&
    !attacker.usedThisTurn.includes(SAVAGE_ATTACKER);
  // Zhentarim Ruffian's Exploit Opening does the same for every Opportunity Attack.
  const exploit =
    hasPassive(stats, "opportunityDamage") && inOwnTurn(target, context);
  if (savage) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: SAVAGE_ATTACKER,
      }),
    );
  }
  // Piercer: once a turn, a low die of the first damage of its type is rolled again, and a Critical Hit with it
  // rolls one more die.
  const piercer = stats.passives.find(
    (passive) =>
      passive.kind === "damageReroll" &&
      resolution.damage.some(({ type }) => type === passive.damage),
  );
  const pierced = piercer?.kind === "damageReroll" ? piercer.damage : null;
  const pierceIndex = resolution.damage.findIndex(
    ({ type }) => type === pierced,
  );
  const pierceKey = `reroll:${String(pierced)}`;
  const rerolls =
    pierced !== null && !attacker.usedThisTurn.includes(pierceKey);
  // Boon of Bloodshed's Power from Pain: once a turn, the Proficiency Bonus more while Bloodied.
  const pain =
    hasPassive(stats, "bloodiedDamage") &&
    attacker.hp * 2 <= stats.maxHp &&
    !attacker.usedThisTurn.includes(BLOODIED_DAMAGE);
  if (pain) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: BLOODIED_DAMAGE,
      }),
    );
  }
  // The turn's use is spent only when a die is rolled again.
  const pierce = { used: false };
  // Charger's Charge Attack: once on its turn, a melee hit after moving at least 10 feet adds 1d8.
  // shortcut: any 10 feet moved this turn counts, not only a straight line toward the target, and it never pushes.
  const charging =
    hasPassive(stats, "chargeAttack") &&
    isMelee(action) &&
    attacker.moved >= 10 &&
    inOwnTurn(attacker, context) &&
    !attacker.usedThisTurn.includes(CHARGE_ATTACK);
  if (charging) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: CHARGE_ATTACK,
      }),
    );
  }
  const charge = charging ? rollDiceNotation("1d8", dice, multiplier) : 0;
  const maxed = maximized(
    attacker,
    stats,
    resolution.damage.map(({ type }) => type),
  );
  events.push(...(maxed?.events ?? []));
  const maxIndex = resolution.damage.findIndex(
    ({ type }) => type === maxed?.type,
  );
  const weaponDice = weaponDamageDice(dice, action.id, stats, context);
  resolution.damage.forEach(({ amount, type }, index) => {
    const pierces = index === pierceIndex;
    const die = /d(\d+)/.exec(amount.dice ?? "")?.[1];
    const roll = () => {
      const inner =
        index === maxIndex
          ? HIGHEST
          : masteredDice(
              weaponDice,
              type,
              mastered,
              rerolled,
              state.combat?.environment?.forceFloor,
            );
      if (!(pierces && rerolls)) {
        return rollAmount(amount, stats, inner, multiplier);
      }
      let count = 0;
      const total = rollAmount(
        { ...amount, reroll: 1 },
        stats,
        {
          below: (count) => inner.below(count),
          roll: (sides) => {
            count += 1;
            return inner.roll(sides);
          },
        },
        multiplier,
      );
      const printed = Number(/^(\d+)d/.exec(amount.dice ?? "")?.[1] ?? 0);
      if (count > printed * multiplier) pierce.used = true;
      return total;
    };
    const rolled =
      ((savage || exploit) && index === 0 ? Math.max(roll(), roll()) : roll()) +
      (pierces && payload.critical && die
        ? rollDiceNotation(`1d${die}`, dice)
        : 0) +
      (index === 0 && type === firstType
        ? extra +
          damageBonus(attacker, resolution, stats, context) +
          (pain ? stats.proficiency : 0) +
          charge
        : 0) -
      (index === 0 && payload.noModifier && resolution.attack.ability
        ? Math.max(0, modifierFor(stats, resolution.attack.ability))
        : 0);
    const final = finalDamage(Math.max(0, rolled), type, responses);
    // Damage it absorbs heals it on its own, rather than taking from the rest of the hit.
    if (final < 0) absorbed.push({ amount: final, type });
    else totalDealt += final;
  });
  if (pierce.used) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: pierceKey }),
    );
  }

  events.push(...sideRidersSpent(attacker, target, state));
  const hits = [
    ...(firstType ? [{ amount: totalDealt, type: firstType }] : []),
    ...absorbed,
    ...[
      ...typedExtra,
      ...hitRiders(attacker, target, resolution, responses, state),
    ].map(({ amount, type }) => ({
      amount: finalDamage(
        rollAmount(amount, stats, dice, multiplier),
        type,
        responses,
      ),
      type,
    })),
  ];
  // Death Strike: a first-round Sneak Attack doubles the hit's damage unless the target saves.
  const struck = sneak.landed
    ? deathStruck(attacker, target, stats, context)
    : null;
  if (struck) events.push(...struck.events);
  // Enfeebling Arrow: the bearer's weapon attacks deal half damage; Ancestral Protectors' only off its caster.
  const weakened =
    resolution.attack.type === "weapon" &&
    attacker.activeEffects.some(
      ({ modifier, casterId }) =>
        modifier.kind === "weakened" &&
        !(modifier.exceptCaster && casterId === target.id),
    );
  // Path to the Grave's curse: the next hit from its caster's side deals double.
  const exposed = target.activeEffects.some(
    ({ modifier, casterId }) =>
      modifier.kind === "exposed" &&
      state.actors[casterId]?.side === attacker.side,
  );
  const doubled =
    struck?.doubled || exposed
      ? hits.map((item) => ({
          ...item,
          amount: item.amount > 0 ? item.amount * 2 : item.amount,
        }))
      : weakened
        ? hits.map((item) => ({
            ...item,
            amount: item.amount > 0 ? halved(item.amount) : item.amount,
          }))
        : hits;
  const targetStats = deriveStats(target, context);
  const armored = doubled.map((item) => ({
    ...item,
    amount:
      item.amount < 0
        ? item.amount // absorbed
        : Math.max(
            0,
            item.amount -
              armoredReduction(target, targetStats, item.type, context),
          ),
  }));
  const lessened = lessenHits(armored, payload);
  const dealt = dealEvents(target, lessened, payload.critical, context);
  const passed = passedOn(armored, lessened, payload, attacker, target, {
    ...context,
    state: dealt.events.reduce(applyDndEvent, state),
  });
  events.push(
    ...dealt.events,
    ...passed.events,
    ...damageRiders(
      attacker,
      target,
      new Set(resolution.damage.map(({ type }) => type)),
      payload.critical,
      stats,
      context,
      false,
      action,
    ),
    ...insideDamageEvents(attacker, target, dealt.dealt),
    ...leafEvents(resolution.onHit, action.id, attacker, target, context),
    ...oncePerTurnHit(resolution, action, attacker, target, context),
    ...drained(resolution, attacker, target, dealt.dealt, stats, context),
    ...feast(attacker, target, stats, context),
    ...retaliated(attacker, target, action, context),
    ...halted(attacker, target, stats, context),
    ...shieldBash(attacker, target, action, stats, context),
    ...inspiringStrike(attacker, payload.critical, stats, context),
    ...(dealt.dealt > 0 ? reassertHonor(attacker, target, context) : []),
    ...duelDamaged(attacker, target, dealt.dealt, state),
    ...onceHitEnded(attacker),
  );
  // The save sees the target as the hit left it.
  const afterHit = events.reduce(applyDndEvent, state);
  const nested = nestedSave(resolution, action, attacker, target, {
    ...context,
    state: afterHit,
  });
  events.push(...nested.events);
  // A Poisoner's dose on the weapon: the save it brings, once, on a hit that deals damage.
  const coating =
    dealt.dealt > 0 && action.id.startsWith("weapon:")
      ? attacker.activeEffects.find(
          ({ modifier }) => modifier.kind === "coating",
        )
      : undefined;
  const coated =
    coating?.modifier.kind === "coating"
      ? nestedSave(
          {
            ...resolution,
            onHitSave: {
              ability: coating.modifier.ability,
              dc: coating.modifier.dc,
              damage: coating.modifier.damage,
              onSuccessDamage: "none",
              onFail: coating.modifier.condition
                ? [
                    {
                      kind: "applyCondition",
                      condition: coating.modifier.condition,
                      duration: { until: "yourNextTurnEnd" },
                      repeatSave: false,
                      endsOnDamage: false,
                    },
                  ]
                : [],
              onSuccess: [],
            },
          },
          { ...action, id: coating.sourceId },
          attacker,
          target,
          { ...context, state: nested.events.reduce(applyDndEvent, afterHit) },
        )
      : null;
  if (coating && coated) {
    events.push(
      ...coated.events,
      dndEvent(`${NS}:effectEnded`, {
        actor: attacker.id,
        sourceId: coating.sourceId,
      }),
    );
  }
  // What answers the hit: the damage, the hit itself, and a foe striking someone else, as with Sentinel's Guardian.
  const landed = {
    ...context,
    state: [...nested.events, ...(coated?.events ?? [])].reduce(
      applyDndEvent,
      afterHit,
    ),
  };
  const how = attackKind(payload, context);
  const cause = {
    source: attacker.id,
    types: armored.flatMap((item) => (item.amount > 0 ? [item.type] : [])),
    ...how,
  };
  // Hew: a Critical Hit or a drop with a melee weapon readies a Bonus Action attack with it.
  const hew =
    hasPassive(stats, "hew") &&
    action.id.startsWith("weapon:") &&
    isMelee(action) &&
    (payload.critical || dealt.dealt + nested.dealt >= target.hp)
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: `${HEW_READY}${action.id}`,
          }),
        ]
      : [];
  return {
    // Stealth Attack: hidden again until the turn ends, unless it ends out of cover (combat/turn.ts).
    events: [...events, ...hew, ...stayHidden(payload, attacker, context)],
    frames: [
      ...concentrationFrame(
        target,
        dealt.dealt + nested.dealt,
        hasPassive(stats, "concentrationBreaker"),
      ),
      // The attacker's own choices for its hit come before the target's answers: the strike options picked, then
      // what it can add now.
      ...(payload.strikes ?? []).map((id, index, all) =>
        frame("smite", {
          attacker: attacker.id,
          actionId: action.id,
          target: target.id,
          critical: payload.critical,
          answer: encodeOption(id, target.id),
          ...(sharedOnce(attacker, id, all.slice(0, index), context)
            ? { noDamage: true }
            : {}),
        }),
      ),
      ...(smitesFor(action, attacker, target, stats, context).length > 0
        ? [
            frame("afterHit", {
              attacker: attacker.id,
              actionId: action.id,
              target: target.id,
              critical: payload.critical,
              total: payload.total,
            }),
          ]
        : []),
      ...(masteryOf(attacker, action.id, context)
        ? [frame("masteryHit", { ...payload, dealt: dealt.dealt })]
        : []),
      ...passed.frames,
      ...afterDamage(target, dealt.dealt + nested.dealt, cause, [], landed),
      ...reactFrames({ kind: "struck", actor: target.id, ...cause }, landed),
      ...reactFrames(
        {
          kind: "hitOther",
          actor: target.id,
          ...cause,
          dealt: dealt.dealt + nested.dealt,
        },
        landed,
      ),
      CHECK_END,
    ],
  };
}

// Mirror Image: a d6 for each duplicate left, and on a 3 or higher the hit lands on one of them, which is gone.
// An attacker that is Blinded, or sees by Blindsight or Truesight, isn't fooled.
function imageHit(
  attacker: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] | null {
  const images = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "images",
  );
  if (images?.modifier.kind !== "images") return null;
  const senses =
    attacker.source.kind === "monster"
      ? (lookup(context, MonsterSchema, attacker.source.statBlockId).text ?? "")
      : "";
  const fooled =
    !hasCondition(attacker, "blinded") &&
    !/\b(?:blindsight|truesight) \d+ ft/i.test(senses) &&
    !attacker.activeEffects.some(
      ({ modifier }) => modifier.kind === "darkvision" && modifier.truesight,
    );
  const { count } = images.modifier;
  const rolls = Array.from({ length: count }, () => context.dice.roll(6));
  if (!fooled || rolls.every((roll) => roll < 3)) return null;
  return [
    dndEvent(`${NS}:effectEnded`, {
      actor: target.id,
      sourceId: images.sourceId,
    }),
    ...(count > 1
      ? [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              ...images,
              modifier: { kind: "images", count: count - 1 },
            },
          }),
        ]
      : []),
  ];
}

// A curse any of its caster's side spends by hitting, as Path to the Grave's, ends once a hit uses it.
function sideRidersSpent(attacker: Actor, target: Actor, state: DndState) {
  return target.activeEffects.flatMap(({ modifier, sourceId, casterId }) =>
    (modifier.kind === "exposed" &&
      state.actors[casterId]?.side === attacker.side) ||
    (modifier.kind === "hitDamage" &&
      ((modifier.dealtBy === "side" &&
        state.actors[casterId]?.side === attacker.side) ||
        // Feinting Attack's die, on the creature feinted, goes with the caster's hit.
        (modifier.dealtBy === "caster" &&
          modifier.once === true &&
          casterId === attacker.id)))
      ? [
          dndEvent(`${NS}:effectEnded`, {
            actor: target.id,
            sourceId,
            casterId,
          }),
        ]
      : [],
  );
}

// Damage added to the bearer's next attack only, as Deadly Aim's, is spent by that attack, hit or miss, as is
// True Strike's change to it.
function onceHitEnded(attacker: Actor): SystemEvent[] {
  return attacker.activeEffects.flatMap(({ modifier, sourceId }) =>
    ((modifier.kind === "hitDamage" && modifier.dealtBy === "bearer") ||
      modifier.kind === "weaponSpell") &&
    modifier.once
      ? [dndEvent(`${NS}:effectEnded`, { actor: attacker.id, sourceId })]
      : [],
  );
}

// A melee hit from within 5 feet on a creature that strikes back, as Fire Shield's or Flames of Phlegethos' flames, a black
// pudding's acid or a mimic's glue, rolled with the bearer's numbers.
function retaliated(
  attacker: Actor,
  target: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  if (!isMelee(action) || !within5(attacker, target)) return [];
  const stats = deriveStats(target, context);
  const backs = [
    ...target.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
  ].flatMap((modifier) => (modifier.kind === "retaliate" ? [modifier] : []));
  if (backs.length === 0 || isDown(attacker)) return [];
  const responses = damageResponses(attacker, context);
  const hits = backs.flatMap(({ damage }) =>
    damage.map(({ amount, type }) => ({
      amount: finalDamage(
        rollAmount(amount, stats, context.dice),
        type,
        responses,
      ),
      type,
    })),
  );
  const events = dealEvents(attacker, hits, false, context).events;
  if (
    backs.some(({ grapple }) => grapple) &&
    !hasCondition(attacker, "grappled") &&
    !immuneToCondition(deriveStats(attacker, context), "grappled")
  ) {
    events.push(
      dndEvent(`${NS}:effectAdded`, {
        actor: attacker.id,
        effect: {
          sourceId: `${target.id}:adhesive`,
          casterId: target.id,
          modifier: { kind: "condition", condition: "grappled" },
          ends: "spellDuration",
        },
      }),
    );
  }
  return events;
}

const PEERLESS_AIM = "peerless-aim";
const CHARGE_ATTACK = "charge-attack";
const FEAST = "sanguine-feast";

function hasUse(actor: Actor, stats: Stats, resource: string): boolean {
  return (
    (actor.resourcesSpent[resource] ?? 0) < (stats.resources[resource] ?? 0)
  );
}

// A Dhampir's Vampiric Bite on a creature that isn't a Construct or an Undead: Drain heals the biter by the damage
// dealt, and Strengthen adds it to the biter's next attack roll or ability check within a minute.
// shortcut: Drain is taken while the biter is missing that many Hit Points, else Strengthen, without asking.
function drained(
  resolution: Extract<Resolution, { kind: "attack" }>,
  attacker: Actor,
  target: Actor,
  dealt: number,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const { drain } = resolution;
  if (
    !drain ||
    dealt <= 0 ||
    !hasUse(attacker, stats, drain.resource) ||
    exemptFrom(["construct", "undead"], target, deriveStats(target, context))
  )
    return [];
  const missing = stats.maxHp - Math.max(attacker.hp, 0);
  const strengthen = (to: "attacks" | "checks") =>
    dndEvent(`${NS}:effectAdded`, {
      actor: attacker.id,
      effect: {
        sourceId: `${drain.resource}:strengthen`,
        casterId: attacker.id,
        modifier: {
          kind: "bonus",
          to,
          amount: { bonus: { base: dealt, add: [] } },
          once: true,
        },
        ends: "spellDuration",
        ...lastsFor({ minutes: 1 }, attacker, attacker, context.state),
      },
    });
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: attacker.id,
      resource: drain.resource,
    }),
    ...(missing >= dealt
      ? [
          dndEvent(`${NS}:healed`, {
            actor: attacker.id,
            amount: Math.min(dealt, missing),
            max: stats.maxHp,
          }),
        ]
      : [strengthen("attacks"), strengthen("checks")]),
  ];
}

// Bloodlust's Sanguine Feast: once a turn, a hit on a Bloodied creature, not a Construct or Undead, heals by a Hit
// Point Die.
// shortcut: it's spent whenever it can be, rather than when the bearer is hurt enough to want it.
function feast(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const passive = stats.passives.find(({ kind }) => kind === "bloodiedFeast");
  const targetStats = deriveStats(target, context);
  if (
    passive?.kind !== "bloodiedFeast" ||
    attacker.usedThisTurn.includes(FEAST) ||
    !hasUse(attacker, stats, passive.resource) ||
    target.hp * 2 > targetStats.maxHp ||
    ["construct", "undead"].includes(targetStats.creatureType ?? "") ||
    attacker.hp >= stats.maxHp
  ) {
    return [];
  }
  return [
    dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: FEAST }),
    dndEvent(`${NS}:resourceSpent`, {
      actor: attacker.id,
      resource: passive.resource,
    }),
    ...leafEvents(
      [
        {
          kind: "hitDieHeal",
          bonus: { base: 0, add: [{ kind: "abilityMod", ability: "con" }] },
        },
      ],
      FEAST,
      attacker,
      attacker,
      context,
    ),
  ];
}

const BLOODIED_DAMAGE = "bloodied-damage";
const SHIELD_BASH = "shield-bash";

// Shield Master's Shield Bash: once on the bearer's turn, a melee weapon hit on a creature within 5 feet makes it save
// with Strength against 8 + Strength modifier + Proficiency Bonus, or be knocked Prone.
// shortcut: it always knocks Prone rather than pushing 5 feet, since Prone helps the party more.
function shieldBash(
  attacker: Actor,
  target: Actor,
  action: KnownAction,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  if (
    !hasPassive(stats, "shieldBash") ||
    attacker.usedThisTurn.includes(SHIELD_BASH) ||
    !inOwnTurn(attacker, context) ||
    !isMelee(action) ||
    !within5(attacker, target) ||
    isDown(target) ||
    !holdsShield(attacker, context)
  ) {
    return [];
  }
  const dc = 8 + modifierFor(stats, "str") + stats.proficiency;
  const save = rollSave(target, "str", dc, context, false, 0, ["prone"]);
  return [
    dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: SHIELD_BASH }),
    ...save.events,
    ...(save.saved
      ? []
      : [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: SHIELD_BASH,
              casterId: attacker.id,
              modifier: { kind: "condition", condition: "prone" },
              ends: "spellDuration",
            },
          }),
        ]),
  ];
}

// Whether it's the creature's own turn, so a hit on it is a reaction such as an Opportunity Attack.
// Tavern Brawler's push: effects on a hit once a turn, on the attacker's own turn.
function oncePerTurnHit(
  resolution: Extract<Resolution, { kind: "attack" }>,
  action: KnownAction,
  attacker: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  const effects = resolution.onHitOncePerTurn;
  const key = `onhit-effects:${action.id}`;
  if (
    !effects ||
    attacker.usedThisTurn.includes(key) ||
    !inOwnTurn(attacker, context)
  ) {
    return [];
  }
  return [
    dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key }),
    ...leafEvents(effects, action.id, attacker, target, context),
  ];
}

function inOwnTurn(target: Actor, context: Context): boolean {
  const { combat } = context.state;
  return combat?.order[combat.index] === target.id;
}

// Lords' Alliance Agent: once a turn, a Critical Hit gives the nearest ally within 30 feet without Heroic
// Inspiration that Inspiration.
function inspiringStrike(
  attacker: Actor,
  critical: boolean,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const key = "inspiring-strike";
  if (
    !critical ||
    !hasPassive(stats, "critInspiration") ||
    attacker.usedThisTurn.includes(key)
  ) {
    return [];
  }
  const ally = allies(context.state, attacker)
    .filter(
      (item) =>
        item.id !== attacker.id &&
        !isDead(item) &&
        !item.heroicInspiration &&
        distanceFeet(attacker.position, item.position) <= 30 &&
        // who can see or hear the bearer
        (seeing(item, attacker.position, context.state, context) !== "none" ||
          !hasCondition(item, "deafened")),
    )
    .sort(
      (a, b) =>
        distanceFeet(attacker.position, a.position) -
        distanceFeet(attacker.position, b.position),
    )[0];
  return ally
    ? [
        dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key }),
        dndEvent(`${NS}:inspirationGranted`, { actor: ally.id }),
      ]
    : [];
}

// Lords' Alliance Agent's Reassert Honor: an enemy that damages an ally beside the bearer is easier to hit.
function reassertHonor(
  attacker: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  const { state } = context;
  return allies(state, target).flatMap((bearer) =>
    bearer.id !== target.id &&
    bearer.side !== attacker.side &&
    !isDown(bearer) &&
    within5(bearer, target) &&
    seeing(bearer, attacker.position, state, context) !== "none" &&
    hasPassive(deriveStats(bearer, context), "avengeAlly")
      ? leafEvents(
          [
            {
              kind: "modifier",
              duration: { until: "yourNextTurnEnd" },
              modifier: {
                kind: "advantage",
                on: "attacksAgainst",
                once: true,
                casterOnly: true,
              },
            },
          ],
          "reassert-honor",
          bearer,
          attacker,
          context,
        )
      : [],
  );
}

// Sentinel's Halt: a Sentinel's hit on a creature in that creature's own turn is a reaction, so an Opportunity
// Attack, and takes its Speed to 0 for the turn.
function halted(
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  if (!hasPassive(stats, "sentinel") || !inOwnTurn(target, context)) return [];
  return leafEvents(
    [
      {
        kind: "modifier",
        duration: { until: "yourNextTurnStart" },
        modifier: {
          kind: "bonus",
          to: "speed",
          amount: { bonus: { base: 1000, add: [] } },
          subtract: true,
        },
      },
    ],
    "sentinel",
    attacker,
    target,
    context,
  );
}

// Damage a reaction took off a hit and passed on: Transfer Harm's other half to the podling, or Deflect Missile's
// force at a foe once the hit is brought to 0.
function passedOn(
  hits: readonly { readonly amount: number; readonly type: Damage["type"] }[],
  lessened: readonly {
    readonly amount: number;
    readonly type: Damage["type"];
  }[],
  payload: z.infer<typeof HitSchema>,
  attacker: Actor,
  target: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const { state } = context;
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  const kin = payload.transfer ? state.actors[payload.transfer] : undefined;
  if (kin) {
    const taken = hits.map((item, index) => ({
      type: item.type,
      amount:
        Math.max(0, item.amount) - Math.max(0, lessened[index]?.amount ?? 0),
    }));
    const dealt = dealEvents(kin, taken, false, context);
    events.push(...dealt.events);
    frames.push(...concentrationFrame(kin, dealt.dealt));
  }
  const landed = hits.some((item) => item.amount > 0);
  if (payload.deflect && landed && lessened.every((item) => item.amount <= 0)) {
    const action = findAction(target, payload.deflect, context);
    const { resolution } = action.activation;
    const deflect = (resolution.kind === "automatic" ? resolution.effects : [])
      .flatMap((effect) => (effect.kind === "reduceDamage" ? [effect] : []))
      .find((effect) => effect.deflect)?.deflect;
    // At the attacker when it's in range, else the nearest foe that is.
    const victim = deflect
      ? [attacker, ...enemies(state, target)].find(
          (item) =>
            item.side !== target.side &&
            !isDown(item) &&
            distanceFeet(item.position, target.position) <= deflect.range &&
            seeing(target, item.position, state, context) !== "none",
        )
      : undefined;
    if (deflect && victim) {
      const save = rollSave(victim, deflect.ability, deflect.dc, context);
      events.push(...save.events);
      if (!save.saved) {
        const stats = deriveStats(target, context);
        const responses = damageResponses(victim, context);
        const dealt = dealEvents(
          victim,
          deflect.damage.map(({ amount, type }) => ({
            amount: finalDamage(
              rollAmount(amount, stats, context.dice),
              type,
              responses,
            ),
            type,
          })),
          false,
          context,
        );
        events.push(...dealt.events);
        frames.push(...concentrationFrame(victim, dealt.dealt));
      }
    }
  }
  return { events, frames };
}

// Crusher's and Slasher's effects on a creature hit by an attack dealing their damage type.
// shortcut: a reaction lessens the damage after Resistance rather than before it, which only matters to rounding.
function lessenHits<T extends { readonly amount: number }>(
  hits: readonly T[],
  { halve, reduceBy = 0 }: z.infer<typeof HitSchema>,
): T[] {
  let left = reduceBy;
  return hits.map((item) => {
    if (item.amount < 0) return item; // absorbed: it heals, and nothing lessens that
    const amount = halve ? halved(item.amount) : item.amount;
    const after = Math.max(0, amount - left);
    left -= amount - after;
    return { ...item, amount: after };
  });
}

// Extra damage riders: Divine Favor sits on the attacker, while Hex and Hunter's Mark sit on the target.
function hitRiders(
  attacker: Actor,
  target: Actor,
  resolution: Extract<Resolution, { kind: "attack" }>,
  responses: ReturnType<typeof damageResponses>,
  state: DndState,
): readonly Damage[] {
  const seen = new Set<string>();
  const sided = (casterId: string) =>
    state.actors[casterId]?.side === attacker.side;
  const carried = [
    ...attacker.activeEffects.map((effect) => ({ effect, by: "bearer" })),
    ...target.activeEffects.map((effect) => ({ effect, by: "caster" })),
  ];
  return carried.flatMap(({ effect, by }) => {
    const { modifier, sourceId, casterId } = effect;
    if (
      modifier.kind !== "hitDamage" ||
      (modifier.dealtBy === "side"
        ? by !== "caster" || !sided(casterId)
        : modifier.dealtBy !== by ||
          (by === "caster" && casterId !== attacker.id)) ||
      (modifier.weaponOnly && resolution.attack.type !== "weapon") ||
      (modifier.within !== undefined &&
        distanceFeet(attacker.position, target.position) > modifier.within) ||
      seen.has(sourceId)
    ) {
      return [];
    }
    seen.add(sourceId);
    const type = modifier.types
      ? typeAgainst(modifier.types, responses)
      : modifier.damage.type;
    return [{ ...modifier.damage, type }];
  });
}

// The save a hit brings, as a ghoul's claw. Its effects have a source of their own, so a successful repeat save
// against them leaves a grapple from the same hit.
function nestedSave(
  resolution: Extract<Resolution, { kind: "attack" }>,
  action: KnownAction,
  attacker: Actor,
  hit: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly dealt: number } {
  const printed = resolution.onHitSave;
  const target = context.state.actors[hit.id];
  if (!printed || !target || isDead(target)) return { events: [], dealt: 0 };
  if (exemptFrom(printed.exempt, target, deriveStats(target, context))) {
    return { events: [], dealt: 0 };
  }
  const onceKey = `onhit:${printed.onceKey ?? action.id}`;
  const once = printed.oncePerTurn
    ? attacker.usedThisTurn.includes(onceKey) || !inOwnTurn(attacker, context)
      ? null
      : dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key: onceKey })
    : undefined;
  if (once === null) return { events: [], dealt: 0 };
  const save = {
    ...printed,
    ability:
      printed.orDex &&
      saveBonus(deriveStats(target, context), "dex") >
        saveBonus(deriveStats(target, context), printed.ability)
        ? ("dex" as const)
        : printed.ability,
  };
  const stats = deriveStats(attacker, context);
  const dc = evaluateFormula(save.dc, stats);
  const rolled = rollSave(
    target,
    save.ability,
    dc,
    context,
    false,
    0,
    conditionsApplied(save.onFail),
  );
  const rescued = rolled.saved
    ? []
    : rescuedSave(
        target,
        save.ability,
        conditionsApplied(save.onFail),
        deriveStats(target, context),
        rolled.events,
        [],
        context.dice,
        action.spellLevel !== null,
        {
          source: saveSourceOf(attacker, action.id, action.name, context),
          access: context,
        },
      );
  const succeeded = rolled.saved || rescued.length > 0;
  const responses = damageResponses(target, context);
  const damage = dealEvents(
    target,
    save.damage.flatMap(({ amount, type }) => {
      const total = rollAmount(amount, stats, context.dice);
      const scaled =
        save.onSuccessDamage === "half" && evades(target, save.ability, context)
          ? succeeded
            ? 0
            : halved(total)
          : !succeeded || save.onSuccessDamage === "full"
            ? total
            : save.onSuccessDamage === "half"
              ? halved(total)
              : 0;
      return scaled > 0
        ? [{ amount: finalDamage(scaled, type, responses), type }]
        : [];
    }),
    false,
    context,
  );
  const source = `${action.id}:save`;
  return {
    events: [
      ...(once ? [once] : []),
      ...rolled.events,
      ...rescued,
      ...damage.events,
      ...leafEvents(
        succeeded ? save.onSuccess : save.onFail,
        source,
        attacker,
        target,
        context,
        { ability: save.ability, dc },
      ),
    ],
    dealt: damage.dealt,
  };
}

// Flat damage added to a weapon's own roll, such as Rage.
function damageBonus(
  attacker: Actor,
  resolution: Extract<Resolution, { kind: "attack" }>,
  stats: Stats,
  context: Context,
): number {
  if (resolution.attack.type !== "weapon") return 0;
  const seen = new Set<string>();
  return [
    ...attacker.activeEffects.flatMap(({ modifier, sourceId }) => {
      if (seen.has(sourceId)) return [];
      if (modifier.kind === "damageBonus") seen.add(sourceId);
      return [modifier];
    }),
    ...passiveModifiers(stats.passives),
  ].reduce(
    (total, modifier) =>
      modifier.kind === "damageBonus" &&
      (!modifier.ability || modifier.ability === resolution.attack.ability)
        ? total +
          (modifier.subtract ? -1 : 1) *
            rollAmount(modifier.amount, stats, context.dice)
        : total,
    0,
  );
}

function smitesFor(
  hitWith: KnownAction,
  attacker: Actor,
  target: Actor,
  stats: Stats,
  context: Context,
  following?: string,
): readonly KnownAction[] {
  if (hitWith.activation.resolution.kind !== "attack") return [];
  return stats.actions.filter((action) => {
    const { trigger } = action.activation;
    return (
      trigger?.afterHit !== undefined &&
      (following === undefined
        ? trigger.following === undefined
        : trigger.following?.includes(following) === true) &&
      !trigger.replacesHit && // offered before the hit lands instead (combat/ranged-smite.ts)
      trigger.forgo === undefined && // picked before the damage (combat/strikes.ts)
      !trigger.forgoAdvantage && // picked before the roll
      canAfford(action, attacker, stats) &&
      hitFits(trigger.afterHit, hitWith, attacker, context) &&
      (!trigger.withFeature ||
        hitWith.id.startsWith(`feature:${trigger.withFeature}:`)) &&
      (!trigger.sneakAttack || sneakLanded(attacker, stats)) &&
      (!trigger.marked || markedBy(target, attacker, trigger.marked)) &&
      (!trigger.ownTurn || inOwnTurn(attacker, context)) &&
      (trigger.charge === undefined ||
        charged(attacker, target, trigger.charge)) &&
      (!action.activation.withShield || holdsShield(attacker, context)) &&
      (!trigger.dealing ||
        hitWith.activation.resolution.damage.some(
          (item) =>
            item.type === trigger.dealing ||
            (item.types ?? []).includes(trigger.dealing ?? item.type),
        ))
    );
  });
}

// Charge Attack: the last walk this turn was at least `feet` in a straight line toward the target.
function charged(attacker: Actor, target: Actor, feet: number): boolean {
  const last = attacker.usedThisTurn.findLast((key) =>
    key.startsWith(CHARGE_FROM),
  );
  if (!last || !attacker.position || !target.position) return false;
  const [x = NaN, y = NaN] = last
    .slice(CHARGE_FROM.length)
    .split(",")
    .map(Number);
  const from = { x, y };
  const walked = distanceFeet(from, attacker.position);
  return (
    walked >= feet &&
    distanceFeet(from, target.position) >=
      walked + distanceFeet(attacker.position, target.position) - 5
  );
}

// Whether the attacker's Sneak Attack has been dealt this turn, as it is once a hit carries it.
function sneakLanded(attacker: Actor, stats: Stats): boolean {
  return stats.passives.some(
    (passive, index) =>
      passive.kind === "extraDamage" &&
      passive.diceCount === SNEAK_DICE &&
      attacker.usedThisTurn.includes(`extra:${String(index)}`),
  );
}

// The creatures an `afterHit` option with `near` can go for instead of the one hit: of its side, within `near` of
// that one and within its own range, and with `sameRoll` only those the attack roll's total also hits.
function nearHit(
  action: KnownAction,
  attacker: Actor,
  hit: Actor,
  total: number | undefined,
  context: Context,
): readonly Actor[] {
  const { trigger, targeting } = action.activation;
  if (trigger?.near === undefined || !("creatures" in targeting)) return [];
  const { state } = context;
  const near = trigger.near;
  return Object.values(state.actors).filter(
    (item) =>
      item.id !== hit.id &&
      item.position !== null &&
      !isDown(item) &&
      (item.side === attacker.side) === (targeting.side === "ally") &&
      distanceFeet(item.position, hit.position) <= near &&
      reaches(action, attacker, item) &&
      (!trigger.sameRoll ||
        (total !== undefined && total >= deriveStats(item, context).ac)),
  );
}

// What the attacker's own features put on a creature its attack roll missed, as Studied Attacks.
export function runMissRider(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const attacker = actorOf(context.state, hit.attacker);
  const target = context.state.actors[hit.target];
  if (!target || isDown(attacker)) return {};
  return {
    events: deriveStats(attacker, context).passives.flatMap((passive, index) =>
      passive.kind === "missRider"
        ? leafEvents(
            passive.effects,
            `miss:${hit.attacker}:${String(index)}`,
            attacker,
            target,
            context,
          )
        : [],
    ),
  };
}

export const AfterHitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  total: z.number().optional(), // the attack roll, for an option that must also hit another (`sameRoll`)
  // A second strike option of one name on a hit adds its effects but not its damage, as Brutal Strike's die.
  noDamage: z.boolean().optional(),
  // The feature whose option just landed, so only the options that follow it are offered (`trigger.following`).
  following: z.string().optional(),
});

export function runAfterHit(
  payload: z.infer<typeof AfterHitSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const stats = deriveStats(attacker, context);
  const hitWith = findAction(attacker, payload.actionId, context);
  // One limited to a size or type, as Hill's Tumble to Large or smaller, is offered only for a target that fits.
  const options = smitesFor(
    hitWith,
    attacker,
    target,
    stats,
    context,
    payload.following,
  ).flatMap((action) =>
    action.activation.trigger?.near === undefined
      ? fitsType(target, action.activation.targeting, context, attacker)
        ? withUpcasts(action, attacker, stats, target.id, action.name)
        : []
      : nearHit(action, attacker, target, payload.total, context).flatMap(
          (item) =>
            withUpcasts(
              action,
              attacker,
              stats,
              item.id,
              `${action.name}: ${item.name}`,
            ),
        ),
  );
  if (isDown(target) || isDown(attacker) || options.length === 0) return {};
  return {
    frames: [
      awaitDecision({
        id: `${NS}:afterHit:${attacker.id}`,
        actor: attacker.id,
        prompt: `${attacker.name} hits ${target.name}. Add something to the hit?`,
        options: [...options, { id: DECLINE, label: "Not this time" }],
        resume: frame("smite", payload),
      }),
    ],
  };
}

export const SmiteSchema = AfterHitSchema.extend({ answer: z.string() });

export function runSmite(
  payload: z.infer<typeof SmiteSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === DECLINE) return {};
  const { state } = context;
  const attacker = actorOf(state, payload.attacker);
  const [actionId = "", aimed = "", slot] = parseOption(payload.answer);
  const known = findAction(attacker, actionId, context);
  // One aimed at another creature near the one hit goes for that one, and one on the bearer itself for the bearer.
  const target =
    "self" in known.activation.targeting
      ? attacker
      : actorOf(
          state,
          known.activation.trigger?.near === undefined ? payload.target : aimed,
        );
  const slotLevel =
    slot === undefined
      ? (slotToSpend(known, attacker, deriveStats(attacker, context)) ??
        undefined)
      : Number(slot);
  const found = asHit(
    findAction(attacker, actionId, context, slotLevel),
    findAction(attacker, payload.actionId, context),
  );
  const action = payload.noDamage
    ? {
        ...found,
        activation: {
          ...found.activation,
          resolution: { ...found.activation.resolution, damage: [] },
        },
      }
    : found;
  // A smite's damage is part of the attack, so a Critical Hit doubles its dice too, but not an area's round the target.
  const result = resolveAction(
    action,
    attacker,
    [
      ...aroundHit(action, attacker, target, context),
      ...alsoStruck(known, attacker, target, payload.target, context),
    ],
    context,
    slotLevel,
    payload.critical && !("area" in action.activation.targeting),
    target.position ?? undefined,
  );
  const own = action.activation.selfEffects ?? [];
  // Options that follow this one on the same hit, as Stalker's Flurry's after Dreadful Strike, or Elemental Smite's
  // after the Divine Smite spell.
  const featureId =
    /^feature:(.+):\d+$/.exec(known.id)?.[1] ??
    (known.id.startsWith("spell:")
      ? known.id.slice("spell:".length).replace(/:free$/, "")
      : undefined);
  const follows =
    featureId !== undefined &&
    known.activation.trigger?.following === undefined &&
    deriveStats(attacker, context).actions.some(
      ({ activation }) =>
        activation.trigger?.following?.includes(featureId) === true,
    );
  return {
    events: [
      ...payCosts(action, attacker, context, slotLevel),
      ...(result.events ?? []),
      ...leafEvents(own, action.id, attacker, attacker, context),
      // A move as part of the option, as Mobile Flourish's after the push.
      ...own.flatMap((effect) =>
        effect.kind === "reactionMove"
          ? reactionMove(attacker, context, effect, target)
          : [],
      ),
    ],
    frames: [
      ...(result.frames ?? []),
      ...(follows
        ? [
            frame("afterHit", {
              attacker: attacker.id,
              actionId: payload.actionId,
              target: payload.target,
              critical: payload.critical,
              ...(payload.total === undefined ? {} : { total: payload.total }),
              following: featureId,
            }),
          ]
        : []),
    ],
  };
}

// Whether a strike option shares its once-a-turn name with one picked before it for the same hit, so the hit's
// extra die isn't rolled twice, as Improved Brutal Strike's two effects.
function sharedOnce(
  attacker: Actor,
  id: string,
  before: readonly string[],
  context: Context,
): boolean {
  const key = (actionId: string) =>
    findAction(attacker, actionId, context).activation.oncePerTurn;
  const own = key(id);
  return typeof own === "string" && before.some((other) => key(other) === own);
}

// A strike option with `keepsHidden` picked by an attacker that struck from hiding hides it again.
function stayHidden(
  hit: {
    readonly strikes?: readonly string[] | undefined;
    readonly hidden?: number | undefined;
  },
  attacker: Actor,
  context: Context,
): SystemEvent[] {
  const { hidden } = hit;
  const keeps =
    hidden !== undefined &&
    (hit.strikes ?? []).some(
      (id) => findAction(attacker, id, context).activation.keepsHidden,
    );
  const hide = (modifier: Actor["activeEffects"][number]["modifier"]) =>
    dndEvent(`${NS}:effectAdded`, {
      actor: attacker.id,
      effect: {
        sourceId: HIDE_SOURCE,
        casterId: attacker.id,
        modifier,
        ends: "spellDuration",
      },
    });
  return keeps
    ? [
        hide({ kind: "condition", condition: "invisible" }),
        hide({ kind: "tactic", tactic: "hidden", value: hidden }),
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: attacker.id,
          key: STEALTH_ATTACK,
        }),
      ]
    : [];
}

// Another creature an afterHit activation lands on through an `alsoStrikes` passive.
function alsoStruck(
  known: KnownAction,
  attacker: Actor,
  target: Actor,
  hitId: string,
  context: Context,
): readonly Actor[] {
  const [, featureId] = /^feature:(.+):\d+$/.exec(known.id) ?? [];
  const passives = deriveStats(attacker, context).passives.filter(
    (passive) =>
      passive.kind === "alsoStrikes" &&
      passive.feature === featureId &&
      (passive.label === undefined || passive.label === known.activation.label),
  );
  return passives.flatMap((passive): Actor[] => {
    if (passive.kind !== "alsoStrikes") return [];
    if (passive.other === undefined) {
      const hit = actorOf(context.state, hitId);
      return hit.id === target.id || isDown(hit) ? [] : [hit];
    }
    const feet = passive.other;
    const [nearest] = Object.values(context.state.actors)
      .filter(
        (other) =>
          other.id !== target.id &&
          other.side !== attacker.side &&
          !isDown(other) &&
          distanceFeet(attacker.position, other.position) <= feet &&
          fitsType(other, known.activation.targeting, context, attacker),
      )
      .sort(
        (a, b) =>
          distanceFeet(target.position, a.position) -
          distanceFeet(target.position, b.position),
      );
    return nearest ? [nearest] : [];
  });
}

export const ConcentrationSchema = z.object({
  actor: z.string(),
  dc: z.number(),
  disadvantage: z.boolean().optional(), // from a Mage Slayer's damage
});

export function runConcentrationSave(
  payload: z.infer<typeof ConcentrationSchema>,
  context: Context,
): SystemResult {
  const actor = actorOf(context.state, payload.actor);
  if (actor.concentratingOn === null) return {};
  // Boon of the Iron Mind: damage alone never breaks the bearer's Concentration.
  const held = actor.concentratingOn
    .replace(/^spell:/, "")
    .replace(/:free$/, "");
  if (
    !isDown(actor) &&
    deriveStats(actor, context).passives.some(
      (passive) =>
        passive.kind === "unshakableFocus" &&
        (!passive.spells || passive.spells.includes(held)),
    )
  ) {
    return {};
  }
  // Being down ends Concentration outright, as does any failed save.
  const save = isDown(actor)
    ? null
    : rollSave(
        actor,
        "con",
        payload.dc - concentrationBonus(actor, context),
        context,
        false,
        0,
        ["concentration"],
        payload.disadvantage === true ||
          // An eerie chanting zone hampers Concentration (environment.ts).
          passiveModifiers(deriveStats(actor, context).passives).some(
            (modifier) =>
              modifier.kind === "disadvantage" &&
              modifier.on === "saves" &&
              modifier.concentration === true,
          ),
      );
  // A Ring of Dedicated Focus: Hit Point Dice added to a failed save.
  const rescued =
    save && !save.saved
      ? rescuedSave(
          actor,
          "con",
          ["concentration"],
          deriveStats(actor, context),
          save.events,
          [],
          context.dice,
          false,
          { access: context },
        )
      : [];
  const rolled = [...(save?.events ?? []), ...rescued];
  // A reaction to the save, as with Warp Mind.
  const watched = save
    ? reactFrames({ kind: "concentrationSave", actor: actor.id }, context)
    : [];
  if (!save?.saved && rescued.length === 0) {
    return {
      events: [
        ...rolled,
        dndEvent(`${NS}:concentrationEnded`, { actor: actor.id }),
      ],
      frames: watched,
    };
  }
  return { events: rolled, frames: watched };
}

export const attackFrames = {
  [`${NS}:attackRoll`]: frameHandler({
    schema: AttackSchema,
    run: runAttackRoll,
  }),
  [`${NS}:projectile`]: frameHandler({
    schema: AttackSchema,
    run: runProjectile,
  }),
  [`${NS}:afterHit`]: frameHandler({
    schema: AfterHitSchema,
    run: runAfterHit,
  }),
  [`${NS}:smite`]: frameHandler({ schema: SmiteSchema, run: runSmite }),
  [`${NS}:missRider`]: frameHandler({ schema: HitSchema, run: runMissRider }),
  [`${NS}:strikeChosen`]: frameHandler({
    schema: StrikeChosenSchema,
    run: runStrikeChosen,
  }),
  [`${NS}:advantageForgone`]: frameHandler({
    schema: AdvantageForgoneSchema,
    run: runAdvantageForgone,
  }),
  [`${NS}:replaceHit`]: frameHandler({
    schema: HitSchema.extend({ landed: z.boolean(), answer: z.string() }),
    run: runReplaceHit,
  }),
  [`${NS}:rollReaction`]: frameHandler({
    schema: RollReactionSchema,
    run: runRollReaction,
  }),
  [`${NS}:afterReaction`]: frameHandler({
    schema: ReactionSchema,
    run: runAfterReaction,
  }),
  [`${NS}:recheckHit`]: frameHandler({
    schema: HitSchema,
    run: runRecheckHit,
  }),
  [`${NS}:applyHit`]: frameHandler({ schema: HitSchema, run: runApplyHit }),
  [`${NS}:applyMiss`]: frameHandler({ schema: HitSchema, run: runApplyMiss }),
  [`${NS}:concentrationSave`]: frameHandler({
    schema: ConcentrationSchema,
    run: runConcentrationSave,
  }),
};
