import { deriveStats, type KnownAction, lookup } from "../../stats.ts";
import { type Actor, frame } from "../../state.ts";
import { type ContentAccess, type Frame } from "#sdk";
import { MonsterSchema } from "../../schemas.ts";
import { multiattackUses } from "../../multiattack-uses.ts";
import { currentShape, formOf } from "../../forms.ts";
import { type Context } from "../queries.ts";

// A Multiattack's other actions.

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
export function multiattackFrames(
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
