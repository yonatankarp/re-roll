import type { ContentAccess, SystemEvent } from "#sdk";
import {
  CompanionSchema,
  DAMAGE_TYPES,
  type LeafEffect,
  type Modifier,
  SpellSchema,
} from "../schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  dndEvent,
  freshActor,
  NS,
} from "../state.ts";
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
        // An item's bonus to DCs isn't one to attacks, so it comes off, and its bonus to spell attacks goes on.
        spellAttack:
          spellDc -
          8 -
          stats.itemBonuses.spellDc +
          stats.itemBonuses.spellAttack,
        spellDc,
        ...(effect.form ? { form: effect.form } : {}),
      },
      hp: 1,
      inventory: [],
    });
    return boosted(
      { ...actor, hp: deriveStats(actor, context).maxHp },
      caster,
      action.id,
      action.activation.cost.includes("slot"),
      context,
    );
  });
}

const UNRESISTED = new Set(["force", "necrotic", "psychic", "radiant"]);

// What the caster's `summonBoost` passives give a creature it calls or raises, as it appears, as Durable Summons'
// Temporary Hit Points or Undead Fortitude's Hit Points.
export function boosted(
  summoned: Actor,
  caster: Actor,
  source: string | undefined, // the spell's action id, as "spell:phb:spell/animate-dead"
  slotted: boolean,
  context: ContentAccess,
): Actor {
  if (caster.source.kind !== "character") return summoned;
  const stats = deriveStats(caster, context);
  const boosts = stats.passives.flatMap((passive) =>
    passive.kind === "summonBoost" ? [passive] : [],
  );
  if (boosts.length === 0) return summoned;
  const spellId = source?.match(/^spell:([^:]+:[^:]+)/)?.[1];
  const spell = spellId
    ? SpellSchema.safeParse(context.content(spellId)).data
    : undefined;
  const type = (
    deriveStats(summoned, context).creatureType ?? ""
  ).toLowerCase();
  const effect = (modifier: Modifier): ActiveEffect => ({
    sourceId: "summon-boost",
    casterId: caster.id,
    modifier,
    ends: "spellDuration",
  });
  let next = summoned;
  for (const boost of boosts) {
    if (boost.schools && (!spell || !boost.schools.includes(spell.school))) {
      continue;
    }
    if (boost.slot && !slotted) continue;
    if (boost.creatureTypes && !boost.creatureTypes.includes(type)) continue;
    const effects: ActiveEffect[] = [];
    if (boost.hp) {
      const more = Math.max(0, evaluateFormula(boost.hp, stats));
      effects.push(
        effect({
          kind: "bonus",
          to: "maxHp",
          amount: { bonus: { base: more, add: [] } },
        }),
      );
      next = { ...next, hp: next.hp + more };
    }
    if (boost.tempHp) {
      next = {
        ...next,
        tempHp: Math.max(next.tempHp, evaluateFormula(boost.tempHp, stats)),
      };
    }
    if (boost.resistant) {
      for (const damage of DAMAGE_TYPES) {
        if (!UNRESISTED.has(damage)) {
          effects.push(effect({ kind: "resistance", damage }));
        }
      }
    }
    if (boost.hitDamage) {
      const { amount, type: damageType } = boost.hitDamage;
      effects.push(
        effect({
          kind: "hitDamage",
          dealtBy: "bearer",
          weaponOnly: false,
          damage: {
            type: damageType,
            amount: {
              ...amount,
              ...(amount.bonus
                ? {
                    bonus: {
                      base: evaluateFormula(amount.bonus, stats),
                      add: [],
                    },
                  }
                : {}),
            },
          },
        }),
      );
    }
    next = { ...next, activeEffects: [...next.activeEffects, ...effects] };
  }
  return next;
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
