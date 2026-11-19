import { own } from "../kernel/own.ts";
import { z } from "zod";
import { STORY_FRAME_SCHEMAS } from "../story/runtime.ts";
import {
  type Decision,
  DecisionSchema,
  type Frame,
  type GameEvent,
  GameEventSchema,
  type GameState,
  GameStateSchema,
  type Input,
  InputSchema,
  isNamespacedEvent,
} from "../kernel/events.ts";
import { type Registry, systemOf } from "./loader.ts";
import {
  AWAIT_FRAME,
  REPLAY_FRAME,
  ReplayPayloadSchema,
} from "../kernel/system.ts";
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
    const next = table[version]; // an integer, which never names a prototype key
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
    system: {
      id: systemOf(registry).id,
      version: systemOf(registry).version,
    },
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

export function foldEvents(
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
  if (save.system.id !== run.system.id) {
    return {
      ok: false,
      error: `This save uses the "${save.system.id}" system, not "${run.system.id}"`,
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
    if (
      hash !== plugin.hash &&
      registry.legacyPluginHash(plugin.id) !== plugin.hash
    ) {
      warnings.push(`The plugin "${plugin.id}" has changed since this save.`);
    }
  }

  const log = save.log as readonly LogEntry[];
  for (const { events } of log) {
    for (const event of events) {
      if (!isNamespacedEvent(event)) continue;
      const schema = own(run.system.eventSchemas, event.kind);
      if (!schema?.safeParse(event.payload).success) {
        return { ok: false, error: `Invalid event in save: ${event.kind}` };
      }
    }
  }

  const shape = checkLog(log);
  if (shape) return { ok: false, error: shape };
  // Events that each look right can still disagree, and the rules throw on those.
  try {
    const state = foldEvents(run, log);
    if (state === null)
      return { ok: false, error: "The save has no run start" };
    if (!GameStateSchema.safeParse(state).success) {
      return { ok: false, error: "The save's game state is invalid" };
    }
    if (!run.system.stateSchema.safeParse(state.system).success) {
      return { ok: false, error: "The save's system state is invalid" };
    }
    const unresumable = checkResumable(run, state);
    if (unresumable) return { ok: false, error: unresumable };
    return { ok: true, save, state, warnings };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The save is damaged: ${reason}` };
  }
}

// A run starts once, first, and every input after the start answers a decision, as replayInputs plays them.
function checkLog(log: readonly LogEntry[]): string | null {
  const [first, ...rest] = log;
  if (first?.input.kind !== "start" || first.events[0]?.kind !== "runStarted")
    return "The save has no run start";
  const starts = log.flatMap(({ events }) =>
    events.filter((event) => event.kind === "runStarted"),
  );
  if (starts.length > 1) return "The save starts its run more than once";
  if (rest.some(({ input }) => input.kind !== "answer"))
    return "The save starts its run more than once";
  return null;
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
  if (frame.kind === REPLAY_FRAME) {
    const replay = ReplayPayloadSchema.safeParse(frame.payload);
    return replay.success
      ? checkFrame(run, replay.data.frame)
      : "The save waits on an answer to a step that can't be read";
  }
  const story = own(STORY_FRAME_SCHEMAS, frame.kind); // the engine's own
  if (story)
    return story.safeParse(frame.payload).success
      ? null
      : `The save's step ${frame.kind} can't be read`;
  const definition = own(run.system.frames, frame.kind);
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
