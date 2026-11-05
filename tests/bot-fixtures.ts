import { loadRun, scanPlugins } from "../engine/kernel/loader.ts";
import { createRunContext } from "../engine/kernel/turn.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { testAdventure } from "../engine/tools/bot.ts";
import { d6System } from "./fixtures/system-d6/index.ts";

const RUNS = 1000;
const MAX_DECISIONS = 300;

const storage = await createNodeStorage(process.cwd());
const catalog = await scanPlugins(storage, ["tests/fixtures"]);
const adventures = [...catalog.plugins.values()]
  .filter((plugin) => plugin.manifest.kind === "adventure")
  .map((plugin) => plugin.manifest.id);

for (const adventure of adventures) {
  const loaded = await loadRun(storage, catalog, [d6System], [adventure]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues, null, 2));

  const report = testAdventure(createRunContext(loaded.registry, adventure), {
    runs: RUNS,
    maxDecisions: MAX_DECISIONS,
  });
  console.log(`${adventure}: ${String(report.runs)} runs`);
  console.log(`  Final scenes: ${JSON.stringify(report.endings)}`);
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
