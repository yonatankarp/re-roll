import {
  damageResponses,
  deriveStats,
  evaluateFormula,
  immuneToCondition,
  type KnownAction,
  lookup,
  modifierFor,
  rerollingOnes,
  rollAmount,
  saveBonus,
  type Stats,
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
  isDown,
  NS,
  frame,
} from "../state.ts";
import {
  type ContentAccess,
  type Dice,
  type Frame,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { concentrationDc, finalDamage, halved, rollD20 } from "../rules.ts";
import {
  type Ability,
  type Damage,
  type DamageType,
  type Duration,
  type LeafEffect,
  MonsterSchema,
} from "../schemas.ts";
import { multiattackUses } from "../multiattack-uses.ts";
import {
  dropToOneEvents,
  HIGHEST,
  masteredDice,
  maximized,
  masteredTypes,
  rerolledTypes,
  hitDieRoll,
  nextHitDie,
  piercing,
  interposedShield,
  evades,
  rescuedSave,
  traitSaveAdvantage,
} from "../trait-rules.ts";
import { dodging } from "../tactics.ts";
import { AIM, ALL, HIT_DICE, THROW_PREFIX, weaponItemId } from "./ids.ts";
import {
  distanceFeet,
  inArea,
  parseSquare,
  pushTo,
  type Square,
} from "../grid.ts";
import { caughtBy } from "../targeting.ts";
import { behindTotalCover, coverAgainst, coverFor } from "../sight.ts";
import { teleportFrame } from "./movement.ts";
import { summonEvents } from "./summon.ts";
import { fueledDamage } from "./school.ts";
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
  // An attack ends them once rolled, so its own roll still has their Advantage (attack.ts).
  const events: SystemEvent[] = [
    ...(action.activation.resolution.kind === "attack"
      ? []
      : actingEnds(actor, action)),
    ...kitUse(actor, action, context),
  ];
  for (const cost of action.activation.cost) {
    if (cost === "action" || cost === "bonusAction" || cost === "reaction") {
      events.push(
        dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: cost }),
      );
    } else if (cost === "slot") {
      const stats = deriveStats(actor, context);
      const level =
        slotLevel ??
        slotToSpend(action, actor, stats) ??
        action.spellLevel ??
        1;
      // Boon of Spell Recall: a d4 that matches a level 1-4 slot keeps the slot.
      const recalled =
        level <= 4 &&
        hasPassive(stats, "slotRecall") &&
        context.dice.roll(4) === level;
      if (!recalled) {
        events.push(
          dndEvent(`${NS}:resourceSpent`, {
            actor: actor.id,
            resource: `slot:${String(level)}`,
          }),
        );
      }
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

// `breaker` gives the save Disadvantage, as damage from a Mage Slayer does.
export function concentrationFrame(
  target: Actor,
  amount: number,
  breaker = false,
): readonly Frame[] {
  return target.concentratingOn !== null && amount > 0
    ? [
        frame("concentrationSave", {
          actor: target.id,
          dc: concentrationDc(amount),
          ...(breaker ? { disadvantage: true } : {}),
        }),
      ]
    : [];
}

// Reports the damage, and whatever follows from it, as events.
// The difficulty setting scales the damage the party takes, and only that, so the books' monsters keep
// their numbers: Story takes a third of it, Hard adds half again. A fight far beyond the party takes less
// still (worth.ts damageToPartyFor), set when it starts and only lowered after, as the party sees more of it
// through the fog (fog.ts).
export const DAMAGE_TO_PARTY = { story: 1 / 3, normal: 1, hard: 1.5 } as const;

export function damageToParty(state: DndState): number {
  return (
    state.combat?.damageToParty ?? DAMAGE_TO_PARTY[state.difficulty ?? "normal"]
  );
}

function scaledForParty(
  target: Actor,
  amount: number,
  state: DndState,
): number {
  if (target.side !== "party" || amount <= 0) return amount;
  return Math.max(1, Math.round(amount * damageToParty(state)));
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
// Tyro of the Gauntlet's Stand as One: an ally within 5 feet spends its Reaction to keep the target from being moved.
export function heldInPlace(
  target: Actor,
  context: Pick<Context, "state" | "content" | "contentIds">,
): SystemEvent[] {
  if (hasCondition(target, ...INCAPACITATING)) return [];
  const guard = Object.values(context.state.actors).find(
    (other) =>
      other.id !== target.id &&
      other.side === target.side &&
      other.budget.reaction &&
      !isDown(other) &&
      !hasCondition(other, ...INCAPACITATING) &&
      distanceFeet(other.position, target.position) <= 5 &&
      hasPassive(deriveStats(other, context), "standAsOne"),
  );
  return guard
    ? [
        dndEvent(`${NS}:budgetSpent`, {
          actor: guard.id,
          kind: "reaction",
          label: "Stand as One",
        }),
      ]
    : [];
}

// A Healer's Kit's ten uses: an activation that needs it carried spends one, and the last use spends the kit.
function kitUse(
  actor: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  const { carrying } = action.activation;
  const item = carrying ? context.content(carrying) : undefined;
  const uses =
    item && typeof item === "object" && "uses" in item ? Number(item.uses) : 0;
  if (!carrying || !uses) return [];
  const key = `uses:${carrying}`;
  const spent = (actor.resourcesSpent[key] ?? 0) + 1;
  return spent < uses
    ? [dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: key })]
    : [
        dndEvent(`${NS}:itemUsed`, { actor: actor.id, item: carrying }),
        dndEvent(`${NS}:resourceRestored`, { actor: actor.id, resource: key }),
      ];
}

// Boon of Erupting Spellpower: a slot spell's surge, spending its use.
// shortcut: it's used on the first slot spell that deals damage, and comes back with a rest, not on rolling Initiative.
function overloaded(
  actor: Actor,
  action: KnownAction,
  stats: Stats,
): SystemEvent | null {
  if (action.spellLevel === null) return null;
  for (const passive of stats.passives) {
    if (
      passive.kind === "spellOverload" &&
      (actor.resourcesSpent[passive.resource] ?? 0) <
        (stats.resources[passive.resource] ?? 0)
    ) {
      return dndEvent(`${NS}:resourceSpent`, {
        actor: actor.id,
        resource: passive.resource,
      });
    }
  }
  return null;
}

// Boon of Bountiful Health's Augmented Health.
export function tempHpBonus(stats: Stats): number {
  return stats.passives.reduce(
    (sum, passive) =>
      passive.kind === "tempHpBonus" ? sum + passive.amount : sum,
    0,
  );
}

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
  // Dragon Fear: damage lets the target repeat the save that ends the effect.
  const hurt = state.actors[target.id];
  // Killer's Fortune: a foe dropping gives the bearer's next attack Advantage.
  if (hurt && hurt.hp <= 0 && target.hp > 0) {
    for (const bearer of Object.values(state.actors)) {
      if (
        bearer.side === target.side ||
        isDown(bearer) ||
        !hasPassive(deriveStats(bearer, context), "killAdvantage")
      ) {
        continue;
      }
      events.push(
        dndEvent(`${NS}:effectAdded`, {
          actor: bearer.id,
          effect: {
            sourceId: "killers-fortune",
            casterId: bearer.id,
            modifier: { kind: "advantage", on: "attacks", once: true },
            ends: "casterNextTurnEnd",
          },
        }),
      );
    }
  }
  for (const effect of dealt > 0 ? (hurt?.activeEffects ?? []) : []) {
    if (!hurt || !effect.saveOnDamage) continue;
    const save = rollSave(
      hurt,
      effect.saveOnDamage.ability,
      effect.saveOnDamage.dc,
      { ...context, state },
    );
    events.push(...save.events);
    if (save.saved) {
      events.push(
        dndEvent(`${NS}:effectEnded`, {
          actor: hurt.id,
          sourceId: effect.sourceId,
          casterId: effect.casterId,
        }),
      );
    }
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

// Effects on the actor that end as it acts, or as it attacks, deals damage or forces a save, as Fade Away's
// invisibility.
export function actingEnds(
  actor: Actor,
  action: KnownAction | null, // null for an action anyone can take, such as Dash
): SystemEvent[] {
  const resolution = action?.activation.resolution;
  const harms =
    resolution !== undefined &&
    (resolution.kind !== "automatic" || resolution.damage.length > 0);
  return actor.activeEffects.flatMap(({ endsOn, sourceId, casterId }) =>
    endsOn === "action" || (endsOn === "attack" && harms)
      ? [dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId, casterId })]
      : [],
  );
}

// Riders on a creature the bearer damages with this type, as Crusher or Slasher give, from an attack or a spell.
export function damageRiders(
  attacker: Actor,
  target: Actor,
  types: ReadonlySet<DamageType>,
  critical: boolean,
  stats: Stats,
  context: Context,
  spell = false, // from a spell's damage, which only a rider with `spells` takes
): SystemEvent[] {
  return stats.passives.flatMap((passive) => {
    if (passive.kind !== "damageRider" || !types.has(passive.damage)) return [];
    if (spell && !passive.spells) return [];
    if (passive.critical && !critical) return [];
    const key = `rider:${passive.damage}:${String(passive.critical)}`;
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
    ];
  });
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
  // Healing Rerolls: a healing die that rolls 1 is rolled again.
  const healDice = hasPassive(stats, "healingRerolls")
    ? rerollingOnes(context.dice)
    : context.dice;
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
        const rolled = rollAmount(effect.amount, stats, healDice);
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
      case "hitDieHeal": {
        // shortcut: a Healer's Kit's ten uses aren't counted; the target's Hit Point Dice are the limit.
        const die = nextHitDie(target, context);
        if (!die) break;
        const max = deriveStats(target, context).maxHp;
        const rolled =
          hitDieRoll(die, deriveStats(target, context), healDice) +
          evaluateFormula(effect.bonus, stats);
        events.push(
          dndEvent(`${NS}:resourceSpent`, {
            actor: target.id,
            resource: HIT_DICE,
          }),
          dndEvent(`${NS}:healed`, {
            actor: target.id,
            amount: Math.max(0, Math.min(rolled, max - Math.max(target.hp, 0))),
            max,
          }),
        );
        break;
      }
      case "tempHp":
        events.push(
          dndEvent(`${NS}:tempHpGained`, {
            actor: target.id,
            amount:
              rollAmount(effect.amount, stats, context.dice) +
              tempHpBonus(deriveStats(target, context)),
          }),
        );
        break;
      case "dash":
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              modifier: { kind: "tactic", tactic: "dash" },
              ends: "casterNextTurn",
            },
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
          target.activeEffects.some(
            ({ modifier }) =>
              modifier.kind === "conditionImmunity" &&
              modifier.condition === effect.condition,
          ) ||
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
              ...(effect.endsOn ? { endsOn: effect.endsOn } : {}),
              ...(effect.saveOnDamage && conditionSave
                ? { saveOnDamage: conditionSave }
                : {}),
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
        // Being Incapacitated ends Concentration; with Boon of the Iron Mind only Petrified or Unconscious does.
        if (
          INCAPACITATING.includes(effect.condition) &&
          target.concentratingOn !== null &&
          (["petrified", "unconscious"].includes(effect.condition) ||
            !hasPassive(deriveStats(target, context), "unshakableFocus"))
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
        const held = to ? heldInPlace(target, context) : [];
        if (held.length > 0) {
          events.push(...held);
        } else if (to) {
          events.push(
            dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 }),
          );
        }
        break;
      }
      case "note":
      case "reduceDamage":
      case "acAgainstHit":
      case "teleport":
      case "zone":
      case "summon":
      case "counter":
        // A note is only for reading. Reduced damage is worked out by the reaction that holds up the hit, and
        // a teleport's square by its own decision and a zone once for the whole spell (resolveAction).
        break;
      default:
        effect satisfies never;
    }
  }
  return events;
}

// Order's Resilience's Stronger Together: a bearer that can act and an ally within 5 feet of it both have Advantage.
function strongerTogether(
  target: Actor,
  ability: Ability,
  context: Context,
): boolean {
  const able = (actor: Actor) =>
    !isDown(actor) && !hasCondition(actor, ...INCAPACITATING);
  const bears = (actor: Actor) =>
    deriveStats(actor, context).passives.some(
      (passive) =>
        passive.kind === "allySaveAdvantage" &&
        passive.abilities.includes(ability),
    );
  if (!able(target) || !target.position) return false;
  const near = Object.values(context.state.actors).filter(
    (other) =>
      other.id !== target.id &&
      other.side === target.side &&
      able(other) &&
      distanceFeet(other.position, target.position) <= 5,
  );
  return near.length > 0 && (bears(target) || near.some(bears));
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
      traitSaveAdvantage(stats, ability, conditions) ||
      strongerTogether(target, ability, context),
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
  // A save's once-only edge, as Harper Teamwork's Disadvantage, is spent on it.
  const spent = target.activeEffects.flatMap(
    ({ modifier, sourceId, casterId }) =>
      (modifier.kind === "advantage" || modifier.kind === "disadvantage") &&
      modifier.on === "saves" &&
      modifier.once
        ? [
            dndEvent(`${NS}:effectEnded`, {
              actor: target.id,
              sourceId,
              casterId,
            }),
          ]
        : [],
  );
  const rolled = dndEvent(`${NS}:saveRolled`, {
    actor: target.id,
    ability,
    natural: roll.natural,
    total,
    dc,
    success: saved,
  });
  // Boon of Fortune's Favor: a failed save is rolled again, once until the bearer's next turn starts.
  if (
    !saved &&
    hasPassive(stats, "saveReroll") &&
    !target.usedThisTurn.includes(SAVE_REROLL)
  ) {
    const again = rollSave(
      { ...target, usedThisTurn: [...target.usedThisTurn, SAVE_REROLL] },
      ability,
      dc,
      context,
      magical,
      cover,
      conditions,
      disadvantage,
      advantage,
    );
    return {
      saved: again.saved,
      events: [
        rolled,
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: target.id,
          key: SAVE_REROLL,
        }),
        ...again.events,
      ],
    };
  }
  return { saved, events: [rolled, ...spent] };
}

const SAVE_REROLL = "save-reroll";

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
  const mastered = masteredTypes(stats, action.spellLevel !== null);
  const rerolled = rerolledTypes(stats, action.spellLevel !== null);
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
          effect.kind === "polymorph" ||
          effect.kind === "summon") &&
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

  let ridden = false;
  const overload = { prone: false };
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
          piercing(damageResponses(target, context), mastered, stats),
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
    // Boon of Erupting Spellpower: each creature the surging spell damages is knocked Prone.
    if (overload.prone && result.dealt > 0) {
      events.push(
        ...leafEvents(
          [
            {
              kind: "applyCondition",
              condition: "prone",
              duration: { minutes: 1 },
              repeatSave: false,
              endsOnDamage: false,
            },
          ],
          "spell-overload",
          actor,
          target,
          context,
        ),
      );
    }
    // A spell's riders, as Putrefy's, go on the first creature it damages.
    // shortcut: only the first, since a use spent on one isn't seen by the next in the same cast.
    if (!ridden && action.spellLevel !== null && result.dealt > 0) {
      ridden = true;
      events.push(
        ...damageRiders(
          actor,
          target,
          new Set(damage.map(({ type }) => type)),
          false,
          stats,
          context,
          true,
        ),
      );
    }
    frames.push(
      ...concentrationFrame(
        target,
        result.dealt,
        hasPassive(stats, "concentrationBreaker"),
      ),
    );
  };

  const rollSharedDamage = (list: readonly Damage[]) => {
    const fuel =
      list.length > 0
        ? fueledDamage(actor, action, context)
        : { bonus: 0, events: [] };
    const maxed = maximized(
      actor,
      stats,
      list.map(({ type }) => type),
    );
    const surge =
      list.length > 0 && slotLevel !== undefined
        ? overloaded(actor, action, stats)
        : null;
    overload.prone = surge !== null;
    events.push(
      ...fuel.events,
      ...(maxed?.events ?? []),
      ...(surge ? [surge] : []),
    );
    const maxIndex = list.findIndex(({ type }) => type === maxed?.type);
    const floored = (dice: Dice): Dice =>
      surge
        ? {
            below: (count) => dice.below(count),
            roll: (sides) => Math.max(3, dice.roll(sides)),
          }
        : dice;
    return list.map(({ amount, type }, index) => ({
      total:
        rollAmount(
          amount,
          stats,
          index === maxIndex
            ? HIGHEST
            : floored(masteredDice(context.dice, type, mastered, rerolled)),
          critical ? 2 : 1,
        ) + (index === 0 ? fuel.bonus : 0),
      type,
    }));
  };

  switch (resolution.kind) {
    case "automatic": {
      beginConcentration(resolution.effects);
      // A zone is left once, where the area was aimed or round the caster, whoever it caught.
      const at = aim ?? actor.position;
      for (const effect of resolution.effects) {
        if (effect.kind === "summon") {
          events.push(
            ...summonEvents(effect, action, actor, stats, context, slotLevel),
          );
        }
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
              teleportFrame(
                actor,
                effect.feet,
                effect.movement,
                context,
                effect.provokes,
              ),
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
        const rescued =
          rolledSave || resisted
            ? []
            : rescuedSave(
                target,
                resolution.ability,
                conditionsApplied(resolution.onFail),
                deriveStats(target, context),
                saveEvents,
                events,
                context.dice,
                action.spellLevel !== null,
              );
        events.push(...rescued);
        const saved = rolledSave || resisted !== null || rescued.length > 0;
        const evaded =
          resolution.onSuccessDamage === "half" &&
          evades(target, resolution.ability, context);
        const interposed =
          saved &&
          !evaded &&
          damage.length > 0 &&
          resolution.ability === "dex" &&
          resolution.onSuccessDamage === "half" &&
          !spared.has(target.id)
            ? interposedShield(target, deriveStats(target, context), context)
            : null;
        if (interposed) events.push(interposed);
        applyRolled(target, damage, (amount) => {
          if (evaded) return saved ? 0 : halved(amount);
          if (!saved || resolution.onSuccessDamage === "full") return amount;
          return resolution.onSuccessDamage === "half" &&
            !spared.has(target.id) &&
            !interposed
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
      const thrown: Frame[] = [];
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
          // Let go once the rolls are done, since each looks the weapon up again.
          if (actionId.startsWith(THROW_PREFIX)) {
            thrown.push(
              frame("throwWeapon", {
                actor: actor.id,
                item: weaponItemId(actionId),
                target: target.id,
              }),
            );
          }
        }
      }
      frames.push(...thrown);
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
