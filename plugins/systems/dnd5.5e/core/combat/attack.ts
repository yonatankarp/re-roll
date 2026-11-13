import { z } from "zod";
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
import { behindTotalCover, coverAgainst, seeing } from "../sight.ts";
import { insideDamageEvents, swallowerOf } from "./swallow.ts";
import {
  awaitDecision,
  type SystemEvent,
  type SystemResult,
  frameHandler,
} from "#sdk";
import {
  attackBonus,
  damageResponses,
  deriveStats,
  type KnownAction,
  modifierFor,
  passiveModifiers,
  evaluateFormula,
  rollAmount,
  rollDiceNotation,
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
import { type Damage, ItemSchema, type Resolution } from "../schemas.ts";
import {
  armoredReduction,
  masteredDice,
  masteredTypes,
  piercing,
  steadyShot,
  weaponDamageDice,
} from "../trait-rules.ts";
import {
  actorOf,
  allies,
  canAfford,
  charmersOf,
  CHECK_END,
  type Context,
  enemies,
  exemptFrom,
  findAction,
  hasFlag,
  hasPassive,
  isMelee,
  meleeReach,
  rollBonus,
  slotToSpend,
  within5,
  withUpcasts,
} from "./queries.ts";
import {
  concentrationFrame,
  dealEvents,
  leafEvents,
  payCosts,
  resolveAction,
  rollSave,
} from "./effects.ts";

// Attack rolls and what follows a hit: reactions, damage, riders, smites and concentration saves.

export const AttackSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
  noModifier: z.boolean().optional(), // an off-hand or Cleave attack, whose damage leaves out the ability modifier
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
  return { events, frames: concentrationFrame(target, dealt) };
}

// Reports whether a reaction could still change the result of this attack.
function reactionFor(
  target: Actor,
  total: number,
  ac: number,
  context: Context,
  critical: boolean,
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
      const { resolution } = activation;
      if (resolution.kind !== "automatic") return false;
      if (resolution.effects.some((effect) => effect.kind === "reduceDamage")) {
        return true;
      }
      if (critical) return false;
      const acBonus = resolution.effects.reduce((sum, effect) => {
        return effect.kind === "modifier" &&
          effect.modifier.kind === "bonus" &&
          effect.modifier.to === "ac"
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
  holding: "shield" | "shieldOrWeapon" | undefined,
  context: Context,
): boolean {
  return (
    holding === undefined ||
    equipped(actor).some((id) => {
      const item = ItemSchema.safeParse(context.content(id)).data;
      return (
        item?.type === "shield" ||
        (holding === "shieldOrWeapon" && item?.type === "weapon")
      );
    })
  );
}

// An ally's reaction for a target within 5 feet: Protection before the roll, Interception after a hit. It's taken
// as soon as it can be, the way a companion takes it, so the player isn't asked.
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
      !within5(guard, target) ||
      seeing(guard, attacker.position, state, context) === "none"
    ) {
      continue;
    }
    const stats = deriveStats(guard, context);
    const action = stats.actions.find(
      (item) =>
        item.activation.trigger?.[when] &&
        holds(guard, item.activation.trigger.holding, context) &&
        canAfford(item, guard, stats),
    );
    if (action) return { guard, action };
  }
  return null;
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

// Interception: an ally lessens the hit by what its reaction rolls.
function intercepted(
  hit: z.infer<typeof HitSchema>,
  context: Context,
): { readonly events: SystemEvent[]; readonly hit: z.infer<typeof HitSchema> } {
  const { state, dice } = context;
  const target = actorOf(state, hit.target);
  const found = guardFor(
    target,
    actorOf(state, hit.attacker),
    "allyHit",
    context,
  );
  if (!found) return { events: [], hit };
  const { guard, action } = found;
  const { resolution } = action.activation;
  const stats = deriveStats(guard, context);
  const reduceBy = (
    resolution.kind === "automatic" ? resolution.effects : []
  ).reduce(
    (sum, effect) =>
      effect.kind === "reduceDamage" && effect.amount
        ? sum + rollAmount(effect.amount, stats, dice)
        : sum,
    0,
  );
  return {
    events: guardCosts(guard, action, context),
    hit: { ...hit, reduceBy: (hit.reduceBy ?? 0) + reduceBy },
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

  // A later attack in a multiattack moves on if its first target has already fallen.
  const target = aimAt(payload.target, attacker, state);
  if (!target) return {};

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
  const stats = deriveStats(attacker, context);
  const targetStats = deriveStats(target, context);
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
    hasFlag(target, "advantage", "attacksAgainst", targetStats) ||
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
    (hasCondition(target, "prone") && close);
  // Protection: an ally's Shield gives this roll, and the others against the target, Disadvantage.
  const shielded = guardFor(target, attacker, "allyAttacked", context);
  const guarded = shielded
    ? [
        ...guardCosts(shielded.guard, shielded.action, context),
        ...(resolveAction(shielded.action, shielded.guard, [target], context)
          .events ?? []),
      ]
    : [];
  const disadvantage =
    shielded !== null ||
    crowded ||
    unseenTarget ||
    proneFar ||
    dodging(target) ||
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
    hasCondition(
      attacker,
      "blinded",
      "frightened",
      "poisoned",
      "prone",
      "restrained",
    ) ||
    invisibleTo(target, attacker);
  const roll = rollD20(dice, {
    advantage,
    disadvantage,
    rerollOnes: hasPassive(stats, "rerollOnes"),
  });
  const hadAdvantage = advantage && !disadvantage;
  const total =
    roll.natural +
    attackBonus(resolution, stats) +
    rollBonus(attacker, "attacks", context);
  const cover = coverAgainst(state, attacker, target);
  const ac =
    targetStats.ac +
    (steady.bypassCover && meleeReach(action) === null ? 0 : cover);
  const critFrom = criticalFrom(stats);
  const hits = roll.natural >= critFrom || (roll.natural !== 1 && total >= ac);
  // A hit from within 5 feet on a Paralyzed or Unconscious target is a Critical Hit.
  const critical =
    roll.natural >= critFrom ||
    (hits &&
      isMelee(action) &&
      hasCondition(target, "paralyzed", "unconscious"));

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
    ...guarded,
    ...onceEnded(attacker, "attacks"),
    ...onceEnded(target, "attacksAgainst"),
    ...revealEvents(attacker),
  ];
  const hit = {
    attacker: attacker.id,
    actionId: action.id,
    target: target.id,
    critical,
    hadAdvantage,
    total,
    natural: roll.natural,
    ...(payload.slotLevel === undefined
      ? {}
      : { slotLevel: payload.slotLevel }),
    ...(payload.noModifier ? { noModifier: true } : {}),
  };

  if (!hits) {
    const reroll = offerInspiration(
      attacker,
      { ...payload, target: target.id },
      report,
      hit,
      context,
    );
    if (reroll) {
      return { ...reroll, events: [...guarded, ...(reroll.events ?? [])] };
    }
    return {
      events: [report, ...spent],
      ...(masteryOf(attacker, action.id, context)
        ? { frames: [frame("masteryMiss", hit)] }
        : {}),
    };
  }

  const reaction = reactionFor(target, total, ac, context, critical);
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
  return {
    events: [report, ...spent, ...guard.events],
    frames: [frame("applyHit", guard.hit)],
  };
}

export const HitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  hadAdvantage: z.boolean(),
  total: z.number(),
  natural: z.number(),
  slotLevel: z.number().optional(),
  halve: z.boolean().optional(), // set by a reaction like Uncanny Dodge
  reduceBy: z.number().optional(), // set by a reaction like Deflect Attacks
  noModifier: z.boolean().optional(),
});

export const ReactionSchema = HitSchema.extend({ answer: z.string() });

export function runAfterReaction(
  payload: z.infer<typeof ReactionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const { answer, ...hit } = payload;
  if (answer === DECLINE) {
    const guard = intercepted(hit, context);
    return { events: guard.events, frames: [frame("applyHit", guard.hit)] };
  }

  const target = actorOf(state, payload.target);
  const action = findAction(target, answer, context);
  const result = resolveAction(action, target, [target], context);
  const { resolution } = action.activation;
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
  // The rest of the attack is held here and rechecked once the reaction has taken effect.
  return {
    events: [...payCosts(action, target, context), ...(result.events ?? [])],
    frames: [
      ...(result.frames ?? []),
      frame("recheckHit", {
        ...hit,
        ...(lessened.some((effect) => effect.halve) ? { halve: true } : {}),
        ...(reduceBy > 0 ? { reduceBy: (hit.reduceBy ?? 0) + reduceBy } : {}),
      }),
    ],
  };
}

export function runRecheckHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const target = actorOf(state, payload.target);
  const ac =
    deriveStats(target, context).ac +
    coverAgainst(state, actorOf(state, payload.attacker), target);
  if (!payload.critical && payload.total < ac) return {};
  const guard = intercepted(payload, context);
  return { events: guard.events, frames: [frame("applyHit", guard.hit)] };
}

export function runApplyHit(
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
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  const stats = deriveStats(attacker, context);
  const multiplier = payload.critical ? 2 : 1;
  const mastered = masteredTypes(stats, action.spellLevel !== null);
  const responses = piercing(damageResponses(target, context), mastered, stats);

  const events: SystemEvent[] = [];
  let totalDealt = 0;
  const firstType = resolution.damage[0]?.type;

  // Add dice-based extra damage such as Sneak Attack to the first damage roll.
  let extra = 0;
  stats.passives.forEach((passive, index) => {
    if (passive.kind !== "extraDamage") return;
    const key = `extra:${String(index)}`;
    if (passive.oncePerTurn && attacker.usedThisTurn.includes(key)) return;
    const allyPresent = allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id && !isDown(item) && within5(item, target),
    );
    const applies =
      passive.when === "advantage"
        ? payload.hadAdvantage
        : payload.hadAdvantage || allyPresent;
    if (!applies) return;
    extra += rollDiceNotation(passive.dice, dice, multiplier);
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
  if (savage) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: attacker.id,
        key: SAVAGE_ATTACKER,
      }),
    );
  }
  const weaponDice = weaponDamageDice(dice, action.id, stats, context);
  resolution.damage.forEach(({ amount, type }, index) => {
    const roll = () =>
      rollAmount(
        amount,
        stats,
        masteredDice(weaponDice, type, mastered),
        multiplier,
      );
    const rolled =
      (savage && index === 0 ? Math.max(roll(), roll()) : roll()) +
      (index === 0 && type === firstType
        ? extra + damageBonus(attacker, resolution, stats, context)
        : 0) -
      (index === 0 && payload.noModifier && resolution.attack.ability
        ? Math.max(0, modifierFor(stats, resolution.attack.ability))
        : 0);
    const final = finalDamage(Math.max(0, rolled), type, responses);
    totalDealt += final;
  });

  const hits = [
    ...(firstType ? [{ amount: totalDealt, type: firstType }] : []),
    ...hitRiders(attacker, target, resolution).map(({ amount, type }) => ({
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
    amount: Math.max(
      0,
      item.amount - armoredReduction(target, targetStats, item.type, context),
    ),
  }));
  const dealt = dealEvents(
    target,
    lessenHits(armored, payload),
    payload.critical,
    context,
  );
  events.push(
    ...dealt.events,
    ...damageRiders(
      attacker,
      target,
      resolution,
      payload.critical,
      stats,
      context,
    ),
    ...insideDamageEvents(attacker, target, dealt.dealt),
    ...leafEvents(resolution.onHit, action.id, attacker, target, context),
  );
  // The save sees the target as the hit left it.
  const afterHit = events.reduce(applyDndEvent, state);
  const nested = nestedSave(resolution, action, attacker, target, {
    ...context,
    state: afterHit,
  });
  events.push(...nested.events);
  return {
    events,
    frames: [
      ...concentrationFrame(target, dealt.dealt + nested.dealt),
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
      CHECK_END,
    ],
  };
}

// Crusher's and Slasher's effects on a creature hit by an attack dealing their damage type.
function damageRiders(
  attacker: Actor,
  target: Actor,
  resolution: Extract<Resolution, { kind: "attack" }>,
  critical: boolean,
  stats: Stats,
  context: Context,
): SystemEvent[] {
  const types = new Set(resolution.damage.map(({ type }) => type));
  return stats.passives.flatMap((passive) => {
    if (passive.kind !== "damageRider" || !types.has(passive.damage)) return [];
    if (passive.critical && !critical) return [];
    const key = `rider:${passive.damage}:${String(passive.critical)}`;
    if (passive.oncePerTurn && attacker.usedThisTurn.includes(key)) return [];
    return [
      ...(passive.oncePerTurn
        ? [dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key })]
        : []),
      ...leafEvents(passive.effects, key, attacker, target, context),
    ];
  });
}

// shortcut: a reaction lessens the damage after Resistance rather than before it, which only matters to rounding.
function lessenHits<T extends { readonly amount: number }>(
  hits: readonly T[],
  { halve, reduceBy = 0 }: z.infer<typeof HitSchema>,
): T[] {
  let left = reduceBy;
  return hits.map((item) => {
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
      seen.has(sourceId)
    ) {
      return [];
    }
    seen.add(sourceId);
    return [modifier.damage];
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
  const save = resolution.onHitSave;
  const target = context.state.actors[hit.id];
  if (!save || !target || isDead(target)) return { events: [], dealt: 0 };
  if (exemptFrom(save.exempt, target, deriveStats(target, context))) {
    return { events: [], dealt: 0 };
  }
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
  const responses = damageResponses(target, context);
  const damage = dealEvents(
    target,
    save.damage.flatMap(({ amount, type }) => {
      const total = rollAmount(amount, stats, context.dice);
      const scaled =
        !rolled.saved || save.onSuccessDamage === "full"
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
      ...rolled.events,
      ...damage.events,
      ...leafEvents(
        rolled.saved ? save.onSuccess : save.onFail,
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
      canAfford(action, attacker, stats) &&
      (trigger.afterHit === "weapon" || isMelee(hitWith))
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
  const options = smitesFor(hitWith, attacker, stats).flatMap((action) =>
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
  // A smite's damage is part of the attack, so a Critical Hit doubles its dice too.
  const result = resolveAction(
    action,
    attacker,
    [target],
    context,
    slotLevel,
    payload.critical,
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
});

export function runConcentrationSave(
  payload: z.infer<typeof ConcentrationSchema>,
  context: Context,
): SystemResult {
  const actor = actorOf(context.state, payload.actor);
  if (actor.concentratingOn === null) return {};
  // Being down ends Concentration outright, as does any failed save.
  const save = isDown(actor)
    ? null
    : rollSave(actor, "con", payload.dc, context, false, 0, ["concentration"]);
  const rolled = save?.events ?? [];
  if (!save?.saved) {
    return {
      events: [
        ...rolled,
        dndEvent(`${NS}:concentrationEnded`, { actor: actor.id }),
      ],
    };
  }
  return { events: rolled };
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
  [`${NS}:afterReaction`]: frameHandler({
    schema: ReactionSchema,
    run: runAfterReaction,
  }),
  [`${NS}:recheckHit`]: frameHandler({
    schema: HitSchema,
    run: runRecheckHit,
  }),
  [`${NS}:applyHit`]: frameHandler({ schema: HitSchema, run: runApplyHit }),
  [`${NS}:concentrationSave`]: frameHandler({
    schema: ConcentrationSchema,
    run: runConcentrationSave,
  }),
};
