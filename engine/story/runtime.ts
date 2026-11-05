import { z } from "zod";
import type { Dice } from "../kernel/dice.ts";
import type {
  Decision,
  Frame,
  GameEvent,
  GameState,
  StoryState,
  SystemEvent,
} from "../kernel/events.ts";
import { PLAYER_ACTOR, isNarrativeEvent } from "../kernel/events.ts";
import type { ContentEntry, GameSystem } from "../kernel/system.ts";
import {
  type Adventure,
  type Condition,
  StoryEffectSchema,
  type StoryEffect,
} from "./adventure.ts";

export interface RunContext {
  readonly system: GameSystem;
  readonly adventure: Adventure;
  readonly content: (id: string) => ContentEntry | undefined;
}

export interface StoryResult {
  readonly events?: readonly GameEvent[];
  readonly frames?: readonly Frame[]; // the first one listed runs first
}

export const STORY_FRAME_PREFIX = "story:";

const ResolveChoiceSchema = z.object({
  scene: z.string(),
  answer: z.string(),
});
const ApplyEffectsSchema = z.object({ effects: z.array(StoryEffectSchema) });
const EnterSceneSchema = z.object({ scene: z.string() });

// Each system may only emit the shared narrative events and events under its own name.
export function assertOwnEvents(
  run: RunContext,
  events: readonly SystemEvent[] | undefined,
): void {
  for (const event of events ?? []) {
    if (
      !isNarrativeEvent(event) &&
      !event.kind.startsWith(`${run.system.id}:`)
    ) {
      throw new Error(
        `System ${run.system.id} emitted an event it doesn't own: ${event.kind}`,
      );
    }
  }
}

export function initialStory(adventure: Adventure): StoryState {
  return {
    scene: null,
    flags: {},
    clocks: Object.fromEntries(
      adventure.factions.flatMap((faction) =>
        faction.clocks.map((clock) => [clock.id, 0]),
      ),
    ),
    attitudes: Object.fromEntries(
      adventure.npcs.map((npc) => [npc.id, npc.attitude]),
    ),
    revealed: [],
    firedBeats: [],
    variants: {},
    ended: null,
  };
}

// A goto takes effect only after everything else the choice does, and the last one wins.
export function effectsFrame(effects: readonly StoryEffect[]): Frame {
  const gotos = effects.filter((effect) => effect.kind === "goto");
  const others = effects.filter((effect) => effect.kind !== "goto");
  return {
    kind: "story:applyEffects",
    payload: { effects: [...others, ...gotos.slice(-1)] },
  };
}

export function enterSceneFrame(scene: string): Frame {
  return { kind: "story:enterScene", payload: { scene } };
}

export const DIRECTOR_FRAME: Frame = { kind: "story:director", payload: {} };

function evaluateLeaf(
  leaf: Exclude<Condition, { all: unknown } | { any: unknown }>,
  run: RunContext,
  state: GameState,
): boolean {
  const { story } = state;
  switch (leaf.kind) {
    case "flag":
      return (story.flags[leaf.flag] ?? false) === leaf.is;
    case "clock":
      return (story.clocks[leaf.clock] ?? 0) >= leaf.atLeast;
    case "attitude":
      return (story.attitudes[leaf.npc] ?? 0) >= leaf.atLeast;
    case "system": {
      const predicate = run.system.storyPredicates[leaf.predicate];
      if (!predicate) throw new Error(`Unknown predicate ${leaf.predicate}`);
      return predicate.evaluate(leaf.args, state.system);
    }
    default:
      return leaf satisfies never;
  }
}

export function evaluateCondition(
  condition: Condition | undefined,
  run: RunContext,
  state: GameState,
): boolean {
  if (!condition) return true;
  if ("all" in condition) {
    return condition.all.every((leaf) => evaluateLeaf(leaf, run, state));
  }
  if ("any" in condition) {
    return condition.any.some((leaf) => evaluateLeaf(leaf, run, state));
  }
  return evaluateLeaf(condition, run, state);
}

function findScene(run: RunContext, id: string) {
  const scene = run.adventure.scenes.find((item) => item.id === id);
  if (!scene) throw new Error(`Unknown scene ${id}`);
  return scene;
}

export type StoryDecision =
  | { readonly kind: "decision"; readonly decision: Decision }
  | { readonly kind: "ended"; readonly reason: "ending" | "deadEnd" };

export function storyDecision(
  run: RunContext,
  state: GameState,
): StoryDecision {
  const sceneId = state.story.scene;
  if (sceneId === null) throw new Error("The run has no current scene");
  const scene = findScene(run, sceneId);
  if (scene.choices.length === 0) return { kind: "ended", reason: "ending" };

  const options = scene.choices.flatMap((choice, index) =>
    evaluateCondition(choice.when, run, state)
      ? [{ id: String(index), label: choice.label }]
      : [],
  );
  if (options.length === 0) return { kind: "ended", reason: "deadEnd" };

  return {
    kind: "decision",
    decision: {
      id: `scene:${scene.id}`,
      actor: PLAYER_ACTOR,
      prompt: scene.text,
      options,
      resume: { kind: "story:resolveChoice", payload: { scene: scene.id } },
    },
  };
}

function resolveResults(
  run: RunContext,
  results: Readonly<Record<string, readonly StoryEffect[]>>,
  outcome: string,
): readonly StoryEffect[] {
  const direct = results[outcome];
  if (direct) return direct;
  const { groups = {} } = run.system.outcomes;
  for (const [group, members] of Object.entries(groups)) {
    const effects = results[group];
    if (effects && members.includes(outcome)) return effects;
  }
  throw new Error(`No result covers the outcome "${outcome}"`);
}

function runResolveChoice(
  run: RunContext,
  state: GameState,
  dice: Dice,
  payload: z.infer<typeof ResolveChoiceSchema>,
): StoryResult {
  const scene = findScene(run, payload.scene);
  const choice = scene.choices[Number(payload.answer)];
  if (!choice) throw new Error(`Unknown choice ${payload.answer}`);
  if ("effects" in choice) return { frames: [effectsFrame(choice.effects)] };

  const result = run.system.resolveCheck(choice.check, {
    state: state.system,
    dice,
    content: run.content,
  });
  assertOwnEvents(run, result.events);
  return {
    events: [
      ...(result.events ?? []),
      { kind: "checkResolved", outcome: result.outcome },
    ],
    frames: [
      ...(result.frames ?? []),
      effectsFrame(resolveResults(run, choice.results, result.outcome)),
    ],
  };
}

function runApplyEffects(
  run: RunContext,
  state: GameState,
  dice: Dice,
  effects: readonly StoryEffect[],
): StoryResult {
  const [effect, ...rest] = effects;
  if (!effect) return {};
  const remaining: readonly Frame[] =
    rest.length > 0
      ? [{ kind: "story:applyEffects", payload: { effects: rest } }]
      : [];
  const context = { state: state.system, dice, content: run.content };

  switch (effect.kind) {
    case "setFlag":
      return {
        events: [{ kind: "flagSet", flag: effect.flag, value: effect.value }],
        frames: remaining,
      };
    case "goto":
      return { frames: [enterSceneFrame(effect.scene), ...remaining] };
    case "advanceClock": {
      const clock = run.adventure.factions
        .flatMap((faction) => faction.clocks)
        .find((item) => item.id === effect.clock);
      if (!clock) throw new Error(`Unknown clock ${effect.clock}`);
      const before = state.story.clocks[clock.id] ?? 0;
      const after = Math.min(before + effect.by, clock.max);
      const crossed = clock.at
        .filter(({ value }) => before < value && value <= after)
        .flatMap(({ effects: triggered }) => triggered);
      // Merged into one list, so a threshold's goto replaces the choice's own,
      // and the party never passes through a scene the rules have already overruled.
      const following = [...rest, ...crossed];
      return {
        events: [{ kind: "clockAdvanced", clock: clock.id, value: after }],
        frames: following.length > 0 ? [effectsFrame(following)] : [],
      };
    }
    case "adjustAttitude":
      return {
        events: [
          {
            kind: "attitudeAdjusted",
            npc: effect.npc,
            value: (state.story.attitudes[effect.npc] ?? 0) + effect.by,
          },
        ],
        frames: remaining,
      };
    case "startEncounter": {
      const encounter = run.adventure.encounters.find(
        (item) => item.id === effect.encounter,
      );
      if (!encounter) throw new Error(`Unknown encounter ${effect.encounter}`);
      const result = run.system.startEncounter(encounter, context);
      assertOwnEvents(run, result.events);
      return {
        events: result.events ?? [],
        frames: [...(result.frames ?? []), ...remaining],
      };
    }
    case "reveal":
      return {
        events: [{ kind: "secretRevealed", secret: effect.secret }],
        frames: remaining,
      };
    case "system": {
      const definition = run.system.storyEffects[effect.effect];
      if (!definition) throw new Error(`Unknown effect ${effect.effect}`);
      const result = definition.apply(effect.args, context);
      assertOwnEvents(run, result.events);
      return {
        events: result.events ?? [],
        frames: [...(result.frames ?? []), ...remaining],
      };
    }
    default:
      return effect satisfies never;
  }
}

function runDirector(
  run: RunContext,
  state: GameState,
  dice: Dice,
): StoryResult {
  const sceneId = state.story.scene;
  if (sceneId === null || findScene(run, sceneId).choices.length === 0) {
    return {};
  }
  // Each beat fires once per run, so two scenes can't send the party back and forth forever.
  const eligible = run.adventure.beats.filter(
    (beat) =>
      !state.story.firedBeats.includes(beat.id) &&
      evaluateCondition(beat.when, run, state),
  );
  const total = eligible.reduce((sum, beat) => sum + beat.weight, 0);
  if (total === 0) return {};

  let remaining = dice.below(total);
  for (const beat of eligible) {
    remaining -= beat.weight;
    if (remaining < 0) {
      return {
        events: [{ kind: "beatFired", beat: beat.id }],
        frames: [enterSceneFrame(beat.scene)],
      };
    }
  }
  return {};
}

export function runStoryFrame(
  run: RunContext,
  state: GameState,
  dice: Dice,
  frame: Frame,
): StoryResult {
  switch (frame.kind) {
    case "story:resolveChoice":
      return runResolveChoice(
        run,
        state,
        dice,
        ResolveChoiceSchema.parse(frame.payload),
      );
    case "story:applyEffects":
      return runApplyEffects(
        run,
        state,
        dice,
        ApplyEffectsSchema.parse(frame.payload).effects,
      );
    case "story:enterScene":
      return {
        events: [
          {
            kind: "sceneEntered",
            scene: EnterSceneSchema.parse(frame.payload).scene,
          },
        ],
        frames: [DIRECTOR_FRAME],
      };
    case "story:director":
      return runDirector(run, state, dice);
    default:
      throw new Error(`Unknown story frame ${frame.kind}`);
  }
}
