import type { GameSystem } from "#sdk";
import { formatIssue } from "../../engine/kernel/issues.ts";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { checkPlugins } from "../../engine/tools/check-pack.ts";

export async function runCheckPack(
  roots: readonly string[],
  systems: readonly GameSystem[],
): Promise<void> {
  const storage = await createNodeStorage(process.cwd());
  const report = await checkPlugins(storage, roots, systems);

  for (const issue of report.issues) console.error(formatIssue(issue));
  console.log(
    `Checked ${String(report.checked.length)} plugins: ${report.checked.join(", ") || "none"}`,
  );
  console.log(`${String(report.issues.length)} issues`);
  if (report.issues.length > 0) process.exitCode = 1;
}
