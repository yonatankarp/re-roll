// A fight underwater, as an encounter's `underwater` marks it (2024 Underwater Combat and Suffocation): melee weapons
// are hampered without a Swim Speed unless they pierce, ranged weapons miss past their normal range and are hampered
// within it, everything resists Fire, and a creature that can't breathe water runs out of breath and suffocates.
import type { ContentAccess, SystemEvent } from "#sdk";
import type { Passive, Resolution } from "../schemas.ts";
import { type Actor, type DndState, dndEvent, isDead, NS } from "../state.ts";
import {
  type KnownAction,
  abilityModifier,
  deriveStats,
  passiveModifiers,
  rollAmount,
} from "../stats.ts";
import { speedsOf } from "../movement-modes.ts";
import { distanceFeet } from "../grid.ts";
import type { Context } from "../combat.ts";
import { isMelee } from "./queries.ts";

export const SUFFOCATED = "suffocation";

export const underwater = (state: DndState): boolean =>
  state.combat?.underwater === true;

// Anything underwater has Resistance to Fire damage (environment.ts environmentPassives).
export const UNDERWATER_PASSIVES: readonly Passive[] = [
  { kind: "modifier", modifier: { kind: "resistance", damage: "fire" } },
];

type AttackResolution = Extract<Resolution, { kind: "attack" }>;

// Disadvantage underwater: a melee weapon attack without a Swim Speed unless it deals Piercing, and a ranged weapon
// attack within its normal range.
export function underwaterHampered(
  attacker: Actor,
  action: KnownAction,
  resolution: AttackResolution,
  context: ContentAccess & { readonly state: DndState },
): boolean {
  if (!underwater(context.state) || resolution.attack.type !== "weapon") {
    return false;
  }
  if (!isMelee(action)) return true;
  return (
    !speedsOf(attacker, deriveStats(attacker, context)).has("swim") &&
    !resolution.damage.some(({ type }) => type === "piercing")
  );
}

// A ranged weapon attack underwater misses a target beyond its normal range.
export function beyondUnderwaterRange(
  attacker: Actor,
  target: Actor,
  action: KnownAction,
  resolution: AttackResolution,
  state: DndState,
): boolean {
  if (
    !underwater(state) ||
    resolution.attack.type !== "weapon" ||
    isMelee(action)
  ) {
    return false;
  }
  const { targeting } = action.activation;
  const normal =
    resolution.attack.normalRange ??
    ("range" in targeting && typeof targeting.range === "number"
      ? targeting.range
      : Infinity);
  return distanceFeet(attacker.position, target.position) > normal;
}

// Breathing underwater: Water Breathing on it, or a stat block with a Swim Speed or a trait that breathes water.
// shortcut: any Swim Speed counts as breathing water, as most of those stat blocks do.
export function breathesWater(actor: Actor, access: ContentAccess): boolean {
  const stats = deriveStats(actor, access);
  const modifiers = [
    ...actor.activeEffects.map(({ modifier }) => modifier),
    ...passiveModifiers(stats.passives),
  ];
  if (modifiers.some((modifier) => modifier.kind === "waterBreathing")) {
    return true;
  }
  if (actor.source.kind !== "monster") return false;
  const entry = access.content(actor.source.statBlockId) as
    { text?: string } | undefined;
  return (
    speedsOf(actor, stats).has("swim") ||
    /\b(?:amphibious|water breathing|unusual nature)\b/i.test(entry?.text ?? "")
  );
}

// How many rounds it holds its breath: 1 plus its Constitution modifier in minutes, at least 30 seconds, or a trait's
// minutes, as Breathless's hour. Ten rounds make a minute.
function breathRounds(actor: Actor, access: ContentAccess): number {
  const stats = deriveStats(actor, access);
  const held = [
    ...actor.activeEffects.map(({ modifier }) => modifier),
    ...passiveModifiers(stats.passives),
  ].flatMap((modifier) =>
    modifier.kind === "holdBreath" ? [modifier.minutes] : [],
  );
  const minutes = Math.max(1 + abilityModifier(stats.abilities.con), ...held);
  return Math.max(5, minutes * 10);
}

// At the end of each of its turns past its breath, a creature that can't breathe water gains a level of Exhaustion,
// marked so it loses them once the fight ends and it can breathe again.
export function suffocationEvents(
  actor: Actor | undefined,
  context: Context,
): SystemEvent[] {
  const { state } = context;
  if (
    !actor ||
    !underwater(state) ||
    isDead(actor) ||
    breathesWater(actor, context) ||
    (state.combat?.round ?? 0) <= breathRounds(actor, context)
  ) {
    return [];
  }
  return [
    dndEvent(`${NS}:exhaustionChanged`, { actor: actor.id, levels: 1 }),
    dndEvent(`${NS}:effectAdded`, {
      actor: actor.id,
      effect: {
        sourceId: `${SUFFOCATED}:${String(state.combat?.round ?? 0)}`,
        casterId: actor.id,
        modifier: { kind: "mark" },
        ends: "spellDuration",
      },
    }),
  ];
}

// Out of the water as the fight ends, each creature loses the Exhaustion suffocating gave it.
export function breathAgainEvents(state: DndState): SystemEvent[] {
  return Object.values(state.actors).flatMap((actor) => {
    const levels = actor.activeEffects.filter(({ sourceId }) =>
      sourceId.startsWith(`${SUFFOCATED}:`),
    ).length;
    return levels > 0
      ? [
          dndEvent(`${NS}:exhaustionChanged`, {
            actor: actor.id,
            levels: -levels,
          }),
        ]
      : [];
  });
}

// A Mariner's Armor: starting its turn underwater at 0 Hit Points, its wearer regains these, a use spent.
export function reviveUnderwater(
  actor: Actor,
  context: Context,
): SystemEvent[] {
  if (!underwater(context.state) || actor.hp > 0 || isDead(actor)) return [];
  const stats = deriveStats(actor, context);
  for (const passive of stats.passives) {
    if (passive.kind !== "underwaterRevive") continue;
    if (
      (actor.resourcesSpent[passive.resource] ?? 0) >=
      (stats.resources[passive.resource] ?? 0)
    ) {
      continue;
    }
    return [
      dndEvent(`${NS}:resourceSpent`, {
        actor: actor.id,
        resource: passive.resource,
      }),
      dndEvent(`${NS}:healed`, {
        actor: actor.id,
        amount: Math.min(
          rollAmount(passive.amount, stats, context.dice),
          stats.maxHp,
        ),
        max: stats.maxHp,
      }),
    ];
  }
  return [];
}
