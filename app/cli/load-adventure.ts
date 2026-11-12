import { formatIssue } from "../../engine/kernel/issues.ts";
import {
  type Registry,
  loadRun,
  scanPlugins,
} from "../../engine/kernel/loader.ts";
import { type RunContext, createRunContext } from "../../engine/kernel/turn.ts";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { systems } from "../systems.ts";

// RE_ROLL_ROOTS (comma-separated) narrows the folders, as the unit tests do to leave the books out.
export const PLUGIN_ROOTS: readonly string[] = process.env.RE_ROLL_ROOTS?.split(
  ",",
) ?? ["plugins", "books"];

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
