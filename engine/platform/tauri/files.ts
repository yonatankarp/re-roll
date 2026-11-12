// The parts of the Tauri reader that don't need Tauri, so tests can run them in Node.

// The fs plugin reports a missing file as the OS's error: 2 everywhere, or 3 for a missing folder on Windows.
// Anything else, such as a path outside the scope, is a real failure and still throws.
export function isNotFound(error: unknown): boolean {
  return /\(os error [23]\)/.test(String(error));
}

// The newest images as blob URLs, up to `budget` bytes of files. Older ones are revoked.
// A shown <img> keeps its picture after a revoke; only a fresh load of that URL would fail, and a fresh call gets a new one.
export function imageCache(
  budget: number,
): (
  path: string,
  load: () => Promise<Uint8Array<ArrayBuffer>>,
) => Promise<string | null> {
  const entries = new Map<
    string,
    { url: Promise<string | null>; size: number; done: boolean }
  >();
  let total = 0;

  // Oldest first, skipping the one just loaded and any still loading, whose callers are waiting for their URL.
  const trim = (keep: string): void => {
    for (const [path, entry] of entries) {
      if (total <= budget) return;
      if (path === keep || !entry.done) continue;
      entries.delete(path);
      total -= entry.size;
      void entry.url.then((url) => {
        if (url) URL.revokeObjectURL(url);
      });
    }
  };

  return (path, load) => {
    const hit = entries.get(path);
    if (hit) {
      entries.delete(path); // back to the newest end
      entries.set(path, hit);
      return hit.url;
    }
    const entry = {
      url: Promise.resolve<string | null>(null),
      size: 0,
      done: false,
    };
    entry.url = load()
      .then((bytes) => {
        entry.size = bytes.byteLength;
        total += entry.size;
        return URL.createObjectURL(new Blob([bytes]));
      })
      .catch(() => null)
      .finally(() => {
        entry.done = true;
        trim(path);
      });
    entries.set(path, entry);
    return entry.url;
  };
}
