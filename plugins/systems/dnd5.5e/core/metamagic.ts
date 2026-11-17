import { type Frame, type SystemEvent } from "#sdk";
import {
  type Activation,
  type Cost,
  type Damage,
  type DamageType,
  type Passive,
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
// With `two`, any two options join, as with Sorcery Incarnate.
export function joins(
  option: Metamagic,
  waiting: readonly Metamagic[],
  two = false,
) {
  return (
    !waiting.includes(option) &&
    (waiting.length === 0 ||
      (two && waiting.length < 2) ||
      COMBINES.includes(option) ||
      waiting.every((item) => COMBINES.includes(item)))
  );
}

const DAY = 24 * 60;

// The activation with its effects' minutes doubled, as Extended Spell's.
function doubled(activation: Activation): Activation {
  const longer = <T extends { kind: string }>(effect: T): T =>
    "duration" in effect &&
    typeof effect.duration === "object" &&
    effect.duration !== null &&
    "minutes" in effect.duration &&
    typeof effect.duration.minutes === "number"
      ? {
          ...effect,
          duration: {
            ...effect.duration,
            minutes: Math.min(DAY, effect.duration.minutes * 2),
          },
        }
      : effect;
  const { resolution } = activation;
  switch (resolution.kind) {
    case "automatic":
      return {
        ...activation,
        resolution: { ...resolution, effects: resolution.effects.map(longer) },
      };
    case "save":
      return {
        ...activation,
        resolution: {
          ...resolution,
          onFail: resolution.onFail.map(longer),
          onSuccess: resolution.onSuccess.map(longer),
        },
      };
    case "attack":
      return {
        ...activation,
        resolution: { ...resolution, onHit: resolution.onHit.map(longer) },
      };
    default:
      return resolution satisfies never;
  }
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
    // Its effects last twice as long, up to 24 hours.
    case "extended":
      return doubled(activation);
    // These change the saves, the hiding or a miss as the spell resolves.
    case "careful":
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

const FREE = "free-metamagic"; // the turn's option Arcane Apotheosis pays for

// Whether this turn's first option is free (`freeMetamagic`).
export function freeOption(
  actor: Actor,
  passives: readonly Passive[],
): boolean {
  return (
    !actor.usedThisTurn.includes(FREE) &&
    passives.some(
      (passive) =>
        passive.kind === "freeMetamagic" &&
        actor.activeEffects.some(({ sourceId }) =>
          passive.while.some((id) => sourceId.startsWith(`feature:${id}:`)),
        ),
    )
  );
}

// The Sorcery Points the options waiting on a spell cost, the dearest free with Arcane Apotheosis.
function pointsFor(mine: readonly Marker[], free: boolean): number {
  const costs = mine.map((item): number =>
    item.option === "seeking" ? 0 : METAMAGIC_COSTS[item.option],
  );
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  return free ? total - Math.max(0, ...costs) : total;
}

// The spells with options waiting on them, changed and costing their Sorcery Points, so the turn lists them as cast.
// Seeking Spell is paid for only on a miss.
export function withMetamagic(
  actions: readonly KnownAction[],
  actor: Actor,
  charisma: number,
  free = false,
): KnownAction[] {
  const markers = markersOf(actor);
  return actions.map((action) => {
    const mine = markers.filter((item) => item.action === action.id);
    if (mine.length === 0) return action;
    const points = pointsFor(mine, free);
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
// Heightened's Disadvantage stays on the saves a spell held by Concentration repeats (combat/effects.ts).
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

// Whether this cast is Quickened, which keeps other level 1+ spells off the turn.
export function quickens(actor: Actor, actionId: string): boolean {
  return waiting(actor, actionId, "quickened");
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
  free = false,
): SystemEvent[] {
  const mine = markersOf(actor).filter((item) => item.action === actionId);
  const extended = mine.find((item) => item.option === "extended");
  return [
    ...(free && pointsFor(mine, false) > pointsFor(mine, true)
      ? [dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key: FREE })]
      : []),
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
