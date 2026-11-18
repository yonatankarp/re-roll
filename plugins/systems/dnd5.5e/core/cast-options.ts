import { type Frame } from "#sdk";
import {
  type Activation,
  type Passive,
  type ScaleStep,
  type Spell,
} from "./schemas.ts";
import { type Actor, frame } from "./state.ts";
import type { KnownAction } from "./stats.ts";

// A feature's change to a spell as it's cast, at a cost, as Overchannel's maximum damage or Enhanced Necromancy's
// second target for a use of Channel Divinity (Passive `castOption`). Like a Metamagic option, it's picked before the
// cast and waits on its caster as a "metamagic" tactic effect naming the spell, under its own source, until the cast
// is done (class-options.ts offers it, combat/actions.ts clears it).

export type CastOption = Extract<Passive, { kind: "castOption" }>;
export const CAST_OPTION_PREFIX = "castOption:";

// The source a waiting option is kept under: "castOption:<feature>:<index of the passive>".
export function castOptionSource(featureId: string, index: number): string {
  return `${CAST_OPTION_PREFIX}${featureId}:${String(index)}`;
}

export interface Waiting {
  readonly sourceId: string;
  readonly option: CastOption;
  readonly action: string;
}

// The bearer's cast options, by the source they wait under.
export function castOptionsOf(
  features: readonly {
    readonly id: string;
    readonly passives: readonly Passive[];
  }[],
): readonly { readonly sourceId: string; readonly option: CastOption }[] {
  return features.flatMap((feature) =>
    feature.passives.flatMap((passive, index) =>
      passive.kind === "castOption"
        ? [{ sourceId: castOptionSource(feature.id, index), option: passive }]
        : [],
    ),
  );
}

// The options waiting on their spells.
export function waitingOptions(
  actor: Actor,
  options: readonly {
    readonly sourceId: string;
    readonly option: CastOption;
  }[],
): readonly Waiting[] {
  return actor.activeEffects.flatMap(({ sourceId, modifier }) => {
    const found = options.find((item) => item.sourceId === sourceId);
    return found &&
      modifier.kind === "tactic" &&
      modifier.tactic === "metamagic" &&
      modifier.action !== undefined
      ? [{ sourceId, option: found.option, action: modifier.action }]
      : [];
  });
}

// Whether a spell fits an option, from what the spell is and what its action does.
export function fitsOption(
  option: CastOption,
  action: KnownAction,
  spell: Spell | undefined,
  onList: (list: string) => boolean,
): boolean {
  if (action.spellLevel === null || !action.id.startsWith("spell:")) {
    return false;
  }
  const { activation } = action;
  const { resolution, targeting, cost } = activation;
  const id = action.id.slice("spell:".length);
  return (
    (!option.spells || option.spells.some((item) => id.startsWith(item))) &&
    (!option.schools ||
      (spell !== undefined && option.schools.includes(spell.school))) &&
    (!option.list || onList(option.list)) &&
    (!option.slot || cost.includes("slot")) &&
    (option.maxLevel === undefined || action.spellLevel <= option.maxLevel) &&
    (option.minLevel === undefined || action.spellLevel >= option.minLevel) &&
    (!option.damaging || resolution.damage.length > 0) &&
    (!option.saving || resolution.kind === "save") &&
    (!option.plain || resolution.kind === "automatic") &&
    (!option.oneTarget ||
      ("creatures" in targeting && targeting.creatures === 1)) &&
    (!option.allies || ("side" in targeting && targeting.side === "ally")) &&
    (!option.upcastTargets ||
      (action.upcast !== undefined &&
        "addTargets" in action.upcast.perSlotLevel))
  );
}

function changed(
  activation: Activation,
  option: CastOption,
  upcast: KnownAction["upcast"],
  scale: (activation: Activation, step: ScaleStep, times: number) => Activation,
): Activation {
  let next = activation;
  if (option.levels && upcast)
    next = scale(next, upcast.perSlotLevel, option.levels);
  if (option.addTargets) {
    const { targeting } = next;
    if ("creatures" in targeting) {
      next = {
        ...next,
        targeting: {
          ...targeting,
          creatures: targeting.creatures + option.addTargets,
        },
      };
    }
  }
  if (option.maxDamage) {
    next = {
      ...next,
      resolution: {
        ...next.resolution,
        damage: next.resolution.damage.map((item) => ({
          ...item,
          amount: { ...item.amount, highest: true as const },
        })),
      },
    };
  }
  const area = next.area?.resolution;
  if (option.areaOnFail && area?.kind === "save") {
    next = {
      ...next,
      area: {
        ...next.area,
        resolution: { ...area, onFail: [...area.onFail, ...option.areaOnFail] },
      },
    };
  }
  if (option.userEffects) {
    next = {
      ...next,
      userEffects: [...(next.userEffects ?? []), ...option.userEffects],
    };
  }
  if (option.tempHp && next.resolution.kind === "automatic") {
    next = {
      ...next,
      resolution: {
        ...next.resolution,
        effects: [
          ...next.resolution.effects,
          { kind: "tempHp", amount: option.tempHp },
        ],
      },
    };
  }
  return next;
}

// The spells with options waiting on them, changed and costing what the options cost.
export function withCastOptions(
  actions: readonly KnownAction[],
  waiting: readonly Waiting[],
  scale: (activation: Activation, step: ScaleStep, times: number) => Activation,
): KnownAction[] {
  if (waiting.length === 0) return [...actions];
  return actions.map((action) => {
    const mine = waiting.filter((item) => item.action === action.id);
    if (mine.length === 0) return action;
    const activation = mine.reduce(
      (current, item) => changed(current, item.option, action.upcast, scale),
      action.activation,
    );
    return {
      ...action,
      name: `${action.name} (${mine.map((item) => item.option.label).join(", ")})`,
      activation: {
        ...activation,
        cost: [...activation.cost, ...mine.flatMap((item) => item.option.cost)],
      },
      ...(mine.some((item) => item.option.saveDice)
        ? {
            saveDice: mine.flatMap((item) =>
              item.option.saveDice ? [item.option.saveDice] : [],
            )[0],
          }
        : {}),
    };
  });
}

// Clears the options once the cast is done, and has the caster pay any price that grows with use, as Overchannel's.
export function castOptionCast(
  actor: Actor,
  actionId: string,
  slotLevel: number | undefined,
): Frame[] {
  return actor.activeEffects.some(
    ({ sourceId, modifier }) =>
      sourceId.startsWith(CAST_OPTION_PREFIX) &&
      modifier.kind === "tactic" &&
      modifier.action === actionId,
  )
    ? [
        frame("castOptionSpent", {
          actor: actor.id,
          action: actionId,
          ...(slotLevel === undefined ? {} : { slotLevel }),
        }),
      ]
    : [];
}
