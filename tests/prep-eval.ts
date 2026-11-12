import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { loadRun, scanPlugins } from "../engine/kernel/loader.ts";
import { createLlamaClient } from "../engine/platform/node/llama-client.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { SessionDigestSchema, planJobs } from "../engine/prep/jobs.ts";
import { type JobResult, runJob } from "../engine/prep/run-job.ts";
import { d6System } from "./fixtures/system-d6/index.ts";

// Manual evaluation against a running llama-server, so it stays out of `npm test`.
// The automated checks only catch broken output. Whether it reads well is the reader's call.

const SERVER = process.env.LLAMA_URL ?? "http://127.0.0.1:8181";
const MODEL = process.env.MODEL_NAME ?? "unknown model";
const PAIRS = [
  ["goblin-a", "goblin-b"],
  ["house-a", "house-b"],
] as const;

const EvalRunSchema = SessionDigestSchema.extend({
  expectedMentions: z.array(z.array(z.string().min(1)).min(1)).min(1),
});
type EvalRun = z.infer<typeof EvalRunSchema>;

interface RunOutcome {
  readonly run: EvalRun;
  readonly results: readonly JobResult[];
  readonly missingMentions: readonly string[];
}

const storage = await createNodeStorage(process.cwd());
const catalog = await scanPlugins(storage, ["tests/fixtures"]);
const client = createLlamaClient(SERVER, {
  allowRemote: process.argv.includes("--allow-remote"),
});

async function evaluate(name: string): Promise<RunOutcome> {
  const text = await readFile(`tests/fixtures/prep/${name}.yaml`, "utf8");
  const run = EvalRunSchema.parse(parse(text));
  const { expectedMentions, ...digest } = run;
  const loaded = await loadRun(storage, catalog, [d6System], [run.adventure]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const adventure = loaded.registry.adventure(run.adventure);
  if (!adventure) throw new Error(`No adventure ${run.adventure}`);

  const results: JobResult[] = [];
  for (const job of planJobs(adventure, digest)) {
    const result = await runJob(job, client, { seed: 42, temperature: 0.8 });
    results.push(result);
    const last = result.attempts.at(-1);
    console.log(
      `${job.id}: ${result.status}, ${String(result.attempts.length)} attempt(s), ${String(Math.round((last?.durationMs ?? 0) / 1000))}s last`,
    );
  }

  const written = JSON.stringify(
    results
      .filter((result) => result.status === "written")
      .map((result) => result.output),
  ).toLowerCase();
  const missingMentions = expectedMentions
    .filter(
      (options) =>
        !options.some((word) => written.includes(word.toLowerCase())),
    )
    .map((options) => options.join(" / "));
  return { run, results, missingMentions };
}

function render(output: unknown): string {
  if (output === null) return "_(no text)_";
  const parts: string[] = [];
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string")
      parts.push(key ? `**${key}:** ${value}` : value);
    else if (Array.isArray(value))
      value.forEach((item) => {
        visit(item, "");
      });
    else if (typeof value === "object" && value !== null) {
      for (const [name, child] of Object.entries(value)) visit(child, name);
    }
  };
  visit(output, "");
  return parts.join("<br>").replaceAll("|", "\\|").replaceAll("\n", " ");
}

// A fallback still shows the last rejected text, so the writing can be judged apart from the reviewers.
function cell(result: JobResult): string {
  if (result.status === "written") return render(result.output);
  const last = result.attempts.at(-1);
  let shown: unknown = last?.text ?? "";
  try {
    shown = JSON.parse(last?.text ?? "");
  } catch {
    // Unparsable text is shown as it came back.
  }
  const reasons = (last?.problems ?? []).join(" ").replaceAll("|", "\\|");
  return `_(rejected, uses base text instead: ${reasons})_<br>${render(shown)}`;
}

const outcomes = new Map<string, RunOutcome>();
const startedAt = performance.now();
for (const name of PAIRS.flat()) outcomes.set(name, await evaluate(name));
const totalMs = performance.now() - startedAt;

const all = [...outcomes.values()].flatMap((outcome) => outcome.results);
const attempts = all.flatMap((result) => result.attempts);
const reviewCalls = attempts.flatMap((item) => item.reviews).length;
const tokens = attempts.reduce((sum, item) => sum + item.completionTokens, 0);
const generationMs = attempts.reduce((sum, item) => sum + item.durationMs, 0);
const fallbacks = all.filter((result) => result.status === "fallback");
const countProblems = (prefix: string): number =>
  attempts
    .flatMap((item) => item.problems)
    .filter((problem) => problem.startsWith(prefix)).length;
const reviewRejections = all.flatMap((result) =>
  result.attempts.flatMap((attempt) =>
    attempt.problems
      .filter(
        (problem) =>
          problem.startsWith("spoiler:") ||
          problem.startsWith("consistency:") ||
          problem.includes("gave away") ||
          problem.includes("could not decide"),
      )
      .map((problem) => `- \`${result.job.id}\`: ${problem}`),
  ),
);
const missing = [...outcomes.entries()].flatMap(([name, outcome]) =>
  outcome.missingMentions.map((mention) => `${name}: ${mention}`),
);
const perPackSeconds = totalMs / 1000 / outcomes.size;

const leakedSpoilers = all.filter((result) => {
  const text = JSON.stringify(result.output).toLowerCase();
  return result.job.spoilerTerms.some((term) =>
    text.includes(term.toLowerCase()),
  );
});

const checks = [
  ["Every job ended valid within its retries", fallbacks.length === 0],
  [
    "No listed spoiler term survived into the final text",
    leakedSpoilers.length === 0,
  ],
  ["Each run mentions the facts that set it apart", missing.length === 0],
] as const;

const lines = [
  "# Prep evaluation",
  "",
  `**Model:** ${MODEL}`,
  "",
  "## Automated checks",
  "",
  "| Check | Result |",
  "|---|---|",
  ...checks.map(
    ([label, passed]) => `| ${label} | ${passed ? "Pass" : "**Fail**"} |`,
  ),
  "",
  "These only catch broken output, so reading the text below is the real test.",
  "",
  "## Numbers",
  "",
  "| Measure | Value |",
  "|---|---|",
  `| Jobs | ${String(all.length)} |`,
  `| Writing calls | ${String(attempts.length)} |`,
  `| Review calls | ${String(reviewCalls)} |`,
  `| Fallbacks to base text | ${String(fallbacks.length)} |`,
  `| Rejected by the spoiler review | ${String(countProblems("spoiler:"))} |`,
  `| Rejected by the consistency review | ${String(countProblems("consistency:"))} |`,
  `| Average time for a 4-job pack | ${String(Math.round(perPackSeconds))}s |`,
  `| Speed including prompt processing | ${(tokens / (generationMs / 1000)).toFixed(1)} tokens/s |`,
  "",
  missing.length > 0 ? `**Missing mentions:** ${missing.join("; ")}` : "",
  "",
  "## What the reviewers rejected",
  "",
  ...(reviewRejections.length > 0 ? reviewRejections : ["Nothing."]),
  "",
];

for (const [first, second] of PAIRS) {
  const a = outcomes.get(first);
  const b = outcomes.get(second);
  if (!a || !b) continue;
  lines.push(`## ${a.run.adventure}`, "");
  lines.push("| | Run A | Run B |", "|---|---|---|");
  lines.push(
    `| **What happened** | ${a.run.facts.join("<br>")} | ${b.run.facts.join("<br>")} |`,
  );
  a.results.forEach((result, index) => {
    const other = b.results[index];
    lines.push(
      `| **${result.job.kind}** | ${cell(result)} | ${other ? cell(other) : ""} |`,
    );
  });
  lines.push("");
}

await mkdir("out/prep-eval", { recursive: true });
await writeFile("out/prep-eval/report.md", lines.join("\n"));
await writeFile(
  "out/prep-eval/attempts.json",
  JSON.stringify(
    all.map((result) => ({
      job: result.job.id,
      status: result.status,
      attempts: result.attempts,
    })),
    null,
    2,
  ),
);
console.log(
  `Report: out/prep-eval/report.md (${String(Math.round(totalMs / 1000))}s total)`,
);
