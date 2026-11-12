import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Storage, StorageEntry } from "../../kernel/storage.ts";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export type NodeStorage = Storage & {
  readBytes(path: string): Promise<Buffer | null>;
  remove(path: string): Promise<void>;
};

export async function createNodeStorage(
  rootPath: string,
): Promise<NodeStorage> {
  const root = await realpath(rootPath);

  const locate = (path: string): string => {
    const target = resolve(root, path);
    if (!isInside(root, target))
      throw new Error(`path escapes storage root: ${path}`);
    return target;
  };

  // Lexical checks can't see symlinks, so anything that exists is also checked by its real path.
  const assertRealPathInside = async (
    target: string,
    path: string,
  ): Promise<void> => {
    if (!isInside(root, await realpath(target)))
      throw new Error(`path escapes storage root: ${path}`);
  };

  return {
    async read(path) {
      const target = locate(path);
      try {
        await assertRealPathInside(target, path);
        return await readFile(target, "utf8");
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    // For images, which the text read would corrupt.
    async readBytes(path) {
      const target = locate(path);
      try {
        await assertRealPathInside(target, path);
        return await readFile(target);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async replaceAtomically(path, contents) {
      const target = locate(path);
      const folder = dirname(target);
      await mkdir(folder, { recursive: true });
      await assertRealPathInside(folder, path);
      const temporary = join(folder, `.${randomUUID()}.tmp`);
      try {
        // Flushed before the rename, so a power cut leaves the old file or the new one, never an empty one.
        const file = await open(temporary, "w");
        try {
          await file.writeFile(contents, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async remove(path) {
      const target = locate(path);
      try {
        await assertRealPathInside(target, path);
        await rm(target);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },

    async list(prefix) {
      const start = locate(prefix);
      const found: StorageEntry[] = [];

      const walk = async (folder: string): Promise<void> => {
        for (const item of await readdir(folder, { withFileTypes: true })) {
          const full = join(folder, item.name);
          const path = relative(root, full).split(sep).join("/");
          // Symlinks are reported rather than followed, so a link can't pull in outside files.
          if (item.isSymbolicLink()) found.push({ path, symlink: true });
          else if (item.isDirectory()) await walk(full);
          else if (item.isFile()) found.push({ path, symlink: false });
        }
      };

      try {
        if ((await lstat(start)).isSymbolicLink())
          return [{ path: prefix, symlink: true }];
        await walk(start);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}

const SAVES = "saves";
const PRIVATE = "books";

function under(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

// For playing from Node: content is read-only, saves live in their own folder, and a symlinked books/
// (such as a worktree's link to the main checkout) is read through its real folder.
export async function createPlayStorage(
  contentRoot: string,
  savesRoot: string,
): Promise<Storage & { remove(path: string): Promise<void> }> {
  const content = await createNodeStorage(contentRoot);
  await mkdir(savesRoot, { recursive: true });
  // The saves folder's parent, so paths keep their saves/ prefix.
  await mkdir(join(savesRoot, SAVES), { recursive: true });
  const saves = await createNodeStorage(savesRoot);
  const privateDir = await realpath(join(contentRoot, PRIVATE)).catch(
    () => null,
  );
  // shortcut: assumes the link's target is itself named books, as in the main checkout; map paths if that changes.
  const owner = privateDir
    ? await createNodeStorage(dirname(privateDir))
    : content;
  const source = (path: string) =>
    under(SAVES, path) ? saves : under(PRIVATE, path) ? owner : content;
  const readOnly = (path: string) =>
    Promise.reject(new Error(`${path} is read-only`));
  return {
    read: (path) => source(path).read(path),
    list: (prefix) => source(prefix).list(prefix),
    replaceAtomically: (path, contents) =>
      under(SAVES, path)
        ? saves.replaceAtomically(path, contents)
        : readOnly(path),
    remove: (path) =>
      under(SAVES, path) ? saves.remove(path) : readOnly(path),
  };
}
