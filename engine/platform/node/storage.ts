import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Storage, StorageEntry } from "../../kernel/storage.ts";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export async function createNodeStorage(
  rootPath: string,
): Promise<Storage & { readBytes(path: string): Promise<Buffer | null> }> {
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
        await writeFile(temporary, contents, "utf8");
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
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
