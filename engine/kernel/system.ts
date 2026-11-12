import { z } from "zod";
import type { Dice } from "./dice.ts";
import type { Decision, Frame, JsonObject, SystemEvent } from "./events.ts";
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

export interface SystemContext<S> {
  readonly state: S;
  readonly dice: Dice;
  readonly content: (id: string) => ContentEntry | undefined;
  readonly contentIds: () => readonly string[];
}

// Handlers report what happened and never change state, so saves can replay them.
export interface SystemResult {
  readonly events?: readonly SystemEvent[];
  readonly frames?: readonly Frame[]; // the first one listed runs first
}

export interface StoryEffectDef<S> {
  readonly schema: z.ZodType;
  readonly apply: (args: unknown, context: SystemContext<S>) => SystemResult;
  // Content ids the arguments name, checked when the adventure loads.
  readonly references?: (args: unknown) => readonly string[];
}

export interface StoryPredicateDef<S> {
  readonly schema: z.ZodType;
  readonly evaluate: (args: unknown, state: S) => boolean;
}

export interface FrameDef<S> {
  readonly run: (
    payload: JsonObject,
    context: SystemContext<S>,
  ) => SystemResult;
}

export function storyEffect<A, S>(definition: {
  readonly schema: z.ZodType<A>;
  readonly apply: (args: A, context: SystemContext<S>) => SystemResult;
  readonly references?: (args: A) => readonly string[];
}): StoryEffectDef<S> {
  const { references } = definition;
  return {
    schema: definition.schema,
    apply: (args, context) =>
      definition.apply(definition.schema.parse(args), context),
    ...(references
      ? { references: (args) => references(definition.schema.parse(args)) }
      : {}),
  };
}

export function storyPredicate<A, S>(definition: {
  readonly schema: z.ZodType<A>;
  readonly evaluate: (args: A, state: S) => boolean;
}): StoryPredicateDef<S> {
  return {
    schema: definition.schema,
    evaluate: (args, state) =>
      definition.evaluate(definition.schema.parse(args), state),
  };
}

export function frameHandler<P, S>(definition: {
  readonly schema: z.ZodType<P>;
  readonly run: (payload: P, context: SystemContext<S>) => SystemResult;
}): FrameDef<S> {
  return {
    run: (payload, context) =>
      definition.run(definition.schema.parse(payload), context),
  };
}

export const AWAIT_FRAME = "kernel:await";

// Suspends play until the decision is answered. A save at this point resumes exactly here.
export function awaitDecision(decision: Decision): Frame {
  return { kind: AWAIT_FRAME, payload: { decision } };
}

// A choice the player makes when starting a game, such as difficulty, kept with the run.
export interface SystemSetting {
  readonly id: string;
  readonly label: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly undo?: boolean; // lets the player take back their last choice, as a forgiving option
  }[];
  readonly default: string;
}

export interface RunSetup {
  readonly settings: Readonly<Record<string, string>>; // one valid option per declared setting
  readonly actors: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: "player" | "companion";
  }[];
  readonly dice: Dice;
  readonly content: (id: string) => ContentEntry | undefined;
  readonly contentIds: () => readonly string[];
}

export interface ContentAccess {
  readonly content: (id: string) => ContentEntry | undefined;
  readonly contentIds: () => readonly string[];
}

export interface ImportSource {
  readonly name: string;
  readonly slug: string;
  readonly text: string; // the whole entry as found, used to spot changes between runs
  readonly data: unknown; // what the system's own code parsed from the text
  readonly problem: string | null; // set when the entry can't be used
}

// An entry that code parsed entirely from a saved book page, with no model involved.
export interface ParsedImport {
  readonly slug: string;
  readonly entry: unknown;
  readonly notes: readonly string[];
}

// A second model pass that compares accepted mechanics with the source text.
export interface ImportVerification {
  readonly system: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly applies: (draft: unknown) => boolean;
  readonly prompt: (answer: string, source: ImportSource) => string;
  // Returns a problem, null for a pass, or undefined when the verdict can't be read.
  readonly judge: (
    verdict: unknown,
    source: ImportSource,
  ) => string | null | undefined;
}

// How a system turns one kind of book text into content. Code does as much as it can,
// and the model only fills in what code can't work out on its own.
export interface ImportKind {
  readonly idPrefix: string;
  readonly split: (text: string) => readonly ImportSource[];
  readonly systemPrompt: string;
  readonly prompt: (source: ImportSource) => string;
  readonly modelSchema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly validate: (
    value: unknown,
    source: ImportSource,
  ) => z.ZodSafeParseResult<unknown>;
  // True when a reviewed entry has the same text, so its mechanics are reused and the model isn't asked.
  readonly matchesReference: (
    source: ImportSource,
    reference: unknown,
  ) => boolean;
  readonly verification: ImportVerification;
  readonly build: (args: {
    readonly source: ImportSource;
    readonly draft: unknown;
    readonly reference: unknown;
    readonly pluginId: string;
    readonly knownIds: readonly string[];
  }) => { readonly entry: unknown; readonly notes: readonly string[] };
}

// What the adventure has planned for the ways an encounter can end.
export interface EncounterOptions {
  readonly canFlee: boolean; // offer the player a way out mid-fight
  // Losing without the player's character dying ends the encounter with outcome "defeat",
  // and otherwise it's partyDefeated. The character dying is always partyDefeated.
  readonly defeatContinues: boolean;
}

// A rest the player may call between scenes. `effect` names one of the system's story effects.
export interface RestOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string; // one line on what it gives back, such as "Spend Hit Dice"
  readonly effect: string;
}

export interface SystemDefinition<S> {
  readonly id: string;
  readonly version: string;
  readonly sdk: string;
  readonly contentKinds: Readonly<Record<string, ContentKind>>; // keyed by folder name
  readonly checkSchema: z.ZodType;
  readonly encounters: EncounterKind;
  readonly outcomes: SystemOutcomes;
  readonly stateSchema: z.ZodType<S>;
  readonly eventSchemas: Readonly<Record<string, z.ZodType>>; // payload of each namespaced event
  readonly storyEffects: Readonly<Record<string, StoryEffectDef<S>>>;
  readonly storyPredicates: Readonly<Record<string, StoryPredicateDef<S>>>;
  readonly frames: Readonly<Record<string, FrameDef<S>>>;
  readonly settings?: readonly SystemSetting[];
  readonly createRun: (setup: RunSetup) => S;
  readonly resolveCheck: (
    check: unknown,
    context: SystemContext<S>,
  ) => SystemResult & { readonly outcome: string };
  readonly startEncounter: (
    encounter: unknown,
    context: SystemContext<S>,
    options: EncounterOptions,
  ) => SystemResult;
  readonly applyEvent: (state: S, event: SystemEvent) => S;
  readonly nextDecision: (state: S, access: ContentAccess) => Decision | null;
  // The rests the rules allow right now, offered with each scene's choices.
  readonly rests?: (state: S) => readonly RestOption[];
  readonly importKinds?: Readonly<Record<string, ImportKind>>; // keyed by content folder
  readonly htmlParsers?: Readonly<
    Record<
      string,
      (
        html: string,
        pluginId: string,
        knownIds?: readonly string[], // what other plugins hold, so a book can refer to their classes and feats
      ) => readonly ParsedImport[]
    >
  >; // keyed by content folder
  readonly decidePolicy: (
    decision: Decision,
    context: SystemContext<S>,
  ) => string;
  // Decisions decidePolicy can also make well for the player, such as a combat turn. The test bot
  // uses this to play like a sensible person rather than at random.
  readonly tactical?: (decision: Decision) => boolean;
}

// What the engine sees: the system's state type is opaque to it.
export type GameSystem = SystemDefinition<unknown>;

function assertNamespaced(id: string, names: readonly string[]): void {
  for (const name of names) {
    if (!name.startsWith(`${id}:`)) {
      throw new Error(
        `System ${id}: "${name}" must be namespaced as ${id}:name`,
      );
    }
  }
}

const RESERVED_IDS = new Set(["kernel", "story"]);

// A broken system is a programming error, so it fails at startup rather than reporting issues.
export function defineSystem<S>(system: SystemDefinition<S>): GameSystem {
  const fail = (message: string): never => {
    throw new Error(`System ${system.id}: ${message}`);
  };

  if (!PLUGIN_ID_PATTERN.test(system.id)) fail("invalid id");
  if (RESERVED_IDS.has(system.id)) fail("this id is reserved");
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

  for (const names of [
    system.storyEffects,
    system.storyPredicates,
    system.frames,
    system.eventSchemas,
  ]) {
    assertNamespaced(system.id, Object.keys(names));
  }

  // The engine only ever hands a system back state that system produced, or that passed its stateSchema.
  return Object.freeze(system) as unknown as GameSystem;
}
