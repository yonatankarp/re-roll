import { z } from "zod";
import {
  CARET_RANGE_PATTERN,
  VERSION_PATTERN,
  satisfiesCaret,
} from "./semver.ts";
import { PLUGIN_ID_PATTERN } from "./manifest.ts";

export const SDK_VERSION = "1.0.0";

const RESERVED_FOLDERS = new Set(["assets"]);

export const ContentIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]*:[a-z][a-z-]*\/[a-z0-9][a-z0-9-]*$/,
    "must look like plugin:kind/name",
  );

export const ContentEntrySchema = z.object({
  id: ContentIdSchema,
  replaces: ContentIdSchema.optional(),
});

export interface ContentEntry {
  readonly id: string;
  readonly replaces?: string | undefined;
}

type Parsed<T> =
  | {
      readonly ok: true;
      readonly entry: T;
      readonly references: readonly string[];
    }
  | { readonly ok: false; readonly error: z.ZodError };

function parser<T>(
  schema: z.ZodType<T>,
  references?: (entry: T) => readonly string[],
) {
  return (raw: unknown): Parsed<T> => {
    const result = schema.safeParse(raw);
    return result.success
      ? {
          ok: true,
          entry: result.data,
          references: references?.(result.data) ?? [],
        }
      : { ok: false, error: result.error };
  };
}

export interface ContentKind {
  readonly idPrefix: string;
  readonly parse: (raw: unknown) => Parsed<ContentEntry>;
}

// The closure keeps each kind's exact type, so the engine never needs to cast entries.
export function contentKind<T extends ContentEntry>(definition: {
  readonly idPrefix: string;
  readonly schema: z.ZodType<T>;
  readonly references?: (entry: T) => readonly string[];
}): ContentKind {
  return {
    idPrefix: definition.idPrefix,
    parse: parser(definition.schema, definition.references),
  };
}

export interface EncounterEntry {
  readonly id: string;
}

export interface EncounterKind {
  readonly parse: (raw: unknown) => Parsed<EncounterEntry>;
}

export function encounterKind<T extends EncounterEntry>(definition: {
  readonly schema: z.ZodType<T>;
  readonly references?: (entry: T) => readonly string[];
}): EncounterKind {
  return { parse: parser(definition.schema, definition.references) };
}

export interface SystemOutcomes {
  readonly keys: readonly string[];
  readonly groups?: Readonly<Record<string, readonly string[]>>;
}

export interface GameSystem {
  readonly id: string;
  readonly version: string;
  readonly sdk: string;
  readonly contentKinds: Readonly<Record<string, ContentKind>>; // keyed by folder name
  readonly checkSchema: z.ZodType;
  readonly encounters: EncounterKind;
  readonly outcomes: SystemOutcomes;
  readonly storyEffects: Readonly<Record<string, z.ZodType>>;
  readonly storyPredicates: Readonly<Record<string, z.ZodType>>;
}

function assertNamespaced(system: GameSystem, names: readonly string[]): void {
  for (const name of names) {
    if (!name.startsWith(`${system.id}:`)) {
      throw new Error(
        `System ${system.id}: "${name}" must be namespaced as ${system.id}:name`,
      );
    }
  }
}

// A broken system is a programming error, so it fails at startup rather than reporting issues.
export function defineSystem(system: GameSystem): GameSystem {
  const fail = (message: string): never => {
    throw new Error(`System ${system.id}: ${message}`);
  };

  if (!PLUGIN_ID_PATTERN.test(system.id)) fail("invalid id");
  if (!VERSION_PATTERN.test(system.version)) fail("version must be x.y.z");
  if (!CARET_RANGE_PATTERN.test(system.sdk)) fail("sdk must be a caret range");
  if (!satisfiesCaret(SDK_VERSION, system.sdk))
    fail(`needs SDK ${system.sdk}, not ${SDK_VERSION}`);

  const { keys, groups = {} } = system.outcomes;
  if (keys.length === 0) fail("must declare at least one outcome");
  if (new Set(keys).size !== keys.length) fail("outcome keys must be unique");
  for (const [group, members] of Object.entries(groups)) {
    if (keys.includes(group))
      fail(`outcome group "${group}" has the same name as a key`);
    for (const member of members) {
      if (!keys.includes(member))
        fail(`outcome group "${group}" has unknown key "${member}"`);
    }
  }

  for (const folder of Object.keys(system.contentKinds)) {
    if (RESERVED_FOLDERS.has(folder))
      fail(`content folder "${folder}" is reserved`);
  }

  assertNamespaced(system, Object.keys(system.storyEffects));
  assertNamespaced(system, Object.keys(system.storyPredicates));

  return Object.freeze(system);
}
