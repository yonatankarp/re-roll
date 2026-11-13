import {
  damageResponses,
  deriveStats,
  evaluateFormula,
  immuneToCondition,
  type KnownAction,
  lookup,
  modifierFor,
  rollAmount,
  saveBonus,
} from "../stats.ts";
import { metamagicSaves } from "../metamagic.ts";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDead,
  NS,
  frame,
} from "../state.ts";
import {
  type ContentAccess,
  type Frame,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { concentrationDc, finalDamage, halved, rollD20 } from "../rules.ts";
import {
  type Ability,
  type Damage,
  type Duration,
  type LeafEffect,
  MonsterSchema,
} from "../schemas.ts";
import { multiattackUses } from "../multiattack-uses.ts";
import { dropToOneEvents, traitSaveAdvantage } from "../trait-rules.ts";
import { dodging } from "../tactics.ts";
import { AIM, ALL } from "./ids.ts";
import { inArea, parseSquare, pushTo, type Square } from "../grid.ts";
import { caughtBy } from "../targeting.ts";
import { behindTotalCover, coverAgainst, coverFor } from "../sight.ts";
import { teleportFrame } from "./movement.ts";
import { conditionsApplied, legendaryResistance } from "../legendary.ts";
import { insideDamageEvents } from "./swallow.ts";
import { cureFor, dispelEvents, isSpell, snuffedLights } from "./dispel.ts";
import { formOf, weakestBeast } from "../forms.ts";
import {
  actorOf,
  allies,
  areaPool,
  attackRoutine,
  type Context,
  enemies,
  fitsType,
  hasFlag,
  hasPassive,
  reaches,
  rollBonus,
  slotToSpend,
  spellSource,
} from "./queries.ts";

// What an action does once it lands: paying its costs, saving throws, damage, conditions and the other effects.

export function payCosts(
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

export function concentrationFrame(
  target: Actor,
  amount: number,
): readonly Frame[] {
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
// The difficulty setting scales the damage the party takes, and only that, so the books' monsters keep
// their numbers: Story takes a third of it, Hard adds half again.
export const DAMAGE_TO_PARTY = { story: 1 / 3, normal: 1, hard: 1.5 } as const;

function scaledForParty(
  target: Actor,
  amount: number,
  state: DndState,
): number {
  if (target.side !== "party" || amount <= 0) return amount;
  const factor = DAMAGE_TO_PARTY[state.difficulty ?? "normal"];
  return Math.max(1, Math.round(amount * factor));
}

export function damageEvents(
  target: Actor,
  rolled: number,
  type: Damage["type"],
  critical: boolean,
  context: Context,
): SystemEvent[] {
  const amount = scaledForParty(target, rolled, context.state);
  if (amount <= 0) return [];
  // Damage left over after reaching 0 HP kills a character if it's at least their maximum.
  const remaining = amount - target.tempHp - Math.max(0, target.hp);
  const fortitude =
    target.hp > 0 &&
    remaining >= 0 &&
    !critical &&
    type !== "radiant" &&
    hasPassive(deriveStats(target, context), "undeadFortitude")
      ? rollSave(target, "con", 5 + amount, context)
      : null;
  if (fortitude?.saved) {
    return [
      ...fortitude.events,
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: amount - remaining - 1,
        type,
        critical,
        massive: false,
      }),
    ];
  }
  const endured = fortitude
    ? null
    : dropToOneEvents(
        target,
        amount,
        remaining,
        { type, critical },
        deriveStats(target, context),
      );
  if (endured) return endured;
  const massive =
    target.side === "party" && remaining >= deriveStats(target, context).maxHp;
  const events: SystemEvent[] = [
    ...(fortitude?.events ?? []),
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
export function dealEvents(
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
    dealt += Math.max(0, scaledForParty(target, amount, context.state));
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

export function leafEvents(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
  target: Actor,
  context: Context,
  save?: { readonly ability: Ability; readonly dc: number },
  slotLevel?: number, // the slot a spell was cast with, so Dispel Magic knows its level
): SystemEvent[] {
  const stats = deriveStats(caster, context);
  const level = slotLevel === undefined ? {} : { level: slotLevel };
  const events: SystemEvent[] = [];
  // Taking the target out of a grapple and into the caster swallows it (combat/swallow.ts).
  const swallowed = effects.some(
    (effect) =>
      effect.kind === "removeCondition" && effect.condition === "grappled",
  )
    ? { swallowed: true }
    : {};
  // A Hit Point maximum the same spell raises counts for its healing, as with Aid.
  const raisedMax = target.activeEffects.some(
    (item) => item.sourceId === sourceId,
  )
    ? 0
    : effects.reduce(
        (sum, effect) =>
          effect.kind === "modifier" &&
          effect.modifier.kind === "bonus" &&
          effect.modifier.to === "maxHp"
            ? sum + (effect.modifier.amount.bonus?.base ?? 0)
            : sum,
        0,
      );
  for (const effect of effects) {
    switch (effect.kind) {
      case "heal": {
        const max = deriveStats(target, context).maxHp + raisedMax;
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
              ...level,
              modifier: effect.modifier,
              ends: effectEnds(effect.duration),
              ...(effect.repeatSave && save ? { repeatSave: save } : {}),
              ...swallowed,
            },
          }),
        );
        break;
      case "applyCondition": {
        if (
          immuneToCondition(deriveStats(target, context), effect.condition) ||
          (effect.hpAtMost !== undefined && target.hp > effect.hpAtMost)
        )
          break;
        const conditionSave = effect.endSave
          ? {
              ability: effect.endSave.ability,
              dc: evaluateFormula(effect.endSave.dc, stats),
            }
          : save;
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              ...level,
              modifier: { kind: "condition", condition: effect.condition },
              ends: effectEnds(effect.duration),
              ...((effect.repeatSave ||
                effect.secondFailure ||
                effect.endSave) &&
              conditionSave
                ? { repeatSave: conditionSave }
                : {}),
              ...(effect.endsOnDamage ? { endsOnDamage: true } : {}),
              ...(effect.endsOnSpell ? { endsOnSpell: true } : {}),
              ...(effect.secondFailure && conditionSave
                ? {
                    secondFailure: {
                      condition: effect.secondFailure.condition,
                      ends: effectEnds(effect.secondFailure.duration),
                      ...(effect.secondFailure.endsOnDamage
                        ? { endsOnDamage: true }
                        : {}),
                    },
                  }
                : {}),
              ...swallowed,
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
      }
      case "removeCondition":
        events.push(
          dndEvent(`${NS}:conditionRemoved`, {
            actor: target.id,
            condition: effect.condition,
          }),
        );
        break;
      case "cure": {
        const condition = cureFor(target, effect.conditions);
        if (condition) {
          events.push(
            dndEvent(`${NS}:conditionRemoved`, { actor: target.id, condition }),
          );
        }
        break;
      }
      case "polymorph": {
        const beast =
          formOf(target) === null ? weakestBeast(target, context) : null;
        if (!beast) break;
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              modifier: { kind: "form", monster: beast.id },
              ends: effectEnds(effect.duration),
            },
          }),
          dndEvent(`${NS}:tempHpGained`, {
            actor: target.id,
            amount: beast.hp,
          }),
        );
        // A Beast's shape can't keep up a spell, since it can't cast one.
        if (target.concentratingOn !== null) {
          events.push(
            dndEvent(`${NS}:concentrationEnded`, { actor: target.id }),
          );
        }
        break;
      }
      case "dispel":
        events.push(
          ...dispelEvents(target, effect.maxLevel, context.state, context),
        );
        break;
      case "extraAction":
        events.push(dndEvent(`${NS}:actionRegained`, { actor: target.id }));
        break;
      // shortcut: a push is made on the grid as Shove's is, while a pull is only described, and neither checks size.
      case "forcedMove": {
        const to =
          effect.direction === "away"
            ? pushTo(caster.position, target, effect.feet, context.state)
            : null;
        if (to) {
          events.push(
            dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 }),
          );
        }
        break;
      }
      case "note":
      case "reduceDamage":
      case "teleport":
      case "zone":
        // A note is only for reading. Reduced damage is worked out by the reaction that holds up the hit, and
        // a teleport's square by its own decision and a zone once for the whole spell (resolveAction).
        break;
      default:
        effect satisfies never;
    }
  }
  return events;
}

// The saved flag, and the roll for the history. An automatic failure rolls no die, so it has no event.
export function rollSave(
  target: Actor,
  ability: Ability,
  dc: number,
  context: Context,
  magical = false,
  cover = 0, // half or three-quarters cover adds to Dexterity saves
  conditions: readonly string[] = [],
  disadvantage = false, // from the caster, as with Heightened Spell
  advantage = false, // from the spell itself, as Modify Memory gives a foe it fights
): { readonly saved: boolean; readonly events: SystemEvent[] } {
  if (
    (ability === "str" || ability === "dex") &&
    hasCondition(target, "paralyzed", "petrified", "stunned", "unconscious")
  ) {
    return { saved: false, events: [] };
  }
  const stats = deriveStats(target, context);
  const roll = rollD20(context.dice, {
    advantage:
      advantage ||
      hasFlag(target, "advantage", "saves", stats, ability) ||
      (magical && hasPassive(stats, "magicResistance")) ||
      (ability === "dex" && dodging(target)) ||
      traitSaveAdvantage(stats, ability, conditions),
    disadvantage:
      disadvantage ||
      hasFlag(target, "disadvantage", "saves", stats, ability) ||
      (ability === "dex" && hasCondition(target, "restrained")),
    rerollOnes: hasPassive(stats, "rerollOnes"),
  });
  const total =
    roll.natural +
    saveBonus(stats, ability) +
    rollBonus(target, "saves", context) +
    (ability === "dex" ? cover : 0);
  const saved = total >= dc;
  return {
    saved,
    events: [
      dndEvent(`${NS}:saveRolled`, {
        actor: target.id,
        ability,
        natural: roll.natural,
        total,
        dc,
        success: saved,
      }),
    ],
  };
}

// The square an answer aims at ("@x,y" or "@id"), or null for one that aims at no square.
export function aimSquare(
  answerTarget: string,
  state: DndState,
): Square | null {
  if (!answerTarget.startsWith(AIM)) return null;
  const aimedAt = answerTarget.slice(AIM.length);
  return parseSquare(aimedAt) ?? state.actors[aimedAt]?.position ?? null;
}

export function resolveTargets(
  answerTarget: string,
  action: KnownAction,
  actor: Actor,
  context: ContentAccess & { readonly state: DndState },
): readonly Actor[] {
  const { state } = context;
  const { targeting } = action.activation;
  if ("self" in targeting) return [actor];
  const side = (
    targeting.side === "enemy" ? enemies(state, actor) : allies(state, actor)
  ).filter((item) => !isDead(item) && fitsType(item, targeting, context));
  if ("area" in targeting) {
    const { shape, radius } = targeting.area;
    // Aimed at a square ("@x,y") or a creature ("@id"), an area catches everyone in it, the caster's side too.
    const aim = aimSquare(answerTarget, state);
    if (aim && actor.position) {
      // Total cover from where it spreads keeps a creature out of it.
      const centre =
        shape === "sphere" || shape === "cube" ? aim : actor.position;
      return caughtBy(
        targeting,
        actor,
        aim,
        areaPool(targeting, context),
      ).filter(
        (item) =>
          item.id === actor.id ||
          coverFor(state, centre, item, [actor.id]) !== "total",
      );
    }
    // Round the caster, or with no grid: only the side it's meant for, as if placed with care.
    return side.filter((item) =>
      inArea(shape, radius, actor.position, actor.position, item.position),
    );
  }
  const chosen = answerTarget === ALL ? [] : [actorOf(state, answerTarget)];
  const pool = side.filter(
    (item) =>
      !chosen.includes(item) &&
      reaches(action, actor, item) &&
      !behindTotalCover(state, actor, item),
  );
  // A higher slot can add targets to a single-target spell, and they go to the weakest after the one chosen.
  return [...chosen, ...[...pool].sort((a, b) => a.hp - b.hp)].slice(
    0,
    targeting.creatures,
  );
}

export function resolveAction(
  action: KnownAction,
  actor: Actor,
  targets: readonly Actor[],
  context: Context,
  slotLevel?: number,
  critical = false,
  aim?: Square, // where an area was aimed, for a zone it leaves
): SystemResult {
  const { resolution } = action.activation;
  const stats = deriveStats(actor, context);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  // Another spell aimed at a creature ends what lasts only until one is, as Modify Memory's charm.
  const spellEnds = targets.flatMap((target) =>
    [
      ...new Set(
        target.activeEffects
          .filter(
            (effect) =>
              effect.endsOnSpell && effect.sourceId !== spellSource(action),
          )
          .map((effect) => effect.sourceId),
      ),
    ].map((sourceId) =>
      dndEvent(`${NS}:effectEnded`, { actor: target.id, sourceId }),
    ),
  );
  if (spellEnds.length > 0 && isSpell(action, actor, context)) {
    events.push(...spellEnds);
  }

  const usesConcentration = (effects: readonly LeafEffect[]): boolean =>
    effects.some(
      (effect) =>
        (effect.kind === "modifier" ||
          effect.kind === "applyCondition" ||
          effect.kind === "zone" ||
          effect.kind === "polymorph") &&
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
    events.push(
      ...result.events,
      ...insideDamageEvents(actor, target, result.dealt),
    );
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
      // A zone is left once, where the area was aimed or round the caster, whoever it caught.
      const at = aim ?? actor.position;
      for (const effect of resolution.effects) {
        if (effect.kind !== "zone" || !at) continue;
        if (effect.zone === "darkness") {
          events.push(...snuffedLights(at, effect.radius, context));
        }
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              sourceId: spellSource(action),
              casterId: actor.id,
              modifier: {
                kind: "zone",
                zone: effect.zone,
                at,
                radius: effect.radius,
                ...(effect.damage ? { damage: effect.damage } : {}),
              },
              ends: effectEnds(effect.duration),
            },
          }),
        );
      }
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
            undefined,
            slotLevel,
          ),
        );
        // Where it lands is chosen, as a move is.
        for (const effect of resolution.effects) {
          if (effect.kind === "teleport" && target.id === actor.id) {
            frames.push(
              teleportFrame(actor, effect.feet, effect.movement, context),
            );
          }
        }
      }
      break;
    }
    case "save": {
      beginConcentration(resolution.onFail);
      const dc = evaluateFormula(resolution.dc, stats);
      // Damage against several targets at once is rolled once for all of them.
      const damage = rollSharedDamage(resolution.damage);
      const { spared, heightened } = metamagicSaves(
        action,
        actor,
        targets,
        modifierFor(stats, "cha"),
      );
      for (const target of targets) {
        // shortcut: cover counts from the caster, even for a sphere whose centre is elsewhere.
        const { saved: rolledSave, events: saveEvents } = spared.has(target.id)
          ? { saved: true, events: [] }
          : rollSave(
              target,
              resolution.ability,
              dc,
              context,
              action.spellLevel !== null,
              coverAgainst(context.state, actor, target),
              conditionsApplied(resolution.onFail),
              heightened === target.id,
              resolution.advantage,
            );
        events.push(...saveEvents);
        const resisted = rolledSave
          ? null
          : legendaryResistance(
              target,
              conditionsApplied(resolution.onFail),
              context,
              events,
            );
        if (resisted) events.push(resisted);
        const saved = rolledSave || resisted !== null;
        applyRolled(target, damage, (amount) => {
          if (!saved || resolution.onSuccessDamage === "full") return amount;
          return resolution.onSuccessDamage === "half" && !spared.has(target.id)
            ? halved(amount)
            : 0;
        });
        events.push(
          ...leafEvents(
            saved ? resolution.onSuccess : resolution.onFail,
            spellSource(action),
            actor,
            target,
            context,
            { ability: resolution.ability, dc },
            slotLevel,
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
      frames.push(...multiattackFrames(action, actor, targets[0], context));
      break;
    }
    default:
      resolution satisfies never;
  }
  return { events, frames };
}

// A monster's Multiattack can also use another action, as "makes one Bite attack and uses Constrict" does:
// the ids of those its attack brings.
export function multiattackExtras(
  action: KnownAction,
  actor: Actor,
  context: ContentAccess,
): readonly string[] {
  if (
    actor.source.kind !== "monster" ||
    formOf(actor) !== null || // a Beast's shape has only the Beast's routine
    action.activation.resolution.kind !== "attack" ||
    !action.id.startsWith("monster:") ||
    !action.activation.cost.includes("action")
  ) {
    return [];
  }
  const monster = lookup(context, MonsterSchema, actor.source.statBlockId);
  return multiattackUses(monster, action.name);
}

// Those actions, taken once the attacks are done.
function multiattackFrames(
  action: KnownAction,
  actor: Actor,
  target: Actor | undefined,
  context: Context,
): Frame[] {
  if (!target) return [];
  return multiattackExtras(action, actor, context).map((actionId) =>
    frame("useAction", { actor: actor.id, actionId, target: target.id }),
  );
}
