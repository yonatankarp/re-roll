// Whether an effect's resolution does anything in a fight.
import type { Resolution } from "../schemas.ts";

// Calculated on demand and never stored, so stats can't drift out of step with choices or gear.
// Deafened and Grappled have no effect without hearing rules or a grappler's own grip, so a spell that only does
// those would waste a slot. A push or a teleport moves on the grid every fight has.
export function doesSomething(resolution: Resolution): boolean {
  if ("damage" in resolution && resolution.damage.length > 0) return true;
  const effects =
    resolution.kind === "automatic"
      ? resolution.effects
      : resolution.kind === "attack"
        ? [...resolution.onHit, ...resolution.onMiss]
        : [...resolution.onFail, ...resolution.onSuccess];
  return effects.some(
    (effect) =>
      effect.kind === "heal" ||
      effect.kind === "hitDieHeal" ||
      effect.kind === "tempHp" ||
      effect.kind === "modifier" ||
      effect.kind === "removeCondition" ||
      effect.kind === "cure" ||
      effect.kind === "dispel" ||
      effect.kind === "zone" ||
      effect.kind === "polymorph" ||
      effect.kind === "summon" ||
      effect.kind === "commandFamiliar" ||
      effect.kind === "counter" ||
      effect.kind === "extraAction" ||
      effect.kind === "reduceDamage" ||
      effect.kind === "acAgainstHit" ||
      effect.kind === "teleport" ||
      effect.kind === "forcedMove" ||
      effect.kind === "weaponAttack" ||
      effect.kind === "randomAction" ||
      effect.kind === "copySpell" ||
      effect.kind === "createItems" ||
      effect.kind === "untilLongRest" ||
      (effect.kind === "exhaustion" && effect.clear === true) ||
      // what raises or mends the dead and dying, mostly between fights (camp.ts)
      effect.kind === "repose" ||
      effect.kind === "transference" ||
      effect.kind === "reincarnate" ||
      effect.kind === "clone" ||
      (effect.kind === "applyCondition" &&
        effect.condition !== "deafened" &&
        effect.condition !== "grappled"),
  );
}
