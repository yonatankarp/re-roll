import { type Frame, type SystemEvent } from "#sdk";
import {
  type Activation,
  type Cost,
  type Damage,
  type DamageType,
} from "./schemas.ts";
import { type Actor, dndEvent, frame, NS } from "./state.ts";
import type { KnownAction } from "./stats.ts";

// Metamagic as the rules see it: which spells an option fits and how it changes them. A chosen option waits on
// its caster as a "metamagic" tactic effect naming the spell, until the cast is done (class-options.ts offers it).

// Sorcery Points each option costs, by the name in its feature id, such as sorcerer-metamagic-quickened-spell.
export const METAMAGIC_COSTS = {
  careful: 1,
  distant: 1,
  empowered: 1,
  extended: 1,
  heightened: 2,
  quickened: 2,
  seeking: 1,
  subtle: 1,
  transmuted: 1,
  twinned: 1,
} as const;
export type Metamagic = keyof typeof METAMAGIC_COSTS;
export const SORCERY_POINTS = "sorcery-points";
export const TRANSMUTED_TYPES = [
  "acid",
  "cold",
  "fire",
  "lightning",
  "poison",
  "thunder",
] as const satisfies readonly DamageType[];
// Options that can join another on the same casting.
const COMBINES: readonly Metamagic[] = ["empowered", "seeking"];
const HELD = ":held"; // Extended Spell's Advantage, kept for as long as the Concentration lasts

export function metamagicOf(featureId: string): Metamagic | null {
  const name = /-metamagic-([a-z]+)-spell$/.exec(featureId)?.[1];
  return name !== undefined && name in METAMAGIC_COSTS
    ? (name as Metamagic)
    : null;
}

export interface Marker {
  readonly featureId: string;
  readonly option: Metamagic;
  readonly action: string;
  readonly value: number | undefined; // Transmuted Spell: the damage type's place in TRANSMUTED_TYPES
}

// The options waiting on their spell, not Extended Spell's held Advantage.
export function markersOf(actor: Actor): readonly Marker[] {
  return actor.activeEffects.flatMap(({ sourceId, modifier }) => {
    const option = metamagicOf(sourceId);
    return modifier.kind === "tactic" &&
      modifier.tactic === "metamagic" &&
      modifier.action !== undefined &&
      option
      ? [
          {
            featureId: sourceId,
            option,
            action: modifier.action,
            value: modifier.value,
          },
        ]
      : [];
  });
}

export function holdsConcentration(actor: Actor): boolean {
  return actor.activeEffects.some(
    ({ sourceId, modifier }) =>
      sourceId.endsWith(HELD) &&
      modifier.kind === "tactic" &&
      modifier.tactic === "metamagic",
  );
}

function damageOf(activation: Activation): readonly Damage[] {
  return activation.resolution.damage;
}

function lasts(activation: Activation): boolean {
  const { resolution } = activation;
  const effects =
    resolution.kind === "automatic"
      ? resolution.effects
      : resolution.kind === "save"
        ? resolution.onFail
        : resolution.onHit;
  return effects.some(
    (effect) =>
      (effect.kind === "modifier" || effect.kind === "applyCondition") &&
      typeof effect.duration === "object" &&
      "minutes" in effect.duration &&
      effect.duration.minutes >= 1,
  );
}

// Whether an option can change this spell at all.
export function fits(option: Metamagic, action: KnownAction): boolean {
  if (action.spellLevel === null || !action.id.startsWith("spell:")) {
    return false;
  }
  const { activation } = action;
  const { cost, targeting, resolution } = activation;
  switch (option) {
    case "careful":
    case "heightened":
      return resolution.kind === "save";
    case "distant":
      return (
        "range" in targeting &&
        (targeting.range === "touch" ||
          (typeof targeting.range === "number" && targeting.range >= 5))
      );
    case "empowered":
      return damageOf(activation).some((item) => item.amount.dice);
    case "extended":
      return lasts(activation);
    case "quickened":
      return cost.includes("action");
    case "seeking":
      return resolution.kind === "attack";
    case "subtle":
      return true;
    case "transmuted":
      return damageOf(activation).some((item) =>
        (TRANSMUTED_TYPES as readonly string[]).includes(item.type),
      );
    case "twinned":
      return (
        action.spellLevel >= 1 &&
        action.upcast !== undefined &&
        "addTargets" in action.upcast.perSlotLevel &&
        activation.projectiles === undefined &&
        "creatures" in targeting
      );
    default:
      return option satisfies never;
  }
}

// Whether one more option can join those already waiting on this spell.
export function joins(option: Metamagic, waiting: readonly Metamagic[]) {
  return (
    !waiting.includes(option) &&
    (waiting.length === 0 ||
      COMBINES.includes(option) ||
      waiting.every((item) => COMBINES.includes(item)))
  );
}

const withDamage = (
  activation: Activation,
  change: (damage: Damage) => Damage,
): Activation => ({
  ...activation,
  resolution: {
    ...activation.resolution,
    damage: activation.resolution.damage.map(change),
  },
});

function shaped(
  activation: Activation,
  marker: Marker,
  upcast: KnownAction["upcast"],
  charisma: number,
): Activation {
  const { targeting } = activation;
  switch (marker.option) {
    case "distant":
      return "range" in targeting && targeting.range !== "self"
        ? {
            ...activation,
            targeting: {
              ...targeting,
              range: targeting.range === "touch" ? 30 : targeting.range * 2,
            },
          }
        : activation;
    case "empowered":
      return withDamage(activation, (item) => ({
        ...item,
        amount: { ...item.amount, reroll: Math.max(1, charisma) },
      }));
    // shortcut: it doesn't bar another level 1+ spell on the same turn; check that once spells cast per turn are tracked.
    case "quickened":
      return {
        ...activation,
        cost: activation.cost.map((item) =>
          item === "action" ? "bonusAction" : item,
        ),
      };
    case "transmuted": {
      const type = TRANSMUTED_TYPES[marker.value ?? 0] ?? "acid";
      return withDamage(activation, (item) =>
        (TRANSMUTED_TYPES as readonly string[]).includes(item.type)
          ? { ...item, type }
          : item,
      );
    }
    case "twinned":
      return upcast &&
        "addTargets" in upcast.perSlotLevel &&
        "creatures" in targeting
        ? {
            ...activation,
            targeting: {
              ...targeting,
              creatures: targeting.creatures + upcast.perSlotLevel.addTargets,
            },
          }
        : activation;
    // These change the saves, the hiding or a miss as the spell resolves.
    // shortcut: Extended Spell doesn't double durations, which no fight lasts long enough to show; double them once
    // durations outlast a fight.
    case "careful":
    case "extended":
    case "heightened":
    case "seeking":
    case "subtle":
      return activation;
    default:
      return marker.option satisfies never;
  }
}

const NAMES: Readonly<Record<Metamagic, string>> = {
  careful: "Careful",
  distant: "Distant",
  empowered: "Empowered",
  extended: "Extended",
  heightened: "Heightened",
  quickened: "Quickened",
  seeking: "Seeking",
  subtle: "Subtle",
  transmuted: "Transmuted",
  twinned: "Twinned",
};

// The spells with options waiting on them, changed and costing their Sorcery Points, so the turn lists them as cast.
// Seeking Spell is paid for only on a miss.
export function withMetamagic(
  actions: readonly KnownAction[],
  actor: Actor,
  charisma: number,
): KnownAction[] {
  const markers = markersOf(actor);
  return actions.map((action) => {
    const mine = markers.filter((item) => item.action === action.id);
    if (mine.length === 0) return action;
    const points = mine.reduce(
      (sum, item) =>
        sum + (item.option === "seeking" ? 0 : METAMAGIC_COSTS[item.option]),
      0,
    );
    const activation = mine.reduce(
      (current, marker) => shaped(current, marker, action.upcast, charisma),
      action.activation,
    );
    const cost: Cost[] = [
      ...activation.cost,
      ...Array.from({ length: points }, () => ({ resource: SORCERY_POINTS })),
    ];
    return {
      ...action,
      name: `${action.name} (${mine.map((item) => NAMES[item.option]).join(", ")})`,
      activation: { ...activation, cost },
    };
  });
}

function waiting(actor: Actor, actionId: string, option: Metamagic) {
  return markersOf(actor).some(
    (item) => item.action === actionId && item.option === option,
  );
}

// Careful Spell's creatures, which succeed and take no half damage, and Heightened Spell's one target, which saves
// with Disadvantage. Both go to the first creatures the save catches: the caster's side for Careful, a foe for Heightened.
// shortcut: Heightened gives Disadvantage on the first save only, not on the saves the spell repeats.
export function metamagicSaves(
  action: KnownAction,
  caster: Actor,
  targets: readonly Actor[],
  charisma: number,
): { readonly spared: ReadonlySet<string>; readonly heightened?: string } {
  const careful = waiting(caster, action.id, "careful");
  const spared = careful
    ? targets
        .filter((item) => item.side === caster.side)
        .slice(0, Math.max(1, charisma))
        .map((item) => item.id)
    : [];
  const heightened = waiting(caster, action.id, "heightened")
    ? targets.find((item) => item.side !== caster.side)?.id
    : undefined;
  return {
    spared: new Set(spared),
    ...(heightened === undefined ? {} : { heightened }),
  };
}

// Subtle Spell casts without Verbal or Somatic components, so it doesn't give a hidden caster away.
export function keepsHidden(actor: Actor, actionId: string): boolean {
  return waiting(actor, actionId, "subtle");
}

// Clears the options once the cast is done, after its rolls have looked the spell up again.
export function metamagicCast(actor: Actor, actionId: string): Frame[] {
  return markersOf(actor).some((item) => item.action === actionId)
    ? [frame("metamagicSpent", { actor: actor.id, action: actionId })]
    : [];
}

export function metamagicSpentEvents(
  actor: Actor,
  actionId: string,
): SystemEvent[] {
  const mine = markersOf(actor).filter((item) => item.action === actionId);
  const extended = mine.find((item) => item.option === "extended");
  return [
    ...mine.map((item) =>
      dndEvent(`${NS}:effectEnded`, {
        actor: actor.id,
        sourceId: item.featureId,
      }),
    ),
    ...(extended && actor.concentratingOn === actionId
      ? [
          dndEvent(`${NS}:effectAdded`, {
            actor: actor.id,
            effect: {
              sourceId: `${extended.featureId}${HELD}`,
              casterId: actor.id,
              modifier: { kind: "tactic", tactic: "metamagic" },
              ends: "concentration",
            },
          }),
        ]
      : []),
  ];
}

// Seeking Spell on a missed spell attack: the point is spent and the d20 rolled again, once.
export function seekingReroll(
  attacker: Actor,
  actionId: string,
): SystemEvent[] | null {
  const marker = markersOf(attacker).find(
    (item) => item.action === actionId && item.option === "seeking",
  );
  return marker
    ? [
        dndEvent(`${NS}:effectEnded`, {
          actor: attacker.id,
          sourceId: marker.featureId,
        }),
        dndEvent(`${NS}:resourceSpent`, {
          actor: attacker.id,
          resource: SORCERY_POINTS,
        }),
      ]
    : null;
}
