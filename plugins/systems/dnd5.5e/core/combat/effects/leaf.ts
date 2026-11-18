import {
  chargesOf,
  damageResponses,
  deriveStats,
  atSlotLevel,
  evaluateFormula,
  immuneToCondition,
  lookup,
  rerollingOnes,
  cantripTier,
  rollAmount,
  rollDiceNotation,
  grantedKey,
  spellSaveDc,
} from "../../stats.ts";
import { regainCap, regainEvents, shortRestFor } from "../../rest.ts";
import {
  type Actor,
  cannotHeal,
  dndEvent,
  equipped,
  hasCondition,
  INCAPACITATING,
  freshActor,
  RETINUE,
  isDead,
  isStable,
  isDown,
  NS,
  SURGED,
} from "../../state.ts";
import { PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { finalDamage } from "../../rules.ts";
import {
  type Ability,
  ItemSchema,
  type LeafEffect,
  LeafEffectSchema,
  type Modifier,
  MonsterSchema,
} from "../../schemas.ts";
import {
  HIGHEST,
  hitDieHealing,
  hitDieRoll,
  nextHitDie,
  piercing,
} from "../../trait-rules.ts";
import { walkSpeed } from "../../tactics.ts";
import { HIT_DICE, ITEM_PREFIX, itemUseOf, spellOfSource } from "../ids.ts";
import { distanceFeet, pushTo, type Square, squareKey } from "../../grid.ts";
import { healingStopped, inZone, zoneImmune, zonesOf } from "../../zones.ts";
import { seeing } from "../../sight.ts";
import { boosted } from "../summon.ts";
import { resistancesLeft } from "../../legendary.ts";
import {
  focusLost,
  lastsFor,
  lethargyEffect,
  limitEvents,
} from "../durations.ts";
import { liftEvents } from "../falling.ts";
import { reincarnateEvents } from "../../reincarnate.ts";
import { cureFor, dispelEvents } from "../dispel.ts";
import { formOf, formsFor, SHAPE, shapeOf } from "../../forms.ts";
import { formEvents } from "../form-choice.ts";
import {
  clingSave,
  dropEvents,
  prisonEvents,
  sendAwayEvents,
} from "../fear.ts";
import { curedDiseaseEvents } from "../../environment.ts";
import {
  allies,
  type Context,
  currentActor,
  enemies,
  exemptFrom,
  hasPassive,
  SIZES,
  sizeOf,
} from "../queries.ts";
import { dealEvents } from "./damage.ts";
import {
  poolHealing,
  empowerer,
  spellHealing,
  FORTIFIED,
  tempHpBonus,
  stopRegains,
} from "./healing.ts";
import { retributionEvents } from "./magic-items.ts";
import { tacticRiderEvents } from "./riders.ts";
import { effectEnds, lingersFor } from "./lasting.ts";
import { incapacitatedEvents } from "./zero-hp.ts";
import { spellcastingCheck, rollSave } from "./saves.ts";
import { braced, randomFrom, heldInPlace } from "./forced-movement.ts";
import { warded, wardBroken } from "./death-ward.ts";
import { animatedEvents, raisedEvents } from "./animated.ts";

// A leaf effect landing on a target: conditions, healing, movement, damage and the rest.

// Several hits on one target, reported in turn so each one sees the HP the last one left.
// The item an `item:` action spends, or null.
const itemFrom = (sourceId: string): string | null =>
  sourceId.startsWith(ITEM_PREFIX) ? sourceId.slice(ITEM_PREFIX.length) : null;

// A channeled face kept on the target until a rest or until it's unleashed, replacing one kept before.
export function channelEvents(
  from: string,
  face: number,
  caster: Actor,
  target: Actor,
): SystemEvent[] {
  return [
    dndEvent(`${NS}:effectAdded`, {
      actor: target.id,
      effect: {
        sourceId: `channel:${from}`,
        casterId: caster.id,
        modifier: { kind: "channeled", from, face },
        ends: "spellDuration",
        lingers: 1,
      },
    }),
  ];
}

// A target whose Hit Points are in the effect's band, as Divine Word's or Power Word Stun's.
function inHpBand(
  target: Actor,
  band: {
    readonly hpAtMost?: number | undefined;
    readonly hpAbove?: number | undefined;
  },
): boolean {
  return (
    (band.hpAtMost === undefined || target.hp <= band.hpAtMost) &&
    (band.hpAbove === undefined || target.hp > band.hpAbove)
  );
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
  // Healing Rerolls: a healing die that rolls 1 is rolled again, for a spell or Battle Medic's Hit Point Die.
  const rerolled =
    hasPassive(stats, "healingRerolls") &&
    (sourceId.startsWith("spell:") ||
      effects.some((effect) => effect.kind === "hitDieHeal"))
      ? rerollingOnes(context.dice)
      : context.dice;
  // A Soothing Familiar's Healing Beacon: a healer beside it treats low rolls as its floor.
  const floor = Math.max(
    0,
    ...allies(context.state, caster).flatMap((item) =>
      item.id === caster.id || isDown(item)
        ? []
        : deriveStats(item, context).passives.flatMap((passive) =>
            passive.kind === "healDieFloor" &&
            distanceFeet(item.position, caster.position) <= passive.within
              ? [passive.at]
              : [],
          ),
    ),
  );
  const healDice =
    floor > 0
      ? {
          ...rerolled,
          roll: (sides: number) =>
            Math.max(Math.min(floor, sides), rerolled.roll(sides)),
        }
      : rerolled;
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
  const unhealed = healingStopped(target, context.state, context);
  for (const effect of effects) {
    switch (effect.kind) {
      // Magic Item Tinker's Drain: the oldest replicated item gone, a slot back by its rarity.
      // shortcut: the slot doesn't vanish at the next Long Rest.
      case "drainReplicated": {
        const [oldest] = caster.replicated ?? [];
        if (!oldest) break;
        const item = ItemSchema.safeParse(context.content(oldest)).data;
        const level =
          item && "rarity" in item && item.rarity === "common" ? 1 : 2;
        events.push(
          dndEvent(`${NS}:itemUsed`, { actor: caster.id, item: oldest }),
          dndEvent(`${NS}:itemReplicated`, {
            actor: caster.id,
            vanished: [oldest],
          }),
          dndEvent(`${NS}:resourceRestored`, {
            actor: caster.id,
            resource: `slot:${String(level)}`,
            amount: 1,
          }),
        );
        break;
      }
      case "channel": {
        if (effect.pick) break; // picked by a decision (resolveAction)
        const sides = stats.scaling[effect.dieSize] ?? 6;
        const twice = stats.passives.some(
          (passive) =>
            passive.kind === "tableTwice" && passive.from === effect.from,
        );
        const first = context.dice.roll(sides);
        const second = twice ? context.dice.roll(sides) : 0;
        const face =
          twice && first === second ? sides : Math.max(first, second);
        events.push(
          dndEvent(`${NS}:dieRolled`, {
            actor: caster.id,
            die: sides,
            rolled: face,
            label: "Channel",
          }),
          ...channelEvents(effect.from, face, caster, target),
        );
        break;
      }
      case "recoil": {
        const type = deriveStats(target, context).creatureType;
        if (
          effect.creatureTypes &&
          !effect.creatureTypes.includes(type ?? "")
        ) {
          break;
        }
        const hits = effect.damage.map((damage) => ({
          amount: rollAmount(damage.amount, stats, context.dice),
          type: damage.type,
        }));
        events.push(...dealEvents(caster, hits, false, context).events);
        break;
      }
      case "heal": {
        if (unhealed || cannotHeal(target)) break;
        if (
          effect.creatureTypes &&
          !effect.creatureTypes.includes(
            deriveStats(target, context).creatureType ?? "",
          )
        ) {
          break;
        }
        const max = deriveStats(target, context).maxHp + raisedMax;
        const room = Math.max(
          0,
          (effect.half ? Math.floor(max / 2) : max) - Math.max(target.hp, 0),
        );
        // Circle of Mortality: dice healing a creature at 0 Hit Points give their highest faces, and Supreme
        // Healing's for any spell or Channel Divinity.
        const spell = spellOfSource(sourceId);
        const divine = sourceId.includes("channel-divinity");
        const dice =
          (target.hp <= 0 && hasPassive(stats, "maxHealingAtZero")) ||
          ((spell !== null || divine) && hasPassive(stats, "maxHealingDice")) ||
          target.activeEffects.some(
            ({ modifier }) => modifier.kind === "healedMax",
          )
            ? HIGHEST
            : healDice;
        const pool = effect.pool
          ? poolHealing(effect.pool, effect.amount, room, caster, stats, dice)
          : null;
        if (pool && pool.spent > 0) {
          events.push(
            dndEvent(`${NS}:resourceSpent`, {
              actor: caster.id,
              resource: pool.resource,
              amount: pool.spent,
            }),
            ...(effect.pool?.temp
              ? [
                  dndEvent(`${NS}:tempHpGained`, {
                    actor: target.id,
                    amount: pool.spent,
                  }),
                ]
              : []),
          );
        }
        // Empowered Healing: a Sorcery Point rolls a spell's low healing dice again, once a turn.
        const empowering =
          spell !== null && !effect.full && !pool && effect.amount.dice
            ? empowerer(caster, context)
            : null;
        if (empowering) events.push(...empowering.events);
        const amount = empowering
          ? { ...effect.amount, reroll: 1 }
          : effect.amount;
        const rolled =
          (effect.full
            ? max
            : effect.halfMax
              ? Math.floor(max / 2)
              : (pool?.healed ?? rollAmount(amount, stats, dice)) +
                (effect.perSlot && slotLevel
                  ? effect.perSlot * slotLevel
                  : 0)) +
          (spell === null
            ? 0
            : spellHealing(spell, sourceId, stats, context, slotLevel));
        // Fortified Health: once a turn, healing gives the Constitution modifier more.
        const fortified = deriveStats(target, context).passives.find(
          (passive) => passive.kind === "healBonus",
        );
        const bonus =
          fortified?.kind === "healBonus" &&
          !target.usedThisTurn.includes(FORTIFIED) &&
          rolled < room
            ? Math.max(
                0,
                evaluateFormula(fortified.amount, deriveStats(target, context)),
              )
            : 0;
        if (bonus > 0) {
          events.push(
            dndEvent(`${NS}:oncePerTurnUsed`, {
              actor: target.id,
              key: FORTIFIED,
            }),
          );
        }
        // Healing beyond the maximum is lost, so only what's really gained is reported.
        events.push(
          dndEvent(`${NS}:healed`, {
            actor: target.id,
            amount: Math.min(rolled + bonus, room),
            max,
          }),
        );
        break;
      }
      case "ordeal":
        events.push(
          dndEvent(`${NS}:ordealBegun`, {
            actor: target.id,
            penalty: effect.penalty,
          }),
        );
        break;
      case "retribution": {
        const itemId = itemUseOf(sourceId);
        if (itemId) {
          events.push(...retributionEvents(target, itemId, effect, context));
        }
        break;
      }
      // An Arcane Battery: the target's daily item with the most charges spent gets some back.
      case "rechargeItem": {
        const pools = [...new Set(target.inventory)].flatMap((id) => {
          const item = ItemSchema.safeParse(context.content(id)).data;
          return item
            ? chargesOf(item).resources.filter((pool) =>
                pool.recharge.some((entry) => entry.on === "dawn"),
              )
            : [];
        });
        const [most] = pools
          .map((pool) => ({
            pool,
            spent: target.resourcesSpent[pool.id] ?? 0,
          }))
          .sort((a, b) => b.spent - a.spent);
        if (most && most.spent > 0) {
          events.push(
            dndEvent(`${NS}:resourceRestored`, {
              actor: target.id,
              resource: most.pool.id,
              amount: Math.min(
                most.spent,
                Math.max(1, rollAmount(effect.amount, stats, context.dice)),
              ),
            }),
          );
        }
        break;
      }
      // A Horn of Blasting may explode in its user's hands.
      case "mishap": {
        const itemId = itemUseOf(sourceId) ?? itemFrom(sourceId);
        if (!itemId || context.dice.roll(100) > effect.chance) break;
        events.push(
          dndEvent(`${NS}:itemUsed`, { actor: caster.id, item: itemId }),
          ...dealEvents(
            caster,
            effect.damage.map((hit) => ({
              amount: rollAmount(hit.amount, stats, context.dice),
              type: hit.type,
            })),
            false,
            context,
          ).events,
        );
        break;
      }
      case "untilLongRest": {
        const itemId =
          effect.item ??
          (sourceId.startsWith(ITEM_PREFIX)
            ? sourceId.slice(ITEM_PREFIX.length)
            : undefined);
        const item = itemId ? lookup(context, ItemSchema, itemId) : undefined;
        const passives =
          item?.type === "magicItem" ? (item.untilLongRest ?? []) : [];
        if (passives.length > 0) {
          events.push(
            dndEvent(`${NS}:restPassivesGained`, {
              actor: target.id,
              source: sourceId,
              passives,
            }),
          );
        }
        break;
      }
      case "createItems": {
        // An item from a book not loaded, as a dmg potion with phb alone, makes nothing.
        if (!context.content(effect.item)) break;
        const count = Math.max(1, evaluateFormula(effect.count, stats));
        events.push(
          dndEvent(`${NS}:treasureFound`, {
            actor: target.id,
            gold: 0,
            items: Array<string>(count).fill(effect.item),
            stowed: [],
          }),
        );
        break;
      }
      case "uncurse": {
        const cursed = new Set(
          target.activeEffects.flatMap(({ modifier, sourceId, casterId }) =>
            modifier.kind === "mark" && modifier.curse
              ? [`${casterId}|${sourceId}`]
              : [],
          ),
        );
        for (const key of cursed) {
          const [casterId = "", ...rest] = key.split("|");
          events.push(
            dndEvent(`${NS}:effectEnded`, {
              actor: target.id,
              sourceId: rest.join("|"),
              casterId,
            }),
          );
        }
        // It also ends its Attunement to a cursed item, unless only a Wish can (gear.ts), the item now let go.
        const attuned = target.attuned ?? [];
        const kept = attuned.filter((id) => {
          const item = lookup(context, ItemSchema, id);
          return !("curse" in item) || !item.curse || item.curse.wish === true;
        });
        if (kept.length < attuned.length) {
          events.push(
            dndEvent(`${NS}:gearChanged`, {
              actor: target.id,
              stowed: target.stowed ?? [],
              attuned: kept,
            }),
          );
        }
        break;
      }
      case "shortRest":
        events.push(...shortRestFor(target, context));
        break;
      case "regain":
        events.push(
          ...regainEvents(
            target,
            effect.resource,
            effect.perSlot && slotLevel
              ? effect.perSlot * slotLevel
              : effect.count,
            deriveStats(target, context),
            regainCap(effect, slotLevel),
          ),
        );
        break;
      case "drainMaxHp": // dealt with by the save it follows, which knows the damage
      case "disintegrate":
        break;
      case "repose":
        if (isDead(target)) {
          events.push(dndEvent(`${NS}:reposed`, { actor: target.id }));
        }
        break;
      case "hitDieHeal": {
        // shortcut: a Healer's Kit's ten uses aren't counted; the target's Hit Point Dice are the limit.
        // shortcut: it rolls as many of the dice it may as the target has, until the target is whole, rather than
        // asking how many.
        if (unhealed || cannotHeal(target)) break;
        const targetStats = deriveStats(target, context);
        const { maxHp: max } = targetStats;
        const missing = max - Math.max(target.hp, 0);
        let rolled = 0;
        let spent = 0;
        for (
          let left = effect.dice ?? 1;
          left > 0 && rolled < missing;
          left--
        ) {
          const die = nextHitDie(
            {
              ...target,
              resourcesSpent: {
                ...target.resourcesSpent,
                [HIT_DICE]: (target.resourcesSpent[HIT_DICE] ?? 0) + spent,
              },
            },
            context,
          );
          if (!die) break;
          rolled += hitDieHealing(
            hitDieRoll(die, targetStats, healDice),
            targetStats,
          );
          spent++;
        }
        if (spent === 0) break;
        rolled += hitDieHealing(
          evaluateFormula(effect.bonus, stats),
          targetStats,
        );
        events.push(
          ...Array.from({ length: spent }, () =>
            dndEvent(`${NS}:resourceSpent`, {
              actor: target.id,
              resource: HIT_DICE,
            }),
          ),
          dndEvent(`${NS}:healed`, {
            actor: target.id,
            amount: Math.max(0, Math.min(rolled, missing)),
            max,
          }),
        );
        break;
      }
      case "tempHp":
        if (effect.reaction) {
          if (!target.budget.reaction || isDown(target)) break;
          events.push(
            dndEvent(`${NS}:budgetSpent`, {
              actor: target.id,
              kind: "reaction",
            }),
          );
        }
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
      case "disengage":
      case "dodge": {
        if (effect.kind !== "dodge") {
          events.push(
            ...tacticRiderEvents(
              target,
              deriveStats(target, context),
              effect.kind,
            ),
          );
        }
        const tactic = (
          name: "dash" | "disengage" | "dodge",
          value?: number,
        ): SystemEvent =>
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              modifier: {
                kind: "tactic",
                tactic: name,
                ...(value === undefined ? {} : { value }),
              },
              ends: "casterNextTurn",
            },
          });
        const half =
          effect.kind === "dash" && effect.half
            ? 5 *
              Math.floor(walkSpeed(target, deriveStats(target, context)) / 10)
            : undefined;
        events.push(tactic(effect.kind, half));
        if (effect.kind === "dash" && effect.safe) {
          events.push(tactic("disengage"));
        }
        break;
      }
      case "modifier":
        // given once its type, skill or ability is picked (combat/damage-choice.ts, combat/check-choice.ts), or once
        // its option is (combat/options.ts)
        if (effect.choose || effect.pick || effect.option) break;
        if (!inHpBand(target, effect)) break;
        if (
          effect.immuneWith &&
          immuneToCondition(deriveStats(target, context), effect.immuneWith)
        ) {
          break;
        }
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              ...level,
              modifier: rolledModifier(effect.modifier, stats, context),
              ends: effectEnds(effect.duration),
              ...(effect.gone?.includes(
                deriveStats(target, context).creatureType ?? "",
              )
                ? {}
                : lastsFor(effect.duration, caster, target, context.state)),
              ...(effect.endSave
                ? {
                    repeatSave: {
                      ability: effect.endSave.ability,
                      dc: evaluateFormula(effect.endSave.dc, stats),
                    },
                  }
                : effect.repeatSave && save
                  ? { repeatSave: save }
                  : {}),
              ...(effect.whileTempHp ? { endsWithTempHp: true } : {}),
              ...(effect.endsOnDamage ? { endsOnDamage: true } : {}),
              ...(effect.endsOn ? { endsOn: effect.endsOn } : {}),
              ...(effect.saveOnDamage && save ? { saveOnDamage: save } : {}),
              ...(effect.endsInLight ? { endsInLight: true as const } : {}),
              ...(effect.untilIncapacitated
                ? { untilIncapacitated: true as const }
                : {}),
              ...(effect.casterIncapacitated
                ? { casterIncapacitated: true as const }
                : {}),
              ...(effect.studyEnds && save ? { studyDc: save.dc } : {}),
              ...lingersFor(effect.duration, !context.state.combat),
              ...swallowed,
            },
          }),
        );
        if (effect.modifier.kind === "hasted" && !effect.modifier.noLethargy) {
          const waiting = lethargyEffect(sourceId, caster.id, target);
          if (waiting) events.push(waiting);
        }
        // A fresh grant's uses start over, as a second Potion of Fire Breath's three exhales.
        if (
          effect.modifier.kind === "grantedAction" &&
          effect.modifier.uses !== undefined
        ) {
          events.push(
            dndEvent(`${NS}:resourceRestored`, {
              actor: target.id,
              resource: grantedKey(sourceId),
            }),
          );
        }
        if (
          effect.modifier.kind === "actionLimit" ||
          effect.modifier.kind === "pacified"
        ) {
          events.push(
            ...limitEvents(
              target,
              effect.modifier.kind === "pacified"
                ? { noActions: true, noReactions: true, speed: "none" }
                : effect.modifier,
              currentActor(context.state)?.id === target.id,
            ),
          );
        }
        break;
      case "applyCondition": {
        if (effect.option) break; // given once its option is picked (combat/options.ts)
        if (
          !inHpBand(target, effect) ||
          immuneToCondition(deriveStats(target, context), effect.condition) ||
          zoneImmune(target, effect.condition, context.state, context) ||
          target.activeEffects.some(
            ({ modifier }) =>
              modifier.kind === "conditionImmunity" &&
              modifier.condition === effect.condition &&
              (!modifier.creatureTypes ||
                modifier.creatureTypes.includes(
                  (
                    deriveStats(caster, context).creatureType ?? ""
                  ).toLowerCase(),
                )),
          ) ||
          (effect.web &&
            hasPassive(deriveStats(target, context), "webWalker")) ||
          (effect.maxSize !== undefined &&
            sizeOf(target, context) > SIZES.indexOf(effect.maxSize))
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
              ...lastsFor(effect.duration, caster, target, context.state),
              ...((effect.repeatSave ||
                effect.secondFailure ||
                effect.endSave) &&
              conditionSave
                ? { repeatSave: conditionSave }
                : {}),
              ...(effect.endsOnDamage ? { endsOnDamage: true } : {}),
              ...(effect.endsOnSpell ? { endsOnSpell: true } : {}),
              ...(effect.endsOn ? { endsOn: effect.endsOn } : {}),
              ...(effect.endsInLight ? { endsInLight: true as const } : {}),
              ...(effect.untilIncapacitated
                ? { untilIncapacitated: true as const }
                : {}),
              ...(effect.casterIncapacitated
                ? { casterIncapacitated: true as const }
                : {}),
              ...(effect.saveOnDamage && conditionSave
                ? {
                    saveOnDamage: {
                      ...conditionSave,
                      ...(effect.saveOnDamage === "advantage"
                        ? { advantage: true as const }
                        : {}),
                    },
                  }
                : {}),
              ...(effect.flee ? { flee: effect.flee } : {}),
              ...(effect.shake ? { shake: true as const } : {}),
              ...(effect.cantStand ? { cantStand: true as const } : {}),
              ...(effect.actionSave ? { actionSave: true as const } : {}),
              ...(effect.escape && (effect.escape.dc ?? save?.dc) !== undefined
                ? {
                    escape: {
                      ability: effect.escape.ability,
                      ...(effect.escape.skill
                        ? { skill: effect.escape.skill }
                        : {}),
                      dc: effect.escape.dc ?? save?.dc ?? 10,
                      ...(effect.escape.free ? { free: true as const } : {}),
                    },
                  }
                : {}),
              ...(effect.failExhaustion
                ? { failExhaustion: true as const }
                : {}),
              ...(effect.clings && conditionSave
                ? { clings: conditionSave }
                : {}),
              ...lingersFor(effect.duration, !context.state.combat),
              ...(effect.banish && save
                ? { banish: { ability: effect.banish.ability, dc: save.dc } }
                : {}),
              ...(effect.secondFailure && conditionSave
                ? {
                    secondFailure: {
                      condition: effect.secondFailure.condition,
                      ends: effectEnds(effect.secondFailure.duration),
                      ...(effect.secondFailure.count
                        ? { count: effect.secondFailure.count }
                        : {}),
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
        // Prone Deficiency: an odd roll leaves the creature knocked down Incapacitated until it saves.
        const deficient = deriveStats(target, context).passives.find(
          (passive) => passive.kind === "proneDeficiency",
        );
        if (
          effect.condition === "prone" &&
          deficient?.kind === "proneDeficiency" &&
          context.dice.roll(2) === 1
        ) {
          events.push(
            dndEvent(`${NS}:effectAdded`, {
              actor: target.id,
              effect: {
                sourceId: `${target.id}:prone-deficiency`,
                casterId: target.id,
                modifier: { kind: "condition", condition: "incapacitated" },
                ends: "spellDuration",
                repeatSave: { ability: deficient.ability, dc: deficient.dc },
              },
            }),
            ...focusLost(target, ["incapacitated"], context),
          );
        }
        events.push(...focusLost(target, [effect.condition], context));
        events.push(
          ...incapacitatedEvents(target, caster, effect.condition, context),
        );
        break;
      }
      case "removeCondition": {
        if (effect.option) break; // given once its option is picked (combat/options.ts)
        const clung = clingSave(target, effect.condition, context);
        events.push(...clung.events);
        if (clung.held) break;
        events.push(
          dndEvent(`${NS}:conditionRemoved`, {
            actor: target.id,
            condition: effect.condition,
          }),
        );
        break;
      }
      case "cure": {
        const condition = cureFor(target, effect.conditions);
        const clung = condition
          ? clingSave(target, condition, context)
          : { held: false, events: [] };
        events.push(...clung.events);
        if (effect.disease) events.push(...curedDiseaseEvents(target, context));
        // Befuddlement's hold on its spellcasting, which Greater Restoration and Heal end.
        const befuddled = effect.befuddled
          ? target.activeEffects.find(
              ({ modifier }) =>
                modifier.kind === "actionLimit" && modifier.noSpells,
            )
          : undefined;
        if (befuddled) {
          events.push(
            dndEvent(`${NS}:effectEnded`, {
              actor: target.id,
              sourceId: befuddled.sourceId,
              casterId: befuddled.casterId,
            }),
          );
        }
        const curse = target.activeEffects.find(
          ({ modifier }) => modifier.kind === "mark" && modifier.curse,
        );
        if (effect.pool) {
          const { resource, per } = effect.pool;
          let left =
            (stats.resources[resource] ?? 0) -
            (caster.resourcesSpent[resource] ?? 0);
          let spent = 0;
          let rest = target;
          for (
            let next = cureFor(rest, effect.conditions);
            next && left >= per;
            next = cureFor(rest, effect.conditions)
          ) {
            const removed = dndEvent(`${NS}:conditionRemoved`, {
              actor: target.id,
              condition: next,
            });
            events.push(removed);
            rest = {
              ...rest,
              activeEffects: rest.activeEffects.filter(
                ({ modifier }) =>
                  modifier.kind !== "condition" || modifier.condition !== next,
              ),
            };
            left -= per;
            spent += per;
          }
          if (spent > 0) {
            events.push(
              dndEvent(`${NS}:resourceSpent`, {
                actor: caster.id,
                resource,
                amount: spent,
              }),
            );
          }
        } else if (condition && clung.held) {
          // the save failed, and the condition stays
        } else if (condition) {
          events.push(
            dndEvent(`${NS}:conditionRemoved`, { actor: target.id, condition }),
          );
        } else if (effect.curse && curse) {
          events.push(
            dndEvent(`${NS}:effectEnded`, {
              actor: target.id,
              sourceId: curse.sourceId,
              casterId: curse.casterId,
            }),
          );
        } else if (effect.maxHp && (target.maxHpLoss ?? 0) > 0) {
          events.push(
            dndEvent(`${NS}:maxHpReduced`, {
              actor: target.id,
              amount: -(target.maxHpLoss ?? 0),
            }),
          );
        } else if (effect.exhaustion && target.exhaustion > 0) {
          events.push(
            dndEvent(`${NS}:exhaustionChanged`, {
              actor: target.id,
              levels: -1,
            }),
          );
        }
        break;
      }
      // A foe takes the weakest form allowed; the caster picks one for itself or an ally (resolveAction).
      case "polymorph": {
        const form =
          formOf(target) === null && target.side !== caster.side
            ? formsFor(effect, target, context)[0]
            : undefined;
        if (form) {
          events.push(
            ...formEvents(
              effect,
              sourceId,
              caster,
              target,
              form,
              effectEnds(effect.duration),
              context,
            ),
          );
        }
        break;
      }
      case "dispel": {
        // Spell Breaker: the Proficiency Bonus on the check, and the slot back when nothing ends.
        const breaker = hasPassive(stats, "spellBreaker");
        const ended = dispelEvents(
          target,
          effect.maxLevel,
          context.state,
          context,
          effect.hostile,
          effect.check && stats.spellAbility
            ? (dc) =>
                spellcastingCheck(
                  caster,
                  stats,
                  dc - (breaker ? stats.proficiency : 0),
                  context,
                )
            : undefined,
        );
        events.push(...ended);
        const stopped = ended.some(
          (item) =>
            item.kind === `${NS}:effectEnded` ||
            item.kind === `${NS}:concentrationEnded`,
        );
        const spell = spellOfSource(sourceId);
        // Power Surge: a spell ended gives a surge back.
        if (stopped) events.push(...stopRegains(caster, stats));
        if (
          breaker &&
          !stopped &&
          slotLevel !== undefined &&
          spell !== null &&
          !/:free(:|$)/.test(sourceId)
        ) {
          events.push(
            dndEvent(`${NS}:resourceRestored`, {
              actor: caster.id,
              resource: `slot:${String(slotLevel)}`,
              amount: 1,
            }),
          );
        }
        // Shutdown: the dispelled construct may fall Unconscious.
        const shutdown = deriveStats(target, context).passives.find(
          (passive) => passive.kind === "dispelShutdown",
        );
        if (shutdown?.kind === "dispelShutdown") {
          const saved = rollSave(
            target,
            "con",
            spellSaveDc(stats),
            context,
            true,
          );
          events.push(...saved.events);
          if (!saved.saved) {
            events.push(
              dndEvent(`${NS}:effectAdded`, {
                actor: target.id,
                effect: {
                  sourceId,
                  casterId: caster.id,
                  modifier: {
                    kind: "condition",
                    condition: shutdown.condition,
                  },
                  ends: "spellDuration",
                  ...lastsFor({ minutes: 1 }, caster, target, context.state),
                  endsOnDamage: true,
                },
              }),
            );
          }
        }
        break;
      }
      case "shapeShift": {
        const shapes =
          target.source.kind === "monster"
            ? lookup(context, MonsterSchema, target.source.statBlockId).shapes
            : undefined;
        const index =
          shapes?.findIndex((shape) => shape.name === effect.shape) ?? -1;
        const now = shapeOf(target);
        if (!shapes || index < 0 || (now ?? shapes[0]?.name) === effect.shape) {
          break;
        }
        if (now !== null) {
          events.push(
            dndEvent(`${NS}:effectEnded`, {
              actor: target.id,
              sourceId: SHAPE,
            }),
          );
        }
        // The true shape, listed first, is having no other.
        if (index > 0) {
          events.push(
            dndEvent(`${NS}:effectAdded`, {
              actor: target.id,
              effect: {
                sourceId: SHAPE,
                casterId: target.id,
                modifier: { kind: "shape", shape: effect.shape },
                ends: "spellDuration",
              },
            }),
          );
        }
        break;
      }
      case "hide": // its own frame, after the rest (actions.ts hideFrames)
      case "carry":
        if (target.id !== caster.id) {
          events.push(
            dndEvent(`${NS}:effectAdded`, {
              actor: caster.id,
              effect: {
                sourceId,
                casterId: caster.id,
                modifier: { kind: "carrying", actor: target.id },
                ends: "casterTurnEnd",
              },
            }),
          );
        }
        break;
      case "swapPlaces":
        if (caster.position && target.position && caster.id !== target.id) {
          events.push(
            dndEvent(`${NS}:moved`, {
              actor: caster.id,
              to: target.position,
              feet: 0,
            }),
            dndEvent(`${NS}:moved`, {
              actor: target.id,
              to: caster.position,
              feet: 0,
            }),
          );
        }
        break;
      case "extraAction":
        events.push(
          dndEvent(`${NS}:actionRegained`, { actor: target.id }),
          dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key: SURGED }),
        );
        break;
      case "extraTurns":
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              ...level,
              modifier: {
                kind: "extraTurns",
                turns: rollAmount(effect.turns, stats, context.dice),
              },
              ends: "spellDuration",
            },
          }),
        );
        break;
      // A push or pull is made on the grid as Shove's is, in a straight line.
      case "forcedMove": {
        if (effect.option) break; // given once its option is picked (combat/options.ts)
        const fits =
          (effect.maxSize === undefined ||
            sizeOf(target, context) <= SIZES.indexOf(effect.maxSize)) &&
          (effect.largerBy === undefined ||
            sizeOf(target, context) <=
              sizeOf(caster, context) + effect.largerBy);
        const brace = fits
          ? braced(target, effect.feet, context)
          : { feet: 0, events: [] };
        events.push(...brace.events);
        const to =
          fits && brace.feet > 0
            ? pushTo(
                effect.direction === "random"
                  ? randomFrom(target, context.dice.roll(4))
                  : effect.fromObject
                    ? (objectAt(caster, sourceId) ?? caster.position)
                    : caster.position,
                target,
                brace.feet,
                context.state,
                effect.direction === "toward",
              )
            : null;
        const held = to ? heldInPlace(target, context) : [];
        if (held.length > 0) {
          events.push(...held);
        } else if (to) {
          events.push(
            dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 }),
            ...prisonEvents(target, context),
          );
        }
        break;
      }
      case "disarm": {
        if (isDown(target) || !target.position) break;
        // War Bond: no disarming while it can act.
        if (
          hasPassive(deriveStats(target, context), "warBond") &&
          !hasCondition(target, ...INCAPACITATING)
        ) {
          break;
        }
        const held = equipped(target).find(
          (id) =>
            ItemSchema.safeParse(context.content(id)).data?.type === "weapon",
        );
        if (target.source.kind === "character") {
          if (held) {
            events.push(
              dndEvent(`${NS}:weaponThrown`, {
                item: held,
                at: target.position,
                by: target.id,
              }),
            );
          }
          break;
        }
        const weapon = deriveStats(target, context).actions.find(
          ({ activation }) =>
            activation.resolution.kind === "attack" &&
            activation.resolution.attack.type === "weapon" &&
            !activation.resolution.attack.unarmed,
        );
        if (weapon) {
          events.push(
            ...leafEvents(
              [
                {
                  kind: "modifier",
                  modifier: { kind: "stuck", action: weapon.id },
                  duration: { until: "itsNextTurnStart" },
                },
              ],
              sourceId,
              caster,
              target,
              context,
            ),
          );
        }
        break;
      }
      case "stabilize":
        if (target.hp <= 0 && !isDead(target) && !isStable(target)) {
          events.push(dndEvent(`${NS}:stabilized`, { actor: target.id }));
        }
        break;
      // Life Transference: the caster's own damage, which nothing lessens, heals the target twice over.
      case "transference": {
        const taken = rollAmount(effect.amount, stats, context.dice);
        events.push(
          dndEvent(`${NS}:damaged`, {
            actor: caster.id,
            amount: taken,
            type: effect.type,
            critical: false,
            massive: false,
          }),
        );
        if (unhealed || cannotHeal(target) || isDead(target)) break;
        const max = deriveStats(target, context).maxHp;
        const room = max - Math.max(target.hp, 0);
        if (room > 0) {
          events.push(
            dndEvent(`${NS}:healed`, {
              actor: target.id,
              amount: Math.min(room, taken * effect.times),
              max,
            }),
          );
        }
        break;
      }
      case "reincarnate":
        if (isDead(target) && target.source.kind === "character") {
          events.push(...reincarnateEvents(target, effect.species, context));
        }
        break;
      case "clone":
        if (target.clone === undefined && !isDead(target)) {
          events.push(
            dndEvent(`${NS}:cloneStarted`, {
              actor: target.id,
              days: effect.days,
            }),
          );
        }
        break;
      case "lift":
        events.push(...liftEvents(effect, sourceId, caster, target, context));
        break;
      case "splash":
        events.push(...splashEvents(effect, caster, target, context));
        break;
      case "exhaustion":
        // A Book of Vile Darkness's Tireless Form gains no levels.
        // shortcut: only levels from spells, attacks and items are held off, not a rest's or the weather's.
        if (
          effect.clear
            ? target.exhaustion > 0
            : effect.levels &&
              !hasPassive(deriveStats(target, context), "noExhaustion") &&
              // Iron Body's living metal, while it lasts
              !target.activeEffects.some(
                ({ modifier }) => modifier.kind === "noExhaustion",
              )
        ) {
          events.push(
            dndEvent(`${NS}:exhaustionChanged`, {
              actor: target.id,
              levels: effect.clear ? -target.exhaustion : (effect.levels ?? 0),
            }),
          );
        }
        break;
      // On a failed save, or a creature already at 0 Hit Points, as Steal Body or Consume Life. An automatic one
      // is worked out with its damage (resolveAction).
      case "concentrationSave":
        if (target.concentratingOn) {
          const kept = rollSave(target, "con", effect.dc, context, false, 0, [
            "concentration",
          ]);
          events.push(
            ...kept.events,
            ...(kept.saved
              ? []
              : [dndEvent(`${NS}:concentrationEnded`, { actor: target.id })]),
          );
        }
        break;
      case "behead":
        events.push(...beheadEvents(effect, caster, target, context));
        break;
      case "slay":
        if (warded(target)) {
          events.push(...wardBroken(target));
          break;
        }
        if (
          !isDead(target) &&
          target.hp <= effect.hpAtMost &&
          (effect.chance === undefined ||
            context.dice.roll(100) <= effect.chance) &&
          (!effect.creatureTypes ||
            exemptFrom(
              effect.creatureTypes,
              target,
              deriveStats(target, context),
            ))
        ) {
          events.push(
            dndEvent(`${NS}:damaged`, {
              actor: target.id,
              amount: Math.max(0, target.hp) + target.tempHp,
              type: "psychic",
              critical: false,
              massive: true,
            }),
            { kind: "actorDefeated", actor: target.id },
          );
        }
        break;
      case "drop":
        if (effect.option) break; // given once its option is picked (combat/options.ts)
        events.push(...dropEvents(target, context));
        break;
      case "sendAway":
        events.push(
          ...sendAwayEvents(effect, sourceId, caster, target, context),
        );
        break;
      case "allyHeal": {
        const hurt = allies(context.state, caster)
          .filter(
            (item) =>
              item.id !== target.id &&
              !isDead(item) &&
              distanceFeet(item.position, caster.position) <= effect.within,
          )
          .map((item) => ({ item, max: deriveStats(item, context).maxHp }))
          .filter(({ item, max }) => item.hp < max)
          .sort((a, b) => a.item.hp - a.max - (b.item.hp - b.max))[0];
        if (hurt) {
          events.push(
            dndEvent(`${NS}:healed`, {
              actor: hurt.item.id,
              amount: Math.min(
                rollAmount(effect.amount, stats, healDice),
                hurt.max - Math.max(hurt.item.hp, 0),
              ),
              max: hurt.max,
            }),
          );
        }
        break;
      }
      case "foesTake": {
        // Deflecting Shroud: the nearest foes the caster sees in range.
        const { range, creatures, damage } = effect;
        const foes = enemies(context.state, caster)
          .filter(
            (item) =>
              !isDown(item) &&
              !isDead(item) &&
              distanceFeet(caster.position, item.position) <= range &&
              seeing(caster, item.position, context.state, context) !== "none",
          )
          .sort(
            (a, b) =>
              distanceFeet(caster.position, a.position) -
              distanceFeet(caster.position, b.position),
          )
          .slice(0, creatures);
        for (const foe of foes) {
          // the bearer's Resistance-piercing for this source, as Aura of Malevolence's with Bloodthirst
          const responses = piercing(
            damageResponses(foe, context),
            [],
            stats,
            sourceId,
          );
          // none dealt, as with an Intelligence modifier of 0 or less, sets nothing off
          const hits = damage
            .map(({ amount, type }) => ({
              amount: finalDamage(
                rollAmount(amount, stats, context.dice),
                type,
                responses,
              ),
              type,
            }))
            .filter((hit) => hit.amount !== 0);
          if (hits.length === 0) continue;
          events.push(...dealEvents(foe, hits, false, context, caster).events);
        }
        break;
      }
      case "choose": {
        // Alter Self's options: the player picks; a companion or monster takes the first, which for a foe is the one
        // meant for foes, as Enlarge/Reduce's Reduce.
        const foe = target.side !== caster.side;
        const ordered = [
          ...effect.options.filter((item) => item.foe === true && foe),
          ...effect.options.filter((item) => !(item.foe === true && foe)),
        ];
        const answer =
          caster.id === PLAYER_ACTOR && context.ask
            ? context.ask({
                id: `${NS}:choose:${target.id}:${sourceId}`,
                actor: caster.id,
                prompt:
                  target.id === caster.id
                    ? "Which do you choose?"
                    : `Which do you choose for ${target.name}?`,
                options: ordered.map(({ name }, index) => ({
                  id: String(index),
                  label: name,
                })),
              })
            : "0";
        const option = ordered[Number(answer)] ?? ordered[0];
        events.push(
          ...leafEvents(
            [
              ...(option?.modifiers ?? []).map((modifier) =>
                LeafEffectSchema.parse({
                  kind: "modifier",
                  modifier,
                  duration: effect.duration,
                }),
              ),
              ...(option?.tempHp
                ? [{ kind: "tempHp" as const, amount: option.tempHp }]
                : []),
            ],
            sourceId,
            caster,
            target,
            context,
            save,
            slotLevel,
          ),
        );
        break;
      }
      case "commandCompanion": {
        // A Steel Defender or a Primal Companion may act on its next turn, which comes right after its owner's.
        for (const companion of Object.values(context.state.actors)) {
          if (
            companion.source.kind !== "summon" ||
            !companion.source.lasting ||
            companion.source.casterId !== caster.id ||
            isDown(companion)
          ) {
            continue;
          }
          events.push(
            dndEvent(`${NS}:effectAdded`, {
              actor: companion.id,
              effect: {
                sourceId: sourceId,
                casterId: caster.id,
                modifier: { kind: "commanded" },
                ends: "casterNextTurn",
                ...lastsFor(
                  { until: "yourNextTurnStart" },
                  caster,
                  companion,
                  context.state,
                ),
              },
            }),
          );
        }
        break;
      }
      case "senseDeceptions": {
        // Unerring Eye: only that something is trying to fool it, not what.
        const near = (at: Square | null): boolean =>
          distanceFeet(caster.position, at) <= effect.feet;
        const images = zonesOf(context.state).filter(
          (zone) =>
            zone.zone === "image" && zone.owner !== caster.id && near(zone.at),
        ).length;
        const fooling = Object.values(context.state.actors).filter(
          (item) =>
            item.id !== caster.id &&
            !isDead(item) &&
            near(item.position) &&
            (formOf(item) !== null ||
              item.activeEffects.some(
                ({ modifier }) =>
                  modifier.kind === "disguise" || modifier.kind === "shape",
              )),
        ).length;
        events.push(
          dndEvent(`${NS}:deceptionSensed`, {
            actor: caster.id,
            count: images + fooling,
          }),
        );
        break;
      }
      case "realImage": {
        // Illusory Reality: a wall over each of the caster's slot-cast images, for a minute.
        for (const zone of zonesOf(context.state)) {
          if (
            zone.zone !== "image" ||
            zone.decoy ||
            zone.owner !== caster.id ||
            zone.level === undefined
          ) {
            continue;
          }
          const grid = context.state.combat?.grid;
          const blocks: string[] = [];
          for (let y = 0; grid && y < grid.height; y += 1) {
            for (let x = 0; x < grid.width; x += 1) {
              if (inZone(zone, { x, y })) blocks.push(squareKey({ x, y }));
            }
          }
          events.push(
            dndEvent(`${NS}:effectAdded`, {
              actor: caster.id,
              effect: {
                sourceId: `real:${zone.sourceId}`,
                casterId: caster.id,
                modifier: {
                  kind: "zone",
                  zone: "wall",
                  at: zone.at,
                  radius: zone.radius,
                  blocks,
                  name: zone.name,
                },
                ends: "spellDuration",
                ...lastsFor(
                  { minutes: effect.minutes },
                  caster,
                  caster,
                  context.state,
                ),
              },
            }),
          );
        }
        break;
      }
      case "swapImage": {
        // Trickster's Transposition: the caster and its image trade squares.
        const image = caster.activeEffects.find(
          ({ modifier, sourceId: from }) =>
            modifier.kind === "zone" &&
            modifier.zone === "image" &&
            effect.sources.some(
              (id) =>
                from.startsWith(`feature:${id}:`) || from === `spell:${id}`,
            ),
        );
        if (image?.modifier.kind !== "zone" || !caster.position) break;
        events.push(
          dndEvent(`${NS}:moved`, {
            actor: caster.id,
            to: image.modifier.at,
            feet: 0,
          }),
          dndEvent(`${NS}:zoneMoved`, {
            actor: caster.id,
            sourceId: image.sourceId,
            to: caster.position,
          }),
        );
        break;
      }
      case "becomeMonster": {
        if (isDead(target)) break;
        const before = effect.counter
          ? (target.resourcesSpent[effect.counter] ?? 0)
          : 0;
        if (effect.counter) {
          events.push(
            dndEvent(`${NS}:resourceSpent`, {
              actor: target.id,
              resource: effect.counter,
            }),
          );
        }
        if (
          effect.chance !== undefined &&
          context.dice.roll(100) > effect.chance * (before + 1)
        ) {
          break;
        }
        // shortcut: with the monster's book not loaded, nothing happens.
        const monster = MonsterSchema.safeParse(
          context.content(effect.monster),
        ).data;
        if (!monster) break;
        events.push(
          dndEvent(`${NS}:damaged`, {
            actor: target.id,
            amount: Math.max(0, target.hp) + target.tempHp,
            type: "psychic",
            critical: false,
            massive: true,
          }),
          { kind: "actorDefeated", actor: target.id },
          dndEvent(`${NS}:summoned`, {
            actor: {
              ...freshActor({
                id: `${target.id}:lost`,
                name: monster.name,
                side: target.side === "party" ? "enemy" : "party",
                source: { kind: "monster", statBlockId: effect.monster },
                hp: monster.hp,
                inventory: [],
              }),
              ...(target.position ? { position: target.position } : {}),
            },
            after: target.id,
          }),
        );
        break;
      }
      case "endOwn": {
        // Leaving Wild Shape, or a Starry Form giving way to another: what those activations put on the target.
        const ended = new Set<string>();
        for (const own of target.activeEffects) {
          const key = `${own.sourceId}|${own.casterId}`;
          if (
            !ended.has(key) &&
            effect.features.some((id) =>
              own.sourceId.startsWith(`feature:${id}:`),
            )
          ) {
            ended.add(key);
            events.push(
              dndEvent(`${NS}:effectEnded`, {
                actor: target.id,
                sourceId: own.sourceId,
                casterId: own.casterId,
              }),
            );
          }
        }
        break;
      }
      case "endConcentration":
        if (target.concentratingOn !== null) {
          events.push(
            dndEvent(`${NS}:concentrationEnded`, { actor: target.id }),
          );
        }
        break;
      case "retain": {
        const monster = lookup(context, MonsterSchema, effect.monster);
        const count = Math.max(
          1,
          evaluateFormula(
            slotLevel === undefined
              ? effect.count
              : atSlotLevel(effect.count, slotLevel),
            stats,
          ),
        );
        const slug = effect.monster.slice(effect.monster.lastIndexOf("/") + 1);
        const used = (caster.retinue ?? []).map(
          ({ key }) => Number(key.slice(key.lastIndexOf("-") + 1)) || 0,
        );
        const first = Math.max(0, ...used) + 1;
        const hp = boosted(
          freshActor({
            id: `${caster.id}${RETINUE}new`,
            name: monster.name,
            side: caster.side,
            source: { kind: "monster", statBlockId: effect.monster },
            hp: monster.hp,
            inventory: [],
          }),
          caster,
          sourceId,
          slotLevel !== undefined,
          context,
        ).hp;
        events.push(
          dndEvent(`${NS}:retinueGained`, {
            actor: caster.id,
            entries: Array.from({ length: count }, (_, index) => ({
              key: `${slug}-${String(first + index)}`,
              monster: effect.monster,
              hp,
              lasts: effect.lasts,
            })),
          }),
        );
        break;
      }
      case "animate":
        if (
          effect.chance === undefined ||
          context.dice.roll(100) <= effect.chance
        ) {
          events.push(
            ...animatedEvents(
              effect,
              caster,
              context,
              sourceId,
              slotLevel !== undefined,
            ),
          );
        }
        break;
      case "raiseCorpse":
        events.push(
          ...raisedEvents(
            effect,
            caster,
            context,
            effect.slain ? target : undefined,
            sourceId,
          ),
        );
        break;
      case "revertShape": {
        // shortcut: it can shape-shift again at once, rather than only once out of the light.
        const ended = new Set<string>();
        for (const own of target.activeEffects) {
          const key = `${own.sourceId}|${own.casterId}`;
          if (
            (own.modifier.kind === "form" || own.modifier.kind === "shape") &&
            !ended.has(key)
          ) {
            ended.add(key);
            events.push(
              dndEvent(`${NS}:effectEnded`, {
                actor: target.id,
                sourceId: own.sourceId,
                casterId: own.casterId,
              }),
            );
          }
        }
        break;
      }
      case "note":
      case "disperse":
      case "reactionAttack":
      case "reactionMove":
      case "randomAction":
      case "rollTable":
      case "escape":
      case "reduceDamage":
      case "acAgainstHit":
      case "commandFamiliar":
      case "teleport":
      case "zone":
      case "summon":
      case "counter":
      case "reroll":
      case "rollBonus":
      case "replaceRoll":
      case "succeed":
      case "strike":
      case "redirect":
      case "drawAttack":
      case "negateHit":
      case "redirectMiss":
      case "noCritical":
      case "stealSpell":
      case "stickWeapon":
      case "slowFall":
      case "split":
      case "swapInitiative":
      case "inspiration":
      case "resistTrigger":
      case "forcedAttack":
      case "moveZone":
      case "weaponAttack":
      case "copySpell":
      case "retypeHit":
        // A note is only for reading. Reduced damage is worked out by the reaction that holds up the hit, and
        // a teleport's square by its own decision and a zone once for the whole spell (resolveAction).
        break;
      default:
        effect satisfies never;
    }
  }
  return events;
}

// Where a caster's spell object stands, for an action of that spell (combat/anchor.ts), as Grasping Vine's vine.
function objectAt(caster: Actor, sourceId: string): Square | null {
  const source = sourceId.startsWith("lasting:")
    ? `spell:${sourceId.slice("lasting:".length)}`
    : sourceId;
  for (const effect of caster.activeEffects) {
    if (effect.sourceId === source && effect.modifier.kind === "zone") {
      return effect.modifier.at;
    }
  }
  return null;
}

// Of these types, the one a creature takes most from: vulnerable, then plain, then resisted, never immune if another
// will do, as Chromatic Orb's caster picks.
// A Vorpal Sword's 20 on a creature with a head: it dies, or takes the damage when it can't lose one.
function beheadEvents(
  effect: Extract<LeafEffect, { kind: "behead" }>,
  caster: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  if (isDead(target)) return [];
  const responses = damageResponses(target, context);
  const headless =
    effect.spares !== undefined &&
    exemptFrom(effect.spares, target, deriveStats(target, context));
  const immune = effect.damage.some(({ type }) =>
    responses.immunities.includes(type),
  );
  const resisted =
    headless || immune || resistancesLeft(target, context, context.state) <= 0
      ? null
      : dndEvent(`${NS}:legendaryResistanceUsed`, { actor: target.id });
  if (!headless && !immune && !resisted) {
    return [
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: Math.max(0, target.hp) + target.tempHp,
        type: effect.damage[0]?.type ?? "slashing",
        critical: true,
        massive: true,
      }),
      { kind: "actorDefeated", actor: target.id },
    ];
  }
  const stats = deriveStats(caster, context);
  return [
    ...(resisted ? [resisted] : []),
    ...dealEvents(
      target,
      effect.damage.map(({ amount, type }) => ({
        amount: finalDamage(
          rollAmount(amount, stats, context.dice),
          type,
          responses,
        ),
        type,
      })),
      false,
      context,
    ).events,
  ];
}

// Green-Flame Blade's fire leaping from the creature hit to the nearest other foe of the caster's beside it.
function splashEvents(
  effect: Extract<LeafEffect, { kind: "splash" }>,
  caster: Actor,
  target: Actor,
  context: Context,
): SystemEvent[] {
  const [other] = Object.values(context.state.actors)
    .filter(
      (item) =>
        item.id !== target.id &&
        item.side !== caster.side &&
        !isDown(item) &&
        distanceFeet(target.position, item.position) <= effect.feet,
    )
    .sort(
      (a, b) =>
        distanceFeet(target.position, a.position) -
        distanceFeet(target.position, b.position),
    );
  if (!other) return [];
  const stats = deriveStats(caster, context);
  const responses = damageResponses(other, context);
  const tiers = cantripTier(stats.level);
  const hits = effect.damage.map(({ amount, type }, index) => ({
    amount: finalDamage(
      rollAmount(amount, stats, context.dice) +
        (index === 0 && effect.perTier && tiers > 0
          ? rollDiceNotation(effect.perTier, context.dice, tiers)
          : 0),
      type,
      responses,
    ),
    type,
  }));
  return dealEvents(other, hits, false, context).events;
}

// A Hit Point maximum cut by dice, as a demilich's Energy Drain, is rolled once and kept as the number rolled.
// shortcut: Hit Points above the lowered maximum stay until the creature is hurt.
function rolledModifier(
  modifier: Modifier,
  stats: ReturnType<typeof deriveStats>,
  context: Context,
): Modifier {
  // Sanctuary keeps the caster's save DC as it was cast, as does an action a spell gives.
  if (
    (modifier.kind === "sanctuary" ||
      modifier.kind === "grantedAction" ||
      modifier.kind === "castSave" ||
      modifier.kind === "dodgeSave" ||
      modifier.kind === "disguise") &&
    modifier.dc === undefined
  ) {
    return { ...modifier, dc: spellSaveDc(stats) };
  }
  if (modifier.kind !== "bonus" || modifier.to !== "maxHp") return modifier;
  if (modifier.amount.dice === undefined) return modifier;
  return {
    ...modifier,
    amount: {
      bonus: {
        base: rollAmount(modifier.amount, stats, context.dice),
        add: [],
      },
    },
  };
}
