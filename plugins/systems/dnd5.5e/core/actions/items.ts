import { type Context, dealEvents, rollSave } from "../combat.ts";
import { castAction, CastCheckSchema } from "../combat/actions.ts";
import { payCosts } from "../combat/effects.ts";
import { ITEM_PREFIX } from "../combat/ids.ts";
import { actorOf, findAction, slotLevelFor } from "../combat/queries.ts";
import { tableOf, tableRoll } from "../combat/reactions.ts";
import { ItemSchema } from "../schemas.ts";
import { type Actor, dndEvent, frame, NS } from "../state.ts";
import { deriveStats, lookup, rollAmount } from "../stats.ts";
import { abilityCheck } from "./checks.ts";
import { CHECK_END } from "./ids.ts";
import {
  frameHandler,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { z } from "zod";

// The save attuning to an item calls for (MagicItemSchema `attuneSave`, gear.ts), made as the Attunement starts: a
// failure is the attuner's end, as the Wand of Orcus's death or the Book of Vile Darkness's Larva, and a success takes
// the item's damage. Its rolls are carried by the events.
export const attuneSaveHandlers = {
  [`${NS}:attuneSave`]: frameHandler({
    schema: z.strictObject({ actor: z.string(), item: z.string() }),
    run: ({ actor: actorId, item }, context: Context): SystemResult => {
      const actor = actorOf(context.state, actorId);
      const magic = lookup(context, ItemSchema, item.split("--")[0] ?? item);
      if (magic.type !== "magicItem" || !magic.attuneSave) {
        throw new Error(`${item} asks no save to attune`);
      }
      const { ability, dc, unless, saved } = magic.attuneSave;
      const stats = deriveStats(actor, context);
      if (stats.creatureType && unless?.includes(stats.creatureType)) {
        return {};
      }
      const save = rollSave(actor, ability, dc, context, true);
      if (!save.saved) {
        return {
          events: [
            ...save.events,
            dndEvent(`${NS}:damaged`, {
              actor: actor.id,
              amount: Math.max(0, actor.hp) + actor.tempHp,
              type: "necrotic",
              critical: false,
              massive: true,
            }),
            { kind: "actorDefeated", actor: actor.id },
            // The story follows the player's character, so its end is the run's, as in a fight.
            ...(actor.id === PLAYER_ACTOR
              ? [{ kind: "partyDefeated" as const }]
              : []),
          ],
        };
      }
      const hits = saved.map((damage) => ({
        amount: rollAmount(damage.amount, stats, context.dice),
        type: damage.type,
      }));
      return {
        events: [
          ...save.events,
          ...dealEvents(actor, hits, false, context).events,
        ],
      };
    },
  }),
};

// The check an action needs as it's taken (KnownAction `castCheck`), as reading a Spell Scroll above the reader's
// level: a failure pays for it and wastes it, an item with it, and a success takes it.
export const castCheckFrames = {
  [`${NS}:castCheck`]: frameHandler({
    schema: CastCheckSchema,
    run: (cast, context: Context): SystemResult => {
      const actor = actorOf(context.state, cast.actor);
      const slotLevel = slotLevelFor(actor, cast.actionId, cast.slot, context);
      const action = findAction(actor, cast.actionId, context, slotLevel);
      const check = action.castCheck;
      if (!check) throw new Error(`${action.id} needs no check`);
      const rolled =
        check.chance === undefined
          ? abilityCheck(
              actor,
              check.skill,
              check.ability,
              check.dc,
              (success) => (success ? action.name : `${action.name} fails`),
              context,
            )
          : failChance(actor, action.name, check.chance, context);
      if (rolled.success) {
        const taken = castAction(
          actor,
          cast.actionId,
          cast.slot,
          cast.target,
          context,
          false,
          cast.shape,
          true,
        );
        return {
          ...taken,
          events: [...rolled.events, ...(taken.events ?? [])],
        };
      }
      // A Hat of Many Spells' use is kept on a failure, though the slot is spent.
      const keep = check.keep;
      const paid = keep
        ? {
            ...action,
            activation: {
              ...action.activation,
              cost: action.activation.cost.filter(
                (cost) =>
                  !(
                    typeof cost === "object" &&
                    "resource" in cost &&
                    cost.resource === keep
                  ),
              ),
            },
          }
        : action;
      // A Hat of Many Spells' failure rolls on its table instead.
      const table = check.table ? tableOf(check.table, context) : undefined;
      const random = table
        ? tableRoll(
            table,
            action,
            actor,
            undefined,
            context.state.actors[
              typeof cast.target === "string"
                ? cast.target
                : (cast.target[0] ?? "")
            ],
            action.spellLevel ?? 0,
            context,
          )
        : { events: [], frames: [] };
      return {
        events: [
          ...rolled.events,
          ...payCosts(paid, actor, context, slotLevel),
          ...random.events,
        ],
        frames: [
          ...random.frames,
          ...(cast.actionId.startsWith(ITEM_PREFIX) || check.breaks
            ? [
                frame("useItem", {
                  actor: actor.id,
                  item: check.breaks ?? cast.actionId.slice(ITEM_PREFIX.length),
                }),
              ]
            : []),
          CHECK_END,
          frame("afterAction", { actor: actor.id }),
        ],
      };
    },
  }),
};

// A percent chance that something fails, as a Wind Fan's tearing: a d100 at or under it fails.
function failChance(
  actor: Actor,
  label: string,
  chance: number,
  context: Context,
): { readonly success: boolean; readonly events: SystemEvent[] } {
  const roll = context.dice.roll(100);
  const success = roll > chance;
  return {
    success,
    events: [
      dndEvent(`${NS}:rollReported`, {
        actor: actor.id,
        against: "check",
        natural: roll,
        total: roll,
        target: chance + 1,
        success,
        label: success ? label : `${label} fails`,
      }),
    ],
  };
}
