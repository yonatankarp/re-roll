import {
  type ContentAccess,
  type Decision,
  type EncounterOptions,
  type Frame,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
} from "#sdk";
import { z } from "zod";
import { concentrationDc, finalDamage, halved, rollD20 } from "./rules.ts";
import type {
  Ability,
  Damage,
  Duration,
  LeafEffect,
  Resolution,
  Targeting,
} from "./schemas.ts";
import { ClassSchema, MonsterSchema, PregenSchema } from "./schemas.ts";
import {
  type Actor,
  type DndState,
  NS,
  INCAPACITATING,
  applyDndEvent,
  dndEvent,
  freshActor,
  hasCondition,
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
  passiveModifiers,
  rollAmount,
  rollDiceNotation,
  scaleActivation,
} from "./stats.ts";

export type Context = SystemContext<DndState>;

export const PASS = "pass";
export const CREATE_CHARACTER = "create";
const FLEE = "flee";
export const HIT_DICE = "hitDice";
const DEATH_SAVE = "deathSave";
const SEPARATOR = "|";
const ALL = "all"; // an area takes everyone, and projectiles go for the lowest HP
const DECLINE = "decline";

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
  on: "attacks" | "saves" | "checks" | "attacksAgainst",
  stats: Stats,
): boolean {
  return [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
  ].some((modifier) => modifier.kind === kind && modifier.on === on);
}

function hasPassive(
  stats: Stats,
  kind: "packTactics" | "undeadFortitude" | "magicResistance",
): boolean {
  return stats.passives.some((passive) => passive.kind === kind);
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
  const stats = deriveStats(actor, context);
  for (const modifier of passiveModifiers(stats.passives)) {
    if (modifier.kind === "bonus" && modifier.to === to) {
      total += rollAmount(modifier.amount, stats, context.dice);
    }
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

// A spell can use a slot of its own level or higher, which is also how Pact Magic casts low spells.
function slotToSpend(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): number | null {
  const lowest = action.spellLevel ?? 1;
  for (let level = lowest; level <= stats.slots.length; level += 1) {
    const spent = actor.resourcesSpent[`slot:${String(level)}`] ?? 0;
    if (spent < (stats.slots[level - 1] ?? 0)) return level;
  }
  return null;
}

// The higher slots worth offering: ones above the slot the spell would use anyway, if the spell gains from them.
function upcastSlots(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): readonly number[] {
  const lowest = slotToSpend(action, actor, stats);
  if (!action.upcast || lowest === null) return [];
  return stats.slots.flatMap((count, index) => {
    const level = index + 1;
    return level > lowest &&
      (actor.resourcesSpent[`slot:${String(level)}`] ?? 0) < count
      ? [level]
      : [];
  });
}

function withUpcasts(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
  target: string,
  label: string,
): { id: string; label: string }[] {
  const id = `${action.id}${SEPARATOR}${target}`;
  return [
    { id, label },
    ...upcastSlots(action, actor, stats).map((slot) => ({
      id: `${id}${SEPARATOR}${String(slot)}`,
      label: `${label} (level ${String(slot)} slot)`,
    })),
  ];
}

// A Charmed creature can't target its charmer with attacks or harmful magic.
function charmersOf(actor: Actor): ReadonlySet<string> {
  return new Set(
    actor.activeEffects.flatMap(({ modifier, casterId }) =>
      modifier.kind === "condition" && modifier.condition === "charmed"
        ? [casterId]
        : [],
    ),
  );
}

function fitsType(
  item: Actor,
  targeting: Targeting,
  access: ContentAccess,
): boolean {
  if ("self" in targeting || !targeting.creatureTypes) return true;
  return targeting.creatureTypes.includes(
    deriveStats(item, access).creatureType ?? "",
  );
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
    if (cost === "slot") return slotToSpend(action, actor, stats) !== null;
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
  if (hasCondition(actor, ...INCAPACITATING)) {
    return [{ id: PASS, label: "End your turn" }];
  }
  const stats = deriveStats(actor, access);
  const options: { id: string; label: string }[] = [];
  const charmers = charmersOf(actor);
  const living = (list: readonly Actor[]): readonly Actor[] =>
    list.filter((item) => !isDead(item));

  for (const action of stats.actions) {
    const { activation } = action;
    if (activation.trigger || !canAfford(action, actor, stats)) continue;
    const { targeting } = activation;
    const add = (target: string, label: string): void => {
      options.push(...withUpcasts(action, actor, stats, target, label));
    };
    if ("self" in targeting) {
      add(actor.id, action.name);
      continue;
    }
    const candidates = living(
      targeting.side === "enemy"
        ? enemies(state, actor).filter(
            (item) => !isDown(item) && !charmers.has(item.id),
          )
        : allies(state, actor),
    ).filter((item) => fitsType(item, targeting, access));
    if (targeting.creatureTypes && candidates.length === 0) continue;
    if ("area" in targeting || targeting.creatures > 1) {
      // shortcut: with no positions until step 6, an area or multi-target choice takes everyone it can.
      add(ALL, action.name);
    } else {
      for (const target of candidates) {
        add(
          target.id,
          `${action.name}: ${target.name} (${String(target.hp)} HP)`,
        );
      }
      if ((activation.projectiles ?? 1) > 1) {
        add(ALL, `${action.name}: lowest HP first`);
      }
    }
  }
  // shortcut: fleeing always works and costs nothing, until the grid in step 6 can give it opportunity attacks.
  if (actor.id === PLAYER_ACTOR && state.combat?.canFlee) {
    options.push({ id: FLEE, label: "Flee the fight" });
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
    options.push({ id: CREATE_CHARACTER, label: "Create a new character" });
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
    readonly forPartySize?: number | undefined;
  },
  context: Context,
  { canFlee, defeatContinues }: EncounterOptions,
): SystemResult {
  const party = Object.values(context.state.actors).filter(
    (actor) => actor.side === "party" && !isDead(actor),
  );
  const { forPartySize } = encounter;
  const monsters: Actor[] = [];
  for (const { monster, count: written } of encounter.monsters) {
    const count = forPartySize
      ? Math.max(1, Math.round((written * party.length) / forPartySize))
      : written;
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
        ...(canFlee ? { canFlee } : {}),
        ...(defeatContinues ? { defeatContinues } : {}),
      }),
    ],
  };
}

function payCosts(
  action: KnownAction,
  actor: Actor,
  context: Context,
  slotLevel?: number,
): SystemEvent[] {
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
          resource: `slot:${String(slotLevel ?? slotToSpend(action, actor, deriveStats(actor, context)) ?? action.spellLevel ?? 1)}`,
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
  if (
    target.hp > 0 &&
    remaining >= 0 &&
    !critical &&
    type !== "radiant" &&
    hasPassive(deriveStats(target, context), "undeadFortitude") &&
    rollSave(target, "con", 5 + amount, context)
  ) {
    return [
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: amount - remaining - 1,
        type,
        critical,
        massive: false,
      }),
    ];
  }
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

// Several hits on one target, reported in turn so each one sees the HP the last one left.
function dealEvents(
  target: Actor,
  hits: readonly { readonly amount: number; readonly type: Damage["type"] }[],
  critical: boolean,
  context: Context,
): { events: SystemEvent[]; dealt: number } {
  let { state } = context;
  const events: SystemEvent[] = [];
  let dealt = 0;
  for (const { amount, type } of hits) {
    const current = state.actors[target.id] ?? target;
    for (const event of damageEvents(
      current,
      amount,
      type,
      critical,
      context,
    )) {
      events.push(event);
      if (state.actors[target.id]) state = applyDndEvent(state, event);
    }
    dealt += Math.max(0, amount);
  }
  return { events, dealt };
}

// shortcut: a timed spell lasts until the effect is removed some other way, since nothing tracks minutes yet.
export function effectEnds(
  duration: Duration,
): "concentration" | "casterNextTurn" | "casterNextTurnEnd" | "spellDuration" {
  if (typeof duration !== "object") return "casterNextTurn";
  if ("until" in duration) {
    return duration.until === "yourNextTurnEnd"
      ? "casterNextTurnEnd"
      : "casterNextTurn";
  }
  return "concentration" in duration ? "concentration" : "spellDuration";
}

function leafEvents(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
  target: Actor,
  context: Context,
  save?: { readonly ability: Ability; readonly dc: number },
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
              ends: effectEnds(effect.duration),
            },
          }),
        );
        break;
      case "applyCondition":
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              modifier: { kind: "condition", condition: effect.condition },
              ends: effectEnds(effect.duration),
              ...(effect.repeatSave && save ? { repeatSave: save } : {}),
              ...(effect.endsOnDamage ? { endsOnDamage: true } : {}),
            },
          }),
        );
        // Being Incapacitated ends Concentration.
        if (
          INCAPACITATING.includes(effect.condition) &&
          target.concentratingOn !== null
        ) {
          events.push(
            dndEvent(`${NS}:concentrationEnded`, { actor: target.id }),
          );
        }
        break;
      case "removeCondition":
        events.push(
          dndEvent(`${NS}:conditionRemoved`, {
            actor: target.id,
            condition: effect.condition,
          }),
        );
        break;
      case "extraAction":
        events.push(dndEvent(`${NS}:actionRegained`, { actor: target.id }));
        break;
      case "forcedMove":
      case "note":
      case "reduceDamage":
        // shortcut: forced movement needs the grid in step 6, and a note is only for reading.
        // Reduced damage is worked out by the reaction that holds up the hit.
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
  magical = false,
): boolean {
  if (
    (ability === "str" || ability === "dex") &&
    hasCondition(target, "paralyzed", "petrified", "stunned", "unconscious")
  ) {
    return false;
  }
  const stats = deriveStats(target, context);
  const roll = rollD20(context.dice, {
    advantage:
      hasFlag(target, "advantage", "saves", stats) ||
      (magical && hasPassive(stats, "magicResistance")),
    disadvantage:
      hasFlag(target, "disadvantage", "saves", stats) ||
      (ability === "dex" && hasCondition(target, "restrained")),
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
  context: Context,
): readonly Actor[] {
  const { state } = context;
  const { targeting } = action.activation;
  if ("self" in targeting) return [actor];
  const chosen = answerTarget === ALL ? [] : [actorOf(state, answerTarget)];
  const pool = (
    targeting.side === "enemy" ? enemies(state, actor) : allies(state, actor)
  ).filter(
    (item) =>
      !isDead(item) &&
      fitsType(item, targeting, context) &&
      !chosen.includes(item),
  );
  if ("area" in targeting) return chosen.length > 0 ? chosen : pool;
  // A higher slot can add targets to a single-target spell, and they go to the weakest after the one chosen.
  return [...chosen, ...[...pool].sort((a, b) => a.hp - b.hp)].slice(
    0,
    targeting.creatures,
  );
}

// A cast keeps its slot level in the frames it leaves behind, so later steps roll the same dice.
function findAction(
  actor: Actor,
  id: string,
  context: Context,
  slotLevel?: number,
): KnownAction {
  const action = deriveStats(actor, context).actions.find(
    (item) => item.id === id,
  );
  if (!action) throw new Error(`${actor.id} has no action ${id}`);
  const above = (slotLevel ?? 0) - (action.spellLevel ?? 0);
  return action.upcast
    ? {
        ...action,
        activation: scaleActivation(
          action.activation,
          action.upcast.perSlotLevel,
          above,
        ),
      }
    : action;
}

function spellSource(action: KnownAction): string {
  return action.id;
}

// Extra Attack only applies to the Attack action with a weapon, while a monster follows its stat block.
function attackRoutine(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): readonly string[] {
  const { cost, resolution } = action.activation;
  if (
    !cost.includes("action") ||
    (actor.source.kind === "character" &&
      resolution.kind === "attack" &&
      resolution.attack.type === "spell")
  ) {
    return [action.id];
  }
  return (
    stats.routines?.[action.id] ??
    Array<string>(stats.multiattack).fill(action.id)
  );
}

function resolveAction(
  action: KnownAction,
  actor: Actor,
  targets: readonly Actor[],
  context: Context,
  slotLevel?: number,
  critical = false,
): SystemResult {
  const { resolution } = action.activation;
  const stats = deriveStats(actor, context);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];

  const usesConcentration = (effects: readonly LeafEffect[]): boolean =>
    effects.some(
      (effect) =>
        (effect.kind === "modifier" || effect.kind === "applyCondition") &&
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
    const result = dealEvents(
      target,
      damage.map(({ total, type }) => ({
        amount: finalDamage(
          scale(total),
          type,
          damageResponses(target, context),
        ),
        type,
      })),
      false,
      context,
    );
    events.push(...result.events);
    frames.push(...concentrationFrame(target, result.dealt));
  };

  const rollSharedDamage = (list: readonly Damage[]) =>
    list.map(({ amount, type }) => ({
      total: rollAmount(amount, stats, context.dice, critical ? 2 : 1),
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
        const saved = rollSave(
          target,
          resolution.ability,
          dc,
          context,
          action.spellLevel !== null,
        );
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
            { ability: resolution.ability, dc },
          ),
        );
      }
      break;
    }
    case "attack": {
      for (const target of targets) {
        for (const actionId of attackRoutine(action, actor, stats)) {
          frames.push(
            frame("attackRoll", {
              attacker: actor.id,
              actionId,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
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
  if (payload.answer === FLEE) return { events: combatEnded(state, "flee") };

  const [actionId = "", targetId = "", slot] = payload.answer.split(SEPARATOR);
  const known = findAction(actor, actionId, context);
  const usesSlot = known.activation.cost.includes("slot");
  const slotLevel = !usesSlot
    ? undefined
    : slot === undefined
      ? (slotToSpend(known, actor, deriveStats(actor, context)) ?? undefined)
      : Number(slot);
  const action = findAction(actor, actionId, context, slotLevel);
  const { projectiles, resolution } = action.activation;
  const result: SystemResult =
    projectiles !== undefined && resolution.kind !== "save"
      ? {
          frames: Array.from({ length: projectiles }, () =>
            frame(resolution.kind === "attack" ? "attackRoll" : "projectile", {
              attacker: actor.id,
              actionId,
              target: targetId,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          ),
        }
      : resolveAction(
          action,
          actor,
          resolveTargets(targetId, action, actor, context),
          context,
          slotLevel,
        );
  return {
    events: [
      ...payCosts(action, actor, context, slotLevel),
      ...(result.events ?? []),
    ],
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
  slotLevel: z.number().optional(),
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
      .filter((item) => !charmers.has(item.id))
      .sort((a, b) => a.hp - b.hp)[0];
  }
  const aimed = actorOf(state, id);
  return isDown(aimed) ? standing[0] : aimed;
}

// An automatic hit such as a Magic Missile dart: all of them land, one at a time against current HP.
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

function isMelee(action: KnownAction): boolean {
  const { targeting } = action.activation;
  return (
    "creatures" in targeting &&
    (targeting.range === "touch" ||
      (typeof targeting.range === "number" && targeting.range <= 5))
  );
}

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
  // shortcut: with no positions, any other ally who can act counts as within 5 feet for Pack Tactics.
  const packed =
    hasPassive(stats, "packTactics") &&
    allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id &&
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING),
    );
  // shortcut: with no positions until step 6, every attack counts as close enough for Prone's Advantage.
  const advantage =
    packed ||
    hasFlag(attacker, "advantage", "attacks", stats) ||
    hasFlag(target, "advantage", "attacksAgainst", targetStats) ||
    hasCondition(attacker, "invisible") ||
    hasCondition(
      target,
      "blinded",
      "paralyzed",
      "petrified",
      "prone",
      "restrained",
      "stunned",
      "unconscious",
    );
  const disadvantage =
    hasFlag(attacker, "disadvantage", "attacks", stats) ||
    hasFlag(target, "disadvantage", "attacksAgainst", targetStats) ||
    hasCondition(
      attacker,
      "blinded",
      "frightened",
      "poisoned",
      "prone",
      "restrained",
    ) ||
    hasCondition(target, "invisible");
  const roll = rollD20(dice, { advantage, disadvantage });
  const hadAdvantage = advantage && !disadvantage;
  const total =
    roll.natural +
    attackBonus(resolution, stats) +
    rollBonus(attacker, "attacks", context);
  const { ac } = targetStats;
  const hits = roll.natural === 20 || (roll.natural !== 1 && total >= ac);
  // A hit from within 5 feet on a Paralyzed or Unconscious target is a Critical Hit.
  const critical =
    roll.natural === 20 ||
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
    ...onceEnded(attacker, "attacks"),
    ...onceEnded(target, "attacksAgainst"),
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
  };

  if (!hits) return { events: [report, ...spent] };

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
  return { events: [report, ...spent], frames: [frame("applyHit", hit)] };
}

function onceEnded(
  actor: Actor,
  on: "attacks" | "attacksAgainst",
): SystemEvent[] {
  return actor.activeEffects.flatMap(({ modifier, sourceId }) =>
    (modifier.kind === "advantage" || modifier.kind === "disadvantage") &&
    modifier.on === on &&
    modifier.once
      ? [dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId })]
      : [],
  );
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
  slotLevel: z.number().optional(),
  halve: z.boolean().optional(), // set by a reaction like Uncanny Dodge
  reduceBy: z.number().optional(), // set by a reaction like Deflect Attacks
});

const ReactionSchema = HitSchema.extend({ answer: z.string() });

export function runAfterReaction(
  payload: z.infer<typeof ReactionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const { answer, ...hit } = payload;
  if (answer === DECLINE) return { frames: [frame("applyHit", hit)] };

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
        ...(reduceBy > 0 ? { reduceBy } : {}),
      }),
    ],
  };
}

export { ReactionSchema, HitSchema };

export function runRecheckHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const ac = deriveStats(actorOf(context.state, payload.target), context).ac;
  return payload.critical || payload.total >= ac
    ? { frames: [frame("applyHit", payload)] }
    : {};
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
  const responses = damageResponses(target, context);

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
      (index === 0 && type === firstType
        ? extra + damageBonus(attacker, resolution, stats, context)
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
  const dealt = dealEvents(
    target,
    lessenHits(hits, payload),
    payload.critical,
    context,
  );
  events.push(
    ...dealt.events,
    ...leafEvents(resolution.onHit, action.id, attacker, target, context),
  );
  return {
    events,
    frames: [
      ...concentrationFrame(target, dealt.dealt),
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
      CHECK_END,
    ],
  };
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
        ? total + rollAmount(modifier.amount, stats, context.dice)
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

const AfterHitSchema = z.object({
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

const SmiteSchema = AfterHitSchema.extend({ answer: z.string() });

export function runSmite(
  payload: z.infer<typeof SmiteSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === DECLINE) return {};
  const { state } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const [actionId = "", , slot] = payload.answer.split(SEPARATOR);
  const known = findAction(attacker, actionId, context);
  const slotLevel =
    slot === undefined
      ? (slotToSpend(known, attacker, deriveStats(attacker, context)) ??
        undefined)
      : Number(slot);
  const action = findAction(attacker, actionId, context, slotLevel);
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

export { AfterHitSchema, SmiteSchema };

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

function combatEnded(
  state: DndState,
  outcome?: "defeat" | "flee",
): SystemEvent[] {
  return [
    {
      kind: "encounterEnded",
      encounter: state.combat?.encounter ?? "",
      ...(outcome ? { outcome } : {}),
    },
    dndEvent(`${NS}:combatEnded`, {}),
  ];
}

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
    return !playerDead && state.combat.defeatContinues
      ? { events: combatEnded(state, "defeat") }
      : { events: [{ kind: "partyDefeated" }] };
  }
  if (!enemyStanding) return { events: combatEnded(state) };
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
  return canContinue &&
    !isDown(actor) &&
    !hasCondition(actor, ...INCAPACITATING)
    ? {}
    : endOfTurn(context);
}

function currentActor(state: DndState): Actor | undefined {
  const actorId = state.combat?.order[state.combat.index];
  return actorId === undefined ? undefined : state.actors[actorId];
}

// One frame per source, as the same spell from two casters doesn't stack and a creature saves only once a turn.
// shortcut: with no map, everyone a zone was cast on stays in it until the effect ends.
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

const LingeringSchema = z.object({
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
  const saved = save
    ? rollSave(
        target,
        save.ability,
        evaluateFormula(save.dc, stats),
        context,
        effect.sourceId.startsWith("spell:"),
      )
    : false;
  const scale = (amount: number): number => {
    if (!saved || save?.onSuccess === "full") return amount;
    return save?.onSuccess === "half" ? halved(amount) : 0;
  };
  const responses = damageResponses(target, context);
  const { events, dealt } = dealEvents(
    target,
    damage.map(({ amount, type }) => ({
      amount: finalDamage(
        scale(rollAmount(amount, stats, dice)),
        type,
        responses,
      ),
      type,
    })),
    false,
    context,
  );
  if (once || (saved && save?.endsEffect)) {
    events.push(
      dndEvent(`${NS}:effectEnded`, {
        actor: target.id,
        sourceId: effect.sourceId,
      }),
    );
  }
  return { events, frames: [...concentrationFrame(target, dealt), CHECK_END] };
}

export { LingeringSchema };

// A monster killed by something at the start of its own turn has no turn to take.
export function runAfterTurnStart(context: Context): SystemResult {
  const actor = currentActor(context.state);
  return actor && isDead(actor) ? endOfTurn(context) : {};
}

function endOfTurn(context: Context): SystemResult {
  const actor = currentActor(context.state);
  const ticks =
    actor && !isDead(actor) ? lingeringFrames(actor, "turnEnd") : [];
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
    actor && effect.repeatSave && !isDown(actor)
      ? [{ actor, sourceId: effect.sourceId, save: effect.repeatSave }]
      : [],
  );
  const seen = new Set<string>();
  const events = repeated.flatMap(({ actor: target, sourceId, save }) => {
    if (seen.has(sourceId)) return [];
    seen.add(sourceId);
    return rollSave(
      target,
      save.ability,
      save.dc,
      context,
      sourceId.startsWith("spell:"),
    )
      ? [dndEvent(`${NS}:effectEnded`, { actor: target.id, sourceId })]
      : [];
  });
  const finished = [
    ...events,
    ...(actor ? rechargeEvents(actor, context) : []),
    dndEvent(`${NS}:turnAdvanced`, {}),
  ];
  // Look ahead through the same events, so nothing happens at all unless the next creature has a start-of-turn effect.
  let after = state;
  for (const event of finished) after = applyDndEvent(after, event);
  const next = currentActor(after);
  const ticks = next ? lingeringFrames(next, "turnStart") : [];
  return ticks.length > 0
    ? { events: finished, frames: [...ticks, frame("afterTurnStart", {})] }
    : { events: finished };
}

// shortcut: the roll happens at the end of the monster's turn rather than the start of its next one,
// which gives the same chance, as nothing else can change it in between.
function rechargeEvents(actor: Actor, context: Context): SystemEvent[] {
  if (actor.source.kind !== "monster") return [];
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

// Companions spend hit dice until healed. The player chooses die by die, in rest.ts.
export function shortRestEvents(
  context: Context,
  skip?: string,
): SystemEvent[] {
  return Object.values(context.state.actors).flatMap((actor) => {
    if (actor.side !== "party" || isDead(actor) || actor.id === skip) return [];
    if (actor.source.kind !== "character" || !actor.source.build) return [];
    const stats = deriveStats(actor, context);
    const events: SystemEvent[] = [];
    let { hp } = actor;
    for (const { classId } of actor.source.build.levels.slice(
      actor.resourcesSpent[HIT_DICE] ?? 0,
    )) {
      if (hp >= stats.maxHp) break;
      const die = lookup(context, ClassSchema, classId).hitDie;
      const rolled = rollDiceNotation(`1${die}`, context.dice);
      const amount = Math.min(
        Math.max(1, rolled + modifierFor(stats, "con")),
        stats.maxHp - hp,
      );
      hp += amount;
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: HIT_DICE,
        }),
        dndEvent(`${NS}:healed`, { actor: actor.id, amount, max: stats.maxHp }),
      );
    }
    return events;
  });
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
    const [actionId = "", targetId = "", slot] = option.id.split(SEPARATOR);
    const action = stats.actions.find((item) => item.id === actionId);
    const target = state.actors[targetId];
    return action ? [{ option, action, target, targetId, slot }] : [];
  });

  const heals = (action: KnownAction): boolean =>
    action.activation.resolution.kind === "automatic" &&
    action.activation.resolution.effects.some((item) => item.kind === "heal");

  // Slots go on fights that need them: the enemies left must outlast the caster's own HP, and a healer keeps its last slot.
  const foesHp = enemies(state, actor)
    .filter((item) => !isDown(item))
    .reduce((total, item) => total + item.hp, 0);
  const slotsLeft = stats.slots.reduce(
    (total, count, index) =>
      total +
      Math.max(
        0,
        count - (actor.resourcesSpent[`slot:${String(index + 1)}`] ?? 0),
      ),
    0,
  );
  const healer = stats.actions.some(
    (action) => (action.spellLevel ?? 0) > 0 && heals(action),
  );
  const spendsSlot = foesHp > stats.maxHp && slotsLeft > (healer ? 1 : 0);

  if (decision.id.startsWith(`${NS}:afterHit:`)) {
    return spendsSlot ? first.id : DECLINE;
  }

  const wounded = parsed
    .filter(
      ({ action, target }) =>
        heals(action) && target && hpFraction(target, context) < 0.5,
    )
    .sort((a, b) => (a.target?.hp ?? 0) - (b.target?.hp ?? 0))[0];
  if (wounded) return wounded.option.id;

  const foes = enemies(state, actor).filter((item) => !isDown(item));
  const areas = parsed.filter(
    ({ action, target }) =>
      !target &&
      !heals(action) &&
      action.spellLevel === null &&
      "area" in action.activation.targeting &&
      action.activation.targeting.side === "enemy",
  );
  // A monster's area attack, such as a breath weapon, is its strongest choice while it's ready. One with no recharge
  // has to catch more than one foe to beat attacking, and one that only applies a condition waits until at least
  // half the foes are free of it, as repeating it on the rest would waste the turn.
  const blast = areas.find(({ action }) => {
    const { cost, resolution } = action.activation;
    if ("damage" in resolution && resolution.damage.length > 0) {
      return foes.length > 1 || cost.some((item) => typeof item === "object");
    }
    const applied = (
      resolution.kind === "save" ? resolution.onFail : []
    ).flatMap((item) =>
      item.kind === "applyCondition" ? [item.condition] : [],
    );
    const free = foes.filter((item) => !hasCondition(item, ...applied));
    return free.length > 0 && free.length * 2 >= foes.length;
  });
  if (blast) return blast.option.id;

  // One slot a turn, on a spell that's still doing nothing: never a second Concentration or the same buff twice.
  const freshTurn = actor.budget.action && actor.budget.bonusAction;
  const slotSpell = parsed
    .filter(({ action, target, slot }) => {
      const { activation, spellLevel } = action;
      if (slot !== undefined || (spellLevel ?? 0) === 0) return false;
      if (heals(action) || !activation.cost.includes("slot")) return false;
      const { resolution } = activation;
      const leaves =
        resolution.kind === "automatic"
          ? resolution.effects
          : resolution.kind === "save"
            ? resolution.onFail
            : resolution.onHit;
      const concentrates = leaves.some(
        (item) =>
          "duration" in item &&
          typeof item.duration === "object" &&
          "concentration" in item.duration,
      );
      if (concentrates && actor.concentratingOn !== null) return false;
      const lasting = leaves.some(
        (item) => item.kind === "modifier" || item.kind === "applyCondition",
      );
      const harms = "damage" in resolution && resolution.damage.length > 0;
      if (!harms && !lasting) return false;
      const side =
        "side" in activation.targeting && activation.targeting.side === "enemy"
          ? enemies(state, actor)
          : allies(state, actor);
      const aimedAt = target ? [target] : side;
      return !(
        !harms &&
        aimedAt.some((item) =>
          item.activeEffects.some((effect) => effect.sourceId === action.id),
        )
      );
    })
    .sort(
      (a, b) =>
        Number("area" in b.action.activation.targeting) -
          Number("area" in a.action.activation.targeting) ||
        (b.action.spellLevel ?? 0) - (a.action.spellLevel ?? 0),
    )[0];
  if (spendsSlot && freshTurn && slotSpell) return slotSpell.option.id;

  const attack = parsed
    .filter(
      ({ action, target }) =>
        target?.side !== actor.side &&
        target !== undefined &&
        !heals(action) &&
        (action.spellLevel ?? 0) === 0,
    )
    .sort(
      (a, b) =>
        (a.target?.hp ?? 0) - (b.target?.hp ?? 0) ||
        attackRoutine(b.action, actor, stats).length -
          attackRoutine(a.action, actor, stats).length,
    )[0];
  if (attack) return attack.option.id;
  const lastResort = areas.find(
    ({ action: { activation } }) =>
      "damage" in activation.resolution &&
      activation.resolution.damage.length > 0,
  );
  if (lastResort) return lastResort.option.id;

  // With the Attack action spent: Action Surge when the fight is still on, and a monster's free trick like Nimble Escape.
  const extra = parsed.find(({ action, target }) => {
    const { cost, resolution } = action.activation;
    if (target?.id !== actor.id || heals(action)) return false;
    return resolution.kind === "automatic" &&
      resolution.effects.some((item) => item.kind === "extraAction")
      ? foesHp > stats.maxHp && !actor.budget.action
      : actor.source.kind === "monster" && cost.includes("bonusAction");
  });
  if (extra) return extra.option.id;
  return decision.options.at(-1)?.id ?? first.id;
}
