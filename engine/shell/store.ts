import { z } from "zod";
import type { StoreIndex, StorePackage } from "./store-index.ts";

// The Store's own logic, apart from the screen and the downloads: which repos the player added, what
// came from where, what a package needs first, and whether a download is the file the index promised.

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// "owner/repo", from that or any GitHub link into the repo.
export function parseRepo(input: string): string | null {
  const path = input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/[?#].*$/, "");
  const [owner = "", name = ""] = path.split("/");
  const repo = `${owner}/${name.replace(/\.git$/i, "")}`;
  return REPO.test(repo) && !/\/\.{1,2}$/.test(repo) ? repo : null;
}

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const StoreStateSchema = z.object({
  repos: z.array(z.string()).default([]),
  // Each package installed from a store: the repo it came from, and the zip's hash, which marks its version.
  installed: z
    .record(z.string(), z.object({ repo: z.string(), sha256: Sha }))
    .default({}),
});
export type StoreState = z.infer<typeof StoreStateSchema>;

// A missing or unreadable record starts empty, so the Store still opens.
export function readStoreState(text: string | null): StoreState {
  try {
    const parsed = StoreStateSchema.safeParse(JSON.parse(text ?? "{}"));
    return parsed.success ? parsed.data : { repos: [], installed: {} };
  } catch {
    return { repos: [], installed: {} };
  }
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Refuses a download that was cut short, damaged, or changed since the index was made.
export async function verifyDownload(
  bytes: Uint8Array,
  pkg: StorePackage,
): Promise<void> {
  if (bytes.length !== pkg.size || (await sha256(bytes)) !== pkg.sha256)
    throw new Error(
      `${pkg.title} didn't download as the store lists it. Try again, or ask the store's owner to pack it again.`,
    );
}

// "present" is a package whose plugins are all there already, from a zip or another store.
export type PackageStatus = "install" | "update" | "installed" | "present";

export function packageStatus(
  repo: string,
  pkg: StorePackage,
  state: StoreState,
  present: ReadonlySet<string>,
): PackageStatus {
  const record = state.installed[pkg.id];
  if (record?.repo === repo)
    return record.sha256 === pkg.sha256 ? "installed" : "update";
  return pkg.plugins.length > 0 &&
    pkg.plugins.every(({ id }) => present.has(id))
    ? "present"
    : "install";
}

export interface StoreStep {
  readonly repo: string;
  readonly pkg: StorePackage;
}

// The package, after the packages that give it the plugins it needs and the game lacks, each once.
// A plugin is looked for in the package's own store first, then in the others.
export function installOrder(
  wanted: StoreStep,
  stores: ReadonlyMap<string, StoreIndex>,
  present: ReadonlySet<string>,
): StoreStep[] {
  const order: StoreStep[] = [];
  const have = new Set(present);
  const visiting = new Set<string>();
  const providerOf = (plugin: string, repo: string): StoreStep | null => {
    const repos = [
      repo,
      ...[...stores.keys()].filter((other) => other !== repo),
    ];
    for (const from of repos)
      for (const pkg of stores.get(from)?.packages ?? [])
        if (pkg.plugins.some(({ id }) => id === plugin))
          return { repo: from, pkg };
    return null;
  };
  const visit = (step: StoreStep): void => {
    const key = `${step.repo}:${step.pkg.id}`;
    if (
      visiting.has(key) ||
      order.some((done) => `${done.repo}:${done.pkg.id}` === key)
    )
      return;
    visiting.add(key);
    const own = new Set(step.pkg.plugins.map(({ id }) => id));
    for (const { requires } of step.pkg.plugins)
      for (const needed of requires) {
        if (have.has(needed) || own.has(needed)) continue;
        const provider = providerOf(needed, step.repo);
        if (!provider)
          throw new Error(
            `${step.pkg.title} needs ${needed}, which none of your stores has.`,
          );
        visit(provider);
      }
    for (const id of own) have.add(id);
    order.push(step);
  };
  visit(wanted);
  return order;
}
