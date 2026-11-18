import type { Frame, SystemEvent } from "#sdk";
import { ClassSchema, type Passive, SpellSchema } from "../schemas.ts";
import { type Actor, dndEvent, isDown, NS } from "../state.ts";
import { finalDamage } from "../rules.ts";
import { distanceFeet } from "../grid.ts";
import {
  atSlotLevel,
  damageResponses,
  deriveStats,
  evaluateFormula,
  type KnownAction,
  lookup,
  rollAmount,
  spellModifier,
  type Stats,
} from "../stats.ts";
import { HIT_DICE, spellOfSource } from "./ids.ts";
import { hitDieRoll } from "../trait-rules.ts";
import { dealEvents, leafEvents, typeAgainst } from "./effects.ts";
import { teleportFrame } from "./movement.ts";
import { type Context, enemies } from "./queries.ts";

// The Arcana Unleashed adepts' riders on casting a spell of their school (passive `schoolCast`).

type Rider = Extract<Passive, { kind: "schoolCast" }>["rider"];
const FUELED = "fueled"; // usedThisTurn: Fueled Evocation's once a turn

// The school of the spell behind an action or a Concentration source (ids.ts spellOfSource).
export function schoolOf(
  sourceId: string | null,
  context: Pick<Context, "content">,
): string | null {
  const id = sourceId === null ? null : spellOfSource(sourceId);
  if (!id) return null;
  return SpellSchema.safeParse(context.content(id)).data?.school ?? null;
}

// The once-a-turn use a cast rider spends, by what it rides on.
function riderKey(passive: Extract<Passive, { kind: "castRider" }>): string {
  return `castRider:${passive.spends ?? ""}:${(passive.types ?? []).join(",")}:${passive.without?.join(",") ?? ""}`;
}

// Fueled Spellfire: a spell dealing one of the types also takes Hit Point Dice once a turn.
function fueledType(stats: Stats, action: KnownAction): boolean {
  const types = action.activation.resolution.damage.map(({ type }) => type);
  return stats.passives.some(
    (passive) =>
      passive.kind === "fueledSpell" &&
      passive.types.some((type) => types.includes(type)),
  );
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
    !(
      riding(stats, schoolOf(action.id, context), "fueled") ||
      fueledType(stats, action)
    )
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

// Whether a spell restores Hit Points.
function heals(action: KnownAction): boolean {
  const { resolution } = action.activation;
  const effects =
    resolution.kind === "automatic"
      ? resolution.effects
      : resolution.kind === "save"
        ? [...resolution.onFail, ...resolution.onSuccess]
        : resolution.onHit;
  return effects.some((effect) => effect.kind === "heal");
}

// Flames of Phlegethos: casting a spell that deals the type puts the rider's effects on the caster. Bewitching
// Magic: casting one of the school with an action and a slot does, its teleport landing where the caster picks.
export function castRiders(
  actor: Actor,
  action: KnownAction,
  slotLevel: number | undefined,
  context: Context,
  targets: readonly Actor[] = [],
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  if (action.spellLevel === null) return { events: [], frames: [] };
  const { resolution, cost } = action.activation;
  const types = new Set([
    ...resolution.damage.map(({ type }) => type),
    ...(resolution.kind === "attack" && resolution.onHitSave
      ? resolution.onHitSave.damage.map(({ type }) => type)
      : []),
  ]);
  const school = schoolOf(action.id, context);
  const stats = deriveStats(actor, context);
  const rides = stats.passives.flatMap((passive) => {
    if (passive.kind !== "castRider") return [];
    if (
      passive.resource &&
      (actor.resourcesSpent[passive.resource] ?? 0) >=
        (stats.resources[passive.resource] ?? 0)
    ) {
      return [];
    }
    if (passive.slot && slotLevel === undefined) return [];
    if (passive.oncePerTurn && actor.usedThisTurn.includes(riderKey(passive))) {
      return [];
    }
    if (passive.without?.some((id) => stats.features.includes(id))) return [];
    if (
      passive.spends &&
      !cost.some(
        (item) =>
          typeof item === "object" &&
          "resource" in item &&
          item.resource === passive.spends,
      )
    ) {
      return [];
    }
    const fits = passive.uses
      ? passive.uses.some(
          (id) =>
            action.id === `spell:${id}` || action.id.startsWith(`spell:${id}:`),
        )
      : passive.spends
        ? true
        : passive.school
          ? slotLevel !== undefined &&
            cost.includes("action") &&
            passive.school.some((item) => item === school)
          : passive.heals
            ? heals(action) && targets.some((item) => item.id !== actor.id)
            : passive.types
              ? passive.types.some((type) => types.has(type))
              : passive.damage !== undefined && types.has(passive.damage);
    return fits ? [passive] : [];
  });
  // Simbul's Synostodweomer: a slot spell rolls as many Hit Point Dice as the slot's level.
  const mended =
    slotLevel === undefined
      ? []
      : actor.activeEffects.flatMap(({ modifier, casterId, sourceId }) => {
          if (modifier.kind !== "castHitDice") return [];
          const by = context.state.actors[casterId] ?? actor;
          return leafEvents(
            [
              {
                kind: "hitDieHeal",
                dice: slotLevel,
                bonus: {
                  base: evaluateFormula(
                    modifier.bonus,
                    deriveStats(by, context),
                  ),
                  add: [],
                },
              },
            ],
            sourceId,
            by,
            actor,
            context,
          );
        });
  return {
    events: [
      ...mended,
      ...rides.flatMap((ride) => {
        const { effects, onTargets, resource, nearby } = ride;
        const near = nearby
          ? enemies(context.state, actor).filter(
              (foe) =>
                !isDown(foe) &&
                distanceFeet(foe.position, actor.position) <= nearby.within,
            )
          : [];
        const struck = nearby?.one
          ? [...near].sort((a, b) => a.hp - b.hp).slice(0, 1)
          : near;
        return [
          ...(resource
            ? [dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource })]
            : []),
          ...(ride.oncePerTurn
            ? [
                dndEvent(`${NS}:oncePerTurnUsed`, {
                  actor: actor.id,
                  key: riderKey(ride),
                }),
              ]
            : []),
          ...(nearby?.otherwise && struck.length === 0
            ? leafEvents(
                nearby.otherwise,
                `castRider:${action.id}`,
                actor,
                actor,
                context,
              )
            : []),
          // Heart of the Storm: the foes round the caster take its damage, in the type each resists least.
          ...(nearby
            ? struck.flatMap(
                (foe) =>
                  dealEvents(
                    foe,
                    nearby.damage.map((item) => {
                      const type = item.types
                        ? typeAgainst(item.types, damageResponses(foe, context))
                        : item.type;
                      return {
                        amount: finalDamage(
                          rollAmount(item.amount, stats, context.dice),
                          type,
                          damageResponses(foe, context),
                        ),
                        type,
                      };
                    }),
                    false,
                    context,
                  ).events,
              )
            : []),
          ...leafEvents(
            atSlotLevel(effects, slotLevel ?? 0),
            `castRider:${action.id}`,
            actor,
            actor,
            context,
          ),
          // On the spell's targets too, ending with it, as Hunter's Rime's hold on the marked.
          ...(onTargets
            ? targets.flatMap((target) =>
                target.id === actor.id
                  ? []
                  : leafEvents(onTargets, action.id, actor, target, context),
              )
            : []),
        ];
      }),
    ],
    frames: rides.flatMap(({ effects }) =>
      effects.flatMap((effect) =>
        effect.kind === "teleport"
          ? [
              teleportFrame(
                actor,
                effect.feet,
                effect.movement,
                context,
                effect.provokes,
              ),
            ]
          : [],
      ),
    ),
  };
}

// Persistent Conjuration: the bonus to the save to keep Concentration on a Conjuration spell.
// shortcut: the spellcasting modifier, rather than the one the feat raised, which it usually is.
export function concentrationBonus(actor: Actor, context: Context): number {
  const stats = deriveStats(actor, context);
  return riding(stats, schoolOf(actor.concentratingOn, context), "persistent")
    ? Math.max(0, spellModifier(stats))
    : 0;
}
