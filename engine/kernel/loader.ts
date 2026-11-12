import { parse } from "yaml";
import {
  type Adventure,
  STORY_FILES,
  type StoryFile,
  validateAdventure,
} from "../story/adventure.ts";
import { NARRATION_FOLDER } from "../story/narration.ts";
import { hashText } from "./dice.ts";
import { type Issue, zodIssues } from "./issues.ts";
import { type PluginManifest, PluginManifestSchema } from "./manifest.ts";
import { satisfiesCaret } from "./semver.ts";
import type { Storage } from "./storage.ts";
import {
  type ContentEntry,
  type ContentKind,
  type GameSystem,
  SDK_VERSION,
} from "./system.ts";

// An allowlist, because a denylist would miss formats such as .mjs, .wasm or a script-bearing .svg.
const ALLOWED_EXTENSIONS = new Set([
  ".yaml",
  ".md",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp3",
  ".ogg",
  ".wav",
]);

const KIND_FOLDERS = [
  { folder: "rules", kind: "rules" },
  { folder: "adventures", kind: "adventure" },
] as const;

const MANIFEST = "plugin.yaml";
const YAML = ".yaml";

export interface PluginRecord {
  readonly manifest: PluginManifest;
  readonly root: string;
  readonly files: readonly string[]; // relative to root
}

export interface Catalog {
  readonly plugins: ReadonlyMap<string, PluginRecord>;
  readonly issues: readonly Issue[];
}

export interface Registry {
  readonly system: GameSystem;
  readonly plugins: readonly PluginManifest[]; // in load order
  readonly precedence: readonly string[]; // plugin ids, the one whose entries win first
  readonly contentIds: () => readonly string[]; // in precedence order, then by id
  readonly pluginHash: (pluginId: string) => string | undefined;
  readonly content: (id: string) => ContentEntry | undefined; // follows replacements
  readonly adventure: (pluginId: string) => Adventure | undefined;
}

export type LoadResult =
  | { readonly ok: true; readonly registry: Registry }
  | { readonly ok: false; readonly issues: readonly Issue[] };

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

async function readYaml(
  storage: Pick<Storage, "read">,
  path: string,
  plugin: string,
  issues: Issue[],
): Promise<{ readonly found: boolean; readonly value: unknown }> {
  try {
    const text = await storage.read(path);
    if (text === null) return { found: false, value: undefined };
    const value: unknown = parse(text);
    return { found: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ plugin, file: path, message: `cannot read: ${message}` });
    return { found: true, value: undefined };
  }
}

export async function scanPlugins(
  storage: Storage,
  roots: readonly string[],
): Promise<Catalog> {
  const plugins = new Map<string, PluginRecord>();
  const issues: Issue[] = [];

  for (const base of roots) {
    for (const { folder, kind } of KIND_FOLDERS) {
      const prefix = `${base}/${folder}`;
      const groups = new Map<string, string[]>();

      for (const entry of await storage.list(prefix)) {
        // macOS Finder adds these to any folder you open, and they are never read.
        if (!entry.symlink && entry.path.endsWith("/.DS_Store")) continue;
        const relative = entry.path.slice(prefix.length + 1);
        const slash = relative.indexOf("/");
        const name = slash === -1 ? relative : relative.slice(0, slash);
        if (slash === -1) {
          const problem = entry.symlink
            ? "symlinks are not allowed"
            : "stray file outside a plugin";
          issues.push({ plugin: name, file: entry.path, message: problem });
          continue;
        }
        const inside = relative.slice(slash + 1);
        if (entry.symlink) {
          issues.push({
            plugin: name,
            file: entry.path,
            message: "symlinks are not allowed",
          });
        } else if (!ALLOWED_EXTENSIONS.has(extensionOf(inside))) {
          // Data plugins never carry code, so nothing in one can run on the player's machine.
          issues.push({
            plugin: name,
            file: entry.path,
            message: "file type is not allowed",
          });
        }
        groups.set(name, [...(groups.get(name) ?? []), inside]);
      }

      for (const [name, files] of groups) {
        const root = `${prefix}/${name}`;
        const manifestPath = `${root}/${MANIFEST}`;
        const raw = await readYaml(storage, manifestPath, name, issues);
        if (!raw.found) {
          issues.push({
            plugin: name,
            file: manifestPath,
            message: "missing plugin.yaml",
          });
          continue;
        }
        const manifest = PluginManifestSchema.safeParse(raw.value);
        if (!manifest.success) {
          issues.push(...zodIssues(name, manifestPath, manifest.error));
          continue;
        }
        if (manifest.data.id !== name) {
          const message = `manifest id "${manifest.data.id}" must match its folder name`;
          issues.push({ plugin: name, file: manifestPath, message });
          continue;
        }
        if (manifest.data.kind !== kind) {
          const message = `kind "${manifest.data.kind}" does not belong in ${folder}/`;
          issues.push({ plugin: name, file: manifestPath, message });
          continue;
        }
        const existing = plugins.get(name);
        if (existing) {
          const message = `duplicate plugin id, also at ${existing.root}`;
          issues.push({ plugin: name, file: manifestPath, message });
          continue;
        }
        plugins.set(name, { manifest: manifest.data, root, files });
      }
    }
  }
  return { plugins, issues };
}

function resolveOrder(
  catalog: Catalog,
  requested: readonly string[],
  issues: Issue[],
): PluginRecord[] {
  const order: PluginRecord[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string, from: string): void => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") {
      issues.push({
        plugin: id,
        file: null,
        message: `dependency cycle through "${from}"`,
      });
      return;
    }
    const record = catalog.plugins.get(id);
    if (!record) {
      issues.push({
        plugin: from,
        file: null,
        message: `missing plugin "${id}"`,
      });
      return;
    }
    state.set(id, "visiting");
    const dependencies = [...record.manifest.requires].sort((a, b) =>
      a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0,
    );
    for (const { plugin, version } of dependencies) {
      const dependency = catalog.plugins.get(plugin);
      if (dependency && !satisfiesCaret(dependency.manifest.version, version)) {
        const message = `needs "${plugin}" ${version}, found ${dependency.manifest.version}`;
        issues.push({ plugin: id, file: null, message });
      }
      visit(plugin, id);
    }
    state.set(id, "done");
    order.push(record);
  };

  for (const id of [...requested].sort()) visit(id, id);
  return order;
}

function resolveSystem(
  order: readonly PluginRecord[],
  systems: readonly GameSystem[],
  issues: Issue[],
): GameSystem | null {
  const used = new Set(order.map((record) => record.manifest.system.id));
  if (used.size !== 1) {
    if (used.size > 1) {
      const message = `a run uses one system, found: ${[...used].sort().join(", ")}`;
      issues.push({
        plugin: order[0]?.manifest.id ?? "run",
        file: null,
        message,
      });
    }
    return null;
  }

  const [systemId] = used;
  const system = systems.find((candidate) => candidate.id === systemId);
  for (const { manifest } of order) {
    if (!system) {
      issues.push({
        plugin: manifest.id,
        file: null,
        message: `unknown system "${manifest.system.id}"`,
      });
      continue;
    }
    if (!satisfiesCaret(system.version, manifest.system.range)) {
      const message = `needs system ${manifest.system.id} ${manifest.system.range}, found ${system.version}`;
      issues.push({ plugin: manifest.id, file: null, message });
    }
    if (!satisfiesCaret(SDK_VERSION, manifest.sdk)) {
      const message = `needs SDK ${manifest.sdk}, found ${SDK_VERSION}`;
      issues.push({ plugin: manifest.id, file: null, message });
    }
  }
  return system ?? null;
}

function dependencyClosure(catalog: Catalog, id: string): Set<string> {
  const closure = new Set<string>();
  const queue = [id];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (closure.has(next)) continue;
    closure.add(next);
    queue.push(
      ...(catalog.plugins
        .get(next)
        ?.manifest.requires.map((item) => item.plugin) ?? []),
    );
  }
  return closure;
}

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

// The adventure being played comes first, then the plugins its manifest lists, then the rest by the system's rank and id.
function precedenceOrder(
  order: readonly PluginRecord[],
  requested: readonly string[],
  system: GameSystem,
  issues: Issue[],
): string[] {
  const loaded = new Map(order.map(({ manifest }) => [manifest.id, manifest]));
  for (const manifest of loaded.values()) {
    if (manifest.precedence && manifest.kind !== "adventure") {
      const message = "only an adventure can set precedence";
      issues.push({ plugin: manifest.id, file: null, message });
    }
  }
  const adventures = [...requested]
    .sort()
    .flatMap((id) => loaded.get(id) ?? [])
    .filter((manifest) => manifest.kind === "adventure");
  const first = adventures.map((manifest) => manifest.id);
  for (const adventure of adventures) {
    for (const id of adventure.precedence ?? []) {
      if (loaded.has(id)) first.push(id);
      else {
        const message = `precedence names "${id}", which this run doesn't load`;
        issues.push({ plugin: adventure.id, file: null, message });
      }
    }
  }
  const rank = (manifest: PluginManifest): number =>
    system.precedence?.(manifest) ?? 0;
  const rest = [...loaded.values()]
    .filter((manifest) => !first.includes(manifest.id))
    .sort((a, b) => rank(a) - rank(b) || compareText(a.id, b.id));
  return [...new Set(first), ...rest.map((manifest) => manifest.id)];
}

const ownerOf = (id: string): string => id.slice(0, id.indexOf(":"));
const kindPrefixOf = (id: string): string =>
  id.slice(id.indexOf(":") + 1, id.indexOf("/"));

interface LoadedEntry {
  readonly entry: ContentEntry;
  readonly owner: string;
  readonly file: string;
  readonly references: readonly string[];
}

async function parseContentFile(
  storage: Pick<Storage, "read">,
  record: PluginRecord,
  file: string,
  kind: ContentKind,
  entries: Map<string, LoadedEntry>,
  issues: Issue[],
): Promise<void> {
  const plugin = record.manifest.id;
  const path = `${record.root}/${file}`;
  const raw = await readYaml(storage, path, plugin, issues);
  if (!Array.isArray(raw.value)) {
    if (raw.value !== undefined)
      issues.push({ plugin, file: path, message: "must be a list" });
    return;
  }
  (raw.value as unknown[]).forEach((item, index) => {
    const parsed = kind.parse(item);
    if (!parsed.ok) {
      issues.push(...zodIssues(plugin, path, parsed.error, String(index)));
      return;
    }
    const { entry, references } = parsed;
    const expected = `${plugin}:${kind.idPrefix}/`;
    if (!entry.id.startsWith(expected)) {
      issues.push({
        plugin,
        file: path,
        message: `id "${entry.id}" must start with "${expected}"`,
      });
      return;
    }
    if (entries.has(entry.id)) {
      issues.push({
        plugin,
        file: path,
        message: `duplicate id "${entry.id}"`,
      });
      return;
    }
    entries.set(entry.id, { entry, owner: plugin, file: path, references });
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export async function loadRun(
  storage: Storage,
  catalog: Catalog,
  systems: readonly GameSystem[],
  requested: readonly string[],
): Promise<LoadResult> {
  const issues: Issue[] = [];
  const order = resolveOrder(catalog, requested, issues);
  const selected = new Set(order.map((record) => record.manifest.id));
  issues.push(...catalog.issues.filter((issue) => selected.has(issue.plugin)));

  const system = resolveSystem(order, systems, issues);
  if (!system) return { ok: false, issues };
  const precedence = precedenceOrder(order, requested, system, issues);

  const entries = new Map<string, LoadedEntry>();
  const adventures = new Map<string, Adventure>();
  const adventureReferences: { readonly owner: string; readonly id: string }[] =
    [];
  // Each file is read once, for both loading and the hash.
  const texts = new Map<string, Promise<string | null>>();
  const reader = {
    read: (path: string) => texts.get(path) ?? storage.read(path),
  };
  const hashed = (file: string): boolean =>
    // Narration's index changes as clips are made, which doesn't change the story.
    extensionOf(file) === YAML && !file.startsWith(`${NARRATION_FOLDER}/`);

  for (const record of order) {
    const plugin = record.manifest.id;
    // A plugin's files are read all at once and then used in order, so issues keep their order.
    for (const file of record.files.filter(hashed)) {
      const text = storage.read(`${record.root}/${file}`);
      text.catch(() => undefined); // a failed read is reported where the file is used
      texts.set(`${record.root}/${file}`, text);
    }
    const documents = new Map<StoryFile, unknown>();
    const assetPaths = new Set(
      record.files.filter((file) => file.startsWith("assets/")),
    );
    const isAdventure = record.manifest.kind === "adventure";

    for (const file of record.files) {
      const slash = file.indexOf("/");
      const folder = slash === -1 ? null : file.slice(0, slash);

      if (folder === null) {
        if (file === MANIFEST || extensionOf(file) !== YAML) continue;
        const story = STORY_FILES.find((name) => `${name}${YAML}` === file);
        if (!isAdventure || !story) {
          issues.push({
            plugin,
            file: `${record.root}/${file}`,
            message: "unknown file",
          });
          continue;
        }
        const raw = await readYaml(
          reader,
          `${record.root}/${file}`,
          plugin,
          issues,
        );
        documents.set(story, raw.value);
        continue;
      }

      // Pictures, and read-aloud clips made by npm run narrate, aren't story content.
      if (isAdventure && (folder === "assets" || folder === NARRATION_FOLDER)) {
        continue;
      }

      const kind = system.contentKinds[folder];
      if (!kind) {
        const message = `unknown content folder "${folder}" for system ${system.id}`;
        issues.push({ plugin, file: `${record.root}/${file}`, message });
        continue;
      }
      if (extensionOf(file) !== YAML) {
        const message = "content files must be .yaml";
        issues.push({ plugin, file: `${record.root}/${file}`, message });
        continue;
      }
      await parseContentFile(reader, record, file, kind, entries, issues);
    }

    if (isAdventure) {
      const result = validateAdventure({
        pluginId: plugin,
        system,
        documents,
        fileName: (name) => `${record.root}/${name}${YAML}`,
        assetPaths,
      });
      issues.push(...result.issues);
      if (result.adventure) adventures.set(plugin, result.adventure);
      for (const id of result.contentReferences)
        adventureReferences.push({ owner: plugin, id });
    }
  }

  const closures = new Map(
    [...selected].map((id) => [id, dependencyClosure(catalog, id)]),
  );
  const canSee = (owner: string, id: string): boolean =>
    closures.get(owner)?.has(ownerOf(id)) ?? false;

  const aliases = new Map<string, string>();
  for (const { entry, owner, file } of entries.values()) {
    const target = entry.replaces;
    if (target === undefined) continue;
    const report = (message: string): void => {
      issues.push({ plugin: owner, file, message: `${entry.id}: ${message}` });
    };
    if (!entries.has(target)) report(`replaces unknown entry "${target}"`);
    else if (!canSee(owner, target))
      report(`replaces "${target}" without requiring its plugin`);
    else if (kindPrefixOf(target) !== kindPrefixOf(entry.id))
      report(`replaces a different kind`);
    // shortcut: two plugins replacing one entry is an error, allow it if real books need load-order wins.
    else if (aliases.has(target))
      report(
        `"${target}" is already replaced by "${String(aliases.get(target))}"`,
      );
    else aliases.set(target, entry.id);
  }

  const resolve = (id: string): string | null => {
    const seen = new Set<string>();
    let current = id;
    for (
      let next = aliases.get(current);
      next !== undefined;
      next = aliases.get(current)
    ) {
      if (seen.has(current)) return null;
      seen.add(current);
      current = next;
    }
    return current;
  };

  const checkReference = (
    owner: string,
    file: string | null,
    id: string,
  ): void => {
    const resolved = resolve(id);
    if (resolved === null) {
      issues.push({
        plugin: owner,
        file,
        message: `replacement cycle through "${id}"`,
      });
    } else if (!entries.has(resolved)) {
      issues.push({
        plugin: owner,
        file,
        message: `unknown reference "${id}"`,
      });
    } else if (!canSee(owner, id)) {
      issues.push({
        plugin: owner,
        file,
        message: `reference "${id}" needs its plugin in requires`,
      });
    }
  };

  for (const { entry, owner, file, references } of entries.values()) {
    if (aliases.has(entry.id)) continue;
    if (entry.replaces !== undefined && resolve(entry.replaces) === null) {
      issues.push({
        plugin: owner,
        file,
        message: `replacement cycle through "${entry.id}"`,
      });
    }
    for (const id of references) checkReference(owner, file, id);
  }
  for (const { owner, id } of adventureReferences)
    checkReference(owner, null, id);

  if (issues.length > 0) return { ok: false, issues };

  // shortcut: only YAML is hashed, so a changed image won't warn. Hash assets if art ever affects saves.
  const hashes = new Map<string, string>();
  for (const record of order) {
    const parts: string[] = [];
    for (const file of [...record.files].sort()) {
      if (!hashed(file)) continue;
      parts.push(file, (await reader.read(`${record.root}/${file}`)) ?? "");
    }
    hashes.set(record.manifest.id, hashText(parts.join("\0")));
  }

  const content = new Map<string, ContentEntry>();
  for (const [id, { entry }] of entries) {
    if (!aliases.has(id)) content.set(id, deepFreeze(entry));
  }
  for (const adventure of adventures.values()) deepFreeze(adventure);
  const rankOf = new Map(precedence.map((id, index) => [id, index]));
  const rank = (id: string): number =>
    rankOf.get(ownerOf(id)) ?? precedence.length;
  const ids = Object.freeze(
    [...content.keys()].sort((a, b) => rank(a) - rank(b) || compareText(a, b)),
  );

  return {
    ok: true,
    registry: Object.freeze({
      system,
      plugins: Object.freeze(order.map((record) => record.manifest)),
      precedence: Object.freeze(precedence),
      contentIds: () => ids,
      pluginHash: (pluginId: string) => hashes.get(pluginId),
      content: (id: string) => {
        const resolved = resolve(id);
        return resolved === null ? undefined : content.get(resolved);
      },
      adventure: (pluginId: string) => adventures.get(pluginId),
    }),
  };
}
