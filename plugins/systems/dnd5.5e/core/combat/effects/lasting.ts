import { type KnownAction } from "../../stats.ts";
import { type Actor, dndEvent, NS } from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { type Duration } from "../../schemas.ts";

// How long an effect lasts, and what ends it.

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
export const ownForm = (target: Actor, caster: Actor): boolean =>
  target.activeEffects.every(
    ({ modifier, casterId }) =>
      modifier.kind !== "form" || casterId === caster.id,
  );

export function effectEnds(
  duration: Duration,
): "concentration" | "casterNextTurn" | "casterNextTurnEnd" | "spellDuration" {
  // What an instantaneous effect leaves stays until something ends it, as Prone until the creature stands.
  if (typeof duration !== "object") return "spellDuration";
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
