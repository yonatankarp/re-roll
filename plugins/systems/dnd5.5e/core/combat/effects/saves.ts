import {
  checkBonus,
  deriveStats,
  evaluateFormula,
  saveBonus,
  scoreFloor,
  type Stats,
} from "../../stats.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { rollD20 } from "../../rules.ts";
import { type Ability } from "../../schemas.ts";
import {
  d20Floor,
  type SaveSource,
  traitSaveAdvantage,
} from "../../trait-rules.ts";
import { dodging } from "../../tactics.ts";
import { distanceFeet } from "../../grid.ts";
import { placedFlag } from "../../zones.ts";
import { counterBeforeSave, preyBonus, settleRoll } from "../reactions.ts";
import {
  type Context,
  hasFlag,
  hasPassive,
  luckyEdge,
  rollBonus,
} from "../queries.ts";
import { leafEvents } from "./leaf.ts";

// Saving throws, and the spellcasting checks rolled against a spell.

// A check with the caster's spellcasting ability, as Dispel Magic's against a higher spell.
// shortcut: no reactions or rescues change the roll, as they may an ability check's (actions.ts abilityCheck).
export function spellcastingCheck(
  caster: Actor,
  stats: Stats,
  dc: number,
  context: Context,
): { readonly success: boolean; events: SystemEvent[] } {
  const { natural } = rollD20(context.dice, {
    advantage: false,
    disadvantage: false,
  });
  const total =
    natural +
    checkBonus(stats, caster, { ability: stats.spellAbility ?? "int" });
  const success = total >= dc;
  return {
    success,
    events: [
      dndEvent(`${NS}:rollReported`, {
        actor: caster.id,
        against: "check",
        natural,
        total,
        target: dc,
        success,
        label: success ? "ends the spell" : "fails to end the spell",
      }),
    ],
  };
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
  source?: SaveSource, // what it's against, for Dragon Scale Mail's Advantage against a dragon's breath
  penalty = 0, // taken off the total, as Tenacious Spell's 1d6
): { readonly saved: boolean; readonly events: SystemEvent[] } {
  if (
    (ability === "str" || ability === "dex") &&
    hasCondition(target, "paralyzed", "petrified", "stunned", "unconscious")
  ) {
    return { saved: false, events: [] };
  }
  // Slayer's Counter: the bearer's attack at its prey first, and a hit makes the save succeed.
  const countered = counterBeforeSave(target, source?.caster, context);
  if (countered.hit) return { saved: true, events: countered.events };
  const counterEvents = countered.events;
  const stats = deriveStats(target, context);
  // Eldritch Strike: Disadvantage only on a save against its caster's spell.
  const against = (effect: Actor["activeEffects"][number]): boolean =>
    effect.modifier.kind === "disadvantage" &&
    effect.modifier.on === "saves" &&
    effect.modifier.casterSpells === true &&
    magical &&
    source?.caster === effect.casterId;
  const edge = {
    advantage:
      advantage ||
      hasFlag(target, "advantage", "saves", stats, ability) ||
      placedFlag(
        target,
        "advantage",
        "saves",
        context.state,
        context,
        ability,
        conditions,
        magical,
      ) ||
      (magical && hasPassive(stats, "magicResistance")) ||
      (ability === "dex" && dodging(target)) ||
      traitSaveAdvantage(
        stats,
        ability,
        conditions,
        target.hp * 2 <= stats.maxHp,
        target,
        source,
      ) ||
      strongerTogether(target, ability, context),
    disadvantage:
      disadvantage ||
      target.activeEffects.some(against) ||
      hasFlag(target, "disadvantage", "saves", stats, ability) ||
      placedFlag(
        target,
        "disadvantage",
        "saves",
        context.state,
        context,
        ability,
        conditions,
        magical,
        source?.caster,
      ) ||
      (ability === "dex" && hasCondition(target, "restrained")) ||
      stats.passives.some(
        (passive) =>
          passive.kind === "foeDisadvantage" &&
          source?.creatureType !== undefined &&
          passive.creatureTypes.includes(source.creatureType),
      ) ||
      stats.passives.some(
        (passive) =>
          passive.kind === "saveDisadvantage" &&
          passive.conditions.some((condition) =>
            conditions.includes(condition),
          ),
      ),
  };
  const lucky = luckyEdge(target, stats, edge.advantage, edge.disadvantage);
  if (lucky) edge.disadvantage = false;
  const rolled0 = rollD20(context.dice, {
    ...edge,
    rerollOnes: hasPassive(stats, "rerollOnes"),
  });
  // Trance of Order: a d20 of 9 or lower counts as 10.
  const roll = {
    ...rolled0,
    natural: Math.max(
      rolled0.natural,
      d20Floor(target, stats, conditions.includes("concentration")),
    ),
  };
  const base =
    saveBonus(stats, ability) +
    rollBonus(target, "saves", context, undefined, ability) +
    preyBonus(target, source?.caster, context) +
    (ability === "dex" ? cover : 0) -
    penalty;
  const least = scoreFloor(stats, ability); // Indomitable Might
  // Reactions to the roll before it lands, as Bountiful Luck or Portent (combat/reactions.ts).
  const judge = (natural: number, bonus: number) => ({
    total: Math.max(natural + base + bonus, least),
    success: Math.max(natural + base + bonus, least) >= dc,
  });
  const settled = settleRoll(
    {
      roller: target,
      kind: "save",
      natural: roll.natural,
      goal: dc,
      magical,
      conditions,
      ...judge(roll.natural, 0),
    },
    edge,
    judge,
    context,
  );
  const { total, success: saved } = judge(settled.natural, settled.bonus);
  // A save's once-only edge or bonus, as Harper Teamwork's Disadvantage or Mind Sliver's 1d4, is spent on it.
  const spent = target.activeEffects.flatMap(
    ({ modifier, sourceId, casterId }) =>
      (((modifier.kind === "advantage" || modifier.kind === "disadvantage") &&
        modifier.on === "saves" &&
        (modifier.kind !== "disadvantage" ||
          !modifier.casterSpells ||
          (magical && source?.caster === casterId))) ||
        (modifier.kind === "bonus" &&
          modifier.to === "saves" &&
          (!modifier.ability || modifier.ability === ability))) &&
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
    natural: settled.natural,
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
        ...settled.events,
        rolled,
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: target.id,
          key: SAVE_REROLL,
        }),
        ...again.events,
      ],
    };
  }
  return {
    saved,
    events: [
      ...counterEvents,
      ...(lucky ?? []),
      ...settled.events,
      rolled,
      ...spent,
      ...naturalOneEvents(target, settled.natural, context),
    ],
  };
}

const SAVE_REROLL = "save-reroll";

// Set while a natural 1's own save is rolled, so that save doesn't set it off again.
let echoing = false;

// Echoing Soul's Intrusive Echoes: right after a D20 Test of the bearer's rolls a 1, its save, and on a failure what
// the passive does to it (schemas.ts naturalOne).
export function naturalOneEvents(
  actor: Actor,
  natural: number,
  context: Context,
): SystemEvent[] {
  if (natural !== 1 || echoing) return [];
  const stats = deriveStats(actor, context);
  const events: SystemEvent[] = [];
  for (const passive of stats.passives) {
    if (passive.kind !== "naturalOne") continue;
    echoing = true;
    try {
      const against = {
        ability: passive.save.ability,
        dc: evaluateFormula(passive.save.dc, stats),
      };
      const save = rollSave(actor, against.ability, against.dc, context);
      events.push(...save.events);
      // The same save ends a condition that a later one can, as Symbiotic Agenda's Charmed when its bearer is hurt.
      if (!save.saved)
        events.push(
          ...leafEvents(
            passive.effects,
            `trigger:${passive.name}`,
            actor,
            actor,
            context,
            against,
          ),
        );
    } finally {
      echoing = false;
    }
  }
  return events;
}
