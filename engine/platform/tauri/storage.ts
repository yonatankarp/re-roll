import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readDir, readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { imageCache, isNotFound } from "./files.ts";
import type { StorageEntry } from "../../kernel/storage.ts";
import { parseContentPath } from "../browser/content-path.ts";
import type { ContentReader } from "../browser/storage.ts";

// Where "plugins" and "books" are on disk, set by src-tauri/src/main.rs. A built app's "books" is the player's content folder.
let rootPaths: Promise<Readonly<Record<string, string>>> | undefined;
const roots = (): Promise<Readonly<Record<string, string>>> =>
  (rootPaths ??= invoke("content_roots"));

// The same allowlist as the dev route, checked here too so the fs scope isn't the only guard.
// join() uses the platform's separator, since Windows' canonical \\?\ root doesn't take "/".
async function fullPath(path: string): Promise<string> {
  const content = parseContentPath(path);
  if (!content) throw new Error(`${path} is outside the content folders`);
  const root = (await roots())[content.folder];
  if (root === undefined) throw new Error(`${path} has no folder on disk`);
  return join(root, ...(content.rest ? content.rest.split("/") : []));
}

// Shows the player's content folder in the OS's file manager.
export function openContentFolder(): Promise<void> {
  return invoke("open_content_folder");
}

// Scene art runs to 20 MB a picture, so only the newest pictures are kept, and a redraw reuses them.
const images = imageCache(256 * 1024 * 1024);
export function tauriImageUrl(path: string): Promise<string | null> {
  return images(path, async () => readFile(await fullPath(path)));
}

// Tauri's own file access. The app's scope (src-tauri/src/main.rs) limits it to plugins/ and the book folders the game reads.
export function createTauriReader(): ContentReader {
  const walk = async (folder: string, found: StorageEntry[]): Promise<void> => {
    for (const item of await readDir(await fullPath(folder))) {
      if (item.name.startsWith(".")) continue; // never content, as in the dev route
      const path = `${folder}/${item.name}`;
      // Symlinks are reported rather than followed, matching the Node storage.
      if (item.isSymlink) found.push({ path, symlink: true });
      else if (item.isDirectory) await walk(path, found);
      else if (item.isFile) found.push({ path, symlink: false });
    }
  };

  return {
    async read(path) {
      // One call rather than exists() and a read, as opening an adventure reads thousands of files.
      try {
        return await readTextFile(await fullPath(path));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async list(prefix) {
      if (!(await exists(await fullPath(prefix)))) return [];
      const found: StorageEntry[] = [];
      await walk(prefix, found);
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
