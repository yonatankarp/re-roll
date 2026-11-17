// Writes an entity for every library heading that coverage says should be one of the engine's text
// kinds (world lore #127–#129, rulings #130) or the D&D rules glossary (#132), into the book's own rules plugin, and each ruling book's
// index of the sections its rulings rule on. Run it from the main checkout, since storage refuses a symlink.
//   npm run import:world
// The systems load first: the glossary reaches the D&D modules, which import each other.
import { systems } from "../systems.ts";
import { stringify } from "yaml";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { scanPlugins } from "../../engine/run/loader.ts";
import {
  type Entity,
  checkCoverage,
  indexEntities,
  singular,
  slug,
} from "../../engine/tools/coverage.ts";
import {
  type BookRef,
  rulingIndex,
  subjectsOf,
} from "../../engine/tools/rulings.ts";
import { draftWorld } from "../../engine/tools/world.ts";
import { GLOSSARY_KINDS } from "../../plugins/systems/dnd5.5e/core/schemas.ts";

const ROOTS = ["plugins", "books"];
// An erratum's top heading names the book it corrects. These name a book the library holds by another title.
const ALIASES: Readonly<Record<string, string>> = {
  "5e player's handbook": "basic-rules-2014",
};

// The D&D rules glossary's kinds (#132), drafted like lore: id kind -> folder.
const TEXT_KINDS = Object.fromEntries(
  Object.entries(GLOSSARY_KINDS).map(([folder, kind]) => [kind, folder]),
);
const plain = (title: string) => title.replace(/[’‘]/g, "'").toLowerCase();

const storage = await createNodeStorage(process.cwd());
const catalog = await scanPlugins(storage, ROOTS);
const report = await checkCoverage(storage, ROOTS, catalog, systems);
const index = indexEntities(report.entities);
// A ruling that names a rules term rules on the term's entity (#132), not on a spell that shares its name.
const terms = new Set(
  report.entities
    .filter((entity) => entity.lore)
    .map((entity) => singular(slug(entity.name))),
);
const editions = new Map(report.entities.map((e) => [e.plugin, e.edition]));

const titles = new Map<string, string>(); // book -> its title
const rootOf = new Map<string, string>();
for (const { book } of report.books) {
  for (const root of ROOTS) {
    const text = await storage.read(`${root}/library/${book}/index.json`);
    if (text === null) continue;
    titles.set(book, (JSON.parse(text) as { title?: string }).title ?? book);
    rootOf.set(book, root);
    break;
  }
}
const byTitle = new Map<string, BookRef>();
const ref = (plugin: string): BookRef | undefined => {
  const edition = editions.get(plugin);
  return edition === undefined ? undefined : { plugin, edition };
};
for (const [book, title] of titles) {
  const found = ref(book);
  if (found) byTitle.set(plain(title), found);
}
for (const [title, plugin] of Object.entries(ALIASES)) {
  const found = ref(plugin);
  if (found) byTitle.set(title, found);
}
// A Sage Advice heading is the compendium's own; any other top heading is a book its errata correct.
const bookOf = (title: string): BookRef | null | undefined =>
  /sage advice/i.test(title) ? undefined : (byTitle.get(plain(title)) ?? null);

const counts = new Map<string, number>();
const rulings: Pick<Entity, "plugin" | "library" | "about">[] =
  report.entities.filter((e) => e.kind === "ruling");
for (const { book, edition, verdicts } of report.books) {
  const record = catalog.plugins.get(book);
  const { drafts, homeless } = draftWorld(
    book,
    titles.get(book) ?? book,
    verdicts,
    new Set(record?.files),
    TEXT_KINDS,
  );
  for (const id of homeless) console.warn(`${id}: a keyed area with no place`);
  if (record?.manifest.kind !== "rules") {
    if (drafts.length > 0)
      console.warn(
        `${book}: no rules plugin for its ${String(drafts.length)} entities`,
      );
    continue;
  }
  const at = new Map(verdicts.map((v, i) => [v.heading.id, i]));
  for (const { file, entry } of drafts) {
    const kind = file.slice(0, file.indexOf("/"));
    let written: object = entry;
    if (kind === "rulings") {
      const found = at.get(entry.library?.[0] ?? "") ?? -1;
      const about = subjectsOf(verdicts, found, edition, index, bookOf, terms);
      written = { ...entry, ...(about.length > 0 ? { about } : {}) };
      rulings.push({ plugin: book, library: entry.library ?? [], about });
    }
    await storage.replaceAtomically(
      `${record.root}/${file}`,
      stringify([written], { lineWidth: 0 }),
    );
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
}
for (const [book, sections] of rulingIndex(
  rulings,
  report.books.flatMap((b) => b.verdicts),
)) {
  await storage.replaceAtomically(
    `${rootOf.get(book) ?? "books"}/library/${book}/rulings.json`,
    `${JSON.stringify({ rulings: sections }, null, 2)}\n`,
  );
}
console.log(
  `Wrote ${[...counts].map(([kind, n]) => `${kind} ${String(n)}`).join(", ") || "nothing"}`,
);
