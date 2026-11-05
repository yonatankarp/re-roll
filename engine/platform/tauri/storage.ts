import { invoke } from "@tauri-apps/api/core";
import { exists, readDir, readFile, readTextFile } from "@tauri-apps/plugin-fs";
import type { StorageEntry } from "../../kernel/storage.ts";
import type { ContentReader } from "../browser/storage.ts";

const urls = new Map<string, Promise<string | null>>();

// Kept for the life of the page, so a redraw reuses the same image.
export function tauriImageUrl(path: string): Promise<string | null> {
  let url = urls.get(path);
  if (!url) {
    url = invoke<string>("content_root")
      .then((root) => readFile(`${root}/${path}`))
      .then((bytes) => URL.createObjectURL(new Blob([bytes])))
      .catch(() => null);
    urls.set(path, url);
  }
  return url;
}

// Tauri's own file access. The app's scope (src-tauri/src/main.rs) limits it to plugins/ and private/.
export function createTauriReader(): ContentReader {
  const root = invoke<string>("content_root");

  const walk = async (
    base: string,
    folder: string,
    found: StorageEntry[],
  ): Promise<void> => {
    for (const item of await readDir(`${base}/${folder}`)) {
      const path = `${folder}/${item.name}`;
      // Symlinks are reported rather than followed, matching the Node storage.
      if (item.isSymlink) found.push({ path, symlink: true });
      else if (item.isDirectory) await walk(base, path, found);
      else if (item.isFile) found.push({ path, symlink: false });
    }
  };

  return {
    async read(path) {
      const full = `${await root}/${path}`;
      return (await exists(full)) ? readTextFile(full) : null;
    },
    async list(prefix) {
      const base = await root;
      if (!(await exists(`${base}/${prefix}`))) return [];
      const found: StorageEntry[] = [];
      await walk(base, prefix, found);
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
