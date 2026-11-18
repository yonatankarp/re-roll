import { type KnownAction } from "../../stats.ts";
import { type Actor, type DndState, isDead } from "../../state.ts";
import { type ContentAccess } from "#sdk";
import { AIM, ALL } from "../ids.ts";
import { inArea, parseSquare, type Square } from "../../grid.ts";
import { caughtBy } from "../../targeting.ts";
import { behindTotalCover, coverFor } from "../../sight.ts";
import {
  actorOf,
  allies,
  areaPool,
  enemies,
  fitsType,
  reaches,
  deadWithin,
  walledApart,
} from "../queries.ts";

// The squares and creatures an action aims at.

// The square an answer aims at ("@x,y" or "@id"), or null for one that aims at no square.
export function aimSquare(
  answerTarget: string,
  state: DndState,
): Square | null {
  if (!answerTarget.startsWith(AIM)) return null;
  const aimedAt = answerTarget.slice(AIM.length);
  return parseSquare(aimedAt) ?? state.actors[aimedAt]?.position ?? null;
}

export function resolveTargets(
  answerTarget: string,
  action: KnownAction,
  actor: Actor,
  context: ContentAccess & { readonly state: DndState },
): readonly Actor[] {
  const { state } = context;
  const { targeting } = action.activation;
  if ("self" in targeting) return [actor];
  // Revivify is the one aimed at the dead.
  const dead = "dead" in targeting && targeting.dead === true;
  const side = (
    targeting.side === "enemy"
      ? enemies(state, actor)
      : targeting.side === "ally"
        ? allies(state, actor)
        : [...enemies(state, actor), ...allies(state, actor)]
  ).filter(
    (item) =>
      isDead(item) === dead &&
      deadWithin(item, targeting) &&
      fitsType(item, targeting, context, actor),
  );
  if ("area" in targeting) {
    const { shape, radius } = targeting.area;
    // Aimed at a square ("@x,y") or a creature ("@id"), an area catches everyone in it, the caster's side too.
    const aim = aimSquare(answerTarget, state);
    if (aim && actor.position) {
      // Total cover from where it spreads keeps a creature out of it.
      const centre =
        shape === "sphere" ||
        shape === "cube" ||
        shape === "wall" ||
        shape === "ring"
          ? aim
          : actor.position;
      // Creatures of the caster's choice in it are only its side, as Conjure Barrage's.
      const chosen = targeting.choice
        ? new Set(side.map((item) => item.id))
        : null;
      return caughtBy(
        targeting,
        actor,
        aim,
        areaPool(targeting, context, actor),
      ).filter(
        (item) =>
          (chosen === null || chosen.has(item.id)) &&
          (item.id === actor.id ||
            (coverFor(state, centre, item, [actor.id]) !== "total" &&
              !walledApart(actor, item, action, state, context))),
      );
    }
    // Round the caster, or with no grid: only the side it's meant for, as if placed with care.
    return side.filter(
      (item) =>
        inArea(shape, radius, actor.position, actor.position, item.position) &&
        !walledApart(actor, item, action, state, context),
    );
  }
  const chosen = answerTarget === ALL ? [] : [actorOf(state, answerTarget)];
  const pool = side.filter(
    (item) =>
      !chosen.includes(item) &&
      reaches(action, actor, item) &&
      !behindTotalCover(state, actor, item),
  );
  // A higher slot can add targets to a single-target spell, and they go to the weakest after the one chosen.
  return [...chosen, ...[...pool].sort((a, b) => a.hp - b.hp)].slice(
    0,
    targeting.creatures,
  );
}
