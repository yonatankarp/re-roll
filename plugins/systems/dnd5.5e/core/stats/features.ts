// Features and their picked variants, gathered into what they give a creature.
import type { ContentAccess } from "#sdk";
import {
  type Ability,
  type FreeCast,
  type DamageType,
  type Feature,
  type LeafEffect,
  type Passive,
  SpellSchema,
} from "../schemas.ts";
import { featureRules, grantedSpells } from "../feature-rules.ts";
import { featureOf, maybeLookup } from "./content.ts";
import { type KnownAction, type Stats, passiveModifiers } from "./model.ts";
import { classTiered, scaleActivation, cantripTier } from "./scaling.ts";
import { evaluateFormula } from "./formulas.ts";
import { swappedSpells } from "./spell-lists.ts";
import { freeCastOf } from "./free-casting.ts";

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

export function collectFeatureData(
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
    const feature = featureOf(access, id);
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
    const feature = withVariant(featureRules(featureOf(access, id)), variants);
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
    const from = featureOf(access, id).freeCastsFrom;
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

// Imported features are only text, so the attacks a character gets are read from the feature's name.
export function passiveAttacks(
  passives: readonly Passive[],
): readonly number[] {
  return passives.flatMap((passive) =>
    passive.kind === "multiattack" ? [passive.attacks] : [],
  );
}

export function attacksFrom(featureId: string): number {
  if (featureId.endsWith("three-extra-attacks")) return 4;
  if (featureId.endsWith("two-extra-attacks")) return 3;
  return featureId.endsWith("extra-attack") ? 2 : 1;
}

export function passiveBonus(
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
