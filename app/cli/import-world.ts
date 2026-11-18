// Writes an entity for every library heading that coverage says should be one of the engine's text
// kinds (world lore #127–#129, rulings #130), the D&D rules glossary (#132), monster families and lairs (#133)
// or the environment, downtime and character option kinds (#134–#136),
// into the book's own rules plugin, each ruling book's index of the sections its rulings rule on, and each
// book's indexes of the sections its families and lairs link and of its sections' text kinds. Run it from the main checkout, since storage refuses a symlink.
//   npm run import:world
// The systems load first: the glossary reaches the D&D modules, which import each other.
import { systems } from "../systems.ts";
import { stringify } from "yaml";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { scanPlugins } from "../../engine/run/loader.ts";
import {
  type Entity,
  type Verdict,
  checkCoverage,
  indexEntities,
  matchHeading,
  singular,
  slug,
} from "../../engine/tools/coverage.ts";
import {
  type BookRef,
  rulingIndex,
  subjectsOf,
} from "../../engine/tools/rulings.ts";
import { draftWorld } from "../../engine/tools/world.ts";
import { GLOSSARY_TERMS } from "../../plugins/systems/dnd5.5e/core/glossary.ts";
import {
  familyLinks,
  linksIndex,
} from "../../plugins/systems/dnd5.5e/core/import/families.ts";
import { skillRows } from "../../plugins/systems/dnd5.5e/core/import/skills.ts";
import {
  DOWNTIME_KINDS,
  ENVIRONMENT_KINDS,
  GLOSSARY_KINDS,
  MONSTER_TEXT_KINDS,
  OPTION_KINDS,
} from "../../plugins/systems/dnd5.5e/core/schemas.ts";

const ROOTS = ["plugins", "books"];
// An erratum's top heading names the book it corrects. These name a book the library holds by another title.
const ALIASES: Readonly<Record<string, string>> = {
  "5e player's handbook": "basic-rules-2014",
};

// The D&D rules glossary's kinds (#132), monster families and lairs (#133), and the environment, downtime and
// character option kinds (#134–#136), drafted like lore: id kind -> folder.
const TEXT_KINDS = Object.fromEntries(
  Object.entries({
    ...GLOSSARY_KINDS,
    ...MONSTER_TEXT_KINDS,
    ...ENVIRONMENT_KINDS,
    ...DOWNTIME_KINDS,
    ...OPTION_KINDS,
  }).map(([folder, kind]) => [kind, folder]),
);
const SHOWN_KINDS = new Set<string>([
  ...Object.values(ENVIRONMENT_KINDS),
  ...Object.values(DOWNTIME_KINDS),
  ...Object.values(OPTION_KINDS),
]);
// The 2014 books print a condition or a sense in lower case, unlike an action or a skill ("help", "history").
const LOWER_CASE = new Set(["condition", "sense"]);
// Rules terms a book names in one lower-case word that is rarely anything else (#196).
const TERM_WORDS = new Set(["concentration", "surprise", "cantrip"]);
const plain = (title: string) => title.replace(/[’‘]/g, "'").toLowerCase();

const storage = await createNodeStorage(process.cwd());
const catalog = await scanPlugins(storage, ROOTS);
const report = await checkCoverage(storage, ROOTS, catalog, systems);
const index = indexEntities(report.entities);
// The terms the game explains stay terms in every edition, so a 2014 ruling's "Resistance" isn't the cantrip.
// Not a weapon's mastery or property, which 2014 books don't have and whose names are spells' too (Slow).
const terms = new Set(
  GLOSSARY_TERMS.filter((term) => !term.entity.startsWith("weapon-")).flatMap(
    (term) =>
      report.entities
        .filter((entity) => entity.id.endsWith(`:${term.entity}`))
        .map((entity) => singular(slug(entity.name))),
  ),
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

// A 2024 stat block that prints in-Lair numbers is one of its lair's owners.
const inLair = new Map<string, boolean>();
for (const entity of report.entities.filter((e) => e.kind === "monster")) {
  const record = catalog.plugins.get(entity.plugin);
  const tail = entity.id.slice(entity.id.indexOf("/") + 1);
  const text = record
    ? await storage.read(`${record.root}/monsters/${tail}.yaml`)
    : null;
  inLair.set(entity.id, /\bin Lair\b/.test(text ?? ""));
}

// Each book's drafts, and its families' and lairs' links, from where the book nests them.
const plans = report.books.map(({ book, edition, verdicts, members }) => {
  const record = catalog.plugins.get(book);
  // A heading linked to another edition's entity is its reprint's reference text, not lore of its own (#182).
  const reprinted = (entity?: string) =>
    entity !== undefined && index.byId.get(entity)?.edition !== edition;
  const { drafts, homeless } = draftWorld(
    book,
    titles.get(book) ?? book,
    verdicts.map((v) =>
      v.status === "linked" && reprinted(v.entity)
        ? { ...v, kind: "reprint" }
        : v,
    ),
    new Set(record?.files),
    TEXT_KINDS,
  );
  const drafted = new Map(
    drafts.map((d) => [d.entry.library?.[0], d.entry.id]),
  );
  const placed = verdicts.map(({ heading, status, entity }) => ({
    ...heading,
    entity:
      drafted.get(heading.id) ?? (status === "linked" ? entity : undefined),
  }));
  const seen = new Set([
    book,
    ...(record?.manifest.requires ?? []).map((r) => r.plugin),
  ]);
  const visible = (id: string) => seen.has(id.slice(0, id.indexOf(":")));
  const links = familyLinks(book, placed, {
    inLair: (id) => inLair.get(id) ?? false,
    named: (name) => {
      const hit = matchHeading(index, name, {
        book,
        edition,
        kinds: ["monster"],
        asked: true,
        adventure: null,
      });
      return hit && visible(hit.id) ? hit.id : undefined;
    },
    people: report.entities.filter(
      (e) => e.plugin === book && (e.kind === "monster" || e.kind === "npc"),
    ),
  });
  // Where a family's section names its stat blocks only in prose or in another book, the coverage file does.
  for (const [id, ids] of Object.entries(members)) links.set(id, [...ids]);
  return {
    book,
    edition,
    verdicts,
    record,
    drafts,
    homeless,
    placed,
    links,
    visible,
  };
});
// A family heading holding its own book's stat blocks owns its name in its edition, as do families written before.
const owned = new Map<string, string>(); // "<edition>|<name>" -> family id
const nameKey = (edition: string, name: string) =>
  `${edition}|${singular(slug(name))}`;
for (const entity of report.entities.filter((e) => e.kind === "monster-family"))
  owned.set(nameKey(entity.edition, entity.name), entity.id);
for (const { book, edition, drafts, links } of plans)
  for (const { entry } of drafts)
    if (links.get(entry.id)?.some((id) => id.startsWith(`${book}:`)))
      owned.set(nameKey(edition, entry.name), entry.id);

// Each stat block's families in its own book, for a book that prints it too, as the Basic Rules (#188).
const familiesOf = new Map<string, string[]>();
const pluginOf = (id: string) => id.slice(0, id.indexOf(":"));
for (const { links } of plans)
  for (const [family, ids] of links)
    for (const id of ids)
      if (
        family.includes(":monster-family/") &&
        pluginOf(id) === pluginOf(family)
      )
        familiesOf.set(id, [...(familiesOf.get(id) ?? []), family]);
// The heading each entity's own book describes it under, as coverage links it.
const sectionOf = new Map<string, Verdict["heading"]>();
for (const { verdicts } of report.books)
  for (const { heading, status, entity } of verdicts)
    if (
      status === "linked" &&
      entity !== undefined &&
      pluginOf(entity) === heading.book &&
      !sectionOf.has(entity)
    )
      sectionOf.set(entity, heading);
const counts = new Map<string, number>();
const rulings: Pick<Entity, "plugin" | "library" | "about">[] =
  report.entities.filter((e) => e.kind === "ruling");
for (const plan of plans) {
  const { book, edition, verdicts, record, drafts, homeless, placed, links } =
    plan;
  for (const id of homeless) console.warn(`${id}: a keyed area with no place`);
  if (record?.manifest.kind !== "rules") {
    if (drafts.length > 0)
      console.warn(
        `${book}: no rules plugin for its ${String(drafts.length)} entities`,
      );
    continue;
  }
  const at = new Map(verdicts.map((v, i) => [v.heading.id, i]));

  // A family listing only other books' stat blocks under another book's family's name (Basic Rules' Bandits)
  // is that family, linked on the next run. A family listing it lists that family instead.
  const skipped = new Map<string, string>(); // -> the family whose name it has
  for (const { entry } of drafts) {
    const other = owned.get(nameKey(edition, entry.name));
    if (
      entry.id.includes(":monster-family/") &&
      other !== undefined &&
      other !== entry.id &&
      !links.get(entry.id)?.some((id) => id.startsWith(`${book}:`))
    )
      skipped.set(entry.id, other);
  }
  for (const id of skipped.keys()) links.delete(id);
  for (const [id, ids] of links)
    links.set(id, [
      ...new Set(ids.map((m) => skipped.get(m) ?? m).filter(plan.visible)),
    ]);
  const indexed = new Map(links);
  for (const { entity } of placed)
    if (entity && pluginOf(entity) !== book)
      for (const family of familiesOf.get(entity) ?? [])
        indexed.set(family, [
          ...new Set([...(indexed.get(family) ?? []), entity]),
        ]);
  const related = linksIndex(
    placed.map((p) =>
      p.entity && skipped.has(p.entity) ? { ...p, entity: undefined } : p,
    ),
    indexed,
    (id) => {
      const heading = sectionOf.get(id);
      return heading && heading.book !== book
        ? { book: heading.book, file: heading.file, heading: heading.text }
        : undefined;
    },
  );
  if (Object.keys(related).length > 0)
    await storage.replaceAtomically(
      `${rootOf.get(book) ?? "books"}/library/${book}/links.json`,
      `${JSON.stringify({ links: related }, null, 2)}\n`,
    );
  for (const [id, ids] of links)
    if (ids.length === 0) console.warn(`${id}: no stat blocks found`);

  // The sections that are an environment, downtime or character option entity, and which (#134–#136).
  const kinds: Record<string, { heading: string; kind: string }[]> = {};
  for (const { file, text, entity } of placed) {
    const kind = entity?.slice(entity.indexOf(":") + 1, entity.indexOf("/"));
    if (kind !== undefined && SHOWN_KINDS.has(kind))
      (kinds[file] ??= []).push({ heading: text, kind });
  }
  if (Object.keys(kinds).length > 0)
    await storage.replaceAtomically(
      `${rootOf.get(book) ?? "books"}/library/${book}/kinds.json`,
      `${JSON.stringify({ kinds }, null, 2)}\n`,
    );

  for (const { file, entry } of drafts) {
    if (skipped.has(entry.id)) continue;
    const kind = file.slice(0, file.indexOf("/"));
    let written: object = entry;
    if (kind === "monster-families")
      written = { ...entry, members: links.get(entry.id) ?? [] };
    if (kind === "lairs")
      written = { ...entry, owners: links.get(entry.id) ?? [] };
    if (kind === "rulings") {
      const found = at.get(entry.library?.[0] ?? "") ?? -1;
      const about = subjectsOf(verdicts, found, edition, index, bookOf, {
        terms,
        kinds: new Set(Object.values(GLOSSARY_KINDS)),
        lower: LOWER_CASE,
        words: TERM_WORDS,
      });
      written = { ...entry, ...(about.length > 0 ? { about } : {}) };
      rulings.push({ plugin: book, library: entry.library ?? [], about });
    }
    await storage.replaceAtomically(
      `${record.root}/${file}`,
      stringify([written], { lineWidth: 0 }),
    );
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  // The skills a 2024 book lists in its Skills table, each linked to the heading nearest it: the last in
  // reading order whose text holds the whole table, not an ability's few (#187).
  let table: { id: string; rows: ReturnType<typeof skillRows> } | undefined;
  for (const { heading } of verdicts) {
    const rows = skillRows(heading.body);
    if (rows.length > 0 && rows.length >= (table?.rows.length ?? 0))
      table = { id: heading.id, rows };
  }
  const found = table;
  for (const row of found?.rows ?? []) {
    const file = `skills/${row.id}.yaml`;
    if (record.files.includes(file)) continue;
    const entry = {
      id: `${book}:skill/${row.id}`,
      name: row.name,
      source: titles.get(book) ?? book,
      text: row.text,
      library: found ? [found.id] : [],
    };
    await storage.replaceAtomically(
      `${record.root}/${file}`,
      stringify([entry], { lineWidth: 0 }),
    );
    counts.set("skills", (counts.get("skills") ?? 0) + 1);
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
