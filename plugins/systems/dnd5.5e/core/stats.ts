import type { ContentAccess, Dice } from "#sdk";
import type { z } from "zod";
import { type Actor, equipped, hasCondition } from "./state.ts";
import {
  DAMAGE_TYPES,
  ABILITIES,
  type Ability,
  type AbilityScores,
  type Activation,
  type Amount,
  ArmorSchema,
  BackgroundSchema,
  ClassSchema,
  type Damage,
  type DamageType,
  FeatSchema,
  type Feature,
  FeatureSchema,
  type Formula,
  type LeafEffect,
  ItemSchema,
  MonsterSchema,
  type Modifier,
  type Monster,
  type Passive,
  type Resolution,
  type ScaleStep,
  type Skill,
  SpeciesSchema,
  SubclassSchema,
  type Subclass,
  type CharacterBuild,
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
  readonly upcast?: Spell["upcast"];
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
  // For a monster with a printed Multiattack: the attacks each chosen action makes.
  readonly routines: Readonly<Record<string, readonly string[]>> | null;
  readonly creatureType: string | undefined; // lowercase
  readonly initiative: number;
  readonly scaling: Readonly<Record<string, number>>;
  readonly features: readonly string[];
  readonly resourceDefs: Feature["resources"];
  readonly pactMagic: boolean; // slots come back on a Short Rest
}

export function passiveModifiers(
  passives: readonly Passive[],
): readonly Modifier[] {
  return passives.flatMap((passive) =>
    passive.kind === "modifier" ? [passive.modifier] : [],
  );
}

function bestAc(
  actor: Actor,
  abilities: AbilityScores,
  context: {
    armorBases: readonly number[];
    flatBonus: number;
    passives: readonly Passive[];
  },
): number {
  const dex = abilityModifier(abilities.dex);
  // Only one way of calculating AC applies at a time, so the best one is used.
  const bases = [10 + dex, ...context.armorBases];
  const fixed = passiveModifiers(context.passives);
  // shortcut: Mage Armor's and Unarmored Defense's rule about not wearing armor isn't checked, since the best calculation wins anyway.
  for (const modifier of [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...fixed,
  ]) {
    if (modifier.kind !== "acFormula") continue;
    const { base, add } = modifier.formula;
    bases.push(
      add.reduce(
        (total, term) =>
          term.kind === "abilityMod"
            ? total + abilityModifier(abilities[term.ability])
            : total,
        base,
      ),
    );
  }
  let bonus = fixed.reduce(
    (total, modifier) =>
      modifier.kind === "bonus" && modifier.to === "ac"
        ? total + (modifier.amount.bonus?.base ?? 0)
        : total,
    context.flatBonus,
  );
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
            ...(weapon.damage.dice ? { dice: weapon.damage.dice } : {}),
            bonus: {
              base: weapon.damage.flat ?? 0,
              add: [{ kind: "abilityMod", ability }],
            },
          },
          type: weapon.damage.type,
        },
      ],
      onHit: [],
      onMiss: [],
    },
  };
}

// Ability scores after every increase, never above 20.
export function buildAbilities(build: CharacterBuild): AbilityScores {
  const abilities = { ...build.baseAbilities };
  const increases = [
    build.backgroundIncrease,
    ...build.levels.flatMap((entry) =>
      entry.answers.flatMap((answer) =>
        answer.kind === "abilities" ? [answer.increases] : [],
      ),
    ),
  ];
  for (const increase of increases) {
    for (const ability of ABILITIES) {
      abilities[ability] = Math.min(
        20,
        abilities[ability] + (increase[ability] ?? 0),
      );
    }
  }
  return abilities;
}

// Imported features are only text, so the attacks a character gets are read from the feature's name.
function passiveAttacks(passives: readonly Passive[]): readonly number[] {
  return passives.flatMap((passive) =>
    passive.kind === "multiattack" ? [passive.attacks] : [],
  );
}

function attacksFrom(featureId: string): number {
  if (featureId.endsWith("three-extra-attacks")) return 4;
  if (featureId.endsWith("two-extra-attacks")) return 3;
  return featureId.endsWith("extra-attack") ? 2 : 1;
}

function characterStats(actor: Actor, access: ContentAccess): Stats {
  if (actor.source.kind !== "character" || !actor.source.build) {
    throw new Error(`${actor.id} has no character build`);
  }
  const { build } = actor.source;
  const background = lookup(access, BackgroundSchema, build.backgroundId);
  const species = lookup(access, SpeciesSchema, build.speciesId);

  const abilities = buildAbilities(build);

  const level = build.levels.length;
  const classLevels: Record<string, number> = {};
  const skills = new Set<Skill>(background.skills);
  const knownSpells = new Set<string>();
  const featureIds = new Set<string>(species.traits);
  const feat = lookup(access, FeatSchema, background.feat);
  for (const id of feat.grants) featureIds.add(id);
  let scaling: Record<string, number> = {};
  let slots: readonly number[] = [];
  let subclass: Subclass | null = null;

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
      } else if (answer.kind === "feats") {
        for (const id of answer.values) {
          for (const grant of lookup(access, FeatSchema, id).grants) {
            featureIds.add(grant);
          }
        }
      } else if (answer.kind === "subclass") {
        const [id = ""] = answer.values;
        subclass = lookup(access, SubclassSchema, id);
      }
    }
    const subclassLevel: Subclass["levels"][number] | undefined =
      subclass?.levels.find((item) => item.level === classLevel);
    for (const id of subclassLevel?.grants ?? []) featureIds.add(id);
    scaling = { ...scaling, ...subclassLevel?.scaling };
    if (subclassLevel?.slots.length) slots = subclassLevel.slots;
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
  const attuned = actor.attuned ?? [];
  // One action per kind of item, so a second dagger or potion doesn't list twice.
  for (const itemId of new Set(equipped(actor))) {
    const item = lookup(access, ItemSchema, itemId);
    const usable = itemAction(itemId, item, access, firstClass.spellcasting);
    if (usable) actions.push(usable);
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
    } else if (
      item.type === "magicItem" &&
      (!item.attunement || attuned.includes(itemId))
    ) {
      // shortcut: only AC bonuses apply, not saving throw or weapon bonuses, nor a variant's own numbers.
      for (const bonus of item.bonuses ?? []) {
        if (bonus.to === "ac") flatBonus += bonus.amount;
      }
    }
  }

  const fromFeatures = collectFeatureData(access, [...featureIds]);
  actions.push(...fromFeatures.actions);

  for (const spellId of knownSpells) {
    const spell: Spell = lookup(access, SpellSchema, spellId);
    if (spell.activation && doesSomething(spell.activation.resolution)) {
      actions.push({
        id: `spell:${spellId}`,
        name: spell.name,
        activation:
          spell.level === 0 && spell.cantrip
            ? scaleActivation(
                spell.activation,
                spell.cantrip.perTier,
                cantripTier(level),
              )
            : spell.activation,
        spellLevel: spell.level,
        upcast: spell.upcast,
      });
    }
  }

  const partial: Stats = {
    abilities,
    proficiency: proficiencyBonus(level),
    level,
    classLevels,
    maxHp,
    ac: bestAc(actor, abilities, {
      armorBases,
      flatBonus,
      passives: fromFeatures.passives,
    }),
    speed: species.speed,
    savingThrows: firstClass.savingThrows,
    skills: [...skills],
    spellAbility: firstClass.spellcasting?.ability ?? null,
    slots,
    resources: {},
    passives: fromFeatures.passives.map((passive) =>
      passive.kind === "extraDamage"
        ? { ...passive, dice: scaledDice(passive, scaling) ?? passive.dice }
        : passive,
    ),
    actions,
    multiattack: Math.max(
      ...[...featureIds].map(attacksFrom),
      ...passiveAttacks(fromFeatures.passives),
      1,
    ),
    routines: null,
    creatureType: species.creatureType.toLowerCase(),
    initiative: abilityModifier(abilities.dex),
    scaling,
    features: [...featureIds],
    resourceDefs: fromFeatures.resources,
    pactMagic: [...featureIds].some((id) => id.endsWith("pact-magic")),
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

// A potion to drink or a scroll to read, used up once used. Their action ids start "item:", which spends the item.
function itemAction(
  itemId: string,
  item: z.infer<typeof ItemSchema>,
  access: ContentAccess,
  spellcasting: unknown,
): KnownAction | null {
  if ((item.type === "gear" || item.type === "magicItem") && item.healing) {
    return {
      id: `item:${itemId}`,
      name: `Drink ${item.name}`,
      activation: {
        cost: ["bonusAction"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [{ kind: "heal", amount: item.healing }],
        },
      },
      spellLevel: null,
    };
  }
  // shortcut: any spellcaster can read any scroll, with their own spellcasting numbers rather than the scroll's.
  if (item.type !== "magicItem" || !item.spell || !spellcasting) return null;
  const spell = lookup(access, SpellSchema, item.spell);
  if (!spell.activation || !doesSomething(spell.activation.resolution)) {
    return null;
  }
  return {
    id: `item:${itemId}`,
    name: `Read ${item.name}`,
    activation: {
      ...spell.activation,
      cost: spell.activation.cost.filter((cost) => cost !== "slot"),
    },
    spellLevel: spell.level,
  };
}

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
  return Object.fromEntries(
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
      passives: [...monster.passives, ...fromFeatures.passives],
    }),
    speed: monster.speed,
    savingThrows: monster.saves,
    skills: [],
    spellAbility: null,
    slots: [],
    resources: Object.fromEntries(
      monster.actions.flatMap((action) =>
        action.activation.cost.flatMap((cost) =>
          typeof cost === "object" ? [[cost.resource, 1]] : [],
        ),
      ),
    ),
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
    multiattack: Math.max(
      monster.multiattack,
      ...passiveAttacks([...monster.passives, ...fromFeatures.passives]),
    ),
    routines: multiattackRoutines(monster),
    creatureType: monster.creatureType?.toLowerCase(),
    initiative: monster.initiative,
    scaling: {},
    features: monster.features,
    resourceDefs: fromFeatures.resources,
    pactMagic: false,
  };
}

// Calculated on demand and never stored, so stats can't drift out of step with choices or gear.
// Forced movement needs the grid, and Deafened and Grappled have no effect without positions or hearing rules,
// so a spell that only does those would waste a slot. Drop this filter when the grid arrives.
export function doesSomething(resolution: Resolution): boolean {
  if ("damage" in resolution && resolution.damage.length > 0) return true;
  const effects =
    resolution.kind === "automatic"
      ? resolution.effects
      : resolution.kind === "attack"
        ? [...resolution.onHit, ...resolution.onMiss]
        : [...resolution.onFail, ...resolution.onSuccess];
  return effects.some(
    (effect) =>
      effect.kind === "heal" ||
      effect.kind === "tempHp" ||
      effect.kind === "modifier" ||
      effect.kind === "removeCondition" ||
      effect.kind === "extraAction" ||
      effect.kind === "reduceDamage" ||
      (effect.kind === "applyCondition" &&
        effect.condition !== "deafened" &&
        effect.condition !== "grappled"),
  );
}

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

// The flat parts of a roll's bonus, shared by the rolls and the character sheet.
export function attackBonus(
  resolution: Extract<Resolution, { kind: "attack" }>,
  stats: Stats,
): number {
  const { attack } = resolution;
  if (attack.flatBonus !== undefined) return attack.flatBonus;
  const ability = attack.type === "spell" ? stats.spellAbility : attack.ability;
  return stats.proficiency + (ability ? modifierFor(stats, ability) : 0);
}

export function saveBonus(stats: Stats, ability: Ability): number {
  return (
    modifierFor(stats, ability) +
    (stats.savingThrows.includes(ability) ? stats.proficiency : 0)
  );
}

export function checkBonus(
  stats: Stats,
  actor: Actor,
  check: { readonly ability: Ability; readonly skill?: Skill },
): number {
  const proficient =
    check.skill !== undefined && stats.skills.includes(check.skill);
  return (
    modifierFor(stats, check.ability) +
    (proficient ? stats.proficiency : 0) -
    2 * actor.exhaustion
  );
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

// A scaling key can replace the number of dice (sneakAttackD6) or the die size (martialArtsDie).
export function scaledDice(
  source: {
    readonly dice?: string | undefined;
    readonly diceCount?: string | undefined;
    readonly dieSize?: string | undefined;
  },
  scaling: Readonly<Record<string, number>>,
): string | undefined {
  if (!source.dice) return undefined;
  const [count = "0", sides = "0"] = source.dice.split("d");
  return `${String(scaling[source.diceCount ?? ""] ?? count)}d${String(scaling[source.dieSize ?? ""] ?? sides)}`;
}

function cantripTier(level: number): number {
  return level >= 17 ? 3 : level >= 11 ? 2 : level >= 5 ? 1 : 0;
}

// Adds dice to every amount that uses the same die, which covers "both types of damage" and leaves
// Ice Storm's d6 cold alone when only its d10 bludgeoning scales.
function addDice(amount: Amount, add: string, times: number): Amount {
  const [addCount = "0", addSides] = add.split("d");
  const [count = "0", sides] = (amount.dice ?? "").split("d");
  return sides === addSides
    ? {
        ...amount,
        dice: `${String(Number(count) + Number(addCount) * times)}d${sides ?? ""}`,
      }
    : amount;
}

export function scaleActivation(
  activation: Activation,
  step: ScaleStep,
  times: number,
): Activation {
  if (times <= 0) return activation;
  if ("addTargets" in step) {
    const more = step.addTargets * times;
    const { projectiles, targeting } = activation;
    if (projectiles !== undefined) {
      return { ...activation, projectiles: projectiles + more };
    }
    return "creatures" in targeting
      ? {
          ...activation,
          targeting: { ...targeting, creatures: targeting.creatures + more },
        }
      : activation;
  }
  const damage = (list: readonly Damage[]): Damage[] =>
    list.map((item) => ({
      ...item,
      amount: addDice(item.amount, step.addDice, times),
    }));
  const effects = (list: readonly LeafEffect[]): LeafEffect[] =>
    list.map((effect) => {
      if (effect.kind === "heal" || effect.kind === "tempHp") {
        return {
          ...effect,
          amount: addDice(effect.amount, step.addDice, times),
        };
      }
      return effect.kind === "modifier" &&
        effect.modifier.kind === "lingeringDamage"
        ? {
            ...effect,
            modifier: {
              ...effect.modifier,
              damage: damage(effect.modifier.damage),
            },
          }
        : effect;
    });
  const { resolution } = activation;
  switch (resolution.kind) {
    case "automatic":
      return {
        ...activation,
        resolution: {
          ...resolution,
          damage: damage(resolution.damage),
          effects: effects(resolution.effects),
        },
      };
    case "attack":
      return {
        ...activation,
        resolution: {
          ...resolution,
          damage: damage(resolution.damage),
          onHit: effects(resolution.onHit),
          onMiss: effects(resolution.onMiss),
        },
      };
    case "save":
      return {
        ...activation,
        resolution: {
          ...resolution,
          damage: damage(resolution.damage),
          onFail: effects(resolution.onFail),
          onSuccess: effects(resolution.onSuccess),
        },
      };
    default:
      return resolution satisfies never;
  }
}

export function rollAmount(
  amount: Amount,
  stats: Stats,
  dice: Dice,
  diceMultiplier = 1,
): number {
  const notation = scaledDice(amount, stats.scaling);
  const rolled = notation
    ? rollDiceNotation(notation, dice, diceMultiplier)
    : 0;
  return rolled + (amount.bonus ? evaluateFormula(amount.bonus, stats) : 0);
}

export function damageResponses(
  actor: Actor,
  access: ContentAccess,
): {
  readonly adjustments: readonly number[];
  readonly resistances: readonly DamageType[];
  readonly vulnerabilities: readonly DamageType[];
  readonly immunities: readonly DamageType[];
} {
  const resistances: DamageType[] = [];
  const vulnerabilities: DamageType[] = [];
  const immunities: DamageType[] = [];
  // Petrified gives Resistance to all damage.
  if (hasCondition(actor, "petrified")) resistances.push(...DAMAGE_TYPES);
  for (const modifier of [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(deriveStats(actor, access).passives),
  ]) {
    if (modifier.kind === "resistance") resistances.push(modifier.damage);
    if (modifier.kind === "vulnerability")
      vulnerabilities.push(modifier.damage);
    if (modifier.kind === "immunity") immunities.push(modifier.damage);
  }
  return { adjustments: [], resistances, vulnerabilities, immunities };
}
