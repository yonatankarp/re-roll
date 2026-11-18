import type { ContentAccess, SystemEvent } from "#sdk";
import {
  CompanionSchema,
  FeatureSchema,
  MonsterSchema,
  PassiveSchema,
} from "../schemas.ts";
import {
  type Actor,
  dndEvent,
  freshActor,
  hasCondition,
  INCAPACITATING,
  isDead,
  NS,
} from "../state.ts";
import {
  deriveStats,
  evaluateFormula,
  lookup,
  spellAttackBonus,
  spellSaveDc,
  type Stats,
} from "../stats.ts";

// A character's lasting companions, as a Steel Defender or a Primal Companion (passive `lastingCompanion`): found
// before its first fight, they join every fight beside their owner, acting right after it, and keep their Hit Points
// from one fight to the next. One that died comes back after a Long Rest, as its owner makes a new one, and a Long
// Rest also heals it. In a fight one takes only the Dodge action unless its owner commanded it this turn
// (`commandCompanion`), or its owner is Incapacitated.
// shortcut: bringing one back within the hour with a spell slot isn't offered; a Long Rest makes a new one.

type Held = NonNullable<Actor["companions"]>[number];

// What the owner's features give it, by the feature: the companion and the numbers worked out from the owner.
function grants(
  owner: Actor,
  stats: Stats,
  access: ContentAccess,
): Omit<Held, "hp">[] {
  return stats.passives.flatMap((passive): Omit<Held, "hp">[] => {
    if (passive.kind !== "lastingCompanion") return [];
    const numbers = {
      feature: passive.companion,
      companion: passive.companion,
      proficiency: stats.proficiency,
      spellAttack: spellAttackBonus(stats),
      spellDc: spellSaveDc(stats),
      ...(passive.free ? { free: true as const } : {}),
    };
    // Create Homunculus's: a monster's stat block as it's printed.
    if (passive.monster) {
      const monster = MonsterSchema.safeParse(
        access.content(passive.companion),
      ).data;
      return monster
        ? [{ ...numbers, maxHp: monster.hp, monster: true as const }]
        : [];
    }
    const companion = CompanionSchema.safeParse(
      access.content(passive.companion),
    ).data;
    const play = companion?.play;
    if (!play) return [];
    const ac = play.owner?.ac && evaluateFormula(play.owner.ac, stats);
    const level = passive.level ?? play.level;
    return [
      {
        ...numbers,
        maxHp: play.owner
          ? evaluateFormula(play.owner.hp, stats)
          : play.hp + play.hpPerLevel * Math.max(0, level - play.level),
        ...(ac ? { ac } : {}),
        ...(passive.level ? { level } : {}),
      },
    ];
  });
}

// Who finds a companion now: before a fight only one never found, and at a rest also one whose numbers changed, or
// after a Long Rest one that died or was hurt.
export function companionFoundEvents(
  members: readonly Actor[],
  access: ContentAccess,
  when: "fight" | "short" | "long",
): SystemEvent[] {
  return members.flatMap((owner) => {
    if (owner.source.kind !== "character" || isDead(owner)) return [];
    const stats = deriveStats(owner, access);
    return grants(owner, stats, access).flatMap((found) => {
      const held = owner.companions?.find(
        ({ feature }) => feature === found.feature,
      );
      const changed =
        held !== undefined &&
        (held.maxHp !== found.maxHp ||
          held.ac !== found.ac ||
          held.spellAttack !== found.spellAttack ||
          held.spellDc !== found.spellDc ||
          held.proficiency !== found.proficiency ||
          held.level !== found.level);
      const due =
        !held ||
        (when !== "fight" && changed) ||
        (when === "long" && held.hp < held.maxHp);
      return due
        ? [dndEvent(`${NS}:companionFound`, { actor: owner.id, ...found })]
        : [];
    });
  });
}

// The companions that join a fight beside their owners, alive and still given by the owner's features.
export function companionActors(
  members: readonly Actor[],
  access: ContentAccess,
): Actor[] {
  return members.flatMap((owner) => {
    if (owner.source.kind !== "character" || isDead(owner)) return [];
    const stats = deriveStats(owner, access);
    const given = new Set(
      stats.passives.flatMap((passive) =>
        passive.kind === "lastingCompanion" ? [passive.companion] : [],
      ),
    );
    const boons = stats.features.filter(
      (id) => FeatureSchema.safeParse(access.content(id)).data?.companion,
    );
    // Horseshoes of Speed on its mount.
    const gear = stats.passives.flatMap((passive) =>
      passive.kind === "companionGear"
        ? passive.passives.flatMap(
            (item) => PassiveSchema.safeParse(item).data ?? [],
          )
        : [],
    );
    const worn = gear.length > 0 ? { gear } : {};
    return (owner.companions ?? []).flatMap((held) => {
      // A Find Steed steed stays until it dies; anything else only while a feature or known spell gives it.
      if (held.hp <= 0) return [];
      if (
        !given.has(held.feature) &&
        !(held.free && held.level !== undefined)
      ) {
        return [];
      }
      const slug = held.companion.slice(held.companion.lastIndexOf("/") + 1);
      // Find Greater Steed's mount: a monster's stat block, called by its owner.
      if (held.monster) {
        const monster = MonsterSchema.safeParse(
          access.content(held.companion),
        ).data;
        if (!monster) return [];
        return [
          freshActor({
            id: `${owner.id}:companion:${slug}`,
            name: `${owner.name}'s ${monster.name}`,
            side: owner.side,
            source: {
              kind: "monster",
              statBlockId: held.companion,
              calledBy: owner.id,
              lasting: { feature: held.feature },
              ...worn,
            },
            hp: held.hp,
            inventory: [],
          }),
        ];
      }
      const companion = lookup(access, CompanionSchema, held.companion);
      return [
        freshActor({
          id: `${owner.id}:companion:${slug}`,
          name: `${owner.name}'s ${companion.name}`,
          side: owner.side,
          source: {
            kind: "summon",
            companion: held.companion,
            level: held.level ?? companion.play?.level ?? 1,
            casterId: owner.id,
            sourceId: `companion:${held.feature}`,
            concentration: false,
            proficiency: held.proficiency,
            spellAttack: held.spellAttack,
            spellDc: held.spellDc,
            lasting: {
              feature: held.feature,
              ...(held.free ? { free: true as const } : {}),
            },
            ...(boons.length > 0 ? { boons } : {}),
            ...worn,
            maxHp: held.maxHp,
            ...(held.ac !== undefined ? { ac: held.ac } : {}),
          },
          hp: held.hp,
          inventory: [],
        }),
      ];
    });
  });
}

// A lasting companion's owner, or null for any other creature.
export function companionOwner(actor: Actor): string | null {
  const { source } = actor;
  if (source.kind === "summon" && source.lasting) return source.casterId;
  return source.kind === "monster" && source.lasting
    ? (source.calledBy ?? null)
    : null;
}

// A lasting companion takes only the Dodge action, unless its owner commanded it or is Incapacitated.
export function awaitsCommand(actor: Actor, owner: Actor | undefined): boolean {
  if (companionOwner(actor) === null) return false;
  // A steed from a spell, as Find Steed's, acts as its owner's mount, needing no command.
  if (actor.source.kind !== "summon" || actor.source.lasting?.free) {
    return false;
  }
  if (!owner || isDead(owner) || hasCondition(owner, ...INCAPACITATING)) {
    return false;
  }
  return !actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "commanded",
  );
}
