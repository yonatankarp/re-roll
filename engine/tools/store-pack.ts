import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Zippable, zipSync } from "fflate";
import { parse } from "yaml";
import { PluginManifestSchema } from "../kernel/manifest.ts";
import {
  PART_FOLDERS,
  SHARED_FILES,
  planInstall,
} from "../platform/tauri/install.ts";
import {
  STORE_MANIFEST,
  type StoreIndex,
  StoreManifestSchema,
  type StorePackage,
} from "../shell/store-index.ts";

// Packs a store repo's content into one zip per package and the store.json that lists them,
// from the store.yaml that says which content folders make each package.

// Already compressed, so deflating them again only costs time.
const STORED = /\.(png|jpe?g|webp|gif|mp3|ogg)$/i;
// A fixed time, so the same files always make the same zip and the same hash.
const MTIME = new Date("2000-01-01T00:00:00Z");

export interface PackedStore {
  readonly index: StoreIndex;
  readonly zips: ReadonlyMap<string, Uint8Array>;
  // Content folders no package holds, which the publisher may have forgotten.
  readonly unpacked: readonly string[];
}

// Every file under a folder, as paths relative to `root`, hidden names left out as the game leaves them.
async function filesUnder(root: string, path: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(join(root, path), {
    withFileTypes: true,
  })) {
    if (item.name.startsWith(".")) continue;
    const inside = `${path}/${item.name}`;
    if (item.isSymbolicLink())
      throw new Error(`${inside} is a symlink, which a package can't hold.`);
    if (item.isDirectory()) found.push(...(await filesUnder(root, inside)));
    else if (item.isFile()) found.push(inside);
  }
  return found.sort();
}

async function isFolder(path: string): Promise<boolean | null> {
  try {
    const kind = await lstat(path);
    if (kind.isSymbolicLink()) return null;
    return kind.isDirectory();
  } catch {
    return null;
  }
}

export async function packStore(root: string): Promise<PackedStore> {
  const manifest = StoreManifestSchema.parse(
    parse(await readFile(join(root, STORE_MANIFEST), "utf8")),
  );
  const ids = new Set<string>();
  const owner = new Map<string, string>(); // part → package
  for (const { id, parts } of manifest.packages) {
    if (ids.has(id)) throw new Error(`Two packages are called ${id}.`);
    ids.add(id);
    for (const part of parts) {
      const other = owner.get(part);
      if (other) throw new Error(`${part} is in both ${other} and ${id}.`);
      owner.set(part, id);
    }
  }

  const packages: StorePackage[] = [];
  const zips = new Map<string, Uint8Array>();
  for (const { id, title, parts } of manifest.packages) {
    const entries: Zippable = {};
    const plugins: StorePackage["plugins"] = [];
    for (const part of parts) {
      const folder = await isFolder(join(root, part));
      const shared = SHARED_FILES.has(part);
      if (folder === null || folder === shared)
        throw new Error(
          `${part}, in ${id}, isn't a ${shared ? "file" : "folder"} in ${root}.`,
        );
      for (const path of shared ? [part] : await filesUnder(root, part)) {
        entries[path] = [
          await readFile(join(root, path)),
          { level: STORED.test(path) ? 0 : 6, mtime: MTIME },
        ];
      }
      if (part.startsWith("adventures/") || part.startsWith("rules/")) {
        const plugin = PluginManifestSchema.parse(
          parse(await readFile(join(root, part, "plugin.yaml"), "utf8")),
        );
        plugins.push({
          id: plugin.id,
          kind: plugin.kind,
          version: plugin.version,
          distribution: plugin.distribution,
          requires: plugin.requires.map(({ plugin: needed }) => needed),
        });
      }
    }
    const zip = zipSync(entries);
    // The app's own check, so a package that packs is one the Store can install.
    try {
      planInstall(zip, new Map());
    } catch (error) {
      throw new Error(
        `${id} wouldn't install: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const file = `${id}.zip`;
    zips.set(file, zip);
    packages.push({
      id,
      title,
      file,
      size: zip.length,
      sha256: createHash("sha256").update(zip).digest("hex"),
      parts,
      plugins,
    });
  }

  const unpacked: string[] = [];
  for (const folder of PART_FOLDERS) {
    if (!(await isFolder(join(root, folder)))) continue;
    for (const item of await readdir(join(root, folder), {
      withFileTypes: true,
    })) {
      const part = `${folder}/${item.name}`;
      const content = item.isDirectory() || SHARED_FILES.has(part);
      if (!item.name.startsWith(".") && content && !owner.has(part))
        unpacked.push(part);
    }
  }
  return { index: { format: 1, packages }, zips, unpacked };
}
