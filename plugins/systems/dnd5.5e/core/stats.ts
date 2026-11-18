import type { ContentAccess, Dice } from "#sdk";
import type { z } from "zod";
import { environmentPassives } from "./environment.ts";
import {
  carriedWeight,
  carryingCapacity,
  encumberedSpeed,
  encumbrance,
} from "./carry.ts";
import { ENCUMBRANCE, variantOn } from "./variant-rules.ts";
import { hasAspect, pactWeaponId } from "./combat/queries.ts";
import {
  type Actor,
  type DndState,
  effectiveBuild,
  equipped,
  hasCondition,
  turnId,
} from "./state.ts";
import { lightAt } from "./sight.ts";
import {
  currentShape,
  formKept,
  formModifier,
  formOf,
  usableIn,
} from "./forms.ts";
import {
  ALL_SKILLS,
  type Item,
  type ItemCast,
  type Targeting,
  type ResourceDef,
  DAMAGE_TYPES,
  ABILITIES,
  type Ability,
  type AbilityScores,
  type Activation,
  type Duration,
  ActivationSchema,
  type FreeCast,
  type Amount,
  type AreaEffect,
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
  SkillSchema,
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
import {
  freeOption,
  holdsConcentration,
  keepsHidden,
  withMetamagic,
} from "./metamagic.ts";
import { withInvocations } from "./invocations.ts";
import {
  CAST_OPTION_PREFIX,
  castOptionsOf,
  waitingOptions,
  withCastOptions,
} from "./cast-options.ts";
import { withWeaponRiders } from "./weapon-riders.ts";
import {
  GRANTED_PREFIX,
  ITEM_PREFIX,
  THROW_PREFIX,
  WEAPON_PREFIX,
  castFrom,
  itemCastId,
  itemUseId,
  itemUseOf,
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

// A content entry parsed once, as `lookup` does, or undefined when it's missing or doesn't fit the schema.
const maybeParsed = new WeakMap<object, Map<z.ZodType, unknown>>();
export function maybeLookup<T>(
  access: Pick<ContentAccess, "content">,
  schema: z.ZodType<T>,
  id: string,
): T | undefined {
  const entry = access.content(id);
  if (!entry || typeof entry !== "object") return undefined;
  let bySchema = maybeParsed.get(entry);
  if (!bySchema) {
    bySchema = new Map<z.ZodType, unknown>();
    maybeParsed.set(entry, bySchema);
  }
  if (!bySchema.has(schema)) bySchema.set(schema, schema.safeParse(entry).data);
  return bySchema.get(schema) as T | undefined;
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
  readonly ammunition?: string; // the magic ammunition it fires, which a hit spends (combat/attack.ts landHit)
  readonly stored?: string; // the item it's cast from, which no longer holds it once cast (storedCasts)
  // A check made as it's taken, which on a failure wastes it, as reading a Spell Scroll above the reader's level
  // (combat/actions.ts castAction).
  readonly castCheck?: {
    readonly ability: Ability;
    readonly skill?: Skill;
    readonly dc: number;
    readonly keep?: string; // a resource a failure doesn't spend
    readonly chance?: number; // in place of the check, the percent chance it fails, as a Wind Fan's tearing
    readonly breaks?: string; // the item a failure destroys
    readonly table?: string; // the content whose table a failure rolls on, as a Hat of Many Spells
  };
  readonly onceKeys?: readonly string[]; // once-a-turn uses its cast spends, as a `spellDamage` bonus (combat/actions.ts)
  readonly saveDice?: string; // dice taken off each target's first save, as Modify Magic's Tenacious Spell (cast-options.ts)
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
    Partial<Record<"fly" | "climb" | "burrow" | "swim", number>>
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

// Character builds whose features give an aura, filled in as their stats are derived.
export const auraBuilds = new WeakMap<object, boolean>();

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
    armorTypes?: readonly string[]; // the armor worn: none for a monster's printed AC
    shielded?: boolean;
    proficiency?: number;
  },
): number {
  const dex = abilityModifier(abilities.dex);
  const armorTypes = context.armorTypes ?? [];
  // Only one way of calculating AC applies at a time, so the best one is used.
  const bases = [10 + dex, ...context.armorBases];
  const fixed = passiveModifiers(context.passives);
  // shortcut: Mage Armor's rule about not wearing armor isn't checked, since the best calculation wins anyway.
  for (const modifier of [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...fixed,
  ]) {
    if (modifier.kind !== "acFormula") continue;
    if (modifier.unarmored && armorTypes.length > 0) continue;
    if (modifier.noShield && context.shielded) continue;
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
  // A flat AC bonus, its ability modifiers worked out, as Bladesong's Intelligence; one tied to armor only with it on.
  const flat = (
    modifier: Actor["activeEffects"][number]["modifier"],
  ): number | null => {
    if (
      modifier.kind !== "bonus" ||
      modifier.to !== "ac" ||
      modifier.melee ||
      modifier.ranged ||
      (modifier.armor === "any" && armorTypes.length === 0) ||
      (modifier.armor === "heavy" && !armorTypes.includes("heavy"))
    ) {
      return null;
    }
    const formula = modifier.amount.bonus;
    if (!formula) return 0;
    const sum = formula.add.reduce(
      (total, term) =>
        term.kind === "abilityMod"
          ? total + abilityModifier(abilities[term.ability])
          : term.kind === "proficiency"
            ? total + (context.proficiency ?? 0)
            : total,
      formula.base,
    );
    return formula.min === undefined ? sum : Math.max(formula.min, sum);
  };
  let bonus = fixed.reduce(
    (total, modifier) => total + (flat(modifier) ?? 0),
    context.flatBonus,
  );
  const seen = new Set<string>();
  for (const effect of actor.activeEffects) {
    const amount = flat(effect.modifier);
    if (amount !== null) {
      if (!seen.has(effect.sourceId)) bonus += amount;
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
  items: readonly Extract<
    z.infer<typeof ItemSchema>,
    { type: "magicItem" | "weapon" }
  >[],
  attuned: readonly string[] = [],
): AbilityScores {
  const raised = { ...scores };
  const changes = items.flatMap((item) =>
    item.type === "weapon"
      ? (item.abilities ?? [])
      : (item.abilities ?? item.variants?.[0]?.abilities ?? []),
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
  // Might of Giants: more on top, with the other item attuned.
  for (const change of changes) {
    if (
      "boost" in change &&
      attuned.some((id) =>
        change.attunedTo.some((to) => id === to || id.startsWith(`${to}--`)),
      )
    ) {
      raised[change.ability] = Math.min(
        change.max,
        raised[change.ability] + change.boost,
      );
    }
  }
  return raised;
}

// The activation with `bonus` added to each save DC worked out from its caster's spellcasting, as a Rod of the Pact
// Keeper's for a Warlock spell.
function withDcBonus(activation: Activation, bonus: number): Activation {
  return JSON.parse(JSON.stringify(activation), (_key, value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    "add" in value &&
    Array.isArray(value.add) &&
    value.add.some(
      (term: unknown) =>
        typeof term === "object" &&
        term !== null &&
        "kind" in term &&
        term.kind === "spellSaveDc",
    )
      ? {
          ...value,
          base:
            ("base" in value && typeof value.base === "number"
              ? value.base
              : 0) + bonus,
        }
      : value,
  ) as Activation;
}

// Scores an effect on the character sets while it lasts, as a Potion of Giant Strength's, never lowering one unless
// `exact`, as Wish's stress Strength of 3.
function withEffectScores(scores: AbilityScores, actor: Actor): AbilityScores {
  const set = { ...scores };
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "setScore") {
      set[modifier.ability] = modifier.exact
        ? modifier.score
        : Math.max(set[modifier.ability], modifier.score);
    }
  }
  return set;
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

// A leveled spell a feat or feature lets the character cast without a slot, as its own action (FreeCastSchema). The
// ways a spell has share one action and pool when they're its own once-a-rest uses, as Hex from two traits, and each
// spending another resource is an action of its own, "spell:<spell>:free:<resource>" after the first.
function freeCastActions(
  spells: ReadonlyMap<string, readonly FreeCast[]>,
  access: ContentAccess,
  level: number,
): { action: KnownAction; resource: Feature["resources"][number] | null }[] {
  return [...spells].flatMap(([spellId, ways]) => {
    if (!access.content(spellId)) return [];
    const spell = lookup(access, SpellSchema, spellId);
    const { activation } = spell;
    const quick = (how: FreeCast) => typeof how === "object" && how.bonusAction;
    if (!activation || (spell.level === 0 && !ways.some(quick))) return [];
    if (!doesSomething(activation.resolution)) return [];
    const isOwn = (how: FreeCast) => how === true || how === "shortRest";
    const own = ways.filter(isOwn);
    const [first] = own;
    const kinds = [
      ...(first === undefined ? [] : [first]),
      ...new Set(ways.filter((how) => !isOwn(how))),
    ];
    return kinds.flatMap((how, index) => {
      if (spell.level === 0 && !quick(how)) return [];
      const id =
        typeof how === "object" && how.resource
          ? how.resource
          : `free:${spellId}`;
      const unlimited =
        how === "atWill" || (typeof how === "object" && !how.resource);
      const slot =
        typeof how === "object" && how.slotLevel
          ? Object.entries(how.slotLevel)
              .filter(([from]) => Number(from) <= level)
              .reduce((best, [, at]) => Math.max(best, at), 0)
          : spell.level;
      if (slot < spell.level) return [];
      const step = spell.upcast?.perSlotLevel;
      const leveled =
        spell.level === 0 && spell.cantrip
          ? scaleActivation(
              activation,
              spell.cantrip.perTier,
              cantripTier(level),
            )
          : slot > spell.level && step
            ? scaleActivation(activation, step, slot - spell.level)
            : activation;
      const lasting =
        typeof how === "object" && how.minutes !== undefined
          ? unconcentrated(leveled, how.minutes)
          : leveled;
      const targeted =
        typeof how === "object" && how.self
          ? { ...lasting, targeting: { self: true as const } }
          : lasting;
      const cast =
        typeof how === "object" && how.whileIn
          ? { ...targeted, whileIn: how.whileIn }
          : targeted;
      const suffix =
        index === 0
          ? ""
          : `:${typeof how === "object" ? (how.resource ?? "free") : how}`;
      return [
        {
          action: {
            id: `spell:${spellId}:free${suffix}`,
            name: `${spell.name} (free)`,
            activation: {
              ...cast,
              cost: [
                ...activation.cost
                  .filter((cost) => cost !== "slot")
                  .map((cost) =>
                    quick(how) && cost === "action" ? "bonusAction" : cost,
                  ),
                ...(unlimited
                  ? []
                  : [
                      typeof how === "object" && how.perLevel && slot > 1
                        ? { resource: id, count: slot }
                        : { resource: id },
                    ]),
              ],
            },
            spellLevel: slot,
          },
          resource: isOwn(how)
            ? {
                id,
                max: { base: own.length, add: [] },
                recharge: [
                  {
                    on: how === true ? "longRest" : "shortRest",
                    amount: "all",
                  },
                ],
              }
            : null,
        },
      ];
    });
  });
}

// A trait's own cantrips, before any swap (swap.ts).
export function traitCantrips(
  feature: Pick<Feature, "spells">,
  access: ContentAccess,
): readonly string[] {
  return Object.values(feature.spells ?? {})
    .flat()
    .filter(
      (id) =>
        Boolean(access.content(id)) &&
        lookup(access, SpellSchema, id).level === 0,
    );
}

// Where the late picks of a feat's choice are kept in `swaps` (swap.ts), and back.
export function latePickKey(feat: string, choice: string): string {
  return `pick:${feat}#${choice}`;
}
function latePicks(
  swaps: Readonly<Record<string, readonly string[]>>,
  feats: ReadonlySet<string>,
  access: ContentAccess,
): { feat: string; spells: readonly string[]; freeCast?: FreeCast }[] {
  return Object.entries(swaps).flatMap(([key, spells]) => {
    const hash = key.lastIndexOf("#");
    if (!key.startsWith("pick:") || hash < 0) return [];
    const feat = key.slice(5, hash);
    if (!feats.has(feat)) return [];
    const choice = lookup(access, FeatSchema, feat).choices.find(
      (item) => item.id === key.slice(hash + 1),
    );
    if (choice?.kind !== "spells") return [];
    return [
      {
        feat,
        spells,
        ...(choice.freeCast ? { freeCast: choice.freeCast } : {}),
      },
    ];
  });
}

// How a feature casts one of its spells without a slot: all alike, or each as its own entry says.
function freeCastOf(
  how: Feature["freeCast"],
  spell: string,
): FreeCast | undefined {
  if (how === undefined || how === true || typeof how === "string") return how;
  return "resource" in how && typeof how.resource === "string"
    ? how
    : (how as Record<string, FreeCast>)[spell];
}

// A feature's spells with a trait's cantrip swapped after a Long Rest (swap.ts).
function swappedSpells(
  id: string,
  feature: Pick<Feature, "spells" | "swapCantrip">,
  swaps: Readonly<Record<string, readonly string[]>>,
  access: ContentAccess,
): Feature["spells"] {
  const swapped = swaps[`trait:${id}`];
  if (!feature.swapCantrip || !swapped) return feature.spells;
  const cantrips = traitCantrips(feature, access);
  const entries = Object.entries(feature.spells ?? {});
  return Object.fromEntries(
    entries.map(([from, ids], index) => [
      from,
      [
        ...ids.filter((spell) => !cantrips.includes(spell)),
        ...(index === 0 ? swapped : []),
      ],
    ]),
  );
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
export function spellNamed(
  slug: string,
  access: ContentAccess,
): string | undefined {
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
export function withItemNumbers(
  activation: Activation,
  dc: number | undefined,
  attack: number | undefined,
  mod?: number, // the spellcasting modifier, as a stored spell's caster's
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
    const fixed = (kind: string, amount: number | undefined): boolean =>
      amount !== undefined && terms.some((term) => term.kind === kind);
    if (fixed("spellSaveDc", dc) || fixed("spellMod", mod)) {
      const replaced = terms.filter(
        (term) =>
          (term.kind === "spellSaveDc" && dc !== undefined) ||
          (term.kind === "spellMod" && mod !== undefined),
      );
      return {
        ...copy,
        base:
          (typeof copy.base === "number" ? copy.base : 0) +
          replaced.reduce(
            (total, term) =>
              total + (term.kind === "spellSaveDc" ? (dc ?? 0) : (mod ?? 0)),
            0,
          ),
        add: terms.filter((term) => !replaced.includes(term)),
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
  actor: Actor,
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
      const numbered = limitedCast(
        withItemNumbers(scaled, cast.dc, cast.attack),
        cast,
      );
      const used = resource ? (actor.resourcesSpent[resource] ?? 0) : 0;
      return [
        {
          id: itemCastId(spellId, itemId, charges),
          name:
            cast.upTo === undefined
              ? `${spell.name} (${item.name})`
              : `${spell.name}, level ${String(at)} (${item.name})`,
          activation: {
            ...numbered,
            ...(cast.doom
              ? {
                  userEffects: [
                    ...(numbered.userEffects ?? []),
                    {
                      kind: "slay" as const,
                      hpAtMost: Number.MAX_SAFE_INTEGER,
                      chance: cast.doom,
                    },
                  ],
                }
              : {}),
            cost: [
              ...activation.cost
                .map((cost) =>
                  cast.bonusAction && cost === "action" ? "bonusAction" : cost,
                )
                .filter(
                  (cost) =>
                    cost !== "slot" &&
                    !(
                      cast.gold !== undefined &&
                      typeof cost === "object" &&
                      "gold" in cost
                    ),
                ),
              // the item's own costly component in place of the spell's, as Cauldron of Rebirth's salt
              ...(cast.gold ? [{ gold: cast.gold }] : []),
              ...(charges > 0 && resource
                ? [{ resource, ...(charges > 1 ? { count: charges } : {}) }]
                : []),
            ],
          },
          spellLevel: at,
          ...(lasting ? { concentrates: true as const } : {}),
          // A Wind Fan used again before dawn may tear.
          ...(cast.tears && used > 0
            ? {
                castCheck: {
                  ability: "int" as const,
                  dc: 0,
                  chance: Math.min(100, cast.tears * used),
                  breaks: itemId,
                },
              }
            : {}),
        },
      ];
    });
  });
}

// An item's cast with its limits (ItemCastSchema): on its caster alone, an area of its size, only some creatures,
// and how some creatures' saves go.
function limitedCast(activation: Activation, cast: ItemCast): Activation {
  const { targeting, resolution } = activation;
  const narrowed: Targeting = cast.self
    ? { self: true }
    : "area" in targeting
      ? {
          ...targeting,
          ...(cast.radius
            ? { area: { ...targeting.area, radius: cast.radius } }
            : {}),
          ...(cast.creatureTypes ? { creatureTypes: cast.creatureTypes } : {}),
        }
      : "creatures" in targeting
        ? {
            ...targeting,
            ...(cast.creatureTypes
              ? { creatureTypes: cast.creatureTypes }
              : {}),
            ...(cast.swimmers ? { swimmers: true as const } : {}),
          }
        : targeting;
  return {
    ...activation,
    targeting: narrowed,
    resolution:
      cast.edges && resolution.kind === "save"
        ? { ...resolution, edges: [...(resolution.edges ?? []), ...cast.edges] }
        : resolution,
  };
}

// Every spell by its name after the plugin, from the book that leads, as spellNamed finds them.
const leadingSpells = new WeakMap<readonly string[], readonly string[]>();
function allSpells(access: ContentAccess): readonly string[] {
  const ids = access.contentIds();
  let found = leadingSpells.get(ids);
  if (!found) {
    found = ids.filter((id) => {
      const at = id.indexOf(":spell/");
      return at >= 0 && spellNamed(id.slice(at + 7), access) === id;
    });
    leadingSpells.set(ids, found);
  }
  return found;
}

// The spells on a class's list that do something in a fight, worked out once for the content loaded.
const listed = new WeakMap<readonly string[], Map<string, readonly string[]>>();
function classSpells(
  className: string,
  access: ContentAccess,
): readonly string[] {
  const ids = access.contentIds();
  let byClass = listed.get(ids);
  if (!byClass) {
    byClass = new Map();
    listed.set(ids, byClass);
  }
  let found = byClass.get(className);
  if (!found) {
    found = allSpells(access).filter((spellId) => {
      const spell = lookup(access, SpellSchema, spellId);
      return (
        spell.activation !== undefined &&
        onClassList(spell, [className]) &&
        doesSomething(spell.activation.resolution)
      );
    });
    byClass.set(className, found);
  }
  return found;
}

// The spells an item lets its bearer try to cast without knowing them (MagicItemSchema `unknownSpell`): each behind
// its Arcana check, spending the item's use, and for a leveled spell a slot of its level.
function unknownSpells(
  itemId: string,
  item: Item,
  known: ReadonlySet<string>,
  highest: number,
  ability: Ability,
  level: number,
  access: ContentAccess,
): KnownAction[] {
  if (item.type !== "magicItem" || !item.unknownSpell) return [];
  const rule = item.unknownSpell;
  return classSpells(rule.class, access).flatMap((spellId): KnownAction[] => {
    const spell = lookup(access, SpellSchema, spellId);
    const activation = spell.activation;
    if (
      !activation ||
      known.has(spellId) ||
      (rule.cantrips
        ? spell.level !== 0
        : spell.level < 1 || spell.level > highest) ||
      (rule.action && !activation.cost.includes("action"))
    ) {
      return [];
    }
    const scaled =
      spell.level === 0 && spell.cantrip
        ? scaleActivation(activation, spell.cantrip.perTier, cantripTier(level))
        : activation;
    const cast = castWith(scaled, ability);
    return [
      {
        id: itemCastId(spellId, itemId, 0),
        name: `${spell.name} (${item.name})`,
        activation: {
          ...cast,
          cost: [...cast.cost, { resource: rule.resource }],
        },
        spellLevel: spell.level,
        upcast: spell.upcast,
        castCheck: {
          ability: "int",
          skill: "arcana",
          dc: rule.dc + (rule.perLevel ? spell.level : 0),
          ...(rule.keepOnFailure ? { keep: rule.resource } : {}),
          ...(rule.failTable ? { table: itemId } : {}),
        },
      },
    ];
  });
}

// The spells stored in a worn item, each cast once with the slot and numbers it was stored with, as from a Ring of
// Spell Storing. Two of one spell are one action, which casts the first stored.
function storedCasts(
  itemId: string,
  item: Item,
  actor: Actor,
  access: ContentAccess,
): KnownAction[] {
  if (item.type !== "magicItem" || !item.storesSpells) return [];
  const seen = new Set<string>();
  return (actor.storedSpells?.[itemId] ?? []).flatMap((stored) => {
    const spell = SpellSchema.safeParse(access.content(stored.spell)).data;
    if (!spell?.activation || seen.has(stored.spell)) return [];
    seen.add(stored.spell);
    const step = spell.upcast?.perSlotLevel;
    const scaled = step
      ? scaleActivation(spell.activation, step, stored.level - spell.level)
      : spell.activation;
    const numbered = withItemNumbers(
      scaled,
      stored.dc,
      stored.attack,
      stored.mod,
    );
    const lasting =
      spell.lasting &&
      typeof spell.duration === "object" &&
      "concentration" in spell.duration;
    return [
      {
        id: itemCastId(stored.spell, itemId, 0),
        name: `${spell.name}, level ${String(stored.level)} (${item.name})`,
        activation: {
          ...numbered,
          cost: numbered.cost.filter(
            (cost) =>
              cost !== "slot" && !(typeof cost === "object" && "gold" in cost),
          ),
        },
        spellLevel: stored.level,
        stored: itemId,
        ...(lasting ? { concentrates: true as const } : {}),
      },
    ];
  });
}

// A worn item's own activations (ChargedSchema `activations`), named after it, as a Pearl of Power's.
function itemUses(itemId: string, item: Item, actor: Actor): KnownAction[] {
  const uses = "activations" in item ? (item.activations ?? []) : [];
  return uses.flatMap(({ name, activation, whileCharged, rolled }, index) =>
    whileCharged && !charged(actor, item, whileCharged)
      ? []
      : [
          {
            id: itemUseId(itemId, index),
            name: uses.length > 1 ? `${name} (${item.name})` : name,
            activation,
            spellLevel: null,
            ...(rolled ? { rolled: true as const } : {}),
          },
        ],
  );
}

// Whether one of the item's pools has a use left, as a Helm of Brilliance's rubies.
// shortcut: a pool's maximum here is its base and what was rolled, without terms worked out from the bearer.
function charged(actor: Actor, item: Item, resource: string): boolean {
  const def = chargesOf(item).resources.find((pool) => pool.id === resource);
  if (!def) return false;
  const most =
    def.max.base +
    (actor.rolledPools?.[resource] ?? (def.rolled ? diceCount(def.rolled) : 0));
  return most - (actor.resourcesSpent[resource] ?? 0) > 0;
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
  swaps: Readonly<Record<string, readonly string[]>> = {},
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
      const feature = maybeLookup(access, FeatureSchema, grant);
      const own = feature && swappedSpells(grant, feature, swaps, access);
      for (const spells of [
        own,
        feature?.spellsBySlot,
        { castsOnly: feature?.castsOnly ?? [] },
      ]) {
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
  for (const pick of latePicks(swaps, new Set(byFeat.keys()), access)) {
    const ability = byFeat.get(pick.feat);
    if (ability) for (const spell of pick.spells) bySpell.set(spell, ability);
  }
  return bySpell;
}

// A feature's changes to a spell: its hit damage's die (Foe Slayer) and effects it adds (Eldritch Hex).
function spellChanged(
  activation: Activation,
  dice: string | undefined,
  adds: readonly LeafEffect[] | undefined,
): Activation {
  const { resolution } = activation;
  if (resolution.kind !== "automatic" || (!dice && !adds)) return activation;
  const effects = resolution.effects.map((effect): LeafEffect =>
    dice &&
    effect.kind === "modifier" &&
    effect.modifier.kind === "hitDamage" &&
    effect.modifier.damage.amount.dice
      ? {
          ...effect,
          modifier: {
            ...effect.modifier,
            damage: {
              ...effect.modifier.damage,
              amount: { ...effect.modifier.damage.amount, dice },
            },
          },
        }
      : effect,
  );
  return {
    ...activation,
    resolution: { ...resolution, effects: [...effects, ...(adds ?? [])] },
  };
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

// Whether it's the actor's own turn in a fight's first round, as Ambusher's Leap's.
export function ownFirstTurn(actor: Actor, access: ContentAccess): boolean {
  const combat = (access as ContentAccess & { readonly state?: DndState }).state
    ?.combat;
  return combat?.round === 1 && turnId(combat) === actor.id;
}

// Whether it's the actor's own turn and it has taken its action, as for Blade Flourish's Speed.
// shortcut: any action counts, not only the Attack action.
function ownTurnActed(actor: Actor, access: ContentAccess): boolean {
  const combat = (access as ContentAccess & { readonly state?: DndState }).state
    ?.combat;
  return turnId(combat) === actor.id && !actor.budget.action;
}

// The variants picked for a feature, or for the feature it follows; with none picked, as many as it gives at first.
export function pickedVariants(
  feature: Feature,
  variants: Readonly<Record<string, readonly string[]>>,
): NonNullable<Feature["variants"]> {
  const options = feature.variants ?? [];
  const ids = variants[feature.follows ?? feature.id] ?? [];
  const picked = options.filter(({ id }) => ids.includes(id));
  return picked.length > 0
    ? picked
    : options.slice(0, feature.variantPicks?.count ?? 1);
}

// A feature with the variants picked for it joined in.
export function withVariant(
  feature: Feature,
  variants: Readonly<Record<string, readonly string[]>>,
): Feature {
  if (!feature.variants) return feature;
  const picked = pickedVariants(feature, variants);
  return picked.length > 0
    ? {
        ...feature,
        name: `${feature.name} (${picked.map(({ name }) => name).join(", ")})`,
        passives: [
          ...feature.passives,
          ...picked.flatMap((item) => item.passives),
        ],
        activations: [
          ...feature.activations,
          ...picked.flatMap((item) => item.activations),
        ],
        resources: [
          ...feature.resources,
          ...picked.flatMap((item) => item.resources),
        ],
        ...(picked.some((item) => item.spells)
          ? {
              spells: picked.reduce<Record<string, string[]>>(
                (all, item) => {
                  for (const [at, ids] of Object.entries(item.spells ?? {})) {
                    all[at] = [...(all[at] ?? []), ...ids];
                  }
                  return all;
                },
                Object.fromEntries(
                  Object.entries(feature.spells ?? {}).map(([at, ids]) => [
                    at,
                    [...ids],
                  ]),
                ),
              ),
            }
          : {}),
      }
    : feature;
}

function collectFeatureData(
  access: ContentAccess,
  featureIds: readonly string[],
  level = 1,
  highestSlot = 0,
  feats: ReadonlySet<string> = new Set(),
  classLevels: Readonly<Record<string, number>> = {},
  variants: Readonly<Record<string, readonly string[]>> = {},
  swaps: Readonly<Record<string, readonly string[]>> = {},
  grantedBy: ReadonlyMap<string, string> = new Map(),
): {
  passives: Passive[];
  actions: KnownAction[];
  resources: Feature["resources"];
  spells: string[];
  free: [string, FreeCast][];
  retype: Record<string, DamageType>;
  redice: Record<string, string>;
  addsTo: Record<string, readonly LeafEffect[]>;
  abilities: ReadonlyMap<string, Ability>;
  gated: readonly NonNullable<Feature["whileActive"]>[];
} {
  const passives: Passive[] = [];
  const actions: KnownAction[] = [];
  const resources: Feature["resources"] = [];
  // A class or subclass feature's spells come by that class's level, as a subclass table's "Cleric Level".
  const levelFor = (id: string) =>
    classLevels[grantedBy.get(id) ?? ""] ?? level;
  const spells = featureIds.flatMap((id) => grantedSpells(id, levelFor(id)));
  const free: [string, FreeCast][] = [];
  const retype: Record<string, DamageType> = {};
  const redice: Record<string, string> = {};
  const addsTo: Record<string, readonly LeafEffect[]> = {};
  const ownSpells = new Map<string, readonly string[]>(); // each feature's own spells, by feature
  const gated: NonNullable<Feature["whileActive"]>[] = []; // passives only while an effect is on the bearer
  const abilities = new Map<string, Ability>(); // a feature's spells cast with its own ability
  // Activations a later feature's variant takes the place of, by the feature they're on (`replaces`).
  const replaced = new Map<string, Set<string>>();
  for (const id of featureIds) {
    const feature = lookup(access, FeatureSchema, id);
    const labels = pickedVariants(feature, variants).flatMap(
      (item) => item.replaces ?? [],
    );
    if (
      feature.follows &&
      labels.length > 0 &&
      (feature.fromLevel ?? 1) <= level
    ) {
      replaced.set(feature.follows, new Set(labels));
    }
    const { overrides } = featureRules(feature);
    if (overrides && (feature.fromLevel ?? 1) <= level) {
      replaced.set(
        overrides.feature,
        new Set([
          ...(replaced.get(overrides.feature) ?? []),
          ...overrides.labels,
        ]),
      );
    }
  }
  for (const id of featureIds) {
    const feature = withVariant(
      featureRules(lookup(access, FeatureSchema, id)),
      variants,
    );
    if ((feature.fromLevel ?? 1) > level) continue;
    Object.assign(retype, feature.retype);
    Object.assign(redice, feature.redice);
    for (const [spell, effects] of Object.entries(feature.addsTo ?? {})) {
      addsTo[spell] = [...(addsTo[spell] ?? []), ...effects];
    }
    passives.push(...feature.passives);
    if (feature.whileActive) gated.push(feature.whileActive);
    resources.push(...feature.resources);
    const own: string[] = [];
    for (const [from, ids] of Object.entries(
      swappedSpells(id, feature, swaps, access) ?? {},
    )) {
      if (Number(from) > levelFor(id)) continue;
      own.push(...ids);
      for (const spell of ids) {
        const how = freeCastOf(feature.freeCast, spell);
        if (how) free.push([spell, how]);
      }
    }
    spells.push(...own);
    ownSpells.set(id, own);
    if (feature.spellAbility) {
      for (const spell of own) abilities.set(spell, feature.spellAbility);
    }
    const { preparedWith } = feature;
    const prepared =
      preparedWith && feats.has(preparedWith.feat) ? preparedWith : undefined;
    for (const [slot, ids] of Object.entries({
      ...feature.spellsBySlot,
      ...prepared?.spells,
    })) {
      if (Number(slot) > highestSlot) continue;
      spells.push(...ids);
      if (prepared?.spells[slot] === ids) own.push(...ids);
    }
    for (const spell of feature.castsOnly ?? []) {
      const how = freeCastOf(feature.freeCast, spell);
      if (how) free.push([spell, how]);
    }
    const extra = prepared?.freeCast;
    if (extra)
      free.push(...own.map((spell): [string, FreeCast] => [spell, extra]));
    feature.activations.forEach((activation, index) => {
      if (activation.label && replaced.get(id)?.has(activation.label)) return;
      actions.push({
        id: `feature:${id}:${String(index)}`,
        name: activation.label
          ? `${feature.name} (${activation.label})`
          : feature.name,
        activation: classTiered(
          feature.perTier
            ? scaleActivation(activation, feature.perTier, cantripTier(level))
            : activation,
          feature.classTiers,
          classLevels,
        ),
        spellLevel: null,
        ...(feature.upcast ? { upcast: feature.upcast } : {}),
        ...(feature.hitType ? { hitType: true as const } : {}),
      });
    });
  }
  for (const id of featureIds) {
    const from = maybeLookup(access, FeatureSchema, id)?.freeCastsFrom;
    if (!from) continue;
    for (const spell of ownSpells.get(from.feature) ?? []) {
      const known = maybeLookup(access, SpellSchema, spell);
      const level = known?.level;
      if (from.schools && !(known && from.schools.includes(known.school))) {
        continue;
      }
      if (level) {
        free.push([
          spell,
          {
            resource: from.resource,
            ...(from.perLevel ? { perLevel: true as const } : {}),
          },
        ]);
      }
    }
  }
  return {
    passives,
    actions,
    resources,
    spells,
    free,
    retype,
    redice,
    addsTo,
    abilities,
    gated,
  };
}

// An attack with `emptyHanded` dice rolls them while the bearer holds no weapon or Shield, as Unarmed Fighting's d8.
function emptyHanded(
  actions: readonly KnownAction[],
  actor: Actor,
  access: ContentAccess,
): KnownAction[] {
  const holding = equipped(actor).some((id) => {
    const item = ItemSchema.safeParse(access.content(id)).data;
    return item?.type === "weapon" || item?.type === "shield";
  });
  return actions.map((action) => {
    const dice = action.activation.emptyHanded;
    const { resolution } = action.activation;
    const [first, ...rest] = resolution.damage;
    if (!dice || holding || !first) return action;
    return {
      ...action,
      activation: {
        ...action.activation,
        resolution: {
          ...resolution,
          damage: [{ ...first, amount: { ...first.amount, dice } }, ...rest],
        },
      },
    };
  });
}

// Potent Cantrip: a damaging cantrip's miss or successful save still deals half its damage.
function withPotentCantrips(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  if (!passives.some((passive) => passive.kind === "potentCantrip")) {
    return [...actions];
  }
  return actions.map((action) => {
    const { resolution } = action.activation;
    if (
      action.spellLevel !== 0 ||
      spellOfSource(action.id) === null ||
      resolution.damage.length === 0
    ) {
      return action;
    }
    const potent =
      resolution.kind === "save" && resolution.onSuccessDamage === "none"
        ? { ...resolution, onSuccessDamage: "half" as const }
        : resolution.kind === "attack" && !resolution.missDamage
          ? { ...resolution, missDamage: "half" as const }
          : resolution;
    return potent === resolution
      ? action
      : { ...action, activation: { ...action.activation, resolution: potent } };
  });
}

// Whether this cast needs no components (`silentCasting`, or Subtle Spell waiting on it), so nobody sees it cast.
export function castsSilently(
  actor: Actor,
  action: KnownAction,
  stats: Pick<Stats, "passives">,
  access: ContentAccess,
): boolean {
  if (keepsHidden(actor, action.id)) return true;
  const spellId = spellOfSource(action.id);
  if (spellId === null) return false;
  const spell = maybeLookup(access, SpellSchema, spellId);
  return stats.passives.some(
    (passive) =>
      passive.kind === "silentCasting" &&
      (!passive.schools || (spell && passive.schools.includes(spell.school))) &&
      (!passive.list || onList(spellId, spell, passive.list, access)) &&
      (!passive.spells || passive.spells.includes(spellId)) &&
      (!passive.slot || action.activation.cost.includes("slot")) &&
      (!passive.via ||
        (/:free(:|$)/.test(action.id) &&
          action.activation.cost.some(
            (cost) =>
              typeof cost === "object" &&
              "resource" in cost &&
              cost.resource === passive.via,
          ))),
  );
}

// Spells whose damage may take other types (`spellTypes`), the least resisted dealt.
function withSpellTypes(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
  access: ContentAccess,
  usesLeft: (resource: string) => boolean,
): KnownAction[] {
  const changes = passives.flatMap((passive, index) =>
    passive.kind === "spellTypes" &&
    !(
      passive.oncePerTurn &&
      actor.usedThisTurn.includes(`spellTypes:${String(index)}`)
    ) &&
    !(passive.resource && !usesLeft(passive.resource))
      ? [{ passive, key: `spellTypes:${String(index)}` }]
      : [],
  );
  if (changes.length === 0) return [...actions];
  return actions.map((action) => {
    const spellId = spellOfSource(action.id);
    const { resolution } = action.activation;
    if (spellId === null || resolution.damage.length === 0) return action;
    const spell = maybeLookup(access, SpellSchema, spellId);
    const fitting = changes.filter(
      ({ passive }) =>
        !passive.list || onList(spellId, spell, passive.list, access),
    );
    if (fitting.length === 0) return action;
    const add = fitting.flatMap(({ passive }) => passive.add);
    const damage = resolution.damage.map((item) => ({
      ...item,
      types: [...new Set([...(item.types ?? [item.type]), ...add])],
    }));
    const keys = fitting.flatMap(({ passive, key }) =>
      passive.oncePerTurn ? [key] : [],
    );
    const spends = fitting.flatMap(({ passive }) =>
      passive.resource ? [{ resource: passive.resource }] : [],
    );
    return {
      ...action,
      activation: {
        ...action.activation,
        cost: [...action.activation.cost, ...spends],
        resolution: { ...resolution, damage },
      },
      ...(keys.length > 0
        ? { onceKeys: [...(action.onceKeys ?? []), ...keys] }
        : {}),
    };
  });
}

// Spells cast with a Bonus Action in place of an action (`castsAs`), and attack spells reaching farther
// (`spellRange`).
function withCastsAs(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  const farther = passives.reduce(
    (sum, passive) =>
      passive.kind === "spellRange" ? sum + passive.feet : sum,
    0,
  );
  const reached =
    farther === 0
      ? actions
      : actions.map((action) => {
          const { targeting, resolution } = action.activation;
          return spellOfSource(action.id) !== null &&
            resolution.kind === "attack" &&
            "range" in targeting &&
            typeof targeting.range === "number" &&
            targeting.range >= 10
            ? {
                ...action,
                activation: {
                  ...action.activation,
                  targeting: { ...targeting, range: targeting.range + farther },
                },
              }
            : action;
        });
  return castsAs(reached, passives);
}

function castsAs(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  const quick = passives.flatMap((passive) =>
    passive.kind === "castsAs" ? (passive.spells ?? ["*"]) : [],
  );
  if (quick.length === 0) return [...actions];
  // With no spells named, every spell, as Elder Champion's Swift Spells.
  return actions.map((action) => {
    const spell = spellOfSource(action.id);
    return spell !== null && (quick.includes(spell) || quick.includes("*"))
      ? {
          ...action,
          activation: {
            ...action.activation,
            cost: action.activation.cost.map((cost) =>
              cost === "action" ? "bonusAction" : cost,
            ),
          },
        }
      : action;
  });
}

// Spells that reach more creatures (`extraTarget`).
function withExtraTargets(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  const extra = passives.filter((passive) => passive.kind === "extraTarget");
  if (extra.length === 0) return [...actions];
  return actions.map((action) => {
    const spell = spellOfSource(action.id);
    const { targeting } = action.activation;
    const more = extra.reduce(
      (sum, item) =>
        spell !== null && item.spells.includes(spell)
          ? sum + item.creatures
          : sum,
      0,
    );
    return more > 0 && "creatures" in targeting
      ? {
          ...action,
          activation: {
            ...action.activation,
            targeting: { ...targeting, creatures: targeting.creatures + more },
          },
        }
      : action;
  });
}

// Spells with a `spellDamage` bonus added to their damage, while its once-a-turn use (and its resource) is left.
function withSpellDamage(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
  access: ContentAccess,
  usesLeft: (resource: string) => boolean,
): KnownAction[] {
  const bonuses = passives.flatMap((passive, index) =>
    passive.kind === "spellDamage" &&
    !(
      passive.oncePerTurn &&
      actor.usedThisTurn.includes(`spellDamage:${String(index)}`)
    ) &&
    !(passive.resource && !usesLeft(passive.resource))
      ? [{ passive, key: `spellDamage:${String(index)}` }]
      : [],
  );
  if (bonuses.length === 0) return [...actions];
  return actions.map((action) => {
    const spellId = spellOfSource(action.id);
    if (action.spellLevel === null || spellId === null) return action;
    const spell = maybeLookup(access, SpellSchema, spellId);
    let { resolution, cost } = action.activation;
    const keys: string[] = [];
    for (const { passive, key } of bonuses) {
      if (passive.spells && !passive.spells.includes(spellId)) continue;
      if (passive.schools && !(spell && passive.schools.includes(spell.school)))
        continue;
      if (passive.list && !onList(spellId, spell, passive.list, access))
        continue;
      if (passive.slot && !cost.includes("slot")) continue;
      const at = resolution.damage.findIndex(
        (item) => !passive.types || passive.types.includes(item.type),
      );
      const entry = resolution.damage[at];
      if (!entry) continue;
      const { bonus, dice } = passive;
      // Damage of its own, with dice or in its own `type`, as Alchemical Eruption's 2d8 Force or Power Surge's Force.
      const apart = dice !== undefined || passive.type !== undefined;
      const raised = resolution.damage.map((item, index) =>
        index === at && bonus && !apart
          ? {
              ...item,
              amount: {
                ...item.amount,
                bonus: {
                  base: (item.amount.bonus?.base ?? 0) + bonus.base,
                  add: [...(item.amount.bonus?.add ?? []), ...bonus.add],
                  ...(bonus.min === undefined ? {} : { min: bonus.min }),
                },
              },
            }
          : item,
      );
      const damage = apart
        ? [
            ...raised,
            {
              amount: {
                ...(dice ? { dice } : {}),
                ...(bonus ? { bonus } : {}),
              },
              type: passive.type ?? entry.type,
            },
          ]
        : raised;
      resolution = { ...resolution, damage };
      if (passive.resource) cost = [...cost, { resource: passive.resource }];
      if (passive.oncePerTurn) keys.push(key);
    }
    return keys.length === 0 && resolution === action.activation.resolution
      ? action
      : {
          ...action,
          activation: { ...action.activation, resolution, cost },
          ...(keys.length > 0
            ? { onceKeys: [...(action.onceKeys ?? []), ...keys] }
            : {}),
        };
  });
}

// Whether a spell is on a class's list: the spell names the class, or the class's chapter names the spell.
export function onList(
  spellId: string,
  spell: Spell | undefined,
  list: string,
  access: ContentAccess,
): boolean {
  return (
    (spell?.classes.includes(list) ?? false) ||
    (maybeLookup(access, ClassSchema, list)?.spellList?.includes(spellId) ??
      false)
  );
}

// A feature's activations with the effects other features ride on them, as Tactical Shift's move on Second Wind.
// Improved Mystic Fighting Style: a spell of the levels and class list named, that takes an action, can also be cast
// with the passive's costs, as part of the Bonus Action of Flurry of Blows.
function castWithVariants(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  access: ContentAccess,
): readonly KnownAction[] {
  const ways = passives.flatMap((passive) =>
    passive.kind === "castWith" ? [passive] : [],
  );
  if (ways.length === 0) return actions;
  const extra = actions.flatMap((action) => {
    const [, spellId] = /^spell:([^:]+:[^:]+)$/.exec(action.id) ?? [];
    if (!spellId || action.spellLevel === null) return [];
    if (!action.activation.cost.includes("action")) return [];
    const spell = lookup(access, SpellSchema, spellId);
    return ways.flatMap((way) =>
      way.levels.includes(action.spellLevel ?? -1) &&
      spell.classes.includes(way.list)
        ? [
            {
              ...action,
              id: `${action.id}:with`,
              name: `${action.name} (${way.label})`,
              activation: {
                ...action.activation,
                cost: [
                  ...action.activation.cost.filter((cost) => cost !== "action"),
                  ...way.cost,
                ],
              },
            },
          ]
        : [],
    );
  });
  return extra.length === 0 ? actions : [...actions, ...extra];
}

function withRiders(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
): KnownAction[] {
  return actions.map((given) => {
    let action = given;
    const { resolution } = action.activation;
    const riders = passives.flatMap((passive) =>
      passive.kind === "activationRider" &&
      action.id.startsWith(`feature:${passive.feature}:`) &&
      (passive.label === undefined ||
        action.activation.label === passive.label) &&
      (!passive.while ||
        actor.activeEffects.some(({ sourceId }) =>
          passive.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
        ))
        ? [passive]
        : [],
    );
    const extra = riders.flatMap(({ effects }) => effects);
    const damage = riders.flatMap(({ damage: more }) => more ?? []);
    const own = riders.flatMap(({ self }) => self ?? []);
    const allies = riders.flatMap(({ allies: rider }) =>
      rider ? [rider] : [],
    );
    if (allies.length > 0) {
      action = {
        ...action,
        activation: {
          ...action.activation,
          alsoAllies: [...(action.activation.alsoAllies ?? []), ...allies],
        },
      };
    }
    if (own.length > 0) {
      action = {
        ...action,
        activation: {
          ...action.activation,
          alsoSelf: [...(action.activation.alsoSelf ?? []), ...own],
        },
      };
    }
    // On a save, whether it succeeds or fails, as Focused Strike's with Stunning Strike.
    if (resolution.kind === "save" && (damage.length > 0 || extra.length > 0)) {
      return {
        ...action,
        activation: {
          ...action.activation,
          resolution: {
            ...resolution,
            damage: [...resolution.damage, ...damage],
            onFail: [...resolution.onFail, ...extra],
            onSuccess: [...resolution.onSuccess, ...extra],
          },
        },
      };
    }
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

// Whether a Martial Training passive covers this weapon: ranged ones have Ammunition, as a weapon attack reads them.
function trainedWith(
  passive: Extract<Passive, { kind: "martialTraining" }>,
  weapon: Weapon,
): boolean {
  const ranged = weapon.properties.includes("ammunition");
  return (
    (!passive.ranged || ranged) &&
    (!passive.melee || !ranged) &&
    !passive.without?.some((property) => weapon.properties.includes(property))
  );
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

// The weapon, or one of the forms it changes into, whose damage die is biggest, attacked with as a Finesse weapon.
function bestForm(
  weapon: Weapon,
  forms: readonly string[],
  access: ContentAccess,
): Weapon {
  const average = (item: Weapon): number => {
    const [count = 1, sides = 0] = (item.damage.dice ?? "0d0")
      .split("d")
      .map(Number);
    return (item.damage.flat ?? 0) + (count * (sides + 1)) / 2;
  };
  const shaped = forms
    .map((slug) =>
      access
        .contentIds()
        .filter((id) => id.endsWith(`:item/${slug}`))
        .map((id) => WeaponSchema.safeParse(access.content(id)).data)
        .find((item) => item !== undefined),
    )
    .filter((item): item is Weapon => item !== undefined);
  const best = [weapon, ...shaped].reduce((most, item) =>
    average(item) > average(most) ? item : most,
  );
  const properties = best.properties.includes("finesse")
    ? best.properties
    : [...best.properties, "finesse" as const];
  return { ...weapon, damage: best.damage, properties };
}

// The range a weapon is thrown to while its own activation's `thrownWeapon` lasts, as a Martialist's Quarterstaff's.
export function imbuedRange(
  actor: Actor,
  itemId: string,
): { readonly normal: number; readonly long: number } | undefined {
  for (const { modifier, sourceId } of actor.activeEffects) {
    if (modifier.kind === "thrownWeapon" && itemUseOf(sourceId) === itemId) {
      return { normal: modifier.normal, long: modifier.long };
    }
  }
  return undefined;
}

// The magic ammunition carried with the biggest bonus to attack rolls, as +3 Ammunition over +1.
function bestAmmunition(
  worn: readonly (readonly [string, Item])[],
  works: (itemId: string, item: Item) => boolean,
):
  | {
      readonly id: string;
      readonly name: string;
      readonly attack: number;
      readonly damage: number;
      readonly item: Item;
    }
  | undefined {
  const bonus = (item: Item, to: string): number =>
    (item.type === "magicItem"
      ? (item.bonuses ?? item.variants?.[0]?.bonuses ?? [])
      : []
    )
      .filter((entry) => entry.to === to)
      .reduce((total, entry) => total + entry.amount, 0);
  return worn
    .filter(
      ([itemId, item]) =>
        item.type === "magicItem" && item.ammunition && works(itemId, item),
    )
    .map(([id, item]) => ({
      id,
      name: item.name,
      attack: bonus(item, "attack"),
      damage: bonus(item, "damage"),
      item,
    }))
    .sort((a, b) => b.attack - a.attack)[0];
}

// A weapon firing a piece of magic ammunition takes its riders on the hit, as Walloping Ammunition's save: damage of
// no type of its own is the weapon's.
function firing(weapon: Weapon, ammunition: Item | undefined): Weapon {
  if (ammunition?.type !== "magicItem") return weapon;
  const { hitDamage, hitSave, hitEffects } = ammunition;
  const typed = (hitDamage ?? []).map(({ type, weaponDie: _die, ...rest }) => ({
    ...rest,
    type: type ?? weapon.damage.type,
  }));
  return {
    ...weapon,
    ...(typed.length > 0
      ? { hitDamage: [...(weapon.hitDamage ?? []), ...typed] }
      : {}),
    ...(hitSave && !weapon.hitSave ? { hitSave } : {}),
    ...(hitEffects
      ? { hitEffects: [...(weapon.hitEffects ?? []), ...hitEffects] }
      : {}),
  };
}

// The Unarmed Strike every character can make: a Strength attack it's proficient with, dealing 1 plus its
// Strength modifier in Bludgeoning damage. Its Grapple and Shove are actions of their own (actions.ts).
export const UNARMED_STRIKE = "unarmed-strike";
function unarmedStrike(abilities: AbilityScores): KnownAction {
  const activation = weaponActivation(
    {
      id: UNARMED_STRIKE,
      name: "Unarmed Strike",
      type: "weapon",
      category: "simple",
      damage: { flat: 1, type: "bludgeoning" },
      properties: [],
      mastery: "nick",
    },
    abilities,
  );
  const { resolution } = activation;
  return {
    id: UNARMED_STRIKE,
    name: "Unarmed Strike",
    activation:
      resolution.kind === "attack"
        ? {
            ...activation,
            resolution: {
              ...resolution,
              attack: { ...resolution.attack, unarmed: true },
            },
          }
        : activation,
    spellLevel: null,
  };
}

// An Unarmed Strike with what items add to its attack and damage rolls, as Wraps of Unarmed Power's +1.
function withUnarmedBonus(
  action: KnownAction,
  attack: number,
  damage: number,
): KnownAction {
  const { resolution } = action.activation;
  if (
    (attack === 0 && damage === 0) ||
    resolution.kind !== "attack" ||
    !resolution.attack.unarmed
  ) {
    return action;
  }
  const [first, ...rest] = resolution.damage;
  return {
    ...action,
    activation: {
      ...action.activation,
      resolution: {
        ...resolution,
        attack: {
          ...resolution.attack,
          ...(attack > 0
            ? { itemBonus: (resolution.attack.itemBonus ?? 0) + attack }
            : {}),
        },
        damage: first
          ? [
              {
                ...first,
                amount: {
                  ...first.amount,
                  bonus: {
                    base: (first.amount.bonus?.base ?? 0) + damage,
                    add: first.amount.bonus?.add ?? [],
                  },
                },
              },
              ...rest,
            ]
          : resolution.damage,
      },
    },
  };
}

export function weaponActivation(
  weapon: Weapon,
  abilities: AbilityScores,
  proficient = true,
  damageBonus = 0,
  itemBonus = 0,
  classIds: readonly string[] = [], // the wielder's classes, for a weapon's `classAbility`
): Activation {
  const ranged = weapon.properties.includes("ammunition");
  const finesse = weapon.properties.includes("finesse");
  const ability: Ability =
    ranged ||
    (finesse && abilityModifier(abilities.dex) > abilityModifier(abilities.str))
      ? "dex"
      : "str";
  // A Lute of Thunderous Thumping's Bard swings it with Charisma, its damage still with Strength.
  const { classAbility } = weapon;
  const rolledWith =
    classAbility &&
    !ranged &&
    classIds.some((id) => id.endsWith(`/${classAbility.class}`)) &&
    abilityModifier(abilities[classAbility.ability]) >
      abilityModifier(abilities[ability])
      ? classAbility.ability
      : ability;
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
        ability: rolledWith,
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
      onHit: weapon.hitEffects ?? [],
      onMiss: [],
      ...(weapon.hitSave ? { onHitSave: weapon.hitSave } : {}),
      ...(weapon.natural20 ? { natural20: weapon.natural20 } : {}),
      ...(weapon.breaksConcentration ? { breaksConcentration: true } : {}),
      ...(weapon.vs ? { vs: weapon.vs } : {}),
      ...(weapon.sworn?.item
        ? { sworn: { item: weapon.sworn.item, damage: weapon.sworn.damage } }
        : {}),
    },
  };
}

// A magic weapon whose magic doesn't work, unattuned or in an Antimagic Field: no damage or riders of its magic's.
function plainWeapon(weapon: Weapon): Weapon {
  const plain = { ...weapon };
  delete plain.hitDamage;
  delete plain.hitSave;
  delete plain.hitEffects;
  delete plain.natural20;
  delete plain.breaksConcentration;
  delete plain.vs;
  delete plain.thrown;
  delete plain.classAbility;
  delete plain.sworn;
  return plain;
}

// Throwing a Thrown weapon: its melee attack made at range, with Disadvantage past its normal range.
function thrownActivation(
  melee: Activation,
  range: NonNullable<Weapon["range"]>,
  passives: readonly Passive[],
  thrown?: Weapon["thrown"], // a magic weapon's own throw, as a Hammer of Thunderbolts' hurl
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
    ...(thrown?.resource
      ? { cost: [...melee.cost, { resource: thrown.resource }] }
      : {}),
    targeting: { creatures: 1, range: range.long, side: "enemy" },
    resolution: {
      ...resolution,
      ...(thrown?.hitSave ? { onHitSave: thrown.hitSave } : {}),
      attack: {
        ...resolution.attack,
        ...(longShots || range.normal >= range.long
          ? {}
          : { normalRange: range.normal }),
      },
      damage: [
        ...resolution.damage.map((damage, index) =>
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
        ...(thrown?.damage ?? []),
      ],
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

// Heavily encumbered: Disadvantage on ability checks, attack rolls and saving throws that use Strength, Dexterity or
// Constitution.
const HEAVILY_ENCUMBERED = (["checks", "attacks", "saves"] as const).flatMap(
  (on) =>
    (["str", "dex", "con"] as const).map((ability) => ({
      kind: "modifier" as const,
      modifier: { kind: "disadvantage" as const, on, ability },
    })),
);

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
  // A magic weapon's own scores too, as a Thunderous Greatclub's Strength 20.
  const scoring = worn.flatMap(([itemId, item]) =>
    (item.type === "magicItem" || item.type === "weapon") && works(itemId, item)
      ? [item]
      : [],
  );
  // Every worn item's passives, magic weapons and armor made from plain ones too (variants.ts). An entry with
  // versions counts as its first, as its bonuses do.
  const itemPassives = worn.flatMap(([itemId, item]) =>
    works(itemId, item)
      ? [
          ...("passives" in item ? (item.passives ?? []) : []),
          ...(item.type === "magicItem"
            ? (item.whileCharged ?? []).flatMap((entry) =>
                charged(actor, item, entry.resource) ? entry.passives : [],
              )
            : []),
          ...(item.type === "magicItem"
            ? (item.variants?.[0]?.passives ?? [])
            : []),
        ]
      : [],
  );
  // An item's rolled properties, while it works, as an artifact's random ones (gear.ts gainRolls).
  for (const [itemId, item] of worn) {
    if (works(itemId, item)) {
      itemPassives.push(...(actor.itemProperties?.[itemId] ?? []));
    }
  }
  // What studying a book gave for good, as the Book of Exalted Deeds' Halo, the book itself gone or not (gear.ts).
  for (const itemId of actor.studied ?? []) {
    const item = lookup(access, ItemSchema, itemId);
    if (item.type === "magicItem")
      itemPassives.push(...(item.study?.passives ?? []));
  }
  // A curse works while its bearer stays attuned to the item, worn or not, as Armor of Vulnerability's (gear.ts).
  if (!antimagic) {
    for (const itemId of attuned) {
      const item = ItemSchema.safeParse(access.content(itemId)).data;
      if (item && "curse" in item) {
        itemPassives.push(...(item.curse?.passives ?? []));
      }
    }
  }
  const abilities = withEffectScores(
    withItemAbilities(ownAbilities(actor, build), scoring, attuned),
    actor,
  );

  const level = build.levels.length;
  const classLevels: Record<string, number> = {};
  const skills = new Set<Skill>(background.skills);
  const expertise = new Set<Skill>();
  // what a skill choice adds to checks with the skills picked, as Enchanting Conversationalist's
  const skillBonuses: { skill: Skill; bonus: Formula }[] = [];
  const knownSpells = new Set<string>();
  const spellClass = new Map<string, string>(); // the class whose levels gave each known spell
  const freeSpells = new Map<string, FreeCast[]>(); // also cast without a slot
  const freeAlso = (spell: string, how: FreeCast) =>
    freeSpells.set(spell, [...(freeSpells.get(spell) ?? []), how]);
  const swaps = actor.swaps ?? {};
  const raisedSaves = new Set<Ability>(); // proficient from a feat such as Resilient
  const pickedTools: string[] = []; // tools a choice gave
  const pickedWeapons: string[] = []; // kinds of weapons a choice gave proficiency with
  const featureIds = new Set<string>(species.traits);
  const grantedBy = new Map<string, string>(); // the class whose level granted a feature
  const answerAbilities = new Map<string, Ability>(); // spells a class choice gives with its own ability
  const variants: Record<string, string[]> = {}; // the variants picked, by feature
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
  // An older book's background names no feat: the Origin feat picked for it is in the first level's answers.
  const ownFeats =
    replaced || background.feat === undefined ? [] : [background.feat];
  for (const feat of ownFeats) {
    for (const id of lookup(access, FeatSchema, feat).grants) {
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
    for (const id of levelData.grants) {
      featureIds.add(id);
      grantedBy.set(id, entry.classId);
    }
    scaling = { ...scaling, ...levelData.scaling };
    for (const answer of entry.answers) {
      if (answer.kind === "skills") {
        // Expertise comes with proficiency, as Blessings of Knowledge gives both.
        for (const skill of answer.values) {
          if (answer.expertise || (answer.orExpertise && skills.has(skill))) {
            expertise.add(skill);
          }
          skills.add(skill);
          if (answer.bonus) skillBonuses.push({ skill, bonus: answer.bonus });
        }
      } else if (answer.kind === "weapons") {
        pickedWeapons.push(...answer.values);
      } else if (answer.kind === "tools") {
        for (const value of answer.values) {
          const skill = SkillSchema.safeParse(value);
          if (skill.success) skills.add(skill.data);
          else pickedTools.push(value);
        }
      } else if (answer.kind === "spells") {
        for (const spell of answer.values) {
          knownSpells.add(spell);
          spellClass.set(spell, entry.classId);
          if (answer.freeCast) freeAlso(spell, answer.freeCast);
          if (answer.ability) answerAbilities.set(spell, answer.ability);
        }
      } else if (answer.kind === "features") {
        for (const id of answer.values) featureIds.add(id);
      } else if (answer.kind === "variant") {
        variants[answer.feature] = [
          ...(variants[answer.feature] ?? []),
          ...answer.values,
        ];
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
    for (const id of subclassLevel?.grants ?? []) {
      featureIds.add(id);
      grantedBy.set(id, entry.classId);
    }
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
  // Scores a feature raises past 20, as Primal Champion's Strength and Constitution.
  for (const id of featureIds) {
    for (const passive of maybeLookup(access, FeatureSchema, id)?.passives ??
      []) {
      if (passive.kind !== "scoreIncrease") continue;
      for (const ability of passive.abilities) {
        abilities[ability] = Math.max(
          abilities[ability],
          Math.min(passive.max, abilities[ability] + passive.amount),
        );
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

  // shortcut: training comes from every class taken, while a multiclass really gets only some of a later class's.
  const classes = Object.keys(classLevels).map((id) =>
    lookup(access, ClassSchema, id),
  );
  // A multiclass casts with the class it has the most levels in, the first taken on a tie.
  // shortcut: every spell uses that one ability, give each its own class's once Stats holds more than one.
  // A subclass's Spellcasting counts for its class, as an Eldritch Knight's for a Fighter.
  const casting = (def: ClassDef) =>
    def.spellcasting ??
    (subclass?.class === def.id ? subclass.spellcasting : undefined);
  const [casterClass] = classes
    .filter((def) => casting(def))
    .sort((a, b) => (classLevels[b.id] ?? 0) - (classLevels[a.id] ?? 0));
  const caster = casterClass && { spellcasting: casting(casterClass) };
  const trained = new Set<string>(classes.flatMap((def) => def.armor));
  for (const id of featIds) {
    if (id.endsWith("lightly-armored")) trained.add("light").add("shield");
    if (id.endsWith("moderately-armored")) trained.add("medium").add("shield");
    if (id.endsWith("heavily-armored")) trained.add("heavy");
  }
  const martialTraining = [...featIds].some((id) =>
    id.endsWith("/martial-weapon-training"),
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
  const weaponTraining = new Set([
    ...working.flatMap((item) => item.weaponTraining ?? []),
    ...pickedWeapons.map((id) => id.slice(id.lastIndexOf("/") + 1)),
  ]);
  const classDc: Record<string, number> = {}; // DC bonuses for one class's spells, by its name after the plugin
  for (const item of working) {
    if (item.ammunition) continue; // its bonus goes only to the shot that fires it
    // An entry with versions counts as its first, as older saves hold; content names a version as `<id>--<n>` (variants.ts).
    for (const {
      to,
      amount,
      unarmored,
      weapons,
      class: only,
    } of item.bonuses ?? item.variants?.[0]?.bonuses ?? []) {
      if (unarmored && armored) continue;
      if (only && to === "spellDc") {
        classDc[only] = (classDc[only] ?? 0) + amount;
        continue;
      }
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

  // An effect raising the bearer's spell save DC, as Innate Sorcery's +1.
  for (const { modifier } of actor.activeEffects) {
    if (modifier.kind === "bonus" && modifier.to === "spellDc") {
      magic.spellDc += modifier.amount.bonus?.base ?? 0;
    }
  }
  const fromFeatures = collectFeatureData(
    access,
    [...featureIds],
    level,
    slots.findLastIndex((count) => count > 0) + 1,
    featIds,
    classLevels,
    variants,
    swaps,
    grantedBy,
  );
  // Training and proficiencies features give, as Forge Domain's Heavy armor or Survivalist's skills.
  for (const passive of fromFeatures.passives) {
    if (passive.kind === "armorTraining") {
      for (const armor of passive.armor) trained.add(armor);
    } else if (passive.kind === "weaponTraining") {
      for (const kind of passive.weapons) weaponTraining.add(kind);
    } else if (passive.kind === "skillProficiency") {
      for (const skill of passive.skills) {
        skills.add(skill);
        if (passive.expertise) expertise.add(skill);
      }
    }
  }
  if (pickedTools.length > 0) {
    fromFeatures.passives.push({ kind: "toolProficiency", tools: pickedTools });
  }
  const untrainedArmor = worn.some(
    ([, item]) =>
      item.type === "armor" &&
      !item.anyTraining &&
      !trained.has(item.armorType),
  );
  // Whether any of its features gives an aura, active or not, so zones skip a character without one (core/zones.ts).
  if (actor.source.kind === "character" && actor.source.build) {
    auraBuilds.set(
      actor.source.build,
      [
        ...fromFeatures.passives,
        ...fromFeatures.gated.flatMap((gate) => gate.passives),
      ].some((passive) => passive.kind === "aura"),
    );
  }
  // A feature's passives that hold only while an effect of its activations is on the bearer (`whileActive`).
  for (const gate of fromFeatures.gated) {
    if (
      actor.activeEffects.some(({ sourceId }) =>
        gate.features.some((id) => sourceId.startsWith(`feature:${id}:`)),
      )
    ) {
      fromFeatures.passives.push(...gate.passives);
    }
  }
  for (const pick of latePicks(
    swaps,
    new Set([...featIds, ...ownFeats]),
    access,
  )) {
    for (const spell of pick.spells) {
      knownSpells.add(spell);
      if (pick.freeCast) freeAlso(spell, pick.freeCast);
    }
  }
  // Traits from features and from worn magic items, for what they change here, as a Robe of the Archmagi's AC.
  const kept = (actor.restPassives ?? []).flatMap((entry) => entry.passives);
  // The skill picked for an item that gives one, as an Arcanist's Bestiary's, while it works.
  for (const [itemId, item] of worn) {
    const picked = actor.itemSkills?.[itemId];
    if (
      item.type === "magicItem" &&
      works(itemId, item) &&
      picked &&
      item.chooseSkill?.some((skill) => skill === picked)
    ) {
      skills.add(picked as Skill);
    }
  }
  // A trait that holds only without Heavy armor, or without armor and a Shield, as Fast Movement or Unarmored Movement.
  const heavy = worn.some(
    ([, item]) => item.type === "armor" && item.armorType === "heavy",
  );
  const fits = (passive: Passive): boolean =>
    (passive.kind !== "modifier" ||
      !passive.while ||
      passive.while.some((id) =>
        actor.activeEffects.some(({ sourceId }) =>
          sourceId.startsWith(`feature:${id}:`),
        ),
      )) &&
    (passive.kind !== "modifier" ||
      !passive.whileAspect ||
      hasAspect(actor, passive.whileAspect)) &&
    ((passive.kind !== "modifier" && passive.kind !== "weaponRider") ||
      passive.armor === undefined ||
      (passive.armor === "noHeavy" ? !heavy : !armored)) &&
    // Power of the Wilds' Lion aura only in a Rage, as Holy Nimbus's only once it's used.
    (passive.kind !== "aura" ||
      !passive.while ||
      actor.activeEffects.some(({ sourceId }) =>
        passive.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
      )) &&
    (passive.kind !== "aura" ||
      !passive.whileAspect ||
      hasAspect(actor, passive.whileAspect)) &&
    (passive.kind !== "aura" ||
      !passive.without?.some((id) => featureIds.has(id)));
  // Durable Magic's bonuses hold only while the bearer concentrates.
  const traits = [...itemPassives, ...kept, ...fromFeatures.passives].filter(
    (passive) =>
      fits(passive) &&
      (passive.kind !== "modifier" ||
        !passive.concentrating ||
        actor.concentratingOn !== null),
  );
  const castingAbility = new Map([
    ...answerAbilities,
    ...fromFeatures.abilities,
    ...featSpellAbilities(build, ownFeats, species, access, swaps),
  ]);
  const armorBases: number[] = [];
  const armorTypes: string[] = [];
  const flatBonus = magic.ac;
  let shield = 0;
  let heldAc = 0; // a magic weapon's own bonus to AC, as the Wand of Orcus's +3 while held
  let shielded = false;
  const actions: KnownAction[] = [];
  // Use Magic Device: any Spell Scroll read with Intelligence.
  const anyScroll = traits.find((trait) => trait.kind === "anyScroll");
  const reader =
    untrainedArmor || (!caster?.spellcasting && !anyScroll)
      ? undefined
      : {
          classes: caster?.spellcasting ? Object.keys(classLevels) : [],
          ability:
            caster?.spellcasting?.ability ??
            (anyScroll?.kind === "anyScroll" ? anyScroll.ability : "int"),
          highest: slots.findLastIndex((count) => count > 0) + 1,
          ...(anyScroll?.kind === "anyScroll"
            ? { anyScroll: anyScroll.ability }
            : {}),
        };
  for (const [itemId, item] of worn) {
    const usable = itemAction(itemId, item, access, reader);
    if (usable) {
      actions.push(
        item.type === "gear"
          ? fastHands(farLobbed(usable, traits), traits)
          : usable,
      );
    }
    if (works(itemId, item) && !untrainedArmor) {
      actions.push(
        ...itemCasts(itemId, item, level, access, actor),
        ...itemUses(itemId, item, actor),
        ...storedCasts(itemId, item, actor, access),
      );
      // A Thayan Spell Tattoo's spell is always prepared, cast with the bearer's slots.
      if (
        item.type === "magicItem" &&
        item.boundSpell?.as === "tattoo" &&
        item.spell &&
        caster?.spellcasting
      ) {
        knownSpells.add(item.spell);
      }
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
      armorTypes.push(parsed.armorType);
    } else if (item.type === "shield") {
      shielded = true;
      // Only one shield is held, and it protects only with training.
      if (trained.has("shield")) {
        shield = Math.max(
          shield,
          item.bonus + ownAc(item.bonuses, !works(itemId, item)),
        );
      }
    } else if (item.type === "weapon") {
      const weapon = WeaponSchema.parse(item);
      heldAc = Math.max(heldAc, ownAc(weapon.bonuses, !works(itemId, item)));
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
      // Its magic's damage and riders only while it works.
      const unchanged = works(itemId, item) ? weapon : plainWeapon(weapon);
      // A Keyholes Dagger attacks as the form of its own its version allows that hits hardest, with Strength or
      // Dexterity. shortcut: it keeps its own mastery, and it changes back to throw.
      const plain = weapon.forms
        ? bestForm(unchanged, weapon.forms, access)
        : unchanged;
      // shortcut: an Ammunition weapon fires the best magic ammunition carried, without asking.
      const shot = weapon.properties.includes("ammunition")
        ? bestAmmunition(worn, works)
        : undefined;
      const activation = weaponActivation(
        firing(plain, shot?.item),
        abilities,
        martialTraining ||
          fromFeatures.passives.some(
            (passive) =>
              passive.kind === "martialTraining" &&
              trainedWith(passive, weapon),
          ) ||
          kinds.some((kind) => weaponTraining.has(kind)) ||
          classes.some((def) => weaponProficient(def, weapon)),
        own("damage") + scoped("damage") + (shot?.damage ?? 0),
        own("attack") - magic.attack + scoped("attack") + (shot?.attack ?? 0),
        Object.keys(classLevels),
      );
      actions.push({
        id: `${WEAPON_PREFIX}${itemId}`,
        name: shot ? `${item.name} (${shot.name})` : item.name,
        activation,
        spellLevel: null,
        ...(shot ? { ammunition: shot.id } : {}),
      });
      // A Martialist's Quarterstaff made a Thrown weapon for a while by its own activation.
      const imbued = imbuedRange(actor, itemId);
      const range = weapon.properties.includes("thrown")
        ? weapon.range
        : imbued;
      if (range) {
        actions.push({
          id: `${THROW_PREFIX}${itemId}`,
          name: `Throw ${item.name}`,
          activation: thrownActivation(
            activation,
            range,
            traits,
            works(itemId, item) ? weapon.thrown : undefined,
          ),
          spellLevel: null,
        });
      }
    }
  }

  // Every character's Unarmed Strike, and what items add to it, as Wraps of Unarmed Power, also to the Unarmed
  // Strikes features make, as Martial Arts'. shortcut: they keep their own damage type rather than offering Force.
  const unarmed = (to: "attack" | "damage"): number =>
    weaponBonuses
      .filter(
        (bonus) => bonus.to === to && bonus.weapons.includes(UNARMED_STRIKE),
      )
      .reduce((total, bonus) => total + bonus.amount, 0);
  actions.push(
    ...fromFeatures.actions.map((action) => {
      const { targeting } = action.activation;
      if (!("creatures" in targeting)) return action;
      const { creaturesBy, creaturesPlus } = targeting;
      if (!creaturesBy && !creaturesPlus) return action;
      const by = creaturesBy ? abilityModifier(abilities[creaturesBy]) : 0;
      const plus = creaturesPlus
        ? Math.max(0, abilityModifier(abilities[creaturesPlus]))
        : 0;
      return {
        ...action,
        activation: {
          ...action.activation,
          targeting: {
            ...targeting,
            creatures: Math.max(targeting.creatures, by) + plus,
          },
        },
      };
    }),
    // Last, so an attack chosen as the first that fits, as an Opportunity Attack is, takes a weapon or Martial Arts.
    unarmedStrike(abilities),
  );
  actions.splice(
    0,
    actions.length,
    ...actions.map((action) =>
      withUnarmedBonus(action, unarmed("attack"), unarmed("damage")),
    ),
  );
  for (const spellId of fromFeatures.spells) {
    if (access.content(spellId)) knownSpells.add(spellId);
  }
  for (const [spellId, how] of fromFeatures.free) freeAlso(spellId, how);
  const freeCasts = untrainedArmor
    ? []
    : freeCastActions(freeSpells, access, level);
  actions.push(
    ...freeCasts.map(({ action }) => {
      const spellId = spellOfSource(action.id) ?? "";
      const ability = castingAbility.get(spellId);
      const type = fromFeatures.retype[spellId];
      // A free cast takes the features' changes to the spell too, as Cold Fire Magic's cold Flame Blade.
      const changed = spellChanged(
        type ? retyped(action.activation, type) : action.activation,
        fromFeatures.redice[spellId],
        fromFeatures.addsTo[spellId],
      );
      return {
        ...action,
        activation: ability ? castWith(changed, ability) : changed,
      };
    }),
  );

  const zoned =
    "state" in access && access.state
      ? zoneModifiers(actor, access.state as DndState)
      : [];
  const freeing = [
    ...actor.activeEffects.map(({ modifier }) => modifier),
    ...zoned,
  ].flatMap((modifier) => (modifier.kind === "freeSpells" ? [modifier] : []));
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
      const given = spellClass.get(spellId);
      const bonusDc = given
        ? classDc[given.slice(given.lastIndexOf("/") + 1)]
        : undefined;
      // A Candle of Invocation's light: a level 1 spell a Cleric or Druid prepared takes no slot.
      const free =
        given !== undefined &&
        freeing.some(
          (modifier) =>
            spell.level >= 1 &&
            spell.level <= modifier.maxLevel &&
            modifier.classes.includes(given.slice(given.lastIndexOf("/") + 1)),
        );
      const bumped = bonusDc ? withDcBonus(activation, bonusDc) : activation;
      const cast = ability ? castWith(bumped, ability) : bumped;
      const typed = spellChanged(
        type ? retyped(cast, type) : cast,
        fromFeatures.redice[spellId],
        fromFeatures.addsTo[spellId],
      );
      actions.push({
        id: `spell:${spellId}`,
        name: spell.name,
        activation: free
          ? {
              ...typed,
              cost: typed.cost.filter((cost) => cost !== "slot"),
            }
          : typed,
        spellLevel: spell.level,
        upcast: spell.upcast,
        ...(lasting ? { concentrates: true as const } : {}),
      });
    }
    // What it does only outside a fight, as Freezing Sphere's frozen water, cast from the sheet (camp.ts).
    if (spell.scene) {
      actions.push({
        id: `spell:${spellId}:scene`,
        name: `${spell.name} (between fights)`,
        activation: { ...spell.scene, outOfCombat: "scene" },
        spellLevel: spell.level,
        upcast: spell.upcast,
      });
    }
    // What the spell lets its caster do while it holds, as Flame Blade's attack, is no cast of its own.
    // shortcut: it's at the spell's own level, not the slot's it was cast with.
    if (
      lasting &&
      spellOfSource(actor.concentratingOn ?? "") === spellId &&
      !castFrom(actor.concentratingOn ?? "") &&
      !(lasting.remark && stillMarked(actor, spellId, access))
    ) {
      // It grows with the slot the spell was cast with, as Witch Bolt's or Flaming Sphere's later damage.
      const cast = actor.activeEffects.find(
        ({ sourceId, level }) =>
          level !== undefined &&
          (sourceId === actor.concentratingOn ||
            sourceId === `lasting:${spellId}`),
      )?.level;
      const step = spell.upcast?.perSlotLevel;
      // An upcast for the first damage only, as Witch Bolt's, leaves the later damage alone.
      const scaled =
        step &&
        !("initial" in step && step.initial) &&
        cast !== undefined &&
        cast > spell.level
          ? scaleActivation(lasting, step, cast - spell.level)
          : lasting;
      // Delayed Blast Fireball's bead: a die more for each round since it formed.
      const state = (access as ContentAccess & { readonly state?: DndState })
        .state;
      const since = actor.activeEffects.find(
        ({ sourceId, modifier }) =>
          sourceId === `spell:${spellId}` && modifier.kind === "zone",
      )?.modifier;
      const rounds =
        lasting.growsBy && since?.kind === "zone" && since.since !== undefined
          ? (state?.combat?.round ?? since.since) - since.since
          : 0;
      const grown =
        lasting.growsBy && rounds > 0
          ? scaleActivation(scaled, { addDice: lasting.growsBy }, rounds)
          : scaled;
      const retypedTo = fromFeatures.retype[spellId];
      actions.push({
        id: `lasting:${spellId}`,
        name: spell.name,
        activation: spellChanged(
          retypedTo ? retyped(grown, retypedTo) : grown,
          fromFeatures.redice[spellId],
          fromFeatures.addsTo[spellId],
        ),
        spellLevel: null,
      });
    }
  }

  // Spells a worn item lets its bearer try to cast without knowing them, as a Hat of Wizardry's cantrips.
  for (const [itemId, item] of worn) {
    if (works(itemId, item) && !untrainedArmor && caster?.spellcasting) {
      actions.push(
        ...unknownSpells(
          itemId,
          item,
          knownSpells,
          slots.findLastIndex((count) => count > 0) + 1,
          caster.spellcasting.ability,
          level,
          access,
        ),
      );
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
  // Whether a use of a resource is left, for the spell changes that spend one, from its flat maximum (1 when it's
  // worked out from the bearer, as maximums are only after this).
  const usesLeft = (id: string): boolean => {
    const def = [...fromFeatures.resources, ...pools].find(
      (item) => item.id === id,
    );
    const most = def?.max.add.length === 0 ? def.max.base : 1;
    return (actor.resourcesSpent[id] ?? 0) < most;
  };
  const carried = carriedWeight(actor, access);
  const capacity = carryingCapacity(
    abilities.str,
    species.size,
    traits.some(({ kind }) => kind === "powerfulBuild"),
  );
  // With the Encumbrance variant the load slows, in place of armor's Strength score.
  const load = variantOn(access, ENCUMBRANCE)
    ? encumbrance(carried, capacity)
    : null;
  const partial: Stats = {
    abilities,
    proficiency: proficiencyBonus(level) + magic.proficiency,
    level,
    classLevels,
    maxHp,
    ac: bestAc(actor, abilities, {
      armorBases,
      flatBonus: flatBonus + shield + heldAc,
      passives: traits,
      armorTypes,
      shielded,
      proficiency: proficiencyBonus(level) + magic.proficiency,
    }),
    speed: encumberedSpeed(species.speed - 10 * (load ?? 0), carried, capacity),
    savingThrows: withFallbackSaves(
      [
        ...new Set([
          ...firstClass.savingThrows,
          ...raisedSaves,
          ...traits.flatMap((passive) =>
            passive.kind === "saveProficiency" ? passive.abilities : [],
          ),
        ]),
      ],
      [...firstClass.savingThrows, ...raisedSaves],
      traits,
      abilities,
    ),
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
      ...itemPassives.filter(fits),
      ...kept,
      ...skillBonuses.map(({ skill, bonus }) => ({
        kind: "modifier" as const,
        modifier: {
          kind: "bonus" as const,
          to: "checks" as const,
          skill,
          amount: { bonus },
        },
      })),
      ...fromFeatures.passives
        .filter(fits)
        .map((passive) =>
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
      ...(load === 2 ? HEAVILY_ENCUMBERED : []),
    ],
    actions: withCastOptions(
      withMetamagic(
        withInvocations(
          withWeaponRiders(
            withSpellDamage(
              emptyHanded(
                withPotentCantrips(
                  withSpellTypes(
                    withCastsAs(
                      withExtraTargets(
                        withRiders(
                          castWithVariants(
                            actions,
                            fromFeatures.passives,
                            access,
                          ),
                          fromFeatures.passives,
                          actor,
                        ),
                        fromFeatures.passives,
                      ),
                      fromFeatures.passives,
                    ),
                    [...itemPassives, ...fromFeatures.passives],
                    actor,
                    access,
                    usesLeft,
                  ),
                  fromFeatures.passives,
                ),
                actor,
                access,
              ),
              [...itemPassives, ...fromFeatures.passives],
              actor,
              access,
              usesLeft,
            ),
            fromFeatures.passives,
            actor,
            access,
            abilities,
          ),
          fromFeatures.passives,
          abilities,
          classLevels,
          access,
          pactWeaponId(actor, access),
        ),
        actor,
        abilityModifier(abilities.cha),
        freeOption(actor, fromFeatures.passives),
      ),
      // Only an actor with a cast option waiting looks its features over for them.
      actor.activeEffects.some(({ sourceId }) =>
        sourceId.startsWith(CAST_OPTION_PREFIX),
      )
        ? waitingOptions(
            actor,
            castOptionsOf(
              [...featureIds].flatMap((id) => {
                const feature = FeatureSchema.safeParse(
                  access.content(id),
                ).data;
                return feature
                  ? [withVariant(featureRules(feature), variants)]
                  : [];
              }),
            ),
          )
        : [],
      scaleActivation,
    ),
    multiattack:
      Math.max(
        ...[...featureIds].map(attacksFrom),
        ...passiveAttacks(fromFeatures.passives),
        1,
      ) +
      fromFeatures.passives.reduce(
        (sum, passive) =>
          passive.kind === "extraAttacks" &&
          (!passive.while ||
            passive.while.some((id) =>
              actor.activeEffects.some(({ sourceId }) =>
                sourceId.startsWith(`feature:${id}:`),
              ),
            )) &&
          (!passive.firstTurn || ownFirstTurn(actor, access))
            ? sum + passive.count
            : sum,
        0,
      ),
    routines: null,
    creatureType: species.creatureType.toLowerCase(),
    initiative:
      abilityModifier(abilities.dex) -
      2 * exhaustionOf(actor) -
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
      // Each ability modifier, at least 1, for dice that number it, as Sear Undead's d8s ("mod:wis").
      ...Object.fromEntries(
        Object.entries(abilities).map(([ability, score]) => [
          `mod:${ability}`,
          Math.max(1, abilityModifier(score)),
        ]),
      ),
    },
    features: [...featureIds],
    resourceDefs: [
      ...fromFeatures.resources,
      ...freeCasts.flatMap(({ resource }) => (resource ? [resource] : [])),
      ...pools,
    ],
    pactMagic: [...featureIds].some(isPactMagic),
    untrainedArmor,
    exhaustion: exhaustionOf(actor),
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
        passiveBonus(partial, "speed") +
        (ownFirstTurn(actor, access)
          ? partial.passives.reduce(
              (sum, passive) =>
                passive.kind === "firstTurnSpeed" ? sum + passive.feet : sum,
              0,
            )
          : 0) +
        (ownTurnActed(actor, access)
          ? partial.passives.reduce(
              (sum, passive) =>
                passive.kind === "attackSpeed" ? sum + passive.feet : sum,
              0,
            )
          : 0) -
        (tooHeavy &&
        load === null &&
        !traits.some((passive) => passive.kind === "armorStrength")
          ? 10
          : 0) -
        5 * exhaustionOf(actor),
    ),
    resources: Object.fromEntries(
      partial.resourceDefs.map((resource) => [
        resource.id,
        evaluateFormula(resource.max, partial) +
          (actor.rolledPools?.[resource.id] ??
            (resource.rolled ? diceCount(resource.rolled) : 0)),
      ]),
    ),
  };
}

// How many dice a notation rolls, the least it can come to: 3 for "3d10".
export const diceCount = (notation: string): number =>
  Number(/^(\d+)d/.exec(notation)?.[1] ?? 1);

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

// A spell's save DC and attack bonus when an item made with it casts it, by the spell's level, as a Spell Scroll's or
// an Enspelled Staff's.
export function boundNumbers(level: number): {
  readonly dc: number;
  readonly attack: number;
} {
  const dc =
    level <= 2 ? 13 : level <= 4 ? 15 : level <= 6 ? 17 : level <= 8 ? 18 : 19;
  return { dc, attack: dc - 8 };
}

// Whether a spell is on one of these classes' spell lists, by their names after the plugin, so any book's Wizard
// counts. shortcut: a subclass's or feature's own list doesn't count.
export function onClassList(
  spell: Spell,
  classIds: readonly string[],
): boolean {
  const slug = (id: string): string => id.slice(id.lastIndexOf("/") + 1);
  const names = new Set(classIds.map(slug));
  return spell.classes.some((id) => names.has(slug(id)));
}

// A potion to drink or a scroll to read, used up once used. Their action ids start "item:", which spends the item.
function itemAction(
  itemId: string,
  item: z.infer<typeof ItemSchema>,
  access: ContentAccess,
  // the reader's spellcasting: its classes, ability and highest slot level
  reader:
    | {
        readonly classes: readonly string[];
        readonly ability: Ability;
        readonly highest: number;
        readonly anyScroll?: Ability; // any scroll, by Use Magic Device
      }
    | undefined,
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
  if (item.type === "magicItem" && item.activation) {
    const verb =
      item.verb ??
      (item.category === "potion"
        ? "Drink"
        : item.category === "scroll"
          ? "Read"
          : "Use");
    return {
      id: `item:${itemId}`,
      name: `${verb} ${item.name}`,
      activation: item.activation,
      spellLevel: null,
    };
  }
  // A Thayan Spell Tattoo's spell cast once without a slot or components, the tattoo gone after, with the bearer's
  // spellcasting or else DC 13 and +5.
  if (
    item.type === "magicItem" &&
    item.spell &&
    item.boundSpell?.as === "tattoo"
  ) {
    const spell = lookup(access, SpellSchema, item.spell);
    if (!spell.activation || !doesSomething(spell.activation.resolution)) {
      return null;
    }
    const activation =
      reader && reader.classes.length > 0
        ? spell.activation
        : withItemNumbers(spell.activation, 13, 5);
    return {
      id: `item:${itemId}`,
      name: `${spell.name} (${item.name})`,
      activation: {
        ...activation,
        cost: activation.cost.filter(
          (cost) =>
            cost !== "slot" && !(typeof cost === "object" && "gold" in cost),
        ),
      },
      spellLevel: spell.level,
    };
  }
  // A Spell Scroll is read by a caster with its spell on their list, with the scroll's numbers. A spell above the
  // slots they have takes a check of their spellcasting ability first, whose failure wastes the scroll.
  if (item.type !== "magicItem" || !item.spell || !reader) return null;
  const spell = lookup(access, SpellSchema, item.spell);
  const listed = onClassList(spell, reader.classes);
  if (
    !spell.activation ||
    !doesSomething(spell.activation.resolution) ||
    (!listed && reader.anyScroll === undefined)
  ) {
    return null;
  }
  const { dc, attack } = boundNumbers(spell.level);
  const numbered = withItemNumbers(spell.activation, dc, attack);
  return {
    id: `item:${itemId}`,
    name: `Read ${item.name}`,
    activation: {
      ...numbered,
      cost: numbered.cost.filter(
        (cost) =>
          cost !== "slot" && !(typeof cost === "object" && "gold" in cost),
      ),
    },
    spellLevel: spell.level,
    ...(listed
      ? spell.level > Math.max(reader.highest, 0)
        ? { castCheck: { ability: reader.ability, dc: 10 + spell.level } }
        : {}
      : spell.level > 1
        ? {
            castCheck: {
              ability: reader.anyScroll ?? reader.ability,
              skill: "arcana" as const,
              dc: 10 + spell.level,
            },
          }
        : {}),
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
      effect.kind === "createItems" ||
      effect.kind === "untilLongRest" ||
      (effect.kind === "exhaustion" && effect.clear === true) ||
      // what raises or mends the dead and dying, mostly between fights (camp.ts)
      effect.kind === "repose" ||
      effect.kind === "transference" ||
      effect.kind === "reincarnate" ||
      effect.kind === "clone" ||
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
  const own =
    actor.source.kind === "monster"
      ? monsterStats(actor, access)
      : actor.source.kind === "summon"
        ? summonStats(actor, access)
        : characterStats(actor, access);
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

export const MOVE_ZONE = "zone-move:";
export const JUMP_BOOST = "jump-boost";

// A jump farther than walking allows, once a turn, for a little movement, as the Jump spell's 30 feet for 10.
function jumpActions(actor: Actor, stats: Stats): KnownAction[] {
  const best = [
    ...actor.activeEffects.map(({ modifier }) => modifier),
    ...passiveModifiers(stats.passives),
  ].reduce<Extract<Modifier, { kind: "jumpBoost" }> | null>(
    (most, modifier) =>
      modifier.kind === "jumpBoost" && modifier.feet > (most?.feet ?? 0)
        ? modifier
        : most,
    null,
  );
  if (!best) return [];
  return [
    {
      id: JUMP_BOOST,
      name: `Jump (${String(best.feet)} ft for ${String(best.movement)} ft of movement)`,
      activation: {
        cost: [],
        oncePerTurn: JUMP_BOOST,
        targeting: { self: true },
        resolution: {
          kind: "automatic",
          damage: [],
          effects: [
            { kind: "teleport", feet: best.feet, movement: best.movement },
          ],
        },
      },
      spellLevel: null,
    },
  ];
}

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
            cost:
              modifier.area.moveWith === "free"
                ? []
                : [modifier.area.moveWith ?? "action"],
            ...(modifier.area.moveWith === "free"
              ? { oncePerTurn: `${MOVE_ZONE}${sourceId}` }
              : {}),
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
        modifier.kind === "wished" ||
        modifier.kind === "stolenSpell" ||
        modifier.kind === "spheres",
    ) &&
    !stats.actions.some((action) =>
      weaponAttackOf(action.activation.resolution),
    )
  ) {
    return stats;
  }
  const granted: KnownAction[] = [];
  const resources: Record<string, number> = {};
  let actions = stats.actions;
  for (const { modifier, sourceId, level } of actor.activeEffects) {
    // Elminster's Effulgent Spheres: each of its actions spends a sphere.
    if (modifier.kind === "spheres") {
      const spellId = spellOfSource(sourceId) ?? "";
      const spell = lookup(access, SpellSchema, spellId);
      if (!spell.spheres) continue;
      const key = `spheres:${spellId}`;
      const { gathered, countMod, count, perSlot } = spell.spheres;
      // Spirit Lantern: as many as it has gathered, up to the caster's spellcasting modifier (an item's count).
      const most =
        countMod && !castFrom(sourceId)
          ? Math.max(
              1,
              evaluateFormula({ base: 0, add: [{ kind: "spellMod" }] }, stats),
            )
          : count;
      resources[key] = gathered
        ? Math.min(most, actor.resourcesSpent[`${key}:gathered`] ?? 0)
        : count + perSlot * Math.max(0, (level ?? spell.level) - spell.level);
      spell.spheres.actions.forEach((activation, index) => {
        granted.push({
          id: `spheres:${sourceId}:${String(index)}`,
          name: `${spell.name}${activation.label ? `: ${activation.label}` : ""}`,
          activation: {
            ...activation,
            cost: [...activation.cost, { resource: key }],
          },
          spellLevel: null,
        });
      });
      continue;
    }
    // Spell Thief: the thief has the spell prepared, cast with its own slots, and its caster can't cast it.
    if (modifier.kind === "stolenSpell") {
      const id = `spell:${modifier.spell}`;
      if (modifier.lost) {
        actions = actions.filter(
          (action) => spellOfSource(action.id) !== modifier.spell,
        );
      } else if (!actions.some((action) => action.id === id)) {
        const spell = lookup(access, SpellSchema, modifier.spell);
        if (spell.activation) {
          actions = [
            ...actions,
            {
              id,
              name: spell.name,
              activation: spell.activation,
              spellLevel: spell.level,
              upcast: spell.upcast,
            },
          ];
        }
      }
    }
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
    const giver = grantedBy(sourceId, access);
    if (!giver) continue;
    // A cantrip's action grows with the bearer's level, as Produce Flame's hurl.
    const scaled =
      giver.spell?.upcast && giver.spell.granted
        ? scaleActivation(
            giver.activation,
            giver.spell.upcast.perSlotLevel,
            (level ?? giver.spell.level) - giver.spell.level,
          )
        : giver.spell?.level === 0 && giver.spell.cantrip
          ? scaleActivation(
              giver.activation,
              giver.spell.cantrip.perTier,
              cantripTier(stats.level),
            )
          : giver.activation;
    const { resolution } = scaled;
    const dcSet =
      resolution.kind === "save" && modifier.dc !== undefined
        ? {
            ...scaled,
            resolution: { ...resolution, dc: { base: modifier.dc, add: [] } },
          }
        : scaled;
    const retypedAction = modifier.damage
      ? retyped(dcSet, modifier.damage)
      : dcSet;
    const uses = modifier.uses;
    if (uses !== undefined) resources[grantedKey(sourceId)] = uses;
    granted.push({
      id: `${GRANTED_PREFIX}${sourceId}`,
      name: giver.name,
      activation:
        uses === undefined
          ? retypedAction
          : {
              ...retypedAction,
              cost: [...retypedAction.cost, { resource: grantedKey(sourceId) }],
            },
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
    : {
        ...stats,
        actions: [...reaching, ...granted],
        ...(Object.keys(resources).length > 0
          ? { resources: { ...stats.resources, ...resources } }
          : {}),
      };
}

// The pool of a `grantedAction` that allows only so many uses, as a Potion of Fire Breath's three exhales.
export const grantedKey = (sourceId: string): string => `granted:${sourceId}`;

// What gave a `grantedAction`: a spell's `granted` action, or a magic item's, as a Potion of Fire Breath's.
function grantedBy(
  sourceId: string,
  access: ContentAccess,
):
  | {
      readonly name: string;
      readonly activation: Activation;
      readonly spell?: Spell;
    }
  | undefined {
  // An item's, from using it up or from one of its activations, as a Staff of the Adder's snake head.
  const itemId = sourceId.startsWith(ITEM_PREFIX)
    ? sourceId.slice(ITEM_PREFIX.length)
    : itemUseOf(sourceId);
  if (itemId) {
    const item = lookup(access, ItemSchema, itemId);
    return "granted" in item && item.granted
      ? { name: item.name, activation: item.granted }
      : undefined;
  }
  const spell = lookup(access, SpellSchema, spellOfSource(sourceId) ?? "");
  return spell.granted
    ? { name: spell.name, activation: spell.granted, spell }
    : undefined;
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

// Whether a creature other than the caster still bears what its spell, or that spell's lasting action, put on it, so
// the spell's mark doesn't move yet, as Hunter's Mark's.
function stillMarked(
  actor: Actor,
  spellId: string,
  access: ContentAccess,
): boolean {
  const state = (access as ContentAccess & { readonly state?: DndState }).state;
  if (!state) return false;
  const sources = new Set([`spell:${spellId}`, `lasting:${spellId}`]);
  return Object.values(state.actors).some(
    (item) =>
      item.id !== actor.id &&
      item.hp > 0 &&
      item.activeEffects.some(
        ({ sourceId, casterId }) =>
          casterId === actor.id && sources.has(sourceId),
      ),
  );
}

// Its levels of Exhaustion, with those that last only while an effect does, as Sickening Radiance's.
export function exhaustionOf(actor: Actor): number {
  return Math.min(
    6,
    actor.activeEffects.reduce(
      (sum, { modifier }) =>
        modifier.kind === "exhausted"
          ? sum +
            Math.min(modifier.levels, Math.max(0, (modifier.upTo ?? 6) - sum))
          : sum,
      actor.exhaustion,
    ),
  );
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

export function hasSteadySpeed(stats: Stats, actor?: Actor): boolean {
  return (
    stats.passives.some((passive) => passive.kind === "steadySpeed") ||
    (actor?.activeEffects.some(
      ({ modifier }) => modifier.kind === "steadySpeed",
    ) ??
      false)
  );
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
  // A Finesse weapon a feature or spell makes, as Shadow Blade's, uses the better of Strength and Dexterity.
  const ability =
    attack.type === "spell"
      ? (attack.ability ?? stats.spellAbility)
      : (attack.ability ??
        (attack.finesse
          ? modifierFor(stats, "dex") > modifierFor(stats, "str")
            ? "dex"
            : "str"
          : undefined));
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

// Elegant Courtier: a save proficiency the character already had from elsewhere gives one of `orElse` instead, the
// highest score's it isn't proficient in.
// shortcut: the book has the player choose; the higher score is the one worth having.
function withFallbackSaves(
  saves: Ability[],
  otherwise: readonly Ability[],
  passives: readonly Passive[],
  abilities: AbilityScores,
): Ability[] {
  const out = [...saves];
  for (const passive of passives) {
    if (
      passive.kind !== "saveProficiency" ||
      !passive.orElse ||
      !passive.abilities.every((ability) => otherwise.includes(ability))
    )
      continue;
    const pick = [...passive.orElse]
      .filter((ability) => !out.includes(ability))
      .sort((a, b) => abilities[b] - abilities[a])[0];
    if (pick) out.push(pick);
  }
  return out;
}

export function checkBonus(
  stats: Stats,
  actor: Actor,
  // A tool's proficiency counts once, as the skill's would (core/explore.ts).
  check: {
    readonly ability: Ability;
    readonly skill?: Skill;
    readonly toolProficient?: boolean;
  },
): number {
  const { skill } = check;
  const skilled = skill !== undefined && stats.skills.includes(skill);
  const proficient = skilled || check.toolProficient === true;
  const expert =
    skilled &&
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
    2 * exhaustionOf(actor) -
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

export function spellAttackBonus(stats: Stats): number {
  return (
    stats.proficiency + spellModifier(stats) + stats.itemBonuses.spellAttack
  );
}

export function spellSaveDc(stats: Stats): number {
  return (
    8 + stats.proficiency + spellModifier(stats) + stats.itemBonuses.spellDc
  );
}

// Effects with their `slotLevel` terms worked out for a cast with this slot.
export function atSlotLevel<T>(value: T, slot: number): T {
  return slotted(value, slot) as T;
}

function slotted(value: unknown, slot: number): unknown {
  if (Array.isArray(value)) return value.map((item) => slotted(item, slot));
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, slotted(item, slot)]),
  );
  const terms: unknown[] = Array.isArray(copy.add) ? copy.add : [];
  const isSlot = (term: unknown) =>
    typeof term === "object" &&
    term !== null &&
    "kind" in term &&
    term.kind === "slotLevel";
  const count = terms.filter(isSlot).length;
  return count === 0
    ? copy
    : {
        ...copy,
        base: (typeof copy.base === "number" ? copy.base : 0) + count * slot,
        add: terms.filter((term) => !isSlot(term)),
      };
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
      case "slotLevel": // filled in by the cast it's part of (atSlotLevel)
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
    readonly dieAtLeast?: string | undefined;
    readonly halfDice?: true | undefined;
  },
  scaling: Readonly<Record<string, number>>,
): string | undefined {
  if (!source.dice) return undefined;
  const [count = "0", sides = "0"] = source.dice.split("d");
  const dice = Number(scaling[source.diceCount ?? ""] ?? count);
  const rolled = source.halfDice ? Math.ceil(dice / 2) : dice;
  const size = Math.max(
    Number(scaling[source.dieSize ?? ""] ?? sides),
    scaling[source.dieAtLeast ?? ""] ?? 0,
  );
  return `${String(rolled)}d${String(size)}`;
}

// A feature's dice that grow at levels in one class, as Jolt to Life's lightning at Artificer levels 11 and 17.
function classTiered(
  activation: Activation,
  tiers: Feature["classTiers"],
  classLevels: Readonly<Record<string, number>>,
): Activation {
  if (!tiers) return activation;
  const level = classLevels[tiers.class] ?? 0;
  return scaleActivation(
    activation,
    tiers.step,
    tiers.at.filter((at) => level >= at).length,
  );
}

export function cantripTier(level: number): number {
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

// Every timed effect of an activation lasting `duration` instead, as a higher slot's Bestow Curse.
function withDuration(activation: Activation, duration: Duration): Activation {
  const timed = (effects: readonly LeafEffect[]): LeafEffect[] =>
    effects.map((effect) =>
      effect.kind === "modifier" || effect.kind === "applyCondition"
        ? { ...effect, duration }
        : effect,
    );
  const { resolution } = activation;
  switch (resolution.kind) {
    case "save":
      return {
        ...activation,
        resolution: {
          ...resolution,
          onFail: timed(resolution.onFail),
          onSuccess: timed(resolution.onSuccess),
        },
      };
    case "automatic":
      return {
        ...activation,
        resolution: { ...resolution, effects: timed(resolution.effects) },
      };
    case "attack":
      return {
        ...activation,
        resolution: { ...resolution, onHit: timed(resolution.onHit) },
      };
    default:
      return activation;
  }
}

export function scaleActivation(
  activation: Activation,
  step: ScaleStep,
  times: number,
): Activation {
  if (times <= 0 || "slotOnly" in step) return activation;
  if ("durations" in step) {
    const reached = step.durations.filter(({ at }) => times >= at);
    const longer = reached[reached.length - 1]?.duration;
    return longer ? withDuration(activation, longer) : activation;
  }
  if ("addRadius" in step) {
    const { targeting, trigger } = activation;
    const more = step.addRadius * times;
    if ("area" in targeting) {
      return {
        ...activation,
        targeting: {
          ...targeting,
          area: { ...targeting.area, radius: targeting.area.radius + more },
        },
      };
    }
    // A reaction's reach grows, as Aura of the Guardian's 10 feet becoming 30.
    return trigger?.within !== undefined && "range" in targeting
      ? {
          ...activation,
          trigger: { ...trigger, within: trigger.within + more },
          targeting: {
            ...targeting,
            range:
              typeof targeting.range === "number"
                ? targeting.range + more
                : targeting.range,
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
  const steps = step.at
    ? step.at.filter((above) => times >= above).length
    : step.every
      ? Math.min(step.max ?? times, Math.floor(times / step.every))
      : times;
  if (steps <= 0) return activation;
  const { addBonus, hitDice } = step;
  const more = (amount: Amount): Amount => {
    const dice = step.addDice ? addDice(amount, step.addDice, steps) : amount;
    if (!addBonus) return dice;
    const { bonus } = dice;
    return {
      ...dice,
      bonus: {
        ...bonus,
        base: (bonus?.base ?? 0) + addBonus * steps,
        add: bonus?.add ?? [],
      },
    };
  };
  const dice = (amount: Amount): Amount =>
    step.addDice ? addDice(amount, step.addDice, steps) : amount;
  const damage = (list: readonly Damage[]): Damage[] =>
    list.map((item) => ({ ...item, amount: dice(item.amount) }));
  const effects = (list: readonly LeafEffect[]): LeafEffect[] =>
    list.map((effect): LeafEffect => {
      if (effect.kind === "heal" || effect.kind === "tempHp") {
        return { ...effect, amount: more(effect.amount) };
      }
      if (effect.kind === "transference") {
        return { ...effect, amount: more(effect.amount) };
      }
      // What a reaction takes off grows too, as Spirit Shield's d6s.
      if (effect.kind === "reduceDamage" && effect.amount) {
        return { ...effect, amount: more(effect.amount) };
      }
      if (effect.kind === "hitDieHeal") {
        return hitDice
          ? { ...effect, dice: (effect.dice ?? 1) + hitDice * steps }
          : effect;
      }
      if (effect.kind === "dispel") {
        return addBonus
          ? {
              ...effect,
              maxLevel: Math.min(9, effect.maxLevel + addBonus * steps),
            }
          : effect;
      }
      if (effect.kind !== "modifier") return effect;
      const { modifier } = effect;
      switch (modifier.kind) {
        // An extra hit's damage grows too, as Conjure Minor Elementals'.
        // Flame Arrows' quiver holds more pieces with `addBonus`.
        case "hitDamage": {
          const [hit] = damage([modifier.damage]);
          return hit
            ? {
                ...effect,
                modifier: {
                  ...modifier,
                  damage: hit,
                  ...(addBonus && modifier.uses !== undefined
                    ? { uses: modifier.uses + addBonus * steps }
                    : {}),
                },
              }
            : effect;
        }
        // Booming Blade's thunder for moving grows with its cantrip tier.
        case "moveDamage":
          return {
            ...effect,
            modifier: { ...modifier, damage: damage(modifier.damage) },
          };
        // A flat bonus grows only by `addBonus`, as Elemental Weapon's +1 to hit or Aid's Hit Point maximum.
        case "bonus":
          return addBonus && modifier.amount.dice === undefined
            ? {
                ...effect,
                modifier: {
                  ...modifier,
                  amount: {
                    ...modifier.amount,
                    bonus: {
                      base:
                        (modifier.amount.bonus?.base ?? 0) + addBonus * steps,
                      add: modifier.amount.bonus?.add ?? [],
                    },
                  },
                },
              }
            : effect;
        case "damageBonus":
          return addBonus
            ? {
                ...effect,
                modifier: { ...modifier, amount: more(modifier.amount) },
              }
            : effect;
        // The cold that strikes back grows with Armor of Agathys' Temporary Hit Points.
        case "retaliate":
          return {
            ...effect,
            modifier: {
              ...modifier,
              damage: modifier.damage.map((item) => ({
                ...item,
                amount: more(item.amount),
              })),
            },
          };
        case "lingeringDamage":
          return step.initial
            ? effect
            : {
                ...effect,
                modifier: { ...modifier, damage: damage(modifier.damage) },
              };
        default:
          return effect;
      }
    });
  const scaled = (resolution: Resolution): Resolution => {
    switch (resolution.kind) {
      case "automatic":
        return {
          ...resolution,
          damage: damage(resolution.damage),
          effects: effects(resolution.effects),
          ...(resolution.burst
            ? {
                burst: {
                  ...resolution.burst,
                  damage: damage(resolution.burst.damage),
                },
              }
            : {}),
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
          ...(resolution.chosen ? { chosen: effects(resolution.chosen) } : {}),
        };
      default:
        return resolution satisfies never;
    }
  };
  // What an area it leaves does later grows with the slot too, as Spirit Guardians' damage does, and so does
  // what strikes in a hit's place, as Lightning Arrow's.
  const { area, areas, trigger } = activation;
  const grown = (item: AreaEffect): AreaEffect => ({
    ...item,
    ...(item.resolution ? { resolution: scaled(item.resolution) } : {}),
    ...(item.holding ? { holding: scaled(item.holding) } : {}),
  });
  return {
    ...activation,
    ...(areas ? { areas: areas.map(grown) } : {}),
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
  const rolling = amount.highest
    ? { ...dice, roll: (sides: number) => sides }
    : amount.rerollOnes
      ? rerollingOnes(dice)
      : dice;
  const rolled = notation
    ? amount.reroll
      ? rollRerolling(notation, rolling, diceMultiplier, amount.reroll)
      : amount.explode
        ? rollExploding(
            notation,
            rolling,
            diceMultiplier,
            evaluateFormula(amount.explode, stats),
          )
        : rollDiceNotation(notation, rolling, diceMultiplier)
    : 0;
  return (
    rolled * (amount.times ?? 1) +
    (amount.bonus ? evaluateFormula(amount.bonus, stats) : 0)
  );
}

// Each die showing its highest face, the added ones too, adds another die, at most `most` more, as Sorcerous Burst's.
export function rollExploding(
  notation: string,
  dice: Dice,
  multiplier: number,
  most: number,
): number {
  const [count = "0", sides = "0"] = notation.split("d");
  let left = Number(count) * multiplier;
  let added = 0;
  let total = 0;
  while (left > 0) {
    left -= 1;
    const face = dice.roll(Number(sides));
    total += face;
    if (face === Number(sides) && added < most) {
      added += 1;
      left += 1;
    }
  }
  return total;
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
    // What the areas it stands in give it, as Silence's Immunity to Thunder damage or Aura of Warding's Resistances.
    ...(access.state ? zoneModifiers(actor, access.state, access) : []),
  ]) {
    if (modifier.kind === "resistance") resistances.push(modifier.damage);
    if (modifier.kind === "vulnerability")
      vulnerabilities.push(modifier.damage);
    if (modifier.kind === "immunity") immunities.push(modifier.damage);
  }
  const absorbs = stats.passives.flatMap((passive) =>
    passive.kind === "absorb" ? passive.damage : [],
  );
  // Elemental Bane: no Resistance to its type.
  const baned = actor.activeEffects.flatMap(({ modifier }) =>
    modifier.kind === "bane" ? [modifier.damage] : [],
  );
  return {
    adjustments: [],
    resistances: resistances.filter((type) => !baned.includes(type)),
    vulnerabilities,
    immunities,
    absorbs,
  };
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
