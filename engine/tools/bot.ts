import { createDice, rngFromSeed } from "../kernel/dice.ts";
import type { GameState, Input } from "../kernel/events.ts";
import { type LogEntry, replayInputs } from "../run/save.ts";
import { type RunContext, startRun, step, wouldEnd } from "../run/turn.ts";
import {
  REST_OPTION_PREFIX,
  SCENE_DECISION_PREFIX,
  sceneActionsHere,
} from "../story/runtime.ts";

export interface BotRun {
  readonly seed: string;
  readonly outcome: "ending" | "deadEnd" | "defeat" | "tooLong";
  readonly inputs: readonly Input[];
  readonly log: readonly LogEntry[];
  readonly state: GameState;
  readonly scenes: readonly string[];
}

// The bot has its own dice, so its choices never disturb the game's own rolls.
export function playRun(
  run: RunContext,
  seed: string,
  options: {
    readonly maxDecisions: number;
    readonly onState?: (state: GameState) => void;
    // Plays the player's fights and builds the character with the system's own tactics, as a sensible person
    // would. Story choices stay random.
    readonly smart?: boolean;
    // Rests whenever a scene allows, taking the last (longest) rest offered, as a careful player does.
    readonly rests?: boolean;
    // Leaves a story choice that would end the adventure while another choice doesn't, so short endings
    // don't hide how a long adventure plays.
    readonly avoidEndings?: boolean;
    readonly settings?: Readonly<Record<string, string>>;
  },
): BotRun {
  const dice = createDice(rngFromSeed(`${seed}:bot`));
  const started = startRun(run, seed, options.settings);
  const start: Input = options.settings
    ? { kind: "start", settings: { ...options.settings } }
    : { kind: "start" };
  const inputs: Input[] = [start];
  const log: LogEntry[] = [{ input: start, events: started.events }];
  const scenes = new Set<string>();
  let { state, pending } = started;
  options.onState?.(state);

  const noteScenes = (events: LogEntry["events"]): void => {
    for (const event of events) {
      if (event.kind === "sceneEntered") scenes.add(event.scene);
    }
  };
  noteScenes(started.events);

  for (let count = 0; pending && count < options.maxDecisions; count += 1) {
    const decisionId = pending.id;
    const answer = (optionId: string): Extract<Input, { kind: "answer" }> => ({
      kind: "answer",
      decisionId,
      optionId,
    });
    // Without rests on it never rests, so its runs measure the adventure as written.
    const rest = options.rests
      ? pending.options.findLast((item) =>
          item.id.startsWith(REST_OPTION_PREFIX),
        )
      : undefined;
    // Nor does it drink or change gear between choices, which the sheet offers.
    const actions = new Set(
      pending.id.startsWith(SCENE_DECISION_PREFIX)
        ? sceneActionsHere(run, state).map((action) => action.id)
        : [],
    );
    let choices = pending.options.filter(
      (item) =>
        !item.id.startsWith(REST_OPTION_PREFIX) && !actions.has(item.id),
    );
    if (options.avoidEndings && pending.id.startsWith(SCENE_DECISION_PREFIX)) {
      // Trying a choice sees the same dice the real one would.
      const scene = pending;
      const going = choices.filter(
        (item) => !wouldEnd(run, state, scene, item.id),
      );
      if (going.length > 0) choices = going;
    }
    const option =
      rest ??
      (options.smart && run.system.tactical?.(pending)
        ? {
            id: run.system.decidePolicy(pending, {
              state: state.system,
              dice,
              content: run.content,
              contentIds: run.contentIds,
            }),
          }
        : choices[dice.below(choices.length)]);
    if (!option) throw new Error(`${pending.id} has no options`);
    const input = answer(option.id);
    const outcome = step(run, state, input);
    if (!outcome.ok) throw new Error(outcome.error);
    ({ state, pending } = outcome);
    inputs.push(input);
    log.push({ input, events: outcome.events });
    noteScenes(outcome.events);
    options.onState?.(state);
  }

  const ended = state.story.ended;
  return {
    seed,
    outcome: pending || ended === null ? "tooLong" : ended,
    inputs,
    log,
    state,
    scenes: [...scenes].sort(),
  };
}

export interface BotFailure {
  readonly seed: string;
  readonly problem: string;
  readonly inputs: readonly Input[];
}

export interface BotReport {
  readonly runs: number;
  readonly failures: readonly BotFailure[];
  readonly endings: Readonly<Record<string, number>>;
  readonly defeats: number;
  readonly unvisitedScenes: readonly string[];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function testAdventure(
  run: RunContext,
  options: {
    readonly runs: number;
    readonly maxDecisions: number;
    readonly seedPrefix?: string;
    readonly smart?: boolean;
    readonly rests?: boolean;
    readonly avoidEndings?: boolean;
    readonly settings?: Readonly<Record<string, string>>;
  },
): BotReport {
  const failures: BotFailure[] = [];
  const endings: Record<string, number> = {};
  let defeats = 0;
  const visited = new Set<string>();

  for (let index = 0; index < options.runs; index += 1) {
    const seed = `${options.seedPrefix ?? "bot"}-${String(index)}`;
    let inputs: readonly Input[] = [];
    try {
      const result = playRun(run, seed, {
        maxDecisions: options.maxDecisions,
        ...(options.smart ? { smart: true } : {}),
        ...(options.rests ? { rests: true } : {}),
        ...(options.avoidEndings ? { avoidEndings: true } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      });
      ({ inputs } = result);
      for (const scene of result.scenes) visited.add(scene);
      const lastScene = result.state.story.scene ?? "none";
      endings[lastScene] = (endings[lastScene] ?? 0) + 1;

      // A party can lose a fight, so a defeat is a valid way for a run to end.
      if (result.outcome === "defeat") defeats += 1;
      if (result.outcome !== "ending" && result.outcome !== "defeat") {
        failures.push({
          seed,
          problem: `${result.outcome} at scene ${lastScene}`,
          inputs,
        });
        continue;
      }
      const replay = replayInputs(run, seed, inputs);
      if (
        !sameJson(replay.state, result.state) ||
        !sameJson(replay.log, result.log)
      ) {
        failures.push({ seed, problem: "Replay diverged", inputs });
      }
    } catch (error) {
      failures.push({
        seed,
        problem: error instanceof Error ? error.message : String(error),
        inputs,
      });
    }
  }

  return {
    runs: options.runs,
    failures,
    endings,
    defeats,
    unvisitedScenes: run.adventure.scenes
      .map((scene) => scene.id)
      .filter((scene) => !visited.has(scene)),
  };
}
