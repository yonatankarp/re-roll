import type { ContentAccess, Dice, SystemEvent } from "#sdk";
import {
  type Ability,
  ClassSchema,
  type DamageType,
  ItemSchema,
  type SaveFrom,
  type Passive,
  type Skill,
} from "./schemas.ts";
import {
  type Actor,
  type DndState,
  INCAPACITATING,
  NS,
  dndEvent,
  equipped,
  hasCondition,
} from "./state.ts";
import {
  type Stats,
  deriveStats,
  evaluateFormula,
  lookup,
  passiveModifiers,
  rollDiceNotation,
  scaledDice,
} from "./stats.ts";
import { HIT_DICE, spellOfSource, weaponItemId } from "./combat/ids.ts";
import { walkSpeed } from "./tactics.ts";
import { schoolOf } from "./combat/school.ts";

// What a save is against, for a passive with `from` (SaveFromSchema): the creature behind it and the spell's school.
export interface SaveSource {
  readonly creatureType: string | undefined;
  readonly school: string | null;
  readonly breath: boolean;
}

// The source of a save that this creature's action calls for.
export function saveSourceOf(
  caster: Actor,
  actionId: string,
  name: string,
  access: ContentAccess,
): SaveSource {
  return {
    creatureType: deriveStats(caster, access).creatureType,
    school: schoolOf(actionId, access),
    breath: /breath/i.test(name),
  };
}

// Whether a save's source is what a passive's `from` asks for: a spell of its schools, or a creature of its types
// (by its breath weapon, with `breath`). A passive without `from` takes any save.
function fromMatches(
  from: SaveFrom | undefined,
  source: SaveSource | undefined,
): boolean {
  if (!from) return true;
  if (!source) return false;
  return (
    (source.school !== null &&
      (from.schools ?? []).some((school) => school === source.school)) ||
    (source.creatureType !== undefined &&
      (from.creatureTypes ?? []).includes(source.creatureType) &&
      (!from.breath || source.breath))
  );
}

// Whether a save-limited passive covers this save: its abilities or conditions, or with `from` and neither, any save
// against that source.
function coversSave(
  passive: {
    readonly abilities: readonly Ability[];
    readonly conditions: readonly string[];
    readonly from?: SaveFrom | undefined;
  },
  ability: Ability,
  conditions: readonly string[],
  source: SaveSource | undefined,
): boolean {
  const any = passive.abilities.length === 0 && passive.conditions.length === 0;
  return (
    ((any && passive.from !== undefined) ||
      passive.abilities.includes(ability) ||
      passive.conditions.some((condition) => conditions.includes(condition))) &&
    fromMatches(passive.from, source)
  );
}

// Species traits and feats that change rolls combat makes, kept out of combat.ts behind one call each.

// Whether the creature has a Shield equipped, as Shield Master needs.
export function holdsShield(
  actor: Actor,
  access: Pick<ContentAccess, "content">,
): boolean {
  return equipped(actor).some(
    (id) => ItemSchema.safeParse(access.content(id)).data?.type === "shield",
  );
}

// Shield Master's Interpose Shield: a Dexterity save that halves damage takes none instead, for the Reaction, while
// the creature holds a Shield. The Reaction's event, or null when it can't.
export function interposedShield(
  target: Actor,
  stats: Stats,
  access: Pick<ContentAccess, "content">,
): SystemEvent | null {
  return stats.passives.some((passive) => passive.kind === "interposeShield") &&
    target.budget.reaction &&
    !hasCondition(target, ...INCAPACITATING) &&
    holdsShield(target, access)
    ? dndEvent(`${NS}:budgetSpent`, {
        actor: target.id,
        kind: "reaction",
        label: "Interpose Shield",
      })
    : null;
}

// Advantage on a save from a trait, such as Gnomish Cunning, or Brave against a save that would frighten.
export function traitSaveAdvantage(
  stats: Stats,
  ability: Ability,
  conditions: readonly string[],
  bloodied = false,
  target?: Actor, // for a passive that holds `while` it has a condition
  source?: SaveSource,
): boolean {
  // A save to keep Concentration names "concentration" among its conditions.
  return stats.passives.some(
    (passive) =>
      (passive.kind === "saveAdvantage" &&
        (!passive.bloodied || bloodied) &&
        (!passive.while ||
          (target !== undefined && hasCondition(target, passive.while))) &&
        coversSave(passive, ability, conditions, source)) ||
      (passive.kind === "concentrationAdvantage" &&
        conditions.includes("concentration")),
  );
}

// Evasion: a save for half damage the bearer can still dodge, unless it's Incapacitated.
export function evades(
  target: Actor,
  ability: Ability,
  access: ContentAccess,
): boolean {
  return (
    !hasCondition(target, ...INCAPACITATING) &&
    deriveStats(target, access).passives.some(
      (passive) =>
        passive.kind === "evasion" && (passive.anySave || ability === "dex"),
    )
  );
}

// Blood Frenzy, Bloodied Fury and the like: Advantage on attack rolls in a state the trait names.
// Whether a creature is under an effect of the bearer's from one of these spells or features, as Hunter's Mark.
export function markedBy(
  target: Actor,
  bearer: Actor,
  ids: readonly string[],
): boolean {
  return target.activeEffects.some(
    ({ sourceId, casterId }) =>
      casterId === bearer.id &&
      ids.some(
        (id) =>
          sourceId.startsWith(`feature:${id}:`) ||
          spellOfSource(sourceId) === id,
      ),
  );
}

function attackAdvantaged(
  passive: Extract<Passive, { kind: "attackAdvantage" }>,
  stats: Stats,
  attacker: Actor,
  target: Actor,
  targetStats: Stats,
  state: DndState | undefined,
): boolean {
  switch (passive.when) {
    case "bloodied":
      return attacker.hp * 2 <= stats.maxHp;
    case "targetHurt":
      return target.hp < targetStats.maxHp;
    case "targetFrightened":
      return hasCondition(target, "frightened");
    case "targetCharmed":
      return hasCondition(target, "charmed");
    case "marked":
      return (
        passive.against !== undefined &&
        markedBy(target, attacker, passive.against)
      );
    case "unacted": {
      // In the first round, a creature yet to act stands later in the order than the one acting now.
      const combat = state?.combat;
      if (!combat || combat.round > 1) return false;
      return combat.order.indexOf(target.id) > combat.index;
    }
  }
}

export function traitAttackAdvantage(
  stats: Stats,
  attacker: Actor,
  target: Actor,
  targetStats: Stats,
  state?: DndState,
): boolean {
  return stats.passives.some(
    (passive) =>
      passive.kind === "attackAdvantage" &&
      attackAdvantaged(passive, stats, attacker, target, targetStats, state),
  );
}

// Great Weapon Fighting: damage dice of a Two-Handed melee weapon attack never count below 3.
// shortcut: a Versatile weapon held in two hands doesn't count, since the hands used aren't tracked.
export function weaponDamageDice(
  dice: Dice,
  actionId: string,
  stats: Stats,
  access: ContentAccess,
): Dice {
  if (!stats.passives.some(({ kind }) => kind === "greatWeaponFighting")) {
    return dice;
  }
  const itemId = weaponItemId(actionId);
  const item =
    itemId && access.content(itemId)
      ? lookup(access, ItemSchema, itemId)
      : null;
  const twoHanded =
    item?.type === "weapon" &&
    item.properties.includes("twoHanded") &&
    !item.properties.includes("ammunition") &&
    !item.properties.includes("thrown");
  return twoHanded
    ? {
        below: (count) => dice.below(count),
        roll: (sides) => Math.max(3, dice.roll(sides)),
      }
    : dice;
}

// Elemental Adept: the damage types a spell of the bearer's ignores Resistance to.
export function masteredTypes(
  stats: Stats,
  spell: boolean,
): readonly DamageType[] {
  return spell
    ? stats.passives.flatMap((passive) =>
        passive.kind === "energyMastery" ? [passive.damage] : [],
      )
    : [];
}

// Resistance the bearer's damage goes through: the mastered types, and any the bearer always overcomes, as with the
// Boon of Irresistible Offense.
export function piercing<
  T extends { readonly resistances: readonly DamageType[] },
>(responses: T, mastered: readonly DamageType[], stats: Stats): T {
  const ignored = [
    ...mastered,
    ...stats.passives.flatMap((passive) =>
      passive.kind === "overcomeResistance" ? passive.damage : [],
    ),
  ];
  return ignored.length === 0
    ? responses
    : {
        ...responses,
        resistances: responses.resistances.filter(
          (type) => !ignored.includes(type),
        ),
      };
}

// Heavy Armor Master: what an attack's damage of a type is lessened by while the target wears the armor.
export function armoredReduction(
  target: Actor,
  stats: Stats,
  type: DamageType,
  access: ContentAccess,
): number {
  const worn = new Set(
    equipped(target).flatMap((id) => {
      const item = ItemSchema.safeParse(access.content(id)).data;
      return item?.type === "armor" ? [item.armorType] : [];
    }),
  );
  return stats.passives.reduce(
    (total, passive) =>
      passive.kind === "armoredReduction" &&
      worn.has(passive.armor) &&
      passive.damage.includes(type)
        ? total + evaluateFormula(passive.amount, stats)
        : total,
    0,
  );
}

// Sharpshooter, Spell Sniper and Crossbow Expert: whether a ranged attack ignores an enemy beside the attacker, and
// whether it ignores Half and Three-Quarters Cover.
export function steadyShot(
  stats: Stats,
  actionId: string,
  attack: "weapon" | "spell",
): { readonly inMelee: boolean; readonly bypassCover: boolean } {
  const fits = stats.passives.flatMap((passive) =>
    passive.kind === "firingInMelee" &&
    passive.attack === attack &&
    (!passive.crossbows || actionId.includes("crossbow"))
      ? [passive]
      : [],
  );
  return {
    inMelee: fits.length > 0,
    bypassCover: fits.some((passive) => passive.bypassCover),
  };
}

// A 1 on a damage die of a mastered type counts as a 2.
export function masteredDice(
  dice: Dice,
  type: DamageType,
  mastered: readonly DamageType[],
  rerolled: readonly DamageType[] = [],
): Dice {
  // Flames of Phlegethos: a 1 on a die of its type is rolled again, and the new roll stands.
  const once: Dice = rerolled.includes(type)
    ? {
        below: (count) => dice.below(count),
        roll: (sides) => {
          const value = dice.roll(sides);
          return value === 1 ? dice.roll(sides) : value;
        },
      }
    : dice;
  return mastered.includes(type)
    ? {
        below: (count) => once.below(count),
        roll: (sides) => Math.max(2, once.roll(sides)),
      }
    : once;
}

// The damage types whose 1s the bearer's spells roll again, as with Flames of Phlegethos.
export function rerolledTypes(
  stats: Stats,
  spell: boolean,
): readonly DamageType[] {
  return spell
    ? stats.passives.flatMap((passive) =>
        passive.kind === "spellRerollOnes" ? [passive.damage] : [],
      )
    : [];
}

// The conditions a repeated save would end, so that a trait such as Fey Ancestry gives its Advantage there as well.
export function repeatSaveConditions(actor: Actor, sourceId: string): string[] {
  return actor.activeEffects.flatMap((effect) =>
    effect.sourceId === sourceId && effect.modifier.kind === "condition"
      ? [effect.modifier.condition]
      : [],
  );
}

// A failed save turned into a success by a trait, as Mage Slayer's Guarded Mind or Survivor's Steel Yourself do:
// the events that pay for it, or none when nothing rescues it. `rolled` holds the save's own events, for its total.
// `pending` holds the events not yet applied, so two saves in one step can't spend the same use.
export function rescuedSave(
  target: Actor,
  ability: Ability,
  conditions: readonly string[],
  stats: Stats,
  rolled: readonly SystemEvent[],
  pending: readonly SystemEvent[],
  dice?: Dice, // for a rescue that rolls, as Spell Resistant's 1d6
  magical = false, // the save is against a spell
  more: {
    readonly source?: SaveSource; // what the save is against, for a rescue with `from`
    readonly access?: ContentAccess; // for a rescue with Hit Point Dice, to know their size
  } = {},
): SystemEvent[] {
  const roll = rolled.findLast((event) => event.kind === `${NS}:saveRolled`);
  const { total, dc } =
    roll && "payload" in roll
      ? (roll.payload as { total: number; dc: number })
      : { total: 0, dc: Infinity };
  const spentNow = (kind: string, resource?: string): number =>
    pending.filter(
      (event) =>
        event.kind === `${NS}:${kind}` &&
        "payload" in event &&
        event.payload.actor === target.id &&
        (resource === undefined || event.payload.resource === resource),
    ).length;
  for (const passive of stats.passives) {
    const die =
      passive.kind === "saveRescue" && passive.bonusDice
        ? (scaledDice(
            { dice: passive.bonusDice, dieSize: passive.dieSize },
            stats.scaling,
          ) ?? passive.bonusDice)
        : undefined;
    if (
      passive.kind !== "saveRescue" ||
      // A save to keep Concentration is rescued only by what names it, as a Ring of Dedicated Focus.
      (conditions.includes("concentration") && !passive.concentration) ||
      !coversSave(
        passive.concentration
          ? { ...passive, conditions: [...passive.conditions, "concentration"] }
          : passive,
        ability,
        conditions,
        more.source,
      ) ||
      (passive.bonus && total + evaluateFormula(passive.bonus, stats) < dc) ||
      (passive.magical && !magical) ||
      (die &&
        (!dice ||
          total + rollDiceNotation(die, HIGHEST) < dc ||
          total + rollDiceNotation(die, dice) < dc)) ||
      (passive.reaction &&
        (!target.budget.reaction ||
          hasCondition(target, ...INCAPACITATING) ||
          spentNow("budgetSpent") > 0))
    ) {
      continue;
    }
    if (passive.hitDice) {
      const spending = hitDiceRescue(
        target,
        passive.hitDice,
        dc - total,
        dice,
        more.access,
      );
      if (spending > 0) {
        return [
          dndEvent(`${NS}:resourceSpent`, {
            actor: target.id,
            resource: HIT_DICE,
            ...(spending > 1 ? { amount: spending } : {}),
          }),
        ];
      }
      continue;
    }
    const { resource } = passive;
    const spent =
      (target.resourcesSpent[resource] ?? 0) +
      spentNow("resourceSpent", resource);
    const max = stats.resources[resource] ?? 0;
    if (spent < max) {
      // A Scarab of Protection crumbles once its last charge is spent.
      const gone =
        passive.item !== undefined && spent + 1 >= max
          ? [
              dndEvent(`${NS}:itemUsed`, {
                actor: target.id,
                item: passive.item,
              }),
              dndEvent(`${NS}:resourceRestored`, {
                actor: target.id,
                resource,
              }),
            ]
          : [];
      return [
        ...(passive.reaction
          ? [
              dndEvent(`${NS}:budgetSpent`, {
                actor: target.id,
                kind: "reaction",
              }),
            ]
          : []),
        dndEvent(`${NS}:resourceSpent`, { actor: target.id, resource }),
        ...gone,
      ];
    }
  }
  return [];
}

// A Ring of Dedicated Focus: how many of the bearer's Hit Point Dice, rolled one at a time, make up the `short` a
// failed save fell short by, at most `most`; 0 when they don't. shortcut: the dice are kept when they fall short, and
// each is the size of its next unspent die.
function hitDiceRescue(
  target: Actor,
  most: number,
  short: number,
  dice: Dice | undefined,
  access: ContentAccess | undefined,
): number {
  const die = access ? nextHitDie(target, access) : null;
  const left =
    target.source.kind === "character"
      ? (target.source.build?.levels.length ?? 0) -
        (target.resourcesSpent[HIT_DICE] ?? 0)
      : 0;
  const count = Math.min(most, left);
  if (!die || !dice || count * Number(die.slice(1)) < short) return 0;
  let rolled = 0;
  for (let used = 1; used <= count; used += 1) {
    rolled += dice.roll(Number(die.slice(1)));
    if (rolled >= short) return used;
  }
  return 0;
}

// Knowledge from a Past Life or Tactical Mind: a failed check gets a die added when its highest could be enough.
export function rescuedCheck(
  actor: Actor,
  stats: Stats,
  total: number,
  dc: number,
  dice: Dice,
  skill?: Skill,
): { readonly bonus: number; readonly events: SystemEvent[] } {
  if (total >= dc) return { bonus: 0, events: [] };
  for (const passive of stats.passives) {
    if (passive.kind !== "checkRescue") continue;
    const die =
      scaledDice(
        { dice: passive.bonusDice, dieSize: passive.dieSize },
        stats.scaling,
      ) ?? passive.bonusDice;
    if (
      (actor.resourcesSpent[passive.resource] ?? 0) >=
        (stats.resources[passive.resource] ?? 0) ||
      (passive.skills &&
        (skill === undefined || !passive.skills.includes(skill))) ||
      total + rollDiceNotation(die, HIGHEST) < dc
    ) {
      continue;
    }
    const bonus = rollDiceNotation(die, dice);
    if (passive.keep && total + bonus < dc) return { bonus, events: [] };
    return {
      bonus,
      events: [
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: passive.resource,
        }),
      ],
    };
  }
  return { bonus: 0, events: [] };
}

// Reliable Talent or Glibness: the least a check's d20 roll counts as.
export function checkFloor(
  actor: Actor,
  stats: Stats,
  ability: Ability,
  skill?: Skill,
): number {
  const proficient = skill !== undefined && stats.skills.includes(skill);
  return Math.max(
    1,
    ...[
      ...actor.activeEffects.map(({ modifier }) => modifier),
      ...passiveModifiers(stats.passives),
    ].flatMap((modifier) =>
      modifier.kind === "checkFloor" &&
      (!modifier.ability || modifier.ability === ability) &&
      (!modifier.skills ||
        (skill !== undefined && modifier.skills.includes(skill))) &&
      (!modifier.proficient || proficient)
        ? [modifier.value]
        : [],
    ),
  );
}

// Powerful Radiance: the first damage roll of its type uses each die's highest number, spending a use.
// shortcut: it's used on the first such roll, rather than one the bearer picks.
export function maximized(
  actor: Actor,
  stats: Stats,
  types: readonly DamageType[],
): { readonly type: DamageType; readonly events: SystemEvent[] } | null {
  for (const passive of stats.passives) {
    if (
      passive.kind === "maxDamageDice" &&
      types.includes(passive.damage) &&
      (actor.resourcesSpent[passive.resource] ?? 0) <
        (stats.resources[passive.resource] ?? 0)
    ) {
      return {
        type: passive.damage,
        events: [
          dndEvent(`${NS}:resourceSpent`, {
            actor: actor.id,
            resource: passive.resource,
          }),
        ],
      };
    }
  }
  return null;
}
export const HIGHEST: Dice = { below: () => 0, roll: (sides) => sides };

// A Hit Point Die rolled to heal, at least a floor or at its highest, as Bloodlust or Boon of Bountiful Health gives.
export function hitDieRoll(die: string, stats: Stats, dice: Dice): number {
  const sides = Number(die.slice(1));
  const rules = stats.passives.flatMap((passive) =>
    passive.kind === "hitDieRolls" ? [passive] : [],
  );
  if (rules.some(({ highest }) => highest)) return sides;
  return Math.max(dice.roll(sides), ...rules.map(({ floor = 1 }) => floor));
}

// What a Hit Point Die spent to heal restores, twice over with a Periapt of Wound Closure.
export function hitDieHealing(amount: number, stats: Stats): number {
  return stats.passives.some(
    (passive) => passive.kind === "hitDieRolls" && passive.double,
  )
    ? amount * 2
    : amount;
}

// The die a character's next unspent Hit Point Die is, in level order as resting spends them, or null for none.
export function nextHitDie(actor: Actor, access: ContentAccess): string | null {
  if (actor.source.kind !== "character") return null;
  const entry = actor.source.build?.levels[actor.resourcesSpent[HIT_DICE] ?? 0];
  return entry ? lookup(access, ClassSchema, entry.classId).hitDie : null;
}

export const WARD_DOWN = "ward-down";

// Diabolic Ward, Incomprehensible Form or a Cloak of Displacement: attacks against the bearer have Disadvantage,
// except after it attacked this round or took damage (until its next turn starts), while it's Incapacitated, or
// while its Speed is 0, as the trait says.
export function warded(target: Actor, stats: Stats): boolean {
  return stats.passives.some(
    (passive) =>
      passive.kind === "ward" &&
      !(
        passive.suppressed !== "incapacitated" &&
        target.usedThisTurn.includes(WARD_DOWN)
      ) &&
      !(
        passive.suppressed === "damaged" &&
        (walkSpeed(target, stats) === 0 ||
          hasCondition(target, "grappled", "restrained", ...INCAPACITATING))
      ) &&
      !(
        passive.suppressed === "incapacitated" &&
        hasCondition(target, ...INCAPACITATING)
      ),
  );
}
