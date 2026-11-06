import { testAdventure } from "../../engine/tools/bot.ts";
import { listAdventures, loadAdventure } from "./load-adventure.ts";

const RUNS = Number(process.argv[2] ?? 500);
const ONLY = process.argv[3]; // one adventure's id, or all of them
const MAX_DECISIONS = 500;

for (const adventure of (await listAdventures()).filter(
  (id) => ONLY === undefined || id === ONLY,
)) {
  const { run } = await loadAdventure(adventure);
  const report = testAdventure(run, {
    runs: RUNS,
    maxDecisions: MAX_DECISIONS,
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
