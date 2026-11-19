import { type Issue, formatIssue } from "../kernel/issues.ts";
import {
  type PluginRecord,
  type Registry,
  loadRun,
  scanPlugins,
} from "../run/loader.ts";
import type { Storage } from "../kernel/storage.ts";
import type { GameSystem } from "../kernel/system.ts";
import {
  ART_INDEX,
  ArtIndexSchema,
  CREDITS,
  CreditsSchema,
} from "../story/art.ts";

const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;

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
    const record = catalog.plugins.get(id);
    if (record) {
      for (const issue of await checkArt(
        storage,
        record,
        result.registry,
        catalog.plugins,
      ))
        issues.set(formatIssue(issue), issue);
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

// A plugin's own pictures: its index names files it holds and things that exist, every picture an
// adventure points at is there, and a shipped plugin credits each file under a licence that lets it ship.
async function checkArt(
  storage: Storage,
  record: PluginRecord,
  registry: Registry,
  plugins: ReadonlyMap<string, PluginRecord>,
): Promise<Issue[]> {
  const plugin = record.manifest.id;
  const issues: Issue[] = [];
  const files = new Set(record.files);
  const report = (file: string, message: string): void => {
    issues.push({ plugin, file: `${record.root}/${file}`, message });
  };
  const readJson = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(
        (await storage.read(`${record.root}/${file}`)) ?? "null",
      );
    } catch {
      return undefined;
    }
  };

  if (files.has(ART_INDEX)) {
    const parsed = ArtIndexSchema.safeParse(await readJson(ART_INDEX));
    if (!parsed.success) report(ART_INDEX, "isn't a list of pictures");
    for (const entry of parsed.data ?? []) {
      const at = (message: string): void => {
        report(ART_INDEX, `${entry.file}: ${message}`);
      };
      if (!files.has(`assets/${entry.file}`)) at("no such file in assets/");
      else if (!IMAGE_FILE.test(entry.file)) at("isn't a picture");
      for (const id of entry.cover ?? [])
        if (!plugins.has(id)) at(`cover of "${id}", which isn't a plugin`);
      for (const key of entry.chapter ?? []) {
        const [adventure = "", scene] = key.split(":");
        if (
          !registry
            .adventure(adventure)
            ?.scenes.some((item) => item.id === scene)
        )
          at(`chapter "${key}" names no scene`);
      }
      for (const id of [
        ...(entry.monster ? [entry.monster] : []),
        ...(entry.items ?? []),
      ])
        if (!registry.content(id)) at(`"${id}" isn't loaded content`);
    }
  }

  // Battle maps and other pictures an encounter names, whatever the system calls the field.
  const adventure = registry.adventure(plugin);
  const named = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("assets/"))
      named.add(value);
    else if (value && typeof value === "object")
      for (const item of Object.values(value)) collect(item);
  };
  collect(adventure?.encounters);
  for (const scene of adventure?.scenes ?? []) {
    if (scene.art && !IMAGE_FILE.test(scene.art))
      report(scene.art, `scene ${scene.id}: isn't a picture`);
  }
  for (const path of named)
    if (!files.has(path))
      report(path, "an encounter names this picture, which isn't there");

  if (record.manifest.distribution !== "shipped") return issues;
  const media = record.files.filter(
    (file) =>
      file.startsWith("assets/") && file !== ART_INDEX && file !== CREDITS,
  );
  if (media.length === 0) return issues;
  const credits = files.has(CREDITS)
    ? CreditsSchema.safeParse(await readJson(CREDITS))
    : null;
  if (credits && !credits.success) {
    const problem = credits.error.issues[0];
    report(
      CREDITS,
      `${problem?.path.join(".") ?? ""}: ${problem?.message ?? "invalid"}`,
    );
  }
  const credited = new Set(
    (credits?.data ?? []).map((item) => `assets/${item.file}`),
  );
  for (const file of media)
    if (!credited.has(file))
      report(file, `shipped with no entry in ${CREDITS}`);
  for (const file of credited)
    if (!files.has(file)) report(CREDITS, `credits ${file}, which isn't there`);
  return issues;
}
