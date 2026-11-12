import { SAVES, type SaveFiles } from "./storage.ts";

const DATABASE = "re-roll";
const FILES = "files";

// IndexedDB holds far more than localStorage's 5 MB. Each call waits for its transaction to
// complete, so a write has landed before it resolves.
export async function openIndexedDbFiles(
  factory: IDBFactory = indexedDB,
): Promise<SaveFiles> {
  const database = await new Promise<IDBDatabase>((done, fail) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FILES);
    request.onsuccess = () => {
      done(request.result);
    };
    request.onerror = () => {
      fail(request.error ?? new Error("Couldn't open IndexedDB"));
    };
  });
  const run = <T>(
    mode: IDBTransactionMode,
    act: (files: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    new Promise((done, fail) => {
      const transaction = database.transaction(FILES, mode);
      const request = act(transaction.objectStore(FILES));
      transaction.oncomplete = () => {
        done(request.result);
      };
      transaction.onerror = transaction.onabort = () => {
        fail(transaction.error ?? new Error("IndexedDB transaction failed"));
      };
    });
  return {
    read: async (path) =>
      ((await run("readonly", (files) => files.get(path))) as
        string | undefined) ?? null,
    write: async (path, contents) => {
      await run("readwrite", (files) => files.put(contents, path));
    },
    list: async () =>
      (await run("readonly", (files) => files.getAllKeys()))
        .map(String)
        .filter((path) => path.startsWith(SAVES)),
    remove: async (path) => {
      await run("readwrite", (files) => files.delete(path));
    },
  };
}
