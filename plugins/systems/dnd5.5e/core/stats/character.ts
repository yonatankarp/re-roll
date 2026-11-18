// A player character's stats, from its build, gear and what affects it.
import type { ContentAccess } from "#sdk";
import {
  carriedWeight,
  carryingCapacity,
  encumberedSpeed,
  encumbrance,
} from "../carry.ts";
import { ENCUMBRANCE, variantOn } from "../variant-rules.ts";
import { hasAspect, pactWeaponId } from "../combat/queries.ts";
import {
  type Actor,
  type DndState,
  effectiveBuild,
  equipped,
  hasCondition,
  turnId,
} from "../state.ts";
import {
  ALL_SKILLS,
  type Item,
  type Ability,
  type FreeCast,
  ArmorSchema,
  BackgroundSchema,
  ClassSchema,
  FeatSchema,
  SkillSchema,
  type Formula,
  ItemSchema,
  type Passive,
  type Skill,
  SpeciesSchema,
  SubclassSchema,
  type Subclass,
  type ClassDef,
  type Spell,
  SpellSchema,
  WeaponSchema,
} from "../schemas.ts";
import { featureRules } from "../feature-rules.ts";
import { type Caster, multiclassSlots } from "../multiclass.ts";
import { freeOption, holdsConcentration, withMetamagic } from "../metamagic.ts";
import { withInvocations } from "../invocations.ts";
import {
  CAST_OPTION_PREFIX,
  castOptionsOf,
  waitingOptions,
  withCastOptions,
} from "../cast-options.ts";
import { withWeaponRiders } from "../weapon-riders.ts";
import {
  THROW_PREFIX,
  WEAPON_PREFIX,
  castFrom,
  spellOfSource,
} from "../combat/ids.ts";
import { zoneModifiers } from "../zones.ts";
import { lookup, featureOf, circleOptions } from "./content.ts";
import type { Stats, KnownAction } from "./model.ts";
import {
  withEffectScores,
  withItemAbilities,
  ownAbilities,
  abilityModifier,
  proficiencyBonus,
  bestMentalAbility,
} from "./abilities.ts";
import { ownAc, bestAc } from "./armor-class.ts";
import { doesSomething } from "./resolution.ts";
import { scaleActivation, cantripTier } from "./scaling.ts";
import { withFallbackSaves, exhaustionOf } from "./bonuses.ts";
import { evaluateFormula } from "./formulas.ts";
import { scaledDice, diceCount } from "./dice.ts";
import { raisedByFeat, latePicks, featSpellAbilities } from "./spell-lists.ts";
import { freeCastActions } from "./free-casting.ts";
import {
  spellChanged,
  retyped,
  castWith,
  withDcBonus,
  withSpellDamage,
  withPotentCantrips,
  withSpellTypes,
  withCastsAs,
  withExtraTargets,
  withRiders,
  castWithVariants,
} from "./spell-changes.ts";
import {
  charged,
  itemAction,
  fastHands,
  farLobbed,
  itemCasts,
  itemUses,
  storedCasts,
  unknownSpells,
  itemPools,
} from "./items.ts";
import {
  plainWeapon,
  bestForm,
  bestAmmunition,
  weaponActivation,
  firing,
  trainedWith,
  weaponProficient,
  imbuedRange,
  thrownActivation,
  UNARMED_STRIKE,
  unarmedStrike,
  withUnarmedBonus,
  emptyHanded,
} from "./weapons.ts";
import {
  collectFeatureData,
  withVariant,
  attacksFrom,
  passiveAttacks,
  passiveBonus,
} from "./features.ts";
import { familiarFrom, spellCompanions } from "./companions.ts";

// Character builds whose features give an aura, filled in as their stats are derived.
export const auraBuilds = new WeakMap<object, boolean>();

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

export function characterStats(actor: Actor, access: ContentAccess): Stats {
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
  // Options a story granted, as a Blessing or a survivor talent, read as features but not listed among them (#192).
  const granted = [...new Set(actor.granted ?? [])].filter((id) =>
    access.content(id),
  );
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
  for (const id of [...featureIds, ...granted]) {
    for (const passive of featureOf(access, id).passives) {
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
    [...featureIds, ...granted],
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
    // only while the bearer has a condition, as Adrenaline Surge's Frightened
    (!("whileCondition" in passive) ||
      !passive.whileCondition ||
      hasCondition(actor, passive.whileCondition)) &&
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
            castOptionsOf([
              ...[...featureIds, ...granted].flatMap((id) => {
                const feature = access.content(id)
                  ? featureOf(access, id)
                  : undefined;
                return feature
                  ? [withVariant(featureRules(feature), variants)]
                  : [];
              }),
              ...circleOptions(access),
            ]),
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
    ...familiarFrom(
      knownSpells,
      castingAbility,
      access,
      partial.spellAbility,
      partial.passives,
    ),
    // A known spell that gives a lasting companion, as Homunculus Servant's, gives it as a feature would.
    passives: [...partial.passives, ...spellCompanions(knownSpells, access)],
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
