import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

// What the desktop build must never ship: content from the owner's books, which isn't redistributable.
// Tauri copies bundle.resources as they are and follows symlinks, so a link is refused rather than followed.
// private is the old name of books/, kept as a guard.
const PRIVATE_FOLDERS = new Set(["books", "private"]);

// Every reason the resources in a tauri.conf.json can't be bundled, or none.
export async function bundleProblems(confPath: string): Promise<string[]> {
  const conf = JSON.parse(await readFile(confPath, "utf8")) as {
    bundle?: { resources?: readonly string[] | Record<string, string> };
  };
  const resources = conf.bundle?.resources ?? [];
  const sources = Array.isArray(resources)
    ? (resources as readonly string[])
    : Object.keys(resources);
  const problems: string[] = [];

  // `shown` is the path as written in the config, so the private-folder test can't trip on where the repo sits.
  const visit = async (path: string, shown: string): Promise<void> => {
    if (shown.split(/[\\/]/).some((part) => PRIVATE_FOLDERS.has(part))) {
      problems.push(`${shown} is in a private folder`);
      return;
    }
    const info = await lstat(path).catch(() => null);
    if (!info) problems.push(`${shown} doesn't exist`);
    else if (info.isSymbolicLink()) problems.push(`${shown} is a symlink`);
    else if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), `${shown.replace(/[\\/]$/, "")}/${name}`);
      }
    } else if (shown.endsWith("/plugin.yaml")) {
      const manifest = parse(await readFile(path, "utf8")) as {
        distribution?: unknown;
      } | null;
      if (manifest?.distribution !== "shipped") {
        problems.push(`${shown} isn't distribution: shipped`);
      }
    }
  };

  for (const source of sources) {
    // A glob would need its own matching to check, and the config doesn't use one.
    if (/[*?[{]/.test(source)) problems.push(`${source} is a glob`);
    else await visit(resolve(dirname(confPath), source), source);
  }
  return problems;
}
