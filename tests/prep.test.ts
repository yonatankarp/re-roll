import { describe, expect, it } from "vitest";
import { loadRun, scanPlugins } from "../engine/kernel/loader.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { type SessionDigest, planJobs } from "../engine/prep/jobs.ts";
import type { ModelClient, ModelRequest } from "../engine/prep/model.ts";
import { MAX_ATTEMPTS, runJob } from "../engine/prep/run-job.ts";
import type { Adventure } from "../engine/story/adventure.ts";
import { d6System } from "./fixtures/system-d6/index.ts";

async function loadHauntedHouse(): Promise<Adventure> {
  const storage = await createNodeStorage(process.cwd());
  const catalog = await scanPlugins(storage, ["tests/fixtures"]);
  const result = await loadRun(storage, catalog, [d6System], ["haunted-house"]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const adventure = result.registry.adventure("haunted-house");
  if (!adventure) throw new Error("Adventure did not load");
  return adventure;
}

const digest: SessionDigest = {
  run: "test",
  adventure: "haunted-house",
  session: 2,
  player: {
    name: "Ash",
    pronouns: "they/them",
    description: "A debt collector.",
  },
  visitedScenes: ["hallway"],
  nextScene: "cellar-door",
  npc: "caretaker",
  foreshadow: "buried-letter",
  facts: ["The party broke a window to get in."],
  attitudes: { caretaker: -2 },
  revealedSecrets: [],
  companions: [
    {
      id: "ana",
      name: "Ana",
      pronouns: "she/her",
      personality: "Blunt.",
      goal: "Gold.",
      loyalty: 1,
    },
    {
      id: "bo",
      name: "Bo",
      pronouns: "he/him",
      personality: "Nervous.",
      goal: "Home.",
      loyalty: 0,
    },
  ],
};

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

async function jobOfKind(kind: string) {
  const job = planJobs(await loadHauntedHouse(), digest).find(
    (item) => item.kind === kind,
  );
  if (!job) throw new Error(`No ${kind} job`);
  return { ...job, reviews: [] };
}

async function reviewedJobOfKind(kind: string) {
  const job = planJobs(await loadHauntedHouse(), digest).find(
    (item) => item.kind === kind,
  );
  if (!job) throw new Error(`No ${kind} job`);
  return job;
}

const verdict = (value: "ok" | "problem", reason = "Fine."): string =>
  JSON.stringify({ reason, verdict: value });

const noViolations = JSON.stringify({ violations: [] });

const violation = (quote: string): string =>
  JSON.stringify({
    violations: [
      { rule: "contradiction", quote, conflictsWith: "a listed fact" },
    ],
  });

describe("planJobs", () => {
  it("creates schemas with no references for the model", async () => {
    for (const job of planJobs(await loadHauntedHouse(), digest)) {
      const text = JSON.stringify(job.schema);
      expect(text).not.toContain("$ref");
      expect(text).not.toContain("$defs");
    }
  });

  it("limits a job's ids to real companions", async () => {
    const banter = await jobOfKind("banter");
    expect(JSON.stringify(banter.schema)).toContain('"ana"');
  });

  it("only offers scenes reachable from here, and not ones already visited", async () => {
    const adventure = await loadHauntedHouse();
    const planned = planJobs(adventure, {
      ...digest,
      visitedScenes: ["hallway", "doors-seal"],
    }).find((item) => item.kind === "conversation");
    const schema = JSON.stringify(planned?.schema);
    expect(schema).toContain('"stay"');
    expect(schema).toContain('"escape"');
    expect(schema).not.toContain('"doors-seal"');
    expect(schema).not.toContain('"hallway"');
  });

  it("tells every job who the player and NPC are", async () => {
    for (const job of planJobs(await loadHauntedHouse(), digest)) {
      expect(job.prompt).toContain("Ash (they/them)");
      expect(job.prompt).toContain("Mrs. Hale (she/her)");
      expect(job.prompt).toContain("Ana (ana, she/her)");
    }
  });

  it("reviews every job for consistency and rumors for spoilers too", async () => {
    const names = planJobs(await loadHauntedHouse(), digest).map((job) => [
      job.kind,
      job.reviews.map((review) => review.name),
    ]);
    expect(names).toEqual([
      ["scene", ["consistency"]],
      ["conversation", ["consistency"]],
      ["banter", ["consistency"]],
      ["rumor", ["consistency", "spoiler"]],
    ]);
  });

  it("only tells the rumor job about the locked secret", async () => {
    const scene = await jobOfKind("scene");
    const rumor = await jobOfKind("rumor");
    const truth = "sealed the cellar to protect the town";
    expect(scene.prompt).not.toContain(truth);
    expect(rumor.prompt).toContain(truth);
  });

  it("rejects a digest with an unknown scene", async () => {
    const adventure = await loadHauntedHouse();
    expect(() =>
      planJobs(adventure, { ...digest, nextScene: "nowhere" }),
    ).toThrow('unknown scene "nowhere"');
  });
});

describe("runJob", () => {
  const good = JSON.stringify({
    text: "Warm wood, and something knocks back.",
  });

  it("returns a valid answer on the first attempt", async () => {
    const client = scripted([good]);
    const result = await runJob(await jobOfKind("scene"), client, OPTIONS);
    expect(result.status).toBe("written");
    expect(result.attempts).toHaveLength(1);
  });

  it("retries invalid JSON with feedback and a new seed", async () => {
    const client = scripted(["not json", good]);
    const result = await runJob(await jobOfKind("scene"), client, OPTIONS);
    expect(result.status).toBe("written");
    expect(client.requests[1]?.prompt).toContain("not valid JSON");
    expect(client.requests[1]?.seed).toBe(OPTIONS.seed + 1);
  });

  it("falls back to base text after repeated failures", async () => {
    const client = scripted(["bad", "bad", "bad", good]);
    const job = await jobOfKind("scene");
    const result = await runJob(job, client, OPTIONS);
    expect(result.status).toBe("fallback");
    expect(result.output).toEqual(job.fallback);
    expect(client.requests).toHaveLength(MAX_ATTEMPTS);
  });

  it("rejects an unknown id", async () => {
    const answer = JSON.stringify({
      lines: [
        { speaker: "stranger", line: "Hello." },
        { speaker: "ana", line: "Hello." },
      ],
    });
    const result = await runJob(
      await jobOfKind("banter"),
      scripted([answer, answer, answer]),
      OPTIONS,
    );
    expect(result.status).toBe("fallback");
    expect(result.attempts[0]?.problems.join()).toContain("lines.0.speaker");
  });

  it("rejects a spoiler in any casing, without repeating it to the model", async () => {
    const leak = JSON.stringify({ text: "They say she SEALED THE CELLAR." });
    const client = scripted([leak, good]);
    const result = await runJob(await jobOfKind("rumor"), client, OPTIONS);
    expect(result.status).toBe("written");
    expect(result.attempts[0]?.problems.join()).toContain("gave away a secret");
    expect(client.requests[1]?.prompt).not.toContain(
      "gave away a secret: sealed",
    );
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
    const result = await runJob(await jobOfKind("scene"), client, OPTIONS);
    expect(result.status).toBe("fallback");
    expect(result.attempts[0]?.problems.join()).toContain("cut off");
  });

  it("enforces length limits after parsing", async () => {
    const long = JSON.stringify({ text: "x".repeat(1201) });
    const result = await runJob(
      await jobOfKind("scene"),
      scripted([long, long, long]),
      OPTIONS,
    );
    expect(result.status).toBe("fallback");
  });

  it("accepts text once every review passes", async () => {
    const client = scripted([good, noViolations, verdict("ok")]);
    const result = await runJob(
      await reviewedJobOfKind("rumor"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
    expect(client.requests).toHaveLength(3);
    expect(client.requests[2]?.temperature).toBe(0);
  });

  it("retries with the reviewer's reason when a review rejects the text", async () => {
    const client = scripted([
      good,
      noViolations,
      verdict("problem", "It names who sealed the door."),
      good,
      noViolations,
      verdict("ok"),
    ]);
    const result = await runJob(
      await reviewedJobOfKind("rumor"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
    expect(result.attempts[0]?.problems.join()).toContain(
      "spoiler: It names who sealed the door.",
    );
    expect(client.requests[3]?.prompt).toContain(
      "It names who sealed the door.",
    );
  });

  it("rejects the text when a spoiler review is unreadable", async () => {
    const client = scripted([
      good,
      noViolations,
      "nonsense",
      good,
      noViolations,
      "nonsense",
      good,
      noViolations,
      "nonsense",
    ]);
    const result = await runJob(
      await reviewedJobOfKind("rumor"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("fallback");
    expect(result.attempts[0]?.problems.join()).toContain("could not decide");
  });

  it("passes the text when a consistency review is unreadable, and keeps the raw answer", async () => {
    const client = scripted([good, "nonsense"]);
    const result = await runJob(
      await reviewedJobOfKind("scene"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
    expect(result.attempts[0]?.reviews[0]?.raw).toBe("nonsense");
  });

  it("passes the text when a consistency review is cut off", async () => {
    let calls = 0;
    const client: ModelClient = {
      complete: () => {
        calls += 1;
        return Promise.resolve({
          text: calls === 1 ? good : violation("Warm wood"),
          finishReason: calls === 1 ? "stop" : "length",
          completionTokens: 1,
          durationMs: 1,
        });
      },
    };
    const result = await runJob(
      await reviewedJobOfKind("scene"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
  });

  it("rejects the text when a spoiler review is cut off", async () => {
    let calls = 0;
    const client: ModelClient = {
      complete: () => {
        calls += 1;
        const isSpoilerReview = calls % 3 === 0;
        return Promise.resolve({
          text: calls % 3 === 1 ? good : noViolations,
          finishReason: isSpoilerReview ? "length" : "stop",
          completionTokens: 1,
          durationMs: 1,
        });
      },
    };
    const result = await runJob(
      await reviewedJobOfKind("rumor"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("fallback");
  });

  it("ignores a violation whose quote isn't in the text", async () => {
    const client = scripted([good, violation("words that were never written")]);
    const result = await runJob(
      await reviewedJobOfKind("scene"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
  });

  it("rejects a violation that quotes the text, ignoring case and spacing", async () => {
    const client = scripted([
      good,
      violation("WARM   wood"),
      good,
      noViolations,
    ]);
    const result = await runJob(
      await reviewedJobOfKind("scene"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
    expect(result.attempts[0]?.problems.join()).toContain("WARM   wood");
  });

  it("shows the review what the scene itself allows", async () => {
    const job = await reviewedJobOfKind("scene");
    expect(job.reviews[0]?.prompt("{}")).toContain("something knocks back");
  });

  it("skips reviews when the writing itself is already invalid", async () => {
    const client = scripted(["bad", good, noViolations]);
    const result = await runJob(
      await reviewedJobOfKind("scene"),
      client,
      OPTIONS,
    );
    expect(result.status).toBe("written");
    expect(client.requests).toHaveLength(3);
  });

  it("lets a connection failure stop prep instead of hiding it", async () => {
    const client: ModelClient = {
      complete: () => Promise.reject(new Error("connection refused")),
    };
    await expect(
      runJob(await jobOfKind("scene"), client, OPTIONS),
    ).rejects.toThrow("connection refused");
  });
});
