import { type Context, rollSave } from "../combat.ts";
import { braced, heldInPlace } from "../combat/effects.ts";
import { pushTo } from "../grid.ts";
import { type Ability } from "../schemas.ts";
import { type Actor, dndEvent, NS } from "../state.ts";
import { deriveStats, modifierFor, saveBonus, type Stats } from "../stats.ts";
import { type ContentAccess, type SystemEvent } from "#sdk";

// An Unarmed Strike's Grapple or Shove, and a mastery's save: 8 + the ability modifier + Proficiency Bonus.
export function saveDc(stats: Stats, ability: Ability): number {
  return 8 + modifierFor(stats, ability) + stats.proficiency;
}

// The target picks the better of Strength and Dexterity against a Grapple or Shove.
export function betterSave(
  target: Actor,
  access: ContentAccess,
): "str" | "dex" {
  const stats = deriveStats(target, access);
  return saveBonus(stats, "dex") > saveBonus(stats, "str") ? "dex" : "str";
}

export function reportedSave(
  target: Actor,
  ability: Ability,
  dc: number,
  label: string,
  context: Context,
): { readonly saved: boolean; readonly events: readonly SystemEvent[] } {
  // The roll for the history (and a Legendary Resistance), then the line saying what it was against.
  const { saved, events } = rollSave(target, ability, dc, context);
  return {
    saved,
    events: [
      ...events,
      dndEvent(`${NS}:saveReported`, {
        actor: target.id,
        ability,
        dc,
        success: saved,
        label,
      }),
    ],
  };
}

// The squares a creature is pushed through, straight away from `from`, stopping at a wall, a creature or the
// map's edge. Null when it can't move at all, or there's no map.

// Forced movement uses none of the creature's own Speed and provokes no Opportunity Attacks.
export function pushEvents(
  by: Actor,
  target: Actor,
  feet: number,
  context: Context,
): SystemEvent[] {
  const brace = braced(target, feet, context);
  const to =
    brace.feet > 0
      ? pushTo(by.position, target, brace.feet, context.state)
      : null;
  const held = to ? heldInPlace(target, context) : [];
  if (held.length > 0) return [...brace.events, ...held];
  return [
    ...brace.events,
    ...(to ? [dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 })] : []),
  ];
}
