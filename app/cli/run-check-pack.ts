import type { GameSystem } from "#sdk";
import { formatIssue } from "../../engine/kernel/issues.ts";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { checkPlugins } from "../../engine/tools/check-pack.ts";
import { checkCoverage, formatCoverage } from "../../engine/tools/coverage.ts";
import { scanPlugins } from "../../engine/run/loader.ts";

export async function runCheckPack(
  roots: readonly string[],
  systems: readonly GameSystem[],
  coverageFails = false, // a library heading with no entity, or a bad link, fails the check
): Promise<void> {
  const storage = await createNodeStorage(process.cwd());
  const report = await checkPlugins(storage, roots, systems);

  for (const issue of report.issues) console.error(formatIssue(issue));
  console.log(
    `Checked ${String(report.checked.length)} plugins: ${report.checked.join(", ") || "none"}`,
  );
  console.log(`${String(report.issues.length)} issues`);
  if (report.issues.length > 0) process.exitCode = 1;

  const coverage = await checkCoverage(
    storage,
    roots,
    await scanPlugins(storage, roots),
    systems,
  );
  if (coverage.books.length === 0) {
    console.log("Library coverage: no books");
    return;
  }
  const lines = formatCoverage(coverage);
  const missing = coverage.books.some(({ verdicts }) =>
    verdicts.some((verdict) => verdict.status === "missing"),
  );
  const log = coverageFails ? console.error : console.log;
  for (const issue of coverage.issues) log(formatIssue(issue));
  for (const line of lines) log(line);
  if (coverageFails && (missing || coverage.issues.length > 0))
    process.exitCode = 1;
}
