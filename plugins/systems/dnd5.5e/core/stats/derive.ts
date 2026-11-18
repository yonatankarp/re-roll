// Any creature's stats, derived on demand from its state.
import type { ContentAccess } from "#sdk";
import { environmentPassives } from "../environment.ts";
import type { Actor } from "../state.ts";
import { formKept, formModifier, formOf } from "../forms.ts";
import { SpellSchema } from "../schemas.ts";
import { withWeaponRiders } from "../weapon-riders.ts";
import { spellOfSource } from "../combat/ids.ts";
import { type Stats, passiveModifiers } from "./model.ts";
import { passiveBonus } from "./features.ts";
import { characterStats } from "./character.ts";
import { monsterStats, summonStats } from "./monsters.ts";
import { hasSteadySpeed, zoneMoves, jumpActions } from "./movement.ts";
import { withEffectActions } from "./effect-actions.ts";

// What a form that keeps the bearer's features takes from it, as Wild Shape's: its class features, feats and
// resources, its skill and save proficiencies with the better Proficiency Bonus, and its own level for formulas.
// shortcut: species traits are kept too, and passives baked into the bearer's own AC and Speed don't carry over.
function keptFeatures(
  own: Stats,
  shaped: Stats,
  actor: Actor,
  access: ContentAccess,
  acFloor?: number,
) {
  return {
    ac: Math.max(shaped.ac, acFloor ?? 0),
    proficiency: Math.max(shaped.proficiency, own.proficiency),
    level: own.level,
    classLevels: own.classLevels,
    scaling: own.scaling,
    features: own.features,
    savingThrows: [...new Set([...shaped.savingThrows, ...own.savingThrows])],
    skills: [...new Set([...shaped.skills, ...own.skills])],
    expertise: own.expertise,
    resources: { ...shaped.resources, ...own.resources },
    resourceDefs: [...shaped.resourceDefs, ...own.resourceDefs],
    passives: [...shaped.passives, ...own.passives],
    // the form's attacks take the bearer's riders, as Improved Circle Forms' Radiant
    actions: [
      ...withWeaponRiders(
        shaped.actions,
        own.passives,
        actor,
        access,
        shaped.abilities,
      ),
      ...own.actions.filter(({ id }) => id.startsWith("feature:")),
    ],
  };
}

export function deriveStats(actor: Actor, access: ContentAccess): Stats {
  const built =
    actor.source.kind === "monster"
      ? monsterStats(actor, access)
      : actor.source.kind === "summon"
        ? summonStats(actor, access)
        : characterStats(actor, access);
  // Find Greater Steed's mount: a monster kept as a lasting companion can be ridden.
  // What its owner's gear gives a lasting companion, as Horseshoes of Speed.
  const gear =
    actor.source.kind === "monster" || actor.source.kind === "summon"
      ? (actor.source.gear ?? [])
      : [];
  const base =
    actor.source.kind === "monster" && actor.source.lasting
      ? {
          ...built,
          passives: [...built.passives, { kind: "rideable" as const }, ...gear],
        }
      : gear.length > 0
        ? { ...built, passives: [...built.passives, ...gear] }
        : built;
  // Gear comes after the stat block's own numbers, so its Speed bonus is added here.
  const own =
    gear.length > 0
      ? {
          ...base,
          speed:
            base.speed + passiveBonus({ ...base, passives: gear }, "speed"),
        }
      : base;
  // A form's stat block replaces the creature's own, but it keeps its creature type and Hit Point maximum, and with
  // Shapechange its Intelligence, Wisdom and Charisma and its spellcasting.
  const form = formOf(actor);
  const kept = formKept(actor);
  // Beast Spells: spells cast in a form that keeps the bearer's features, of these schools when it names them.
  const formSpells = kept.includes("features")
    ? own.passives.find((passive) => passive.kind === "formSpells")
    : undefined;
  const keep = formSpells ? [...kept, "spells" as const] : kept;
  const shaped = form
    ? monsterStats(
        { ...actor, source: { kind: "monster", statBlockId: form } },
        access,
      )
    : null;
  const stats = shaped
    ? {
        ...shaped,
        creatureType: own.creatureType,
        maxHp: own.maxHp,
        ...(keep.includes("mind")
          ? {
              abilities: {
                ...shaped.abilities,
                int: own.abilities.int,
                wis: own.abilities.wis,
                cha: own.abilities.cha,
              },
            }
          : {}),
        ...(keep.includes("features")
          ? keptFeatures(own, shaped, actor, access, formModifier(actor)?.ac)
          : {}),
        ...(keep.includes("spells")
          ? {
              actions: [
                ...(keep.includes("features")
                  ? keptFeatures(own, shaped, actor, access).actions
                  : shaped.actions),
                ...own.actions.filter(
                  ({ id, spellLevel }) =>
                    spellLevel !== null &&
                    (formSpells?.kind !== "formSpells" ||
                      !formSpells.school ||
                      formSpells.school.some(
                        (school) =>
                          SpellSchema.safeParse(
                            access.content(spellOfSource(id) ?? ""),
                          ).data?.school === school,
                      )),
                ),
              ],
              spellAbility: own.spellAbility,
              slots: own.slots,
              pactMagic: own.pactMagic,
              proficiency: Math.max(shaped.proficiency, own.proficiency),
            }
          : {}),
        ...(formModifier(actor)?.ac !== undefined && !keep.includes("features")
          ? { ac: Math.max(shaped.ac, formModifier(actor)?.ac ?? 0) }
          : {}),
      }
    : own;
  // A Ring of Free Action: nothing takes Speed off.
  const speed = effectBonus(actor, "speed", hasSteadySpeed(stats, actor));
  const maxHp = effectBonus(actor, "maxHp");
  const stuck = new Set(
    actor.activeEffects.flatMap(({ modifier }) =>
      modifier.kind === "stuck" ? [modifier.action] : [],
    ),
  );
  const changed = withEffectActions(stats, actor, access);
  const free =
    stuck.size === 0
      ? changed
      : {
          ...changed,
          actions: changed.actions.filter((action) => !stuck.has(action.id)),
        };
  const moving = [...zoneMoves(actor), ...jumpActions(actor, stats)];
  const moved =
    moving.length > 0
      ? { ...free, actions: [...free.actions, ...moving] }
      : free;
  const loss = actor.maxHpLoss ?? 0;
  // The environmental effects around it give their passives too, as Arcadian Vitality (environment.ts).
  const around = environmentPassives(moved.creatureType, access);
  const surrounded =
    around.length > 0
      ? { ...moved, passives: [...moved.passives, ...around] }
      : moved;
  // A character's passive marked `bloodied` holds only while it is, as Boon of the Furious Storm's Immunity.
  const placed =
    actor.source.kind === "character" &&
    surrounded.passives.some(
      (passive) => "bloodied" in passive && passive.bloodied,
    ) &&
    actor.hp * 2 > surrounded.maxHp
      ? {
          ...surrounded,
          passives: surrounded.passives.filter(
            (passive) => !("bloodied" in passive && passive.bloodied),
          ),
        }
      : surrounded;
  // Boots of Striding and Springing: a Speed of at least 30 feet.
  const floor = Math.max(
    0,
    ...passiveModifiers(placed.passives).flatMap((modifier) =>
      modifier.kind === "speedFloor" ? [modifier.feet] : [],
    ),
  );
  const floored =
    floor > placed.speed + speed ? { ...placed, speed: floor - speed } : placed;
  return speed === 0 && maxHp === 0 && loss === 0
    ? floored
    : {
        ...floored,
        speed: Math.max(0, floored.speed + speed),
        maxHp: Math.max(1, stats.maxHp + maxHp - loss),
      };
}

// A spell's flat Speed or Hit Point maximum increase, as with Longstrider or Aid, counted once per source.
// shortcut: Hit Points above the maximum aren't taken away when the increase ends.
function effectBonus(
  actor: Actor,
  to: "speed" | "maxHp",
  increasesOnly = false,
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const { sourceId, modifier } of actor.activeEffects) {
    if (
      modifier.kind !== "bonus" ||
      modifier.to !== to ||
      seen.has(sourceId) ||
      (increasesOnly && modifier.subtract)
    )
      continue;
    seen.add(sourceId);
    total += (modifier.subtract ? -1 : 1) * (modifier.amount.bonus?.base ?? 0);
  }
  return total;
}

// Profane Casting: a spell of these schools the bearer casts without its components.
export function bareSpell(
  actor: Actor,
  school: string,
  access: ContentAccess,
): boolean {
  return deriveStats(actor, access).passives.some(
    (passive) =>
      passive.kind === "noComponents" &&
      passive.school.some((item) => item === school) &&
      (!passive.while ||
        passive.while.some((id) =>
          actor.activeEffects.some(({ sourceId }) =>
            sourceId.startsWith(`feature:${id}:`),
          ),
        )),
  );
}
