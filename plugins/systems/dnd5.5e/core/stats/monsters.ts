// Monsters' and summoned creatures' stats, from their stat blocks.
import type { ContentAccess } from "#sdk";
import type { Actor } from "../state.ts";
import { currentShape, usableIn } from "../forms.ts";
import {
  CompanionSchema,
  FeatureSchema,
  MonsterSchema,
  type Monster,
  type Passive,
  type Resolution,
} from "../schemas.ts";
import { lookup } from "./content.ts";
import type { Stats, KnownAction } from "./model.ts";
import { bestAc } from "./armor-class.ts";
import { exhaustionOf } from "./bonuses.ts";
import { collectFeatureData, passiveAttacks } from "./features.ts";

const COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

// Reads the printed routine, so "one Bite attack and three other attacks, using Claw or Tail" is what happens.
// An attack the sentence doesn't name is a separate action, made once.
function multiattackRoutines(
  monster: Monster,
): Readonly<Record<string, readonly string[]>> | null {
  const sentence = monster.text
    ?.replace(/\s+/g, " ")
    .match(/Multiattack(?: \([^)]*\))?\.? (.*?\.)(?: |$)/)?.[1];
  if (!sentence) return null;
  const count = monster.multiattack;
  const numbers = Object.keys(COUNT_WORDS).join("|");
  const attacks = monster.actions.flatMap(({ name, activation }, index) =>
    activation.resolution.kind === "attack" &&
    activation.cost.length === 1 &&
    activation.cost[0] === "action"
      ? [{ id: `monster:${String(index)}`, name }]
      : [],
  );
  const named = (name: string, before = ""): RegExp =>
    new RegExp(
      `\\b${before}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );
  // "one Claws attack and one Tail attack, or it makes two Hurl Flame attacks" prints two routines to choose from.
  const clauses = sentence
    .split(new RegExp(`,? or (?:it makes )?(?=(?:${numbers})\\b)`, "i"))
    .map((clause) => {
      const fixed = attacks.flatMap(({ id, name }) => {
        const word = clause.match(named(name, `(${numbers}) `))?.[1];
        return Array<string>(COUNT_WORDS[word?.toLowerCase() ?? ""] ?? 0).fill(
          id,
        );
      });
      const free = attacks
        .filter(
          ({ id, name }) => !fixed.includes(id) && named(name).test(clause),
        )
        .map(({ id }) => id);
      return { fixed, free };
    });
  const routines: Record<string, readonly string[]> = Object.fromEntries(
    attacks.map(({ id }) => {
      const clause = clauses.find(
        ({ fixed, free }) => fixed.includes(id) || free.includes(id),
      );
      if (!clause) return [id, [id]];
      const { fixed, free } = clause;
      if (fixed.includes(id) && free.length === 0) return [id, fixed];
      const room = count - fixed.length;
      // "using Pike or Longbow in any combination", or "two Greatsword or Heavy Crossbow attacks": the chosen one repeats.
      if (fixed.length === 0 || room <= 0) {
        return [id, fixed.includes(id) ? fixed : Array<string>(count).fill(id)];
      }
      const start = Math.max(0, free.indexOf(id));
      return [
        id,
        [
          ...fixed,
          ...Array.from(
            { length: room },
            (_, index) => free[(start + index) % free.length] ?? id,
          ),
        ],
      ];
    }),
  );
  // A "Melee or Ranged" attack is imported twice, and the ranged copy repeats as the melee one does.
  for (const { id, name } of attacks) {
    const melee = attacks.find((item) => `${item.name} (ranged)` === name);
    const routine = melee && routines[melee.id];
    if (melee && routine) {
      routines[id] = routine.map((item) => (item === melee.id ? id : item));
    }
  }
  return routines;
}

function mapRoutines(
  routines: Readonly<Record<string, readonly string[]>> | null,
  map: (id: string, chosen: string) => string,
): Readonly<Record<string, readonly string[]>> | null {
  if (!routines) return null;
  return Object.fromEntries(
    Object.entries(routines).map(([chosen, ids]) => [
      chosen,
      ids.map((id) => map(id, chosen)),
    ]),
  );
}

export function monsterStats(actor: Actor, access: ContentAccess): Stats {
  if (actor.source.kind !== "monster") {
    throw new Error(`${actor.id} is not a monster`);
  }
  const stats = statBlockStats(
    actor,
    lookup(access, MonsterSchema, actor.source.statBlockId),
    access,
  );
  const { familiarOf } = actor.source;
  if (!familiarOf) return stats;
  // A familiar can't attack, is a Fey, and has what its owner's features give it, reading its owner's numbers. With
  // Pact of the Chain its attacks are Reactions its owner commands, dealing the types Investment of the Chain Master
  // gives, with its owner's save DC.
  const boons = familiarOf.features.flatMap(
    (id) => lookup(access, FeatureSchema, id).familiar ?? [],
  );
  const attacks = boons.some((boon) => boon.attacks);
  const types = boons.flatMap((boon) => boon.damageTypes ?? []);
  const ownerDc = boons.some((boon) => boon.ownerDc);
  const commanded = (action: KnownAction): KnownAction => {
    const { resolution } = action.activation;
    const typed =
      resolution.kind === "attack" && types.length > 0
        ? {
            ...resolution,
            damage: resolution.damage.map((item) => ({
              ...item,
              types: [...new Set([...(item.types ?? [item.type]), ...types])],
            })),
          }
        : resolution;
    return {
      ...action,
      activation: {
        ...action.activation,
        cost: ["reaction"],
        trigger: { commanded: true },
        resolution: typed,
      },
    };
  };
  const dc = familiarOf.scaling.spellDc;
  const withDc = (action: KnownAction): KnownAction =>
    ownerDc && dc !== undefined && action.activation.resolution.kind === "save"
      ? {
          ...action,
          activation: {
            ...action.activation,
            resolution: {
              ...action.activation.resolution,
              dc: { base: dc, add: [] },
            },
          },
        }
      : action;
  return {
    ...stats,
    maxHp: familiarOf.maxHp,
    creatureType: "fey",
    passives: [...stats.passives, ...boons.flatMap((boon) => boon.passives)],
    actions: [
      ...stats.actions.flatMap((action) =>
        action.activation.resolution.kind !== "attack"
          ? [withDc(action)]
          : attacks
            ? [commanded(action)]
            : [],
      ),
      ...boons.flatMap((boon) =>
        boon.actions.map(({ name, activation }) => ({
          id: `familiar:${name}`,
          name,
          activation,
          spellLevel: null,
        })),
      ),
    ],
    scaling: { ...stats.scaling, ...familiarOf.scaling },
  };
}

// A summoned creature: its companion's numbers at the spell's level, and its caster's spell attack and save DC.
export function summonStats(actor: Actor, access: ContentAccess): Stats {
  const { source } = actor;
  if (source.kind !== "summon") throw new Error(`${actor.id} is not summoned`);
  const companion = lookup(access, CompanionSchema, source.companion);
  const { play } = companion;
  if (!play) throw new Error(`${companion.id} has no numbers to play`);
  const above = Math.max(0, source.level - play.level);
  const form =
    play.forms?.find((item) => item.name === source.form) ?? play.forms?.[0];
  const speeds = form?.speeds ?? play.speeds;
  const casterNumbers = (resolution: Resolution): Resolution => {
    const dc = { base: source.spellDc, add: [] };
    switch (resolution.kind) {
      case "attack":
        return {
          ...resolution,
          attack:
            resolution.attack.type === "spell"
              ? { ...resolution.attack, flatBonus: source.spellAttack }
              : resolution.attack,
          ...(resolution.onHitSave
            ? { onHitSave: { ...resolution.onHitSave, dc } }
            : {}),
        };
      case "save":
        return { ...resolution, dc };
      default:
        return resolution;
    }
  };
  // What its owner's features give a lasting companion, as Bestial Fury's second Beast's Strike.
  const boons = (source.boons ?? []).flatMap((id) => {
    const given = FeatureSchema.safeParse(access.content(id)).data?.companion;
    return given ? [given] : [];
  });
  const replaced = new Set(boons.flatMap(({ replaces }) => replaces ?? []));
  const retyped = boons.flatMap(({ damageTypes }) => damageTypes ?? []);
  const withTypes = (resolution: Resolution): Resolution =>
    retyped.length === 0 || resolution.kind !== "attack"
      ? resolution
      : {
          ...resolution,
          damage: resolution.damage.map((item) => ({
            ...item,
            types: [...new Set([...(item.types ?? [item.type]), ...retyped])],
          })),
        };
  const stats = statBlockStats(
    actor,
    {
      id: companion.id,
      name: companion.name,
      ...(companion.size ? { size: companion.size } : {}),
      abilities: companion.abilities,
      // a lasting companion's, worked out from its owner as it was found
      ac: source.ac ?? (form?.ac ?? play.ac) + play.acPerLevel * above,
      hp: source.maxHp ?? (form?.hp ?? play.hp) + play.hpPerLevel * above,
      speed: form?.speed ?? play.speed,
      ...(speeds ? { speeds } : {}),
      proficiency: source.proficiency,
      saves: play.saves,
      initiative: 0, // it goes right after its caster
      ...(play.creatureType ? { creatureType: play.creatureType } : {}),
      features: [],
      passives: [
        ...play.passives,
        ...(form?.passives ?? []),
        ...boons.flatMap(({ passives }) => passives),
      ],
      multiattack: Math.max(
        play.halfLevelAttacks
          ? Math.max(1, Math.floor(source.level / 2))
          : play.multiattack,
        ...boons.map(({ multiattack }) => multiattack ?? 0),
      ),
      // an action printed for some forms only is out of reach in the others
      actions: [
        ...play.actions
          .filter(
            ({ name, shapes }) =>
              !replaced.has(name) &&
              (!shapes || (form !== undefined && shapes.includes(form.name))),
          )
          .map(({ shapes: _shapes, ...action }) => action),
        ...boons.flatMap(({ actions }) => actions),
      ].map((action) => ({
        ...action,
        activation: {
          ...action.activation,
          resolution: withTypes(casterNumbers(action.activation.resolution)),
        },
      })),
    },
    access,
  );
  // Damage "plus the spell's level" reads it as a scaling key, and "plus your Intelligence modifier" as its caster's
  // spellcasting modifier, as a Steel Defender's; its save DC is the caster's, for its auras.
  return {
    ...stats,
    scaling: {
      spellLevel: source.level,
      ownerMod: source.spellAttack - source.proficiency,
      spellDc: source.spellDc,
    },
  };
}

function statBlockStats(
  actor: Actor,
  monster: Monster,
  access: ContentAccess,
): Stats {
  const fromFeatures = collectFeatureData(access, monster.features);
  const shape = currentShape(monster, actor);
  const lacks =
    actor.source.kind === "monster" ? (actor.source.lacks ?? []) : [];
  const usable = new Set(
    monster.actions.flatMap((action, index) =>
      usableIn(action, shape) && !lacks.includes(action.name)
        ? [`monster:${String(index)}`]
        : [],
    ),
  );
  // A passive marked `bloodied` holds only while the creature is.
  const bloodied = actor.hp * 2 <= monster.hp;
  const passives = [
    ...monster.passives,
    ...(shape?.passives ?? []),
    ...fromFeatures.passives,
  ].filter(
    (passive) => bloodied || !("bloodied" in passive && passive.bloodied),
  );
  // A Multiattack printed for other shapes only isn't there, and a routine's attack this shape can't make is the
  // chosen one again.
  const routines =
    shape?.multiattack === false
      ? null
      : mapRoutines(multiattackRoutines(monster), (id, chosen) =>
          usable.has(id) ? id : chosen,
        );
  return {
    abilities: monster.abilities,
    proficiency: monster.proficiency,
    level: 0,
    classLevels: {},
    maxHp: monster.hp,
    ac: bestAc(actor, monster.abilities, {
      armorBases: [monster.ac],
      flatBonus: 0,
      passives,
    }),
    speed: Math.max(
      0,
      (shape?.speed ?? monster.speed) - 5 * exhaustionOf(actor),
    ),
    savingThrows: monster.saves,
    skills: [],
    expertise: [],
    spellAbility: null,
    slots: [],
    resources: Object.fromEntries(
      monster.actions.flatMap((action) =>
        action.activation.cost.flatMap((cost) =>
          typeof cost === "object" && "resource" in cost
            ? [[cost.resource, action.perDay ?? 1]]
            : [],
        ),
      ),
    ),
    passives,
    actions: [
      ...monster.actions.flatMap((action, index) =>
        usable.has(`monster:${String(index)}`)
          ? [
              {
                id: `monster:${String(index)}`,
                name: action.name,
                activation: action.activation,
                spellLevel: null,
                ...(action.rolled ? { rolled: true as const } : {}),
              },
            ]
          : [],
      ),
      ...fromFeatures.actions,
    ],
    // A hydra bites once a head.
    multiattack: Math.max(
      shape?.multiattack === false
        ? 1
        : Math.max(1, livingHeads(actor, passives) ?? monster.multiattack),
      ...passiveAttacks(passives),
    ),
    routines,
    creatureType: monster.creatureType?.toLowerCase(),
    initiative:
      monster.initiative - 2 * exhaustionOf(actor) - (actor.ordeal ?? 0),
    scaling: {},
    features: monster.features,
    resourceDefs: fromFeatures.resources,
    pactMagic: false,
    untrainedArmor: false,
    exhaustion: exhaustionOf(actor),
    ordeal: actor.ordeal ?? 0,
    itemBonuses: {
      attack: 0,
      spellAttack: 0,
      spellDc: 0,
      savingThrows: 0,
      checks: 0,
    },
    speeds: Object.fromEntries(
      (["fly", "climb", "burrow", "swim"] as const).flatMap((mode) => {
        const feet = monster.speeds?.[mode];
        return feet
          ? [[mode, Math.max(0, feet - 5 * exhaustionOf(actor))]]
          : [];
      }),
    ),
  };
}

// A hydra's heads still living (combat/heads.ts), or null for a creature without them.
export function livingHeads(
  actor: Actor,
  passives: readonly Passive[],
): number | null {
  const heads = passives.find((passive) => passive.kind === "heads");
  if (heads?.kind !== "heads") return null;
  const spent = actor.resourcesSpent;
  return heads.heads + (spent["heads:grown"] ?? 0) - (spent["heads:dead"] ?? 0);
}
