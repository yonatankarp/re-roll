import { OPENING, type ShellContext } from "./context.ts";
import { button, el } from "./dom.ts";
import { renderMarkdown } from "./markdown.ts";
import type { KindRef, LinkRef, RulingRef } from "./session.ts";

// The book library: a book's headings, and the text of the one chosen.

const SHOWN_HEADINGS = 300;

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
      const body = el("div", { class: "book-text" });
      const item = el(
        "details",
        { class: "book-ruling" },
        el("summary", { text: ref.heading }),
        body,
      );
      item.addEventListener("toggle", () => {
        if (!item.open || body.childNodes.length > 0) return;
        void ctx.game
          .readSection(ref.book, ref.file)
          .then((markdown) => {
            body.replaceChildren(
              ...renderMarkdown(headingPart(markdown, ref.heading)),
            );
          })
          .catch(() => {
            body.textContent = "This ruling's book can't be read.";
          });
      });
      return item;
    }),
  );
}

const RELATION: Readonly<Record<LinkRef["rel"], string>> = {
  family: "Family",
  member: "Stat block",
  lair: "Lair",
  owner: "Lair of",
};

// The sections a monster, its family and its lair are in, each opened in place (#133), another book's too (#188).
function linkRow(
  refs: readonly LinkRef[],
  open: (ref: LinkRef) => void,
): HTMLElement {
  return el(
    "nav",
    { class: "book-links" },
    ...refs.map((ref) =>
      button(`${RELATION[ref.rel]}: ${ref.heading}`, () => {
        open(ref);
      }),
    ),
  );
}

// What a section is, such as "Disease: Sewer Plague", from its kind's id (#134–#136).
function kindRow(refs: readonly KindRef[]): HTMLElement {
  return el(
    "p",
    { class: "book-kinds" },
    ...refs.map((ref) =>
      el("span", {
        text: `${ref.kind.charAt(0).toUpperCase()}${ref.kind.slice(1).replace(/-/g, " ")}: ${ref.heading}`,
      }),
    ),
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
          .catch(() => ({ id, title: bookTitle(id), broken: true })),
      ),
    )
  ).sort((a, b) => a.title.localeCompare(b.title));
  const broken = opened.filter((book) => "broken" in book);
  const heading = el("h2", { text: "Book library" });
  heading.tabIndex = -1;
  const screen = el(
    "section",
    { class: "menu" },
    heading,
    el(
      "div",
      { class: "options" },
      ...opened.flatMap((book) =>
        "broken" in book
          ? []
          : [
              button(book.title, () => {
                ctx.act(() => ctx.showBook(books, book.id), {
                  busy: OPENING,
                });
              }),
            ],
      ),
    ),
    // A book that won't open is named, so it isn't missing without a word.
    ...(broken.length > 0
      ? [
          el("p", {
            class: "empty",
            text: `${broken.map((book) => book.title).join(", ")} couldn't be opened. Its files may be damaged; install it again to fix it.`,
          }),
        ]
      : []),
    ...(opened.length === 0
      ? [el("p", { class: "empty", text: "There are no books here yet." })]
      : []),
  );
  ctx.screen.replaceChildren(screen);
  ctx.keys = {
    owner: screen,
    handle: (event) => {
      if (event.key !== "Escape") return false;
      ctx.act(ctx.showMenu);
      return true;
    },
  };
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
  const text = el("div", { class: "book-text" });
  text.tabIndex = -1;
  const kindsBox = el("div");
  const rulings = el("div");
  // A section of this book, or of another the library holds, as a family's in the Monster Manual (#188).
  const openSection = async (file: string, from = id): Promise<void> => {
    const [words, refs, all, kinds] = await Promise.all([
      ctx.game.readSection(from, file),
      ctx.game.rulings(from, file),
      ctx.game.links(from, file),
      ctx.game.kinds(from, file),
    ]);
    const links = all.filter((ref) => !ref.book || books.includes(ref.book));
    text.replaceChildren(...renderMarkdown(words));
    kindsBox.replaceChildren(...(kinds.length > 0 ? [kindRow(kinds)] : []));
    rulings.replaceChildren(
      ...(links.length > 0
        ? [
            linkRow(links, (to) => {
              ctx.act(() => openSection(to.file, to.book ?? from));
            }),
          ]
        : []),
      ...(refs.length > 0 ? [rulingDrawer(ctx, refs)] : []),
    );
    ctx.focusNext = text;
  };
  const drawContents = (): void => {
    const wanted = search.value.trim().toLowerCase();
    // Only the first matches are drawn, which is plenty once a search narrows them, and the list says so.
    const found = book.sections.filter((section) =>
      section.heading.toLowerCase().includes(wanted),
    );
    const matches = found.slice(0, SHOWN_HEADINGS);
    contents.replaceChildren(
      ...matches.map((section) => {
        const open = button(section.heading, () => {
          ctx.act(() => openSection(section.file));
        });
        open.style.marginLeft = `${String((section.depth - 1) * 12)}px`;
        return open;
      }),
      ...(found.length > matches.length
        ? [
            el("p", {
              class: "empty",
              text: `The first ${String(matches.length)} of ${String(found.length)} headings. Search to find the rest.`,
            }),
          ]
        : []),
      ...(found.length === 0
        ? [el("p", { class: "empty", text: "No heading has that in it." })]
        : []),
    );
  };
  search.addEventListener("input", drawContents);
  drawContents();
  const screen = el(
    "section",
    { class: "book" },
    heading,
    search,
    el(
      "div",
      { class: "book-layout" },
      contents,
      el("div", {}, kindsBox, text, rulings),
    ),
  );
  ctx.screen.replaceChildren(screen);
  // Esc goes back as the first button does: to the game it was opened from, else the library.
  ctx.keys = {
    owner: screen,
    handle: (event) => {
      if (event.key !== "Escape") return false;
      if (at) at.back();
      else ctx.act(() => ctx.showLibrary(books));
      return true;
    },
  };
  ctx.focusNext = heading;
  if (at) await openSection(at.file);
}
