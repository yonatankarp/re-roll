import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readDir, readFile, readTextFile } from "@tauri-apps/plugin-fs";
import type { StorageEntry } from "../../kernel/storage.ts";
import { parseContentPath } from "../browser/content-path.ts";
import type { ContentReader } from "../browser/storage.ts";

const urls = new Map<string, Promise<string | null>>();
let rootPath: Promise<string> | undefined;
const root = (): Promise<string> =>
  (rootPath ??= invoke<string>("content_root"));

// The same allowlist as the dev route, checked here too so the fs scope isn't the only guard.
// join() uses the platform's separator, since Windows' canonical \\?\ root doesn't take "/".
async function fullPath(path: string): Promise<string> {
  if (!parseContentPath(path))
    throw new Error(`${path} is outside the content folders`);
  return join(await root(), ...path.split("/"));
}

// Kept for the life of the page, so a redraw reuses the same image.
export function tauriImageUrl(path: string): Promise<string | null> {
  let url = urls.get(path);
  if (!url) {
    url = fullPath(path)
      .then((full) => readFile(full))
      .then((bytes) => URL.createObjectURL(new Blob([bytes])))
      .catch(() => null);
    urls.set(path, url);
  }
  return url;
}

// Tauri's own file access. The app's scope (src-tauri/src/main.rs) limits it to plugins/ and the book folders the game reads.
export function createTauriReader(): ContentReader {
  const walk = async (folder: string, found: StorageEntry[]): Promise<void> => {
    for (const item of await readDir(await fullPath(folder))) {
      const path = `${folder}/${item.name}`;
      // Symlinks are reported rather than followed, matching the Node storage.
      if (item.isSymlink) found.push({ path, symlink: true });
      else if (item.isDirectory) await walk(path, found);
      else if (item.isFile) found.push({ path, symlink: false });
    }
  };

  return {
    async read(path) {
      const full = await fullPath(path);
      return (await exists(full)) ? readTextFile(full) : null;
    },
    async list(prefix) {
      if (!(await exists(await fullPath(prefix)))) return [];
      const found: StorageEntry[] = [];
      await walk(prefix, found);
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
