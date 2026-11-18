import { type Actor, dndEvent, NS } from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { HIDE_SOURCE, STEALTH_ATTACK } from "../../tactics.ts";
import { type Context, findAction } from "../queries.ts";

// Whether a strike option shares its once-a-turn name with one picked before it for the same hit, so the hit's
// extra die isn't rolled twice, as Improved Brutal Strike's two effects.
export function sharedOnce(
  attacker: Actor,
  id: string,
  before: readonly string[],
  context: Context,
): boolean {
  const key = (actionId: string) =>
    findAction(attacker, actionId, context).activation.oncePerTurn;
  const own = key(id);
  return typeof own === "string" && before.some((other) => key(other) === own);
}

// A strike option with `keepsHidden` picked by an attacker that struck from hiding hides it again.
export function stayHidden(
  hit: {
    readonly strikes?: readonly string[] | undefined;
    readonly hidden?: number | undefined;
  },
  attacker: Actor,
  context: Context,
): SystemEvent[] {
  const { hidden } = hit;
  const keeps =
    hidden !== undefined &&
    (hit.strikes ?? []).some(
      (id) => findAction(attacker, id, context).activation.keepsHidden,
    );
  const hide = (modifier: Actor["activeEffects"][number]["modifier"]) =>
    dndEvent(`${NS}:effectAdded`, {
      actor: attacker.id,
      effect: {
        sourceId: HIDE_SOURCE,
        casterId: attacker.id,
        modifier,
        ends: "spellDuration",
      },
    });
  return keeps
    ? [
        hide({ kind: "condition", condition: "invisible" }),
        hide({ kind: "tactic", tactic: "hidden", value: hidden }),
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: attacker.id,
          key: STEALTH_ATTACK,
        }),
      ]
    : [];
}
