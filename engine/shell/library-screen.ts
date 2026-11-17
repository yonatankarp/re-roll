import { OPENING, type ShellContext } from "./context.ts";
import { button, el } from "./dom.ts";
import type { RulingRef } from "./session.ts";

// The book library: a book's headings, and the text of the one chosen.

// A book's title as a reader would write it: a folder-style name such as "Project_Lamordia" gets
// spaces and capitals.
export function bookTitle(title: string): string {
  return title.includes("_") || title === title.toLowerCase()
    ? title
        .replace(/_+/g, " ")
        .replace(/(^|\s)\p{Ll}/gu, (letter) => letter.toUpperCase())
    : title;
}

// One heading's part of a section file: the heading and what follows it, up to a heading as high.
export function headingPart(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const levelOf = (line: string): number | undefined => {
    const found = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    return found ? (found[1] ?? "").length : undefined;
  };
  const textOf = (line: string) =>
    line
      .replace(/^#{1,6}\s+/, "")
      .replace(/[*_`]/g, "")
      .replace(/\s*#*\s*$/, "")
      .trim();
  const start = lines.findIndex(
    (line) => levelOf(line) !== undefined && textOf(line) === heading,
  );
  if (start < 0) return markdown;
  const level = levelOf(lines[start] ?? "") ?? 1;
  const end = lines.findIndex(
    (line, at) => at > start && (levelOf(line) ?? 7) <= level,
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

// The Sage Advice answers and errata on what a section describes, each opened in place like a drawer.
function rulingDrawer(
  ctx: ShellContext,
  refs: readonly RulingRef[],
): HTMLElement {
  return el(
    "details",
    { class: "book-rulings" },
    el("summary", { text: `Rulings (${String(refs.length)})` }),
    ...refs.map((ref) => {
      const body = el("pre", { class: "book-text" });
      const item = el(
        "details",
        { class: "book-ruling" },
        el("summary", { text: ref.heading }),
        body,
      );
      item.addEventListener("toggle", () => {
        if (!item.open || body.textContent) return;
        void ctx.game
          .readSection(ref.book, ref.file)
          .then((markdown) => {
            body.textContent = headingPart(markdown, ref.heading);
          })
          .catch(() => {
            body.textContent = "This ruling's book can't be read.";
          });
      });
      return item;
    }),
  );
}

export async function showLibrary(
  ctx: ShellContext,
  books: readonly string[],
): Promise<void> {
  ctx.actions.replaceChildren(
    button("Menu", () => {
      ctx.act(ctx.showMenu);
    }),
  );
  const opened = (
    await Promise.all(
      books.map((id) =>
        ctx.game
          .openBook(id)
          .then((book) => ({ id, title: bookTitle(book.title) }))
          .catch(() => null),
      ),
    )
  ).sort((a, b) => (a?.title ?? "").localeCompare(b?.title ?? ""));
  const heading = el("h2", { text: "Book library" });
  heading.tabIndex = -1;
  ctx.screen.replaceChildren(
    el(
      "section",
      { class: "menu" },
      heading,
      el(
        "div",
        { class: "options" },
        ...opened.flatMap((book) =>
          book
            ? [
                button(book.title, () => {
                  ctx.act(() => ctx.showBook(books, book.id), {
                    busy: OPENING,
                  });
                }),
              ]
            : [],
        ),
      ),
    ),
  );
  ctx.focusNext = heading;
}

export async function showBook(
  ctx: ShellContext,
  books: readonly string[],
  id: string,
  at?: { readonly file: string; readonly back: () => void },
): Promise<void> {
  const book = await ctx.game.openBook(id);
  ctx.actions.replaceChildren(
    ...(at
      ? [
          button("Back to the game", () => {
            at.back();
          }),
        ]
      : []),
    button("Library", () => {
      ctx.act(() => ctx.showLibrary(books));
    }),
    button("Menu", () => {
      ctx.act(ctx.showMenu);
    }),
  );
  const heading = el("h2", { text: bookTitle(book.title) });
  heading.tabIndex = -1;
  const search = el("input", { class: "search" });
  search.type = "search";
  search.placeholder = "Search headings";
  search.setAttribute("aria-label", "Search headings");
  const contents = el("nav", { class: "book-contents" });
  const text = el("pre", { class: "book-text" });
  text.tabIndex = -1;
  const rulings = el("div");
  const openSection = async (file: string): Promise<void> => {
    const [words, refs] = await Promise.all([
      ctx.game.readSection(id, file),
      ctx.game.rulings(id, file),
    ]);
    text.textContent = words;
    rulings.replaceChildren(
      ...(refs.length > 0 ? [rulingDrawer(ctx, refs)] : []),
    );
    ctx.focusNext = text;
  };
  const drawContents = (): void => {
    const wanted = search.value.trim().toLowerCase();
    // shortcut: only the first matches are drawn, which is plenty once a search narrows them.
    const matches = book.sections
      .filter((section) => section.heading.toLowerCase().includes(wanted))
      .slice(0, 300);
    contents.replaceChildren(
      ...matches.map((section) => {
        const open = button(section.heading, () => {
          ctx.act(() => openSection(section.file));
        });
        open.style.marginLeft = `${String((section.depth - 1) * 12)}px`;
        return open;
      }),
    );
  };
  search.addEventListener("input", drawContents);
  drawContents();
  ctx.screen.replaceChildren(
    el(
      "section",
      { class: "book" },
      heading,
      search,
      el(
        "div",
        { class: "book-layout" },
        contents,
        el("div", {}, text, rulings),
      ),
    ),
  );
  ctx.focusNext = heading;
  if (at) await openSection(at.file);
}
