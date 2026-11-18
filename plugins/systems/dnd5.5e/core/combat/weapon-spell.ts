import type { Frame, SystemEvent } from "#sdk";
import type { LeafEffect } from "../schemas.ts";
import { type Actor, dndEvent, frame, NS } from "../state.ts";
import { deriveStats, type KnownAction, weaponFits } from "../stats.ts";
import { type Context, reaches } from "./queries.ts";

// A weapon attack made through a spell, as True Strike's or Swift Quiver's: the caster's own weapon that reaches the
// target, the hardest-hitting first, changed by the spell for the next attack it makes.

const averageOf = (action: KnownAction): number => {
  const { resolution } = action.activation;
  return resolution.damage.reduce((sum, { amount }) => {
    const [count = 0, sides = 0] = (amount.dice ?? "0d0")
      .split("d")
      .map(Number);
    return sum + (count * (sides + 1)) / 2;
  }, 0);
};

export function weaponAttackResult(
  effect: Extract<LeafEffect, { kind: "weaponAttack" }>,
  sourceId: string,
  actor: Actor,
  target: Actor,
  context: Context,
): { events: SystemEvent[]; frames: Frame[] } {
  const [weapon] = deriveStats(actor, context)
    .actions.filter(
      (action) =>
        weaponFits(action, effect.change, context) &&
        reaches(action, actor, target),
    )
    .sort((a, b) => averageOf(b) - averageOf(a));
  if (!weapon) return { events: [], frames: [] };
  // Which weapon it is says nothing of how the attack changes.
  const { spellAbility, dice, type, extra } = effect.change;
  return {
    events:
      spellAbility || dice || type || extra
        ? [
            dndEvent(`${NS}:effectAdded`, {
              actor: actor.id,
              effect: {
                sourceId,
                casterId: actor.id,
                modifier: { kind: "weaponSpell", ...effect.change, once: true },
                ends: "casterNextTurn",
              },
            }),
          ]
        : [],
    frames: Array.from({ length: effect.times }, () =>
      frame("attackRoll", {
        attacker: actor.id,
        actionId: weapon.id,
        target: target.id,
        spell: sourceId,
      }),
    ),
  };
}
