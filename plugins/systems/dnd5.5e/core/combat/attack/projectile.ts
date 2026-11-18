import { z } from "zod";
import { type Actor, type DndState, isDown } from "../../state.ts";
import { ALL } from "../ids.ts";
import { behindTotalCover } from "../../sight.ts";
import { type SystemResult } from "#sdk";
import { afterDamage } from "../reactions.ts";
import { damageResponses, deriveStats, rollAmount } from "../../stats.ts";
import {
  actorOf,
  charmersOf,
  type Context,
  enemies,
  findAction,
} from "../queries.ts";
import { concentrationFrame, dealEvents } from "../effects.ts";
import { AttackSchema } from "./payloads.ts";

// Who a projectile or later attack actually goes for, given who is still standing.
export function aimAt(
  id: string,
  attacker: Actor,
  state: DndState,
): Actor | undefined {
  const standing = enemies(state, attacker).filter((item) => !isDown(item));
  if (id === ALL) {
    const charmers = charmersOf(attacker);
    return standing
      .filter(
        (item) =>
          !charmers.has(item.id) && !behindTotalCover(state, attacker, item),
      )
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
      amount: rollAmount(amount, stats, dice),
      response: responses,
      type,
    })),
    false,
    context,
  );
  return {
    events,
    frames: afterDamage(
      target,
      dealt,
      {
        source: attacker.id,
        types: resolution.damage.map(({ type }) => type),
        spell: action.spellLevel !== null,
      },
      concentrationFrame(target, dealt),
      context,
    ),
  };
}
