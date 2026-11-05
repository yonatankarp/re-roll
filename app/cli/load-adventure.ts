import { formatIssue } from "../../engine/kernel/issues.ts";
import {
  type Registry,
  loadRun,
  scanPlugins,
} from "../../engine/kernel/loader.ts";
import { type RunContext, createRunContext } from "../../engine/kernel/turn.ts";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { systems } from "../systems.ts";

export const PLUGIN_ROOTS = ["plugins", "private"] as const;

export async function listAdventures(): Promise<readonly string[]> {
  const storage = await createNodeStorage(process.cwd());
  const catalog = await scanPlugins(storage, PLUGIN_ROOTS);
  return [...catalog.plugins.values()]
    .filter((plugin) => plugin.manifest.kind === "adventure")
    .map((plugin) => plugin.manifest.id)
    .sort();
}

export async function loadAdventure(
  adventure: string,
): Promise<{ readonly registry: Registry; readonly run: RunContext }> {
  const storage = await createNodeStorage(process.cwd());
  const catalog = await scanPlugins(storage, PLUGIN_ROOTS);
  const loaded = await loadRun(storage, catalog, systems, [adventure]);
  if (!loaded.ok) {
    throw new Error(loaded.issues.map(formatIssue).join("\n"));
  }
  return {
    registry: loaded.registry,
    run: createRunContext(loaded.registry, adventure),
  };
}
