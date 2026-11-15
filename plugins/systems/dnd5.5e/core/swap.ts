import {
  awaitDecision,
  type ContentAccess,
  frameHandler,
  PLAYER_ACTOR,
  type SceneAction,
  storyEffect,
  type SystemResult,
} from "#sdk";
import { z } from "zod";
import { choiceOptions } from "./character.ts";
import {
  type ChoiceDef,
  ClassSchema,
  FeatSchema,
  SpeciesSchema,
} from "./schemas.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  effectiveBuild,
  frame,
  NS,
} from "./state.ts";
import { lookup } from "./stats.ts";

// Picks a feat or species lets the character change after a Long Rest, as Weapon Master's weapons, offered beside a
// scene's choices so a save from before them never meets a new decision.
// shortcut: only the player swaps, any time until the next Long Rest, and only picks made since builds record whose
// they are.

type Context = ContentAccess & { readonly state: DndState };

const KINDS = {
  skills: "skills",
  weaponMastery: "weaponMastery",
  features: "option",
} as const;
const KEEP = "keep";

interface Swappable {
  readonly key: string; // "<level>:<answer>" in the build
  readonly owner: string;
  readonly choice: ChoiceDef;
  readonly values: readonly string[];
}

export function swappable(
  actor: Actor,
  access: ContentAccess,
): readonly Swappable[] {
  const build = effectiveBuild(actor);
  if (!build) return [];
  return build.levels.flatMap((entry, level) =>
    entry.answers.flatMap((answer, index): Swappable[] => {
      if (!(answer.kind in KINDS) || !("feat" in answer) || !answer.feat) {
        return [];
      }
      const kind = KINDS[answer.kind as keyof typeof KINDS];
      const content = access.content(answer.feat);
      const owner =
        FeatSchema.safeParse(content).data ??
        SpeciesSchema.safeParse(content).data;
      const choice = owner?.choices.find(
        (item) =>
          item.kind === kind &&
          "swap" in item &&
          item.swap === "longRest" &&
          (item.kind !== "skills" ||
            Boolean(item.expertise) ===
              (answer.kind === "skills" && answer.expertise === true)),
      );
      return owner && choice && "values" in answer
        ? [
            {
              key: `${String(level)}:${String(index)}`,
              owner: owner.name,
              choice,
              values: answer.values,
            },
          ]
        : [];
    }),
  );
}

export function sceneSwapActions(
  state: DndState,
  access: ContentAccess,
): SceneAction[] {
  const actor = state.actors[PLAYER_ACTOR];
  if (!actor || state.combat || state.sinceLongRest === undefined) return [];
  return swappable(actor, access)
    .filter(({ key }) => !(actor.swapped ?? []).includes(key))
    .map(({ key, owner }) => ({
      id: `swap:${key}`,
      label: `Change a pick of ${owner}`,
      effect: `${NS}:swap`,
      args: { key },
    }));
}

function nameOf(id: string, access: ContentAccess): string {
  const entry = access.content(id) as { name?: unknown } | undefined;
  return typeof entry?.name === "string" ? entry.name : id;
}

const StepSchema = z.object({
  actor: z.string(),
  key: z.string(),
  drop: z.string().optional(),
});
const AnswerSchema = StepSchema.extend({ answer: z.string() });

function runSwapStep(
  payload: z.infer<typeof StepSchema>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[payload.actor];
  const found = actor
    ? swappable(actor, context).find(({ key }) => key === payload.key)
    : undefined;
  const build = actor ? effectiveBuild(actor) : null;
  if (!actor || !found || !build) return {};
  const id = `${NS}:swap:${actor.id}:${payload.key}:${payload.drop ?? ""}`;
  const keep = { id: KEEP, label: "Keep it as it is" };
  const resume = (drop?: string) =>
    frame("swapAnswer", {
      actor: actor.id,
      key: payload.key,
      ...(drop === undefined ? {} : { drop }),
    });
  // With several picks, which one changes is asked first.
  const [only] = found.values;
  const drop = payload.drop ?? (found.values.length === 1 ? only : undefined);
  if (drop === undefined) {
    return {
      frames: [
        awaitDecision({
          id,
          actor: actor.id,
          prompt: `Which pick of ${found.owner} do you change?`,
          options: [
            ...found.values.map((value) => ({
              id: value,
              label: nameOf(value, context),
            })),
            keep,
          ],
          resume: resume(),
        }),
      ],
    };
  }
  const [first] = build.levels;
  const classDef = lookup(context, ClassSchema, first?.classId ?? "");
  const { options } = choiceOptions(
    found.choice,
    { picks: {}, scores: [] },
    build,
    classDef,
    context,
  );
  return {
    frames: [
      awaitDecision({
        id,
        actor: actor.id,
        prompt: `${found.owner}: what takes the place of ${nameOf(drop, context)}?`,
        options: [...options, keep],
        resume: resume(drop),
      }),
    ],
  };
}

function runSwapAnswer(
  payload: z.infer<typeof AnswerSchema>,
  context: Context,
): SystemResult {
  const { actor, key, drop, answer } = payload;
  if (answer === KEEP) return {};
  const holder = context.state.actors[actor];
  const found = holder
    ? swappable(holder, context).find((item) => item.key === key)
    : undefined;
  if (!found) return {};
  if (drop === undefined) {
    return { frames: [frame("swapStep", { actor, key, drop: answer })] };
  }
  return {
    events: [
      dndEvent(`${NS}:answerSwapped`, {
        actor,
        key,
        values: found.values.map((value) => (value === drop ? answer : value)),
      }),
    ],
  };
}

export const swapEffects = {
  [`${NS}:swap`]: storyEffect({
    schema: z.object({ key: z.string() }),
    apply: ({ key }, _context: Context) => ({
      frames: [frame("swapStep", { actor: PLAYER_ACTOR, key })],
    }),
  }),
};

export const swapFrames = {
  [`${NS}:swapStep`]: frameHandler({ schema: StepSchema, run: runSwapStep }),
  [`${NS}:swapAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runSwapAnswer,
  }),
};
