import {
  chargesOf,
  checkBonus,
  damageResponses,
  deriveStats,
  evaluateFormula,
  immuneToCondition,
  type KnownAction,
  lookup,
  modifierFor,
  passiveModifiers,
  rerollingOnes,
  rollAmount,
  rollDiceNotation,
  wishedKey,
  saveBonus,
  scoreFloor,
  spellSaveDc,
  type Stats,
} from "../stats.ts";
import { metamagicSaves } from "../metamagic.ts";
import { regainCap, regainEvents, shortRestFor } from "../rest.ts";
import {
  type Actor,
  applyDndEvent,
  cannotHeal,
  dndEvent,
  type DndState,
  equipped,
  hasCondition,
  INCAPACITATING,
  fightingOn,
  familiarOwner,
  freshActor,
  isDead,
  isStable,
  mountOf,
  isDown,
  NS,
  frame,
  SURGED,
} from "../state.ts";
import {
  type ContentAccess,
  type Dice,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { concentrationDc, finalDamage, halved, rollD20 } from "../rules.ts";
import {
  type Ability,
  type Amount,
  type Condition,
  type Damage,
  type DamageType,
  type Duration,
  type Formula,
  ItemSchema,
  type LeafEffect,
  type Modifier,
  MonsterSchema,
  type Passive,
  type Resolution,
  SpellSchema,
} from "../schemas.ts";
import { multiattackUses } from "../multiattack-uses.ts";
import {
  HIGHEST,
  masteredDice,
  maximized,
  masteredTypes,
  rerolledTypes,
  hitDieHealing,
  hitDieRoll,
  nextHitDie,
  piercing,
  interposedShield,
  evades,
  markedBy,
  rescuedSave,
  type SaveSource,
  saveSourceOf,
  traitSaveAdvantage,
  WARD_DOWN,
} from "../trait-rules.ts";
import { dodging, speedOf, walkSpeed } from "../tactics.ts";
import {
  AIM,
  ALL,
  HIT_DICE,
  THROW_PREFIX,
  castFrom,
  itemUseOf,
  spellOfSource,
  weaponItemId,
} from "./ids.ts";
import {
  distanceFeet,
  inArea,
  parseSquare,
  pushTo,
  type Square,
  squareKey,
} from "../grid.ts";
import {
  blockedSquares,
  healingStopped,
  placedFlag,
  sealed,
  zoneImmune,
  zonesOf,
  zonesOn,
} from "../zones.ts";
import { caughtBy } from "../targeting.ts";
import { behindTotalCover, coverAgainst, coverFor } from "../sight.ts";
import { teleportFrame, teleportSquares } from "./movement.ts";
import {
  afterDamage,
  beforeDamage,
  besideSquare,
  reactFrames,
  settleRoll,
  beforeFailedSave,
  playerTakes,
  slotRefund,
} from "./reactions.ts";
import { summonEvents } from "./summon.ts";
import { fueledDamage } from "./school.ts";
import { conditionsApplied, legendaryResistance } from "../legendary.ts";
import { insideDamageEvents } from "./swallow.ts";
import { headDamageEvents } from "./heads.ts";
import { lastsFor, lethargyEffect, limitEvents } from "./durations.ts";
import { movedFrames } from "./areas.ts";
import { liftEvents } from "./falling.ts";
import { reincarnateEvents } from "../reincarnate.ts";
import { cureFor, dispelEvents, isSpell, snuffedLights } from "./dispel.ts";
import { currentShape, formOf, formsFor, SHAPE, shapeOf } from "../forms.ts";
import { formEvents, formFrame } from "./form-choice.ts";
import { damageTypeFrame, zoneTypeFrame } from "./damage-choice.ts";
import { focusFrame } from "./check-choice.ts";
import { clingSave, dropEvents, prisonEvents, sendAwayEvents } from "./fear.ts";
import { optionFrame } from "./options.ts";
import { curedDiseaseEvents } from "../environment.ts";
import { weaponAttackResult } from "./weapon-spell.ts";
import { duelBroken, duelDamaged } from "./duel.ts";
import { wishFrame } from "./wish.ts";
import {
  actorOf,
  allies,
  areaPool,
  attackRoutine,
  type Context,
  currentActor,
  enemies,
  exemptFrom,
  fitsType,
  hasFlag,
  hasPassive,
  inReach,
  isMelee,
  meleeReach,
  hitFits,
  onceKey,
  reaches,
  rollBonus,
  SIZES,
  sizeOf,
  slotToSpend,
  deadWithin,
  spellSource,
  underEffect,
  walledApart,
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
    // Wish's copy is cast once.
    ...actor.activeEffects.flatMap(({ modifier }) =>
      modifier.kind === "wished" && action.id === `spell:${modifier.spell}`
        ? [
            dndEvent(`${NS}:oncePerTurnUsed`, {
              actor: actor.id,
              key: wishedKey(modifier.spell),
            }),
          ]
        : [],
    ),
    ...(action.activation.oncePerTurn
      ? [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: actor.id,
            key: onceKey(action),
          }),
        ]
      : []),
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
    } else if ("gold" in cost) {
      events.push(dndEvent(`${NS}:goldSpent`, { gold: cost.gold }));
    } else {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: cost.resource,
          ...(cost.count ? { amount: cost.count } : {}),
        }),
      );
    }
  }
  return [...events, ...lastCharge(actor, action, context)];
}

// Spending a charged item's last charge rolls a d20, and on a 1 the item is gone, or left as the plain item it
// becomes, as an Enspelled Staff's Quarterstaff (ChargedSchema). That's a spell cast from it or its own activation.
// shortcut: a Staff of Power's or the Magi's other rolls, keeping its bonus or regaining charges on a 20, don't play.
function lastCharge(
  actor: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  const itemId = castFrom(action.id)?.item ?? itemUseOf(action.id);
  const item = itemId ? lookup(context, ItemSchema, itemId) : undefined;
  const fate = item && "lastCharge" in item ? item.lastCharge : undefined;
  const pool = item ? chargesOf(item).resources[0]?.id : undefined;
  if (!itemId || !fate || !pool) return [];
  const charges = action.activation.cost.reduce(
    (total, cost) =>
      typeof cost === "object" && "resource" in cost && cost.resource === pool
        ? total + (cost.count ?? 1)
        : total,
    0,
  );
  const left =
    (deriveStats(actor, context).resources[pool] ?? 0) -
    (actor.resourcesSpent[pool] ?? 0) -
    charges;
  if (charges === 0 || left > 0 || context.dice.roll(20) !== 1) return [];
  return [
    dndEvent(`${NS}:itemUsed`, { actor: actor.id, item: itemId }),
    dndEvent(`${NS}:resourceRestored`, { actor: actor.id, resource: pool }),
    ...(typeof fate === "object"
      ? [
          dndEvent(`${NS}:treasureFound`, {
            actor: actor.id,
            gold: 0,
            items: [fate.becomes],
            stowed: [],
          }),
        ]
      : []),
  ];
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
  if (rolled < 0) return absorbedEvents(target, -rolled, context);
  const amount = scaledForParty(target, rolled, context.state);
  if (amount <= 0) return [];
  const stats = deriveStats(target, context);
  return [
    ...takenEvents(target, amount, type, critical, context),
    ...afterDamageEvents(target, amount, type, stats, context),
  ];
}

// Damage absorbed heals instead.
function absorbedEvents(
  target: Actor,
  amount: number,
  context: Context,
): SystemEvent[] {
  const { maxHp } = deriveStats(target, context);
  const healed = cannotHeal(target)
    ? 0
    : Math.min(amount, maxHp - Math.max(target.hp, 0));
  return healed > 0
    ? [
        dndEvent(`${NS}:healed`, {
          actor: target.id,
          amount: healed,
          max: maxHp,
        }),
      ]
    : [];
}

// What a hit sets off on the creature it lands on: a yeti's Fear of Fire, or a troll's limb cut off.
function afterDamageEvents(
  target: Actor,
  amount: number,
  type: Damage["type"],
  stats: ReturnType<typeof deriveStats>,
  context: Context,
): SystemEvent[] {
  const events: SystemEvent[] = headDamageEvents(target, amount, type, stats);
  // A Cloak of Displacement stops working until the bearer's next turn starts.
  if (
    stats.passives.some(
      (passive) => passive.kind === "ward" && passive.suppressed === "damaged",
    ) &&
    !target.usedThisTurn.includes(WARD_DOWN)
  ) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key: WARD_DOWN }),
    );
  }
  for (const passive of stats.passives) {
    if (passive.kind === "onDamage" && passive.damage.includes(type)) {
      for (const modifier of passive.modifiers) {
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: `${target.id}:on-damage`,
              casterId: target.id,
              modifier,
              ends: "casterNextTurnEnd",
            },
          }),
        );
      }
    }
    const left = target.hp - amount;
    if (
      passive.kind === "severedLimbs" &&
      type === "slashing" &&
      amount >= passive.slashing &&
      left > 0 &&
      left * 2 <= stats.maxHp &&
      (target.resourcesSpent[passive.resource] ?? 0) < passive.uses
    ) {
      events.push(...severedEvents(target, passive, context));
    }
  }
  return events;
}

// shortcut: a single hit of the printed Slashing damage severs the limb at once, rather than the turn's total at its end.
function severedEvents(
  target: Actor,
  passive: Extract<Passive, { kind: "severedLimbs" }>,
  context: Context,
): SystemEvent[] {
  const monster = lookup(context, MonsterSchema, passive.monster);
  const count = target.resourcesSpent[passive.resource] ?? 0;
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: target.id,
      resource: passive.resource,
    }),
    dndEvent(`${NS}:exhaustionChanged`, { actor: target.id, levels: 1 }),
    dndEvent(`${NS}:summoned`, {
      actor: {
        ...freshActor({
          id: `${target.id}:limb-${String(count + 1)}`,
          name: `${monster.name} ${String(count + 1)}`,
          side: target.side,
          source: { kind: "monster", statBlockId: passive.monster },
          hp: monster.hp,
          inventory: [],
        }),
        position:
          teleportSquares(target, 5, 0, context.state, context)[0] ??
          target.position,
      },
      after: target.id,
    }),
  ];
}

function takenEvents(
  target: Actor,
  amount: number,
  type: Damage["type"],
  critical: boolean,
  context: Context,
): SystemEvent[] {
  // Damage left over after reaching 0 HP kills a character if it's at least their maximum.
  const remaining = amount - target.tempHp - Math.max(0, target.hp);
  // A vampire warden that would drop turns to stone instead, with Hit Points to lose all over again.
  const stone = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "stoneRestoration",
  );
  if (
    stone?.kind === "stoneRestoration" &&
    target.hp > 0 &&
    remaining >= 0 &&
    !hasCondition(target, "petrified")
  ) {
    const { maxHp } = deriveStats(target, context);
    return [
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: amount - remaining,
        type,
        critical,
        massive: false,
      }),
      dndEvent(`${NS}:healed`, {
        actor: target.id,
        amount: Math.min(stone.hp, maxHp),
        max: maxHp,
      }),
      dndEvent(`${NS}:effectAdded`, {
        actor: target.id,
        effect: {
          sourceId: `${target.id}:stone`,
          casterId: target.id,
          modifier: { kind: "condition", condition: "petrified" },
          ends: "spellDuration",
        },
      }),
    ];
  }
  // Suppressed Lycanthropy: the creature that drops comes back at once as another, or as itself again.
  const reborn = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "reborn",
  );
  if (
    reborn?.kind === "reborn" &&
    target.hp > 0 &&
    remaining >= 0 &&
    target.source.kind === "monster" &&
    !target.id.endsWith(":reborn") // only once
  ) {
    const id = reborn.monster ?? target.source.statBlockId;
    const monster = lookup(context, MonsterSchema, id);
    const hp = reborn.hp === "full" ? monster.hp : Math.floor(monster.hp / 2);
    return [
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: amount - remaining,
        type,
        critical,
        massive: false,
      }),
      { kind: "actorDefeated", actor: target.id },
      dndEvent(`${NS}:summoned`, {
        actor: {
          ...freshActor({
            id: `${target.id}:reborn`,
            name: reborn.monster ? monster.name : target.name,
            side: target.side,
            source: { kind: "monster", statBlockId: id },
            hp,
            inventory: [],
          }),
          position: target.position,
        },
        after: target.id,
      }),
    ];
  }
  const fortitude =
    target.hp > 0 &&
    remaining >= 0 &&
    !critical &&
    deriveStats(target, context).passives.some(
      (passive) =>
        passive.kind === "undeadFortitude" &&
        !(passive.except ?? ["radiant"]).includes(type),
    )
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
  const tried = fortitude
    ? null
    : enduredEvents(target, amount, remaining, { type, critical }, context);
  if (tried?.endured) return [...tried.rolled, ...tried.endured];
  const massive =
    target.side === "party" && remaining >= deriveStats(target, context).maxHp;
  const events: SystemEvent[] = [
    ...(fortitude?.events ?? []),
    ...(tried?.rolled ?? []),
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

// A hit that would drop the target to 0 Hit Points without killing it outright leaves it at 1 instead, or at a trait's
// `hp`, as Relentless Endurance or Relentless Rage do: the events, or null when nothing holds it. Death Ward comes
// first, then the target's own traits, then an ally's that hold for allies too, as Gift of the Protectors. `rolled`
// holds the saves tried on the way, which stand either way.
function enduredEvents(
  target: Actor,
  amount: number,
  remaining: number,
  hit: { readonly type: DamageType; readonly critical: boolean },
  context: Context,
): { rolled: SystemEvent[]; endured: SystemEvent[] | null } | null {
  if (target.hp <= 0 || remaining < 0) return null;
  const toOne = amount - remaining - 1;
  const ward = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "deathWard",
  );
  if (ward) {
    return {
      rolled: [],
      endured: [
        dndEvent(`${NS}:effectEnded`, {
          actor: target.id,
          sourceId: ward.sourceId,
        }),
        dndEvent(`${NS}:damaged`, {
          actor: target.id,
          amount: toOne,
          ...hit,
          massive: false,
        }),
      ],
    };
  }
  const stats = deriveStats(target, context);
  if (target.side === "party" && remaining >= stats.maxHp) return null;
  const bearers = [
    target,
    ...Object.values(context.state.actors).filter(
      (other) =>
        other.id !== target.id && other.side === target.side && !isDead(other),
    ),
  ];
  const rolled: SystemEvent[] = [];
  for (const bearer of bearers) {
    const own = deriveStats(bearer, context);
    for (const trait of own.passives) {
      if (
        trait.kind !== "dropToOne" ||
        (bearer !== target && !trait.allies) ||
        (bearer.resourcesSpent[trait.resource] ?? 0) >=
          (own.resources[trait.resource] ?? 0) ||
        trait.except?.includes(hit.type) ||
        (trait.notCritical && hit.critical) ||
        (trait.while &&
          !bearer.activeEffects.some(({ sourceId }) =>
            trait.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
          ))
      ) {
        continue;
      }
      if (trait.save) {
        const save = rollSave(
          target,
          trait.save.ability,
          trait.save.dc +
            (trait.save.step ?? 0) *
              (bearer.resourcesSpent[trait.resource] ?? 0) +
            (trait.save.plusDamage ? amount : 0),
          context,
        );
        rolled.push(...save.events);
        if (!save.saved) continue;
      }
      const hp = trait.hp
        ? Math.min(stats.maxHp, Math.max(1, evaluateFormula(trait.hp, own)))
        : 1;
      const endured = [
        dndEvent(`${NS}:resourceSpent`, {
          actor: bearer.id,
          resource: trait.resource,
        }),
        ...(trait.burst
          ? burstEvents(target, target, trait.burst, context)
          : []),
        dndEvent(`${NS}:damaged`, {
          actor: target.id,
          amount: toOne,
          ...hit,
          massive: false,
        }),
        ...(hp > 1
          ? [
              dndEvent(`${NS}:healed`, {
                actor: target.id,
                amount: hp - 1,
                max: stats.maxHp,
              }),
            ]
          : []),
        ...(trait.exhaustion
          ? [
              dndEvent(`${NS}:exhaustionChanged`, {
                actor: target.id,
                levels: trait.exhaustion,
              }),
            ]
          : []),
        ...trait.effects.map((modifier) =>
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: trait.resource,
              casterId: target.id,
              modifier,
              ends: "spellDuration",
            },
          }),
        ),
      ];
      return { rolled, endured };
    }
  }
  return { rolled, endured: null };
}

// A foe that just dropped to 0 Hit Points feeds its enemies' traits, as Dark One's Blessing.
// shortcut: the creature whose turn it is counts as the one that dropped it, as most damage comes on its own turn.
function killEvents(fallen: Actor, context: Context): SystemEvent[] {
  const turn = context.state.combat
    ? context.state.combat.order[context.state.combat.index]
    : undefined;
  return Object.values(context.state.actors).flatMap((bearer) => {
    if (bearer.side === fallen.side || isDown(bearer)) return [];
    const stats = deriveStats(bearer, context);
    return stats.passives.flatMap((passive) => {
      if (
        passive.kind !== "onKill" ||
        (passive.within !== undefined &&
          !(passive.mine && turn === bearer.id) &&
          distanceFeet(bearer.position, fallen.position) > passive.within) ||
        (passive.resource !== undefined &&
          (bearer.resourcesSpent[passive.resource] ?? 0) >=
            (stats.resources[passive.resource] ?? 0)) ||
        (passive.reaction &&
          (!bearer.budget.reaction ||
            hasCondition(bearer, ...INCAPACITATING))) ||
        (passive.oncePerTurn &&
          (bearer.usedThisTurn.includes(ON_KILL) ||
            hasCondition(bearer, ...INCAPACITATING))) ||
        (passive.marked && !markedBy(fallen, bearer, passive.marked))
      ) {
        return [];
      }
      // Keeper of Souls: the most hurt of the bearer and its allies near it, healed by the foe's Hit Dice.
      const to = passive.ally
        ? ([bearer, ...allies(context.state, bearer)]
            .filter(
              (item) =>
                !isDead(item) &&
                distanceFeet(bearer.position, item.position) <=
                  (passive.within ?? Infinity),
            )
            .map((item) => ({
              item,
              missing: deriveStats(item, context).maxHp - item.hp,
            }))
            .sort((a, b) => b.missing - a.missing)
            .find(({ missing }) => missing > 0)?.item ?? null)
        : bearer;
      if (!to) return [];
      const dice = hitDiceOf(fallen, context);
      const effects = passive.fallenHitDice
        ? passive.effects.map((effect) =>
            effect.kind === "heal"
              ? { ...effect, amount: { bonus: { base: dice, add: [] } } }
              : effect,
          )
        : passive.effects;
      return [
        ...(passive.oncePerTurn
          ? [
              dndEvent(`${NS}:oncePerTurnUsed`, {
                actor: bearer.id,
                key: ON_KILL,
              }),
            ]
          : []),
        ...(passive.resource
          ? [
              dndEvent(`${NS}:resourceSpent`, {
                actor: bearer.id,
                resource: passive.resource,
              }),
            ]
          : []),
        ...(passive.reaction
          ? [
              dndEvent(`${NS}:budgetSpent`, {
                actor: bearer.id,
                kind: "reaction",
              }),
            ]
          : []),
        ...leafEvents(effects, `onKill:${fallen.id}`, bearer, to, context),
      ];
    });
  });
}

const ON_KILL = "onKill";

// Effects from an activation with `transfers` move off a creature that drops to the foe nearest their caster.
function transferEvents(fallen: Actor, context: Context): SystemEvent[] {
  const { state } = context;
  const moved = new Set<string>();
  return fallen.activeEffects.flatMap((effect) => {
    const caster = state.actors[effect.casterId];
    const key = `${effect.casterId}|${effect.sourceId}`;
    if (!caster || isDown(caster) || moved.has(key)) return [];
    if (!effect.sourceId.startsWith("feature:")) return [];
    const feet = deriveStats(caster, context).actions.find(
      ({ id }) => id === effect.sourceId,
    )?.activation.transfers;
    if (feet === undefined) return [];
    moved.add(key);
    const [next] = Object.values(state.actors)
      .filter(
        (other) =>
          other.id !== fallen.id &&
          other.side !== caster.side &&
          !isDown(other) &&
          distanceFeet(caster.position, other.position) <= feet,
      )
      .sort(
        (a, b) =>
          distanceFeet(caster.position, a.position) -
          distanceFeet(caster.position, b.position),
      );
    if (!next) return [];
    const carried = fallen.activeEffects.filter(
      (item) =>
        item.sourceId === effect.sourceId && item.casterId === effect.casterId,
    );
    return [
      dndEvent(`${NS}:effectEnded`, {
        actor: fallen.id,
        sourceId: effect.sourceId,
        casterId: effect.casterId,
      }),
      ...carried.map((item) =>
        dndEvent(`${NS}:effectAdded`, { actor: next.id, effect: item }),
      ),
    ];
  });
}

// A check with the caster's spellcasting ability, as Dispel Magic's against a higher spell.
// shortcut: no reactions or rescues change the roll, as they may an ability check's (actions.ts abilityCheck).
function spellcastingCheck(
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

// A creature's number of Hit Dice: a character's level, or a monster's worked out from its Hit Points.
// shortcut: a stat block gives no Hit Dice here, so they come from its Hit Points over its size's die and Constitution.
function hitDiceOf(fallen: Actor, context: Context): number {
  const stats = deriveStats(fallen, context);
  if (fallen.source.kind === "character") return stats.level;
  const die = [2.5, 3.5, 4.5, 5.5, 6.5][sizeOf(fallen, context)] ?? 10.5;
  return Math.max(
    1,
    Math.round(stats.maxHp / Math.max(1, die + modifierFor(stats, "con"))),
  );
}

// Dropping to 0 Hit Points without dying: what keeps the creature conscious, as Rage beyond Death or Strength before
// Death, and what it calls, as Faithful Summons.
export function downedEvents(target: Actor, context: Context): SystemEvent[] {
  const stats = deriveStats(target, context);
  const left = (resource: string) =>
    (target.resourcesSpent[resource] ?? 0) < (stats.resources[resource] ?? 0);
  const events: SystemEvent[] = [];
  for (const passive of stats.passives) {
    if (passive.kind === "whenDowned" && left(passive.resource)) {
      events.push(...calledEvents(target, passive, context));
    }
    if (passive.kind !== "fightOn" || fightingOn(target)) continue;
    if (passive.while) {
      const rage = target.activeEffects.find(({ sourceId }) =>
        passive.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
      );
      if (!rage) continue;
      events.push(
        dndEvent(`${NS}:effectAdded`, {
          actor: target.id,
          effect: {
            ...rage,
            modifier: { kind: "fightingOn", delayDeath: true },
          },
        }),
      );
    } else if (
      passive.resource &&
      left(passive.resource) &&
      target.budget.reaction
    ) {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: target.id,
          resource: passive.resource,
        }),
        dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
        dndEvent(`${NS}:effectAdded`, {
          actor: target.id,
          effect: {
            sourceId: `fightOn:${passive.resource}`,
            casterId: target.id,
            modifier: { kind: "fightingOn" },
            ends: "casterNextTurnEnd",
          },
        }),
      );
    }
    if (events.length > 0) break;
  }
  return events;
}

// A `whenDowned` trait's effects, spending its use.
function calledEvents(
  target: Actor,
  passive: Extract<Passive, { kind: "whenDowned" }>,
  context: Context,
): SystemEvent[] {
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: target.id,
      resource: passive.resource,
    }),
    ...passive.effects.flatMap((effect) =>
      effect.kind === "animate"
        ? animatedEvents(effect, target, context)
        : leafEvents([effect], passive.resource, target, target, context),
    ),
  ];
}

// Incapacitated by a foe: a `whenDowned` trait with `incapacitated` answers it, as Faithful Summons does.
export function incapacitatedEvents(
  target: Actor,
  caster: Actor,
  condition: Condition,
  context: Context,
): SystemEvent[] {
  if (caster.side === target.side || !INCAPACITATING.includes(condition)) {
    return [];
  }
  const stats = deriveStats(target, context);
  const passive = stats.passives.find(
    (item) =>
      item.kind === "whenDowned" &&
      item.incapacitated &&
      (target.resourcesSpent[item.resource] ?? 0) <
        (stats.resources[item.resource] ?? 0),
  );
  return passive?.kind === "whenDowned"
    ? calledEvents(target, passive, context)
    : [];
}

// Damage to each foe of `source` within `radius` feet of `origin`, halved by a save against the source's spell save
// DC when there is one, as Necrotic Husk's Unholy Resuscitation, and with `blind` Blinded until the origin's turn ends,
// as Searing Vengeance. shortcut: no Concentration saves or reactions follow, as for a trap's damage.
export function burstEvents(
  origin: Actor,
  source: Actor,
  burst: {
    readonly radius: number;
    readonly save?: Ability | undefined;
    readonly damage: Amount;
    readonly type: DamageType;
    readonly blind?: boolean;
  },
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(source, context);
  const dc = spellSaveDc(stats);
  return Object.values(context.state.actors).flatMap((foe) => {
    if (
      foe.side === source.side ||
      isDead(foe) ||
      !foe.position ||
      distanceFeet(origin.position, foe.position) > burst.radius
    ) {
      return [];
    }
    const save = burst.save
      ? rollSave(foe, burst.save, dc, context, true)
      : { saved: false, events: [] };
    const rolled = rollAmount(burst.damage, stats, context.dice);
    return [
      ...save.events,
      ...dealEvents(
        foe,
        [{ amount: save.saved ? halved(rolled) : rolled, type: burst.type }],
        false,
        context,
      ).events,
      ...(burst.blind
        ? [
            dndEvent(`${NS}:effectAdded`, {
              actor: foe.id,
              effect: {
                sourceId: `${source.id}:burst`,
                casterId: origin.id,
                modifier: { kind: "condition", condition: "blinded" },
                ends: "casterTurnEnd",
              },
            }),
          ]
        : []),
    ];
  });
}

// A Ring of Spell Turning's Reaction: a spell that targeted only the bearer, with no area, is cast back at its caster,
// who saves against its own spell save DC. The player is asked first. shortcut: it comes back at the spell's own
// level, whatever slot it took, and not at all when the caster can't cast it again as an action of its own.
function deflectedSpell(
  action: KnownAction,
  caster: Actor,
  target: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const none = { events: [], frames: [] };
  const { targeting } = action.activation;
  if (
    target.id === caster.id ||
    !("creatures" in targeting) ||
    targeting.creatures !== 1 ||
    !target.budget.reaction ||
    hasCondition(target, ...INCAPACITATING) ||
    !deriveStats(target, context).passives.some(
      (passive) => passive.kind === "spellTurning" && passive.deflect,
    ) ||
    !deriveStats(caster, context).actions.some(
      (item) => item.id === action.id,
    ) ||
    (target.id === PLAYER_ACTOR &&
      !playerTakes(
        "spellTurning",
        `You save against ${caster.name}'s ${action.name}. Turn it back with Spell Turning?`,
        { ...action, id: "spellTurning", name: "Spell Turning" },
        context,
      ))
  ) {
    return none;
  }
  return {
    events: [
      dndEvent(`${NS}:budgetSpent`, {
        actor: target.id,
        kind: "reaction",
        label: "Spell Turning",
      }),
    ],
    frames: [
      frame("useAction", {
        actor: caster.id,
        actionId: action.id,
        target: caster.id,
        anyone: true,
        free: true,
      }),
    ],
  };
}

// Boon Companions' Bands: an area that makes creatures save spares the one wearing the band paired with the
// caster's, spending the caster's use.
function pairedBandSpares(
  action: KnownAction,
  caster: Actor,
  stats: Stats,
  targets: readonly Actor[],
  context: Context,
): { readonly spared: readonly string[]; readonly events: SystemEvent[] } {
  const none = { spared: [], events: [] };
  if (!("area" in action.activation.targeting)) return none;
  for (const band of stats.passives) {
    if (
      band.kind !== "pairedBand" ||
      (caster.resourcesSpent[band.resource] ?? 0) >=
        (stats.resources[band.resource] ?? 0)
    ) {
      continue;
    }
    const partner = targets.find(
      (target) =>
        target.id !== caster.id &&
        target.side === caster.side &&
        deriveStats(target, context).passives.some(
          (passive) =>
            passive.kind === "pairedBand" && passive.item === band.item,
        ),
    );
    if (partner) {
      return {
        spared: [partner.id],
        events: [
          dndEvent(`${NS}:resourceSpent`, {
            actor: caster.id,
            resource: band.resource,
          }),
        ],
      };
    }
  }
  return none;
}

// A Saddle of the Cavalier's Protected Mount: attacks against a mount whose rider sits in it have Disadvantage.
export function protectedMount(
  target: Actor,
  context: Pick<Context, "state" | "content" | "contentIds">,
): boolean {
  return Object.values(context.state.actors).some(
    (rider) =>
      mountOf(rider) === target.id &&
      !isDown(rider) &&
      hasPassive(deriveStats(rider, context), "protectedMount"),
  );
}

// Several hits on one target, reported in turn so each one sees the HP the last one left.
// Tyro of the Gauntlet's Stand as One: an ally within 5 feet spends its Reaction to keep the target from being moved.
export function heldInPlace(
  target: Actor,
  context: Pick<Context, "state" | "content" | "contentIds">,
): SystemEvent[] {
  if (hasCondition(target, ...INCAPACITATING)) return [];
  // A Saddle of the Cavalier's Secure Rider: nothing moves its rider off its mount.
  if (
    mountOf(target) !== null &&
    hasPassive(deriveStats(target, context), "protectedMount")
  ) {
    return [
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: target.id,
        key: "secure-rider",
      }),
    ];
  }
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
  for (const hit of hits) {
    const current = state.actors[target.id] ?? target;
    const reduced = reducedHit(current, hit.amount, hit.type, {
      ...context,
      state,
    });
    // A reaction such as Vitality Ward may lessen it before it lands.
    const lessened = beforeDamage(current, reduced.amount, hit.type, {
      ...context,
      state,
    });
    const { amount, type } = { ...hit, amount: lessened.amount };
    for (const event of [
      ...reduced.events,
      ...lessened.events,
      ...damageEvents(current, amount, type, critical, { ...context, state }),
    ]) {
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
    events.push(...killEvents(target, { ...context, state }));
    events.push(...transferEvents(target, { ...context, state }));
    if (!isDead(hurt))
      events.push(...downedEvents(hurt, { ...context, state }));
  }
  const resaved = new Set<string>();
  for (const effect of dealt > 0 ? (hurt?.activeEffects ?? []) : []) {
    if (!hurt || !effect.saveOnDamage) continue;
    // One save for each source, as Hideous Laughter's Prone and Incapacitated end together.
    const key = `${effect.sourceId}|${effect.casterId}`;
    if (resaved.has(key)) continue;
    resaved.add(key);
    const save = rollSave(
      hurt,
      effect.saveOnDamage.ability,
      effect.saveOnDamage.dc,
      { ...context, state },
      effect.sourceId.startsWith("spell:"),
      0,
      [],
      false,
      effect.saveOnDamage.advantage === true,
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
  // Cackle Fever: damage other than Psychic sets off a fit of laughter on a failed save (environment.ts).
  const fits = hurt?.activeEffects.find(
    ({ modifier }) => modifier.kind === "laughter",
  );
  if (
    hurt &&
    dealt > 0 &&
    fits?.modifier.kind === "laughter" &&
    !isDead(hurt) &&
    !hasCondition(hurt, "incapacitated") &&
    hits.some(({ type, amount }) => type !== "psychic" && amount > 0)
  ) {
    const { dc, damage } = fits.modifier;
    const save = rollSave(hurt, "con", dc, { ...context, state });
    events.push(...save.events);
    if (!save.saved) {
      const laughed = dealEvents(
        hurt,
        damage.map(({ amount, type }) => ({
          amount: amount.dice ? rollDiceNotation(amount.dice, context.dice) : 0,
          type,
        })),
        false,
        { ...context, state },
      );
      events.push(
        ...laughed.events,
        dndEvent(`${NS}:effectAdded`, {
          actor: hurt.id,
          effect: {
            sourceId: `${fits.sourceId}:laughter`,
            casterId: hurt.id,
            modifier: { kind: "condition", condition: "incapacitated" },
            ends: "spellDuration",
            repeatSave: { ability: "con", dc },
            ...lastsFor({ minutes: 1 }, hurt, hurt, state),
          },
        }),
      );
    }
  }
  return { events, dealt };
}

// Resistance (the cantrip): damage of the type picked is cut by a die, once a turn. A worn item's cuts it every time,
// as a Ring of Warmth's 2d8 off Cold damage.
function reducedHit(
  target: Actor,
  amount: number,
  type: Damage["type"],
  context: Context,
): { amount: number; events: SystemEvent[] } {
  const targetStats = deriveStats(target, context);
  const worn = passiveModifiers(targetStats.passives).find(
    (modifier) =>
      modifier.kind === "damageReduction" && modifier.damage === type,
  );
  if (worn?.kind === "damageReduction" && amount > 0) {
    amount = Math.max(
      0,
      amount - rollAmount(worn.amount, targetStats, context.dice),
    );
  }
  const effect = target.activeEffects.find(
    ({ modifier }) =>
      modifier.kind === "damageReduction" && modifier.damage === type,
  );
  const { combat } = context.state;
  if (effect?.modifier.kind !== "damageReduction" || amount <= 0) {
    return { amount, events: [] };
  }
  // usedThisTurn clears only as the bearer's own turn starts, so the key names the turn.
  const key = `${effect.sourceId}@${String(combat?.round ?? 0)}:${String(combat?.index ?? 0)}`;
  if (target.usedThisTurn.includes(key)) return { amount, events: [] };
  const cut = rollAmount(
    effect.modifier.amount,
    deriveStats(target, context),
    context.dice,
  );
  return {
    amount: Math.max(0, amount - cut),
    events: [dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key })],
  };
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

// An hour or more without Concentration outlasts the fight, counted down by rests after it (rest.ts).
// shortcut: anything shorter ends with the fight, as the scenes between fights take longer than ten minutes.
export function lingersFor(duration: Duration): {
  lingers?: number;
} {
  return typeof duration === "object" &&
    "minutes" in duration &&
    !("concentration" in duration) &&
    duration.minutes >= 60
    ? { lingers: Math.floor(duration.minutes / 60) }
    : {};
}

// A timed spell's minutes, and a turn of the target's, are counted in rounds by its `lasts` (lastsFor).
export function effectEnds(
  duration: Duration,
): "concentration" | "casterNextTurn" | "casterNextTurnEnd" | "spellDuration" {
  if (typeof duration !== "object") return "casterNextTurn";
  if ("until" in duration) {
    if (duration.until === "yourNextTurnEnd") return "casterNextTurnEnd";
    return duration.until === "yourNextTurnStart"
      ? "casterNextTurn"
      : "spellDuration";
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
  hitWith?: KnownAction, // the attack that hit, for a rider limited to some hits
): SystemEvent[] {
  const { combat } = context.state;
  return stats.passives.flatMap((passive, index) => {
    if (passive.kind !== "damageRider") return [];
    if (passive.damage !== undefined && !types.has(passive.damage)) return [];
    if (
      passive.with &&
      !(hitWith && hitFits(passive.with, hitWith, attacker, context))
    ) {
      return [];
    }
    // A hit during the target's own turn is an Opportunity Attack.
    if (passive.opportunity && combat?.order[combat.index] !== target.id) {
      return [];
    }
    if (spell && !passive.spells) return [];
    if (passive.critical && !critical) return [];
    if (passive.while && !underEffect(attacker, passive.while)) return [];
    if (passive.firstRound && (combat?.round ?? 1) > 1) return [];
    if (passive.ownTurn && combat?.order[combat.index] !== attacker.id) {
      return [];
    }
    const key =
      passive.damage === undefined
        ? `rider:${String(index)}`
        : `rider:${passive.damage}:${String(passive.critical)}`;
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

// Healing shared among the targets, as Mass Heal: rolled once, then given out to the most hurt first, each as much
// as it can take, so each target's own heal is its share.
export function sharedHealing(
  effects: readonly LeafEffect[],
  targets: readonly Actor[],
  caster: Actor,
  context: Context,
): (target: Actor) => readonly LeafEffect[] {
  // shortcut: Temporary Hit Points to divide go evenly, as the caster may share them out any way.
  const split = effects.find(
    (effect) => effect.kind === "tempHp" && effect.divided,
  );
  if (split?.kind === "tempHp") {
    const each = Math.floor(
      rollAmount(split.amount, deriveStats(caster, context), context.dice) /
        Math.max(1, targets.length),
    );
    return () =>
      effects.map((effect) =>
        effect === split
          ? {
              kind: "tempHp" as const,
              amount: { bonus: { base: each, add: [] } },
            }
          : effect,
      );
  }
  const divided = effects.find(
    (effect) => effect.kind === "heal" && effect.divided,
  );
  if (divided?.kind !== "heal") return () => effects;
  const room = (target: Actor): number => {
    const max = deriveStats(target, context).maxHp;
    return Math.max(
      0,
      (divided.half ? Math.floor(max / 2) : max) - Math.max(target.hp, 0),
    );
  };
  let left = rollAmount(
    divided.amount,
    deriveStats(caster, context),
    context.dice,
  );
  const shares = new Map<string, number>();
  for (const target of [...targets].sort((a, b) => room(b) - room(a))) {
    const share = Math.min(left, room(target));
    shares.set(target.id, share);
    left -= share;
  }
  // No share, no heal, so a dying creature's death saves stand.
  return (target) =>
    effects.flatMap((effect) => {
      if (effect !== divided) return [effect];
      const share = shares.get(target.id) ?? 0;
      return share > 0
        ? [
            {
              kind: "heal" as const,
              amount: { bonus: { base: share, add: [] } },
            },
          ]
        : [];
    });
}

const FORTIFIED = "fortified-health";

const MEAN: Dice = { below: () => 0, roll: (sides) => (sides + 1) / 2 };

// A healing pool spends one of its resource for each `amount` it heals: as many as fill `room`, never more than
// are left or than `most` allows, as Lay On Hands' Hit Points or Healing Light's dice.
export function poolHealing(
  pool: { readonly resource: string; readonly most?: Formula | undefined },
  amount: Amount,
  room: number,
  caster: Actor,
  stats: Stats,
  dice: Dice,
): { resource: string; spent: number; healed: number } {
  const left =
    (stats.resources[pool.resource] ?? 0) -
    (caster.resourcesSpent[pool.resource] ?? 0);
  const each = Math.max(1, rollAmount(amount, stats, MEAN));
  const spent = Math.max(
    0,
    Math.min(
      left,
      pool.most ? Math.max(1, evaluateFormula(pool.most, stats)) : left,
      Math.ceil(room / each),
    ),
  );
  let healed = 0;
  for (let index = 0; index < spent; index += 1) {
    healed += rollAmount(amount, stats, dice);
  }
  return { resource: pool.resource, spent, healed };
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
      case "heal": {
        if (unhealed || cannotHeal(target)) break;
        const max = deriveStats(target, context).maxHp + raisedMax;
        const room = Math.max(
          0,
          (effect.half ? Math.floor(max / 2) : max) - Math.max(target.hp, 0),
        );
        // Circle of Mortality: dice healing a creature at 0 Hit Points give their highest faces.
        const dice =
          target.hp <= 0 && hasPassive(stats, "maxHealingAtZero")
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
        const rolled = effect.full
          ? max
          : (pool?.healed ?? rollAmount(effect.amount, stats, dice));
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
            effect.count,
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
              ...lingersFor(effect.duration),
              ...swallowed,
            },
          }),
        );
        if (effect.modifier.kind === "hasted") {
          const waiting = lethargyEffect(sourceId, caster.id, target);
          if (waiting) events.push(waiting);
        }
        if (effect.modifier.kind === "actionLimit") {
          events.push(
            ...limitEvents(
              target,
              effect.modifier,
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
              modifier.condition === effect.condition,
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
              ...(effect.failExhaustion
                ? { failExhaustion: true as const }
                : {}),
              ...(effect.clings && conditionSave
                ? { clings: conditionSave }
                : {}),
              ...lingersFor(effect.duration),
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
          );
        }
        // Being Incapacitated ends Concentration; with Boon of the Iron Mind only Petrified or Unconscious does.
        if (
          INCAPACITATING.includes(effect.condition) &&
          target.concentratingOn !== null &&
          (["petrified", "unconscious"].includes(effect.condition) ||
            !deriveStats(target, context).passives.some(
              (passive) =>
                passive.kind === "unshakableFocus" && !passive.spells,
            ))
        ) {
          events.push(
            dndEvent(`${NS}:concentrationEnded`, { actor: target.id }),
          );
        }
        events.push(
          ...incapacitatedEvents(target, caster, effect.condition, context),
        );
        break;
      }
      case "removeCondition": {
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
            ),
          );
        }
        break;
      }
      case "dispel": {
        events.push(
          ...dispelEvents(
            target,
            effect.maxLevel,
            context.state,
            context,
            effect.hostile,
            effect.check && stats.spellAbility
              ? (dc) => spellcastingCheck(caster, stats, dc, context)
              : undefined,
          ),
        );
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
        const to =
          (effect.maxSize === undefined ||
            sizeOf(target, context) <= SIZES.indexOf(effect.maxSize)) &&
          (effect.largerBy === undefined ||
            sizeOf(target, context) <=
              sizeOf(caster, context) + effect.largerBy)
            ? pushTo(
                caster.position,
                target,
                effect.feet,
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
      case "exhaustion":
        events.push(
          dndEvent(`${NS}:exhaustionChanged`, {
            actor: target.id,
            levels: effect.levels,
          }),
        );
        break;
      // On a failed save, or a creature already at 0 Hit Points, as Steal Body or Consume Life. An automatic one
      // is worked out with its damage (resolveAction).
      case "slay":
        if (!isDead(target) && target.hp <= effect.hpAtMost) {
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
        events.push(...dropEvents(target, context));
        break;
      case "sendAway":
        events.push(
          ...sendAwayEvents(effect, sourceId, caster, target, context),
        );
        break;
      case "note":
      case "disperse":
      case "animate":
      case "reactionAttack":
      case "reactionMove":
      case "randomAction":
      case "raiseCorpse":
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
      case "strike":
      case "redirect":
      case "drawAttack":
      case "negateHit":
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
        // A note is only for reading. Reduced damage is worked out by the reaction that holds up the hit, and
        // a teleport's square by its own decision and a zone once for the whole spell (resolveAction).
        break;
      default:
        effect satisfies never;
    }
  }
  return events;
}

// The owner's familiar within range takes the commanded action with its Reaction, as with Energy Pulse.
export function commandedFamiliar(
  effect: Extract<LeafEffect, { kind: "commandFamiliar" }>,
  owner: Actor,
  state: DndState,
): Actor | null {
  return (
    Object.values(state.actors).find(
      (item) =>
        familiarOwner(item) === owner.id &&
        !isDown(item) &&
        item.budget.reaction &&
        !hasCondition(item, ...INCAPACITATING) &&
        distanceFeet(owner.position, item.position) <= effect.range,
    ) ?? null
  );
}

function commandedResult(
  effect: Extract<LeafEffect, { kind: "commandFamiliar" }>,
  owner: Actor,
  context: Context,
): SystemResult {
  const familiar = commandedFamiliar(effect, owner, context.state);
  const action =
    familiar &&
    deriveStats(familiar, context).actions.find(
      (item) => item.name === effect.action,
    );
  if (!familiar || !action) return {};
  const result = resolveAction(
    action,
    familiar,
    resolveTargets(ALL, action, familiar, context),
    context,
  );
  return {
    events: [...payCosts(action, familiar, context), ...(result.events ?? [])],
    frames: result.frames ?? [],
  };
}

// The zones a spell leaves, once for the whole cast, where the area was aimed or round the caster, whoever it
// caught. Its area's save DC is fixed as cast; a wall rings the area with squares no one can pass.
function zoneEvents(
  effects: readonly LeafEffect[],
  action: KnownAction,
  actor: Actor,
  context: Context,
  aim: Square | undefined,
  slotLevel: number | undefined,
): SystemEvent[] {
  const at = aim ?? actor.position;
  if (!at) return [];
  const stats = deriveStats(actor, context);
  const placed = new Set<string>();
  const events: SystemEvent[] = [];
  const { targeting } = action.activation;
  const wind = effects.find((effect) => effect.kind === "disperse");
  if (wind?.kind === "disperse" && "area" in targeting) {
    const { shape, radius } = targeting.area;
    // shortcut: Sunburst ends any Darkness zone, as a monster's own Darkness is a spell too.
    const ends = (zone: ReturnType<typeof zonesOf>[number]): boolean =>
      wind.zones
        ? wind.zones.includes(zone.zone)
        : zone.zone === "fog" || zone.area?.disperses === true;
    for (const zone of zonesOf(context.state)) {
      if (ends(zone) && inArea(shape, radius, actor.position, at, zone.at)) {
        events.push(
          dndEvent(`${NS}:effectEnded`, {
            actor: zone.owner,
            sourceId: zone.sourceId,
            casterId: zone.owner,
          }),
        );
      }
    }
  }
  const above = Math.max(0, (slotLevel ?? 0) - (action.spellLevel ?? 0));
  const printed = action.activation.area;
  // A higher slot widens what the area shields, as Globe of Invulnerability's.
  const area =
    printed?.shieldGrows && printed.spellShield !== undefined
      ? { ...printed, spellShield: Math.min(9, printed.spellShield + above) }
      : printed;
  // Its saves' DCs are fixed as cast.
  const fixed = (printed: Resolution | undefined): Resolution | undefined =>
    printed?.kind === "save"
      ? {
          ...printed,
          dc: { base: evaluateFormula(printed.dc, stats), add: [] },
        }
      : printed;
  const element = (
    effects.find((effect) => effect.kind === "zone" && effect.choose) as
      Extract<LeafEffect, { kind: "zone" }> | undefined
  )?.choose;
  const type = element ? leastResisted(element, actor, context) : undefined;
  const resolution = retyped(fixed(area?.resolution), type);
  const holding = retyped(fixed(area?.holding), type);
  // A wall's layers go on the wall alone, their DCs fixed too.
  const { layers, ...kept } = area ?? {};
  const fixedLayers = layers?.flatMap((layer) => fixed(layer) ?? []);
  for (const effect of effects) {
    if (effect.kind !== "zone") continue;
    // A higher slot widens it, as Fog Cloud's 20 feet a level.
    const radius = effect.radius + (effect.perSlot ?? 0) * above;
    const key = `${effect.zone}|${String(radius)}`;
    if (placed.has(key)) continue;
    placed.add(key);
    if (effect.zone === "darkness") {
      events.push(...snuffedLights(at, radius, context));
    }
    const centre = effect.follows ? (actor.position ?? at) : at;
    const wall =
      effect.zone === "wall"
        ? wallRing(centre, radius, context, effect.walls !== "sight")
        : null;
    events.push(
      ...(wall?.pushed ?? []),
      ...(wall && effect.escape
        ? wallEscapes(
            centre,
            radius,
            effect.escape,
            actor,
            wall.squares,
            context,
          )
        : []),
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId: spellSource(action),
          casterId: actor.id,
          ...(slotLevel === undefined ? {} : { level: slotLevel }),
          modifier: {
            kind: "zone",
            zone: effect.zone,
            at: centre,
            radius,
            ...(effect.damage ? { damage: effect.damage } : {}),
            ...(effect.follows ? { follows: true as const } : {}),
            ...(area && !effect.bare
              ? {
                  area: {
                    ...kept,
                    ...(resolution ? { resolution } : {}),
                    ...(holding ? { holding } : {}),
                  },
                }
              : {}),
            ...(wall ? { blocks: wall.squares } : {}),
            ...(wall && effect.walls ? { walls: effect.walls } : {}),
            ...(wall && fixedLayers ? { layers: fixedLayers } : {}),
            name: action.name,
          },
          ends: effectEnds(effect.duration),
          ...lastsFor(effect.duration, actor, actor, context.state),
        },
      }),
    );
  }
  return events;
}

// The damage type of `types` its foes in the fight resist least, as a caster picking Conjure Elemental's element.
// The area starts with it, and the caster is then asked (combat/damage-choice.ts).
export function leastResisted(
  types: readonly DamageType[],
  caster: Actor,
  context: Context,
): DamageType {
  const foes = enemies(context.state, caster).filter((foe) => !isDead(foe));
  const worth = (type: DamageType): number =>
    foes.reduce((sum, foe) => {
      const responses = damageResponses(foe, context);
      return (
        sum +
        (responses.immunities.includes(type) || responses.absorbs.includes(type)
          ? 0
          : responses.resistances.includes(type)
            ? 1
            : responses.vulnerabilities.includes(type)
              ? 3
              : 2)
      );
    }, 0);
  const [best = types[0] ?? "force"] = [...types].sort(
    (a, b) => worth(b) - worth(a),
  );
  return best;
}

// Of these types, the one a creature takes most from: vulnerable, then plain, then resisted, never immune if another
// will do, as Chromatic Orb's caster picks.
export function typeAgainst(
  types: readonly DamageType[],
  responses: ReturnType<typeof damageResponses>,
): DamageType {
  const worth = (type: DamageType): number =>
    responses.immunities.includes(type) || responses.absorbs.includes(type)
      ? 0
      : responses.resistances.includes(type)
        ? 1
        : responses.vulnerabilities.includes(type)
          ? 3
          : 2;
  const [best = types[0] ?? "force"] = [...types].sort(
    (a, b) => worth(b) - worth(a),
  );
  return best;
}

// A resolution whose damage all takes `type`, when one was picked.
export function retyped(
  resolution: Resolution | undefined,
  type: DamageType | undefined,
): Resolution | undefined {
  if (!resolution || !type) return resolution;
  return {
    ...resolution,
    damage: resolution.damage.map((item) => ({ ...item, type })),
  };
}

// Moves the bearer's area of a spell to `to`, with the ticks on whoever it moves onto, as Moonbeam's.
function movedZone(
  source: string,
  actor: Actor,
  to: Square,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const zones = zonesOf(context.state).filter(
    (zone) => zone.owner === actor.id && zone.sourceId === source,
  );
  if (zones.length === 0) return { events: [], frames: [] };
  return {
    events: [
      dndEvent(`${NS}:zoneMoved`, { actor: actor.id, sourceId: source, to }),
    ],
    frames: zones.flatMap((zone) =>
      movedFrames({ ...zone, at: to }, zone.at, context),
    ),
  };
}

// A creature the wall shuts in can save to get out first, spending its Reaction on a walk to the nearest open square
// outside, as Wall of Stone allows. shortcut: only the caster's foes try, since its friends would rather stay.
function wallEscapes(
  centre: Square,
  radius: number,
  ability: Ability,
  caster: Actor,
  wall: readonly string[],
  context: Context,
): SystemEvent[] {
  const { state } = context;
  const grid = state.combat?.grid;
  if (!grid) return [];
  const dc = evaluateFormula(
    { base: 0, add: [{ kind: "spellSaveDc" }] },
    deriveStats(caster, context),
  );
  const shut = new Set([...blockedSquares(state, "walking"), ...wall]);
  const taken = new Set(
    Object.values(state.actors).flatMap((item) =>
      item.position && !isDead(item) ? [squareKey(item.position)] : [],
    ),
  );
  const events: SystemEvent[] = [];
  for (const item of Object.values(state.actors)) {
    const at = item.position;
    if (
      !at ||
      isDown(item) ||
      item.side === caster.side ||
      !item.budget.reaction ||
      distanceFeet(centre, at) >= radius
    ) {
      continue;
    }
    const saved = rollSave(item, ability, dc, context);
    events.push(...saved.events);
    if (!saved.saved) continue;
    const reach = walkSpeed(item, deriveStats(item, context));
    let best: Square | null = null;
    for (let x = 0; x < grid.width; x += 1) {
      for (let y = 0; y < grid.height; y += 1) {
        const square = { x, y };
        const key = squareKey(square);
        if (distanceFeet(centre, square) <= radius || shut.has(key)) continue;
        if (taken.has(key) || distanceFeet(at, square) > reach) continue;
        if (!best || distanceFeet(at, square) < distanceFeet(at, best)) {
          best = square;
        }
      }
    }
    if (!best) continue;
    taken.add(squareKey(best));
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: item.id, kind: "reaction" }),
      dndEvent(`${NS}:moved`, { actor: item.id, to: best, feet: 0 }),
    );
  }
  return events;
}

// A wall's squares: the edge of the area round `centre`. A creature standing on one that stops walking is pushed one
// square in, and where there's no room it stays, leaving a gap; one that only stops sight, as fire, it stands in.
function wallRing(
  centre: Square,
  radius: number,
  context: Context,
  pushes: boolean,
): { readonly squares: string[]; readonly pushed: SystemEvent[] } {
  const { state } = context;
  const grid = state.combat?.grid;
  if (!grid) return { squares: [], pushed: [] };
  const taken = new Map(
    Object.values(state.actors).flatMap((item) =>
      item.position && !isDead(item)
        ? [[squareKey(item.position), item] as const]
        : [],
    ),
  );
  const walls = new Set([
    ...blockedSquares(state, "walking"),
    ...blockedSquares(state, "sight"),
  ]);
  const squares: string[] = [];
  const pushed: SystemEvent[] = [];
  const reach = Math.floor(radius / 5);
  for (let x = centre.x - reach; x <= centre.x + reach; x += 1) {
    for (let y = centre.y - reach; y <= centre.y + reach; y += 1) {
      const square = { x, y };
      const outside = x < 0 || y < 0 || x >= grid.width || y >= grid.height;
      if (outside || distanceFeet(centre, square) !== radius) continue;
      const key = squareKey(square);
      if (walls.has(key)) continue;
      const standing = pushes ? taken.get(key) : undefined;
      if (standing) {
        const inward = {
          x: x - Math.sign(x - centre.x),
          y: y - Math.sign(y - centre.y),
        };
        const inwardKey = squareKey(inward);
        if (taken.has(inwardKey) || walls.has(inwardKey)) continue;
        taken.delete(key);
        taken.set(inwardKey, standing);
        pushed.push(
          dndEvent(`${NS}:moved`, { actor: standing.id, to: inward, feet: 0 }),
        );
      }
      squares.push(key);
    }
  }
  return { squares, pushed };
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
): { readonly saved: boolean; readonly events: SystemEvent[] } {
  if (
    (ability === "str" || ability === "dex") &&
    hasCondition(target, "paralyzed", "petrified", "stunned", "unconscious")
  ) {
    return { saved: false, events: [] };
  }
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
      ) ||
      (ability === "dex" && hasCondition(target, "restrained")) ||
      stats.passives.some(
        (passive) =>
          passive.kind === "saveDisadvantage" &&
          passive.conditions.some((condition) =>
            conditions.includes(condition),
          ),
      ),
  };
  const roll = rollD20(context.dice, {
    ...edge,
    rerollOnes: hasPassive(stats, "rerollOnes"),
  });
  const base =
    saveBonus(stats, ability) +
    rollBonus(target, "saves", context, undefined, ability) +
    (ability === "dex" ? cover : 0);
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
  return { saved, events: [...settled.events, rolled, ...spent] };
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
  // Revivify is the one aimed at the dead.
  const dead = "dead" in targeting && targeting.dead === true;
  const side = (
    targeting.side === "enemy"
      ? enemies(state, actor)
      : targeting.side === "ally"
        ? allies(state, actor)
        : [...enemies(state, actor), ...allies(state, actor)]
  ).filter(
    (item) =>
      isDead(item) === dead &&
      deadWithin(item, targeting) &&
      fitsType(item, targeting, context, actor),
  );
  if ("area" in targeting) {
    const { shape, radius } = targeting.area;
    // Aimed at a square ("@x,y") or a creature ("@id"), an area catches everyone in it, the caster's side too.
    const aim = aimSquare(answerTarget, state);
    if (aim && actor.position) {
      // Total cover from where it spreads keeps a creature out of it.
      const centre =
        shape === "sphere" || shape === "cube" ? aim : actor.position;
      // Creatures of the caster's choice in it are only its side, as Conjure Barrage's.
      const chosen = targeting.choice
        ? new Set(side.map((item) => item.id))
        : null;
      return caughtBy(
        targeting,
        actor,
        aim,
        areaPool(targeting, context, actor),
      ).filter(
        (item) =>
          (chosen === null || chosen.has(item.id)) &&
          (item.id === actor.id ||
            (coverFor(state, centre, item, [actor.id]) !== "total" &&
              !walledApart(actor, item, action, state, context))),
      );
    }
    // Round the caster, or with no grid: only the side it's meant for, as if placed with care.
    return side.filter(
      (item) =>
        inArea(shape, radius, actor.position, actor.position, item.position) &&
        !walledApart(actor, item, action, state, context),
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
  aimedAt: readonly Actor[],
  context: Context,
  slotLevel?: number,
  critical = false,
  aim?: Square, // where an area was aimed, for a zone it leaves
): SystemResult {
  const { resolution } = action.activation;
  const stats = deriveStats(actor, context);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  // A helmed horror's Spell Immunity: the spells it names pass it by.
  const spell = isSpell(action, actor, context) ? action.name : null;
  const targets = spell
    ? sculpted(
        aimedAt.filter(
          (target) => !immuneToSpell(target, spell, context, action),
        ),
        action,
        actor,
        stats,
      )
    : aimedAt;
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
  // Ending what the action it needs left on the target, as Quivering Palm's end.
  const { targeting } = action.activation;
  const afflicting =
    action.activation.endsAffliction && "afflicted" in targeting
      ? stats.actions.find(({ name }) => name === targeting.afflicted)?.id
      : undefined;
  if (afflicting) {
    events.push(
      ...targets.map((target) =>
        dndEvent(`${NS}:effectEnded`, {
          actor: target.id,
          sourceId: afflicting,
          casterId: actor.id,
        }),
      ),
    );
  }
  // One creature at a time: used again, it leaves the last one.
  if (action.activation.oneTarget) {
    for (const other of Object.values(context.state.actors)) {
      if (
        !targets.some(({ id }) => id === other.id) &&
        other.activeEffects.some(
          (item) => item.sourceId === action.id && item.casterId === actor.id,
        )
      ) {
        events.push(
          dndEvent(`${NS}:effectEnded`, {
            actor: other.id,
            sourceId: action.id,
            casterId: actor.id,
          }),
        );
      }
    }
  }
  if (spell) events.push(...duelBroken(actor, targets, context.state));

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
    if (!usesConcentration(effects) && !action.concentrates) return;
    // An area acting later, at no cost, keeps the Concentration its spell began, as Conjure Elemental's spirit
    // restraining. A recast still begins it anew.
    if (
      action.activation.cost.length === 0 &&
      actor.concentratingOn === spellSource(action)
    ) {
      return;
    }
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
  let lastDealt = 0;
  const pulled = new Set<string>(); // Pull of Death's once a turn, within this cast
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
          piercing(
            damageResponses(target, context),
            mastered,
            stats,
            action.id,
          ),
        ),
        type,
      })),
      false,
      context,
    );
    lastDealt = result.dealt;
    events.push(
      ...result.events,
      ...insideDamageEvents(actor, target, result.dealt),
      ...duelDamaged(actor, target, result.dealt, context.state),
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
    // Pull of Death: a spell's damage by a save or with no roll, once a turn, to a creature already missing Hit
    // Points (combat/attack.ts adds it to an attack's).
    if (
      action.spellLevel !== null &&
      result.dealt > 0 &&
      resolution.kind !== "attack"
    ) {
      const hurt = target.hp < deriveStats(target, context).maxHp;
      stats.passives.forEach((passive, index) => {
        const key = `extra:${String(index)}`;
        if (
          !hurt ||
          passive.kind !== "extraDamage" ||
          passive.when !== "targetHurt" ||
          !passive.type ||
          (passive.oncePerTurn &&
            (actor.usedThisTurn.includes(key) || pulled.has(key)))
        ) {
          return;
        }
        if (passive.oncePerTurn) {
          pulled.add(key);
          events.push(
            dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key }),
          );
        }
        const now = events.reduce(applyDndEvent, context.state);
        events.push(
          ...dealEvents(
            now.actors[target.id] ?? target,
            [
              {
                amount: passive.dice
                  ? rollDiceNotation(passive.dice, context.dice)
                  : 0,
                type: passive.type,
              },
            ],
            false,
            { ...context, state: now },
          ).events,
        );
      });
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
      ...afterDamage(
        target,
        result.dealt,
        {
          source: actor.id,
          types: damage.map(({ type }) => type),
          spell: action.spellLevel !== null,
        },
        concentrationFrame(
          target,
          result.dealt,
          hasPassive(stats, "concentrationBreaker"),
        ),
        { ...context, state: events.reduce(applyDndEvent, context.state) },
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
    const roll = (amount: Damage["amount"], type: DamageType, index: number) =>
      rollAmount(
        amount,
        stats,
        index === maxIndex
          ? HIGHEST
          : floored(masteredDice(context.dice, type, mastered, rerolled)),
        critical ? 2 : 1,
      ) + (index === 0 ? fuel.bonus : 0);
    const shared = list.map(({ amount, type }, index) => ({
      total: roll(amount, type, index),
      type,
    }));
    // A larger die against a hurt target, or more dice against its kind, rolled once for all they reach.
    const later = new Map<string, number>();
    const once = (key: string, rolled: () => number): number => {
      const known = later.get(key) ?? rolled();
      later.set(key, known);
      return known;
    };
    return (target: Actor) => {
      const met = deriveStats(target, context);
      const hurt = target.hp < met.maxHp;
      return list.flatMap((item, index) => {
        if (item.except && exemptFrom(item.except, target, met)) return [];
        const { total = 0 } = shared[index] ?? {};
        const type = item.types
          ? typeAgainst(item.types, damageResponses(target, context))
          : item.type;
        const count = (item.amount.dice ?? "").split("d")[0] ?? "0";
        const dealt =
          item.hurtDie && hurt
            ? once(`hurt:${String(index)}`, () =>
                roll(
                  { ...item.amount, dice: `${count}d${String(item.hurtDie)}` },
                  type,
                  index,
                ),
              )
            : total;
        const { vs } = item;
        return [
          { total: dealt, type },
          ...(vs && exemptFrom(vs.creatureTypes, target, met)
            ? [
                {
                  total: once(`vs:${String(index)}`, () =>
                    rollDiceNotation(vs.dice, context.dice, critical ? 2 : 1),
                  ),
                  type,
                },
              ]
            : []),
        ];
      });
    };
  };

  switch (resolution.kind) {
    case "automatic": {
      beginConcentration(resolution.effects);
      for (const effect of resolution.effects) {
        if (effect.kind === "moveZone" && aim) {
          const moved = movedZone(effect.source, actor, aim, context);
          events.push(...moved.events);
          frames.push(...moved.frames);
        }
      }
      for (const effect of resolution.effects) {
        if (effect.kind === "summon") {
          events.push(
            ...summonEvents(effect, action, actor, stats, context, slotLevel),
          );
        }
        if (effect.kind === "raiseCorpse") {
          events.push(...raisedEvents(effect, actor, context));
        }
        if (effect.kind === "commandFamiliar") {
          const commanded = commandedResult(effect, actor, context);
          events.push(...(commanded.events ?? []));
          frames.push(...(commanded.frames ?? []));
        }
        if (effect.kind === "animate") {
          events.push(...animatedEvents(effect, actor, context));
        }
      }
      events.push(
        ...zoneEvents(
          resolution.effects,
          action,
          actor,
          context,
          aim,
          slotLevel,
        ),
      );
      const element = zoneTypeFrame(
        resolution.effects,
        spellSource(action),
        actor,
      );
      if (element) frames.push(element);
      const damage = rollSharedDamage(resolution.damage);
      const shared = sharedHealing(resolution.effects, targets, actor, context);
      const slay = resolution.effects.find((effect) => effect.kind === "slay");
      for (const target of targets) {
        // Power Word Kill: a target with few enough Hit Points dies, and only the others take the damage.
        if (
          slay?.kind === "slay" &&
          target.hp > 0 &&
          target.hp <= slay.hpAtMost
        ) {
          events.push(
            dndEvent(`${NS}:damaged`, {
              actor: target.id,
              amount: target.hp + target.tempHp,
              type: "psychic",
              critical: false,
              massive: true,
            }),
            { kind: "actorDefeated", actor: target.id },
          );
          continue;
        }
        applyRolled(target, damage(target), (amount) => amount);
        events.push(
          ...leafEvents(
            shared(target),
            spellSource(action),
            actor,
            target,
            context,
            undefined,
            slotLevel,
          ),
        );
        const typed = damageTypeFrame(
          resolution.effects,
          spellSource(action),
          actor,
          target,
          slotLevel,
        );
        if (typed) frames.push(typed);
        const focus = focusFrame(
          resolution.effects,
          spellSource(action),
          actor,
          target,
          slotLevel,
        );
        if (focus) frames.push(focus);
        const picked = optionFrame(
          resolution.effects,
          spellSource(action),
          actor,
          target,
          undefined,
          slotLevel,
        );
        if (picked) frames.push(picked);
        // Where it lands is chosen, as a move is, and so is a form for a friend.
        for (const effect of resolution.effects) {
          if (
            effect.kind === "teleport" &&
            (target.id === actor.id || effect.others)
          ) {
            const { rolled } = effect;
            frames.push(
              teleportFrame(
                target,
                rolled
                  ? rolled.times *
                      context.dice.roll(
                        deriveStats(actor, context).scaling[rolled.dieSize] ??
                          6,
                      )
                  : effect.feet,
                effect.movement,
                context,
                effect.provokes,
                undefined,
                action.id,
              ),
            );
          }
          const choice =
            effect.kind === "polymorph" &&
            target.side === actor.side &&
            formOf(target) === null
              ? formFrame(
                  effect,
                  spellSource(action),
                  actor,
                  target,
                  effectEnds(effect.duration),
                  context,
                )
              : null;
          if (choice) frames.push(choice);
          if (effect.kind === "copySpell" && target.id === actor.id) {
            const wish = wishFrame(effect, spellSource(action), actor, context);
            if (wish) frames.push(wish);
          }
          if (effect.kind === "weaponAttack") {
            const made = weaponAttackResult(
              effect,
              spellSource(action),
              actor,
              target,
              context,
            );
            events.push(...made.events);
            frames.push(...made.frames);
          }
          if (effect.kind === "randomAction") {
            const rolled = rolledActions(
              effect,
              action,
              actor,
              target,
              context,
              slotLevel,
            );
            events.push(...rolled.events);
            frames.push(...rolled.frames);
          }
          if (effect.kind === "reactionMove") {
            events.push(...reactionMove(target, context, effect, actor));
          }
          if (effect.kind === "reactionAttack") {
            const struck = reactionAttack(target, context);
            events.push(...struck.events);
            frames.push(...struck.frames);
          }
        }
        // A save round the target, as Jolt to Life's lightning (combat/spell-riders.ts).
        if (resolution.burst) {
          frames.push(
            frame("burst", {
              attacker: actor.id,
              actionId: action.id,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          );
        }
      }
      break;
    }
    case "save": {
      // Mythal Ward's 20 turns the whole spell aside, so what it has done so far is dropped (beforeFailedSave).
      const unspent = { events: events.length, frames: frames.length };
      beginConcentration(resolution.onFail);
      // A zone the spell leaves is left before the saves, so a cloud's first save comes from the cast.
      events.push(
        ...zoneEvents(
          [...resolution.onFail, ...resolution.onSuccess],
          action,
          actor,
          context,
          aim,
          slotLevel,
        ),
      );
      const element = zoneTypeFrame(
        [...resolution.onFail, ...resolution.onSuccess],
        spellSource(action),
        actor,
      );
      if (element) frames.push(element);
      const dc = evaluateFormula(resolution.dc, stats);
      // Damage against several targets at once is rolled once for all of them.
      const damage = rollSharedDamage(resolution.damage);
      const source = saveSourceOf(actor, action.id, action.name, context);
      const careful = metamagicSaves(
        action,
        actor,
        targets,
        modifierFor(stats, "cha"),
      );
      const { heightened } = careful;
      const banded = pairedBandSpares(action, actor, stats, targets, context);
      events.push(...banded.events);
      const spared = new Set([...careful.spared, ...banded.spared]);
      for (const struck of targets) {
        if (resolution.heard && hasCondition(struck, "deafened")) continue;
        // Wail of the Banshee: a target with few enough Hit Points dies, and only the others save.
        if (
          resolution.slayAtMost !== undefined &&
          struck.hp > 0 &&
          struck.hp <= resolution.slayAtMost
        ) {
          events.push(
            dndEvent(`${NS}:damaged`, {
              actor: struck.id,
              amount: struck.hp + struck.tempHp,
              type: resolution.damage[0]?.type ?? "psychic",
              critical: false,
              massive: true,
            }),
            { kind: "actorDefeated", actor: struck.id },
          );
          continue;
        }
        // Banishing Smite: the damage lands first, and only a target it leaves low enough saves.
        const landed = resolution.hpAtMost !== undefined;
        if (landed) applyRolled(struck, damage(struck), (amount) => amount);
        const target = landed
          ? (events.reduce(applyDndEvent, context.state).actors[struck.id] ??
            struck)
          : struck;
        if (
          resolution.hpAtMost !== undefined &&
          (target.hp <= 0 || target.hp > resolution.hpAtMost)
        ) {
          continue;
        }
        const met = deriveStats(target, context);
        const edges = (resolution.edges ?? []).flatMap((edge) =>
          (!edge.creatureTypes ||
            exemptFrom(edge.creatureTypes, target, met)) &&
          (!edge.minSize ||
            sizeOf(target, context) >= SIZES.indexOf(edge.minSize)) &&
          (!edge.maxScore ||
            met.abilities[edge.maxScore.ability] <= edge.maxScore.score) &&
          (!edge.immuneTo || immuneToCondition(met, edge.immuneTo))
            ? [edge.roll]
            : [],
        );
        // Cause Fear: a creature of a type it can't touch is left out altogether.
        if (edges.includes("immune")) continue;
        // shortcut: cover counts from the caster, even for a sphere whose centre is elsewhere.
        const { saved: rolledSave, events: saveEvents } = spared.has(target.id)
          ? { saved: true, events: [] }
          : edges.includes("succeed") || edges.includes("fail")
            ? { saved: edges.includes("succeed"), events: [] }
            : rollSave(
                target,
                resolution.ability,
                dc,
                context,
                action.spellLevel !== null,
                coverAgainst(context.state, actor, target, context),
                conditionsApplied(resolution.onFail),
                heightened === target.id || edges.includes("disadvantage"),
                resolution.advantage === true || edges.includes("advantage"),
                source,
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
                { source, access: context },
              );
        events.push(...rescued);
        const saved = rolledSave || resisted !== null || rescued.length > 0;
        // Mythal Ward: a reaction before the failed save lands, which may make the spell do nothing to the target.
        if (!saved && action.spellLevel !== null) {
          const warded = beforeFailedSave(
            target,
            actor,
            slotLevel ?? action.spellLevel,
            context,
          );
          if (warded.negate) {
            events.length = unspent.events;
            frames.length = unspent.frames;
            events.push(
              ...warded.events,
              ...slotRefund(actor, action, slotLevel ?? action.spellLevel),
            );
            break;
          }
          events.push(...warded.events);
          frames.push(...warded.frames);
        }
        // Ring of Spell Turning: a spell up to some level does nothing to a target that saves against it.
        const turned =
          saved &&
          action.spellLevel !== null &&
          deriveStats(target, context).passives.some(
            (passive) =>
              passive.kind === "spellTurning" &&
              (slotLevel ?? action.spellLevel ?? 0) <= passive.upTo,
          );
        // And with its Reaction, a spell aimed at it alone is turned back at its caster, who saves against it.
        if (turned && targets.length === 1) {
          const deflected = deflectedSpell(action, actor, target, context);
          events.push(...deflected.events);
          frames.push(...deflected.frames);
        }
        const evaded =
          resolution.onSuccessDamage === "half" &&
          (evades(target, resolution.ability, context) ||
            (action.spellLevel !== null &&
              zonesOn(target, context.state, context).some(
                (zone) => zone.area?.magicWard,
              )));
        const interposed =
          saved &&
          !evaded &&
          resolution.damage.length > 0 &&
          resolution.ability === "dex" &&
          resolution.onSuccessDamage === "half" &&
          !spared.has(target.id)
            ? interposedShield(target, deriveStats(target, context), context)
            : null;
        if (interposed) events.push(interposed);
        lastDealt = 0;
        if (!landed) {
          applyRolled(target, damage(target), (amount) => {
            if (turned) return 0;
            if (evaded) return saved ? 0 : halved(amount);
            if (!saved || resolution.onSuccessDamage === "full") return amount;
            return resolution.onSuccessDamage === "half" &&
              !spared.has(target.id) &&
              !interposed
              ? halved(amount)
              : 0;
          });
        }
        events.push(
          ...leafEvents(
            turned ? [] : saved ? resolution.onSuccess : resolution.onFail,
            spellSource(action),
            actor,
            target,
            context,
            { ability: resolution.ability, dc },
            slotLevel,
          ),
        );
        const focused = turned
          ? null
          : focusFrame(
              saved ? resolution.onSuccess : resolution.onFail,
              spellSource(action),
              actor,
              target,
              slotLevel,
            );
        if (focused) frames.push(focused);
        const picked = turned
          ? null
          : optionFrame(
              saved ? resolution.onSuccess : resolution.onFail,
              spellSource(action),
              actor,
              target,
              { ability: resolution.ability, dc },
              slotLevel,
            );
        if (picked) frames.push(picked);
        // Harm: the damage taken comes off the Hit Point maximum too.
        if (
          !saved &&
          !turned &&
          lastDealt > 0 &&
          resolution.onFail.some((effect) => effect.kind === "drainMaxHp")
        ) {
          const now = events.reduce(applyDndEvent, context.state).actors[
            target.id
          ];
          const max = Math.max(
            1,
            deriveStats(target, context).maxHp - lastDealt,
          );
          if (now) {
            events.push(
              dndEvent(`${NS}:maxHpReduced`, {
                actor: target.id,
                amount: lastDealt,
                ...(now.hp > max ? { hp: max } : {}),
              }),
            );
          }
        }
        // Disintegrate: a character it drops is dust, past death saves.
        if (
          !saved &&
          !turned &&
          target.side === "party" &&
          resolution.onFail.some((effect) => effect.kind === "disintegrate")
        ) {
          const now = events.reduce(applyDndEvent, context.state).actors[
            target.id
          ];
          if (now && now.hp <= 0 && !isDead(now)) {
            events.push(
              dndEvent(`${NS}:damaged`, {
                actor: target.id,
                amount: 0,
                type: "force",
                critical: false,
                massive: true,
              }),
              dndEvent(`${NS}:disintegrated`, { actor: target.id }),
              { kind: "actorDefeated", actor: target.id },
            );
          }
        }
        if (!saved) {
          const forced = forcedAttack(
            resolution.onFail,
            actor,
            target,
            context,
          );
          events.push(...forced.events);
          frames.push(...forced.frames);
          for (const effect of turned ? [] : resolution.onFail) {
            if (effect.kind === "reactionMove") {
              const now = events.reduce(applyDndEvent, context.state).actors[
                target.id
              ];
              if (now)
                events.push(...reactionMove(now, context, effect, actor));
            }
          }
        }
        // A reaction to how the save went, as Mind Corrosion or Spell Reflection.
        frames.push(
          ...reactFrames(
            {
              kind: "saved",
              actor: target.id,
              source: actor.id,
              success: saved,
              spell: action.spellLevel !== null,
            },
            context,
          ),
        );
      }
      // One creature of the caster's choice in the area, the most hurt of its side there, also gets these, as
      // Wither and Bloom's Hit Point Dice.
      const { targeting } = action.activation;
      if (resolution.chosen && "area" in targeting) {
        const caught = [actor, ...allies(context.state, actor)].filter(
          (item) =>
            !isDead(item) &&
            inArea(
              targeting.area.shape,
              targeting.area.radius,
              actor.position,
              aim ?? actor.position,
              item.position,
            ),
        );
        const now = events.reduce(applyDndEvent, context.state);
        const missing = (item: Actor) =>
          deriveStats(item, context).maxHp -
          (now.actors[item.id]?.hp ?? item.hp);
        const chosen = [...caught].sort((a, b) => missing(b) - missing(a))[0];
        if (chosen && missing(chosen) > 0) {
          events.push(
            ...leafEvents(
              resolution.chosen,
              spellSource(action),
              actor,
              now.actors[chosen.id] ?? chosen,
              { ...context, state: now },
              undefined,
              slotLevel,
            ),
          );
        }
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
        // Hit or miss, the shard bursts round the target, as Ice Knife's.
        if (resolution.burst) {
          frames.push(
            frame("burst", {
              attacker: actor.id,
              actionId: action.id,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          );
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

// Aura of Violence: the target spends its Reaction on a melee attack against a creature in its reach, its own side
// first, or takes the damage when no creature is in reach. One with no Reaction left does neither.
function forcedAttack(
  effects: readonly LeafEffect[],
  caster: Actor,
  target: Actor,
  context: Context,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const forced = effects.find((effect) => effect.kind === "forcedAttack");
  if (forced?.kind !== "forcedAttack" || isDown(target)) {
    return { events: [], frames: [] };
  }
  const { state } = context;
  const melee = deriveStats(target, context).actions.filter(
    (item) =>
      meleeReach(item) !== null &&
      item.activation.resolution.kind === "attack" &&
      !item.activation.trigger &&
      item.spellLevel === null,
  );
  const reach = Math.max(5, ...melee.map((item) => meleeReach(item) ?? 0));
  const [victim] = Object.values(state.actors)
    .filter(
      (item) =>
        item.id !== target.id &&
        !isDead(item) &&
        !sealed(item) &&
        item.position !== null &&
        distanceFeet(target.position, item.position) <= reach,
    )
    .sort(
      (a, b) =>
        Number(b.side === target.side) - Number(a.side === target.side) ||
        a.hp - b.hp,
    );
  if (!victim) {
    const stats = deriveStats(caster, context);
    const responses = damageResponses(target, context);
    const hurt = dealEvents(
      target,
      forced.otherwise.map(({ amount, type }) => ({
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
    return {
      events: hurt.events,
      frames: [...concentrationFrame(target, hurt.dealt)],
    };
  }
  const away = distanceFeet(target.position, victim.position);
  const weapon = melee.find((item) => (meleeReach(item) ?? 0) >= away);
  if (
    !weapon ||
    !target.budget.reaction ||
    hasCondition(target, ...INCAPACITATING)
  ) {
    return { events: [], frames: [] };
  }
  return {
    events: [
      dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    ],
    frames: [
      frame("attackRoll", {
        attacker: target.id,
        actionId: weapon.id,
        target: victim.id,
      }),
    ],
  };
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
  const usable = new Set(
    deriveStats(actor, context).actions.map(({ id }) => id),
  );
  return currentShape(monster, actor)?.multiattack === false
    ? []
    : multiattackUses(monster, action.name).filter((id) => usable.has(id));
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
      modifier.kind === "dodgeSave") &&
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

// Each roll picks one of the actions it names, rolling again for one already used this turn, as Eye Rays do.
function rolledActions(
  effect: Extract<LeafEffect, { kind: "randomAction" }>,
  action: KnownAction,
  actor: Actor,
  target: Actor,
  context: Context,
  slotLevel: number | undefined,
): { events: SystemEvent[]; frames: Frame[] } {
  const rays = spellRolls(action, context);
  if (rays) return rolledRays(effect, rays, actor, target, context, slotLevel);
  const known = deriveStats(actor, context).actions;
  const used = new Set(effect.repeats ? [] : actor.usedThisTurn);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  for (let time = 0; time < effect.times; time += 1) {
    if (effect.of.every((name) => used.has(`rolled:${name}`))) break;
    let name = "";
    do {
      name = effect.of[context.dice.roll(effect.of.length) - 1] ?? "";
    } while (used.has(`rolled:${name}`));
    used.add(`rolled:${name}`);
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, {
        actor: actor.id,
        key: `rolled:${name}`,
      }),
    );
    const action = known.find((item) => item.name === name);
    if (action) {
      frames.push(
        frame("useAction", {
          actor: actor.id,
          actionId: action.id,
          target: target.id,
        }),
      );
    }
  }
  return { events, frames };
}

// A spell's own rolled activations, as Prismatic Spray's rays, each made as the spell itself, named by its label.
function spellRolls(
  action: KnownAction,
  context: Context,
): readonly (KnownAction & { readonly label: string })[] | null {
  const id = spellOfSource(action.id);
  if (!id) return null;
  const spell = SpellSchema.safeParse(context.content(id)).data;
  return (
    spell?.rolled?.map((activation) => ({
      id: action.id,
      name: action.name,
      label: activation.label ?? "",
      activation,
      spellLevel: action.spellLevel,
    })) ?? null
  );
}

// Each target gets its own roll among them, and with `twiceOnTop` the die's top face strikes it with two,
// rolling that face again.
function rolledRays(
  effect: Extract<LeafEffect, { kind: "randomAction" }>,
  rays: readonly (KnownAction & { readonly label: string })[],
  actor: Actor,
  target: Actor,
  context: Context,
  slotLevel: number | undefined,
): { events: SystemEvent[]; frames: Frame[] } {
  const sides = effect.of.length + (effect.twiceOnTop ? 1 : 0);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  const roll = (): number => {
    const value = context.dice.roll(sides);
    events.push(
      dndEvent(`${NS}:dieRolled`, {
        actor: target.id,
        die: sides,
        rolled: value,
        label: rays[0]?.name ?? "",
      }),
    );
    return value;
  };
  const first = roll();
  const picks: number[] = [];
  if (effect.twiceOnTop && first === sides) {
    while (picks.length < 2) {
      const again = roll();
      if (again !== sides) picks.push(again);
    }
  } else {
    picks.push(first);
  }
  // shortcut: a creature struck by two rays saves against each.
  for (const pick of picks) {
    const ray = rays.find(({ label }) => label === effect.of[pick - 1]);
    if (!ray) continue;
    const result = resolveAction(ray, actor, [target], context, slotLevel);
    events.push(...(result.events ?? []));
    frames.push(...(result.frames ?? []));
  }
  return { events, frames };
}

// A creature spends its Reaction on one melee attack at the weakest foe in its reach, as Incite Rampage gives.
function reactionAttack(
  target: Actor,
  context: Context,
): { events: SystemEvent[]; frames: Frame[] } {
  if (!target.budget.reaction || isDown(target)) {
    return { events: [], frames: [] };
  }
  const { actions } = deriveStats(target, context);
  const melee = actions.find(
    (action) =>
      action.activation.resolution.kind === "attack" &&
      action.activation.cost.includes("action") &&
      isMelee(action),
  );
  const foe = melee
    ? [...inReach(melee, target, context.state, context)].sort(
        (a, b) => a.hp - b.hp,
      )[0]
    : undefined;
  if (!melee || !foe) return { events: [], frames: [] };
  return {
    events: [
      dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    ],
    frames: [
      frame("useAction", {
        actor: target.id,
        actionId: melee.id,
        target: foe.id,
      }),
    ],
  };
}

// A creature spends its Reaction to step beside its nearest foe within its Speed, or to get as far from the caster as
// it can, provoking nothing.
// shortcut: fleeing goes straight away from the caster, as a push does, not by the safest winding route.
export function reactionMove(
  target: Actor,
  context: Context,
  effect: Extract<LeafEffect, { kind: "reactionMove" }>,
  caster: Actor,
): SystemEvent[] {
  if (!target.budget.reaction || isDown(target) || !target.position) return [];
  const full = speedOf(target, deriveStats(target, context));
  const speed = effect.half ? Math.floor(full / 10) * 5 : full;
  if (effect.away) {
    const to =
      speed > 0 ? pushTo(caster.position, target, speed, context.state) : null;
    return to
      ? [
          dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
          dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 }),
        ]
      : [];
  }
  const [foe] = enemies(context.state, target)
    .filter((item) => !isDown(item) && item.position)
    .sort(
      (a, b) =>
        distanceFeet(target.position, a.position) -
        distanceFeet(target.position, b.position),
    );
  if (!foe || distanceFeet(target.position, foe.position) <= 5) return [];
  const to = besideSquare(target, foe, context);
  if (!to || distanceFeet(target.position, to) > speed) return [];
  return [
    dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 }),
  ];
}

// Copies of a monster, or another stat block, come to life next to the bearer, as Animate Trees or Soul Tattoo.
// shortcut: they stay until they drop, not until the bearer dies or moves too far away.
function animatedEvents(
  effect: Extract<LeafEffect, { kind: "animate" }>,
  actor: Actor,
  context: Context,
): SystemEvent[] {
  const id =
    effect.monster ??
    (actor.source.kind === "monster" ? actor.source.statBlockId : undefined);
  if (!id) return [];
  const monster = lookup(context, MonsterSchema, id);
  const open = [
    ...teleportSquares(actor, effect.range, 0, context.state, context),
  ].sort(
    (a, b) => distanceFeet(actor.position, a) - distanceFeet(actor.position, b),
  );
  const made = Object.keys(context.state.actors).filter((key) =>
    key.startsWith(`${actor.id}:animated-`),
  ).length;
  return open.slice(0, effect.count).map((square, index) =>
    dndEvent(`${NS}:summoned`, {
      actor: {
        ...freshActor({
          id: `${actor.id}:animated-${String(made + index + 1)}`,
          name: `${monster.name} ${String(made + index + 1)}`,
          side: actor.side,
          source: {
            kind: "monster",
            statBlockId: id,
            ...(effect.lacks.length > 0 ? { lacks: effect.lacks } : {}),
            // a character's beasts die at 0 Hit Points, as monsters do, and leave with the fight
            ...(actor.source.kind === "monster" ? {} : { calledBy: actor.id }),
          },
          hp: monster.hp,
          inventory: [],
        }),
        position: square,
      },
      after: actor.id,
    }),
  );
}

// A corpse rises in its own square, on the raiser's side, taking its turns right after the raiser's.
// shortcut: how long it has been dead, and how many the raiser already controls, aren't counted.
function raisedEvents(
  effect: Extract<LeafEffect, { kind: "raiseCorpse" }>,
  actor: Actor,
  context: Context,
): SystemEvent[] {
  const { state } = context;
  const corpses = Object.values(state.actors).filter(
    (item) =>
      isDead(item) &&
      item.position !== null &&
      state.actors[`${item.id}:risen`] === undefined &&
      distanceFeet(actor.position, item.position) <= effect.range &&
      effect.creatureTypes.includes(
        deriveStats(item, context).creatureType ?? "",
      ),
  );
  const monster = lookup(context, MonsterSchema, effect.monster);
  return (effect.all ? corpses : corpses.slice(0, 1)).map((corpse) =>
    dndEvent(`${NS}:summoned`, {
      actor: {
        ...freshActor({
          id: `${corpse.id}:risen`,
          name: `${monster.name} (${corpse.name})`,
          side: actor.side,
          source: { kind: "monster", statBlockId: effect.monster },
          hp: monster.hp,
          inventory: [],
        }),
        position: corpse.position,
      },
      after: actor.id,
    }),
  );
}

// Spell Immunity names spells by id; a spell is known here by its name, as a monster's cast of it carries.
// Reflective Carapace adds every spell that makes a ranged attack roll.
// shortcut: the carapace's 6 that turns the spell back on its caster is left out; the spell only misses it.
function immuneToSpell(
  target: Actor,
  spell: string,
  context: Context,
  action: KnownAction,
): boolean {
  const { resolution } = action.activation;
  const rangedAttack =
    resolution.kind === "attack" &&
    resolution.attack.type === "spell" &&
    !isMelee(action);
  return deriveStats(target, context).passives.some(
    (passive) =>
      passive.kind === "spellImmunity" &&
      ((passive.rangedAttacks === true && rangedAttack) ||
        passive.spells.some(
          (id) =>
            SpellSchema.safeParse(context.content(id)).data?.name === spell,
        )),
  );
}

// Evocation Sculptor: an area spell passes over the caster and up to that many of its side, who save and take nothing.
function sculpted(
  targets: readonly Actor[],
  action: KnownAction,
  actor: Actor,
  stats: ReturnType<typeof deriveStats>,
): readonly Actor[] {
  const sculptor = stats.passives.find(
    (passive) => passive.kind === "sculptor",
  );
  if (
    sculptor?.kind !== "sculptor" ||
    !("area" in action.activation.targeting)
  ) {
    return targets;
  }
  let spared = 0;
  return targets.filter((target) => {
    if (target.side !== actor.side) return true;
    if (target.id === actor.id) return false;
    spared += 1;
    return spared > sculptor.creatures;
  });
}
