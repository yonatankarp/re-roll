// The narration model's files in IndexedDB, with the Cache API's match and put, for webviews where
// that API is missing or refused. A database of its own, so it never touches the browser saves
// (engine/platform/browser/indexeddb.ts, which the shell may not import). Each call waits for its
// transaction to complete.
export async function openModelCache(factory: IDBFactory): Promise<{
  readonly match: (key: string) => Promise<Response | undefined>;
  readonly put: (key: string, response: Response) => Promise<void>;
}> {
  const database = await new Promise<IDBDatabase>((done, fail) => {
    const request = factory.open("re-roll-models", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
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
      const transaction = database.transaction("files", mode);
      const request = act(transaction.objectStore("files"));
      transaction.oncomplete = () => {
        done(request.result);
      };
      transaction.onerror = transaction.onabort = () => {
        fail(transaction.error ?? new Error("IndexedDB transaction failed"));
      };
    });
  return {
    match: async (key) => {
      const bytes = (await run("readonly", (files) => files.get(key))) as
        ArrayBuffer | undefined;
      return bytes
        ? new Response(bytes, {
            headers: { "Content-Length": String(bytes.byteLength) },
          })
        : undefined;
    },
    put: async (key, response) => {
      try {
        const bytes = await response.arrayBuffer();
        await run("readwrite", (files) => files.put(bytes, key));
      } catch (error) {
        // Say, out of quota: this launch still reads, and the next one downloads again.
        console.warn(`Couldn't keep ${key}: ${String(error)}`);
      }
    },
  };
}
