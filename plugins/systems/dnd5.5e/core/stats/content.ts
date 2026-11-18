// Content entries read through their schemas, each parsed once, and features found by id.
import type { ContentAccess } from "#sdk";
import type { z } from "zod";
import {
  type Feature,
  FeatureSchema,
  CharacterOptionSchema,
} from "../schemas.ts";

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

// A feature, or a granted character option read as one (#192): a supernatural gift's or survivor talent's mechanics.
const optionFeatures = new WeakMap<object, Feature>();

export function featureOf(
  access: Pick<ContentAccess, "content">,
  id: string,
): Feature {
  const feature = maybeLookup(access, FeatureSchema, id);
  if (feature) return feature;
  const option = maybeLookup(access, CharacterOptionSchema, id);
  if (!option) return lookup(access, FeatureSchema, id);
  const known = optionFeatures.get(option);
  if (known) return known;
  const made = FeatureSchema.parse({
    id: option.id,
    name: option.name,
    text: option.text || option.name,
    automation: option.automation,
    passives: option.passives,
    activations: option.activations,
    resources: option.resources,
    ...(option.spells ? { spells: option.spells } : {}),
    ...(option.freeCast ? { freeCast: option.freeCast } : {}),
    ...(option.castsOnly ? { castsOnly: option.castsOnly } : {}),
    ...(option.variants ? { variants: option.variants } : {}),
  });
  optionFeatures.set(option, made);
  return made;
}

// Circle casting options (#192): any of the party's casters can cast with one while another joins (class-options.ts).
// Read once per content.
const circleBy = new WeakMap<ContentAccess["content"], readonly Feature[]>();

export function circleOptions(access: ContentAccess): readonly Feature[] {
  const known = circleBy.get(access.content);
  if (known) return known;
  const found = access
    .contentIds()
    .filter((id) => id.includes(":circle-casting-option/"))
    .map((id) => featureOf(access, id))
    .filter((feature) =>
      feature.passives.some((passive) => passive.kind === "castOption"),
    );
  circleBy.set(access.content, found);
  return found;
}
