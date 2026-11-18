// Moving: jumps, areas the bearer moves, and a steady Speed.
import type { Actor } from "../state.ts";
import type { Modifier } from "../schemas.ts";
import { type Stats, type KnownAction, passiveModifiers } from "./model.ts";

export const MOVE_ZONE = "zone-move:";

export const JUMP_BOOST = "jump-boost";

// A jump farther than walking allows, once a turn, for a little movement, as the Jump spell's 30 feet for 10.
export function jumpActions(actor: Actor, stats: Stats): KnownAction[] {
  const best = [
    ...actor.activeEffects.map(({ modifier }) => modifier),
    ...passiveModifiers(stats.passives),
  ].reduce<Extract<Modifier, { kind: "jumpBoost" }> | null>(
    (most, modifier) =>
      modifier.kind === "jumpBoost" && modifier.feet > (most?.feet ?? 0)
        ? modifier
        : most,
    null,
  );
  if (!best) return [];
  return [
    {
      id: JUMP_BOOST,
      name: `Jump (${String(best.feet)} ft for ${String(best.movement)} ft of movement)`,
      activation: {
        cost: [],
        oncePerTurn: JUMP_BOOST,
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [
            { kind: "teleport", feet: best.feet, movement: best.movement },
          ],
        },
      },
      spellLevel: null,
    },
  ];
}

// An action to move an area the bearer keeps, as Moonbeam's Magic action. shortcut: its reach is counted from the
// bearer, not from where the area stands.
export function zoneMoves(actor: Actor): KnownAction[] {
  const seen = new Set<string>();
  return actor.activeEffects.flatMap(
    ({ sourceId, modifier }): KnownAction[] => {
      if (modifier.kind !== "zone" || !modifier.area?.moves) return [];
      if (modifier.follows || seen.has(sourceId)) return [];
      seen.add(sourceId);
      return [
        {
          id: `${MOVE_ZONE}${sourceId}`,
          name: `Move ${modifier.name ?? "the area"}`,
          activation: {
            cost:
              modifier.area.moveWith === "free"
                ? []
                : [modifier.area.moveWith ?? "action"],
            ...(modifier.area.moveWith === "free"
              ? { oncePerTurn: `${MOVE_ZONE}${sourceId}` }
              : {}),
            targeting: {
              area: { shape: "sphere", radius: modifier.radius },
              range: modifier.area.moves,
              side: "enemy",
            },
            resolution: {
              kind: "automatic",
              damage: [],
              effects: [{ kind: "moveZone", source: sourceId }],
            },
          },
          spellLevel: null,
        },
      ];
    },
  );
}

export function hasSteadySpeed(stats: Stats, actor?: Actor): boolean {
  return (
    stats.passives.some((passive) => passive.kind === "steadySpeed") ||
    (actor?.activeEffects.some(
      ({ modifier }) => modifier.kind === "steadySpeed",
    ) ??
      false)
  );
}
