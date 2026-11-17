import type { SystemEvent } from "#sdk";
import { ClassSchema, type Passive, SpellSchema } from "../schemas.ts";
import { type Actor, dndEvent, NS } from "../state.ts";
import {
  deriveStats,
  type KnownAction,
  lookup,
  spellModifier,
  type Stats,
} from "../stats.ts";
import { HIT_DICE } from "./ids.ts";
import { hitDieRoll } from "../trait-rules.ts";
import { leafEvents } from "./effects.ts";
import type { Context } from "./queries.ts";

// The Arcana Unleashed adepts' riders on casting a spell of their school (passive `schoolCast`).

type Rider = Extract<Passive, { kind: "schoolCast" }>["rider"];
const FUELED = "fueled"; // usedThisTurn: Fueled Evocation's once a turn

// The school of the spell behind an action or a Concentration source, as "spell:<id>" or "spell:<id>:free".
export function schoolOf(
  sourceId: string | null,
  context: Pick<Context, "content">,
): string | null {
  if (!sourceId?.startsWith("spell:")) return null;
  const id = sourceId.slice(6).replace(/:free$/, "");
  return SpellSchema.safeParse(context.content(id)).data?.school ?? null;
}

function riding(stats: Stats, school: string | null, rider: Rider): boolean {
  return stats.passives.some(
    (passive) =>
      passive.kind === "schoolCast" &&
      passive.school === school &&
      passive.rider === rider,
  );
}

// Up to this many of the actor's unspent Hit Point Dice, rolled and spent.
function spendHitDice(
  actor: Actor,
  count: number,
  context: Context,
): { readonly total: number; readonly events: SystemEvent[] } {
  const build = actor.source.kind === "character" ? actor.source.build : null;
  const spent = actor.resourcesSpent[HIT_DICE] ?? 0;
  const entries = build?.levels.slice(spent, spent + count) ?? [];
  let total = 0;
  for (const entry of entries) {
    total += hitDieRoll(
      lookup(context, ClassSchema, entry.classId).hitDie,
      deriveStats(actor, context),
      context.dice,
    );
  }
  return {
    total,
    events: entries.map(() =>
      dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: HIT_DICE }),
    ),
  };
}

// Casting a spell of the school with a slot: Protective Ward's Temporary Hit Points, Life Manipulation's healing and
// Magical Augmentation's Speed.
// shortcut: the ward always goes to the caster, and Hit Point Dice are spent only while it's hurt.
export function schoolCastEvents(
  actor: Actor,
  action: KnownAction,
  slotLevel: number | undefined,
  context: Context,
): SystemEvent[] {
  if (slotLevel === undefined || action.spellLevel === null) return [];
  const stats = deriveStats(actor, context);
  const school = schoolOf(action.id, context);
  const events: SystemEvent[] = [];
  if (riding(stats, school, "ward")) {
    events.push(
      dndEvent(`${NS}:tempHpGained`, {
        actor: actor.id,
        amount: 2 * slotLevel,
      }),
    );
  }
  if (riding(stats, school, "life") && actor.hp < stats.maxHp) {
    const { total, events: spent } = spendHitDice(actor, 2, context);
    if (spent.length > 0) {
      events.push(
        ...spent,
        dndEvent(`${NS}:healed`, {
          actor: actor.id,
          amount: Math.min(
            total + slotLevel,
            stats.maxHp - Math.max(actor.hp, 0),
          ),
          max: stats.maxHp,
        }),
      );
    }
  }
  if (riding(stats, school, "augment") && context.state.combat) {
    events.push(
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId: `schoolCast:${action.id}`,
          casterId: actor.id,
          modifier: {
            kind: "bonus",
            to: "speed",
            amount: { bonus: { base: 5 * slotLevel, add: [] } },
          },
          ends: "casterTurnEnd",
        },
      }),
    );
  }
  // Expert Divination: the highest spent slot below the one cast with, up to level 5.
  if (riding(stats, school, "refund") && slotLevel >= 2) {
    for (let level = Math.min(slotLevel - 1, 5); level >= 1; level -= 1) {
      const resource = `slot:${String(level)}`;
      if ((actor.resourcesSpent[resource] ?? 0) === 0) continue;
      events.push(
        dndEvent(`${NS}:resourceRestored`, {
          actor: actor.id,
          resource,
          amount: 1,
        }),
      );
      break;
    }
  }
  return events;
}

// Fueled Evocation: once a turn, up to two Hit Point Dice added to an Evocation spell's damage.
// shortcut: only a save or automatic spell's damage, since a spell attack's is rolled in attack.ts.
export function fueledDamage(
  actor: Actor,
  action: KnownAction,
  context: Context,
): { readonly bonus: number; readonly events: SystemEvent[] } {
  const stats = deriveStats(actor, context);
  if (
    action.spellLevel === null ||
    actor.usedThisTurn.includes(FUELED) ||
    !riding(stats, schoolOf(action.id, context), "fueled")
  ) {
    return { bonus: 0, events: [] };
  }
  const { total, events } = spendHitDice(actor, 2, context);
  if (events.length === 0) return { bonus: 0, events: [] };
  return {
    bonus: total,
    events: [
      ...events,
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key: FUELED }),
    ],
  };
}

// Flames of Phlegethos: casting a spell that deals the type puts the rider's effects on the caster.
export function castRiders(
  actor: Actor,
  action: KnownAction,
  context: Context,
): SystemEvent[] {
  if (action.spellLevel === null) return [];
  const { resolution } = action.activation;
  const types = new Set([
    ...resolution.damage.map(({ type }) => type),
    ...(resolution.kind === "attack" && resolution.onHitSave
      ? resolution.onHitSave.damage.map(({ type }) => type)
      : []),
  ]);
  return deriveStats(actor, context).passives.flatMap((passive) =>
    passive.kind === "castRider" && types.has(passive.damage)
      ? leafEvents(
          passive.effects,
          `castRider:${action.id}`,
          actor,
          actor,
          context,
        )
      : [],
  );
}

// Persistent Conjuration: the bonus to the save to keep Concentration on a Conjuration spell.
// shortcut: the spellcasting modifier, rather than the one the feat raised, which it usually is.
export function concentrationBonus(actor: Actor, context: Context): number {
  const stats = deriveStats(actor, context);
  return riding(stats, schoolOf(actor.concentratingOn, context), "persistent")
    ? Math.max(0, spellModifier(stats))
    : 0;
}
