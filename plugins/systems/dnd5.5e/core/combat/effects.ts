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
  onList,
  passiveModifiers,
  rerollingOnes,
  cantripTier,
  rollAmount,
  rollDiceNotation,
  weaponAttackOf,
  wishedKey,
  grantedKey,
  saveBonus,
  scoreFloor,
  spellSaveDc,
  type Stats,
  maybeLookup,
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
  turnId,
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
  LeafEffectSchema,
  type Modifier,
  MonsterSchema,
  type Passive,
  type Resolution,
  SpellSchema,
  type AlliesRider,
} from "../schemas.ts";
import { multiattackUses } from "../multiattack-uses.ts";
import {
  HIGHEST,
  masteredDice,
  maximized,
  flooredTypes,
  masteredTypes,
  rerolledTypes,
  hitDieHealing,
  hitDieRoll,
  nextHitDie,
  piercing,
  interposedShield,
  d20Floor,
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
  ITEM_PREFIX,
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
  inZone,
  placedFlag,
  sealed,
  zoneImmune,
  zoneModifiers,
  zonesOf,
  zonesOn,
} from "../zones.ts";
import { caughtBy } from "../targeting.ts";
import { behindTotalCover, coverAgainst, coverFor, seeing } from "../sight.ts";
import { teleportFrame, teleportSquares } from "./movement.ts";
import {
  afterDamage,
  beforeDamage,
  counterBeforeSave,
  preyBonus,
  spellAimedAt,
  turnedOn,
  besideSquare,
  reactFrames,
  settleRoll,
  beforeFailedSave,
  playerTakes,
  slotRefund,
  tableOf,
  tableRoll,
} from "./reactions.ts";
import { channelPickFrame } from "./school.ts";
import { summonEvents } from "./summon.ts";
import { fueledDamage, schoolOf, spendHitDice } from "./school.ts";
import {
  conditionsApplied,
  legendaryResistance,
  resistancesLeft,
} from "../legendary.ts";
import { insideDamageEvents } from "./swallow.ts";
import { headDamageEvents } from "./heads.ts";
import {
  lastsFor,
  lethargyEffect,
  limitEvents,
  timeStopEnds,
} from "./durations.ts";
import { movedFrames } from "./areas.ts";
import { liftEvents } from "./falling.ts";
import { reincarnateEvents } from "../reincarnate.ts";
import {
  cureFor,
  dispelEvents,
  isSpell,
  snuffedLights,
  spellLevelOf,
  spellOf,
} from "./dispel.ts";
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
  charmersOf,
  currentActor,
  enemies,
  exemptFrom,
  fitsType,
  hasFlag,
  hasPassive,
  inReach,
  isMelee,
  luckyEdge,
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
      // A pool whose size is rolled is rolled as it's first spent, as a Necklace of Fireballs' beads.
      const rolled = deriveStats(actor, context).resourceDefs.find(
        (def) => def.id === cost.resource,
      )?.rolled;
      if (rolled && actor.rolledPools?.[cost.resource] === undefined) {
        events.push(
          dndEvent(`${NS}:poolRolled`, {
            actor: actor.id,
            resource: cost.resource,
            amount: rollDiceNotation(rolled, context.dice),
          }),
        );
      }
      // Use Magic Device: a 6 on a d6 keeps a magic item's charges.
      const kept =
        hasPassive(deriveStats(actor, context), "chargeSaver") &&
        itemCharge(actor, cost.resource, context) &&
        context.dice.roll(6) === 6;
      if (!kept) {
        events.push(
          dndEvent(`${NS}:resourceSpent`, {
            actor: actor.id,
            resource: cost.resource,
            ...(cost.count ? { amount: cost.count } : {}),
          }),
        );
      }
    }
  }
  // A stored spell leaves the item it's cast from.
  if (action.stored) {
    const spell = spellOfSource(action.id);
    if (spell) {
      events.push(
        dndEvent(`${NS}:storedSpellUsed`, {
          actor: actor.id,
          item: action.stored,
          spell,
        }),
      );
    }
  }
  return [...events, ...lastCharge(actor, action, context)];
}

// Whether a pool is one of a carried magic item's charges.
function itemCharge(actor: Actor, resource: string, context: Context): boolean {
  return [...new Set(actor.inventory)].some((id) => {
    const item = lookup(context, ItemSchema, id);
    return [
      ...("resources" in item ? (item.resources ?? []) : []),
      ...(item.type === "magicItem"
        ? (item.variants ?? []).flatMap((entry) => entry.resources ?? [])
        : []),
    ].some((def) => def.id === resource);
  });
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
  const twenty =
    item && "lastChargeTwenty" in item ? item.lastChargeTwenty : undefined;
  const pool = item ? chargesOf(item).resources[0]?.id : undefined;
  if (!itemId || (!fate && !twenty) || !pool) return [];
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
  if (charges === 0 || left > 0) return [];
  // An Arcane Chatelaine is gone with its last key, with no d20.
  const face = fate === "vanishes" ? 1 : context.dice.roll(20);
  // A Staff of Power's 20 gives charges back.
  if (face === 20 && twenty) {
    return [
      dndEvent(`${NS}:resourceRestored`, {
        actor: actor.id,
        resource: pool,
        amount: Math.max(
          1,
          twenty.base + rollDiceNotation(twenty.dice, context.dice),
        ),
      }),
    ];
  }
  if (face !== 1 || !fate) return [];
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
      // Soul of Artifice's Cheat Death: its Uncommon and Rare replicated items, in place of a use.
      const artifice =
        trait.kind === "dropToOne" && trait.replicated !== undefined
          ? (bearer.replicated ?? []).filter((id) => {
              const item = ItemSchema.safeParse(context.content(id)).data;
              return (
                item !== undefined &&
                "rarity" in item &&
                (item.rarity === "uncommon" || item.rarity === "rare")
              );
            })
          : [];
      if (
        trait.kind !== "dropToOne" ||
        (bearer !== target && !trait.allies) ||
        (trait.replicated !== undefined
          ? artifice.length === 0
          : (bearer.resourcesSpent[trait.resource] ?? 0) >=
            (own.resources[trait.resource] ?? 0)) ||
        trait.except?.includes(hit.type) ||
        (trait.notCritical && hit.critical) ||
        (trait.reaction && (!bearer.budget.reaction || isDown(bearer))) ||
        (trait.within !== undefined &&
          distanceFeet(bearer.position, target.position) > trait.within) ||
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
      const hp = trait.replicated
        ? Math.min(stats.maxHp, trait.replicated * artifice.length)
        : trait.hp
          ? Math.min(stats.maxHp, Math.max(1, evaluateFormula(trait.hp, own)))
          : 1;
      const endured = [
        ...(trait.replicated
          ? [
              ...artifice.map((item) =>
                dndEvent(`${NS}:itemUsed`, { actor: bearer.id, item }),
              ),
              dndEvent(`${NS}:itemReplicated`, {
                actor: bearer.id,
                vanished: artifice,
              }),
            ]
          : [
              dndEvent(`${NS}:resourceSpent`, {
                actor: bearer.id,
                resource: trait.resource,
              }),
            ]),
        ...(trait.reaction
          ? [
              dndEvent(`${NS}:budgetSpent`, {
                actor: bearer.id,
                kind: "reaction",
              }),
            ]
          : []),
        // For a reaction right after it, as Orcish Fury's attack (combat/reactions.ts).
        dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key: ENDURED }),
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

export const ENDURED = "endured";

// A foe that just dropped to 0 Hit Points feeds its enemies' traits, as Dark One's Blessing.
// shortcut: the creature whose turn it is counts as the one that dropped it, as most damage comes on its own turn.
function killEvents(fallen: Actor, context: Context): SystemEvent[] {
  const turn = context.state.combat ? turnId(context.state.combat) : undefined;
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
      const fallenStats = passive.fallenMaxHp
        ? deriveStats(fallen, context)
        : undefined;
      if (
        fallenStats &&
        ["construct", "undead"].includes(fallenStats.creatureType ?? "")
      ) {
        return [];
      }
      const effects = passive.fallenHitDice
        ? passive.effects.map((effect) =>
            effect.kind === "heal"
              ? { ...effect, amount: { bonus: { base: dice, add: [] } } }
              : effect,
          )
        : fallenStats
          ? passive.effects.map((effect) =>
              effect.kind === "tempHp"
                ? {
                    ...effect,
                    amount: { bonus: { base: fallenStats.maxHp, add: [] } },
                  }
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
  turning: Extract<Passive, { kind: "spellTurning" }>,
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  const none = { events: [], frames: [] };
  const { targeting } = action.activation;
  const stats = deriveStats(target, context);
  if (
    target.id === caster.id ||
    !("creatures" in targeting) ||
    targeting.creatures !== 1 ||
    !target.budget.reaction ||
    hasCondition(target, ...INCAPACITATING) ||
    !turning.deflect ||
    (turning.resource !== undefined &&
      (stats.resources[turning.resource] ?? 0) -
        (target.resourcesSpent[turning.resource] ?? 0) <
        1) ||
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
      ...(turning.resource
        ? [
            dndEvent(`${NS}:resourceSpent`, {
              actor: target.id,
              resource: turning.resource,
            }),
          ]
        : []),
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
// The item an `item:` action spends, or null.
const itemFrom = (sourceId: string): string | null =>
  sourceId.startsWith(ITEM_PREFIX) ? sourceId.slice(ITEM_PREFIX.length) : null;

// A Staff of Power's Retributive Strike: the staff breaks, and its charges left blast its bearer and those near.
export function retributionEvents(
  bearer: Actor,
  itemId: string,
  effect: Extract<LeafEffect, { kind: "retribution" }>,
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(bearer, context);
  const left = Math.max(
    0,
    (stats.resources[effect.resource] ?? 0) -
      (bearer.resourcesSpent[effect.resource] ?? 0),
  );
  const events: SystemEvent[] = [
    dndEvent(`${NS}:itemUsed`, { actor: bearer.id, item: itemId }),
  ];
  if (context.dice.roll(100) > 50) {
    events.push(
      ...dealEvents(
        bearer,
        [{ amount: effect.self * left, type: "force" }],
        false,
        context,
      ).events,
    );
  }
  for (const other of Object.values(context.state.actors)) {
    if (
      other.id === bearer.id ||
      isDead(other) ||
      distanceFeet(bearer.position, other.position) > effect.radius
    ) {
      continue;
    }
    const save = rollSave(other, "dex", effect.dc, context, true);
    const amount = effect.others * left;
    events.push(
      ...save.events,
      ...dealEvents(
        other,
        [
          {
            amount: save.saved ? Math.floor(amount / 2) : amount,
            type: "force",
          },
        ],
        false,
        context,
      ).events,
    );
  }
  return events;
}

// A push along the ground made shorter by the target's Reaction, as Dwarven Plate's 10 feet less: the feet it's
// still moved, and the Reaction spent. shortcut: the Reaction is always taken when it can be.
export function braced(
  target: Actor,
  feet: number,
  context: Pick<Context, "state" | "content" | "contentIds">,
): { readonly feet: number; readonly events: SystemEvent[] } {
  const brace = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "bracing",
  );
  if (
    brace?.kind !== "bracing" ||
    !target.budget.reaction ||
    isDown(target) ||
    hasCondition(target, ...INCAPACITATING)
  ) {
    return { feet, events: [] };
  }
  return {
    feet: Math.max(0, feet - brace.feet),
    events: [
      dndEvent(`${NS}:budgetSpent`, { actor: target.id, kind: "reaction" }),
    ],
  };
}

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

// A Berserker Axe's fury: another creature's damage calls for a save, failed into a fury (combat/madness.ts).
function furyEvents(target: Actor, context: Context): SystemEvent[] {
  const damager = currentActor(context.state);
  if (
    target.hp <= 0 ||
    !damager ||
    damager.id === target.id ||
    target.activeEffects.some(({ modifier }) => modifier.kind === "furious")
  ) {
    return [];
  }
  const fury = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "fury",
  );
  if (fury?.kind !== "fury") return [];
  const save = rollSave(target, fury.ability, fury.dc, context, true);
  return [
    ...save.events,
    ...(save.saved
      ? []
      : [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: "fury",
              casterId: target.id,
              modifier: {
                kind: "furious",
                ...(fury.damager ? { at: damager.id } : {}),
              },
              ends: "spellDuration",
            },
          }),
        ]),
  ];
}

export function dealEvents(
  target: Actor,
  hits: readonly { readonly amount: number; readonly type: Damage["type"] }[],
  critical: boolean,
  context: Context,
  source?: Actor, // the creature dealing it, for a reaction aimed back at it, as Backlash's
  magical = false, // a spell's, for Magic Absorption
): { events: SystemEvent[]; dealt: number } {
  let { state } = context;
  const events: SystemEvent[] = [];
  let dealt = 0;
  for (const hit of hits) {
    const current = state.actors[target.id] ?? target;
    const reduced = reducedHit(
      current,
      hit.amount,
      hit.type,
      { ...context, state },
      magical,
    );
    // A reaction such as Vitality Ward may lessen it before it lands.
    const lessened = beforeDamage(
      current,
      reduced.amount,
      hit.type,
      { ...context, state },
      source && (state.actors[source.id] ?? source),
    );
    const { amount, type } = { ...hit, amount: lessened.amount };
    // Thought Shield: the creature that dealt it takes the same.
    const mirrored =
      source &&
      source.id !== target.id &&
      amount > 0 &&
      deriveStats(current, context).passives.some(
        (passive) => passive.kind === "mirrorDamage" && passive.damage === type,
      )
        ? damageEvents(state.actors[source.id] ?? source, amount, type, false, {
            ...context,
            state,
          })
        : [];
    for (const event of [
      ...reduced.events,
      ...lessened.events,
      ...damageEvents(current, amount, type, critical, { ...context, state }),
      ...mirrored,
    ]) {
      events.push(event);
      if (state.actors[target.id]) state = applyDndEvent(state, event);
    }
    dealt += Math.max(0, scaledForParty(target, amount, context.state));
  }
  // Dragon Fear: damage lets the target repeat the save that ends the effect.
  const hurt = state.actors[target.id];
  if (hurt && dealt > 0)
    events.push(...furyEvents(hurt, { ...context, state }));
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
  magical = false,
): { amount: number; events: SystemEvent[] } {
  const targetStats = deriveStats(target, context);
  // Spell Resistance: a spell's damage is halved, unless the bearer resists its type already.
  if (
    magical &&
    hasPassive(targetStats, "spellDamageResistance") &&
    !damageResponses(target, context).resistances.includes(type)
  ) {
    amount = Math.floor(amount / 2);
  }
  const { combat } = context.state;
  const turnKey = (id: string) =>
    `${id}@${String(combat?.round ?? 0)}:${String(combat?.index ?? 0)}`;
  const worn = passiveModifiers(targetStats.passives).find(
    (modifier) =>
      modifier.kind === "damageReduction" &&
      (modifier.damage === undefined || modifier.damage === type) &&
      (!modifier.magical || magical) &&
      (!modifier.oncePerTurn ||
        !target.usedThisTurn.includes(turnKey("damage-reduction"))) &&
      (!modifier.able || !hasCondition(target, ...INCAPACITATING)),
  );
  const wornEvents: SystemEvent[] = [];
  if (worn?.kind === "damageReduction" && amount > 0) {
    // Burning Life Force: Hit Point Dice spent for more.
    const burned = worn.hitDice
      ? spendHitDice(
          target,
          Math.max(1, evaluateFormula(worn.hitDice, targetStats)),
          context,
        )
      : null;
    if (burned) wornEvents.push(...burned.events);
    amount = Math.max(
      0,
      amount -
        rollAmount(worn.amount, targetStats, context.dice) -
        (burned?.total ?? 0),
    );
    if (worn.oncePerTurn) {
      wornEvents.push(
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: target.id,
          key: turnKey("damage-reduction"),
        }),
      );
    }
  }
  // Bastion of Law: as many of the ward's dice as the damage needs, on average, spent and rolled.
  // shortcut: a hit of two damage types reads the ward as it was before the hit for each.
  const ward = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "wardDice",
  );
  if (ward?.modifier.kind === "wardDice" && amount > 0) {
    const { count, die } = ward.modifier;
    const spend = Math.min(count, Math.ceil(amount / ((die + 1) / 2)));
    let cut = 0;
    for (let left = spend; left > 0; left--) cut += context.dice.roll(die);
    amount = Math.max(0, amount - cut);
    wornEvents.push(
      dndEvent(`${NS}:effectEnded`, {
        actor: target.id,
        sourceId: ward.sourceId,
        casterId: ward.casterId,
      }),
      ...(count > spend
        ? [
            dndEvent(`${NS}:effectAdded`, {
              actor: target.id,
              effect: {
                ...ward,
                modifier: { ...ward.modifier, count: count - spend },
              },
            }),
          ]
        : []),
    );
  }
  const effect = target.activeEffects.find(
    ({ modifier }) =>
      modifier.kind === "damageReduction" && modifier.damage === type,
  );
  if (effect?.modifier.kind !== "damageReduction" || amount <= 0) {
    return { amount, events: wornEvents };
  }
  // usedThisTurn clears only as the bearer's own turn starts, so the key names the turn.
  const key = turnKey(effect.sourceId);
  if (target.usedThisTurn.includes(key)) {
    return { amount, events: wornEvents };
  }
  const cut = rollAmount(
    effect.modifier.amount,
    deriveStats(target, context),
    context.dice,
  );
  return {
    amount: Math.max(0, amount - cut),
    events: [
      ...wornEvents,
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key }),
    ],
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

// An hour or more without Concentration outlasts the fight, counted down by rests after it (rest.ts), and one that
// lasts until a Long Rest outlasts fights and scenes until then.
// shortcut: anything shorter ends with the fight, as the scenes between fights take longer than ten minutes.
// Outside a fight (`between`), as cast in a scene (camp.ts), the effect lasts the scene, or its hours, Concentration
// or not; a scene takes about an hour.
export function lingersFor(
  duration: Duration,
  between = false,
): {
  lingers?: number | "longRest";
} {
  if (typeof duration === "object" && "until" in duration)
    return duration.until === "longRest"
      ? { lingers: "longRest" }
      : between
        ? { lingers: 0 }
        : {};
  if (typeof duration === "object" && "minutes" in duration)
    return between || !("concentration" in duration)
      ? duration.minutes >= 60 || between
        ? { lingers: Math.floor(duration.minutes / 60) }
        : {}
      : {};
  return between ? { lingers: 0 } : {};
}

// A timed spell's minutes, and a turn of the target's, are counted in rounds by its `lasts` (lastsFor).
// A creature in no form, or in one this caster gave it, can take a new one, as using Wild Shape again.
const ownForm = (target: Actor, caster: Actor): boolean =>
  target.activeEffects.every(
    ({ modifier, casterId }) =>
      modifier.kind !== "form" || casterId === caster.id,
  );

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
  const casts = action?.spellLevel !== null && action?.spellLevel !== undefined;
  return actor.activeEffects.flatMap(({ endsOn, sourceId, casterId }) =>
    endsOn === "action" ||
    (endsOn === "attack" && harms) ||
    (endsOn === "spell" && (harms || casts))
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
    if (passive.opportunity && combat && turnId(combat) !== target.id) {
      return [];
    }
    if (spell && !passive.spells) return [];
    if (passive.critical && !critical) return [];
    if (passive.while && !underEffect(attacker, passive.while)) return [];
    if (passive.firstRound && (combat?.round ?? 1) > 1) return [];
    if (passive.ownTurn && combat && turnId(combat) !== attacker.id) {
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
      ...(passive.selfEffects ?? []).flatMap((effect) =>
        effect.kind === "reactionMove"
          ? reactionMove(
              { ...attacker, budget: { ...attacker.budget, reaction: true } },
              context,
              effect,
              target,
            ).filter((event) => event.kind !== `${NS}:budgetSpent`)
          : leafEvents([effect], key, attacker, attacker, context),
      ),
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

// A spell stopped, by Dispel Magic or a counter: a use of each `stopRegain` resource back.
export function stopRegains(caster: Actor, stats: Stats): SystemEvent[] {
  return stats.passives.flatMap((passive) =>
    passive.kind === "stopRegain" &&
    (caster.resourcesSpent[passive.resource] ?? 0) > 0
      ? [
          dndEvent(`${NS}:resourceRestored`, {
            actor: caster.id,
            resource: passive.resource,
            amount: 1,
          }),
        ]
      : [],
  );
}

// Empowered Healing: the caster or an ally within 5 feet of it whose `empoweredHealing` use is left this turn spends
// it, and its resource, for the healing dice to be rolled again when low.
function empowerer(
  caster: Actor,
  context: Context,
): { readonly events: SystemEvent[] } | null {
  for (const bearer of [caster, ...allies(context.state, caster)]) {
    if (
      bearer.id !== caster.id &&
      distanceFeet(bearer.position, caster.position) > 5
    ) {
      continue;
    }
    if (bearer.usedThisTurn.includes(EMPOWERED_HEALING)) continue;
    if (hasCondition(bearer, ...INCAPACITATING) || isDown(bearer)) continue;
    const own = deriveStats(bearer, context);
    const passive = own.passives.find(
      (item) => item.kind === "empoweredHealing",
    );
    if (passive?.kind !== "empoweredHealing") continue;
    if (
      (bearer.resourcesSpent[passive.resource] ?? 0) >=
      (own.resources[passive.resource] ?? 0)
    ) {
      continue;
    }
    return {
      events: [
        dndEvent(`${NS}:resourceSpent`, {
          actor: bearer.id,
          resource: passive.resource,
        }),
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: bearer.id,
          key: EMPOWERED_HEALING,
        }),
      ],
    };
  }
  return null;
}
const EMPOWERED_HEALING = "empoweredHealing";

// What a caster's `spellHealing` passives add to the healing of a spell, cast with a slot of this level unless it's a
// free cast or one from an item.
function spellHealing(
  spell: string,
  sourceId: string,
  stats: Stats,
  context: Context,
  slotLevel: number | undefined,
): number {
  const slotted =
    slotLevel !== undefined &&
    !/:free(:|$)/.test(sourceId) &&
    castFrom(sourceId) === null;
  const known = maybeLookup(context, SpellSchema, spell);
  return stats.passives.reduce(
    (sum, passive) =>
      passive.kind === "spellHealing" &&
      (!passive.slot || slotted) &&
      (!passive.list || onList(spell, known, passive.list, context))
        ? sum +
          evaluateFormula(passive.bonus, stats) +
          (passive.dice ? rollDiceNotation(passive.dice, context.dice) : 0) +
          (passive.perSlot && slotted ? slotLevel : 0)
        : sum,
    0,
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
          ((spell !== null || divine) && hasPassive(stats, "maxHealingDice"))
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
        const item = sourceId.startsWith(ITEM_PREFIX)
          ? lookup(context, ItemSchema, sourceId.slice(ITEM_PREFIX.length))
          : undefined;
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
          );
        }
        // Being Incapacitated ends Concentration; with Boon of the Iron Mind only Petrified or Unconscious does.
        if (
          INCAPACITATING.includes(effect.condition) &&
          target.concentratingOn !== null &&
          (["petrified", "unconscious"].includes(effect.condition) ||
            !deriveStats(target, context).passives.some(
              (passive) =>
                passive.kind === "unshakableFocus" &&
                !passive.spells &&
                !passive.schools,
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
      case "note":
      case "disperse":
      case "animate":
      case "reactionAttack":
      case "reactionMove":
      case "randomAction":
      case "rollTable":
      case "escape":
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
  if (wind?.kind === "disperse" && wind.maxLevel !== undefined) {
    events.push(...overlapEnds(wind, effects, actor, at, context));
  } else if (wind?.kind === "disperse" && "area" in targeting) {
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
    // Time Stop ends once an area its caster leaves during it covers another creature.
    events.push(
      ...timeStopEnds(
        actor,
        Object.values(context.state.actors).filter(
          (other) =>
            other.position !== null &&
            !isDead(other) &&
            distanceFeet(other.position, centre) <= radius,
        ),
      ),
    );
    if (effect.zone === "sunlight") {
      events.push(...dazzled(centre, spellSource(action), actor, context));
    }
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
            ...(effect.dim ? { dim: effect.dim } : {}),
            ...(effect.ownerSees ? { ownerSees: true as const } : {}),
            ...(effect.reveals ? { reveals: true as const } : {}),
            ...(effect.zone === "image"
              ? { dc: effect.dc ?? spellSaveDc(stats) }
              : {}),
            ...(effect.decoy ? { decoy: true as const } : {}),
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

// A Robe of Eyes' wearer within its reach of a spell's sunlight is Blinded for a minute, saving at each turn's end.
function dazzled(
  centre: Square,
  sourceId: string,
  caster: Actor,
  context: Context,
): SystemEvent[] {
  return Object.values(context.state.actors).flatMap((bearer) => {
    if (!bearer.position || isDead(bearer)) return [];
    const passive = deriveStats(bearer, context).passives.find(
      (item) => item.kind === "dazzledBy",
    );
    if (
      passive?.kind !== "dazzledBy" ||
      distanceFeet(bearer.position, centre) > passive.within
    ) {
      return [];
    }
    return [
      dndEvent(`${NS}:effectAdded`, {
        actor: bearer.id,
        effect: {
          sourceId: `${sourceId}:dazzled`,
          casterId: caster.id,
          modifier: { kind: "condition", condition: "blinded" },
          ends: "spellDuration",
          ...lastsFor({ minutes: 1 }, caster, bearer, context.state),
          repeatSave: { ability: "con", dc: passive.dc },
        },
      }),
    ];
  });
}

// Daylight's sunlight ends Darkness of level 3 or lower that its area overlaps, and the Boon of the Bright Sun's
// light any spell's Darkness.
function overlapEnds(
  wind: Extract<LeafEffect, { kind: "disperse" }>,
  effects: readonly LeafEffect[],
  actor: Actor,
  at: Square,
  context: Context,
): SystemEvent[] {
  const own = effects.flatMap((effect) =>
    effect.kind === "zone" ? [effect] : [],
  );
  const reach = Math.max(0, ...own.map((effect) => effect.radius));
  const centre = own.some((effect) => effect.follows)
    ? (actor.position ?? at)
    : at;
  const kinds = wind.zones ?? ["fog"];
  return zonesOf(context.state).flatMap((zone) => {
    const owner = context.state.actors[zone.owner];
    const level =
      zone.level ?? spellLevelOf(zone.sourceId, owner, context) ?? 9;
    return kinds.includes(zone.zone) &&
      level <= (wind.maxLevel ?? 9) &&
      distanceFeet(zone.at, centre) <= zone.radius + reach
      ? [
          dndEvent(`${NS}:effectEnded`, {
            actor: zone.owner,
            sourceId: zone.sourceId,
            casterId: zone.owner,
          }),
        ]
      : [];
  });
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

// The square a creature is pushed away from to go north, south, east or west, by a d4's 1 to 4, as Infestation moves
// it. shortcut: a creature that can't move or has no Speed is moved all the same.
function randomFrom(target: Actor, face: number): Square | null {
  const at = target.position;
  if (!at) return null;
  const [dx, dy] = [
    [0, 1],
    [0, -1],
    [-1, 0],
    [1, 0],
  ][face - 1] ?? [0, 1];
  return { x: at.x + (dx ?? 0), y: at.y + (dy ?? 0) };
}

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

// A Helm of Brilliance's Taking Fire Damage: a d20, and on a 1 its gems' beams and the helm's end.
function backfireEvents(
  bearer: Actor,
  types: readonly Damage["type"][],
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(bearer, context);
  const events: SystemEvent[] = [];
  for (const passive of stats.passives) {
    if (
      passive.kind !== "spellBackfire" ||
      !types.includes(passive.damage) ||
      !bearer.inventory.includes(passive.item)
    ) {
      continue;
    }
    const die = context.dice.roll(passive.die);
    events.push(
      dndEvent(`${NS}:dieRolled`, {
        actor: bearer.id,
        die: passive.die,
        rolled: die,
        label: "Taking Fire Damage",
      }),
    );
    if (die !== 1) continue;
    const gems = passive.resources.reduce(
      (sum, resource) =>
        sum +
        Math.max(
          0,
          (stats.resources[resource] ?? 0) -
            (bearer.resourcesSpent[resource] ?? 0),
        ),
      0,
    );
    for (const other of Object.values(context.state.actors)) {
      if (
        other.id === bearer.id ||
        isDown(other) ||
        isDead(other) ||
        distanceFeet(bearer.position, other.position) > passive.radius ||
        gems <= 0
      ) {
        continue;
      }
      const save = rollSave(other, passive.ability, passive.dc, context, true);
      events.push(...save.events);
      if (!save.saved) {
        events.push(
          ...dealEvents(
            other,
            [
              {
                amount: finalDamage(
                  gems,
                  passive.type,
                  damageResponses(other, context),
                ),
                type: passive.type,
              },
            ],
            false,
            context,
            bearer,
            true,
          ).events,
        );
      }
    }
    events.push(
      dndEvent(`${NS}:itemUsed`, { actor: bearer.id, item: passive.item }),
    );
  }
  return events;
}

// Storm's Strength: saves against the caster's spells dealing these types have Disadvantage.
function stormStrength(action: KnownAction, stats: Stats): boolean {
  if (action.spellLevel === null) return false;
  const types = action.activation.resolution.damage.map(({ type }) => type);
  return stats.passives.some(
    (passive) =>
      passive.kind === "stormStrength" &&
      passive.damage.some((type) => types.includes(type)),
  );
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

// What taking the Dash or Disengage action gives its taker until its turn ends, as Speedy's Dash over Difficult Terrain.
export function tacticRiderEvents(
  actor: Actor,
  stats: Stats,
  tactic: "dash" | "disengage",
): SystemEvent[] {
  return stats.passives.flatMap((passive, index) =>
    passive.kind === "tacticRider" && passive.tactic === tactic
      ? passive.modifiers.map((modifier) =>
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              sourceId: `tactic-rider:${tactic}:${String(index)}`,
              casterId: actor.id,
              modifier,
              ends: "casterTurnEnd",
            },
          }),
        )
      : [],
  );
}

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
  // Shield against Magic Missile, or Spell Thief: a reaction may turn the spell aside before it lands.
  const aside = spell
    ? spellAimedAt(action, actor, aimedAt, context)
    : { targets: aimedAt, events: [] };
  events.push(...aside.events);
  if (spell) events.push(...turnedOn(actor, aside.targets, stats));
  const targets = spell
    ? sculpted(
        aside.targets.filter(
          (target) => !immuneToSpell(target, spell, context, action),
        ),
        action,
        actor,
        stats,
        context,
        slotLevel ?? action.spellLevel ?? 0,
      )
    : aimedAt;
  const mastered = masteredTypes(stats, action.spellLevel !== null);
  const floors = flooredTypes(stats, action.spellLevel !== null);
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
          effect.kind === "choose" ||
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
      actor,
      action.spellLevel !== null,
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
          : floored(masteredDice(context.dice, type, floors, rerolled)),
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
        if (item.only && !exemptFrom(item.only, target, met)) return [];
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
      // The Hide action as part of another, as Shrouding Spells', comes once the rest is done (actions.ts).
      if (resolution.effects.some((effect) => effect.kind === "hide")) {
        frames.push(frame("hideNow", { actor: actor.id }));
      }
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
            // A spell's weapon attack lands its other effects only on a hit, as Booming Blade's (combat/attack.ts).
            weaponAttackOf(resolution) ? [] : shared(target),
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
                effect.halfSpeed
                  ? Math.floor(deriveStats(target, context).speed / 2)
                  : effect.movement,
                context,
                effect.provokes,
                effect.beside === undefined
                  ? undefined
                  : { actor: actor.id, feet: effect.beside },
                action.id,
                effect.fly,
                effect.retrace,
              ),
            );
          }
          const choice =
            effect.kind === "polymorph" &&
            target.side === actor.side &&
            ownForm(target, actor)
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
          if (effect.kind === "rollTable") {
            const table = tableOf(effect.from, context);
            // A channeled spirit is unleashed: its kept face, and the effect that kept it ends.
            const kept = effect.channeled
              ? actor.activeEffects.find(
                  ({ modifier }) =>
                    modifier.kind === "channeled" &&
                    modifier.from === effect.from,
                )
              : undefined;
            const face =
              kept?.modifier.kind === "channeled"
                ? kept.modifier.face
                : undefined;
            if (table && (!effect.channeled || face !== undefined)) {
              if (kept) {
                events.push(
                  dndEvent(`${NS}:effectEnded`, {
                    actor: actor.id,
                    sourceId: kept.sourceId,
                  }),
                );
              }
              const rolled = tableRoll(
                table,
                action,
                actor,
                undefined,
                target,
                slotLevel ?? action.spellLevel ?? 0,
                context,
                face,
              );
              events.push(...rolled.events);
              frames.push(...rolled.frames);
            }
          }
          // Teleport's getaway: the fight ends as a flight, where the story lets the party flee.
          if (effect.kind === "escape" && context.state.combat?.canFlee) {
            frames.push(frame("escape", { actor: actor.id }));
          }
          if (effect.kind === "channel" && effect.pick) {
            const table = tableOf(effect.from, context);
            const sides =
              deriveStats(actor, context).scaling[effect.dieSize] ?? 6;
            if (table) {
              frames.push(
                channelPickFrame(actor, effect.from, table, sides, target),
              );
            }
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
      // Heightened Spell: the target's later saves against a spell held by Concentration are at Disadvantage too.
      if (heightened !== undefined && action.concentrates) {
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: heightened,
            effect: {
              sourceId: action.id,
              casterId: actor.id,
              modifier: {
                kind: "disadvantage",
                on: "saves",
                casterSpells: true,
              },
              ends: "concentration",
            },
          }),
        );
      }
      // Magical Ambush: an Invisible caster's spell is saved against with Disadvantage.
      const ambushing =
        action.spellLevel !== null &&
        hasCondition(actor, "invisible") &&
        hasPassive(stats, "magicalAmbush");
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
          (!edge.immuneTo || immuneToCondition(met, edge.immuneTo)) &&
          (!edge.charmedByCaster || charmersOf(target).has(actor.id))
            ? [edge.roll]
            : [],
        );
        // Cause Fear: a creature of a type it can't touch is left out altogether.
        if (edges.includes("immune")) continue;
        // shortcut: cover counts from the caster, even for a sphere whose centre is elsewhere.
        const { saved: rolledSave, events: saveEvents } = spared.has(target.id)
          ? { saved: true, events: [] }
          : edges.includes("succeed") ||
              edges.includes("fail") ||
              (resolution.willing && target.side === actor.side)
            ? { saved: edges.includes("succeed"), events: [] }
            : rollSave(
                target,
                resolution.ability,
                dc,
                context,
                action.spellLevel !== null,
                coverAgainst(context.state, actor, target, context),
                conditionsApplied(resolution.onFail),
                heightened === target.id ||
                  edges.includes("disadvantage") ||
                  ambushing ||
                  stormStrength(action, stats),
                resolution.advantage === true || edges.includes("advantage"),
                source,
                action.saveDice
                  ? rollDiceNotation(action.saveDice, context.dice)
                  : 0,
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
        const school =
          action.spellLevel === null
            ? undefined
            : spellOf(action.id, actor, context)?.school;
        const turning = saved
          ? deriveStats(target, context).passives.find(
              (passive) =>
                passive.kind === "spellTurning" &&
                action.spellLevel !== null &&
                (slotLevel ?? action.spellLevel) <= passive.upTo &&
                (!passive.schools ||
                  (school !== undefined && passive.schools.includes(school))),
            )
          : undefined;
        const turned = turning?.kind === "spellTurning" && !turning.deflectOnly;
        // And with its Reaction, a spell aimed at it alone is turned back at its caster, who saves against it.
        if (turning?.kind === "spellTurning" && targets.length === 1) {
          const deflected = deflectedSpell(
            action,
            actor,
            target,
            context,
            turning,
          );
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
        const scaled = (amount: number): number => {
          if (turned) return 0;
          if (evaded) return saved ? 0 : halved(amount);
          if (!saved || resolution.onSuccessDamage === "full") return amount;
          return resolution.onSuccessDamage === "half" &&
            !spared.has(target.id) &&
            !interposed
            ? halved(amount)
            : 0;
        };
        // Lightning Lure's damage waits on where its pull leaves the target.
        const within = resolution.damageWithin;
        if (!landed && within === undefined) {
          applyRolled(target, damage(target), scaled);
        }
        // A Helm of Brilliance: Fire from a failed save against a spell may set its gems off.
        if (!saved && !turned && lastDealt > 0 && action.spellLevel !== null) {
          events.push(
            ...backfireEvents(
              target,
              resolution.damage.map(({ type }) => type),
              {
                ...context,
                state: events.reduce(applyDndEvent, context.state),
              },
            ),
          );
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
        if (!landed && within !== undefined) {
          const now = events.reduce(applyDndEvent, context.state).actors[
            target.id
          ];
          if (now && distanceFeet(actor.position, now.position) <= within) {
            applyRolled(target, damage(target), scaled);
          }
        }
        // A willing ally of Polymorph's that fails it by choice: the caster picks its form.
        for (const effect of turned || saved ? [] : resolution.onFail) {
          const choice =
            effect.kind === "polymorph" &&
            target.side === actor.side &&
            ownForm(target, actor)
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
        }
        // Detonate: an explosion round the target once its own save is done (combat/spell-riders.ts).
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
        // Aura of Life keeps the maximum whole.
        if (
          !saved &&
          !turned &&
          lastDealt > 0 &&
          resolution.onFail.some((effect) => effect.kind === "drainMaxHp") &&
          !zoneModifiers(target, context.state, context).some(
            (modifier) => modifier.kind === "keepMaxHp",
          )
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
              conditions: conditionsApplied(resolution.onFail),
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
// Sculpt Spells: only an Evocation, sparing 1 plus the spell's level of the caster's side.
// shortcut: the spared are the caster's side, the ones it would pick, and they're spared the whole spell.
function sculpted(
  targets: readonly Actor[],
  action: KnownAction,
  actor: Actor,
  stats: ReturnType<typeof deriveStats>,
  context: Context,
  slotLevel: number,
): readonly Actor[] {
  const school = schoolOf(action.id, context);
  const sculptor = stats.passives.find(
    (passive) =>
      passive.kind === "sculptor" &&
      (!passive.schools || passive.schools.some((item) => item === school)),
  );
  if (
    sculptor?.kind !== "sculptor" ||
    !("area" in action.activation.targeting)
  ) {
    return targets;
  }
  const most = sculptor.creatures + (sculptor.perLevel ? slotLevel : 0);
  let spared = 0;
  return targets.filter((target) => {
    if (target.side !== actor.side) return true;
    if (target.id === actor.id && !sculptor.perLevel) return false;
    spared += 1;
    return spared > most;
  });
}

// What an activation or a spell's rider does to the bearer's allies near it, whatever its targets, as Rallying Cry's
// healing with Second Wind: the most hurt first, up to each rider's count.
export function alliesRiderEvents(
  riders: readonly AlliesRider[],
  sourceId: string,
  actor: Actor,
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(actor, context);
  const spent: Record<string, number> = {};
  return riders.flatMap((rider) => {
    if (rider.without?.some((id) => stats.features.includes(id))) return [];
    const effects = [
      ...rider.effects,
      ...(rider.with ?? []).flatMap((more) =>
        stats.features.includes(more.feature) ? more.effects : [],
      ),
    ];
    const near = allies(context.state, actor)
      .filter(
        (ally) =>
          ally.id !== actor.id &&
          !isDead(ally) &&
          distanceFeet(actor.position, ally.position) <= rider.within,
      )
      .sort(
        (a, b) =>
          a.hp / deriveStats(a, context).maxHp -
          b.hp / deriveStats(b, context).maxHp,
      )
      .slice(
        0,
        rider.count
          ? Math.max(1, evaluateFormula(rider.count, stats))
          : Infinity,
      );
    if (near.length === 0) return [];
    const costs: SystemEvent[] = [];
    if (rider.resource) {
      const left =
        (stats.resources[rider.resource] ?? 0) -
        (actor.resourcesSpent[rider.resource] ?? 0) -
        (spent[rider.resource] ?? 0);
      if (left <= 0) return [];
      spent[rider.resource] = (spent[rider.resource] ?? 0) + 1;
      costs.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: rider.resource,
        }),
      );
    }
    return [
      ...costs,
      ...near.flatMap((ally) =>
        leafEvents(effects, sourceId, actor, ally, context),
      ),
    ];
  });
}
