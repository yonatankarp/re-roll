// Rulings (#130): what each Sage Advice answer or erratum rules on, found by code from where the book
// puts it and the names it prints, and the reader's index of rulings beside each section they rule on.
import { WORLD_KINDS } from "../kernel/world.ts";
import {
  type Entity,
  type EntityIndex,
  type Verdict,
  matchHeading,
  singular,
  slug,
} from "./coverage.ts";

// Lore, tables, Bastion orders ("Attack") and other rulings aren't what a ruling is about.
const NOT_SUBJECTS = new Set([
  ...Object.values(WORLD_KINDS).map((kind) => kind.idPrefix),
  "table",
  "lookup",
  "budget",
  "bastion",
]);
const subject = (entity: Entity) => !NOT_SUBJECTS.has(entity.kind);
// The kinds a section of questions is about ("Barbarian", "Charger"), unlike a feature that shares
// a section's name ("Spellcasting").
const SECTIONS = new Set([
  "class",
  "subclass",
  "feat",
  "species",
  "background",
]);
const bare = (entity: Entity) => slug(entity.name.replace(/\([^)]*\)/g, ""));

// The word after a name that says what kind it is: "the Wish spell", "a Shield item".
const HINTS: Readonly<Record<string, readonly string[]>> = {
  spell: ["spell"],
  cantrip: ["spell"],
  ritual: ["spell"],
  feat: ["feat"],
  feature: ["feature"],
  trait: ["feature", "species"],
  class: ["class"],
  subclass: ["subclass"],
  weapon: ["item"],
  armor: ["item"],
  background: ["background"],
  species: ["species"],
  race: ["species"],
};
const JOINERS = new Set(["of", "the", "and", "to", "a", "an", "in", "from"]);
const MAX_WORDS = 6;
const capital = (word: string) => /^[\p{Lu}\d+]/u.test(word);

// The entities a ruling's question names, as a reader would spot them: a run of capitalized words
// ("Ring of Protection", "Reckless Attack"), any words before "spell" ("the guidance spell"), or
// lower-case words that are a whole name ("bracers of defense").
export function mentions(
  index: EntityIndex,
  text: string,
  edition: string,
  terms: ReadonlySet<string> = new Set(), // rules terms' names, by slug ("resistance")
): string[] {
  const found = new Set<string>();
  let first = true; // a sentence's first word is capitalized anyway
  for (const clause of text.split(/[.,;:?!“”"()—–]/)) {
    const words = clause
      .replace(/[’']s\b/g, "")
      .split(/[\s/]+/)
      .filter(Boolean);
    for (let at = 0; at < words.length;) {
      let taken = 1;
      for (
        let size = Math.min(MAX_WORDS, words.length - at);
        size > 0;
        size--
      ) {
        const run = words.slice(at, at + size);
        const next = (words[at + size] ?? "").toLowerCase();
        const kinds = HINTS[next];
        const named =
          capital(run[0] ?? "") &&
          capital(run.at(-1) ?? "") &&
          run.every((word) => capital(word) || JOINERS.has(word)) &&
          !(first && at === 0 && size === 1);
        // Lower-case words name an entity only when they are its whole name, as the 2014 books print them.
        const plain =
          !named &&
          !kinds?.includes("spell") &&
          size > 1 &&
          !JOINERS.has(run[0] ?? "") &&
          !JOINERS.has(run.at(-1) ?? "");
        if (!named && !plain && !kinds?.includes("spell")) continue;
        const key = slug(run.join(" "));
        const keys = plain ? [key] : [key, singular(key)];
        const hits = [
          ...(index.bySlug.get(key) ?? []),
          ...(index.bySlug.get(singular(key)) ?? []),
        ].filter(
          (entity) =>
            entity.edition === edition &&
            subject(entity) &&
            (!kinds || kinds.includes(entity.kind)) &&
            keys.includes(bare(entity)),
        );
        // A rules term's name is the term, not the spell that shares it ("Resistance"), unless hinted.
        if (hits.length === 0 || (!kinds && keys.some((k) => terms.has(k))))
          continue;
        // "Spell Scroll" names the scroll, not each "Spell Scroll (Wish)", where the scroll itself exists.
        const whole = hits.filter((hit) => keys.includes(slug(hit.name)));
        for (const hit of whole.length > 0 ? whole : hits) found.add(hit.id);
        taken = size;
        break;
      }
      at += taken;
    }
    first = false;
  }
  return [...found];
}

export interface BookRef {
  readonly plugin: string;
  readonly edition: string;
}

// What the ruling at `at` rules on. An erratum names its entry, inside the book its top heading names
// (`bookOf` gives null for a book the library doesn't have, and undefined for a heading that isn't a
// book). A question rules on the entity its section is about, and on those it names.
export function subjectsOf(
  verdicts: readonly Verdict[], // the ruling book's, in reading order
  at: number,
  edition: string, // the ruling book's
  index: EntityIndex,
  bookOf: (title: string) => BookRef | null | undefined,
  terms: ReadonlySet<string> = new Set(),
): string[] {
  const verdict = verdicts[at];
  if (!verdict) return [];
  const above: Verdict[] = [];
  for (let i = at - 1, depth = verdict.heading.level; i >= 0; i -= 1) {
    const item = verdicts[i];
    if (!item || item.heading.level >= depth) continue;
    depth = item.heading.level;
    above.push(item);
  }
  const top = above.at(-1);
  const book = top?.heading.level === 1 ? bookOf(top.heading.text) : undefined;
  if (book !== undefined) {
    const name = slug(verdict.heading.text.replace(/\s*\([^)]*\)$/, ""));
    // Missing books, and rules terms ("Darkvision (p. 183)"), have no entity to link yet.
    if (book === null || terms.has(singular(name))) return [];
    const hit = matchHeading(index, verdict.heading.text, {
      book: book.plugin,
      edition: book.edition,
      kinds: null,
      asked: false, // by its name, not a feature's that ends with it ("Athlete")
      adventure: null,
    });
    return hit && subject(hit) ? [hit.id] : [];
  }
  const section = above.find((item) => item.status === "linked")?.entity;
  const owner = section === undefined ? undefined : index.byId.get(section);
  return [
    ...new Set([
      ...(owner && SECTIONS.has(owner.kind) ? [owner.id] : []),
      ...mentions(index, verdict.heading.text, edition, terms),
    ]),
  ];
}

export interface RulingRef {
  readonly book: string;
  readonly file: string;
  readonly heading: string; // the ruling's heading, to find it in its file
}

// For each ruling book, the sections ("<book>/<file>") its rulings rule on, and those rulings.
export function rulingIndex(
  rulings: readonly Pick<Entity, "plugin" | "library" | "about">[],
  verdicts: readonly Verdict[], // every book's
): Map<string, Record<string, RulingRef[]>> {
  const headings = new Map(
    verdicts.map((item) => [item.heading.id, item.heading]),
  );
  const sections = new Map<string, Set<string>>();
  // Not beside a ruling book's own headings, which group the rulings already.
  const own = new Set(rulings.map((ruling) => ruling.plugin));
  for (const { heading, status, entity } of verdicts) {
    if (status !== "linked" || entity === undefined || own.has(heading.book))
      continue;
    const key = `${heading.book}/${heading.file}`;
    sections.set(entity, (sections.get(entity) ?? new Set()).add(key));
  }
  const out = new Map<string, Record<string, RulingRef[]>>();
  for (const ruling of rulings) {
    const self = headings.get(ruling.library[0] ?? "");
    if (!self) continue;
    const ref = { book: self.book, file: self.file, heading: self.text };
    const keys = new Set(
      ruling.about.flatMap((id) => [...(sections.get(id) ?? [])]),
    );
    const book = out.get(ruling.plugin) ?? {};
    for (const key of [...keys].sort()) (book[key] ??= []).push(ref);
    out.set(ruling.plugin, book);
  }
  return out;
}
