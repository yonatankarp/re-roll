// The spells a creature knows: class lists, spells by name, traits' cantrips and feats' spells.
import type { ContentAccess } from "#sdk";
import {
  type Ability,
  type FreeCast,
  ClassSchema,
  FeatSchema,
  type Feature,
  FeatureSchema,
  type Species,
  type CharacterBuild,
  type Spell,
  SpellSchema,
} from "../schemas.ts";
import { lookup, maybeLookup } from "./content.ts";
import { doesSomething } from "./resolution.ts";

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

export function latePicks(
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

// A feature's spells with a trait's cantrip swapped after a Long Rest (swap.ts).
export function swappedSpells(
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

export function classSpells(
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

// The abilities a level's feat raised, when that feat makes its raised save proficient, as Resilient does.
export function raisedByFeat(
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
export function featSpellAbilities(
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
