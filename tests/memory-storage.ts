import type { Storage } from "../engine/kernel/storage.ts";

export function memoryStorage(
  files: Readonly<Record<string, string>>,
  symlinks: readonly string[] = [],
): Storage {
  const contents = new Map(Object.entries(files));
  return {
    read: (path) => Promise.resolve(contents.get(path) ?? null),
    replaceAtomically: (path, text) => {
      contents.set(path, text);
      return Promise.resolve();
    },
    list: (prefix) => {
      const regular = [...contents.keys()].map((path) => ({
        path,
        symlink: false,
      }));
      const linked = symlinks.map((path) => ({ path, symlink: true }));
      return Promise.resolve(
        [...regular, ...linked].filter((entry) =>
          entry.path.startsWith(`${prefix}/`),
        ),
      );
    },
  };
}
