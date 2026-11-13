import type { SystemEvent } from "#sdk";
import { CompanionSchema, type LeafEffect } from "../schemas.ts";
import { type Actor, dndEvent, freshActor, NS } from "../state.ts";
import {
  deriveStats,
  evaluateFormula,
  type KnownAction,
  lookup,
  type Stats,
} from "../stats.ts";
import { teleportSquares } from "./movement.ts";
import { type Context, spellSource } from "./queries.ts";

type Summon = Extract<LeafEffect, { kind: "summon" }>;

// The creatures a summoning spell brings, at the spell's level and with the caster's numbers as cast.
// The caster's spell attack is its save DC less 8, as a monster's Spellcasting entry gives both.
export function summonedActors(
  effect: Summon,
  action: KnownAction,
  caster: Actor,
  stats: Stats,
  context: Context,
  slotLevel?: number,
): readonly Actor[] {
  const companion = lookup(context, CompanionSchema, effect.companion);
  if (!companion.play) return [];
  const level = slotLevel ?? action.spellLevel ?? companion.play.level;
  const spellDc = evaluateFormula(effect.dc, stats);
  const count = Math.max(1, evaluateFormula(effect.count, stats));
  const slug = effect.companion.slice(effect.companion.lastIndexOf("/") + 1);
  const prefix = `${caster.id}:${slug}-`;
  const before = Object.keys(context.state.actors).filter((id) =>
    id.startsWith(prefix),
  ).length;
  return Array.from({ length: count }, (_, index) => {
    const actor = freshActor({
      id: `${prefix}${String(before + index + 1)}`,
      name:
        count > 1 ? `${companion.name} ${String(index + 1)}` : companion.name,
      side: caster.side,
      source: {
        kind: "summon",
        companion: companion.id,
        level,
        casterId: caster.id,
        sourceId: spellSource(action),
        concentration:
          typeof effect.duration === "object" &&
          "concentration" in effect.duration,
        proficiency: stats.proficiency,
        spellAttack: spellDc - 8 + stats.itemBonuses.spellAttack,
        spellDc,
      },
      hp: 1,
      inventory: [],
    });
    return { ...actor, hp: deriveStats(actor, context).maxHp };
  });
}

// shortcut: they appear in the open squares within range nearest the foes, rather than where the caster chooses.
export function summonEvents(
  effect: Summon,
  action: KnownAction,
  caster: Actor,
  stats: Stats,
  context: Context,
  slotLevel?: number,
): SystemEvent[] {
  const squares = teleportSquares(
    caster,
    effect.range,
    0,
    context.state,
    context,
  );
  const actors = summonedActors(
    effect,
    action,
    caster,
    stats,
    context,
    slotLevel,
  ).slice(0, squares.length);
  return actors.map((actor, index) =>
    dndEvent(`${NS}:summoned`, {
      actor: { ...actor, position: squares[index] ?? null },
      after: index === 0 ? caster.id : (actors[index - 1]?.id ?? caster.id),
    }),
  );
}
