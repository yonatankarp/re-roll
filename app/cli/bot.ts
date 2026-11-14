import { testAdventure } from "../../engine/tools/bot.ts";
import { listAdventures, loadAdventure } from "./load-adventure.ts";

// npm run bot -- [runs] [adventure] [--smart] [--rests] [--avoid-endings] [--difficulty=story|normal|hard] [--check]
// --check plays every difficulty and fails when a defeat rate leaves its band in CHECK_BANDS.
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const SMART = flags.includes("--smart"); // play fights and build characters sensibly, to measure difficulty
const RESTS = flags.includes("--rests"); // rest whenever a scene allows
const AVOID_ENDINGS = flags.includes("--avoid-endings"); // keep going while a choice doesn't end the adventure
const DIFFICULTY = flags
  .find((flag) => flag.startsWith("--difficulty="))
  ?.slice("--difficulty=".length);
const RUNS = Number(args[0] ?? 500);
const ONLY = args[1]; // one adventure's id, or all of them
const MAX_DECISIONS = 5000; // a long book adventure played to its end takes over a thousand
const CHECK = flags.includes("--check");

// Defeat %, smart play, seeds bot-0..199. Wide bands around the rates measured on 2026-11-12, to catch
// regressions. The shipped adventures are short and gentle, below the 15-45% Normal target in CLAUDE.md,
// so these bands don't enforce it. Book adventures stay out: their ids don't belong in this repository.
const CHECK_BANDS: Readonly<
  Record<string, Readonly<Record<string, readonly [number, number]>>>
> = {
  "goblin-ambush": { story: [0, 10], normal: [0, 15], hard: [1, 25] }, // measured 0, 1.5, 5; 0, 0, 3.5 on 2026-11-14
  "haunted-house": { story: [0, 5], normal: [0, 5], hard: [0, 5] }, // measured 0, 0, 0
};

if (CHECK) {
  for (const [adventure, bands] of Object.entries(CHECK_BANDS)) {
    if (ONLY !== undefined && adventure !== ONLY) continue;
    const { run } = await loadAdventure(adventure);
    for (const [difficulty, [low, high]] of Object.entries(bands)) {
      const report = testAdventure(run, {
        runs: RUNS,
        maxDecisions: MAX_DECISIONS,
        smart: true,
        settings: { difficulty },
      });
      const rate = (100 * report.defeats) / report.runs;
      const ok = report.failures.length === 0 && rate >= low && rate <= high;
      console.log(
        `${ok ? "ok  " : "FAIL"} ${adventure} ${difficulty}: ${rate.toFixed(1)}% defeats (band ${String(low)}-${String(high)}%), ${String(report.failures.length)} failures`,
      );
      if (!ok) process.exitCode = 1;
    }
  }
}

for (const adventure of (await listAdventures()).filter(
  (id) => !CHECK && (ONLY === undefined || id === ONLY),
)) {
  const { run } = await loadAdventure(adventure);
  const report = testAdventure(run, {
    runs: RUNS,
    maxDecisions: MAX_DECISIONS,
    smart: SMART,
    rests: RESTS,
    avoidEndings: AVOID_ENDINGS,
    ...(DIFFICULTY ? { settings: { difficulty: DIFFICULTY } } : {}),
  });
  console.log(`${adventure}: ${String(report.runs)} runs`);
  console.log(`  Final scenes: ${JSON.stringify(report.endings)}`);
  console.log(`  Party defeats: ${String(report.defeats)}`);
  console.log(
    `  Unvisited scenes: ${report.unvisitedScenes.join(", ") || "none"}`,
  );
  console.log(`  Failures: ${String(report.failures.length)}`);
  for (const failure of report.failures.slice(0, 5)) {
    console.error(
      `  ${failure.seed}: ${failure.problem}\n    Inputs: ${JSON.stringify(failure.inputs)}`,
    );
  }
  if (report.failures.length > 0) process.exitCode = 1;
}
