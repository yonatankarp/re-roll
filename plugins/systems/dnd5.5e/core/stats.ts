import type { ContentAccess, Dice } from "#sdk";
import type { z } from "zod";
import type { Actor } from "./state.ts";
import {
  ABILITIES,
  type Ability,
  type AbilityScores,
  type Activation,
  type Amount,
  ArmorSchema,
  BackgroundSchema,
  ClassSchema,
  type DamageType,
  FeatSchema,
  type Feature,
  FeatureSchema,
  type Formula,
  ItemSchema,
  MonsterSchema,
  type Passive,
  type Skill,
  SpeciesSchema,
  type Spell,
  SpellSchema,
  WeaponSchema,
  type Weapon,
} from "./schemas.ts";

export function lookup<T>(
  access: Pick<ContentAccess, "content">,
  schema: z.ZodType<T>,
  id: string,
): T {
  const entry = access.content(id);
  if (!entry) throw new Error(`Unknown content ${id}`);
  return schema.parse(entry);
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((level - 1) / 4);
}

export interface KnownAction {
  readonly id: string;
  readonly name: string;
  readonly activation: Activation;
  readonly spellLevel: number | null;
}

export interface Stats {
  readonly abilities: AbilityScores;
  readonly proficiency: number;
  readonly level: number;
  readonly classLevels: Readonly<Record<string, number>>;
  readonly maxHp: number;
  readonly ac: number;
  readonly speed: number;
  readonly savingThrows: readonly Ability[];
  readonly skills: readonly Skill[];
  readonly spellAbility: Ability | null;
  readonly slots: readonly number[];
  readonly resources: Readonly<Record<string, number>>;
  readonly passives: readonly Passive[];
  readonly actions: readonly KnownAction[];
  readonly multiattack: number;
  readonly initiative: number;
  readonly scaling: Readonly<Record<string, number>>;
}

function bestAc(
  actor: Actor,
  abilities: AbilityScores,
  context: { armorBases: readonly number[]; flatBonus: number },
): number {
  const dex = abilityModifier(abilities.dex);
  // Only one way of calculating AC applies at a time, so the best one is used.
  const bases = [10 + dex, ...context.armorBases];
  let bonus = context.flatBonus;
  const seen = new Set<string>();
  for (const effect of actor.activeEffects) {
    const { modifier } = effect;
    if (modifier.kind === "bonus" && modifier.to === "ac") {
      if (!seen.has(effect.sourceId)) bonus += modifier.amount.bonus?.base ?? 0;
      seen.add(effect.sourceId);
    }
  }
  return Math.max(...bases) + bonus;
}

function collectFeatureData(
  access: ContentAccess,
  featureIds: readonly string[],
): {
  passives: Passive[];
  actions: KnownAction[];
  resources: Feature["resources"];
} {
  const passives: Passive[] = [];
  const actions: KnownAction[] = [];
  const resources: Feature["resources"] = [];
  for (const id of featureIds) {
    const feature = lookup(access, FeatureSchema, id);
    passives.push(...feature.passives);
    resources.push(...feature.resources);
    feature.activations.forEach((activation, index) => {
      actions.push({
        id: `feature:${id}:${String(index)}`,
        name: feature.name,
        activation,
        spellLevel: null,
      });
    });
  }
  return { passives, actions, resources };
}

export function weaponActivation(
  weapon: Weapon,
  abilities: AbilityScores,
): Activation {
  const ranged = weapon.properties.includes("ammunition");
  const finesse = weapon.properties.includes("finesse");
  const ability: Ability =
    ranged ||
    (finesse && abilityModifier(abilities.dex) > abilityModifier(abilities.str))
      ? "dex"
      : "str";
  return {
    cost: ["action"],
    targeting: { creatures: 1, range: ranged ? 80 : 5, side: "enemy" },
    resolution: {
      kind: "attack",
      attack: { type: "weapon", ability },
      damage: [
        {
          amount: {
            dice: weapon.damage.dice,
            bonus: { base: 0, add: [{ kind: "abilityMod", ability }] },
          },
          type: weapon.damage.type,
        },
      ],
      onHit: [],
      onMiss: [],
    },
  };
}

function characterStats(actor: Actor, access: ContentAccess): Stats {
  if (actor.source.kind !== "character" || !actor.source.build) {
    throw new Error(`${actor.id} has no character build`);
  }
  const { build } = actor.source;
  const background = lookup(access, BackgroundSchema, build.backgroundId);
  const species = lookup(access, SpeciesSchema, build.speciesId);

  const abilities = { ...build.baseAbilities };
  for (const ability of ABILITIES) {
    abilities[ability] = Math.min(
      20,
      abilities[ability] + (build.backgroundIncrease[ability] ?? 0),
    );
  }

  const level = build.levels.length;
  const classLevels: Record<string, number> = {};
  const skills = new Set<Skill>(background.skills);
  const knownSpells = new Set<string>();
  const featureIds = new Set<string>(species.traits);
  const feat = lookup(access, FeatSchema, background.feat);
  for (const id of feat.grants) featureIds.add(id);
  let scaling: Record<string, number> = {};
  let slots: readonly number[] = [];

  // shortcut: spell slots come from the last class level, so multiclass slot tables need adding with multiclassing.
  for (const entry of build.levels) {
    const classLevel = (classLevels[entry.classId] ?? 0) + 1;
    classLevels[entry.classId] = classLevel;
    const definition = lookup(access, ClassSchema, entry.classId);
    const levelData = definition.levels.find(
      (item) => item.level === classLevel,
    );
    if (!levelData) {
      throw new Error(`${entry.classId} has no level ${String(classLevel)}`);
    }
    for (const id of levelData.grants) featureIds.add(id);
    scaling = { ...scaling, ...levelData.scaling };
    if (levelData.slots.length > 0) slots = levelData.slots;
    for (const answer of entry.answers) {
      if (answer.kind === "skills") {
        for (const skill of answer.values) skills.add(skill);
      } else if (answer.kind === "spells") {
        for (const spell of answer.values) knownSpells.add(spell);
      } else if (answer.kind === "features") {
        for (const id of answer.values) featureIds.add(id);
      }
    }
  }

  const [firstLevel] = build.levels;
  if (!firstLevel) throw new Error(`${actor.id} has no levels`);
  const firstClass = lookup(access, ClassSchema, firstLevel.classId);
  const con = abilityModifier(abilities.con);
  const maxHp = build.levels.reduce(
    (sum, entry) => sum + entry.hitPointGain + con,
    0,
  );

  const armorBases: number[] = [];
  let flatBonus = 0;
  const actions: KnownAction[] = [];
  for (const itemId of actor.inventory) {
    const item = lookup(access, ItemSchema, itemId);
    if (item.type === "armor") {
      const parsed = ArmorSchema.parse(item);
      const dex = abilityModifier(abilities.dex);
      const allowed = parsed.addDex ? Math.min(dex, parsed.maxDex ?? dex) : 0;
      armorBases.push(parsed.base + allowed);
    } else if (item.type === "shield") {
      flatBonus += item.bonus;
    } else if (item.type === "weapon") {
      actions.push({
        id: `weapon:${itemId}`,
        name: item.name,
        activation: weaponActivation(WeaponSchema.parse(item), abilities),
        spellLevel: null,
      });
    }
  }

  const fromFeatures = collectFeatureData(access, [...featureIds]);
  actions.push(...fromFeatures.actions);

  for (const spellId of knownSpells) {
    const spell: Spell = lookup(access, SpellSchema, spellId);
    if (spell.activation) {
      actions.push({
        id: `spell:${spellId}`,
        name: spell.name,
        activation: spell.activation,
        spellLevel: spell.level,
      });
    }
  }

  const partial: Stats = {
    abilities,
    proficiency: proficiencyBonus(level),
    level,
    classLevels,
    maxHp,
    ac: bestAc(actor, abilities, { armorBases, flatBonus }),
    speed: species.speed,
    savingThrows: firstClass.savingThrows,
    skills: [...skills],
    spellAbility: firstClass.spellcasting?.ability ?? null,
    slots,
    resources: {},
    passives: fromFeatures.passives,
    actions,
    multiattack: 1,
    initiative: abilityModifier(abilities.dex),
    scaling,
  };
  return {
    ...partial,
    resources: Object.fromEntries(
      fromFeatures.resources.map((resource) => [
        resource.id,
        evaluateFormula(resource.max, partial),
      ]),
    ),
  };
}

function monsterStats(actor: Actor, access: ContentAccess): Stats {
  if (actor.source.kind !== "monster") {
    throw new Error(`${actor.id} is not a monster`);
  }
  const monster = lookup(access, MonsterSchema, actor.source.statBlockId);
  const fromFeatures = collectFeatureData(access, monster.features);
  return {
    abilities: monster.abilities,
    proficiency: monster.proficiency,
    level: 0,
    classLevels: {},
    maxHp: monster.hp,
    ac: bestAc(actor, monster.abilities, {
      armorBases: [monster.ac],
      flatBonus: 0,
    }),
    speed: monster.speed,
    savingThrows: monster.saves,
    skills: [],
    spellAbility: null,
    slots: [],
    resources: {},
    passives: [...monster.passives, ...fromFeatures.passives],
    actions: [
      ...monster.actions.map((action, index) => ({
        id: `monster:${String(index)}`,
        name: action.name,
        activation: action.activation,
        spellLevel: null,
      })),
      ...fromFeatures.actions,
    ],
    multiattack: monster.multiattack,
    initiative: monster.initiative,
    scaling: {},
  };
}

// Calculated on demand and never stored, so stats can't drift out of step with choices or gear.
export function deriveStats(actor: Actor, access: ContentAccess): Stats {
  return actor.source.kind === "monster"
    ? monsterStats(actor, access)
    : characterStats(actor, access);
}

export function modifierFor(stats: Stats, ability: Ability): number {
  return abilityModifier(stats.abilities[ability]);
}

export function spellModifier(stats: Stats): number {
  return stats.spellAbility ? modifierFor(stats, stats.spellAbility) : 0;
}

export function spellSaveDc(stats: Stats): number {
  return 8 + stats.proficiency + spellModifier(stats);
}

export function evaluateFormula(formula: Formula, stats: Stats): number {
  let total = formula.base;
  for (const term of formula.add) {
    switch (term.kind) {
      case "abilityMod":
        total += modifierFor(stats, term.ability);
        break;
      case "proficiency":
        total += stats.proficiency;
        break;
      case "classLevel":
        total += stats.classLevels[term.class] ?? 0;
        break;
      case "scaling":
        total += stats.scaling[term.key] ?? 0;
        break;
      case "spellMod":
        total += spellModifier(stats);
        break;
      case "spellSaveDc":
        total += spellSaveDc(stats);
        break;
      default:
        term satisfies never;
    }
  }
  return formula.min === undefined ? total : Math.max(total, formula.min);
}

export function rollDiceNotation(
  notation: string,
  dice: Dice,
  multiplier = 1,
): number {
  const [count = "0", sides = "0"] = notation.split("d");
  let total = 0;
  for (let index = 0; index < Number(count) * multiplier; index += 1) {
    total += dice.roll(Number(sides));
  }
  return total;
}

export function rollAmount(
  amount: Amount,
  stats: Stats,
  dice: Dice,
  diceMultiplier = 1,
): number {
  const rolled = amount.dice
    ? rollDiceNotation(amount.dice, dice, diceMultiplier)
    : 0;
  return rolled + (amount.bonus ? evaluateFormula(amount.bonus, stats) : 0);
}

export function damageResponses(actor: Actor): {
  readonly adjustments: readonly number[];
  readonly resistances: readonly DamageType[];
  readonly vulnerabilities: readonly DamageType[];
  readonly immunities: readonly DamageType[];
} {
  const resistances: DamageType[] = [];
  const vulnerabilities: DamageType[] = [];
  const immunities: DamageType[] = [];
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "resistance") resistances.push(modifier.damage);
    if (modifier.kind === "vulnerability")
      vulnerabilities.push(modifier.damage);
    if (modifier.kind === "immunity") immunities.push(modifier.damage);
  }
  return { adjustments: [], resistances, vulnerabilities, immunities };
}
