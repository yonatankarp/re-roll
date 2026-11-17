import type { ContentAccess } from "#sdk";
import type { Passive } from "./schemas.ts";
import type { Actor } from "./state.ts";
import type { KnownAction } from "./stats.ts";
import { hitFits, underEffect } from "./combat/queries.ts";
import { ItemSchema } from "./schemas.ts";
import { weaponItemId } from "./combat/ids.ts";

// What `weaponRider` passives give a character's weapon attacks of a kind, applied as Stats are derived: a bonus to
// hit or to damage, damage types to deal in place of the weapon's own, and more reach.

type WeaponRider = Extract<Passive, { kind: "weaponRider" }>;

function twoHanded(action: KnownAction, access: ContentAccess): boolean {
  const id = weaponItemId(action.id);
  const item = id ? ItemSchema.safeParse(access.content(id)).data : undefined;
  return item?.type === "weapon" && item.properties.includes("twoHanded");
}

function ridden(action: KnownAction, rider: WeaponRider): KnownAction {
  const { resolution, targeting } = action.activation;
  if (resolution.kind !== "attack") return action;
  const [first, ...rest] = resolution.damage;
  const reach =
    rider.reach !== undefined && "creatures" in targeting
      ? {
          ...targeting,
          range:
            (typeof targeting.range === "number" ? targeting.range : 5) +
            rider.reach,
          reach: true as const,
        }
      : targeting;
  return {
    ...action,
    activation: {
      ...action.activation,
      targeting: reach,
      resolution: {
        ...resolution,
        attack: rider.attack
          ? {
              ...resolution.attack,
              flatBonus: (resolution.attack.flatBonus ?? 0) + rider.attack,
            }
          : resolution.attack,
        damage: first
          ? [
              {
                ...first,
                amount: rider.damage
                  ? {
                      ...first.amount,
                      bonus: {
                        base:
                          (first.amount.bonus?.base ?? 0) + rider.damage.base,
                        add: [
                          ...(first.amount.bonus?.add ?? []),
                          ...rider.damage.add,
                        ],
                      },
                    }
                  : first.amount,
                ...(rider.types
                  ? {
                      types: [
                        ...new Set([
                          ...(first.types ?? [first.type]),
                          ...rider.types,
                        ]),
                      ],
                    }
                  : {}),
              },
              ...rest,
            ]
          : resolution.damage,
      },
    },
  };
}

export function withWeaponRiders(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
  access: ContentAccess,
): readonly KnownAction[] {
  const riders = passives.filter(
    (item): item is WeaponRider =>
      item.kind === "weaponRider" &&
      (!item.while || underEffect(actor, item.while)),
  );
  if (riders.length === 0) return actions;
  return actions.map((action) =>
    riders.reduce(
      (shaped, rider) =>
        action.activation.trigger === undefined &&
        hitFits(rider.with, action, actor, access) &&
        !(rider.oneHanded && twoHanded(action, access))
          ? ridden(shaped, rider)
          : shaped,
      action,
    ),
  );
}
