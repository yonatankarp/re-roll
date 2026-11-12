import { z } from "zod";
import { STORY_FRAME_PREFIX } from "../story/runtime.ts";
import {
  type Decision,
  DecisionSchema,
  type Frame,
  type GameEvent,
  GameEventSchema,
  type GameState,
  type Input,
  InputSchema,
  isNamespacedEvent,
} from "./events.ts";
import type { Registry } from "./loader.ts";
import { AWAIT_FRAME } from "./system.ts";
import {
  type RunContext,
  applyEvent,
  pendingDecision,
  startRun,
  step,
} from "./turn.ts";

export const SAVE_FORMAT_VERSION = 1;

export type Migration = (
  raw: Record<string, unknown>,
) => Record<string, unknown>;

// migrations[n] turns a save of format n into format n + 1. Add one whenever SAVE_FORMAT_VERSION goes up.
export const migrations: Readonly<Record<number, Migration>> = {};

// Brings an older save up to the current format, before the strict schema sees it.
export function migrate(
  raw: unknown,
  table: Readonly<Record<number, Migration>> = migrations,
  target = SAVE_FORMAT_VERSION,
): { ok: true; raw: unknown } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: true, raw }; // the schema reports it
  }
  let save = raw as Record<string, unknown>;
  let version = save.formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: true, raw }; // the schema reports it
  }
  if (version > target) {
    return {
      ok: false,
      error: `Unknown save format ${String(version)}: this save was made by a newer version of Re-roll`,
    };
  }
  while (version < target) {
    const next = table[version];
    if (!next) {
      return { ok: false, error: `Unknown save format ${String(version)}` };
    }
    save = { ...next(save), formatVersion: version + 1 };
    version += 1;
  }
  return { ok: true, raw: save };
}

const SaveFileSchema = z.strictObject({
  formatVersion: z.number().int(),
  system: z.strictObject({ id: z.string(), version: z.string() }),
  plugins: z.array(
    z.strictObject({ id: z.string(), version: z.string(), hash: z.string() }),
  ),
  adventure: z.string(),
  seed: z.string(),
  log: z.array(
    z.strictObject({ input: InputSchema, events: z.array(GameEventSchema) }),
  ),
});

export type SaveFile = z.infer<typeof SaveFileSchema>;

export interface LogEntry {
  readonly input: Input;
  readonly events: readonly GameEvent[];
}

export function createSave(
  registry: Registry,
  adventure: string,
  seed: string,
  log: readonly LogEntry[],
): SaveFile {
  return {
    formatVersion: SAVE_FORMAT_VERSION,
    system: { id: registry.system.id, version: registry.system.version },
    plugins: registry.plugins.map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      hash: registry.pluginHash(plugin.id) ?? "",
    })),
    adventure,
    seed,
    log: log.map((entry) => ({
      input: entry.input,
      events: [...entry.events],
    })),
  };
}

export type LoadedSave =
  | {
      readonly ok: true;
      readonly save: SaveFile;
      readonly state: GameState;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

function foldEvents(
  run: RunContext,
  log: readonly LogEntry[],
): GameState | null {
  let state: GameState | null = null;
  for (const { events } of log) {
    for (const event of events) {
      if (event.kind === "runStarted") state = event.state;
      else if (state === null) return null;
      else state = applyEvent(run, state, event);
    }
  }
  return state;
}

// Loading applies the recorded events, so it never re-rolls dice and survives later content changes.
export function loadSave(
  text: string,
  registry: Registry,
  run: RunContext,
): LoadedSave {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "The save file isn't valid JSON" };
  }

  const migrated = migrate(raw);
  if (!migrated.ok) return migrated;
  const parsed = SaveFileSchema.safeParse(migrated.raw);
  if (!parsed.success) {
    return { ok: false, error: `Invalid save file: ${parsed.error.message}` };
  }
  const save = parsed.data;
  if (save.system.id !== registry.system.id) {
    return {
      ok: false,
      error: `This save uses the "${save.system.id}" system, not "${registry.system.id}"`,
    };
  }

  const warnings: string[] = [];
  for (const plugin of save.plugins) {
    const hash = registry.pluginHash(plugin.id);
    if (hash === undefined) {
      return {
        ok: false,
        error: `This save needs the plugin "${plugin.id}", which isn't loaded`,
      };
    }
    if (hash !== plugin.hash) {
      warnings.push(`The plugin "${plugin.id}" has changed since this save.`);
    }
  }

  const log = save.log as readonly LogEntry[];
  for (const { events } of log) {
    for (const event of events) {
      if (!isNamespacedEvent(event)) continue;
      const schema = run.system.eventSchemas[event.kind];
      if (!schema?.safeParse(event.payload).success) {
        return { ok: false, error: `Invalid event in save: ${event.kind}` };
      }
    }
  }

  const state = foldEvents(run, log);
  if (state === null) return { ok: false, error: "The save has no run start" };
  if (!run.system.stateSchema.safeParse(state.system).success) {
    return { ok: false, error: "The save's system state is invalid" };
  }
  const unresumable = checkResumable(run, state);
  if (unresumable) return { ok: false, error: unresumable };
  return { ok: true, save, state, warnings };
}

// A frame the rules no longer know, or whose payload changed shape, would only fail on the
// player's first input, so it is caught at load. Only the stack as it stands is checked, since
// frames that already ran never run again.
function checkFrame(run: RunContext, frame: Frame): string | null {
  if (frame.kind === AWAIT_FRAME) {
    const awaited = z
      .object({ decision: DecisionSchema })
      .safeParse(frame.payload);
    return awaited.success
      ? checkResume(run, awaited.data.decision)
      : "The save waits on a decision that can't be read";
  }
  if (frame.kind.startsWith(STORY_FRAME_PREFIX)) return null; // the engine's own
  const definition = run.system.frames[frame.kind];
  if (!definition)
    return `The save is in the middle of an unknown step, ${frame.kind}`;
  if (
    definition.schema &&
    !definition.schema.safeParse(frame.payload).success
  ) {
    return `The save's step ${frame.kind} no longer fits the rules`;
  }
  return null;
}

// The answer is only added when the player picks, so any option stands in for it.
function checkResume(run: RunContext, decision: Decision): string | null {
  const answer = decision.options[0]?.id ?? "";
  return checkFrame(run, {
    kind: decision.resume.kind,
    payload: { ...decision.resume.payload, answer },
  });
}

function checkResumable(run: RunContext, state: GameState): string | null {
  for (const frame of state.stack) {
    const problem = checkFrame(run, frame);
    if (problem) return problem;
  }
  try {
    const decision = pendingDecision(run, state);
    return decision ? checkResume(run, decision) : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `The save can't find what it was waiting on: ${reason}`;
  }
}

export interface ReplayResult {
  readonly state: GameState;
  readonly log: readonly LogEntry[];
}

// Runs the inputs again from the seed. The core check that the game is fully deterministic.
export function replayInputs(
  run: RunContext,
  seed: string,
  inputs: readonly Input[],
): ReplayResult {
  const [first, ...rest] = inputs;
  if (first?.kind !== "start")
    throw new Error("A replay must begin with start");
  const started = startRun(run, seed, first.settings);
  let { state } = started;
  const log: LogEntry[] = [{ input: first, events: started.events }];

  for (const input of rest) {
    if (input.kind !== "answer") throw new Error("A run can only start once");
    const outcome = step(run, state, input);
    if (!outcome.ok) throw new Error(outcome.error);
    state = outcome.state;
    log.push({ input, events: outcome.events });
  }
  return { state, log };
}
