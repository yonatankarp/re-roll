import type { ContentAccess, Dice } from "#sdk";
import type { z } from "zod";
import { carriedWeight, carryingCapacity, encumberedSpeed } from "./carry.ts";
import {
  type Actor,
  type DndState,
  effectiveBuild,
  equipped,
  hasCondition,
} from "./state.ts";
import { lightAt } from "./sight.ts";
import { currentShape, formKept, formOf, usableIn } from "./forms.ts";
import {
  ALL_SKILLS,
  type Item,
  type ItemCast,
  type ResourceDef,
  DAMAGE_TYPES,
  ABILITIES,
  type Ability,
  type AbilityScores,
  type Activation,
  ActivationSchema,
  type FreeCast,
  type Amount,
  type Condition,
  ArmorSchema,
  BackgroundSchema,
  ClassSchema,
  CompanionSchema,
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
  type Species,
  SpeciesSchema,
  SubclassSchema,
  type Subclass,
  type CharacterBuild,
  type ClassDef,
  type Spell,
  SpellSchema,
  WeaponSchema,
  type Weapon,
  type WeaponChange,
} from "./schemas.ts";
import { featureRules, grantedSpells } from "./feature-rules.ts";
import { type Caster, multiclassSlots } from "./multiclass.ts";
import { holdsConcentration, withMetamagic } from "./metamagic.ts";
import { withInvocations } from "./invocations.ts";
import { withWeaponRiders } from "./weapon-riders.ts";
import {
  THROW_PREFIX,
  WEAPON_PREFIX,
  castFrom,
  itemCastId,
  itemUseId,
  spellOfSource,
  weaponItemId,
} from "./combat/ids.ts";
import { zoneModifiers } from "./zones.ts";

// Content is frozen once loaded, so each entry is checked against a schema only once.
const parsed = new WeakMap<object, Map<z.ZodType, unknown>>();

export function lookup<T>(
  access: Pick<ContentAccess, "content">,
  schema: z.ZodType<T>,
  id: string,
): T {
  const entry = access.content(id);
  if (!entry) throw new Error(`Unknown content ${id}`);
  let bySchema = parsed.get(entry);
  if (!bySchema) {
    bySchema = new Map<z.ZodType, unknown>();
    parsed.set(entry, bySchema);
  }
  if (!bySchema.has(schema)) bySchema.set(schema, schema.parse(entry));
  return bySchema.get(schema) as T;
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
  readonly hitType?: true; // its damage takes the type of the hit it adds to, as a maneuver's die does
  readonly rolled?: true; // taken only when a randomAction picks it, as one eye ray
  readonly concentrates?: true; // casting it starts Concentration even with no lasting effect, as Flame Blade
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
  readonly expertise: readonly Skill[]; // skills whose Proficiency Bonus is doubled
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
  // Wearing armor without training: Disadvantage on Strength and Dexterity rolls, and no spellcasting.
  readonly untrainedArmor: boolean;
  readonly exhaustion: number; // each level takes 2 from every d20 test and 5 feet from speed
  readonly ordeal: number; // taken from every d20 test after coming back from the dead, as Raise Dead's
  // A stat block's Speeds besides walking. Others come from effects (core/movement-modes.ts).
  readonly speeds: Readonly<
    Partial<Record<"fly" | "climb" | "burrow", number>>
  >;
  // From magic items worn, and attuned where they need it.
  readonly itemBonuses: Readonly<
    Record<
      "attack" | "spellAttack" | "spellDc" | "savingThrows" | "checks",
      number
    >
  >;
  // A character's familiar, from a spell it knows that gives one (combat/familiar.ts), with the ability it casts
  // that spell with.
  readonly familiar?: { readonly form: string; readonly ability: Ability };
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
      modifier.kind === "bonus" &&
      modifier.to === "ac" &&
      !modifier.melee &&
      !modifier.ranged
        ? total + (modifier.amount.bonus?.base ?? 0)
        : total,
    context.flatBonus,
  );
  const seen = new Set<string>();
  for (const effect of actor.activeEffects) {
    const { modifier } = effect;
    if (
      modifier.kind === "bonus" &&
      modifier.to === "ac" &&
      !modifier.melee &&
      !modifier.ranged
    ) {
      if (!seen.has(effect.sourceId)) bonus += modifier.amount.bonus?.base ?? 0;
      seen.add(effect.sourceId);
    }
  }
  return Math.max(...bases) + bonus;
}

// A magic armor's or Shield's own bonus to AC, which an Antimagic Field, or not being attuned where it needs it,
// suppresses.
function ownAc(
  bonuses: readonly { to: string; amount: number }[] | undefined,
  suppressed: boolean,
): number {
  if (suppressed) return 0;
  return (bonuses ?? [])
    .filter((bonus) => bonus.to === "ac")
    .reduce((total, bonus) => total + bonus.amount, 0);
}

// The character's scores after every increase, including those raised for good, as by a Manual of Bodily Health.
export function ownAbilities(
  actor: Actor,
  build: CharacterBuild,
): AbilityScores {
  const scores = buildAbilities(build);
  for (const ability of ABILITIES) {
    scores[ability] += actor.raised?.[ability] ?? 0;
  }
  return scores;
}

// Scores the items worn set or raise, as Gauntlets of Ogre Power's Strength 19, never lowering one.
// An entry with versions counts as its first, as with its bonuses.
function withItemAbilities(
  scores: AbilityScores,
  items: readonly Extract<z.infer<typeof ItemSchema>, { type: "magicItem" }>[],
): AbilityScores {
  const raised = { ...scores };
  const changes = items.flatMap(
    (item) => item.abilities ?? item.variants?.[0]?.abilities ?? [],
  );
  // Setting comes after raising, so a set score is what the item says, unless the raised one is higher.
  for (const change of changes) {
    if ("raise" in change) {
      raised[change.ability] = Math.max(
        raised[change.ability],
        Math.min(change.max, raised[change.ability] + change.raise),
      );
    }
  }
  for (const change of changes) {
    if ("set" in change) {
      raised[change.ability] = Math.max(raised[change.ability], change.set);
    }
  }
  return raised;
}

// The activation with each Concentration duration made a plain one of these minutes, as War God's Blessing's.
function unconcentrated(activation: Activation, minutes: number): Activation {
  return ActivationSchema.parse(
    JSON.parse(JSON.stringify(activation), (_key, value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      "concentration" in value &&
      "minutes" in value
        ? { minutes }
        : value,
    ),
  );
}

// A leveled spell a feat or feature lets the character cast without a slot, as its own action (FreeCastSchema).
function freeCastActions(
  spells: ReadonlyMap<string, FreeCast>,
  access: ContentAccess,
): { action: KnownAction; resource: Feature["resources"][number] | null }[] {
  return [...spells].flatMap(([spellId, how]) => {
    if (!access.content(spellId)) return [];
    const spell = lookup(access, SpellSchema, spellId);
    const { activation } = spell;
    if (spell.level === 0 || !activation) return [];
    if (!doesSomething(activation.resolution)) return [];
    const own = how === true || how === "shortRest";
    const id = typeof how === "object" ? how.resource : `free:${spellId}`;
    const cast =
      typeof how === "object" && how.minutes !== undefined
        ? unconcentrated(activation, how.minutes)
        : activation;
    return [
      {
        action: {
          id: `spell:${spellId}:free`,
          name: `${spell.name} (free)`,
          activation: {
            ...cast,
            cost: [
              ...activation.cost.filter((cost) => cost !== "slot"),
              ...(how === "atWill" ? [] : [{ resource: id }]),
            ],
          },
          spellLevel: spell.level,
        },
        resource: own
          ? {
              id,
              max: { base: 1, add: [] },
              recharge: [
                { on: how === true ? "longRest" : "shortRest", amount: "all" },
              ],
            }
          : null,
      },
    ];
  });
}

// A charged item's pools and spells (ChargedSchema). An entry with versions counts as its first, as its passives do.
export function chargesOf(item: Item): {
  readonly resources: readonly ResourceDef[];
  readonly casts: readonly ItemCast[];
} {
  const first = item.type === "magicItem" ? item.variants?.[0] : undefined;
  return {
    resources: [
      ...("resources" in item ? (item.resources ?? []) : []),
      ...(first?.resources ?? []),
    ],
    casts: [
      ...("casts" in item ? (item.casts ?? []) : []),
      ...(first?.casts ?? []),
    ],
  };
}

// Spells by their names after the plugin, the first loaded of each, so the book that leads plays it. Kept for each
// run's list of ids, which doesn't change.
const namedSpells = new WeakMap<readonly string[], Map<string, string>>();
function spellNamed(slug: string, access: ContentAccess): string | undefined {
  const ids = access.contentIds();
  let bySlug = namedSpells.get(ids);
  if (!bySlug) {
    bySlug = new Map();
    for (const id of ids) {
      const at = id.indexOf(":spell/");
      const name = id.slice(at + 7);
      if (at >= 0 && !bySlug.has(name)) bySlug.set(name, id);
    }
    namedSpells.set(ids, bySlug);
  }
  return bySlug.get(slug);
}

// A spell cast with an item's own numbers, as a Wand of Web's DC 13, rather than with the bearer's.
function withItemNumbers(
  activation: Activation,
  dc: number | undefined,
  attack: number | undefined,
): Activation {
  const toHit = attack ?? (dc === undefined ? undefined : dc - 8);
  const mapped = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((item) => mapped(item));
    if (value === null || typeof value !== "object") return value;
    const copy: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mapped(item, name)]),
    );
    const terms = Array.isArray(copy.add)
      ? (copy.add as { readonly kind: string }[])
      : [];
    if (dc !== undefined && terms.some((term) => term.kind === "spellSaveDc")) {
      return {
        ...copy,
        base: (typeof copy.base === "number" ? copy.base : 0) + dc,
        add: terms.filter((term) => term.kind !== "spellSaveDc"),
      };
    }
    return key === "attack" && copy.type === "spell" && toHit !== undefined
      ? { ...copy, flatBonus: toHit }
      : copy;
  };
  return mapped(activation) as Activation;
}

// The spells a worn item casts (ItemCastSchema): one action for each number of charges it can spend, each at its
// own level, which never spends a slot.
function itemCasts(
  itemId: string,
  item: Item,
  level: number,
  access: ContentAccess,
): KnownAction[] {
  const { resources, casts } = chargesOf(item);
  return casts.flatMap((cast) => {
    const spellId = spellNamed(cast.spell, access);
    const spell = spellId ? lookup(access, SpellSchema, spellId) : undefined;
    const activation = spell?.activation;
    if (!spellId || !spell || !activation) return [];
    const lasting =
      spell.lasting &&
      typeof spell.duration === "object" &&
      "concentration" in spell.duration;
    if (!lasting && !doesSomething(activation.resolution)) return [];
    const resource = cast.resource ?? resources[0]?.id;
    const lowest = cast.level ?? spell.level;
    const step = spell.upcast?.perSlotLevel;
    return Array.from(
      { length: (cast.upTo ?? cast.charges) - cast.charges + 1 },
      (_, extra) => cast.charges + extra,
    ).flatMap((charges): KnownAction[] => {
      const at = lowest + charges - cast.charges;
      if ((charges > 0 && !resource) || (at > lowest && !step)) return [];
      const scaled =
        spell.level === 0 && spell.cantrip
          ? scaleActivation(
              activation,
              spell.cantrip.perTier,
              cantripTier(level),
            )
          : step
            ? scaleActivation(activation, step, at - spell.level)
            : activation;
      const numbered = withItemNumbers(scaled, cast.dc, cast.attack);
      return [
        {
          id: itemCastId(spellId, itemId, charges),
          name:
            cast.upTo === undefined
              ? `${spell.name} (${item.name})`
              : `${spell.name}, level ${String(at)} (${item.name})`,
          activation: {
            ...numbered,
            cost: [
              ...activation.cost.filter((cost) => cost !== "slot"),
              ...(charges > 0 && resource
                ? [{ resource, ...(charges > 1 ? { count: charges } : {}) }]
                : []),
            ],
          },
          spellLevel: at,
          ...(lasting ? { concentrates: true as const } : {}),
        },
      ];
    });
  });
}

// A worn item's own activations (ChargedSchema `activations`), named after it, as a Pearl of Power's.
function itemUses(itemId: string, item: Item): KnownAction[] {
  const uses = "activations" in item ? (item.activations ?? []) : [];
  return uses.map(({ name, activation }, index) => ({
    id: itemUseId(itemId, index),
    name: uses.length > 1 ? `${name} (${item.name})` : name,
    activation,
    spellLevel: null,
  }));
}

// The abilities a level's feat raised, when that feat makes its raised save proficient, as Resilient does.
function raisedByFeat(
  answers: CharacterBuild["levels"][number]["answers"],
  access: ContentAccess,
): Ability[] {
  const proficient = answers.some(
    (answer) =>
      answer.kind === "feats" &&
      answer.values.some((featId) =>
        lookup(access, FeatSchema, featId).grants.some(
          (id) =>
            !!access.content(id) &&
            lookup(access, FeatureSchema, id).passives.some(
              (passive) =>
                passive.kind === "saveProficiency" && passive.increased,
            ),
        ),
      ),
  );
  if (!proficient) return [];
  return answers.flatMap((answer) =>
    answer.kind === "abilities"
      ? (Object.keys(answer.increases) as Ability[])
      : [],
  );
}

// The spellcasting ability of each spell a feat gives, where the feat names one: fixed, the one it raised, the one
// chosen for it, or the one chosen for a feat taken before (`like`).
function featSpellAbilities(
  build: CharacterBuild,
  originFeats: readonly string[],
  species: Species,
  access: ContentAccess,
): ReadonlyMap<string, Ability> {
  const byFeat = new Map<string, Ability>();
  const taken: [string, CharacterBuild["levels"][number]["answers"]][] = [];
  for (const id of originFeats)
    taken.push([id, build.levels[0]?.answers ?? []]);
  for (const entry of build.levels) {
    for (const answer of entry.answers) {
      if (answer.kind === "spellAbility")
        byFeat.set(answer.feat, answer.ability);
      if (answer.kind === "feats") {
        for (const id of answer.values) taken.push([id, entry.answers]);
      }
    }
  }
  const feats = taken.map(([id, answers]) => ({
    id,
    answers,
    feat: lookup(access, FeatSchema, id),
  }));
  for (const { id, answers, feat } of feats) {
    const rule = feat.spellAbility;
    if (typeof rule === "string" && rule !== "increased") byFeat.set(id, rule);
    if (rule === "increased") {
      const raised = answers.flatMap((answer) =>
        answer.kind === "abilities"
          ? (Object.keys(answer.increases) as Ability[])
          : [],
      );
      const ability = raised.find(
        (item) => feat.abilityIncrease?.includes(item) ?? true,
      );
      if (ability) byFeat.set(id, ability);
    }
  }
  for (const { id, feat } of feats) {
    const rule = feat.spellAbility;
    if (typeof rule !== "object") continue;
    const earlier = [...byFeat].find(
      ([other]) => other === rule.like || other.startsWith(`${rule.like}-`),
    );
    if (earlier) byFeat.set(id, earlier[1]);
  }

  const bySpell = new Map<string, Ability>();
  const featureSpells = (ids: readonly string[], ability: Ability) => {
    for (const grant of ids) {
      const feature = FeatureSchema.safeParse(access.content(grant)).data;
      for (const spells of [feature?.spells, feature?.spellsBySlot]) {
        for (const spell of Object.values(spells ?? {}).flat()) {
          bySpell.set(spell, ability);
        }
      }
    }
  };
  for (const entry of build.levels) {
    for (const answer of entry.answers) {
      const ability =
        (answer.kind === "spells" || answer.kind === "features") && answer.feat
          ? byFeat.get(answer.feat)
          : undefined;
      if (!ability) continue;
      // A species' lineage, picked as an option, gives its spells with the species' ability.
      if (answer.kind === "features") featureSpells(answer.values, ability);
      else if (answer.kind === "spells") {
        for (const spell of answer.values) bySpell.set(spell, ability);
      }
    }
  }
  for (const { id, feat } of feats) {
    const ability = byFeat.get(id);
    if (ability) featureSpells(feat.grants, ability);
  }
  const own = byFeat.get(species.id);
  if (own) featureSpells(species.traits, own);
  return bySpell;
}

// Cold Fire Magic: a spell's damage takes another type.
function retyped(activation: Activation, type: DamageType): Activation {
  const { resolution } = activation;
  const swap = <T extends { readonly type: DamageType }>(list: readonly T[]) =>
    list.map((item) => ({ ...item, type }));
  return {
    ...activation,
    resolution:
      resolution.kind === "attack" && resolution.onHitSave
        ? {
            ...resolution,
            damage: swap(resolution.damage),
            onHitSave: {
              ...resolution.onHitSave,
              damage: swap(resolution.onHitSave.damage),
            },
          }
        : { ...resolution, damage: swap(resolution.damage) },
  };
}

// A feat's spell cast with its own ability: its save DC, spell attack and spellcasting modifier.
function castWith(activation: Activation, ability: Ability): Activation {
  const mapped = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((item) => mapped(item));
    if (value === null || typeof value !== "object") return value;
    const copy: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mapped(item, name)]),
    );
    const spellTerm = copy.kind === "spellMod" || copy.kind === "spellSaveDc";
    const spellAttack = key === "attack" && copy.type === "spell";
    return (spellTerm || spellAttack) && copy.ability === undefined
      ? { ...copy, ability }
      : copy;
  };
  return mapped(activation) as Activation;
}

function bestMentalAbility(abilities: AbilityScores): Ability {
  return (["int", "wis", "cha"] as const).reduce<Ability>(
    (best, ability) => (abilities[ability] > abilities[best] ? ability : best),
    "int",
  );
}

function collectFeatureData(
  access: ContentAccess,
  featureIds: readonly string[],
  level = 1,
  highestSlot = 0,
  feats: ReadonlySet<string> = new Set(),
): {
  passives: Passive[];
  actions: KnownAction[];
  resources: Feature["resources"];
  spells: string[];
  free: [string, FreeCast][];
  retype: Record<string, DamageType>;
} {
  const passives: Passive[] = [];
  const actions: KnownAction[] = [];
  const resources: Feature["resources"] = [];
  const spells = featureIds.flatMap((id) => grantedSpells(id, level));
  const free: [string, FreeCast][] = [];
  const retype: Record<string, DamageType> = {};
  for (const id of featureIds) {
    const feature = featureRules(lookup(access, FeatureSchema, id));
    if ((feature.fromLevel ?? 1) > level) continue;
    Object.assign(retype, feature.retype);
    passives.push(...feature.passives);
    resources.push(...feature.resources);
    for (const [from, ids] of Object.entries(feature.spells ?? {})) {
      if (Number(from) > level) continue;
      spells.push(...ids);
      const how = feature.freeCast;
      if (how)
        free.push(...ids.map((spell): [string, FreeCast] => [spell, how]));
    }
    const { preparedWith } = feature;
    for (const [slot, ids] of Object.entries({
      ...feature.spellsBySlot,
      ...(preparedWith && feats.has(preparedWith.feat)
        ? preparedWith.spells
        : {}),
    })) {
      if (Number(slot) <= highestSlot) spells.push(...ids);
    }
    feature.activations.forEach((activation, index) => {
      actions.push({
        id: `feature:${id}:${String(index)}`,
        name: activation.label
          ? `${feature.name} (${activation.label})`
          : feature.name,
        activation: feature.perTier
          ? scaleActivation(activation, feature.perTier, cantripTier(level))
          : activation,
        spellLevel: null,
        ...(feature.upcast ? { upcast: feature.upcast } : {}),
        ...(feature.hitType ? { hitType: true as const } : {}),
      });
    });
  }
  return { passives, actions, resources, spells, free, retype };
}

// A feature's activations with the effects other features ride on them, as Tactical Shift's move on Second Wind.
function withRiders(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  return actions.map((action) => {
    const { resolution } = action.activation;
    const extra = passives.flatMap((passive) =>
      passive.kind === "activationRider" &&
      action.id.startsWith(`feature:${passive.feature}:`)
        ? passive.effects
        : [],
    );
    return extra.length === 0 || resolution.kind !== "automatic"
      ? action
      : {
          ...action,
          activation: {
            ...action.activation,
            resolution: {
              ...resolution,
              effects: [...resolution.effects, ...extra],
            },
          },
        };
  });
}

export function weaponProficient(classDef: ClassDef, weapon: Weapon): boolean {
  if (!classDef.weapons.includes(weapon.category)) return false;
  const limit = classDef.martialWeaponProperties;
  return (
    weapon.category !== "martial" ||
    !limit ||
    weapon.properties.some((property) => limit.includes(property))
  );
}

export function weaponActivation(
  weapon: Weapon,
  abilities: AbilityScores,
  proficient = true,
  damageBonus = 0,
  itemBonus = 0,
): Activation {
  const ranged = weapon.properties.includes("ammunition");
  const finesse = weapon.properties.includes("finesse");
  const ability: Ability =
    ranged ||
    (finesse && abilityModifier(abilities.dex) > abilityModifier(abilities.str))
      ? "dex"
      : "str";
  // shortcut: an Ammunition weapon without its range in the data reaches 80 feet with no long range.
  const range = ranged ? (weapon.range ?? { normal: 80, long: 80 }) : null;
  const reach = !ranged && weapon.properties.includes("reach");
  return {
    cost: ["action"],
    targeting: {
      creatures: 1,
      range: range?.long ?? (reach ? 10 : 5),
      side: "enemy",
      ...(reach ? { reach: true as const } : {}),
    },
    resolution: {
      kind: "attack",
      attack: {
        type: "weapon",
        ability,
        ...(proficient ? {} : { proficient }),
        ...(itemBonus > 0 ? { itemBonus } : {}),
        ...(range && range.normal < range.long
          ? { normalRange: range.normal }
          : {}),
      },
      damage: [
        {
          amount: {
            ...(weapon.damage.dice ? { dice: weapon.damage.dice } : {}),
            bonus: {
              base: (weapon.damage.flat ?? 0) + damageBonus,
              add: [{ kind: "abilityMod", ability }],
            },
          },
          type: weapon.damage.type,
        },
        ...(weapon.hitDamage ?? []),
      ],
      onHit: [],
      onMiss: [],
    },
  };
}

// Throwing a Thrown weapon: its melee attack made at range, with Disadvantage past its normal range.
function thrownActivation(
  melee: Activation,
  range: NonNullable<Weapon["range"]>,
  passives: readonly Passive[],
): Activation {
  const { resolution } = melee;
  if (resolution.kind !== "attack") return melee;
  const bonus = passives.reduce(
    (sum, passive) =>
      passive.kind === "thrownDamage" ? sum + passive.bonus : sum,
    0,
  );
  const longShots = passives.some(({ kind }) => kind === "longShots");
  return {
    ...melee,
    targeting: { creatures: 1, range: range.long, side: "enemy" },
    resolution: {
      ...resolution,
      attack: {
        ...resolution.attack,
        ...(longShots || range.normal >= range.long
          ? {}
          : { normalRange: range.normal }),
      },
      damage: resolution.damage.map((damage, index) =>
        index === 0 && bonus > 0
          ? {
              ...damage,
              amount: {
                ...damage.amount,
                bonus: {
                  base: (damage.amount.bonus?.base ?? 0) + bonus,
                  add: damage.amount.bonus?.add ?? [],
                },
              },
            }
          : damage,
      ),
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

const isPactMagic = (id: string): boolean => id.endsWith("pact-magic");

function characterStats(actor: Actor, access: ContentAccess): Stats {
  const build = effectiveBuild(actor);
  if (!build) throw new Error(`${actor.id} has no character build`);
  const background = lookup(access, BackgroundSchema, build.backgroundId);
  const species = lookup(access, SpeciesSchema, build.speciesId);

  // One action per kind of item, so a second dagger or potion doesn't list twice.
  const worn = [...new Set(equipped(actor))].map(
    (itemId) => [itemId, lookup(access, ItemSchema, itemId)] as const,
  );
  const attuned = actor.attuned ?? [];
  // In an Antimagic Field, magic items don't work.
  const antimagic = actor.suppressed !== undefined;
  // Whether a worn item's magic works: not in an Antimagic Field, and attuned where it needs it.
  const works = (itemId: string, item: Item): boolean =>
    !antimagic &&
    !("attunement" in item && item.attunement && !attuned.includes(itemId));
  const working = worn.flatMap(([itemId, item]) =>
    item.type === "magicItem" && works(itemId, item) ? [item] : [],
  );
  // Every worn item's passives, magic weapons and armor made from plain ones too (variants.ts). An entry with
  // versions counts as its first, as its bonuses do.
  const itemPassives = worn.flatMap(([itemId, item]) =>
    works(itemId, item)
      ? [
          ...("passives" in item ? (item.passives ?? []) : []),
          ...(item.type === "magicItem"
            ? (item.variants?.[0]?.passives ?? [])
            : []),
        ]
      : [],
  );
  const abilities = withItemAbilities(ownAbilities(actor, build), working);

  const level = build.levels.length;
  const classLevels: Record<string, number> = {};
  const skills = new Set<Skill>(background.skills);
  const expertise = new Set<Skill>();
  const knownSpells = new Set<string>();
  const freeSpells = new Map<string, FreeCast>(); // also cast without a slot
  const raisedSaves = new Set<Ability>(); // proficient from a feat such as Resilient
  const featureIds = new Set<string>(species.traits);
  // A feat picked in place of the background's, as a Dark Gift for Haunted One, is in the first level's answers.
  const replaced =
    background.featOr !== undefined &&
    (build.levels[0]?.answers ?? []).some(
      (answer) =>
        answer.kind === "feats" &&
        answer.values.some(
          (id) => lookup(access, FeatSchema, id).category === background.featOr,
        ),
    );
  if (!replaced) {
    for (const id of lookup(access, FeatSchema, background.feat).grants) {
      featureIds.add(id);
    }
  }
  let scaling: Record<string, number> = {};
  let slots: readonly number[] = [];
  const casters: Record<string, Caster> = {};
  let subclass: Subclass | null = null;
  const featIds = new Set<string>();

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
    for (const answer of entry.answers) {
      if (answer.kind === "skills") {
        for (const skill of answer.values) {
          (answer.expertise || (answer.orExpertise && skills.has(skill))
            ? expertise
            : skills
          ).add(skill);
        }
      } else if (answer.kind === "spells") {
        for (const spell of answer.values) {
          knownSpells.add(spell);
          if (answer.freeCast) freeSpells.set(spell, answer.freeCast);
        }
      } else if (answer.kind === "features") {
        for (const id of answer.values) featureIds.add(id);
      } else if (answer.kind === "feats") {
        for (const id of answer.values) {
          featIds.add(id);
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
      subclass?.class === entry.classId
        ? subclass.levels.find((item) => item.level === classLevel)
        : undefined;
    for (const id of subclassLevel?.grants ?? []) featureIds.add(id);
    for (const ability of raisedByFeat(entry.answers, access)) {
      raisedSaves.add(ability);
    }
    scaling = { ...scaling, ...subclassLevel?.scaling };
    const own = subclassLevel?.slots.length
      ? subclassLevel.slots
      : levelData.slots;
    if (own.length > 0) slots = own;
    // Pact Magic, granted at a Warlock's first level, isn't Spellcasting and keeps out of the multiclass table.
    const pact = definition.levels.some((item) =>
      item.grants.some(isPactMagic),
    );
    if (own.length > 0 && !pact) {
      casters[entry.classId] = {
        slots: own,
        level: classLevel,
        subclass: own !== levelData.slots,
      };
    }
  }
  slots = multiclassSlots(Object.values(casters)) ?? slots;

  const [firstLevel] = build.levels;
  if (!firstLevel) throw new Error(`${actor.id} has no levels`);
  const firstClass = lookup(access, ClassSchema, firstLevel.classId);
  const con = abilityModifier(abilities.con);
  const maxHp = build.levels.reduce(
    (sum, entry) => sum + entry.hitPointGain + con,
    0,
  );

  // shortcut: training comes from every class taken, while a multiclass really gets only some of a later class's.
  // shortcut: a Protector cleric's or Warden druid's training isn't given, since the order chosen isn't recorded as its own feature.
  const classes = Object.keys(classLevels).map((id) =>
    lookup(access, ClassSchema, id),
  );
  // A multiclass casts with the class it has the most levels in, the first taken on a tie.
  // shortcut: every spell uses that one ability, give each its own class's once Stats holds more than one.
  const [caster] = classes
    .filter((def) => def.spellcasting)
    .sort((a, b) => (classLevels[b.id] ?? 0) - (classLevels[a.id] ?? 0));
  const trained = new Set<string>(classes.flatMap((def) => def.armor));
  for (const id of featIds) {
    if (id.endsWith("lightly-armored")) trained.add("light").add("shield");
    if (id.endsWith("moderately-armored")) trained.add("medium").add("shield");
    if (id.endsWith("heavily-armored")) trained.add("heavy");
  }
  const martialTraining = [...featIds].some((id) =>
    id.endsWith("/martial-weapon-training"),
  );
  const untrainedArmor = worn.some(
    ([, item]) =>
      item.type === "armor" &&
      !item.anyTraining &&
      !trained.has(item.armorType),
  );
  const tooHeavy = worn.some(
    ([, item]) => item.type === "armor" && abilities.str < (item.strength ?? 0),
  );

  const magic = {
    ac: 0,
    attack: 0,
    damage: 0,
    savingThrows: 0,
    spellAttack: 0,
    spellDc: 0,
    checks: 0,
    proficiency: 0,
  };
  const armored = worn.some(
    ([, item]) => item.type === "armor" || item.type === "shield",
  );
  const weaponBonuses: { to: string; amount: number; weapons: string[] }[] = [];
  const weaponTraining = new Set(
    working.flatMap((item) => item.weaponTraining ?? []),
  );
  for (const item of working) {
    // An entry with versions counts as its first, as older saves hold; content names a version as `<id>--<n>` (variants.ts).
    for (const { to, amount, unarmored, weapons } of item.bonuses ??
      item.variants?.[0]?.bonuses ??
      []) {
      if (unarmored && armored) continue;
      if (weapons) {
        weaponBonuses.push({ to, amount, weapons });
        continue;
      }
      // shortcut: a magic weapon isn't a weapon to swing here, so its bonus goes to the weapons carried, the best one once.
      magic[to] =
        to === "attack" || to === "damage"
          ? Math.max(magic[to], amount)
          : magic[to] + amount;
    }
  }

  const fromFeatures = collectFeatureData(
    access,
    [...featureIds],
    level,
    slots.findLastIndex((count) => count > 0) + 1,
    featIds,
  );
  // Traits from features and from worn magic items, for what they change here, as a Robe of the Archmagi's AC.
  const traits = [...itemPassives, ...fromFeatures.passives];
  const castingAbility = featSpellAbilities(
    build,
    replaced ? [] : [background.feat],
    species,
    access,
  );
  const armorBases: number[] = [];
  const flatBonus = magic.ac;
  let shield = 0;
  const actions: KnownAction[] = [];
  for (const [itemId, item] of worn) {
    const usable = itemAction(
      itemId,
      item,
      access,
      untrainedArmor ? undefined : caster?.spellcasting,
    );
    if (usable) {
      actions.push(
        item.type === "gear"
          ? fastHands(farLobbed(usable, traits), traits)
          : usable,
      );
    }
    if (works(itemId, item) && !untrainedArmor) {
      actions.push(
        ...itemCasts(itemId, item, level, access),
        ...itemUses(itemId, item),
      );
    }
    if (item.type === "armor") {
      const parsed = ArmorSchema.parse(item);
      const dex = abilityModifier(abilities.dex);
      const maxDex = traits.reduce(
        (most, passive) =>
          passive.kind === "armorDexMax" && passive.armor === parsed.armorType
            ? Math.max(most, passive.max)
            : most,
        parsed.maxDex ?? dex,
      );
      const allowed = parsed.addDex ? Math.min(dex, maxDex) : 0;
      armorBases.push(
        parsed.base + allowed + ownAc(item.bonuses, !works(itemId, item)),
      );
    } else if (item.type === "shield") {
      // Only one shield is held, and it protects only with training.
      if (trained.has("shield")) {
        shield = Math.max(
          shield,
          item.bonus + ownAc(item.bonuses, !works(itemId, item)),
        );
      }
    } else if (item.type === "weapon") {
      const weapon = WeaponSchema.parse(item);
      // A magic weapon's own bonus, or the best from a magic weapon carried beside it, never both.
      const own = (to: "attack" | "damage"): number =>
        Math.max(
          magic[to],
          ...(!works(itemId, item) ? [] : (weapon.bonuses ?? []))
            .filter((bonus) => bonus.to === to)
            .map((bonus) => bonus.amount),
        );
      // Bonuses and training an item gives with this kind of weapon, as Bracers of Archery with a Longbow.
      const kinds = [itemId, weapon.baseWeapon ?? itemId].map((id) =>
        id.slice(id.lastIndexOf("/") + 1),
      );
      const scoped = (to: "attack" | "damage"): number =>
        weaponBonuses
          .filter(
            (bonus) =>
              bonus.to === to &&
              kinds.some((kind) => bonus.weapons.includes(kind)),
          )
          .reduce((total, bonus) => total + bonus.amount, 0);
      const { hitDamage, ...plain } = weapon;
      const activation = weaponActivation(
        works(itemId, item) && hitDamage ? { ...plain, hitDamage } : plain,
        abilities,
        martialTraining ||
          kinds.some((kind) => weaponTraining.has(kind)) ||
          classes.some((def) => weaponProficient(def, weapon)),
        own("damage") + scoped("damage"),
        own("attack") - magic.attack + scoped("attack"),
      );
      actions.push({
        id: `${WEAPON_PREFIX}${itemId}`,
        name: item.name,
        activation,
        spellLevel: null,
      });
      if (weapon.properties.includes("thrown") && weapon.range) {
        actions.push({
          id: `${THROW_PREFIX}${itemId}`,
          name: `Throw ${item.name}`,
          activation: thrownActivation(activation, weapon.range, traits),
          spellLevel: null,
        });
      }
    }
  }

  actions.push(...fromFeatures.actions);
  for (const spellId of fromFeatures.spells) {
    if (access.content(spellId)) knownSpells.add(spellId);
  }
  for (const [spellId, how] of fromFeatures.free) freeSpells.set(spellId, how);
  const freeCasts = untrainedArmor ? [] : freeCastActions(freeSpells, access);
  actions.push(
    ...freeCasts.map(({ action }) => {
      // Its id is "spell:<spell>:free".
      const ability = castingAbility.get(action.id.slice(6, -5));
      return ability
        ? { ...action, activation: castWith(action.activation, ability) }
        : action;
    }),
  );

  for (const spellId of untrainedArmor ? [] : knownSpells) {
    const spell: Spell = lookup(access, SpellSchema, spellId);
    const lasting =
      spell.lasting &&
      typeof spell.duration === "object" &&
      "concentration" in spell.duration
        ? spell.lasting
        : undefined;
    if (
      spell.activation &&
      (lasting || doesSomething(spell.activation.resolution))
    ) {
      const activation =
        spell.level === 0 && spell.cantrip
          ? scaleActivation(
              spell.activation,
              spell.cantrip.perTier,
              cantripTier(level),
            )
          : spell.activation;
      const ability = castingAbility.get(spellId);
      const type = fromFeatures.retype[spellId];
      const cast = ability ? castWith(activation, ability) : activation;
      actions.push({
        id: `spell:${spellId}`,
        name: spell.name,
        activation: type ? retyped(cast, type) : cast,
        spellLevel: spell.level,
        upcast: spell.upcast,
        ...(lasting ? { concentrates: true as const } : {}),
      });
    }
    // What the spell lets its caster do while it holds, as Flame Blade's attack, is no cast of its own.
    // shortcut: it's at the spell's own level, not the slot's it was cast with.
    if (
      lasting &&
      spellOfSource(actor.concentratingOn ?? "") === spellId &&
      !castFrom(actor.concentratingOn ?? "")
    ) {
      actions.push({
        id: `lasting:${spellId}`,
        name: spell.name,
        activation: lasting,
        spellLevel: null,
      });
    }
  }

  // What a spell cast from an item lets its caster do while it holds, as Flaming Sphere's from a Staff of the Magi.
  const held = castFrom(actor.concentratingOn ?? "")
    ? spellOfSource(actor.concentratingOn ?? "")
    : null;
  const heldLasting = held
    ? SpellSchema.safeParse(access.content(held)).data?.lasting
    : undefined;
  if (held && heldLasting && !untrainedArmor) {
    actions.push({
      id: `lasting:${held}`,
      name: lookup(access, SpellSchema, held).name,
      activation: heldLasting,
      spellLevel: null,
    });
  }

  const pools = itemPools(actor, access);
  const partial: Stats = {
    abilities,
    proficiency: proficiencyBonus(level) + magic.proficiency,
    level,
    classLevels,
    maxHp,
    ac: bestAc(actor, abilities, {
      armorBases,
      flatBonus: flatBonus + shield,
      passives: traits,
    }),
    speed: encumberedSpeed(
      species.speed,
      carriedWeight(actor, access),
      carryingCapacity(
        abilities.str,
        species.size,
        traits.some(({ kind }) => kind === "powerfulBuild"),
      ),
    ),
    savingThrows: [
      ...new Set([
        ...firstClass.savingThrows,
        ...raisedSaves,
        ...traits.flatMap((passive) =>
          passive.kind === "saveProficiency" ? passive.abilities : [],
        ),
      ]),
    ],
    skills: traits.some((passive) => passive.kind === "allSkills")
      ? ALL_SKILLS
      : [...skills],
    expertise: [...expertise],
    // shortcut: a character with no Spellcasting casts the spells a feat or trait gives with the best of
    // Intelligence, Wisdom or Charisma, as if it had chosen that one.
    spellAbility:
      caster?.spellcasting?.ability ??
      (knownSpells.size > 0 ? bestMentalAbility(abilities) : null),
    slots,
    resources: {},
    passives: [
      ...itemPassives,
      ...fromFeatures.passives.map((passive) =>
        passive.kind === "extraDamage"
          ? { ...passive, dice: scaledDice(passive, scaling) ?? passive.dice }
          : passive,
      ),
      ...(holdsConcentration(actor)
        ? [{ kind: "concentrationAdvantage" as const }]
        : []),
      // Every weapon attack uses Strength or Dexterity.
      // shortcut: a save can't be limited to Strength and Dexterity without a change in combat.ts, so saves aren't affected yet.
      ...(untrainedArmor
        ? [
            {
              kind: "modifier" as const,
              modifier: {
                kind: "disadvantage" as const,
                on: "attacks" as const,
              },
            },
          ]
        : []),
    ],
    actions: withMetamagic(
      withInvocations(
        withWeaponRiders(
          withRiders(actions, fromFeatures.passives),
          fromFeatures.passives,
          actor,
          access,
          abilities,
        ),
        fromFeatures.passives,
        abilities,
        classLevels,
      ),
      actor,
      abilityModifier(abilities.cha),
    ),
    multiattack: Math.max(
      ...[...featureIds].map(attacksFrom),
      ...passiveAttacks(fromFeatures.passives),
      1,
    ),
    routines: null,
    creatureType: species.creatureType.toLowerCase(),
    initiative:
      abilityModifier(abilities.dex) -
      2 * actor.exhaustion -
      (actor.ordeal ?? 0),
    // Proficiency Bonus as a scaling key, for dice that number it, as Healing Hands' d4s.
    scaling: {
      ...scaling,
      ...Object.fromEntries(
        fromFeatures.passives.flatMap((passive) =>
          passive.kind === "scalingFloor"
            ? [
                [
                  passive.key,
                  Math.max(scaling[passive.key] ?? 0, passive.value),
                ],
              ]
            : [],
        ),
      ),
      proficiency: proficiencyBonus(level) + magic.proficiency,
    },
    features: [...featureIds],
    resourceDefs: [
      ...fromFeatures.resources,
      ...freeCasts.flatMap(({ resource }) => (resource ? [resource] : [])),
      ...pools,
    ],
    pactMagic: [...featureIds].some(isPactMagic),
    untrainedArmor,
    exhaustion: actor.exhaustion,
    ordeal: actor.ordeal ?? 0,
    itemBonuses: magic,
    speeds: {},
  };
  return {
    ...partial,
    ...familiarFrom(knownSpells, castingAbility, access, partial.spellAbility),
    maxHp: partial.maxHp + passiveBonus(partial, "maxHp"),
    initiative: partial.initiative + passiveBonus(partial, "initiative"),
    speed: Math.max(
      0,
      partial.speed +
        passiveBonus(partial, "speed") -
        (tooHeavy ? 10 : 0) -
        5 * actor.exhaustion,
    ),
    resources: Object.fromEntries(
      [...fromFeatures.resources, ...pools].map((resource) => [
        resource.id,
        evaluateFormula(resource.max, partial),
      ]),
    ),
  };
}

// The pools of every item carried, stowed or not, so a wand in the pack still regains its charges. Two of one item
// share theirs.
// shortcut: pools are kept by their ids, so a second Wand of Web adds no charges of its own.
function itemPools(actor: Actor, access: ContentAccess): ResourceDef[] {
  const pools = new Map<string, ResourceDef>();
  for (const itemId of new Set(actor.inventory)) {
    for (const pool of chargesOf(lookup(access, ItemSchema, itemId))
      .resources) {
      if (!pools.has(pool.id)) pools.set(pool.id, pool);
    }
  }
  return [...pools.values()];
}

function familiarFrom(
  knownSpells: ReadonlySet<string>,
  castingAbility: ReadonlyMap<string, Ability>,
  access: ContentAccess,
  spellAbility: Ability | null,
): Pick<Stats, "familiar"> {
  for (const spellId of knownSpells) {
    const { familiar } = lookup(access, SpellSchema, spellId);
    if (!familiar) continue;
    return {
      familiar: {
        form: familiar.form,
        ability: castingAbility.get(spellId) ?? spellAbility ?? "int",
      },
    };
  }
  return {};
}

// shortcut: a speed bonus doesn't check the armor it needs, such as Fast Movement's.
function passiveBonus(
  stats: Stats,
  to: "speed" | "initiative" | "maxHp",
): number {
  return passiveModifiers(stats.passives).reduce(
    (total, modifier) =>
      modifier.kind === "bonus" && modifier.to === to
        ? total +
          evaluateFormula(modifier.amount.bonus ?? { base: 0, add: [] }, stats)
        : total,
    0,
  );
}

// What drinking it heals, for a potion such as a Potion of Healing.
// A potion entry with versions heals as its first, as older saves hold; `<id>--<n>` is the nth (variants.ts).
export function itemHealing(item: z.infer<typeof ItemSchema>) {
  return item.type === "gear"
    ? item.healing
    : item.type === "magicItem"
      ? (item.healing ?? item.variants?.[0]?.healing)
      : undefined;
}

// A potion to drink or a scroll to read, used up once used. Their action ids start "item:", which spends the item.
function itemAction(
  itemId: string,
  item: z.infer<typeof ItemSchema>,
  access: ContentAccess,
  spellcasting: unknown,
): KnownAction | null {
  const healing = itemHealing(item);
  if (healing) {
    return {
      id: `item:${itemId}`,
      name: `Drink ${item.name}`,
      activation: {
        cost: ["bonusAction"],
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [{ kind: "heal", amount: healing }],
        },
      },
      spellLevel: null,
    };
  }
  if (item.type === "gear" && item.activation) {
    return {
      id: `item:${itemId}`,
      name: `Throw ${item.name}`,
      activation: item.activation,
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

// Fast Hands: gear used with an action, as a flask of Acid thrown, takes a Bonus Action instead.
// shortcut: every such use counts as the Utilize action.
function fastHands(
  action: KnownAction,
  passives: readonly Passive[],
): KnownAction {
  if (!passives.some((passive) => passive.kind === "fastHands")) return action;
  return {
    ...action,
    activation: {
      ...action.activation,
      cost: action.activation.cost.map((cost) =>
        cost === "action" ? "bonusAction" : cost,
      ),
    },
  };
}

// Bomber's Far Lobber: a vial or flask thrown farther.
function farLobbed(
  action: KnownAction,
  passives: readonly Passive[],
): KnownAction {
  const { targeting } = action.activation;
  const feet = Math.max(
    0,
    ...passives.map((passive) =>
      passive.kind === "farLobber" ? passive.feet : 0,
    ),
  );
  if (
    !("creatures" in targeting) ||
    typeof targeting.range !== "number" ||
    targeting.range >= feet
  ) {
    return action;
  }
  return {
    ...action,
    activation: {
      ...action.activation,
      targeting: { ...targeting, range: feet },
    },
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

function monsterStats(actor: Actor, access: ContentAccess): Stats {
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
  // A familiar can't attack, is a Fey, and has what its owner's features give it, reading its owner's numbers.
  const boons = familiarOf.features.flatMap(
    (id) => lookup(access, FeatureSchema, id).familiar ?? [],
  );
  return {
    ...stats,
    maxHp: familiarOf.maxHp,
    creatureType: "fey",
    passives: [...stats.passives, ...boons.flatMap((boon) => boon.passives)],
    actions: [
      ...stats.actions.filter(
        ({ activation }) => activation.resolution.kind !== "attack",
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
function summonStats(actor: Actor, access: ContentAccess): Stats {
  const { source } = actor;
  if (source.kind !== "summon") throw new Error(`${actor.id} is not summoned`);
  const companion = lookup(access, CompanionSchema, source.companion);
  const { play } = companion;
  if (!play) throw new Error(`${companion.id} has no numbers to play`);
  const above = Math.max(0, source.level - play.level);
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
  const stats = statBlockStats(
    actor,
    {
      id: companion.id,
      name: companion.name,
      ...(companion.size ? { size: companion.size } : {}),
      abilities: companion.abilities,
      ac: play.ac + play.acPerLevel * above,
      hp: play.hp + play.hpPerLevel * above,
      speed: play.speed,
      ...(play.speeds ? { speeds: play.speeds } : {}),
      proficiency: source.proficiency,
      saves: play.saves,
      initiative: 0, // it goes right after its caster
      ...(play.creatureType ? { creatureType: play.creatureType } : {}),
      features: [],
      passives: play.passives,
      multiattack: play.halfLevelAttacks
        ? Math.max(1, Math.floor(source.level / 2))
        : play.multiattack,
      actions: play.actions.map((action) => ({
        ...action,
        activation: {
          ...action.activation,
          resolution: casterNumbers(action.activation.resolution),
        },
      })),
    },
    access,
  );
  // Damage "plus the spell's level" reads it as a scaling key.
  return { ...stats, scaling: { spellLevel: source.level } };
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
    speed: Math.max(0, (shape?.speed ?? monster.speed) - 5 * actor.exhaustion),
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
    initiative: monster.initiative - 2 * actor.exhaustion - (actor.ordeal ?? 0),
    scaling: {},
    features: monster.features,
    resourceDefs: fromFeatures.resources,
    pactMagic: false,
    untrainedArmor: false,
    exhaustion: actor.exhaustion,
    ordeal: actor.ordeal ?? 0,
    itemBonuses: {
      attack: 0,
      spellAttack: 0,
      spellDc: 0,
      savingThrows: 0,
      checks: 0,
    },
    speeds: Object.fromEntries(
      (["fly", "climb", "burrow"] as const).flatMap((mode) => {
        const feet = monster.speeds?.[mode];
        return feet ? [[mode, Math.max(0, feet - 5 * actor.exhaustion)]] : [];
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

// Calculated on demand and never stored, so stats can't drift out of step with choices or gear.
// Deafened and Grappled have no effect without hearing rules or a grappler's own grip, so a spell that only does
// those would waste a slot. A push or a teleport moves on the grid every fight has.
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
      effect.kind === "hitDieHeal" ||
      effect.kind === "tempHp" ||
      effect.kind === "modifier" ||
      effect.kind === "removeCondition" ||
      effect.kind === "cure" ||
      effect.kind === "dispel" ||
      effect.kind === "zone" ||
      effect.kind === "polymorph" ||
      effect.kind === "summon" ||
      effect.kind === "commandFamiliar" ||
      effect.kind === "counter" ||
      effect.kind === "extraAction" ||
      effect.kind === "reduceDamage" ||
      effect.kind === "acAgainstHit" ||
      effect.kind === "teleport" ||
      effect.kind === "forcedMove" ||
      effect.kind === "weaponAttack" ||
      effect.kind === "randomAction" ||
      effect.kind === "copySpell" ||
      (effect.kind === "applyCondition" &&
        effect.condition !== "deafened" &&
        effect.condition !== "grappled"),
  );
}

export function immuneToCondition(stats: Stats, condition: Condition): boolean {
  return stats.passives.some(
    (passive) =>
      passive.kind === "conditionImmunity" && passive.condition === condition,
  );
}

export function deriveStats(actor: Actor, access: ContentAccess): Stats {
  const own =
    actor.source.kind === "monster"
      ? monsterStats(actor, access)
      : actor.source.kind === "summon"
        ? summonStats(actor, access)
        : characterStats(actor, access);
  // A form's stat block replaces the creature's own, but it keeps its creature type and Hit Point maximum, and with
  // Shapechange its Intelligence, Wisdom and Charisma and its spellcasting.
  const form = formOf(actor);
  const keep = formKept(actor);
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
        ...(keep.includes("spells")
          ? {
              actions: [
                ...shaped.actions,
                ...own.actions.filter(({ spellLevel }) => spellLevel !== null),
              ],
              spellAbility: own.spellAbility,
              slots: own.slots,
              pactMagic: own.pactMagic,
              proficiency: Math.max(shaped.proficiency, own.proficiency),
            }
          : {}),
      }
    : own;
  // A Ring of Free Action: nothing takes Speed off.
  const speed = effectBonus(actor, "speed", hasSteadySpeed(stats));
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
  const moving = zoneMoves(actor);
  const moved =
    moving.length > 0
      ? { ...free, actions: [...free.actions, ...moving] }
      : free;
  const loss = actor.maxHpLoss ?? 0;
  return speed === 0 && maxHp === 0 && loss === 0
    ? moved
    : {
        ...moved,
        speed: Math.max(0, stats.speed + speed),
        maxHp: Math.max(1, stats.maxHp + maxHp - loss),
      };
}

export const MOVE_ZONE = "zone-move:";

// An action to move an area the bearer keeps, as Moonbeam's Magic action. shortcut: its reach is counted from the
// bearer, not from where the area stands.
function zoneMoves(actor: Actor): KnownAction[] {
  const seen = new Set<string>();
  return actor.activeEffects.flatMap(
    ({ sourceId, modifier }): KnownAction[] => {
      if (modifier.kind !== "zone" || !modifier.area?.moves) return [];
      if (modifier.follows || seen.has(sourceId)) return [];
      seen.add(sourceId);
      return [
        {
          id: `${MOVE_ZONE}${sourceId}`,
          name: `Move ${modifier.name ?? "the area"}`,
          activation: {
            cost: ["action"],
            targeting: {
              area: { shape: "sphere", radius: modifier.radius },
              range: modifier.area.moves,
              side: "enemy",
            },
            resolution: {
              kind: "automatic",
              damage: [],
              effects: [{ kind: "moveZone", source: sourceId }],
            },
          },
          spellLevel: null,
        },
      ];
    },
  );
}

// What spells on the creature do to its actions: a weapon changed by Shillelagh or True Strike, an action given
// by Dragon's Breath, and a spell's weapon attack reaching as far as the weapons it can use.
function withEffectActions(
  stats: Stats,
  actor: Actor,
  access: ContentAccess,
): Stats {
  // Most creatures have none of these, and stats are derived often.
  if (
    !actor.activeEffects.some(
      ({ modifier }) =>
        modifier.kind === "weaponSpell" ||
        modifier.kind === "grantedAction" ||
        modifier.kind === "wished",
    ) &&
    !stats.actions.some((action) =>
      weaponAttackOf(action.activation.resolution),
    )
  ) {
    return stats;
  }
  const granted: KnownAction[] = [];
  let actions = stats.actions;
  for (const { modifier, sourceId, level } of actor.activeEffects) {
    if (modifier.kind === "wished") {
      const id = `spell:${modifier.spell}`;
      const spell = lookup(access, SpellSchema, modifier.spell);
      // Once cast it's no longer offered, yet stays to be found until the turn is over, as its attacks need it.
      const cast = actor.usedThisTurn.includes(wishedKey(modifier.spell));
      const known = actions.some((action) => action.id === id);
      const copy = (
        activation: Activation,
      ): Omit<KnownAction, "id" | "name"> => ({
        activation: { ...activation, cost: [] },
        spellLevel: spell.level,
        ...(spell.upcast ? { upcast: spell.upcast } : {}),
        ...(cast ? { rolled: true as const } : {}),
      });
      if (known && !cast) {
        actions = actions.map((action) =>
          action.id === id ? { ...action, ...copy(action.activation) } : action,
        );
      } else if (!known && spell.activation) {
        actions = [
          ...actions,
          { id, name: spell.name, ...copy(spell.activation) },
        ];
      }
    }
    if (modifier.kind === "weaponSpell") {
      actions = actions.map(
        (action) => changedWeapon(action, modifier, stats, access) ?? action,
      );
    }
    if (modifier.kind !== "grantedAction") continue;
    const spell = lookup(access, SpellSchema, spellOfSource(sourceId) ?? "");
    if (!spell.granted) continue;
    const scaled = spell.upcast
      ? scaleActivation(
          spell.granted,
          spell.upcast.perSlotLevel,
          (level ?? spell.level) - spell.level,
        )
      : spell.granted;
    const { resolution } = scaled;
    granted.push({
      id: `granted:${sourceId}`,
      name: spell.name,
      activation: retyped(
        resolution.kind === "save" && modifier.dc !== undefined
          ? {
              ...scaled,
              resolution: { ...resolution, dc: { base: modifier.dc, add: [] } },
            }
          : scaled,
        modifier.damage,
      ),
      spellLevel: null,
    });
  }
  const reaching = actions.flatMap((action) => {
    const attack = weaponAttackOf(action.activation.resolution);
    const { targeting } = action.activation;
    if (!attack || !("creatures" in targeting)) return [action];
    const ranges = actions.flatMap((item) => {
      const reach = item.activation.targeting;
      return weaponFits(item, attack.change, access) && "creatures" in reach
        ? [typeof reach.range === "number" ? reach.range : 5]
        : [];
    });
    // With no weapon to make it with, it can't be cast.
    if (ranges.length === 0) return [];
    return [
      {
        ...action,
        activation: {
          ...action.activation,
          targeting: { ...targeting, range: Math.max(...ranges) },
        },
      },
    ];
  });
  return actions === stats.actions &&
    granted.length === 0 &&
    reaching.length === actions.length &&
    reaching.every((action, index) => action === actions[index])
    ? stats
    : { ...stats, actions: [...reaching, ...granted] };
}

// In usedThisTurn once Wish's copy of the spell has been cast.
export const wishedKey = (spell: string): string => `wished:${spell}`;

export function weaponAttackOf(
  resolution: Resolution,
): Extract<LeafEffect, { kind: "weaponAttack" }> | undefined {
  if (resolution.kind !== "automatic") return undefined;
  const found = resolution.effects.find(
    (effect) => effect.kind === "weaponAttack",
  );
  return found?.kind === "weaponAttack" ? found : undefined;
}

// A weapon attack of the creature's own that a spell's change applies to: only the weapons it names (or a magic
// one made from them), and with `ranged` only one firing ammunition.
export function weaponFits(
  action: KnownAction,
  change: WeaponChange,
  access: ContentAccess,
): boolean {
  if (!action.id.startsWith(WEAPON_PREFIX)) return false;
  const weapon = WeaponSchema.safeParse(
    access.content(weaponItemId(action.id)),
  ).data;
  if (!weapon) return false;
  if (change.ranged && !weapon.properties.includes("ammunition")) return false;
  const ids = [weaponItemId(action.id), weapon.baseWeapon ?? ""];
  return !change.weapons || ids.some((id) => change.weapons?.includes(id));
}

// The weapon attack as the spell makes it: its spellcasting ability, its die, its damage type and its extra damage.
// The caster picks the spell's type or the weapon's, whichever the target resists least.
function changedWeapon(
  action: KnownAction,
  change: WeaponChange,
  stats: Stats,
  access: ContentAccess,
): KnownAction | null {
  const { resolution } = action.activation;
  if (resolution.kind !== "attack" || !weaponFits(action, change, access)) {
    return null;
  }
  const [main, ...rest] = resolution.damage;
  if (!main) return null;
  const from = resolution.attack.ability;
  const ability =
    change.spellAbility && stats.spellAbility ? stats.spellAbility : from;
  const tier = cantripTier(stats.level);
  const die = change.dice?.[Math.min(tier, change.dice.length - 1)];
  const { bonus } = main.amount;
  const [count = 1, sides = 6] = (change.extra?.perTier ?? "1d6")
    .split("d")
    .map(Number);
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution: {
        ...resolution,
        attack: { ...resolution.attack, ...(ability ? { ability } : {}) },
        damage: [
          {
            type: change.type ?? main.type,
            ...(change.type && change.type !== main.type
              ? { types: [change.type, main.type] }
              : {}),
            amount: {
              ...main.amount,
              ...(die ? { dice: die } : {}),
              ...(bonus
                ? {
                    bonus: {
                      ...bonus,
                      add: bonus.add.map((term) =>
                        term.kind === "abilityMod" &&
                        term.ability === from &&
                        ability
                          ? { ...term, ability }
                          : term,
                      ),
                    },
                  }
                : {}),
            },
          },
          ...rest,
          ...(change.extra && tier > 0
            ? [
                {
                  amount: { dice: `${String(count * tier)}d${String(sides)}` },
                  type: change.extra.type,
                },
              ]
            : []),
        ],
      },
    },
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

export function hasSteadySpeed(stats: Stats): boolean {
  return stats.passives.some((passive) => passive.kind === "steadySpeed");
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
  const exhaustion = 2 * stats.exhaustion + stats.ordeal;
  if (attack.flatBonus !== undefined) return attack.flatBonus - exhaustion;
  const ability =
    attack.type === "spell"
      ? (attack.ability ?? stats.spellAbility)
      : attack.ability;
  const proficiency = attack.proficient === false ? 0 : stats.proficiency;
  const item =
    attack.type === "spell"
      ? stats.itemBonuses.spellAttack
      : stats.itemBonuses.attack + (attack.itemBonus ?? 0);
  return (
    proficiency +
    (ability ? modifierFor(stats, ability) : 0) +
    item -
    exhaustion
  );
}

export function saveBonus(stats: Stats, ability: Ability): number {
  return (
    modifierFor(stats, ability) +
    (stats.savingThrows.includes(ability) ? stats.proficiency : 0) +
    stats.itemBonuses.savingThrows -
    2 * stats.exhaustion -
    stats.ordeal
  );
}

export function checkBonus(
  stats: Stats,
  actor: Actor,
  check: { readonly ability: Ability; readonly skill?: Skill },
): number {
  const { skill } = check;
  const proficient = skill !== undefined && stats.skills.includes(skill);
  const expert =
    skill !== undefined &&
    (stats.expertise.includes(skill) ||
      actor.activeEffects.some(
        ({ modifier }) =>
          modifier.kind === "expertise" && modifier.skills?.includes(skill),
      ));
  const half =
    skill !== undefined &&
    stats.passives.some(({ kind }) => kind === "halfProficiency");
  return (
    modifierFor(stats, check.ability) +
    (proficient
      ? stats.proficiency * (expert ? 2 : 1)
      : half
        ? Math.floor(stats.proficiency / 2)
        : 0) +
    stats.itemBonuses.checks -
    2 * actor.exhaustion -
    (actor.ordeal ?? 0)
  );
}

// The least a check or save with this ability can total, as Indomitable Might's Strength score.
export function scoreFloor(stats: Stats, ability: Ability): number {
  return stats.passives.some(
    (passive) => passive.kind === "scoreFloor" && passive.ability === ability,
  )
    ? stats.abilities[ability]
    : -Infinity;
}

export function spellSaveDc(stats: Stats): number {
  return (
    8 + stats.proficiency + spellModifier(stats) + stats.itemBonuses.spellDc
  );
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
        total +=
          (term.roundUp ? Math.ceil : Math.floor)(
            (stats.classLevels[term.class] ?? 0) / (term.half ? 2 : 1),
          ) * (term.times ?? 1);
        break;
      case "level":
        total += term.half ? Math.floor(stats.level / 2) : stats.level;
        break;
      case "scaling":
        total += stats.scaling[term.key] ?? 0;
        break;
      case "bestAbilityMod":
        total += Math.max(
          ...term.abilities.map((ability) => modifierFor(stats, ability)),
        );
        break;
      case "spellMod":
        total += term.ability
          ? modifierFor(stats, term.ability)
          : spellModifier(stats);
        break;
      case "spellSaveDc":
        total += term.ability
          ? 8 +
            stats.proficiency +
            modifierFor(stats, term.ability) +
            stats.itemBonuses.spellDc
          : spellSaveDc(stats);
        break;
      case "maxHp":
        total += term.half ? Math.floor(stats.maxHp / 2) : stats.maxHp;
        break;
      case "abilityScore":
        total += Math.max(
          ...term.abilities.map((ability) => stats.abilities[ability]),
        );
        break;
      case "dealt": // filled in by the reaction it's part of
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

// Rolls again, once, up to `reroll` of the dice that came up below average, the lowest first, and keeps the new rolls.
function rollRerolling(
  notation: string,
  dice: Dice,
  multiplier: number,
  reroll: number,
): number {
  const [count = "0", sides = "0"] = notation.split("d");
  const rolls = Array.from({ length: Number(count) * multiplier }, () =>
    dice.roll(Number(sides)),
  );
  const low = rolls
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value < (Number(sides) + 1) / 2)
    .sort((a, b) => a.value - b.value)
    .slice(0, reroll);
  for (const { index } of low) rolls[index] = dice.roll(Number(sides));
  return rolls.reduce((sum, value) => sum + value, 0);
}

// A scaling key can replace the number of dice (sneakAttackD6) or the die size (martialArtsDie).
export function scaledDice(
  source: {
    readonly dice?: string | undefined;
    readonly diceCount?: string | undefined;
    readonly dieSize?: string | undefined;
    readonly halfDice?: true | undefined;
  },
  scaling: Readonly<Record<string, number>>,
): string | undefined {
  if (!source.dice) return undefined;
  const [count = "0", sides = "0"] = source.dice.split("d");
  const dice = Number(scaling[source.diceCount ?? ""] ?? count);
  const rolled = source.halfDice ? Math.ceil(dice / 2) : dice;
  return `${String(rolled)}d${String(scaling[source.dieSize ?? ""] ?? sides)}`;
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
  if (times <= 0 || "slotOnly" in step) return activation;
  if ("addRadius" in step) {
    const { targeting } = activation;
    return "area" in targeting
      ? {
          ...activation,
          targeting: {
            ...targeting,
            area: {
              ...targeting.area,
              radius: targeting.area.radius + step.addRadius * times,
            },
          },
        }
      : activation;
  }
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
  const steps = step.every
    ? Math.min(step.max ?? times, Math.floor(times / step.every))
    : times;
  if (steps <= 0) return activation;
  const damage = (list: readonly Damage[]): Damage[] =>
    list.map((item) => ({
      ...item,
      amount: addDice(item.amount, step.addDice, steps),
    }));
  const effects = (list: readonly LeafEffect[]): LeafEffect[] =>
    list.map((effect) => {
      if (effect.kind === "heal" || effect.kind === "tempHp") {
        return {
          ...effect,
          amount: addDice(effect.amount, step.addDice, steps),
        };
      }
      if (effect.kind === "modifier" && effect.modifier.kind === "hitDamage") {
        const [hit] = damage([effect.modifier.damage]);
        return hit
          ? { ...effect, modifier: { ...effect.modifier, damage: hit } }
          : effect;
      }
      const { addBonus } = step;
      if (
        addBonus &&
        effect.kind === "modifier" &&
        effect.modifier.kind === "bonus" &&
        effect.modifier.amount.dice === undefined
      ) {
        const { bonus } = effect.modifier.amount;
        return {
          ...effect,
          modifier: {
            ...effect.modifier,
            amount: {
              ...effect.modifier.amount,
              bonus: {
                base: (bonus?.base ?? 0) + addBonus * steps,
                add: bonus?.add ?? [],
              },
            },
          },
        };
      }
      // An extra hit's damage grows too, as Conjure Minor Elementals'.
      if (effect.kind === "modifier" && effect.modifier.kind === "hitDamage") {
        const [scaled] = damage([effect.modifier.damage]);
        return scaled
          ? { ...effect, modifier: { ...effect.modifier, damage: scaled } }
          : effect;
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
  const scaled = (resolution: Resolution): Resolution => {
    switch (resolution.kind) {
      case "automatic":
        return {
          ...resolution,
          damage: damage(resolution.damage),
          effects: effects(resolution.effects),
        };
      case "attack":
        return {
          ...resolution,
          damage: damage(resolution.damage),
          onHit: effects(resolution.onHit),
          onMiss: effects(resolution.onMiss),
          ...(resolution.burst
            ? {
                burst: {
                  ...resolution.burst,
                  damage: damage(resolution.burst.damage),
                },
              }
            : {}),
        };
      case "save":
        return {
          ...resolution,
          damage: damage(resolution.damage),
          onFail: effects(resolution.onFail),
          onSuccess: effects(resolution.onSuccess),
        };
      default:
        return resolution satisfies never;
    }
  };
  // What an area it leaves does later grows with the slot too, as Spirit Guardians' damage does, and so does
  // what strikes in a hit's place, as Lightning Arrow's.
  const { area, trigger } = activation;
  return {
    ...activation,
    ...(trigger?.replacesHit
      ? { trigger: { ...trigger, replacesHit: damage(trigger.replacesHit) } }
      : {}),
    resolution: scaled(activation.resolution),
    ...(area?.resolution || area?.holding
      ? {
          area: {
            ...area,
            ...(area.resolution ? { resolution: scaled(area.resolution) } : {}),
            ...(area.holding ? { holding: scaled(area.holding) } : {}),
          },
        }
      : {}),
  };
}

// Dice whose 1s are rolled again once, the new roll standing, as with Healing Rerolls or Tavern Brawler.
export function rerollingOnes(dice: Dice): Dice {
  return {
    ...dice,
    roll: (sides) => {
      const rolled = dice.roll(sides);
      return rolled === 1 ? dice.roll(sides) : rolled;
    },
  };
}

export function rollAmount(
  amount: Amount,
  stats: Stats,
  dice: Dice,
  diceMultiplier = 1,
): number {
  const notation = scaledDice(amount, stats.scaling);
  const rolling = amount.rerollOnes ? rerollingOnes(dice) : dice;
  const rolled = notation
    ? amount.reroll
      ? rollRerolling(notation, rolling, diceMultiplier, amount.reroll)
      : rollDiceNotation(notation, rolling, diceMultiplier)
    : 0;
  return rolled + (amount.bonus ? evaluateFormula(amount.bonus, stats) : 0);
}

export function damageResponses(
  actor: Actor,
  access: ContentAccess & { readonly state?: DndState },
): {
  readonly adjustments: readonly number[];
  readonly resistances: readonly DamageType[];
  readonly vulnerabilities: readonly DamageType[];
  readonly immunities: readonly DamageType[];
  readonly absorbs: readonly DamageType[];
} {
  const resistances: DamageType[] = [];
  const vulnerabilities: DamageType[] = [];
  const immunities: DamageType[] = [];
  // Petrified gives Resistance to all damage.
  if (hasCondition(actor, "petrified")) resistances.push(...DAMAGE_TYPES);
  const stats = deriveStats(actor, access);
  // Resistance to all but some types while Bloodied, or in Dim Light or Darkness, as Boon of Desperate Resilience or
  // Boon of the Night Spirit's Shadowy Form gives.
  for (const passive of stats.passives) {
    if (passive.kind !== "resistAll") continue;
    const active =
      passive.while === "bloodied"
        ? actor.hp * 2 <= stats.maxHp
        : access.state !== undefined &&
          lightAt(actor.position, access.state, access) !== "bright";
    if (active) {
      resistances.push(
        ...DAMAGE_TYPES.filter((type) => !passive.except.includes(type)),
      );
    }
  }
  for (const modifier of [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
    // What the spells' areas it stands in give it, as Silence's Immunity to Thunder damage. Monster auras grant
    // none, so their stat blocks aren't read on every hit.
    ...(access.state ? zoneModifiers(actor, access.state) : []),
  ]) {
    if (modifier.kind === "resistance") resistances.push(modifier.damage);
    if (modifier.kind === "vulnerability")
      vulnerabilities.push(modifier.damage);
    if (modifier.kind === "immunity") immunities.push(modifier.damage);
  }
  const absorbs = stats.passives.flatMap((passive) =>
    passive.kind === "absorb" ? passive.damage : [],
  );
  return { adjustments: [], resistances, vulnerabilities, immunities, absorbs };
}
