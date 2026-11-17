// The glossary index: which book's entity explains each of a system's rules terms (#132), and the book
// section it describes. Built by code from the entities, and holding only ids and file names, never a book's words.

export interface GlossaryEntity {
  readonly id: string; // plugin:kind/name
  readonly file: string; // inside its plugin, as "conditions/prone.yaml"
  readonly library: readonly string[]; // the headings it describes, as "phb/0123-prone#prone"
}

export interface Glossary {
  readonly system: string;
  readonly terms: Readonly<
    Record<
      string,
      {
        readonly book: string;
        readonly file: string; // the library section
        readonly entity: string; // the entity's file in the book's rules plugin
      }
    >
  >;
  readonly missing: readonly string[]; // term ids no book explains
}

// Books come best first, so the first that has the term's entity wins.
export function buildGlossary(
  system: string,
  terms: readonly {
    readonly id: string;
    readonly entity: string;
    readonly books?: readonly string[]; // in place of `books`, for this term
  }[],
  books: readonly string[],
  entities: readonly GlossaryEntity[],
): Glossary {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const out: Record<string, Glossary["terms"][string]> = {};
  const missing: string[] = [];
  for (const term of terms) {
    const hit = (term.books ?? books)
      .map((book) => ({ book, entity: byId.get(`${book}:${term.entity}`) }))
      .find(({ entity }) => entity?.library[0] !== undefined);
    const section = /^[^/]+\/([^#]+)/.exec(hit?.entity?.library[0] ?? "")?.[1];
    if (hit?.entity && section) {
      out[term.id] = {
        book: hit.book,
        file: `${section}.md`,
        entity: hit.entity.file,
      };
    } else missing.push(term.id);
  }
  return { system, terms: out, missing };
}
