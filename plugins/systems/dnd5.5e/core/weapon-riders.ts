import type { ContentAccess } from "#sdk";
import type { Ability, AbilityScores, Passive } from "./schemas.ts";
import { type Actor, type DndState, turnId } from "./state.ts";
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

const modifier = (score: number): number => Math.floor((score - 10) / 2);

// The attack made with the rider's ability in place of its own, where that's better, as Battle Ready's Intelligence.
function withAbility(
  action: KnownAction,
  ability: Ability,
  scores: AbilityScores,
): KnownAction {
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") return action;
  const own = resolution.attack.ability ?? "str";
  if (modifier(scores[ability]) <= modifier(scores[own])) return action;
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution: {
        ...resolution,
        attack: { ...resolution.attack, ability },
        damage: resolution.damage.map((item) =>
          item.amount.bonus
            ? {
                ...item,
                amount: {
                  ...item.amount,
                  bonus: {
                    ...item.amount.bonus,
                    add: item.amount.bonus.add.map((term) =>
                      term.kind === "abilityMod" && term.ability === own
                        ? { ...term, ability }
                        : term,
                    ),
                  },
                },
              }
            : item,
        ),
      },
    },
  };
}

function ridden(
  plain: KnownAction,
  rider: WeaponRider,
  scores: AbilityScores,
): KnownAction {
  const action = rider.ability
    ? withAbility(plain, rider.ability, scores)
    : plain;
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
        attack:
          rider.attack || rider.attackMod
            ? {
                ...resolution.attack,
                flatBonus:
                  (resolution.attack.flatBonus ?? 0) +
                  (rider.attack ?? 0) +
                  (rider.attackMod
                    ? Math.max(1, modifier(scores[rider.attackMod]))
                    : 0),
              }
            : resolution.attack,
        damage: first
          ? [
              {
                ...first,
                amount: rider.damage
                  ? {
                      ...first.amount,
                      ...(rider.dieAtLeast
                        ? { dieAtLeast: rider.dieAtLeast }
                        : {}),
                      bonus: {
                        base:
                          (first.amount.bonus?.base ?? 0) + rider.damage.base,
                        add: [
                          ...(first.amount.bonus?.add ?? []),
                          ...rider.damage.add,
                        ],
                      },
                    }
                  : rider.dieAtLeast
                    ? { ...first.amount, dieAtLeast: rider.dieAtLeast }
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

// Whether it's the actor's own turn in a fight, for a rider only then.
function ownTurn(actor: Actor, access: ContentAccess): boolean {
  const { state } = access as ContentAccess & { readonly state?: DndState };
  const combat = state?.combat;
  return turnId(combat) === actor.id;
}

export function withWeaponRiders(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
  access: ContentAccess,
  scores: AbilityScores,
): readonly KnownAction[] {
  const riders = passives.filter(
    (item): item is WeaponRider =>
      item.kind === "weaponRider" &&
      (!item.while || underEffect(actor, item.while)) &&
      (!item.ownTurn || ownTurn(actor, access)),
  );
  if (riders.length === 0) return actions;
  return actions.map((action) =>
    riders.reduce(
      (shaped, rider) =>
        action.activation.trigger === undefined &&
        hitFits(rider.with, action, actor, access) &&
        !(rider.oneHanded && twoHanded(action, access))
          ? ridden(shaped, rider, scores)
          : shaped,
      action,
    ),
  );
}
