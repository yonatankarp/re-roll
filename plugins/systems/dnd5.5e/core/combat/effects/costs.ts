import {
  chargesOf,
  deriveStats,
  type KnownAction,
  lookup,
  rollDiceNotation,
  wishedKey,
} from "../../stats.ts";
import { type Actor, dndEvent, NS, SLOT_SPENT } from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { ItemSchema } from "../../schemas.ts";
import { castFrom, itemUseOf, spellOfSource } from "../ids.ts";
import {
  type Context,
  hasPassive,
  onceKey,
  onOwnTurn,
  slotToSpend,
} from "../queries.ts";
import { actingEnds } from "./lasting.ts";

// Paying an action's costs: its resources, an item's charges and a Healer's Kit's uses.

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
          ...(onOwnTurn(action) && !actor.usedThisTurn.includes(SLOT_SPENT)
            ? [
                dndEvent(`${NS}:oncePerTurnUsed`, {
                  actor: actor.id,
                  key: SLOT_SPENT,
                }),
              ]
            : []),
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
