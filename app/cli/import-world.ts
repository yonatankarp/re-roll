// Writes a world entity (#127–#129) for every library heading that coverage says should be one,
// into the book's own rules plugin. Run it from the main checkout, since storage refuses a symlink.
//   npm run import:world
import { stringify } from "yaml";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { scanPlugins } from "../../engine/run/loader.ts";
import { checkCoverage } from "../../engine/tools/coverage.ts";
import { draftWorld } from "../../engine/tools/world.ts";
import { systems } from "../systems.ts";

const ROOTS = ["plugins", "books"];
const storage = await createNodeStorage(process.cwd());
const catalog = await scanPlugins(storage, ROOTS);
const report = await checkCoverage(storage, ROOTS, catalog, systems);

const counts = new Map<string, number>();
for (const { book, verdicts } of report.books) {
  const record = catalog.plugins.get(book);
  let title = book;
  for (const root of ROOTS) {
    const index = await storage.read(`${root}/library/${book}/index.json`);
    if (index === null) continue;
    title = (JSON.parse(index) as { title?: string }).title ?? book;
    break;
  }
  const { drafts, homeless } = draftWorld(
    book,
    title,
    verdicts,
    new Set(record?.files),
  );
  for (const id of homeless) console.warn(`${id}: a keyed area with no place`);
  if (record?.manifest.kind !== "rules") {
    if (drafts.length > 0)
      console.warn(
        `${book}: no rules plugin for its ${String(drafts.length)} entities`,
      );
    continue;
  }
  for (const { file, entry } of drafts) {
    await storage.replaceAtomically(
      `${record.root}/${file}`,
      stringify([entry], { lineWidth: 0 }),
    );
    const kind = file.slice(0, file.indexOf("/"));
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
}
console.log(
  `Wrote ${[...counts].map(([kind, n]) => `${kind} ${String(n)}`).join(", ") || "nothing"}`,
);
