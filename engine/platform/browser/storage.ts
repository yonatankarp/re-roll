import type { Storage, StorageEntry } from "../../kernel/storage.ts";

// The route is repeated from platform/node/content-endpoint.ts, which browser code can't import.
const CONTENT_ROUTE = "/__content";
const SAVES = "saves/";

export type ContentReader = Pick<Storage, "read" | "list">;

// The part of localStorage that saves need.
export interface SaveStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Goes straight into an <img>, which reports a missing file by failing to load.
export function contentImageUrl(path: string): string {
  return `${CONTENT_ROUTE}/image?path=${encodeURIComponent(path)}`;
}

// baseUrl is only set by tests, which have no page to be relative to.
export function createContentReader(baseUrl = ""): ContentReader {
  const query = (action: string, path: string) =>
    fetch(
      `${baseUrl}${CONTENT_ROUTE}/${action}?path=${encodeURIComponent(path)}`,
    );
  const refuse = (path: string, status: number): Error =>
    new Error(`Couldn't read ${path} (${String(status)})`);
  return {
    async read(path) {
      const response = await query("read", path);
      if (response.status === 404) return null;
      if (!response.ok) throw refuse(path, response.status);
      return response.text();
    },
    async list(prefix) {
      const response = await query("list", prefix);
      if (!response.ok) throw refuse(prefix, response.status);
      return (await response.json()) as readonly StorageEntry[];
    },
  };
}

// Content is read-only, so saves live in the webview's own store and nothing can write to the content folders.
// shortcut: about 5 MB and tied to this origin, move to real files once the app has a save folder (step 7).
export function withSaves(
  content: ContentReader,
  saves: SaveStore,
): Storage & { remove(path: string): Promise<void> } {
  return {
    remove: (path) => {
      if (!path.startsWith(SAVES)) {
        return Promise.reject(new Error(`${path} is read-only`));
      }
      saves.removeItem(path);
      return Promise.resolve();
    },
    read: (path) =>
      path.startsWith(SAVES)
        ? Promise.resolve(saves.getItem(path))
        : content.read(path),
    replaceAtomically: (path, contents) => {
      if (!path.startsWith(SAVES)) {
        return Promise.reject(new Error(`${path} is read-only`));
      }
      try {
        saves.setItem(path, contents);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    list: (prefix) => {
      if (!`${prefix}/`.startsWith(SAVES)) return content.list(prefix);
      const paths: StorageEntry[] = [];
      for (let index = 0; index < saves.length; index += 1) {
        const path = saves.key(index);
        if (path?.startsWith(SAVES)) paths.push({ path, symlink: false });
      }
      return Promise.resolve(paths);
    },
  };
}
