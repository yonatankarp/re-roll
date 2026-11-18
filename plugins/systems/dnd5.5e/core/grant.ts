import {
  awaitDecision,
  ContentIdSchema,
  frameHandler,
  PLAYER_ACTOR,
  storyEffect,
  type ContentAccess,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { z } from "zod";
import { answersOf, choiceOptions } from "./character.ts";
import {
  type ChoiceDef,
  ChoiceAnswerSchema,
  CharacterOptionSchema,
  ClassSchema,
} from "./schemas.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  effectiveBuild,
  frame,
  isDead,
  NS,
} from "./state.ts";
import { lookup, maybeLookup } from "./stats.ts";

// Character options a story grants (#192): a supernatural gift, an epic destiny, a survivor talent, a Circle casting
// option or a list of beast shapes. A scene names one (`option`), or lets the player pick (`from`), and the option's
// own picks are asked as it's granted, so the event carries them (an `optionGranted`). With `party` every character of
// the party gains it, the companions picking what the rules prefer.

type Context = ContentAccess & { readonly state: DndState };

const GrantSchema = z.strictObject({
  option: ContentIdSchema.optional(),
  from: z.array(ContentIdSchema).min(1).optional(),
  party: z.literal(true).optional(),
});

const StepSchema = z.object({
  actor: z.string(),
  option: ContentIdSchema.optional(),
  from: z.array(ContentIdSchema).optional(),
  party: z.literal(true).optional(),
  picks: z.record(z.string(), z.array(z.string())).default({}),
});
// `slot` is the choice the decision asked, none for the option itself; the decision's answer comes as `answer`.
const AnswerSchema = StepSchema.extend({
  slot: z.string().optional(),
  answer: z.string(),
});
type Step = z.infer<typeof StepSchema>;

// The picks an option asks: its own choices, and one of its variants when it has them, as Resilience's ability.
function choicesOf(option: z.infer<typeof CharacterOptionSchema>): ChoiceDef[] {
  return [
    ...(option.variants
      ? [
          {
            kind: "variant" as const,
            id: `variant:${option.id}`,
            feature: option.id,
            count: 1,
          },
        ]
      : []),
    ...option.choices,
  ];
}

// Every pick so far, each answer naming the option that asked, so a class's own picks never take it (swap.ts).
function answersFor(
  optionId: string,
  choices: readonly ChoiceDef[],
  picks: Step["picks"],
): z.infer<typeof ChoiceAnswerSchema>[] {
  const answers = answersOf(choices, picks).map((answer) =>
    typeof answer === "object" &&
    answer !== null &&
    "kind" in answer &&
    ["skills", "spells", "features", "weaponMastery", "tools"].includes(
      String(answer.kind),
    )
      ? { ...answer, feat: optionId }
      : answer,
  );
  return z.array(ChoiceAnswerSchema).parse(answers);
}

function partyOf(state: DndState): Actor[] {
  return Object.values(state.actors).filter(
    (actor) =>
      actor.side === "party" &&
      actor.source.kind === "character" &&
      !isDead(actor),
  );
}

function runGrantStep(step: Step, context: Context): SystemResult {
  const actor = context.state.actors[step.actor];
  const build = actor ? effectiveBuild(actor) : null;
  if (!actor || !build) return {};
  const player = step.actor === PLAYER_ACTOR;
  // Which option, when the scene lets the player pick one: those not already granted, or any when all are.
  if (step.option === undefined) {
    const offered = (step.from ?? []).filter(
      (id) => !(actor.granted ?? []).includes(id),
    );
    const open = offered.length > 0 ? offered : (step.from ?? []);
    return {
      frames: [
        awaitDecision({
          id: `${NS}:grant:${actor.id}:option`,
          actor: actor.id,
          prompt: "Which do you gain?",
          options: open.map((id) => ({
            id,
            label: maybeLookup(context, CharacterOptionSchema, id)?.name ?? id,
          })),
          resume: frame("grantAnswer", step),
        }),
      ],
    };
  }
  const option = lookup(context, CharacterOptionSchema, step.option);
  const choices = choicesOf(option);
  const [first] = build.levels;
  const classDef = lookup(context, ClassSchema, first?.classId ?? "");
  for (const choice of choices) {
    const picked = step.picks[choice.id] ?? [];
    const count = "count" in choice ? choice.count : 1;
    if (picked.length >= count) continue;
    const { what, options, prefer } = choiceOptions(
      choice,
      { picks: step.picks, scores: [] },
      build,
      classDef,
      context,
    );
    if (options.length === 0) continue;
    if (!player) {
      const answer =
        prefer?.find((id) => options.some((item) => item.id === id)) ??
        options[0]?.id ??
        "";
      return runGrantStep(
        { ...step, picks: { ...step.picks, [choice.id]: [...picked, answer] } },
        context,
      );
    }
    return {
      frames: [
        awaitDecision({
          id: `${NS}:grant:${actor.id}:${option.id}:${choice.id}-${String(picked.length)}`,
          actor: actor.id,
          prompt: `${option.name}: choose ${what}.`,
          options: [...options],
          resume: frame("grantAnswer", { ...step, slot: choice.id }),
        }),
      ],
    };
  }
  const events: SystemEvent[] = [
    dndEvent(`${NS}:optionGranted`, {
      actor: actor.id,
      option: option.id,
      answers: answersFor(option.id, choices, step.picks),
    }),
  ];
  // The rest of the party gains it too, one after another.
  const others = step.party
    ? partyOf(context.state).filter((other) => other.id !== PLAYER_ACTOR)
    : [];
  return {
    events,
    frames: player
      ? others.map((other) =>
          frame("grantStep", {
            actor: other.id,
            option: option.id,
            picks: {},
          }),
        )
      : [],
  };
}

// The decision's answer: the option picked, or a pick for the choice in `slot`.
function runGrantAnswer(payload: z.infer<typeof AnswerSchema>): SystemResult {
  const { slot, answer: picked, ...step } = payload;
  if (step.option === undefined || slot === undefined) {
    return {
      frames: [frame("grantStep", { ...step, option: picked, picks: {} })],
    };
  }
  return {
    frames: [
      frame("grantStep", {
        ...step,
        picks: { ...step.picks, [slot]: [...(step.picks[slot] ?? []), picked] },
      }),
    ],
  };
}

export const grantEffects = {
  [`${NS}:grantOption`]: storyEffect({
    schema: GrantSchema,
    apply: (args, _context: Context) => ({
      frames: [
        frame("grantStep", {
          actor: PLAYER_ACTOR,
          ...(args.option ? { option: args.option } : {}),
          ...(args.from ? { from: args.from } : {}),
          ...(args.party ? { party: true } : {}),
          picks: {},
        }),
      ],
    }),
  }),
};

export const grantFrames = {
  [`${NS}:grantStep`]: frameHandler({ schema: StepSchema, run: runGrantStep }),
  [`${NS}:grantAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runGrantAnswer,
  }),
};
