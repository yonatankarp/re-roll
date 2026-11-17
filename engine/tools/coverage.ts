// Library coverage (#126): every heading in a book's library is linked to an entity, or structural.
// The matcher and the rule machinery live here. Each book's own rules name its headings, so they
// live with the book, in the private `<root>/coverage/<book>.yaml`.
import { parse } from "yaml";
import { z } from "zod";
import { type Issue, zodIssues } from "../kernel/issues.ts";
import type { Storage } from "../kernel/storage.ts";
import type { GameSystem } from "../kernel/system.ts";
import { WORLD_KINDS } from "../kernel/world.ts";
import type { Catalog } from "../run/loader.ts";

export interface Heading {
  readonly id: string; // "<book>/<file stem>" for a file's first heading, else "…#<slug>"
  readonly book: string;
  readonly file: string;
  readonly level: number;
  readonly text: string;
  readonly body: string; // what the book prints under it, up to the next heading
}

export interface Entity {
  readonly id: string; // plugin:kind/name
  readonly plugin: string;
  readonly kind: string; // the id's kind, such as "spell"
  readonly name: string;
  readonly edition: string;
  readonly library: readonly string[]; // heading ids the entity says it describes
  readonly about: readonly string[]; // a ruling's: the entity ids it rules on
  readonly lore?: boolean; // a system's lore kind, such as a rules glossary term: linked only where a rule asks
}

const RuleSchema = z.strictObject({
  sections: z
    .string()
    .regex(/^\d{4}-\d{4}$/, "must look like 0001-0099")
    .optional(), // by the section file's four-digit prefix, inclusive
  levels: z.array(z.number().int().min(1).max(6)).optional(),
  heading: z.string().optional(), // a case-insensitive regular expression
  keyed: z.boolean().optional(), // a map key, such as "B12. Treasure Room"
  // Link the heading to an entity of these kinds ("any": of any kind) before deciding.
  match: z.union([z.literal("any"), z.array(z.string())]).optional(),
  // A creature family: linked when it holds one stat block of this kind, which matches its name.
  family: z.string().optional(),
  // A mapped site, missing an entity of this kind: it has Features or Locations, or keyed areas, below it.
  site: z.string().optional(),
  // "structural", or the kind of entity the heading names. Unset: on to the next rule.
  is: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const CoverageFileSchema = z.strictObject({
  edition: z.string().optional(), // for a book with no plugin manifest
  // An adventure book: a heading matches only this book's entities, or other books' of these kinds,
  // unless a rule names kinds.
  adventure: z.array(z.string()).optional(),
  rules: z.array(RuleSchema).default([]),
  links: z.record(z.string(), z.array(z.string())).optional(), // heading id -> entity ids
});
export type CoverageFile = z.infer<typeof CoverageFileSchema>;

export const STRUCTURAL = "structural";
const UNCLASSIFIED = "unclassified";
const ALWAYS_STRUCTURAL = /^(?:chapter|appendix|part)\s+\w+\b|^credits$/i;
export const KEYED =
  /^(?:Area\s+)?[A-Z]{0,2}\d{1,3}(?:[a-z](?:\s*[–-]\s*[a-z])?)?\s*[.:]\s*\S/;
const SITE_PART = /(?:Features|Locations)$/;
const WORLD = new Set(Object.values(WORLD_KINDS).map((kind) => kind.idPrefix));

export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const singular = (s: string): string => {
  const t = s.replace(/elves\b/g, "elf").replace(/dwarves\b/g, "dwarf");
  if (t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  return /[^s]s$/.test(t) ? t.slice(0, -1) : t;
};

const LEVEL_LABEL =
  /^(?:(?:level|lvl)\s*\d+|\d+(?:st|nd|rd|th)[- ]level|cantrip|feature(?=:))\s*[:.\-–]\s*/i;
const TRAILING_GROUP = /\s*(?:\([^)]*\)|\[[^\]]*\])\s*$/;
const WRAPPER =
  /^(?:Variant\s+)?(.+?)\s+(?:Traits|Class Features|Features|Spell List|Expanded Spells|Spells|Feats?|Options)$/i;

const unique = (keys: readonly string[]): string[] => [
  ...new Set(keys.filter(Boolean)),
];

// The heading as printed first, then without its labels: "Level 3: Rage", "Feature: Moss Haven", "Stone (Luckstone)",
// "Acid (25 GP)", "The Gilded Hand". Looser keys come after: the singular ("High Elves") and the name
// inside a wrapper label ("Aasimar Traits", "Bard Spell List").
export function variants(heading: string): {
  readonly named: readonly string[];
  readonly loose: readonly string[];
} {
  const unlevelled = heading.replace(LEVEL_LABEL, "");
  let bare = unlevelled;
  while (TRAILING_GROUP.test(bare)) bare = bare.replace(TRAILING_GROUP, "");
  const named = unique(
    [heading, unlevelled, bare, bare.replace(/^the\s+/i, "")].map(slug),
  );
  const inner = slug(WRAPPER.exec(bare)?.[1] ?? "");
  const loose = unique([...named.map(singular), inner, singular(inner)]);
  return { named, loose: loose.filter((key) => !named.includes(key)) };
}

export interface EntityIndex {
  readonly bySlug: ReadonlyMap<string, readonly Entity[]>;
  readonly bySuffix: ReadonlyMap<string, readonly Entity[]>; // the trailing words of an id's name
  readonly byId: ReadonlyMap<string, Entity>;
}

export function indexEntities(entities: readonly Entity[]): EntityIndex {
  const bySlug = new Map<string, Entity[]>();
  const bySuffix = new Map<string, Entity[]>();
  const add = (map: Map<string, Entity[]>, key: string, entity: Entity) => {
    if (key) map.set(key, [...(map.get(key) ?? []), entity]);
  };
  for (const entity of entities) {
    const tail = entity.id.slice(entity.id.indexOf("/") + 1);
    const name = slug(entity.name);
    const keys = new Set([
      name,
      singular(name),
      tail,
      slug(entity.name.replace(/\([^)]*\)/g, "")),
    ]);
    for (const key of keys) add(bySlug, key, entity);
    const parts = tail.split("-");
    for (let i = 1; i < parts.length; i += 1) {
      add(bySuffix, parts.slice(i).join("-"), entity);
    }
  }
  return {
    bySlug,
    bySuffix,
    byId: new Map(entities.map((entity) => [entity.id, entity])),
  };
}

export interface MatchScope {
  readonly book: string;
  readonly edition: string;
  readonly kinds: readonly string[] | null; // null: any kind
  readonly asked: boolean; // a rule says the heading names an entity
  readonly adventure: readonly string[] | null; // the book's adventure kinds
}

// An entity of the same edition named by the heading, from the same book first.
export function matchHeading(
  index: EntityIndex,
  heading: string,
  scope: MatchScope,
): Entity | undefined {
  const sameBook = (entity: Entity) => entity.plugin === scope.book;
  const asked = scope.asked || scope.kinds !== null;
  const fits = (entity: Entity) =>
    entity.edition === scope.edition &&
    (!scope.kinds || scope.kinds.includes(entity.kind)) &&
    // Lore's names are common words (a ship's station named for a god, Encounters), so another book's needs a rule asking.
    (!WORLD.has(entity.kind) || sameBook(entity) || scope.kinds !== null) &&
    // A rules glossary's names are common words (Light, Slow, Adventure), so it needs a rule asking even in its own book.
    (!entity.lore || scope.kinds !== null) &&
    (asked ||
      !scope.adventure ||
      sameBook(entity) ||
      scope.adventure.includes(entity.kind));
  const { named, loose } = variants(heading);
  // Loose keys reach other books only where a rule says the heading names an entity.
  const find = (key: string, wide: boolean) => {
    const hits = (index.bySlug.get(key) ?? []).filter(
      (entity) => fits(entity) && (wide || sameBook(entity)),
    );
    // The same book first, then an entity whose whole name is the key.
    const rank = (entity: Entity) =>
      (sameBook(entity) ? 0 : 2) + (slug(entity.name) === key ? 0 : 1);
    return hits.reduce<Entity | undefined>(
      (best, entity) => (!best || rank(entity) < rank(best) ? entity : best),
      undefined,
    );
  };
  for (const key of named) {
    const hit = find(key, true);
    if (hit) return hit;
  }
  for (const key of loose) {
    const hit = find(key, asked);
    if (hit) return hit;
  }
  // A class feature or a lineage whose id ends with the name, when only one in the book does.
  if (!asked) return undefined;
  for (const key of [...named, ...loose]) {
    if (key.length <= 3) continue;
    const hits = [
      ...(index.bySuffix.get(key) ?? []),
      ...(index.bySuffix.get(`${key}-lineage`) ?? []),
    ].filter((entity) => fits(entity) && sameBook(entity));
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

export function headingsOf(
  book: string,
  file: string,
  markdown: string,
): Heading[] {
  const stem = file.replace(/\.md$/, "");
  const seen = new Set<string>();
  const out: Heading[] = [];
  const bodies: string[][] = [];
  for (const line of markdown.split("\n")) {
    const found = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const text = (found?.[2] ?? "").replace(/[*_`]/g, "").trim();
    if (!found || !text) {
      bodies.at(-1)?.push(line);
      continue;
    }
    bodies.push([]);
    let id = `${book}/${stem}`;
    if (out.length > 0) {
      const base = `${id}#${slug(text) || "heading"}`;
      id = base;
      for (let n = 2; seen.has(id); n += 1) id = `${base}-${String(n)}`;
    }
    seen.add(id);
    out.push({
      id,
      book,
      file,
      level: (found[1] ?? "").length,
      text,
      body: "",
    });
  }
  return out.map((heading, at) => ({
    ...heading,
    body: (bodies[at] ?? []).join("\n").trim(),
  }));
}

export interface BookInput {
  readonly book: string;
  readonly edition: string;
  readonly coverage: CoverageFile | null;
  readonly headings: readonly Heading[]; // in reading order across the book's files
}

export type Status = "linked" | "structural" | "missing";
export interface Verdict {
  readonly heading: Heading;
  readonly status: Status;
  readonly kind: string; // the linked entity's kind, or the kind the heading should have
  readonly entity?: string;
}

const applies = (rule: Rule, heading: Heading): boolean => {
  const section = heading.file.slice(0, 4);
  if (rule.sections) {
    const [low = "", high = ""] = rule.sections.split("-");
    if (section < low || section > high) return false;
  }
  if (rule.levels && !rule.levels.includes(heading.level)) return false;
  if (rule.keyed && !KEYED.test(heading.text)) return false;
  return !rule.heading || new RegExp(rule.heading, "iu").test(heading.text);
};

// Explicit link, then the book's rules in order, each matching within its kinds; else unclassified.
export function classifyBook(
  input: BookInput,
  index: EntityIndex,
  linkedBy: ReadonlyMap<string, string>, // heading id -> the entity that names it
): Verdict[] {
  const { book, edition, coverage, headings } = input;
  const scope = (
    kinds: readonly string[] | null,
    asked = false,
  ): MatchScope => ({
    book,
    edition,
    kinds,
    asked,
    adventure: coverage?.adventure ?? null,
  });
  const plain = headings.map((h) => matchHeading(index, h.text, scope(null)));
  const below = (at: number): number[] => {
    const out: number[] = [];
    for (let i = at + 1; i < headings.length; i += 1) {
      if ((headings[i]?.level ?? 0) <= (headings[at]?.level ?? 0)) break;
      out.push(i);
    }
    return out;
  };
  const linked = (heading: Heading, entity: Entity): Verdict => ({
    heading,
    status: "linked",
    kind: entity.kind,
    entity: entity.id,
  });
  const decide = (heading: Heading, kind: string): Verdict => {
    if (kind === STRUCTURAL) return { heading, status: STRUCTURAL, kind };
    return { heading, status: "missing", kind };
  };

  return headings.map((heading, at): Verdict => {
    const named = [
      linkedBy.get(heading.id),
      ...(coverage?.links?.[heading.id] ?? []),
    ].find((id) => id !== undefined && index.byId.has(id));
    const explicit = named === undefined ? undefined : index.byId.get(named);
    if (explicit) return linked(heading, explicit);
    if (ALWAYS_STRUCTURAL.test(heading.text))
      return decide(heading, STRUCTURAL);

    for (const rule of coverage?.rules ?? []) {
      if (!applies(rule, heading)) continue;
      if (rule.family !== undefined) {
        const one = matchHeading(index, heading.text, scope([rule.family]));
        const kids = below(at).filter((i) => plain[i]).length;
        if (one && kids <= 1) return linked(heading, one);
      }
      if (
        rule.site !== undefined &&
        below(at).some((i) => {
          const text = headings[i]?.text ?? "";
          return SITE_PART.test(text) || KEYED.test(text);
        })
      ) {
        return decide(heading, rule.site);
      }
      if (rule.match !== undefined) {
        const kinds = rule.match === "any" ? null : rule.match;
        const hit = matchHeading(index, heading.text, scope(kinds, true));
        if (hit) return linked(heading, hit);
      }
      if (rule.is === undefined) continue;
      // A heading the rule says names an entity of a kind links only to an entity of that kind.
      const hit =
        rule.is === STRUCTURAL
          ? plain[at]
          : matchHeading(index, heading.text, scope([rule.is]));
      return hit ? linked(heading, hit) : decide(heading, rule.is);
    }
    const hit = plain[at];
    return hit ? linked(heading, hit) : decide(heading, UNCLASSIFIED);
  });
}

export interface CoverageReport {
  readonly books: readonly {
    readonly book: string;
    readonly edition: string;
    readonly verdicts: readonly Verdict[];
  }[];
  readonly entities: readonly Entity[];
  readonly issues: readonly Issue[]; // unreadable coverage files and links to nothing
}

// Reads every book's library under the roots, and every rules entity, and classifies each heading.
export async function checkCoverage(
  storage: Pick<Storage, "read" | "list">,
  roots: readonly string[],
  catalog: Catalog,
  systems: readonly GameSystem[],
): Promise<CoverageReport> {
  const issues: Issue[] = [];
  const editionOf = (plugin: string): string | undefined => {
    const manifest = catalog.plugins.get(plugin)?.manifest;
    if (!manifest) return undefined;
    const system = systems.find((item) => item.id === manifest.system.id);
    return system?.edition?.(manifest) ?? manifest.edition ?? "";
  };

  const lore = new Set(
    systems.flatMap((system) =>
      Object.values(system.contentKinds)
        .filter((kind) => kind.lore)
        .map((kind) => kind.idPrefix),
    ),
  );
  const entities: Entity[] = [];
  for (const [plugin, record] of catalog.plugins) {
    if (record.manifest.kind !== "rules") continue;
    const edition = editionOf(plugin) ?? "";
    for (const file of record.files) {
      if (!/^[^/]+\/[^/]+\.yaml$/.test(file)) continue;
      const raw: unknown = parse(
        (await storage.read(`${record.root}/${file}`)) ?? "",
      );
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        const entry = item as {
          id?: unknown;
          name?: unknown;
          library?: unknown;
          about?: unknown;
        } | null;
        if (typeof entry?.id !== "string") continue;
        const kind = /^[^:]+:([^/]+)\//.exec(entry.id)?.[1] ?? "";
        const ids = (list: unknown): string[] =>
          Array.isArray(list)
            ? list.filter((id) => typeof id === "string")
            : [];
        entities.push({
          id: entry.id,
          plugin,
          kind,
          name: typeof entry.name === "string" ? entry.name : "",
          edition,
          library: ids(entry.library),
          about: ids(entry.about),
          lore: lore.has(kind),
        });
      }
    }
  }
  // Each value the engine plays names an entity, once the books hold any of its kind.
  for (const system of systems) {
    for (const kind of Object.values(system.contentKinds)) {
      const names = new Set(
        entities
          .filter((entity) => entity.kind === kind.idPrefix)
          .map((entity) => entity.id.slice(entity.id.indexOf("/") + 1)),
      );
      if (names.size === 0) continue;
      for (const key of (kind.keys ?? []).filter((item) => !names.has(item)))
        issues.push({
          plugin: system.id,
          file: null,
          message: `${kind.idPrefix} "${key}", which the system plays, has no entity in any book`,
        });
    }
  }
  const index = indexEntities(entities);
  const linkedBy = new Map<string, string>();
  for (const entity of entities) {
    for (const id of entity.library) linkedBy.set(id, entity.id);
  }

  const books: CoverageReport["books"][number][] = [];
  const known = new Set<string>();
  for (const root of roots) {
    const files = new Map<string, string[]>();
    for (const { path } of await storage.list(`${root}/library`)) {
      const found = /\/library\/([^/]+)\/([^/]+\.md)$/.exec(path);
      if (found?.[1] && found[2])
        files.set(found[1], [...(files.get(found[1]) ?? []), found[2]]);
    }
    for (const [book, names] of [...files].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const path = `${root}/coverage/${book}.yaml`;
      const text = await storage.read(path);
      let coverage: CoverageFile | null = null;
      if (text !== null) {
        const parsed = CoverageFileSchema.safeParse(parse(text));
        if (parsed.success) coverage = parsed.data;
        else issues.push(...zodIssues(book, path, parsed.error));
      }
      const headings: Heading[] = [];
      for (const name of names.sort()) {
        const markdown = await storage.read(`${root}/library/${book}/${name}`);
        headings.push(...headingsOf(book, name, markdown ?? ""));
      }
      for (const heading of headings) known.add(heading.id);
      const edition = coverage?.edition ?? editionOf(book) ?? "";
      books.push({
        book,
        edition,
        verdicts: classifyBook(
          { book, edition, coverage, headings },
          index,
          linkedBy,
        ),
      });
      for (const [heading, ids] of Object.entries(coverage?.links ?? {})) {
        if (!known.has(heading))
          issues.push({
            plugin: book,
            file: path,
            message: `links ${heading}, which no heading has`,
          });
        for (const id of ids.filter((item) => !index.byId.has(item)))
          issues.push({
            plugin: book,
            file: path,
            message: `links ${heading} to ${id}, which no entity has`,
          });
      }
    }
  }
  for (const entity of entities) {
    for (const id of entity.library.filter((item) => !known.has(item)))
      issues.push({
        plugin: entity.plugin,
        file: null,
        message: `${entity.id} names library heading ${id}, which no book has`,
      });
    for (const id of entity.about.filter((item) => !index.byId.has(item)))
      issues.push({
        plugin: entity.plugin,
        file: null,
        message: `${entity.id} rules on ${id}, which no entity has`,
      });
  }
  return { books, entities, issues };
}

// One line per book, then the missing headings by the kind of entity each should have.
export function formatCoverage(report: CoverageReport): string[] {
  const count = (verdicts: readonly Verdict[], status: Status) =>
    verdicts.filter((verdict) => verdict.status === status).length;
  const byKind = (verdicts: readonly Verdict[]) => {
    const kinds = new Map<string, number>();
    for (const { status, kind } of verdicts)
      if (status === "missing") kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    return [...kinds]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([kind, n]) => `${kind} ${String(n)}`)
      .join(", ");
  };
  const all = report.books.flatMap((book) => book.verdicts);
  const sums = (verdicts: readonly Verdict[]) =>
    `${String(verdicts.length)} headings: ${String(count(verdicts, "linked"))} linked, ${String(count(verdicts, STRUCTURAL))} structural, ${String(count(verdicts, "missing"))} missing`;
  return [
    `Library coverage, ${String(report.books.length)} books, ${sums(all)}`,
    ...report.books.map(({ book, verdicts }) => {
      const missing = byKind(verdicts);
      return `  ${book}: ${sums(verdicts)}${missing ? ` (${missing})` : ""}`;
    }),
    ...(all.length > 0 ? [`Missing by kind: ${byKind(all) || "none"}`] : []),
  ];
}
