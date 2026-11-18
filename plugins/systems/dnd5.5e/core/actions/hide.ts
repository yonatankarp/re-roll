import { type Context, enemies } from "../combat.ts";
import { hasPassive, sizeOf } from "../combat/queries.ts";
import { coverBetween, squareKey } from "../grid.ts";
import { blindedTo, coverFor, lightAt, seeing } from "../sight.ts";
import { type Actor, dndEvent, type DndState, isDead, NS } from "../state.ts";
import { deriveStats, type Stats } from "../stats.ts";
import { hasTactic } from "../tactics.ts";
import { abilityCheck } from "./checks.ts";
import { standing } from "./common.ts";
import { HIDE, HIDE_DC } from "./ids.ts";
import { type ContentAccess, frameHandler, type SystemEvent } from "#sdk";
import { z } from "zod";

const NO_SQUARES: ReadonlySet<string> = new Set();

// Whether `actor` may Hide: every foe that could see it sees it through at least Three-Quarters Cover or not at
// all, or, with Naturally Stealthy, past a creature at least one size larger.
export function hiddenFromAll(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): boolean {
  const larger = hasPassive(deriveStats(actor, access), "hideBehindLarger")
    ? Object.values(state.actors).filter(
        (item) =>
          item.id !== actor.id &&
          item.position !== null &&
          !isDead(item) &&
          sizeOf(item, access) > sizeOf(actor, access),
      )
    : [];
  return standing(enemies(state, actor)).every((foe) => {
    if (blindedTo(foe, actor, access)) return true;
    const cover = coverFor(state, foe.position, actor, [foe.id]);
    if (cover === 5 || cover === "total") return true;
    if (seeing(foe, actor.position, state, access) === "none") return true;
    const between = larger.flatMap((item) =>
      item.id !== foe.id && item.position ? [squareKey(item.position)] : [],
    );
    return (
      between.length > 0 &&
      coverBetween(
        foe.position,
        actor.position,
        NO_SQUARES,
        { half: NO_SQUARES, threeQuarters: NO_SQUARES },
        new Set(between),
      ) !== 0
    );
  });
}

// The Hide action's Stealth check, DC 15, and on a success the Invisible condition and the total a Search must beat.
export function hideEvents(actor: Actor, context: Context): SystemEvent[] {
  const stats = deriveStats(actor, context);
  const rolled = abilityCheck(
    actor,
    "stealth",
    "dex",
    HIDE_DC,
    () => "stealth",
    context,
    hasPassive(stats, "hideAdvantage"), // Skulker's Fog of War
  );
  const hide = (modifier: Actor["activeEffects"][number]["modifier"]) =>
    dndEvent(`${NS}:effectAdded`, {
      actor: actor.id,
      effect: {
        sourceId: HIDE,
        casterId: actor.id,
        modifier,
        ends: "spellDuration",
      },
    });
  return [
    ...rolled.events,
    ...(rolled.success
      ? [
          hide({ kind: "condition", condition: "invisible" }),
          hide({ kind: "tactic", tactic: "hidden", value: rolled.total }),
        ]
      : []),
  ];
}

// The Hide action as part of another, where it could Hide, as Shrouding Spells' after a spell.
export const hideFrames = {
  [`${NS}:hideNow`]: frameHandler({
    schema: z.object({ actor: z.string() }),
    run: (payload, context: Context) => {
      const actor = context.state.actors[payload.actor];
      return actor &&
        !hasTactic(actor, "hidden") &&
        hiddenFromAll(actor, context.state, context)
        ? { events: hideEvents(actor, context) }
        : {};
    },
  }),
};

// A Nature's Mantle: in Dim Light or Darkness, Hide as a Bonus Action even with a foe watching.
export function dimHide(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): boolean {
  return (
    hasPassive(stats, "hideInDim") &&
    lightAt(actor.position, state, access) !== "bright"
  );
}
