import { z } from "zod";

export const PLAYER_ACTOR = "player";

const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = Readonly<Record<string, unknown>>;

export const FrameSchema = z.strictObject({
  kind: z.string().min(1),
  payload: JsonObjectSchema,
});
export type Frame = Readonly<z.infer<typeof FrameSchema>>;

export const DecisionSchema = z.strictObject({
  id: z.string().min(1),
  actor: z.string().min(1),
  prompt: z.string(),
  options: z
    .array(z.strictObject({ id: z.string().min(1), label: z.string().min(1) }))
    .min(1),
  // Answering pushes this frame, with the chosen option added to its payload as "answer".
  resume: FrameSchema,
});
export type Decision = Readonly<z.infer<typeof DecisionSchema>>;

const RngStateSchema = z.tuple([
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
]);

export const StoryStateSchema = z.strictObject({
  scene: z.string().nullable(),
  flags: z.record(z.string(), z.boolean()),
  clocks: z.record(z.string(), z.number().int()),
  attitudes: z.record(z.string(), z.number().int()),
  revealed: z.array(z.string()),
  firedBeats: z.array(z.string()),
  variants: z.record(z.string(), z.string()),
  ended: z.enum(["ending", "deadEnd"]).nullable(),
});
export type StoryState = Readonly<z.infer<typeof StoryStateSchema>>;

export const CompanionProfileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  pronouns: z.string().min(1),
  personality: z.string().min(1),
  goal: z.string().min(1),
  secret: z.string().min(1),
  loyalty: z.number().int(),
});
export type CompanionProfile = Readonly<z.infer<typeof CompanionProfileSchema>>;

export const GameStateSchema = z.strictObject({
  rng: z.strictObject({ world: RngStateSchema, play: RngStateSchema }),
  partyIds: z.array(z.string()),
  companions: z.record(z.string(), CompanionProfileSchema),
  stack: z.array(FrameSchema),
  story: StoryStateSchema,
  system: z.unknown(), // checked by the system's own stateSchema when a save loads
});
export type GameState = Readonly<z.infer<typeof GameStateSchema>>;

const event = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.strictObject({ kind: z.literal(kind), ...shape });

// Every system must emit these, so the director and prep can react without knowing the rules.
const NARRATIVE_EVENTS = [
  event("checkResolved", { outcome: z.string() }),
  event("actorDowned", { actor: z.string() }),
  event("actorDefeated", { actor: z.string() }),
  event("encounterStarted", { encounter: z.string() }),
  event("encounterEnded", { encounter: z.string() }),
  event("levelGained", { actor: z.string() }),
  event("itemGained", { actor: z.string(), item: z.string() }),
  event("itemLost", { actor: z.string(), item: z.string() }),
  event("gmOpportunity", {}),
] as const;

const ENGINE_EVENTS = [
  event("runStarted", { state: GameStateSchema }),
  event("diceRolled", {
    rolls: z.array(
      z.strictObject({ below: z.number().int(), value: z.number().int() }),
    ),
    state: RngStateSchema,
  }),
  event("framePushed", { frame: FrameSchema }),
  event("framePopped", {}),
  event("sceneEntered", { scene: z.string() }),
  event("flagSet", { flag: z.string(), value: z.boolean() }),
  event("clockAdvanced", { clock: z.string(), value: z.number().int() }),
  event("attitudeAdjusted", { npc: z.string(), value: z.number().int() }),
  event("secretRevealed", { secret: z.string() }),
  event("beatFired", { beat: z.string() }),
  event("adventureEnded", { reason: z.enum(["ending", "deadEnd"]) }),
] as const;

const NarrativeEventSchema = z.discriminatedUnion("kind", [
  ...NARRATIVE_EVENTS,
]);
const EngineEventSchema = z.discriminatedUnion("kind", [...ENGINE_EVENTS]);

export type NarrativeEvent = z.infer<typeof NarrativeEventSchema>;
export type EngineEvent = z.infer<typeof EngineEventSchema>;

const NAMESPACED_KIND = /^[a-z0-9][a-z0-9.-]*:[A-Za-z][A-Za-z0-9-]*$/;

export interface NamespacedEvent {
  readonly kind: `${string}:${string}`;
  readonly payload: JsonObject;
}

const NamespacedEventSchema = z.strictObject({
  kind: z.string().regex(NAMESPACED_KIND),
  payload: JsonObjectSchema,
});

// What a system's handlers may produce.
export type SystemEvent = NarrativeEvent | NamespacedEvent;
export type GameEvent = EngineEvent | SystemEvent;

export const GameEventSchema = z.union([
  EngineEventSchema,
  NarrativeEventSchema,
  NamespacedEventSchema,
]);

const NARRATIVE_KINDS: ReadonlySet<string> = new Set(
  NARRATIVE_EVENTS.map((schema) => schema.shape.kind.value),
);

export function isNarrativeEvent(item: GameEvent): item is NarrativeEvent {
  return NARRATIVE_KINDS.has(item.kind);
}

export function isNamespacedEvent(item: GameEvent): item is NamespacedEvent {
  return item.kind.includes(":");
}

export const InputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start") }),
  z.strictObject({
    kind: z.literal("answer"),
    decisionId: z.string(),
    optionId: z.string(),
  }),
]);
export type Input = z.infer<typeof InputSchema>;
