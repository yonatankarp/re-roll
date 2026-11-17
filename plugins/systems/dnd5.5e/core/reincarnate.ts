import {
  awaitDecision,
  type ContentAccess,
  type Dice,
  frameHandler,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { z } from "zod";
import { choiceOptions, speciesAnswers } from "./character.ts";
import { type ChoiceDef, ClassSchema, SpeciesSchema } from "./schemas.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  effectiveBuild,
  frame,
  NS,
} from "./state.ts";
import { deriveStats, lookup } from "./stats.ts";

// Reincarnate: the dead come back in a new body of a rolled species, which loses the old species' picks and makes
// the new one's. A companion takes each choice's first option; the player is asked between fights (camp.ts).
// shortcut: an old pick is known by being one of the old species' options, so a class pick that happens to be one
// of them goes too, and a feat the new species gives asks none of its own choices.

type Context = ContentAccess & {
  readonly state: DndState;
  readonly dice: Dice;
};

// The new species' choices with what each could be, worked out against the build as it is.
function speciesChoices(
  actor: Actor,
  speciesId: string,
  access: ContentAccess,
): readonly {
  readonly choice: ChoiceDef;
  readonly options: readonly { id: string; label: string }[];
}[] {
  const build = effectiveBuild(actor);
  const [first] = build?.levels ?? [];
  if (!build || !first) return [];
  const classDef = lookup(access, ClassSchema, first.classId);
  return lookup(access, SpeciesSchema, speciesId).choices.map((choice) => ({
    choice,
    options: choiceOptions(
      choice,
      { picks: {}, scores: [] },
      build,
      classDef,
      access,
    ).options,
  }));
}

// The event that gives `actor` its new species with these picks, by choice id, leaving out the old species' picks.
export function reincarnatedEvent(
  actor: Actor,
  speciesId: string,
  picks: Record<string, string[]>,
  access: ContentAccess,
): SystemEvent {
  const old = effectiveBuild(actor)?.speciesId;
  const drop = old
    ? speciesChoices(actor, old, access).flatMap(({ options }) =>
        options.map(({ id }) => id),
      )
    : [];
  return dndEvent(`${NS}:reincarnated`, {
    actor: actor.id,
    species: speciesId,
    drop,
    answers: speciesAnswers(speciesId, picks, access),
  });
}

// The rolled species and a body whole again, with each choice's first option until the player says otherwise.
export function reincarnateEvents(
  target: Actor,
  species: readonly string[],
  context: Context,
): SystemEvent[] {
  const speciesId = species[context.dice.roll(species.length) - 1];
  if (!speciesId) return [];
  const picks = Object.fromEntries(
    speciesChoices(target, speciesId, context).flatMap(({ choice, options }) =>
      options[0] ? [[choice.id, [options[0].id]]] : [],
    ),
  );
  const max = deriveStats(target, context).maxHp;
  return [
    dndEvent(`${NS}:healed`, { actor: target.id, amount: max, max }),
    reincarnatedEvent(target, speciesId, picks, context),
  ];
}

const AskSchema = z.strictObject({
  picks: z.record(z.string(), z.array(z.string())),
});

// The player picks what the new species asks for, one choice at a time.
function runAsk(
  { picks }: z.infer<typeof AskSchema>,
  context: Context,
): SystemResult {
  const player = context.state.actors[PLAYER_ACTOR];
  const speciesId = player?.reincarnated?.species;
  if (!player || !speciesId) return {};
  const next = speciesChoices(player, speciesId, context).find(
    ({ choice, options }) => !(choice.id in picks) && options.length > 1,
  );
  if (!next) {
    return {
      events: [
        reincarnatedEvent(
          player,
          speciesId,
          {
            ...Object.fromEntries(
              speciesChoices(player, speciesId, context).flatMap(
                ({ choice, options }) =>
                  options[0] ? [[choice.id, [options[0].id]]] : [],
              ),
            ),
            ...picks,
          },
          context,
        ),
      ],
    };
  }
  return {
    frames: [
      awaitDecision({
        id: `${NS}:reincarnate:${next.choice.id}`,
        actor: player.id,
        prompt: `Your new body is a ${lookup(context, SpeciesSchema, speciesId).name}. Choose:`,
        options: [...next.options],
        resume: frame("reincarnateAnswer", { picks, choice: next.choice.id }),
      }),
    ],
  };
}

const AnswerSchema = AskSchema.extend({
  choice: z.string(),
  answer: z.string(),
});

function runAnswer(
  { picks, choice, answer }: z.infer<typeof AnswerSchema>,
  _context: Context,
): SystemResult {
  return {
    frames: [frame("reincarnate", { picks: { ...picks, [choice]: [answer] } })],
  };
}

export const reincarnateFrames = {
  [`${NS}:reincarnate`]: frameHandler({ schema: AskSchema, run: runAsk }),
  [`${NS}:reincarnateAnswer`]: frameHandler({
    schema: AnswerSchema,
    run: runAnswer,
  }),
};
