import { z } from "zod";
import {
  type GameEvent,
  GameEventSchema,
  type GameState,
  type Input,
  InputSchema,
  isNamespacedEvent,
} from "../kernel/events.ts";
import type { Registry } from "./loader.ts";
import { type RunContext, applyEvent, startRun, step } from "./turn.ts";

export const SAVE_FORMAT_VERSION = 1;

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

  const parsed = SaveFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `Invalid save file: ${parsed.error.message}` };
  }
  const save = parsed.data;

  if (save.formatVersion !== SAVE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `Unknown save format ${String(save.formatVersion)}`,
    };
  }
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
  return { ok: true, save, state, warnings };
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
