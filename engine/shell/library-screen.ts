import { OPENING, type ShellContext } from "./context.ts";
import { button, el } from "./dom.ts";

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
  const drawContents = (): void => {
    const wanted = search.value.trim().toLowerCase();
    // shortcut: only the first matches are drawn, which is plenty once a search narrows them.
    const matches = book.sections
      .filter((section) => section.heading.toLowerCase().includes(wanted))
      .slice(0, 300);
    contents.replaceChildren(
      ...matches.map((section) => {
        const open = button(section.heading, () => {
          ctx.act(async () => {
            text.textContent = await ctx.game.readSection(id, section.file);
            ctx.focusNext = text;
          });
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
      el("div", { class: "book-layout" }, contents, text),
    ),
  );
  ctx.focusNext = heading;
  if (at) {
    text.textContent = await ctx.game.readSection(id, at.file);
    ctx.focusNext = text;
  }
}
