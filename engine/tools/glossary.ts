// The glossary index: which book section explains each of a system's rules terms. Built by code from the
// library's headings, and holding only ids and file names, never a book's words.

export interface BookIndex {
  readonly plugin: string;
  readonly entries: readonly {
    readonly path: readonly string[];
    readonly file: string;
  }[];
}

export interface Glossary {
  readonly system: string;
  readonly terms: Readonly<
    Record<string, { readonly book: string; readonly file: string }>
  >;
  readonly missing: readonly string[]; // term ids no book explains
}

const SECTION = "rules glossary";

const plain = (heading: string): string =>
  heading.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

// Books come best first, so the first that has a heading wins.
export function buildGlossary(
  system: string,
  terms: readonly { readonly id: string; readonly heading: string }[],
  books: readonly BookIndex[],
): Glossary {
  const found: Record<string, { book: string; file: string }> = {};
  const missing: string[] = [];
  for (const term of terms) {
    const wanted = plain(term.heading);
    const hit = books
      .flatMap((book) =>
        book.entries
          .filter(
            ({ path }) =>
              plain(path[0] ?? "") === SECTION &&
              plain(path[path.length - 1] ?? "") === wanted,
          )
          .map(({ file }) => ({ book: book.plugin, file })),
      )
      .at(0);
    if (hit) found[term.id] = hit;
    else missing.push(term.id);
  }
  return { system, terms: found, missing };
}
