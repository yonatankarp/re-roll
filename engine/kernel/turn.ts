import { type Adventure } from "../story/adventure.ts";
import { COMPANION_COUNT, rollCompanions } from "../story/companions.ts";
import {
  DIRECTOR_FRAME,
  type RunContext,
  STORY_FRAME_PREFIX,
  assertOwnEvents,
  type StoryResult,
  effectsFrame,
  enterSceneFrame,
  initialStory,
  runStoryFrame,
  sceneVisit,
  storyDecision,
} from "../story/runtime.ts";
import { type RecordingDice, createDice, rngFromSeed } from "./dice.ts";
import {
  type Decision,
  DecisionSchema,
  type Frame,
  type GameEvent,
  type GameState,
  type Input,
  PLAYER_ACTOR,
  isNamespacedEvent,
  isNarrativeEvent,
} from "./events.ts";
import { z } from "zod";
import type { Registry } from "./loader.ts";
import { AWAIT_FRAME } from "./system.ts";

// Far beyond any real chain of rules, so hitting it means a handler is looping.
const MAX_WORK_PER_STEP = 10_000;

export type { RunContext };

export function createRunContext(
  registry: Registry,
  adventureId: string,
): RunContext {
  const adventure: Adventure | undefined = registry.adventure(adventureId);
  if (!adventure) throw new Error(`Adventure "${adventureId}" is not loaded`);
  return {
    system: registry.system,
    adventure,
    content: registry.content,
    contentIds: registry.contentIds,
  };
}

export function applyEvent(
  run: RunContext,
  state: GameState,
  event: GameEvent,
): GameState {
  const { story } = state;
  if (isNarrativeEvent(event) || isNamespacedEvent(event)) {
    return {
      ...state,
      system: run.system.applyEvent(state.system, event),
      story:
        event.kind === "encounterEnded"
          ? { ...story, encounterOutcome: event.outcome ?? "victory" }
          : story,
    };
  }
  switch (event.kind) {
    case "runStarted":
      return event.state;
    case "diceRolled":
      return { ...state, rng: { ...state.rng, play: event.state } };
    case "framePushed":
      return { ...state, stack: [...state.stack, event.frame] };
    case "framePopped":
      return { ...state, stack: state.stack.slice(0, -1) };
    case "sceneEntered":
      return {
        ...state,
        story: {
          ...story,
          scene: event.scene,
          visits: {
            ...story.visits,
            [event.scene]: (story.visits?.[event.scene] ?? 0) + 1,
          },
        },
      };
    case "flagSet":
      return {
        ...state,
        story: {
          ...story,
          flags: { ...story.flags, [event.flag]: event.value },
        },
      };
    case "clockAdvanced":
      return {
        ...state,
        story: {
          ...story,
          clocks: { ...story.clocks, [event.clock]: event.value },
        },
      };
    case "attitudeAdjusted":
      return {
        ...state,
        story: {
          ...story,
          attitudes: { ...story.attitudes, [event.npc]: event.value },
        },
      };
    case "resourceAdjusted":
      return {
        ...state,
        story: {
          ...story,
          resources: { ...story.resources, [event.resource]: event.value },
        },
      };
    case "secretRevealed":
      return {
        ...state,
        story: { ...story, revealed: [...story.revealed, event.secret] },
      };
    case "beatFired":
      return {
        ...state,
        story: { ...story, firedBeats: [...story.firedBeats, event.beat] },
      };
    case "restTaken":
      return { ...state, story: { ...story, restedIn: sceneVisit(story) } };
    case "adventureEnded":
      return { ...state, story: { ...story, ended: event.reason } };
    default:
      return event satisfies never;
  }
}

const AwaitPayloadSchema = z.object({ decision: DecisionSchema });

function isStoryFrame(frame: Frame): boolean {
  return frame.kind.startsWith(STORY_FRAME_PREFIX);
}

// What the game is waiting on, computed from state alone, so a loaded save resumes in the same place.
function waitingDecision(run: RunContext, state: GameState): Decision | null {
  const top = state.stack.at(-1);
  if (top?.kind === AWAIT_FRAME) {
    return AwaitPayloadSchema.parse(top.payload).decision;
  }
  if (top && !isStoryFrame(top)) return null;
  return run.system.nextDecision(state.system, run);
}

export function pendingDecision(
  run: RunContext,
  state: GameState,
): Decision | null {
  if (state.story.ended !== null) return null;
  const waiting = waitingDecision(run, state);
  if (waiting) return waiting;
  if (state.stack.length > 0) return null;
  const story = storyDecision(run, state);
  return story.kind === "decision" ? story.decision : null;
}

function answerEvents(
  state: GameState,
  decision: Decision,
  optionId: string,
): readonly GameEvent[] {
  const popped: readonly GameEvent[] =
    state.stack.at(-1)?.kind === AWAIT_FRAME ? [{ kind: "framePopped" }] : [];
  return [
    ...popped,
    {
      kind: "framePushed",
      frame: {
        kind: decision.resume.kind,
        payload: { ...decision.resume.payload, answer: optionId },
      },
    },
  ];
}

export interface StepResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly pending: Decision | null;
}

function settle(
  run: RunContext,
  start: GameState,
  startEvents: readonly GameEvent[],
): StepResult {
  let state = start;
  const events = [...startEvents];

  const emit = (items: readonly GameEvent[]): void => {
    for (const item of items) {
      state = applyEvent(run, state, item);
      events.push(item);
    }
  };

  // Records dice and pending work as events, so a replay reproduces them without rolling again.
  const handle = (
    popFrame: boolean,
    work: (dice: RecordingDice, context: GameState) => StoryResult,
  ): void => {
    const dice = createDice(state.rng.play);
    const result = work(dice, state);
    const produced = result.events ?? [];
    const frames = result.frames ?? [];
    const rolls = dice.rolls();
    const opensDirector = produced.some(
      (item) => item.kind === "gmOpportunity",
    );
    const recorded: GameEvent[] = [];
    if (popFrame) recorded.push({ kind: "framePopped" });
    if (rolls.length > 0) {
      recorded.push({
        kind: "diceRolled",
        rolls: [...rolls],
        state: dice.state(),
      });
    }
    recorded.push(...produced);
    if (opensDirector) {
      recorded.push({ kind: "framePushed", frame: DIRECTOR_FRAME });
    }
    for (const frame of [...frames].reverse()) {
      recorded.push({ kind: "framePushed", frame });
    }
    if (produced.some((item) => item.kind === "partyDefeated")) {
      recorded.push({ kind: "adventureEnded", reason: "defeat" });
    }
    emit(recorded);
  };

  const systemContext = (dice: RecordingDice, current: GameState) => ({
    state: current.system,
    dice,
    content: run.content,
    contentIds: run.contentIds,
  });

  for (let work = 0; work < MAX_WORK_PER_STEP; work += 1) {
    if (state.story.ended !== null) {
      return { state, events, pending: null };
    }

    const top = state.stack.at(-1);
    if (top && top.kind !== AWAIT_FRAME && !isStoryFrame(top)) {
      const definition = run.system.frames[top.kind];
      if (!definition) throw new Error(`Unknown frame ${top.kind}`);
      handle(true, (dice, current) => {
        const result = definition.run(
          top.payload,
          systemContext(dice, current),
        );
        assertOwnEvents(run, result.events);
        return result;
      });
      continue;
    }

    const waiting = waitingDecision(run, state);
    if (waiting) {
      if (waiting.actor === PLAYER_ACTOR) {
        return { state, events, pending: waiting };
      }
      handle(false, (dice, current) => {
        const answer = run.system.decidePolicy(
          waiting,
          systemContext(dice, current),
        );
        if (!waiting.options.some((option) => option.id === answer)) {
          throw new Error(
            `Policy chose unknown option "${answer}" for ${waiting.id}`,
          );
        }
        return { events: answerEvents(current, waiting, answer) };
      });
      continue;
    }

    if (top) {
      handle(true, (dice, current) => runStoryFrame(run, current, dice, top));
      continue;
    }

    const story = storyDecision(run, state);
    if (story.kind === "ended") {
      emit([{ kind: "adventureEnded", reason: story.reason }]);
      continue;
    }
    return { state, events, pending: story.decision };
  }
  throw new Error(
    `The game did not settle within ${String(MAX_WORK_PER_STEP)} steps. A handler is probably looping.`,
  );
}

// Each declared setting takes the chosen option when it is one, and its default otherwise.
export function resolveSettings(
  run: RunContext,
  chosen: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    (run.system.settings ?? []).map((setting) => {
      const value = chosen[setting.id];
      return [
        setting.id,
        value !== undefined &&
        setting.options.some((option) => option.id === value)
          ? value
          : setting.default,
      ];
    }),
  );
}

export function startRun(
  run: RunContext,
  seed: string,
  settings: Readonly<Record<string, string>> = {},
): StepResult {
  const world = createDice(rngFromSeed(`${seed}:world`));
  const profiles = rollCompanions(world);
  if (profiles.length !== COMPANION_COUNT) {
    throw new Error("Not enough companions to fill the party");
  }
  const partyIds = [PLAYER_ACTOR, ...profiles.map((profile) => profile.id)];
  const system = run.system.createRun({
    settings: resolveSettings(run, settings),
    actors: [
      { id: PLAYER_ACTOR, name: "You", role: "player" as const },
      ...profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        role: "companion" as const,
      })),
    ],
    dice: world,
    content: run.content,
    contentIds: run.contentIds,
  });

  const variants: Record<string, string> = {};
  const variantFrames: Frame[] = [];
  for (const variant of run.adventure.variants) {
    const total = variant.options.reduce((sum, item) => sum + item.weight, 0);
    let remaining = world.below(total);
    for (const option of variant.options) {
      remaining -= option.weight;
      if (remaining < 0) {
        variants[variant.id] = option.id;
        variantFrames.push(effectsFrame(option.effects));
        break;
      }
    }
  }

  const state: GameState = {
    rng: { world: world.state(), play: rngFromSeed(`${seed}:play`) },
    partyIds,
    companions: Object.fromEntries(
      profiles.map((profile) => [profile.id, profile]),
    ),
    // The stack runs from the end: variants apply first, then the first scene is entered.
    stack: [enterSceneFrame(run.adventure.startScene), ...variantFrames],
    story: { ...initialStory(run.adventure), variants },
    system,
  };
  return settle(run, state, [{ kind: "runStarted", state }]);
}

export type StepOutcome =
  | ({ readonly ok: true } & StepResult)
  | { readonly ok: false; readonly error: string };

// Bad input returns an error and leaves the state as it was.
export function step(
  run: RunContext,
  state: GameState,
  input: Extract<Input, { kind: "answer" }>,
): StepOutcome {
  const decision = pendingDecision(run, state);
  if (!decision) return { ok: false, error: "No decision is waiting" };
  if (decision.id !== input.decisionId) {
    return {
      ok: false,
      error: `Expected an answer to ${decision.id}, not ${input.decisionId}`,
    };
  }
  if (!decision.options.some((option) => option.id === input.optionId)) {
    return { ok: false, error: `Unknown option "${input.optionId}"` };
  }

  const answers = answerEvents(state, decision, input.optionId);
  const next = answers.reduce<GameState>(
    (current, event) => applyEvent(run, current, event),
    state,
  );
  return { ok: true, ...settle(run, next, answers) };
}
