import { REVIEW_SYSTEM, type RunnableJob } from "./jobs.ts";
import type { ModelClient } from "./model.ts";

export const MAX_ATTEMPTS = 3;

export interface ReviewRecord {
  readonly name: string;
  readonly raw: string;
  readonly finishReason: string;
}

export interface AttemptRecord {
  readonly text: string;
  readonly problems: readonly string[];
  readonly reviews: readonly ReviewRecord[];
  readonly completionTokens: number;
  readonly durationMs: number;
}

export interface JobResult {
  readonly job: RunnableJob;
  readonly status: "written" | "fallback";
  readonly output: unknown;
  readonly attempts: readonly AttemptRecord[];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function findProblems(
  job: RunnableJob,
  text: string,
): { problems: string[]; output?: unknown } {
  const value = parseJson(text);
  if (value === undefined) {
    return { problems: ["The answer was not valid JSON."] };
  }

  const parsed = job.validate(value);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
      ),
    };
  }

  const lowered = JSON.stringify(parsed.data).toLowerCase();
  const leaked = job.spoilerTerms.filter((term) =>
    lowered.includes(term.toLowerCase()),
  );
  if (leaked.length > 0) {
    // The term itself isn't echoed in the feedback, so the retry can't pick it up from here.
    return { problems: ["The answer gave away a secret. Hint less directly."] };
  }
  return { problems: [], output: parsed.data };
}

// Model failures fall back to base text, but a failed connection throws, so prep can stop and report it.
export async function runJob(
  job: RunnableJob,
  client: ModelClient,
  options: { readonly seed: number; readonly temperature: number },
): Promise<JobResult> {
  const attempts: AttemptRecord[] = [];
  let feedback = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const seed = options.seed + attempt;
    const response = await client.complete({
      system: job.system,
      prompt: `${job.prompt}${feedback}`,
      schema: job.schema,
      maxTokens: job.maxTokens,
      temperature: options.temperature,
      seed,
    });
    let completionTokens = response.completionTokens;
    let durationMs = response.durationMs;

    const { problems, output } =
      response.finishReason === "length"
        ? {
            problems: ["The answer was too long and got cut off."],
            output: undefined,
          }
        : findProblems(job, response.text);

    const reviews: ReviewRecord[] = [];
    if (problems.length === 0) {
      for (const review of job.reviews) {
        if (review.applies?.(output) === false) continue;
        const verdict = await client.complete({
          system: review.system ?? REVIEW_SYSTEM,
          prompt: review.prompt(response.text),
          schema: review.schema,
          maxTokens: 250,
          temperature: 0,
          seed,
        });
        completionTokens += verdict.completionTokens;
        durationMs += verdict.durationMs;
        reviews.push({
          name: review.name,
          raw: verdict.text,
          finishReason: verdict.finishReason,
        });

        const judged =
          verdict.finishReason === "length"
            ? undefined
            : review.judge(parseJson(verdict.text), output);
        if (judged === undefined) {
          if (review.ifUnreadable === "reject") {
            problems.push(
              `${review.name}: the review could not decide, so write a safer version.`,
            );
          }
        } else if (judged !== null) {
          problems.push(`${review.name}: ${judged}`);
        }
      }
    }

    attempts.push({
      text: response.text,
      problems,
      reviews,
      completionTokens,
      durationMs,
    });
    if (problems.length === 0) {
      return { job, status: "written", output, attempts };
    }
    feedback = `\n\nYour previous answer had these problems, so fix them:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
  }
  return { job, status: "fallback", output: job.fallback, attempts };
}
