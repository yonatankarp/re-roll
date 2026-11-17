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
  invisibleTo,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
  frame,
} from "../state.ts";
import { ALL, DECLINE, parseOption } from "./ids.ts";
import { aroundHit, replaceHitFrame, runReplaceHit } from "./ranged-smite.ts";
import { againstTarget, missFrames, runApplyMiss } from "./spell-riders.ts";
import { duelBroken, duelDamaged, duelHampers } from "./duel.ts";
import { distanceFeet } from "../grid.ts";
import { grapplesOn } from "./grapple.ts";
import { behindTotalCover, coverAgainst, seeing } from "../sight.ts";
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
  scaledDice,
  saveBonus,
  spellSaveDc,
  type Stats,
} from "../stats.ts";
import { finalDamage, halved, rollD20 } from "../rules.ts";
import {
  dodging,
  grappledAwayFrom,
  masteryOf,
  revealEvents,
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
  maximized,
  masteredTypes,
  rerolledTypes,
  piercing,
  rescuedSave,
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
  carriesExtraDice,
  charmersOf,
  CHECK_END,
  type Context,
  enemies,
  exemptFrom,
  findAction,
  isStuck,
  fitsType,
  hasFlag,
  hasPassive,
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
  const advantage =
    packed ||
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
    invisibleTo(attacker, target) ||
    hasCondition(
      target,
      "blinded",
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
    traitAttackAdvantage(stats, attacker, target, targetStats);
  const held = payload.rolled;
  // Redirect Attack: the target trades places with an ally next to it, who takes the attack instead.
  const redirected = held ? null : redirect(attacker, target, context);
  if (redirected) {
    return {
      events: redirected.events,
      frames: [frame("attackRoll", { ...payload, target: redirected.ally })],
    };
  }
  // Protection: an ally's Shield gives this roll, and the others against the target, Disadvantage.
  const shielded = held
    ? null
    : guardFor(target, attacker, "allyAttacked", context);
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
    hasFlag(attacker, "disadvantage", "attacks", stats, ability) ||
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
    hasCondition(
      attacker,
      "blinded",
      "frightened",
      "poisoned",
      "prone",
      "restrained",
    ) ||
    invisibleTo(target, attacker) ||
    warded(target, targetStats) ||
    (action.spellLevel !== null &&
      passiveModifiers(targetStats.passives).some(
        (modifier) =>
          modifier.kind === "disadvantage" &&
          modifier.on === "attacksAgainst" &&
          modifier.spells,
      ));
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
  const critFrom = criticalFrom(stats);
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
    ...onceEnded(target, "attacksAgainst", attacker.id),
    ...revealEvents(attacker),
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

export function runApplyHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const instead = payload.kept ? null : replaceHitFrame(payload, true, context);
  if (instead) return { frames: [instead] };
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
  const resolution = againstTarget(
    payload.poleStrike ? poleEnd(printed) : printed,
    target,
    context,
  );
  const stats = deriveStats(attacker, context);
  const multiplier = payload.critical ? 2 : 1;
  const mastered = masteredTypes(stats, action.spellLevel !== null);
  const rerolled = rerolledTypes(stats, action.spellLevel !== null);
  const responses = piercing(damageResponses(target, context), mastered, stats);

  const events: SystemEvent[] = [];
  let totalDealt = 0;
  const absorbed: { amount: number; type: DamageType }[] = [];
  const firstType = resolution.damage[0]?.type;

  // Add dice-based extra damage such as Sneak Attack to the first damage roll.
  let extra = 0;
  const typedExtra: Damage[] = [];
  const extraDice = carriesExtraDice(attacker, action, context);
  // Pull of Death's comes with any attack, against a target missing Hit Points.
  const hurt = (): boolean => target.hp < deriveStats(target, context).maxHp;
  stats.passives.forEach((passive, index) => {
    if (passive.kind !== "extraDamage") return;
    if (passive.when === "targetHurt" ? !hurt() : !extraDice) return;
    const key = `extra:${String(index)}`;
    if (passive.oncePerTurn && attacker.usedThisTurn.includes(key)) return;
    // Sneak Attack's ally must be able to act, and the ally never makes up for Disadvantage on the roll.
    const allyPresent = allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id &&
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, target),
    );
    const applies =
      passive.when === "targetHurt" ||
      (passive.when === "advantage"
        ? payload.hadAdvantage
        : payload.hadAdvantage ||
          (allyPresent && payload.hadDisadvantage !== true));
    if (!applies) return;
    const rolled = rollDiceNotation(
      scaledDice(passive, stats.scaling) ?? passive.dice,
      dice,
      multiplier,
    );
    if (passive.type) {
      typedExtra.push({
        amount: { bonus: { base: rolled, add: [] } },
        type: passive.type,
      });
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
          : masteredDice(weaponDice, type, mastered, rerolled);
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

  const hits = [
    ...(firstType ? [{ amount: totalDealt, type: firstType }] : []),
    ...absorbed,
    ...[
      ...typedExtra,
      ...hitRiders(attacker, target, resolution, responses),
    ].map(({ amount, type }) => ({
      amount: finalDamage(
        rollAmount(amount, stats, dice, multiplier),
        type,
        responses,
      ),
      type,
    })),
  ];
  const targetStats = deriveStats(target, context);
  const armored = hits.map((item) => ({
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
    ),
    ...insideDamageEvents(attacker, target, dealt.dealt),
    ...leafEvents(resolution.onHit, action.id, attacker, target, context),
    ...oncePerTurnHit(resolution, action, attacker, target, context),
    ...drained(resolution, attacker, dealt.dealt, stats),
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
  // What answers the hit: the damage, the hit itself, and a foe striking someone else, as with Sentinel's Guardian.
  const landed = {
    ...context,
    state: nested.events.reduce(applyDndEvent, afterHit),
  };
  const how = attackKind(payload, context);
  const cause = {
    source: attacker.id,
    types: armored.flatMap((item) => (item.amount > 0 ? [item.type] : [])),
    ...how,
  };
  return {
    events,
    frames: [
      ...concentrationFrame(
        target,
        dealt.dealt + nested.dealt,
        hasPassive(stats, "concentrationBreaker"),
      ),
      // The attacker's own choices for its hit come before the target's answers.
      ...(smitesFor(action, attacker, stats).length > 0
        ? [
            frame("afterHit", {
              attacker: attacker.id,
              actionId: action.id,
              target: target.id,
              critical: payload.critical,
            }),
          ]
        : []),
      ...(masteryOf(attacker, action.id, context)
        ? [frame("masteryHit", { ...payload, dealt: dealt.dealt })]
        : []),
      ...passed.frames,
      ...afterDamage(target, dealt.dealt + nested.dealt, cause, [], landed),
      ...reactFrames({ kind: "struck", actor: target.id, ...cause }, landed),
      ...reactFrames({ kind: "hitOther", actor: target.id, ...cause }, landed),
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

// Damage added to the bearer's next attack only, as Deadly Aim's, is spent by that attack, hit or miss, as is
// True Strike's change to it.
function onceHitEnded(attacker: Actor): SystemEvent[] {
  return attacker.activeEffects.flatMap(({ modifier, sourceId }) =>
    (modifier.kind === "hitDamage" || modifier.kind === "weaponSpell") &&
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

// A Dhampir's Vampiric Bite: the hit heals the biter by the damage it dealt.
// shortcut: always Drain, never Strengthen.
function drained(
  resolution: Extract<Resolution, { kind: "attack" }>,
  attacker: Actor,
  dealt: number,
  stats: Stats,
): SystemEvent[] {
  const { drain } = resolution;
  if (!drain || dealt <= 0 || !hasUse(attacker, stats, drain.resource))
    return [];
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: attacker.id,
      resource: drain.resource,
    }),
    dndEvent(`${NS}:healed`, {
      actor: attacker.id,
      amount: Math.min(dealt, stats.maxHp - Math.max(attacker.hp, 0)),
      max: stats.maxHp,
    }),
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
        distanceFeet(attacker.position, item.position) <= 30,
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
): readonly Damage[] {
  const seen = new Set<string>();
  const carried = [
    ...attacker.activeEffects.map((effect) => ({ effect, by: "bearer" })),
    ...target.activeEffects.map((effect) => ({ effect, by: "caster" })),
  ];
  return carried.flatMap(({ effect, by }) => {
    const { modifier, sourceId, casterId } = effect;
    if (
      modifier.kind !== "hitDamage" ||
      modifier.dealtBy !== by ||
      (by === "caster" && casterId !== attacker.id) ||
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
  const onceKey = `onhit:${action.id}`;
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
  stats: Stats,
): readonly KnownAction[] {
  const { resolution } = hitWith.activation;
  if (resolution.kind !== "attack" || resolution.attack.type !== "weapon") {
    return [];
  }
  return stats.actions.filter((action) => {
    const { trigger } = action.activation;
    return (
      trigger?.afterHit !== undefined &&
      !trigger.replacesHit && // offered before the hit lands instead (combat/ranged-smite.ts)
      canAfford(action, attacker, stats) &&
      (trigger.afterHit === "weapon" ||
        (trigger.afterHit === "meleeWeapon") === isMelee(hitWith))
    );
  });
}

export const AfterHitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
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
  const options = smitesFor(hitWith, attacker, stats)
    .filter((action) =>
      fitsType(target, action.activation.targeting, context, attacker),
    )
    .flatMap((action) =>
      withUpcasts(action, attacker, stats, target.id, action.name),
    );
  if (isDown(target) || isDown(attacker) || options.length === 0) return {};
  return {
    frames: [
      awaitDecision({
        id: `${NS}:afterHit:${attacker.id}`,
        actor: attacker.id,
        prompt: `${attacker.name} hits ${target.name}. Add a spell to the hit?`,
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
  const target = actorOf(state, payload.target);
  const [actionId = "", , slot] = parseOption(payload.answer);
  const known = findAction(attacker, actionId, context);
  const slotLevel =
    slot === undefined
      ? (slotToSpend(known, attacker, deriveStats(attacker, context)) ??
        undefined)
      : Number(slot);
  const action = asHit(
    findAction(attacker, actionId, context, slotLevel),
    findAction(attacker, payload.actionId, context),
  );
  // A smite's damage is part of the attack, so a Critical Hit doubles its dice too, but not an area's round the target.
  const result = resolveAction(
    action,
    attacker,
    aroundHit(action, attacker, target, context),
    context,
    slotLevel,
    payload.critical && !("area" in action.activation.targeting),
    target.position ?? undefined,
  );
  return {
    events: [
      ...payCosts(action, attacker, context, slotLevel),
      ...(result.events ?? []),
    ],
    frames: [...(result.frames ?? [])],
  };
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
  if (
    !isDown(actor) &&
    hasPassive(deriveStats(actor, context), "unshakableFocus")
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
        payload.disadvantage,
      );
  const rolled = save?.events ?? [];
  // A reaction to the save, as with Warp Mind.
  const watched = save
    ? reactFrames({ kind: "concentrationSave", actor: actor.id }, context)
    : [];
  if (!save?.saved) {
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
