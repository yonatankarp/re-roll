import {
  damageResponses,
  deriveStats,
  type KnownAction,
  type Stats,
} from "../../stats.ts";
import {
  type Actor,
  dndEvent,
  hasCondition,
  INCAPACITATING,
  isDead,
  mountOf,
  isDown,
  NS,
  frame,
} from "../../state.ts";
import { type Frame, PLAYER_ACTOR, type SystemEvent } from "#sdk";
import { finalDamage } from "../../rules.ts";
import { type Damage, type LeafEffect, type Passive } from "../../schemas.ts";
import { distanceFeet } from "../../grid.ts";
import { playerTakes } from "../reactions.ts";
import { type Context, hasPassive } from "../queries.ts";
import { dealEvents } from "./damage.ts";
import { rollSave } from "./saves.ts";

// Magic items that act on a spell or a hit: spell turning, paired bands, a protected mount, a staff's retribution, a helm's backfire.

// A Ring of Spell Turning's Reaction: a spell that targeted only the bearer, with no area, is cast back at its caster,
// who saves against its own spell save DC. The player is asked first. shortcut: it comes back at the spell's own
// level, whatever slot it took, and not at all when the caster can't cast it again as an action of its own.
export function deflectedSpell(
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
export function pairedBandSpares(
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

// A Helm of Brilliance's Taking Fire Damage: a d20, and on a 1 its gems' beams and the helm's end.
export function backfireEvents(
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
