import { damageResponses } from "../../stats.ts";
import { type Actor, isDead } from "../../state.ts";
import { type DamageType, type Resolution } from "../../schemas.ts";
import { type Context, enemies } from "../queries.ts";

// Picking and changing the damage type an effect deals.

// The damage type of `types` its foes in the fight resist least, as a caster picking Conjure Elemental's element.
// The area starts with it, and the caster is then asked (combat/damage-choice.ts).
export function leastResisted(
  types: readonly DamageType[],
  caster: Actor,
  context: Context,
): DamageType {
  const foes = enemies(context.state, caster).filter((foe) => !isDead(foe));
  const worth = (type: DamageType): number =>
    foes.reduce((sum, foe) => {
      const responses = damageResponses(foe, context);
      return (
        sum +
        (responses.immunities.includes(type) || responses.absorbs.includes(type)
          ? 0
          : responses.resistances.includes(type)
            ? 1
            : responses.vulnerabilities.includes(type)
              ? 3
              : 2)
      );
    }, 0);
  const [best = types[0] ?? "force"] = [...types].sort(
    (a, b) => worth(b) - worth(a),
  );
  return best;
}

export function typeAgainst(
  types: readonly DamageType[],
  responses: ReturnType<typeof damageResponses>,
): DamageType {
  const worth = (type: DamageType): number =>
    responses.immunities.includes(type) || responses.absorbs.includes(type)
      ? 0
      : responses.resistances.includes(type)
        ? 1
        : responses.vulnerabilities.includes(type)
          ? 3
          : 2;
  const [best = types[0] ?? "force"] = [...types].sort(
    (a, b) => worth(b) - worth(a),
  );
  return best;
}

// A resolution whose damage all takes `type`, when one was picked.
export function retyped(
  resolution: Resolution | undefined,
  type: DamageType | undefined,
): Resolution | undefined {
  if (!resolution || !type) return resolution;
  return {
    ...resolution,
    damage: resolution.damage.map((item) => ({ ...item, type })),
  };
}
