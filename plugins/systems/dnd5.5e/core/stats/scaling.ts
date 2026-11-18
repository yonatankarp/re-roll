// Activations scaled up by slot, cantrip tier and class level.
import type {
  Activation,
  Duration,
  Amount,
  AreaEffect,
  Damage,
  Feature,
  LeafEffect,
  Resolution,
  ScaleStep,
} from "../schemas.ts";

// A feature's dice that grow at levels in one class, as Jolt to Life's lightning at Artificer levels 11 and 17.
export function classTiered(
  activation: Activation,
  tiers: Feature["classTiers"],
  classLevels: Readonly<Record<string, number>>,
): Activation {
  if (!tiers) return activation;
  const level = classLevels[tiers.class] ?? 0;
  return scaleActivation(
    activation,
    tiers.step,
    tiers.at.filter((at) => level >= at).length,
  );
}

export function cantripTier(level: number): number {
  return level >= 17 ? 3 : level >= 11 ? 2 : level >= 5 ? 1 : 0;
}

// Adds dice to every amount that uses the same die, which covers "both types of damage" and leaves
// Ice Storm's d6 cold alone when only its d10 bludgeoning scales.
function addDice(amount: Amount, add: string, times: number): Amount {
  const [addCount = "0", addSides] = add.split("d");
  const [count = "0", sides] = (amount.dice ?? "").split("d");
  return sides === addSides
    ? {
        ...amount,
        dice: `${String(Number(count) + Number(addCount) * times)}d${sides ?? ""}`,
      }
    : amount;
}

// Every timed effect of an activation lasting `duration` instead, as a higher slot's Bestow Curse.
function withDuration(activation: Activation, duration: Duration): Activation {
  const timed = (effects: readonly LeafEffect[]): LeafEffect[] =>
    effects.map((effect) =>
      effect.kind === "modifier" || effect.kind === "applyCondition"
        ? { ...effect, duration }
        : effect,
    );
  const { resolution } = activation;
  switch (resolution.kind) {
    case "save":
      return {
        ...activation,
        resolution: {
          ...resolution,
          onFail: timed(resolution.onFail),
          onSuccess: timed(resolution.onSuccess),
        },
      };
    case "automatic":
      return {
        ...activation,
        resolution: { ...resolution, effects: timed(resolution.effects) },
      };
    case "attack":
      return {
        ...activation,
        resolution: { ...resolution, onHit: timed(resolution.onHit) },
      };
    default:
      return activation;
  }
}

export function scaleActivation(
  activation: Activation,
  step: ScaleStep,
  times: number,
): Activation {
  if (times <= 0 || "slotOnly" in step) return activation;
  if ("durations" in step) {
    const reached = step.durations.filter(({ at }) => times >= at);
    const longer = reached[reached.length - 1]?.duration;
    return longer ? withDuration(activation, longer) : activation;
  }
  if ("addRadius" in step) {
    const { targeting, trigger } = activation;
    const more = step.addRadius * times;
    if ("area" in targeting) {
      return {
        ...activation,
        targeting: {
          ...targeting,
          area: { ...targeting.area, radius: targeting.area.radius + more },
        },
      };
    }
    // A reaction's reach grows, as Aura of the Guardian's 10 feet becoming 30.
    return trigger?.within !== undefined && "range" in targeting
      ? {
          ...activation,
          trigger: { ...trigger, within: trigger.within + more },
          targeting: {
            ...targeting,
            range:
              typeof targeting.range === "number"
                ? targeting.range + more
                : targeting.range,
          },
        }
      : activation;
  }
  if ("addTargets" in step) {
    const more = step.addTargets * times;
    const { projectiles, targeting } = activation;
    if (projectiles !== undefined) {
      return { ...activation, projectiles: projectiles + more };
    }
    return "creatures" in targeting
      ? {
          ...activation,
          targeting: { ...targeting, creatures: targeting.creatures + more },
        }
      : activation;
  }
  const steps = step.at
    ? step.at.filter((above) => times >= above).length
    : step.every
      ? Math.min(step.max ?? times, Math.floor(times / step.every))
      : times;
  if (steps <= 0) return activation;
  const { addBonus, hitDice } = step;
  const more = (amount: Amount): Amount => {
    const dice = step.addDice ? addDice(amount, step.addDice, steps) : amount;
    if (!addBonus) return dice;
    const { bonus } = dice;
    return {
      ...dice,
      bonus: {
        ...bonus,
        base: (bonus?.base ?? 0) + addBonus * steps,
        add: bonus?.add ?? [],
      },
    };
  };
  const dice = (amount: Amount): Amount =>
    step.addDice ? addDice(amount, step.addDice, steps) : amount;
  const damage = (list: readonly Damage[]): Damage[] =>
    list.map((item) => ({ ...item, amount: dice(item.amount) }));
  const effects = (list: readonly LeafEffect[]): LeafEffect[] =>
    list.map((effect): LeafEffect => {
      if (effect.kind === "heal" || effect.kind === "tempHp") {
        return { ...effect, amount: more(effect.amount) };
      }
      if (effect.kind === "transference") {
        return { ...effect, amount: more(effect.amount) };
      }
      // What a reaction takes off grows too, as Spirit Shield's d6s.
      if (effect.kind === "reduceDamage" && effect.amount) {
        return { ...effect, amount: more(effect.amount) };
      }
      if (effect.kind === "hitDieHeal") {
        return hitDice
          ? { ...effect, dice: (effect.dice ?? 1) + hitDice * steps }
          : effect;
      }
      if (effect.kind === "dispel") {
        return addBonus
          ? {
              ...effect,
              maxLevel: Math.min(9, effect.maxLevel + addBonus * steps),
            }
          : effect;
      }
      if (effect.kind !== "modifier") return effect;
      const { modifier } = effect;
      switch (modifier.kind) {
        // An extra hit's damage grows too, as Conjure Minor Elementals'.
        // Flame Arrows' quiver holds more pieces with `addBonus`.
        case "hitDamage": {
          const [hit] = damage([modifier.damage]);
          return hit
            ? {
                ...effect,
                modifier: {
                  ...modifier,
                  damage: hit,
                  ...(addBonus && modifier.uses !== undefined
                    ? { uses: modifier.uses + addBonus * steps }
                    : {}),
                },
              }
            : effect;
        }
        // Booming Blade's thunder for moving grows with its cantrip tier.
        case "moveDamage":
          return {
            ...effect,
            modifier: { ...modifier, damage: damage(modifier.damage) },
          };
        // A flat bonus grows only by `addBonus`, as Elemental Weapon's +1 to hit or Aid's Hit Point maximum.
        case "bonus":
          return addBonus && modifier.amount.dice === undefined
            ? {
                ...effect,
                modifier: {
                  ...modifier,
                  amount: {
                    ...modifier.amount,
                    bonus: {
                      base:
                        (modifier.amount.bonus?.base ?? 0) + addBonus * steps,
                      add: modifier.amount.bonus?.add ?? [],
                    },
                  },
                },
              }
            : effect;
        case "damageBonus":
          return addBonus
            ? {
                ...effect,
                modifier: { ...modifier, amount: more(modifier.amount) },
              }
            : effect;
        // The cold that strikes back grows with Armor of Agathys' Temporary Hit Points.
        case "retaliate":
          return {
            ...effect,
            modifier: {
              ...modifier,
              damage: modifier.damage.map((item) => ({
                ...item,
                amount: more(item.amount),
              })),
            },
          };
        case "lingeringDamage":
          return step.initial
            ? effect
            : {
                ...effect,
                modifier: { ...modifier, damage: damage(modifier.damage) },
              };
        default:
          return effect;
      }
    });
  const scaled = (resolution: Resolution): Resolution => {
    switch (resolution.kind) {
      case "automatic":
        return {
          ...resolution,
          damage: damage(resolution.damage),
          effects: effects(resolution.effects),
          ...(resolution.burst
            ? {
                burst: {
                  ...resolution.burst,
                  damage: damage(resolution.burst.damage),
                },
              }
            : {}),
        };
      case "attack":
        return {
          ...resolution,
          damage: damage(resolution.damage),
          onHit: effects(resolution.onHit),
          onMiss: effects(resolution.onMiss),
          ...(resolution.burst
            ? {
                burst: {
                  ...resolution.burst,
                  damage: damage(resolution.burst.damage),
                },
              }
            : {}),
        };
      case "save":
        return {
          ...resolution,
          damage: damage(resolution.damage),
          onFail: effects(resolution.onFail),
          onSuccess: effects(resolution.onSuccess),
          ...(resolution.chosen ? { chosen: effects(resolution.chosen) } : {}),
        };
      default:
        return resolution satisfies never;
    }
  };
  // What an area it leaves does later grows with the slot too, as Spirit Guardians' damage does, and so does
  // what strikes in a hit's place, as Lightning Arrow's.
  const { area, areas, trigger } = activation;
  const grown = (item: AreaEffect): AreaEffect => ({
    ...item,
    ...(item.resolution ? { resolution: scaled(item.resolution) } : {}),
    ...(item.holding ? { holding: scaled(item.holding) } : {}),
  });
  return {
    ...activation,
    ...(areas ? { areas: areas.map(grown) } : {}),
    ...(trigger?.replacesHit
      ? { trigger: { ...trigger, replacesHit: damage(trigger.replacesHit) } }
      : {}),
    resolution: scaled(activation.resolution),
    ...(area?.resolution || area?.holding
      ? {
          area: {
            ...area,
            ...(area.resolution ? { resolution: scaled(area.resolution) } : {}),
            ...(area.holding ? { holding: scaled(area.holding) } : {}),
          },
        }
      : {}),
  };
}
