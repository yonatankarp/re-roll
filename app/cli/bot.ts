import { testAdventure } from "../../engine/tools/bot.ts";
import { listAdventures, loadAdventure } from "./load-adventure.ts";

// npm run bot -- [runs] [adventure] [--smart] [--difficulty=story|normal|hard]
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const SMART = flags.includes("--smart"); // play fights sensibly, to measure difficulty
const DIFFICULTY = flags
  .find((flag) => flag.startsWith("--difficulty="))
  ?.slice("--difficulty=".length);
const RUNS = Number(args[0] ?? 500);
const ONLY = args[1]; // one adventure's id, or all of them
const MAX_DECISIONS = 500;

for (const adventure of (await listAdventures()).filter(
  (id) => ONLY === undefined || id === ONLY,
)) {
  const { run } = await loadAdventure(adventure);
  const report = testAdventure(run, {
    runs: RUNS,
    maxDecisions: MAX_DECISIONS,
    smart: SMART,
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
