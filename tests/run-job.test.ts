import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelClient, ModelRequest } from "../engine/prep/model.ts";
import {
  type JobReview,
  MAX_ATTEMPTS,
  type RunnableJob,
  runJob,
} from "../engine/prep/run-job.ts";

function scripted(answers: readonly string[]): ModelClient & {
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete(request) {
      const text = answers[requests.length] ?? "";
      requests.push(request);
      return Promise.resolve({
        text,
        finishReason: "stop",
        completionTokens: 1,
        durationMs: 1,
      });
    },
  };
}

const OPTIONS = { seed: 7, temperature: 0.8 };
const Answer = z.strictObject({ text: z.string().min(1).max(1200) });
const job: RunnableJob = {
  id: "test:scene",
  kind: "scene",
  system: "Write.",
  prompt: "Describe the door.",
  schema: z.toJSONSchema(Answer),
  validate: (value) => Answer.safeParse(value),
  spoilerTerms: ["sealed the cellar"],
  reviews: [],
  fallback: { text: "The base text." },
  maxTokens: 400,
};

// A review that passes when unreadable, and one that rejects then, as the importer's mechanics check does.
const lenient: JobReview = {
  name: "consistency",
  prompt: (answer) => `Check: ${answer}`,
  schema: {},
  ifUnreadable: "pass",
  judge: (review) =>
    typeof review === "object" && review !== null && "ok" in review
      ? review.ok === true
        ? null
        : "it contradicts a fact"
      : undefined,
};
const strict: JobReview = {
  ...lenient,
  name: "spoiler",
  ifUnreadable: "reject",
};

const good = JSON.stringify({ text: "Warm wood, and something knocks back." });
const ok = JSON.stringify({ ok: true });
const problem = JSON.stringify({ ok: false });

describe("runJob", () => {
  it("returns a valid answer on the first attempt", async () => {
    const result = await runJob(job, scripted([good]), OPTIONS);
    expect(result.status).toBe("written");
    expect(result.attempts).toHaveLength(1);
  });

  it("retries invalid JSON with feedback and a new seed", async () => {
    const client = scripted(["not json", good]);
    const result = await runJob(job, client, OPTIONS);
    expect(result.status).toBe("written");
    expect(client.requests[1]?.prompt).toContain("not valid JSON");
    expect(client.requests[1]?.seed).toBe(OPTIONS.seed + 1);
  });

  it("falls back to base text after repeated failures", async () => {
    const client = scripted(["bad", "bad", "bad", good]);
    const result = await runJob(job, client, OPTIONS);
    expect(result.status).toBe("fallback");
    expect(result.output).toEqual(job.fallback);
    expect(client.requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("rejects a spoiler in any casing, without repeating it to the model", async () => {
    const leak = JSON.stringify({ text: "They say she SEALED THE CELLAR." });
    const client = scripted([leak, good]);
    const result = await runJob(job, client, OPTIONS);
    expect(result.status).toBe("written");
    expect(result.attempts[0]?.problems.join()).toContain("gave away a secret");
    expect(client.requests[1]?.prompt).not.toContain("sealed the cellar");
  });

  it("treats a cut-off answer as a failed attempt", async () => {
    const client: ModelClient = {
      complete: () =>
        Promise.resolve({
          text: good,
          finishReason: "length",
          completionTokens: 1,
          durationMs: 1,
        }),
    };
    const result = await runJob(job, client, OPTIONS);
    expect(result.status).toBe("fallback");
    expect(result.attempts[0]?.problems.join()).toContain("cut off");
  });

  it("enforces length limits after parsing", async () => {
    const long = JSON.stringify({ text: "x".repeat(1201) });
    const result = await runJob(job, scripted([long, long, long]), OPTIONS);
    expect(result.status).toBe("fallback");
  });

  it("accepts text once every review passes, reviewing at temperature 0", async () => {
    const client = scripted([good, ok, ok]);
    const result = await runJob(
      { ...job, reviews: [lenient, strict] },
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
    expect(client.requests).toHaveLength(3);
    expect(client.requests[2]?.temperature).toBe(0);
  });

  it("retries with the reviewer's reason when a review rejects the text", async () => {
    const client = scripted([good, problem, good, ok]);
    const result = await runJob(
      { ...job, reviews: [lenient] },
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
    expect(result.attempts[0]?.problems.join()).toContain(
      "consistency: it contradicts a fact",
    );
    expect(client.requests[2]?.prompt).toContain("it contradicts a fact");
  });

  it("rejects the text when a strict review is unreadable or cut off, and passes it when a lenient one is", async () => {
    const unread = await runJob(
      { ...job, reviews: [strict] },
      scripted([good, "nonsense", good, "nonsense", good, "nonsense"]),
      OPTIONS,
    );
    expect(unread.status).toBe("fallback");
    expect(unread.attempts[0]?.problems.join()).toContain("could not decide");

    const passed = await runJob(
      { ...job, reviews: [lenient] },
      scripted([good, "nonsense"]),
      OPTIONS,
    );
    expect(passed.status).toBe("written");
    expect(passed.attempts[0]?.reviews[0]?.raw).toBe("nonsense");

    let calls = 0;
    const cut: ModelClient = {
      complete: () => {
        calls += 1;
        return Promise.resolve({
          text: calls % 2 === 1 ? good : ok,
          finishReason: calls % 2 === 1 ? "stop" : "length",
          completionTokens: 1,
          durationMs: 1,
        });
      },
    };
    const cutOff = await runJob({ ...job, reviews: [strict] }, cut, OPTIONS);
    expect(cutOff.status).toBe("fallback");
  });

  it("skips a review that doesn't apply, and skips reviews while the writing itself is invalid", async () => {
    const skipped = scripted([good]);
    await runJob(
      { ...job, reviews: [{ ...strict, applies: () => false }] },
      skipped,
      OPTIONS,
    );
    expect(skipped.requests).toHaveLength(1);

    const client = scripted(["bad", good, ok]);
    const result = await runJob({ ...job, reviews: [strict] }, client, OPTIONS);
    expect(result.status).toBe("written");
    expect(client.requests).toHaveLength(3);
  });

  it("lets a connection failure stop the run instead of hiding it", async () => {
    const client: ModelClient = {
      complete: () => Promise.reject(new Error("connection refused")),
    };
    await expect(runJob(job, client, OPTIONS)).rejects.toThrow(
      "connection refused",
    );
  });
});
