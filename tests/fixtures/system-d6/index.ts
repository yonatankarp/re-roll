import {
  ContentEntrySchema,
  ContentIdSchema,
  PLAYER_ACTOR,
  type SystemContext,
  awaitDecision,
  contentKind,
  defineSystem,
  encounterKind,
  frameHandler,
  storyEffect,
  storyPredicate,
} from "#sdk";
import { z } from "zod";

// A deliberately un-D&D-like system: one d6, three outcomes, and no turns, HP or grid.
// If the engine starts assuming any of those, this fixture stops working.

const TrickSchema = ContentEntrySchema.extend({ name: z.string() }).strict();

const FoeSchema = ContentEntrySchema.extend({
  name: z.string(),
  menace: z.number().int().min(1).max(6),
  trick: ContentIdSchema.optional(),
}).strict();

const EncounterSchema = z.object({
  id: z.string(),
  foes: z.array(ContentIdSchema).min(1),
});

const CheckSchema = z.strictObject({ risk: z.enum(["low", "high"]) });

const StateSchema = z.strictObject({
  luck: z.record(z.string(), z.number().int()),
});
type D6State = z.infer<typeof StateSchema>;
type Context = SystemContext<D6State>;

const LuckChangedSchema = z.strictObject({
  actor: z.string(),
  by: z.number().int(),
});

const RoundSchema = z.object({
  encounter: z.string(),
  remaining: z.array(z.string()),
});

const CostSchema = RoundSchema.extend({
  answer: z.enum(["spendLuck", "takeTime"]),
});

function roundFrame(encounter: string, remaining: readonly string[]) {
  return { kind: "d6:round", payload: { encounter, remaining } };
}

function luckChanged(by: number) {
  return {
    kind: "d6:luckChanged",
    payload: { actor: PLAYER_ACTOR, by },
  } as const;
}

export const d6System = defineSystem<D6State>({
  id: "d6",
  version: "1.0.0",
  sdk: "^1",
  contentKinds: {
    tricks: contentKind({ idPrefix: "trick", schema: TrickSchema }),
    foes: contentKind({
      idPrefix: "foe",
      schema: FoeSchema,
      references: (foe) => (foe.trick ? [foe.trick] : []),
    }),
  },
  checkSchema: CheckSchema,
  encounters: encounterKind({
    schema: EncounterSchema,
    references: (encounter) => encounter.foes,
  }),
  outcomes: {
    keys: ["hit", "mixed", "miss"],
    groups: { notMiss: ["hit", "mixed"] },
  },
  stateSchema: StateSchema,
  eventSchemas: { "d6:luckChanged": LuckChangedSchema },
  storyEffects: {
    "d6:gainLuck": storyEffect({
      schema: z.strictObject({ amount: z.number().int().min(1) }),
      apply: ({ amount }, _context: Context) => ({
        events: [luckChanged(amount)],
      }),
    }),
  },
  storyPredicates: {
    "d6:hasLuck": storyPredicate({
      schema: z.strictObject({ atLeast: z.number().int().min(1) }),
      evaluate: ({ atLeast }, state: D6State) =>
        (state.luck[PLAYER_ACTOR] ?? 0) >= atLeast,
    }),
  },
  frames: {
    "d6:round": frameHandler({
      schema: RoundSchema,
      run: ({ encounter, remaining }, { dice }: Context) => {
        const [foe, ...rest] = remaining;
        if (foe === undefined) {
          return { events: [{ kind: "encounterEnded", encounter }] };
        }
        const roll = dice.roll(6);
        if (roll >= 5) {
          return {
            events: [{ kind: "actorDefeated", actor: foe }],
            frames: [roundFrame(encounter, rest)],
          };
        }
        if (roll >= 3) {
          // The player picks a cost. Nothing here takes turns, and the game simply waits.
          return {
            frames: [
              awaitDecision({
                id: `d6:cost:${encounter}:${foe}`,
                actor: PLAYER_ACTOR,
                prompt: "You win through, but at what cost?",
                options: [
                  { id: "spendLuck", label: "Spend your luck" },
                  { id: "takeTime", label: "Take your time" },
                ],
                resume: {
                  kind: "d6:payCost",
                  payload: { encounter, remaining },
                },
              }),
            ],
          };
        }
        return {
          events: [{ kind: "gmOpportunity" }],
          frames: [roundFrame(encounter, remaining)],
        };
      },
    }),
    "d6:payCost": frameHandler({
      schema: CostSchema,
      run: ({ encounter, remaining, answer }, _context: Context) => {
        const [foe, ...rest] = remaining;
        if (answer === "takeTime" || foe === undefined) {
          return { frames: [roundFrame(encounter, remaining)] };
        }
        return {
          events: [luckChanged(-1), { kind: "actorDefeated", actor: foe }],
          frames: [roundFrame(encounter, rest)],
        };
      },
    }),
  },
  createRun: ({ actors, dice }) => ({
    luck: Object.fromEntries(actors.map(({ id }) => [id, dice.below(3)])),
  }),
  resolveCheck: (check, { dice }) => {
    const { risk } = CheckSchema.parse(check);
    const roll = dice.roll(6) - (risk === "high" ? 1 : 0);
    if (roll >= 5) return { outcome: "hit" };
    if (roll >= 3) return { outcome: "mixed" };
    return { outcome: "miss", events: [{ kind: "gmOpportunity" }] };
  },
  startEncounter: (encounter) => {
    const { id, foes } = EncounterSchema.parse(encounter);
    return {
      events: [{ kind: "encounterStarted", encounter: id }],
      frames: [roundFrame(id, foes)],
    };
  },
  applyEvent: (state, event) => {
    if (event.kind !== "d6:luckChanged") return state;
    const { actor, by } = LuckChangedSchema.parse(
      "payload" in event ? event.payload : {},
    );
    return {
      luck: { ...state.luck, [actor]: (state.luck[actor] ?? 0) + by },
    };
  },
  nextDecision: () => null,
  decidePolicy: (decision) => decision.options[0]?.id ?? "",
});
