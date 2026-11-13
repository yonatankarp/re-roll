import type { Storage, StorageEntry } from "../../kernel/storage.ts";

// The route is repeated from platform/node/content-endpoint.ts, which browser code can't import.
const CONTENT_ROUTE = "/__content";
export const SAVES = "saves/";

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

// A book loads thousands of files at once, and a browser refuses that many requests in flight
// (ERR_INSUFFICIENT_RESOURCES), so reads wait their turn.
export const READS_IN_FLIGHT = 16;

// Runs at most max tasks at once; a task that finishes hands its slot to the next one waiting.
export function limiter(
  max: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active += 1;
    else await new Promise<void>((go) => waiting.push(go));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

// baseUrl is only set by tests, which have no page to be relative to.
export function createContentReader(baseUrl = ""): ContentReader {
  const limit = limiter(READS_IN_FLIGHT);
  const query = (action: string, path: string) =>
    fetch(
      `${baseUrl}${CONTENT_ROUTE}/${action}?path=${encodeURIComponent(path)}`,
    );
  const refuse = (path: string, status: number): Error =>
    new Error(`Couldn't read ${path} (${String(status)})`);
  // The body is read inside the slot too, since an unread response still holds its connection.
  return {
    read: (path) =>
      limit(async () => {
        const response = await query("read", path);
        if (response.status === 404) return null;
        if (!response.ok) throw refuse(path, response.status);
        return response.text();
      }),
    list: (prefix) =>
      limit(async () => {
        const response = await query("list", prefix);
        if (!response.ok) throw refuse(prefix, response.status);
        return (await response.json()) as readonly StorageEntry[];
      }),
  };
}

// Where saves are kept: IndexedDB in a browser, files in the desktop app.
// Paths are whole, such as "saves/x.json".
export interface SaveFiles {
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  list(): Promise<readonly string[]>;
  remove(path: string): Promise<void>;
}

// shortcut: about 5 MB, so only a browser without IndexedDB keeps its saves here.
export function storeFiles(store: SaveStore): SaveFiles {
  return {
    read: (path) => Promise.resolve(store.getItem(path)),
    write: (path, contents) => {
      try {
        store.setItem(path, contents);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    list: () => {
      const paths: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const path = store.key(index);
        if (path?.startsWith(SAVES)) paths.push(path);
      }
      return Promise.resolve(paths);
    },
    remove: (path) => {
      store.removeItem(path);
      return Promise.resolve();
    },
  };
}

// Content is read-only, so saves are kept apart and nothing can write to the content folders.
export function withSaveFiles(
  content: ContentReader,
  saves: SaveFiles,
): Storage & { remove(path: string): Promise<void> } {
  const refuse = (path: string) =>
    Promise.reject(new Error(`${path} is read-only`));
  return {
    remove: (path) =>
      path.startsWith(SAVES) ? saves.remove(path) : refuse(path),
    read: (path) =>
      path.startsWith(SAVES) ? saves.read(path) : content.read(path),
    replaceAtomically: (path, contents) =>
      path.startsWith(SAVES) ? saves.write(path, contents) : refuse(path),
    list: async (prefix) =>
      `${prefix}/`.startsWith(SAVES)
        ? (await saves.list()).map((path) => ({ path, symlink: false }))
        : content.list(prefix),
  };
}

export function withSaves(
  content: ContentReader,
  saves: SaveStore,
): Storage & { remove(path: string): Promise<void> } {
  return withSaveFiles(content, storeFiles(saves));
}

// Kept with the saves, not in localStorage, which may be too full to take it. Not a .json file,
// so the save list and pruning pass it by.
const MOVED = `${SAVES}moved-from-localstorage`;

// Saves were kept in localStorage before the desktop app had a saves folder and the browser had
// IndexedDB. They are copied over once, never over a newer copy, and the originals stay as a backup.
export async function moveSavesToFiles(
  from: SaveStore,
  to: SaveFiles,
): Promise<number> {
  if ((await to.read(MOVED)) !== null) return 0;
  const existing = new Set(await to.list());
  let moved = 0;
  for (const path of await storeFiles(from).list()) {
    const contents = from.getItem(path);
    if (contents === null || existing.has(path)) continue;
    await to.write(path, contents);
    moved += 1;
  }
  await to.write(MOVED, new Date().toISOString());
  return moved;
}
