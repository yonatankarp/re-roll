import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { STORE_INDEX, STORE_TAG } from "../../engine/shell/store-index.ts";
import { packStore } from "../../engine/tools/store-pack.ts";

// Packs a store: one zip per package in <root>/store.yaml, and store.json, written to --out.
//   npm run store:pack -- books --out /tmp/store
//   npm run store:pack -- books --out /tmp/store --publish owner/repo
// --publish uploads them to the repo's "store" release with the gh CLI, making the release if needed.

const USAGE =
  "Usage: npm run store:pack -- <root> --out <dir> [--publish <owner/repo>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, publish: { type: "string" } },
});
const [root] = positionals;
if (root === undefined || values.out === undefined) {
  console.error(USAGE);
  process.exit(1);
}
const out = values.out;

const { index, zips, unpacked } = await packStore(root);
await mkdir(out, { recursive: true });
for (const [file, zip] of zips) await writeFile(join(out, file), zip);
await writeFile(join(out, STORE_INDEX), `${JSON.stringify(index, null, 2)}\n`);
for (const { id, size, plugins } of index.packages)
  console.log(
    `${id}: ${(size / 1024 ** 2).toFixed(1)} MB${plugins.length > 0 ? `, plugins ${plugins.map((plugin) => plugin.id).join(", ")}` : ""}`,
  );
if (unpacked.length > 0) console.warn(`In no package: ${unpacked.join(", ")}`);
console.log(`Wrote ${String(zips.size)} packages and ${STORE_INDEX} to ${out}`);

const repo = values.publish;
if (repo !== undefined) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    console.error(`${repo} isn't owner/repo`);
    process.exit(1);
  }
  const gh = (...args: string[]): string =>
    execFileSync("gh", args, { encoding: "utf8" });
  // Plugins from books you own aren't redistributable, so they only go to a private repo.
  const isPrivate = gh("api", `repos/${repo}`, "-q", ".private").trim();
  const privatePlugins = index.packages.flatMap(({ plugins }) =>
    plugins.filter(({ distribution }) => distribution === "private"),
  );
  if (isPrivate !== "true" && privatePlugins.length > 0) {
    console.error(
      `${repo} is public, and ${privatePlugins.map(({ id }) => id).join(", ")} ${privatePlugins.length === 1 ? "is" : "are"} marked distribution: private. Publish those to a private repo.`,
    );
    process.exit(1);
  }
  try {
    gh("release", "view", STORE_TAG, "-R", repo);
  } catch {
    gh(
      "release",
      "create",
      STORE_TAG,
      "-R",
      repo,
      "--title",
      "Store",
      "--notes",
      "Content packages for the Re-roll Store, made by npm run store:pack.",
    );
  }
  // The index goes last, so it never lists a zip that isn't up yet.
  const files = [...zips.keys()].map((file) => join(out, file));
  if (files.length > 0)
    gh("release", "upload", STORE_TAG, "-R", repo, "--clobber", ...files);
  gh(
    "release",
    "upload",
    STORE_TAG,
    "-R",
    repo,
    "--clobber",
    join(out, STORE_INDEX),
  );
  console.log(`Published to ${repo}'s ${STORE_TAG} release`);
}
