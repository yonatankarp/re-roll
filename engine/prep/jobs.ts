import { z } from "zod";
import type { Adventure } from "../story/adventure.ts";

export const SessionDigestSchema = z.strictObject({
  run: z.string().min(1),
  adventure: z.string().min(1),
  session: z.number().int().min(1),
  player: z.strictObject({
    name: z.string().min(1),
    pronouns: z.string().min(1),
    description: z.string().min(1),
  }),
  visitedScenes: z.array(z.string()).default([]),
  nextScene: z.string().min(1),
  npc: z.string().min(1),
  foreshadow: z.string().min(1),
  facts: z.array(z.string().min(1)).min(1),
  attitudes: z.record(z.string(), z.number().int()).default({}),
  revealedSecrets: z.array(z.string()).default([]),
  companions: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1),
        pronouns: z.string().min(1),
        personality: z.string().min(1),
        goal: z.string().min(1),
        loyalty: z.number().int(),
      }),
    )
    .min(2),
});

export type SessionDigest = z.infer<typeof SessionDigestSchema>;

export type JobKind = "scene" | "conversation" | "banter" | "rumor";

export interface PrepReview {
  readonly name: "consistency" | "spoiler" | "mechanics";
  readonly system?: string;
  readonly applies?: (answer: unknown) => boolean;
  readonly prompt: (answer: string) => string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly ifUnreadable: "pass" | "reject";
  // Returns a problem, null for a pass, or undefined when the review can't be read.
  readonly judge: (
    review: unknown,
    answer: unknown,
  ) => string | null | undefined;
}

export interface RunnableJob {
  readonly id: string;
  readonly kind: string;
  readonly system: string;
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly validate: (value: unknown) => z.ZodSafeParseResult<unknown>;
  readonly spoilerTerms: readonly string[];
  readonly reviews: readonly PrepReview[];
  readonly fallback: unknown;
  readonly maxTokens: number;
}

export interface PrepJob extends RunnableJob {
  readonly kind: JobKind;
}

const STAY = "stay";

const SYSTEM_PROMPT = [
  "You are preparing the next session of a tabletop adventure, as a skilled game master would.",
  "Write vivid, specific, concrete prose.",
  "Use the facts from this party's earlier sessions, so the text could only belong to this run.",
  "Never contradict the facts. Never invent dice results, rules or numbers.",
  "Return only JSON that matches the requested format.",
].join(" ");

export const REVIEW_SYSTEM = [
  "You are a strict but fair editor checking text prepared for a tabletop adventure.",
  "Most text you check is fine.",
  "Return only JSON that matches the requested format.",
].join(" ");

type Text = (max: number) => z.ZodString;

// The grammar gets plain strings, and length limits are enforced after parsing,
// so an overly long answer earns a retry with feedback instead of a cut-off sentence.
const plain: Text = () => z.string();
const limited: Text = (max) => z.string().min(1).max(max);

function jsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  // Reported llama-server bugs drop the constraint on $ref, so a recursive schema must fail here.
  return z.toJSONSchema(schema, { reused: "inline", cycles: "throw" });
}

const SpoilerVerdictSchema = z.strictObject({
  reason: z.string(),
  verdict: z.enum(["ok", "problem"]),
});

// A small model mislabels a yes-or-no verdict, so passing is the default here,
// and a rejection has to quote the words at fault for code to verify.
const ConsistencyReportSchema = z.strictObject({
  violations: z
    .array(
      z.strictObject({
        rule: z.enum([
          "contradiction",
          "wrongPronoun",
          "companionAddressedAsYou",
          "companionOutOfCharacter",
        ]),
        quote: z.string(),
        conflictsWith: z.string(),
      }),
    )
    .max(3),
});

function allText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(allText).join(" ");
  if (typeof value === "object" && value !== null) {
    return Object.values(value).map(allText).join(" ");
  }
  return "";
}

const normalized = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

function judgeConsistency(
  review: unknown,
  answer: unknown,
): string | null | undefined {
  const parsed = ConsistencyReportSchema.safeParse(review);
  if (!parsed.success) return undefined;
  const text = normalized(allText(answer));
  const real = parsed.data.violations.filter((violation) => {
    const quote = normalized(violation.quote);
    return quote.length > 0 && text.includes(quote);
  });
  if (real.length === 0) return null;
  return real
    .map(
      (violation) =>
        `${violation.rule}: "${violation.quote}" conflicts with ${violation.conflictsWith}`,
    )
    .join("; ");
}

function judgeSpoiler(review: unknown): string | null | undefined {
  const parsed = SpoilerVerdictSchema.safeParse(review);
  if (!parsed.success) return undefined;
  return parsed.data.verdict === "problem" ? parsed.data.reason : null;
}

function enumOf(values: readonly string[]) {
  const [first, ...rest] = values;
  if (first === undefined)
    throw new Error("A job needs at least one allowed id");
  return z.enum([first, ...rest]);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Digest refers to unknown ${label}`);
  return value;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

type Scene = Adventure["scenes"][number];

function scenesAfter(
  scene: Scene,
  adventure: Adventure,
  visited: ReadonlySet<string>,
): readonly Scene[] {
  const targets = new Set(
    scene.choices.flatMap((choice) =>
      ("effects" in choice
        ? choice.effects
        : Object.values(choice.results).flat()
      ).flatMap((effect) => (effect.kind === "goto" ? [effect.scene] : [])),
    ),
  );
  return adventure.scenes.filter(
    (item) => targets.has(item.id) && !visited.has(item.id),
  );
}

export function planJobs(
  adventure: Adventure,
  digest: SessionDigest,
): readonly PrepJob[] {
  const scene = required(
    adventure.scenes.find((item) => item.id === digest.nextScene),
    `scene "${digest.nextScene}"`,
  );
  const npc = required(
    adventure.npcs.find((item) => item.id === digest.npc),
    `NPC "${digest.npc}"`,
  );
  const foreshadowed = required(
    adventure.secrets.find((item) => item.id === digest.foreshadow),
    `secret "${digest.foreshadow}"`,
  );

  const revealed = new Set(digest.revealedSecrets);
  const spoilerTerms = adventure.secrets
    .filter((secret) => !revealed.has(secret.id))
    .flatMap((secret) => secret.spoilerTerms);
  const knownTruths = adventure.secrets
    .filter((secret) => revealed.has(secret.id))
    .map((secret) => secret.truth);
  const { player } = digest;
  const attitude = digest.attitudes[npc.id] ?? npc.attitude;

  const history = [
    `Adventure: ${adventure.title}.`,
    `The player character is ${player.name} (${player.pronouns}). ${player.description} Address the player character as "you". Everyone else is someone other than the player: refer to them by name, and never address a companion as "you" in narration.`,
    `What has happened in this run:\n${bullets(digest.facts)}`,
    knownTruths.length > 0
      ? `Secrets the party already knows:\n${bullets(knownTruths)}`
      : "",
    `Main NPC here: ${npc.name} (${npc.pronouns}). Attitude toward the party: ${String(attitude)} (below 0 is hostile, above 0 is friendly).`,
    `The player's companions:\n${bullets(
      digest.companions.map(
        (companion) =>
          `${companion.name} (${companion.id}, ${companion.pronouns}): ${companion.personality} Wants: ${companion.goal} Loyalty to the player: ${String(companion.loyalty)}.`,
      ),
    )}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const consistency = (context: string): PrepReview => ({
    name: "consistency",
    prompt: (answer) =>
      `${context}\n\nText to check:\n${answer}\n\nList only clear violations of these rules. The list is usually empty.\n- contradiction: it directly contradicts a listed fact or clue.\n- wrongPronoun: it uses the wrong pronoun for a named person.\n- companionAddressedAsYou: narration addresses a companion as "you", or a player option is a decision for a companion. Companions speaking to each other as "you" in dialogue is fine.\n- companionOutOfCharacter: a companion says something opposed to their personality or to what the facts say about them.\nFor each violation, quote the exact words at fault and say what they conflict with. Small invented details that don't conflict with anything are fine.`,
    schema: jsonSchema(ConsistencyReportSchema),
    ifUnreadable: "pass",
    judge: judgeConsistency,
  });

  const spoiler: PrepReview = {
    name: "spoiler",
    prompt: (answer) =>
      `Secret: ${foreshadowed.truth}\n\nRumor:\n${answer}\n\nImagine a sharp player who hears only this rumor. Could they likely guess the secret, including who is involved and what they are doing? Unease, odd small details and vague suspicion are fine. Give your reason first, then your verdict. Answer problem if the rumor ties a named person or the village's leader to the secret activity, or describes that activity directly. Otherwise answer ok.`,
    schema: jsonSchema(SpoilerVerdictSchema),
    ifUnreadable: "reject",
    judge: judgeSpoiler,
  };

  const sceneContext = `${history}\n\nWhat happens in this scene, which is always allowed: ${scene.text}`;

  const reachable = scenesAfter(
    scene,
    adventure,
    new Set(digest.visitedScenes),
  );
  const destinations = [STAY, ...reachable.map((item) => item.id)];
  const destinationNotes = bullets([
    `${STAY}: the conversation ends and the party remains in this scene.`,
    ...reachable.map((item) => `${item.id}: ${item.text}`),
  ]);

  const sceneOutput = (text: Text) => z.strictObject({ text: text(1200) });
  const conversationOutput = (text: Text) =>
    z.strictObject({
      opening: text(500),
      options: z
        .array(
          z.strictObject({
            label: text(120),
            reply: text(400),
            leadsTo: enumOf(destinations),
          }),
        )
        .min(2)
        .max(3),
    });
  const speakers = digest.companions.map((companion) => companion.id);
  const banterOutput = (text: Text) =>
    z.strictObject({
      lines: z
        .array(z.strictObject({ speaker: enumOf(speakers), line: text(240) }))
        .min(2)
        .max(4),
    });
  const rumorOutput = (text: Text) => z.strictObject({ text: text(400) });

  const job = (
    kind: JobKind,
    request: string,
    build: (text: Text) => z.ZodType,
    maxTokens: number,
    fallback: unknown,
    options: {
      readonly reviewContext?: string;
      readonly extraReviews?: readonly PrepReview[];
    } = {},
  ): PrepJob => ({
    id: `${digest.run}:${kind}`,
    kind,
    system: SYSTEM_PROMPT,
    prompt: `${history}\n\n${request}`,
    schema: jsonSchema(build(plain)),
    validate: (value) => build(limited).safeParse(value),
    spoilerTerms,
    reviews: [
      consistency(options.reviewContext ?? history),
      ...(options.extraReviews ?? []),
    ],
    fallback,
    maxTokens,
  });

  const establishedClues = `Established clues, which the rumor must not contradict:\n${bullets(
    foreshadowed.clues.map((clue) => clue.text),
  )}`;

  return [
    job(
      "scene",
      `Rewrite this scene's description for this party in 2 to 4 sentences, under 90 words. Keep what happens the same, but make it reflect their history.\nScene: ${scene.text}`,
      sceneOutput,
      400,
      { text: scene.text },
      { reviewContext: sceneContext },
    ),
    job(
      "conversation",
      `Write a short conversation between ${npc.name} and the player character. ${npc.name}'s motive, which ${npc.name} does not say out loud: ${npc.motive}\nWrite ${npc.name}'s opening line in under 60 words. Then write 2 or 3 options, each a thing the player character says or does, written as a short sentence starting with a verb. Never make an option a decision for a companion. For each option write ${npc.name}'s reply in under 50 words, and choose where it leads from:\n${destinationNotes}`,
      conversationOutput,
      700,
      null,
      { reviewContext: sceneContext },
    ),
    job(
      "banter",
      "Write 2 to 4 lines of banter between the companions, spoken when the party next has a quiet moment. Each line must sound like its speaker, stay true to their personality and to what the facts say about them, and refer to something that happened in this run. Companions do not suddenly change their opinions.",
      banterOutput,
      400,
      null,
    ),
    job(
      "rumor",
      `Write one rumor the party might overhear, in 1 or 2 short sentences and under 40 words. It must create unease through a mood or one small odd detail, and hint at this secret from far off. Never connect any named person or leader to the secret activity, and never describe that activity.\nSecret, for your eyes only: ${foreshadowed.truth}\n${establishedClues}`,
      rumorOutput,
      150,
      null,
      {
        reviewContext: `${history}\n\n${establishedClues}`,
        extraReviews: [spoiler],
      },
    ),
  ];
}
