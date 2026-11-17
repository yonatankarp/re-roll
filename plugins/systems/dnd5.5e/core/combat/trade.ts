import type { SystemEvent } from "#sdk";
import type { Passive } from "../schemas.ts";
import { type Actor, NS, dndEvent } from "../state.ts";
import { type KnownAction, type Stats, deriveStats } from "../stats.ts";
import { TACTIC, tacticsOf } from "../tactics.ts";
import type { Context } from "./queries.ts";

// Trading attacks of the Attack action for a cantrip, a spell or Breath Weapon (passive `attackReplacement`), as
// Valor's Extra Attack or War Magic. The trade is readied first (actions.ts), then the cast spends the action and
// leaves the attacks it didn't trade, each an option of the turn until made.

export const TRADE = `${TACTIC}trade`;
export const STRIKE = `${TACTIC}strike`;

type Trade = Extract<Passive, { kind: "attackReplacement" }>;

export function tradesOf(stats: Stats): readonly Trade[] {
  return stats.passives.filter(
    (passive): passive is Trade => passive.kind === "attackReplacement",
  );
}

export function tradeFits(trade: Trade, action: KnownAction): boolean {
  const { cost } = action.activation;
  if (!cost.includes("action")) return false;
  const level = action.spellLevel;
  return (
    (trade.cantrips === true && level === 0) ||
    (level !== null && trade.levels?.includes(level) === true) ||
    (trade.resource !== undefined &&
      cost.some(
        (item) =>
          typeof item === "object" &&
          "resource" in item &&
          item.resource === trade.resource,
      ))
  );
}

// The attacks a trade leaves of the Attack action.
export function attacksAfter(trade: Trade, stats: Stats): number {
  return stats.multiattack - trade.attacks;
}

export function attacksLeft(actor: Actor): number {
  return tacticsOf(actor, "attacksLeft").reduce(
    (total, { value }) => total + (value ?? 0),
    0,
  );
}

// As a readied trade's spell is cast: the trade is made, leaving the attacks it didn't trade.
export function tradeEvents(
  actor: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  const [readied] = tacticsOf(actor, "trading");
  if (!readied) return [];
  const stats = deriveStats(actor, context);
  const trade = tradesOf(stats)[readied.value ?? 0];
  if (!trade || !tradeFits(trade, action)) return [];
  const left = attacksAfter(trade, stats);
  return [
    dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId: TRADE }),
    ...(left > 0 ? [strikesLeft(actor, left)] : []),
  ];
}

export function strikesLeft(actor: Actor, left: number): SystemEvent {
  return dndEvent(`${NS}:effectAdded`, {
    actor: actor.id,
    effect: {
      sourceId: STRIKE,
      casterId: actor.id,
      modifier: { kind: "tactic", tactic: "attacksLeft", value: left },
      ends: "casterTurnEnd",
    },
  });
}
