import { type ContentAccess, type SystemEvent } from "#sdk";
import { type Damage, type Passive } from "../schemas.ts";
import { type Actor, dndEvent, isDown, NS } from "../state.ts";
import { deriveStats, livingHeads, type Stats } from "../stats.ts";

// A hydra's Multiple Heads (schemas.ts `heads`), counted in its resources: heads that died, heads grown back, heads
// that died since its last turn, and whether a stopping damage type reached it since then (stats.ts livingHeads reads
// the first two).
type Heads = Extract<Passive, { kind: "heads" }>;

const DEAD = "heads:dead";
const GROWN = "heads:grown";
const PENDING = "heads:pending";
const SEARED = "heads:seared";

export function headsOf(stats: Stats): Heads | undefined {
  const found = stats.passives.find((passive) => passive.kind === "heads");
  return found?.kind === "heads" ? found : undefined;
}

export const headsLeft = (actor: Actor, heads: Heads): number =>
  livingHeads(actor, [heads]) ?? 0;

const spend = (actor: Actor, resource: string, amount = 1): SystemEvent =>
  dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource, amount });

// shortcut: one hit of `damage` or more kills a head, rather than the turn's total, as a troll's limbs are cut.
export function headDamageEvents(
  target: Actor,
  amount: number,
  type: Damage["type"],
  stats: Stats,
): SystemEvent[] {
  const heads = headsOf(stats);
  if (!heads || target.hp - amount <= 0) return [];
  const events: SystemEvent[] = [];
  if (heads.stoppedBy.includes(type) && !target.resourcesSpent[SEARED]) {
    events.push(spend(target, SEARED));
  }
  if (amount < heads.damage) return events;
  events.push(spend(target, DEAD), spend(target, PENDING));
  // The hydra dies once it has no heads left.
  if (headsLeft(target, heads) <= 1) {
    events.push(
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: target.hp - amount,
        type,
        critical: false,
        massive: true,
      }),
      { kind: "actorDefeated", actor: target.id },
    );
  }
  return events;
}

// As its turn ends, each head that died since its last turn grows back twice over, unless it was seared.
export function regrowEvents(
  actor: Actor,
  access: ContentAccess,
): SystemEvent[] {
  if (isDown(actor)) return [];
  const stats = deriveStats(actor, access);
  const heads = headsOf(stats);
  const pending = actor.resourcesSpent[PENDING] ?? 0;
  if (!heads || pending === 0) return [];
  const reset = [PENDING, SEARED].flatMap((resource) =>
    actor.resourcesSpent[resource]
      ? [dndEvent(`${NS}:resourceRestored`, { actor: actor.id, resource })]
      : [],
  );
  if (actor.resourcesSpent[SEARED]) return reset;
  const healed = Math.min(heads.heal, stats.maxHp - actor.hp);
  return [
    spend(actor, GROWN, pending * heads.regrow),
    ...(healed > 0
      ? [
          dndEvent(`${NS}:healed`, {
            actor: actor.id,
            amount: healed,
            max: stats.maxHp,
          }),
        ]
      : []),
    ...reset,
  ];
}
