import {
  type ContentAccess,
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
} from "#sdk";
import { z } from "zod";
import { concentrationDc, finalDamage, halved, rollD20 } from "./rules.ts";
import type { Ability, Damage, LeafEffect, Resolution } from "./schemas.ts";
import { MonsterSchema, PregenSchema } from "./schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  dndEvent,
  freshActor,
  isDead,
  isDown,
} from "./state.ts";
import {
  type KnownAction,
  type Stats,
  damageResponses,
  deriveStats,
  evaluateFormula,
  lookup,
  modifierFor,
  rollAmount,
  rollDiceNotation,
} from "./stats.ts";

export type Context = SystemContext<DndState>;

export const PASS = "pass";
const DEATH_SAVE = "deathSave";
const SEPARATOR = "|";

function actorOf(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`Unknown actor ${id}`);
  return actor;
}

function frame(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): Frame {
  return { kind: `${NS}:${kind}`, payload };
}

const CHECK_END = frame("checkCombatEnd", {});

function hasFlag(
  actor: Actor,
  kind: "advantage" | "disadvantage",
  on: "attacks" | "saves" | "checks",
): boolean {
  return actor.activeEffects.some(
    ({ modifier }) => modifier.kind === kind && modifier.on === on,
  );
}

// Effects from one source count once, so casting Bless twice can't add two d4s.
function rollBonus(
  actor: Actor,
  to: "attacks" | "saves" | "checks",
  context: Context,
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const effect of actor.activeEffects) {
    const { modifier } = effect;
    if (modifier.kind !== "bonus" || modifier.to !== to) continue;
    if (seen.has(effect.sourceId)) continue;
    seen.add(effect.sourceId);
    const caster = context.state.actors[effect.casterId] ?? actor;
    total += rollAmount(
      modifier.amount,
      deriveStats(caster, context),
      context.dice,
    );
  }
  return total;
}

function allies(state: DndState, actor: Actor): readonly Actor[] {
  return state.combat
    ? state.combat.order.flatMap((id) => {
        const other = actorOf(state, id);
        return other.side === actor.side ? [other] : [];
      })
    : [];
}

function enemies(state: DndState, actor: Actor): readonly Actor[] {
  return state.combat
    ? state.combat.order.flatMap((id) => {
        const other = actorOf(state, id);
        return other.side !== actor.side ? [other] : [];
      })
    : [];
}

export function canAfford(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): boolean {
  return action.activation.cost.every((cost) => {
    if (cost === "action") return actor.budget.action;
    if (cost === "bonusAction") return actor.budget.bonusAction;
    if (cost === "reaction") return actor.budget.reaction;
    if (cost === "slot") {
      const level = action.spellLevel ?? 1;
      return (
        (actor.resourcesSpent[`slot:${String(level)}`] ?? 0) <
        (stats.slots[level - 1] ?? 0)
      );
    }
    return (
      (actor.resourcesSpent[cost.resource] ?? 0) <
      (stats.resources[cost.resource] ?? 0)
    );
  });
}

function turnOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): Decision["options"] {
  const stats = deriveStats(actor, access);
  const options: { id: string; label: string }[] = [];
  const living = (list: readonly Actor[]): readonly Actor[] =>
    list.filter((item) => !isDead(item));

  for (const action of stats.actions) {
    const { activation } = action;
    if (activation.trigger || !canAfford(action, actor, stats)) continue;
    const { targeting } = activation;
    if ("self" in targeting) {
      options.push({
        id: `${action.id}${SEPARATOR}${actor.id}`,
        label: action.name,
      });
    } else if ("area" in targeting || targeting.creatures > 1) {
      // shortcut: with no positions until step 6, an area or multi-target choice takes everyone it can.
      options.push({ id: `${action.id}${SEPARATOR}all`, label: action.name });
    } else {
      const candidates = living(
        targeting.side === "enemy"
          ? enemies(state, actor).filter((item) => !isDown(item))
          : allies(state, actor),
      );
      for (const target of candidates) {
        options.push({
          id: `${action.id}${SEPARATOR}${target.id}`,
          label: `${action.name}: ${target.name} (${String(target.hp)} HP)`,
        });
      }
    }
  }
  options.push({ id: PASS, label: "End your turn" });
  return options;
}

export function nextDndDecision(
  state: DndState,
  access: ContentAccess,
): Decision | null {
  const player = state.actors[PLAYER_ACTOR];
  if (player?.source.kind === "character" && player.source.build === null) {
    const options = access
      .contentIds()
      .filter((id) => id.includes(":pregen/"))
      .map((id) => ({ id, label: lookup(access, PregenSchema, id).name }));
    return {
      id: `${NS}:chooseCharacter`,
      actor: PLAYER_ACTOR,
      prompt: "Choose your character.",
      options,
      resume: frame("characterChosen", {}),
    };
  }

  const { combat } = state;
  if (!combat) return null;
  const actorId = combat.order[combat.index];
  if (actorId === undefined) return null;
  const actor = actorOf(state, actorId);

  if (isDown(actor)) {
    return {
      id: `${NS}:deathSave:${actorId}:${String(combat.round)}`,
      actor: actorId,
      prompt: `${actor.name} is dying.`,
      options: [{ id: DEATH_SAVE, label: "Roll a death saving throw" }],
      resume: frame("takeAction", { actor: actorId }),
    };
  }
  return {
    id: `${NS}:turn:${actorId}:${String(combat.round)}:${actor.budget.action ? "a" : ""}${actor.budget.bonusAction ? "b" : ""}`,
    actor: actorId,
    prompt: `Round ${String(combat.round)}: ${actor.name}'s turn (${String(actor.hp)} HP).`,
    options: turnOptions(actor, state, access),
    resume: frame("takeAction", { actor: actorId }),
  };
}

export function startCombat(
  encounter: {
    readonly id: string;
    readonly monsters: readonly {
      readonly monster: string;
      readonly count: number;
    }[];
  },
  context: Context,
): SystemResult {
  const monsters: Actor[] = [];
  for (const { monster, count } of encounter.monsters) {
    const statBlock = lookup(context, MonsterSchema, monster);
    const slug = monster.slice(monster.lastIndexOf("/") + 1);
    for (let index = 1; index <= count; index += 1) {
      monsters.push(
        freshActor({
          id: `${encounter.id}:${slug}-${String(index)}`,
          name:
            count > 1 ? `${statBlock.name} ${String(index)}` : statBlock.name,
          side: "enemy",
          source: { kind: "monster", statBlockId: monster },
          hp: statBlock.hp,
          inventory: [],
        }),
      );
    }
  }

  const party = Object.values(context.state.actors).filter(
    (actor) => actor.side === "party" && !isDead(actor),
  );
  const rolled = [...party, ...monsters].map((actor, position) => ({
    id: actor.id,
    position,
    total: context.dice.roll(20) + deriveStats(actor, context).initiative,
  }));
  // Ties keep their listed order, so the result is the same on every machine.
  const order = rolled
    .sort((a, b) => b.total - a.total || a.position - b.position)
    .map((item) => item.id);

  return {
    events: [
      { kind: "encounterStarted", encounter: encounter.id },
      dndEvent(`${NS}:combatStarted`, {
        encounter: encounter.id,
        monsters,
        order,
      }),
    ],
  };
}

function payCosts(action: KnownAction, actor: Actor): SystemEvent[] {
  const events: SystemEvent[] = [];
  for (const cost of action.activation.cost) {
    if (cost === "action" || cost === "bonusAction" || cost === "reaction") {
      events.push(
        dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: cost }),
      );
    } else if (cost === "slot") {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: `slot:${String(action.spellLevel ?? 1)}`,
        }),
      );
    } else {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: cost.resource,
        }),
      );
    }
  }
  return events;
}

function concentrationFrame(target: Actor, amount: number): readonly Frame[] {
  return target.concentratingOn !== null && amount > 0
    ? [
        frame("concentrationSave", {
          actor: target.id,
          dc: concentrationDc(amount),
        }),
      ]
    : [];
}

// Reports the damage, and whatever follows from it, as events.
export function damageEvents(
  target: Actor,
  amount: number,
  type: Damage["type"],
  critical: boolean,
  context: Context,
): SystemEvent[] {
  if (amount <= 0) return [];
  // Damage left over after reaching 0 HP kills a character if it's at least their maximum.
  const remaining = amount - target.tempHp - Math.max(0, target.hp);
  const massive =
    target.side === "party" && remaining >= deriveStats(target, context).maxHp;
  const events: SystemEvent[] = [
    dndEvent(`${NS}:damaged`, {
      actor: target.id,
      amount,
      type,
      critical,
      massive,
    }),
  ];
  if (target.side === "enemy") {
    if (target.hp > 0 && remaining >= 0) {
      events.push({ kind: "actorDefeated", actor: target.id });
    }
  } else if (massive) {
    events.push({ kind: "actorDefeated", actor: target.id });
  } else if (target.hp > 0 && remaining >= 0) {
    events.push({ kind: "actorDowned", actor: target.id });
  }
  return events;
}

function leafEvents(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(caster, context);
  const events: SystemEvent[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case "heal": {
        const max = deriveStats(target, context).maxHp;
        const rolled = rollAmount(effect.amount, stats, context.dice);
        // Healing beyond the maximum is lost, so only what's really gained is reported.
        events.push(
          dndEvent(`${NS}:healed`, {
            actor: target.id,
            amount: Math.min(rolled, max - Math.max(target.hp, 0)),
            max,
          }),
        );
        break;
      }
      case "tempHp":
        events.push(
          dndEvent(`${NS}:tempHpGained`, {
            actor: target.id,
            amount: rollAmount(effect.amount, stats, context.dice),
          }),
        );
        break;
      case "modifier":
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              modifier: effect.modifier,
              ends:
                typeof effect.duration === "object" &&
                "concentration" in effect.duration
                  ? "concentration"
                  : "casterNextTurn",
            },
          }),
        );
        break;
      case "applyCondition":
      case "removeCondition":
      case "forcedMove":
      case "note":
        // shortcut: these are recorded in the data but have no mechanical effect until step 5 needs them.
        break;
      default:
        effect satisfies never;
    }
  }
  return events;
}

function rollSave(
  target: Actor,
  ability: Ability,
  dc: number,
  context: Context,
): boolean {
  const stats = deriveStats(target, context);
  const roll = rollD20(context.dice, {
    advantage: hasFlag(target, "advantage", "saves"),
    disadvantage: hasFlag(target, "disadvantage", "saves"),
  });
  const proficiency = stats.savingThrows.includes(ability)
    ? stats.proficiency
    : 0;
  const total =
    roll.natural +
    modifierFor(stats, ability) +
    proficiency +
    rollBonus(target, "saves", context);
  return total >= dc;
}

function resolveTargets(
  answerTarget: string,
  action: KnownAction,
  actor: Actor,
  state: DndState,
): readonly Actor[] {
  const { targeting } = action.activation;
  if ("self" in targeting) return [actor];
  if (answerTarget !== "all") return [actorOf(state, answerTarget)];

  const pool = (
    targeting.side === "enemy" ? enemies(state, actor) : allies(state, actor)
  ).filter((item) => !isDead(item));
  if ("area" in targeting) return pool;
  return [...pool].sort((a, b) => a.hp - b.hp).slice(0, targeting.creatures);
}

function findAction(actor: Actor, id: string, context: Context): KnownAction {
  const action = deriveStats(actor, context).actions.find(
    (item) => item.id === id,
  );
  if (!action) throw new Error(`${actor.id} has no action ${id}`);
  return action;
}

function spellSource(action: KnownAction): string {
  return action.id;
}

function resolveAction(
  action: KnownAction,
  actor: Actor,
  targets: readonly Actor[],
  context: Context,
): SystemResult {
  const { resolution } = action.activation;
  const stats = deriveStats(actor, context);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];

  const usesConcentration = (effects: readonly LeafEffect[]): boolean =>
    effects.some(
      (effect) =>
        effect.kind === "modifier" &&
        typeof effect.duration === "object" &&
        "concentration" in effect.duration,
    );

  const beginConcentration = (effects: readonly LeafEffect[]): void => {
    if (!usesConcentration(effects)) return;
    if (actor.concentratingOn !== null) {
      events.push(dndEvent(`${NS}:concentrationEnded`, { actor: actor.id }));
    }
    events.push(
      dndEvent(`${NS}:concentrationStarted`, {
        actor: actor.id,
        spell: spellSource(action),
      }),
    );
  };

  const applyRolled = (
    target: Actor,
    damage: readonly {
      readonly total: number;
      readonly type: Damage["type"];
    }[],
    scale: (amount: number) => number,
  ): void => {
    let dealt = 0;
    for (const { total, type } of damage) {
      const final = finalDamage(scale(total), type, damageResponses(target));
      events.push(...damageEvents(target, final, type, false, context));
      dealt += final;
    }
    frames.push(...concentrationFrame(target, dealt));
  };

  const rollSharedDamage = (list: readonly Damage[]) =>
    list.map(({ amount, type }) => ({
      total: rollAmount(amount, stats, context.dice),
      type,
    }));

  switch (resolution.kind) {
    case "automatic": {
      beginConcentration(resolution.effects);
      const damage = rollSharedDamage(resolution.damage);
      for (const target of targets) {
        applyRolled(target, damage, (amount) => amount);
        events.push(
          ...leafEvents(
            resolution.effects,
            spellSource(action),
            actor,
            target,
            context,
          ),
        );
      }
      break;
    }
    case "save": {
      beginConcentration(resolution.onFail);
      const dc = evaluateFormula(resolution.dc, stats);
      // Damage against several targets at once is rolled once for all of them.
      const damage = rollSharedDamage(resolution.damage);
      for (const target of targets) {
        const saved = rollSave(target, resolution.ability, dc, context);
        applyRolled(target, damage, (amount) => {
          if (!saved) return amount;
          return resolution.onSuccessDamage === "half" ? halved(amount) : 0;
        });
        events.push(
          ...leafEvents(
            saved ? resolution.onSuccess : resolution.onFail,
            spellSource(action),
            actor,
            target,
            context,
          ),
        );
      }
      break;
    }
    case "attack": {
      for (const target of targets) {
        for (let attack = 0; attack < stats.multiattack; attack += 1) {
          frames.push(
            frame("attackRoll", {
              attacker: actor.id,
              actionId: action.id,
              target: target.id,
            }),
          );
        }
      }
      break;
    }
    default:
      resolution satisfies never;
  }
  return { events, frames };
}

const TakeActionSchema = z.object({ actor: z.string(), answer: z.string() });

export function runTakeAction(
  payload: z.infer<typeof TakeActionSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const actor = actorOf(state, payload.actor);

  if (payload.answer === DEATH_SAVE) {
    const natural = dice.roll(20);
    const events: SystemEvent[] = [
      dndEvent(`${NS}:deathSaveRolled`, { actor: actor.id, natural }),
    ];
    const failuresAfter =
      actor.deathSaves.failures + (natural < 10 ? (natural === 1 ? 2 : 1) : 0);
    if (natural !== 20 && failuresAfter >= 3) {
      events.push({ kind: "actorDefeated", actor: actor.id });
    }
    return {
      events,
      frames: [CHECK_END, frame("endTurn", {})],
    };
  }

  if (payload.answer === PASS) return { frames: [frame("endTurn", {})] };

  const [actionId = "", targetId = ""] = payload.answer.split(SEPARATOR);
  const action = findAction(actor, actionId, context);
  const targets = resolveTargets(targetId, action, actor, state);
  const result = resolveAction(action, actor, targets, context);
  return {
    events: [...payCosts(action, actor), ...(result.events ?? [])],
    frames: [
      ...(result.frames ?? []),
      CHECK_END,
      frame("afterAction", { actor: actor.id }),
    ],
  };
}

export { TakeActionSchema };

const AttackSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
});

function attackBonus(
  resolution: Extract<Resolution, { kind: "attack" }>,
  stats: Stats,
): number {
  const { attack } = resolution;
  if (attack.flatBonus !== undefined) return attack.flatBonus;
  if (attack.type === "spell") {
    return (
      stats.proficiency +
      (stats.spellAbility ? modifierFor(stats, stats.spellAbility) : 0)
    );
  }
  return (
    stats.proficiency +
    (attack.ability ? modifierFor(stats, attack.ability) : 0)
  );
}

// Reports whether a reaction could still change the result of this attack.
function reactionFor(
  target: Actor,
  total: number,
  ac: number,
  context: Context,
): KnownAction | null {
  if (!target.budget.reaction || isDown(target)) return null;
  const stats = deriveStats(target, context);
  return (
    stats.actions.find((action) => {
      const { activation } = action;
      if (!activation.trigger || !canAfford(action, target, stats))
        return false;
      const { resolution } = activation;
      if (resolution.kind !== "automatic") return false;
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

export function runAttackRoll(
  payload: z.infer<typeof AttackSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const attacker = actorOf(state, payload.attacker);
  let target = actorOf(state, payload.target);
  if (isDead(attacker) || isDown(attacker)) return {};

  // A later attack in a multiattack moves on if its first target has already fallen.
  if (isDown(target)) {
    const next = enemies(state, attacker).find((item) => !isDown(item));
    if (!next) return {};
    target = next;
  }

  const action = findAction(attacker, payload.actionId, context);
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  const stats = deriveStats(attacker, context);
  const advantage = hasFlag(attacker, "advantage", "attacks");
  const disadvantage = hasFlag(attacker, "disadvantage", "attacks");
  const roll = rollD20(dice, { advantage, disadvantage });
  const hadAdvantage = advantage && !disadvantage;
  const total =
    roll.natural +
    attackBonus(resolution, stats) +
    rollBonus(attacker, "attacks", context);
  const ac = deriveStats(target, context).ac;
  const critical = roll.natural === 20;
  const hits = critical || (roll.natural !== 1 && total >= ac);

  const report = dndEvent(`${NS}:rollReported`, {
    actor: attacker.id,
    against: target.id,
    natural: roll.natural,
    total,
    target: ac,
    success: hits,
    label: action.name,
  });
  const hit = {
    attacker: attacker.id,
    actionId: action.id,
    target: target.id,
    critical,
    hadAdvantage,
    total,
    natural: roll.natural,
  };

  if (!hits) return { events: [report] };

  const reaction = critical ? null : reactionFor(target, total, ac, context);
  if (reaction) {
    return {
      events: [report],
      frames: [
        awaitDecision({
          id: `${NS}:reaction:${target.id}`,
          actor: target.id,
          prompt: `${attacker.name} hits ${target.name} with ${action.name}. React?`,
          options: [
            { id: reaction.id, label: reaction.name },
            { id: "decline", label: "Take the hit" },
          ],
          resume: frame("afterReaction", hit),
        }),
      ],
    };
  }
  return { events: [report], frames: [frame("applyHit", hit)] };
}

export { AttackSchema };

const HitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  hadAdvantage: z.boolean(),
  total: z.number(),
  natural: z.number(),
});

const ReactionSchema = HitSchema.extend({ answer: z.string() });

export function runAfterReaction(
  payload: z.infer<typeof ReactionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const { answer, ...hit } = payload;
  if (answer === "decline") return { frames: [frame("applyHit", hit)] };

  const target = actorOf(state, payload.target);
  const action = findAction(target, answer, context);
  const result = resolveAction(action, target, [target], context);
  // The rest of the attack is held here and rechecked once the reaction has taken effect.
  return {
    events: [...payCosts(action, target), ...(result.events ?? [])],
    frames: [...(result.frames ?? []), frame("recheckHit", hit)],
  };
}

export { ReactionSchema, HitSchema };

export function runRecheckHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const ac = deriveStats(actorOf(context.state, payload.target), context).ac;
  return payload.total >= ac ? { frames: [frame("applyHit", payload)] } : {};
}

export function runApplyHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const action = findAction(attacker, payload.actionId, context);
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  const stats = deriveStats(attacker, context);
  const multiplier = payload.critical ? 2 : 1;
  const responses = damageResponses(target);

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
      (item) => item.id !== attacker.id && !isDown(item),
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

  resolution.damage.forEach(({ amount, type }, index) => {
    const rolled =
      rollAmount(amount, stats, dice, multiplier) +
      (index === 0 && type === firstType ? extra : 0);
    const final = finalDamage(Math.max(0, rolled), type, responses);
    totalDealt += final;
  });

  if (firstType) {
    events.push(
      ...damageEvents(target, totalDealt, firstType, payload.critical, context),
    );
  }
  events.push(
    ...leafEvents(resolution.onHit, action.id, attacker, target, context),
  );
  return {
    events,
    frames: [...concentrationFrame(target, totalDealt), CHECK_END],
  };
}

const ConcentrationSchema = z.object({ actor: z.string(), dc: z.number() });

export function runConcentrationSave(
  payload: z.infer<typeof ConcentrationSchema>,
  context: Context,
): SystemResult {
  const actor = actorOf(context.state, payload.actor);
  if (actor.concentratingOn === null) return {};
  // Being down ends Concentration outright, as does any failed save.
  if (isDown(actor) || !rollSave(actor, "con", payload.dc, context)) {
    return {
      events: [dndEvent(`${NS}:concentrationEnded`, { actor: actor.id })],
    };
  }
  return {};
}

export { ConcentrationSchema };

export function runCheckCombatEnd(context: Context): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const fighters = state.combat.order.map((id) => actorOf(state, id));
  const enemyStanding = fighters.some(
    (actor) => actor.side === "enemy" && !isDown(actor),
  );
  const partyStanding = fighters.some(
    (actor) => actor.side === "party" && !isDown(actor),
  );
  // The story follows the player's character, so their death ends the run even if companions win.
  const playerDead = isDead(actorOf(state, PLAYER_ACTOR));
  if (playerDead || (!partyStanding && enemyStanding)) {
    // shortcut: a party with nobody standing is defeated, even if someone could still recover.
    return { events: [{ kind: "partyDefeated" }] };
  }
  if (!enemyStanding) {
    return {
      events: [
        { kind: "encounterEnded", encounter: state.combat.encounter },
        dndEvent(`${NS}:combatEnded`, {}),
      ],
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
  const canContinue = stats.actions.some(
    (action) => !action.activation.trigger && canAfford(action, actor, stats),
  );
  return canContinue && !isDown(actor)
    ? {}
    : { events: [dndEvent(`${NS}:turnAdvanced`, {})] };
}

export function runEndTurn(context: Context): SystemResult {
  return context.state.combat
    ? { events: [dndEvent(`${NS}:turnAdvanced`, {})] }
    : {};
}

function hpFraction(actor: Actor, context: Context): number {
  return actor.hp / deriveStats(actor, context).maxHp;
}

// Simple, predictable tactics, so non-player characters never need a model: heal, attack the weakest, react when it helps.
export function choosePolicy(decision: Decision, context: Context): string {
  const { state } = context;
  const [first] = decision.options;
  if (!first) throw new Error(`${decision.id} has no options`);
  if (decision.id.startsWith(`${NS}:reaction:`)) return first.id;
  if (decision.id.startsWith(`${NS}:deathSave:`)) return first.id;

  const actor = actorOf(state, decision.actor);
  const stats = deriveStats(actor, context);
  const parsed = decision.options.flatMap((option) => {
    const [actionId = "", targetId = ""] = option.id.split(SEPARATOR);
    const action = stats.actions.find((item) => item.id === actionId);
    const target = state.actors[targetId];
    return action ? [{ option, action, target }] : [];
  });

  const heals = (action: KnownAction): boolean =>
    action.activation.resolution.kind === "automatic" &&
    action.activation.resolution.effects.some((item) => item.kind === "heal");

  const wounded = parsed
    .filter(
      ({ action, target }) =>
        heals(action) && target && hpFraction(target, context) < 0.5,
    )
    .sort((a, b) => (a.target?.hp ?? 0) - (b.target?.hp ?? 0))[0];
  if (wounded) return wounded.option.id;

  const attack = parsed
    .filter(
      ({ action, target }) =>
        target?.side !== actor.side &&
        target !== undefined &&
        !heals(action) &&
        (action.spellLevel ?? 0) === 0,
    )
    .sort((a, b) => (a.target?.hp ?? 0) - (b.target?.hp ?? 0))[0];
  if (attack) return attack.option.id;
  return decision.options.at(-1)?.id ?? first.id;
}
