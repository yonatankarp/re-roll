import { type Actor, dndEvent, NS } from "../../state.ts";
import { WEAPON_PREFIX, weaponItemId } from "../ids.ts";
import { type SystemEvent } from "#sdk";
import { type KnownAction } from "../../stats.ts";
import { ItemSchema } from "../../schemas.ts";
import { type Context } from "../queries.ts";

// An attack with a weapon that fires ammunition, as Flame Arrows' quiver feeds.
export function firesAmmunition(
  action: KnownAction,
  context: Context,
): boolean {
  if (!action.id.startsWith(WEAPON_PREFIX)) return false;
  const item = ItemSchema.safeParse(
    context.content(weaponItemId(action.id)),
  ).data;
  return item?.type === "weapon" && item.properties.includes("ammunition");
}

// Flame Arrows: each attack with an Ammunition weapon draws a piece from the quiver, hit or miss, and the last ends it.
export function quiverDrawn(
  attacker: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  if (!firesAmmunition(action, context)) return [];
  return attacker.activeEffects.flatMap((effect) => {
    const { modifier } = effect;
    if (
      modifier.kind !== "hitDamage" ||
      !modifier.ammunition ||
      modifier.uses === undefined
    ) {
      return [];
    }
    const ended = dndEvent(`${NS}:effectEnded`, {
      actor: attacker.id,
      sourceId: effect.sourceId,
    });
    return modifier.uses <= 1
      ? [ended]
      : [
          ended,
          dndEvent(`${NS}:effectAdded`, {
            actor: attacker.id,
            effect: {
              ...effect,
              modifier: { ...modifier, uses: modifier.uses - 1 },
            },
          }),
        ];
  });
}
