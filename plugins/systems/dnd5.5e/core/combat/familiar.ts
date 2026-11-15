import type { ContentAccess, SystemEvent } from "#sdk";
import { FeatureSchema, MonsterSchema, type Skill } from "../schemas.ts";
import {
  type Actor,
  type DndState,
  dndEvent,
  familiarOwner,
  freshActor,
  isDead,
  isDown,
  NS,
} from "../state.ts";
import { distanceFeet } from "../grid.ts";
import {
  deriveStats,
  evaluateFormula,
  lookup,
  modifierFor,
  type Stats,
} from "../stats.ts";
import type { Context } from "./queries.ts";

// A character's familiar, from a spell that gives one (Find Familiar, or a feat that grants it). It is found before
// the first fight once its owner knows the spell, joins every fight with Initiative of its own, and keeps its Hit
// Points from one fight to the next. A rest finds again one that dropped or whose numbers changed, as the spell's
// ritual would, and a Long Rest also heals it.

// The owner's features that give its familiar something.
function boonFeatures(stats: Stats, access: ContentAccess): readonly string[] {
  return stats.features.filter(
    (id) => FeatureSchema.safeParse(access.content(id)).data?.familiar,
  );
}

// The use a check with this skill spends for Advantage from the familiar beside the roller, as with Helpful
// Friend, or null.
export function familiarHelpUse(
  actor: Actor,
  stats: Stats,
  skill: Skill | undefined,
  state: DndState,
): SystemEvent | null {
  if (!skill || !stats.skills.includes(skill)) return null;
  const beside = state.combat
    ? Object.values(state.actors).some(
        (item) =>
          familiarOwner(item) === actor.id &&
          !isDown(item) &&
          distanceFeet(item.position, actor.position) <= 5,
      )
    : (actor.familiar?.hp ?? 0) > 0;
  if (!beside) return null;
  const resource = stats.passives.find(
    (passive) =>
      passive.kind === "familiarHelp" &&
      (actor.resourcesSpent[passive.resource] ?? 0) <
        (stats.resources[passive.resource] ?? 0),
  );
  return resource?.kind === "familiarHelp"
    ? dndEvent(`${NS}:resourceSpent`, {
        actor: actor.id,
        resource: resource.resource,
      })
    : null;
}

// Its form's Hit Points, and what the owner's features add when it is found, as Fortified Familiar's.
export function familiarMaxHp(stats: Stats, access: ContentAccess): number {
  if (!stats.familiar) return 0;
  const { hp } = lookup(access, MonsterSchema, stats.familiar.form);
  return boonFeatures(stats, access).reduce((total, id) => {
    const bonus = lookup(access, FeatureSchema, id).familiar?.hp;
    return total + (bonus ? evaluateFormula(bonus, stats) : 0);
  }, hp);
}

// Who finds a familiar now: at the start of a fight only one never found, and at a rest also one that dropped or
// changed, or after a Long Rest one that was hurt.
export function familiarFoundEvents(
  members: readonly Actor[],
  access: ContentAccess,
  when: "fight" | "short" | "long",
): SystemEvent[] {
  return members.flatMap((actor) => {
    if (actor.source.kind !== "character" || isDead(actor)) return [];
    const stats = deriveStats(actor, access);
    if (!stats.familiar) return [];
    const maxHp = familiarMaxHp(stats, access);
    const held = actor.familiar;
    const due =
      !held ||
      (when !== "fight" &&
        (held.hp <= 0 ||
          held.form !== stats.familiar.form ||
          held.maxHp !== maxHp ||
          (when === "long" && held.hp < held.maxHp)));
    return due
      ? [
          dndEvent(`${NS}:familiarFound`, {
            actor: actor.id,
            form: stats.familiar.form,
            maxHp,
          }),
        ]
      : [];
  });
}

// The familiars that join a fight beside their owners, with the owners' numbers they read.
export function familiarActors(
  members: readonly Actor[],
  context: Context,
): Actor[] {
  return members.flatMap((owner) => {
    const held = owner.familiar;
    if (owner.source.kind !== "character" || isDead(owner) || !held) return [];
    if (held.hp <= 0) return [];
    const stats = deriveStats(owner, context);
    if (!stats.familiar) return [];
    const form = lookup(context, MonsterSchema, held.form);
    return [
      freshActor({
        id: `${owner.id}:familiar`,
        name: `${owner.name}'s ${form.name}`,
        side: "party",
        source: {
          kind: "monster",
          statBlockId: held.form,
          familiarOf: {
            owner: owner.id,
            maxHp: held.maxHp,
            features: [...boonFeatures(stats, context)],
            scaling: {
              ownerProficiency: stats.proficiency,
              spellDc:
                8 +
                stats.proficiency +
                modifierFor(stats, stats.familiar.ability),
            },
          },
        },
        hp: held.hp,
        inventory: [],
      }),
    ];
  });
}
