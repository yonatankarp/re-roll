import { type ContentAccess, type SystemEvent } from "#sdk";
import {
  type ActiveEffect,
  type Actor,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../state.ts";
import { deriveStats, lookup, modifierFor } from "../stats.ts";
import { distanceFeet, rangeFeet } from "../grid.ts";
import { MonsterSchema } from "../schemas.ts";

// Grapples: the DC to escape one, and when one ends on its own. A grapple is the effect that holds a
// creature, and every rider "until the grapple ends" shares its source, so ending that source ends them all.

// One effect per grapple holding this creature. Two monsters of one kind share the action's source, so a grapple
// is its grappler and source together.
export function grapplesOn(actor: Actor): readonly ActiveEffect[] {
  const seen = new Set<string>();
  return actor.activeEffects.filter((effect) => {
    const { modifier, sourceId, casterId } = effect;
    if (modifier.kind !== "condition" || modifier.condition !== "grappled") {
      return false;
    }
    const key = `${casterId}|${sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The stat block's "(escape DC 14)" on the line of the action that grappled, or else 8 + Strength modifier +
// Proficiency Bonus, as an Unarmed Strike's grapple has.
export function escapeDc(
  grapple: ActiveEffect,
  state: DndState,
  access: ContentAccess,
): number {
  const grappler = state.actors[grapple.casterId];
  if (!grappler) return 10;
  const stats = deriveStats(grappler, access);
  const formula = 8 + modifierFor(stats, "str") + stats.proficiency;
  if (grappler.source.kind !== "monster") return formula;
  const monster = lookup(access, MonsterSchema, grappler.source.statBlockId);
  const index = /^monster:(\d+)$/.exec(grapple.sourceId)?.[1];
  const name = index === undefined ? undefined : monster.actions[+index]?.name;
  const line = name
    ? monster.text
        ?.split("\n")
        .find(
          (item) => item.startsWith(`${name}.`) || item.startsWith(`${name} (`),
        )
    : undefined;
  const printed = /\bescape DC (\d+)/i.exec(line ?? "")?.[1];
  return printed ? Number(printed) : formula;
}

// How far a grapple holds: the reach or range of what made it, and at least 5 feet.
function holdFeet(
  grapple: ActiveEffect,
  grappler: Actor,
  access: ContentAccess,
) {
  const action = deriveStats(grappler, access).actions.find(
    (item) => item.id === grapple.sourceId,
  );
  const targeting = action?.activation.targeting;
  return Math.max(
    5,
    targeting && "range" in targeting ? rangeFeet(targeting.range) : 0,
  );
}

// A grapple ends when its grappler is gone, down or Incapacitated, or the two end up farther apart than it holds.
export function releasedGrapples(
  state: DndState,
  access: ContentAccess,
): SystemEvent[] {
  return (state.combat?.order ?? []).flatMap((id) => {
    const held = state.actors[id];
    if (!held) return [];
    return grapplesOn(held).flatMap((grapple) => {
      const grappler = state.actors[grapple.casterId];
      const holds =
        grappler !== undefined &&
        !isDown(grappler) &&
        !hasCondition(grappler, ...INCAPACITATING) &&
        distanceFeet(grappler.position, held.position) <=
          holdFeet(grapple, grappler, access);
      return holds
        ? []
        : [
            dndEvent(`${NS}:effectEnded`, {
              actor: held.id,
              sourceId: grapple.sourceId,
              casterId: grapple.casterId,
            }),
          ];
    });
  });
}
