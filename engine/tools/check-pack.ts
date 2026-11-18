import { type Issue, formatIssue } from "../kernel/issues.ts";
import { loadRun, scanPlugins } from "../run/loader.ts";
import type { Storage } from "../kernel/storage.ts";
import type { GameSystem } from "../kernel/system.ts";

export interface CheckReport {
  readonly checked: readonly string[];
  readonly issues: readonly Issue[];
}

export async function checkPlugins(
  storage: Storage,
  roots: readonly string[],
  systems: readonly GameSystem[],
): Promise<CheckReport> {
  const catalog = await scanPlugins(storage, roots);
  const issues = new Map(
    catalog.issues.map((issue) => [formatIssue(issue), issue]),
  );
  const checked = [...catalog.plugins.keys()].sort();

  // Each plugin loads with its dependencies, so a problem shows up in whatever depends on it too.
  for (const id of checked) {
    const result = await loadRun(storage, catalog, systems, [id]);
    if (!result.ok) {
      for (const issue of result.issues) issues.set(formatIssue(issue), issue);
      continue;
    }
    const { lint } = result.registry.system ?? {};
    if (!lint) continue;
    // Only the plugin's own entries, so each is reported once.
    for (const contentId of result.registry.contentIds()) {
      if (!contentId.startsWith(`${id}:`)) continue;
      const entry = result.registry.content(contentId);
      for (const message of entry ? lint(entry) : []) {
        const issue = {
          plugin: id,
          file: null,
          message: `${contentId}: ${message}`,
        };
        issues.set(formatIssue(issue), issue);
      }
    }
  }
  return { checked, issues: [...issues.values()] };
}
