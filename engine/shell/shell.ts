import type { Game } from "./session.ts";
import { type BoardFactory, type ShellContext, act, say } from "./context.ts";
import { el } from "./dom.ts";
import { showGame } from "./game-screen.ts";
import { wireKeys } from "./keys.ts";
import { showBook, showLibrary } from "./library-screen.ts";
import { resume, showLoad, showMenu } from "./menu-screen.ts";
import { showSetup } from "./setup-screen.ts";

// An open book whose right page turns, for the busy overlay.
const BOOK_ICON =
  '<svg viewBox="0 0 64 40" width="72" height="45" aria-hidden="true">' +
  '<path class="busy-cover" d="M1 5 32 9 63 5v31l-31 4-31-4z"/>' +
  '<path class="busy-leaf" d="M4 7l27 4v26L4 34z"/>' +
  '<path class="busy-leaf" d="M33 11l27-4v27l-27 3z"/>' +
  '<path class="busy-leaf busy-turn" d="M33 11l27-4v27l-27 3z"/>' +
  "</svg>";

// The whole page, drawn from the plain data in GameView. Knows nothing about any rule system.

export function mountShell(
  root: HTMLElement,
  game: Game,
  boards: Readonly<Record<string, BoardFactory>> = {},
  credits: readonly string[] = [], // the app's own, such as for its fonts
  cardSound?: () => void, // played as a card such as treasure found appears, when sound is on
): void {
  const notice = el("div", { class: "notice" });
  notice.setAttribute("role", "status");
  // It hangs over the page, so a click (or Esc, for an error) puts it away, except on its details.
  notice.title = "Click to dismiss";
  notice.addEventListener("click", (event) => {
    if (!(event.target as Element).closest("details")) ctx.say("");
  });
  // The busy overlay, shown when a step takes long enough to look stuck. It sits outside the inert root,
  // so a screen reader still hears it.
  const busyText = el("p");
  const book = el("span", { class: "busy-book" });
  book.innerHTML = BOOK_ICON;
  const busy = el("div", { class: "busy" }, book, busyText);
  busy.setAttribute("role", "status");
  busy.hidden = true;
  document.body.append(busy);
  const screen = el("div", { class: "screen" });
  root.replaceChildren(
    el(
      "header",
      { class: "top" },
      el(
        "div",
        { class: "bar" },
        el("h1", { text: "Re-roll" }),
        el("nav", { class: "bar-actions" }),
      ),
      notice,
    ),
    screen,
  );
  const actions = root.querySelector("nav");
  if (!actions) throw new Error("The page header is missing");
  const ctx: ShellContext = {
    root,
    game,
    boards,
    credits,
    cardSound,
    notice,
    busyText,
    busy,
    screen,
    actions,
    sayTimer: undefined,
    keys: null,
    currentMenu: null,
    focusNext: null,
    say: (text, isError, detail) => {
      say(ctx, text, isError, detail);
    },
    act: (work, options) => {
      act(ctx, work, options);
    },
    showSetup: (adventure) => showSetup(ctx, adventure),
    showMenu: () => showMenu(ctx),
    resume: (save) => {
      resume(ctx, save);
    },
    showLoad: (back) => showLoad(ctx, back),
    showLibrary: (books) => showLibrary(ctx, books),
    showBook: (books, id) => showBook(ctx, books, id),
    showGame: () => {
      showGame(ctx);
    },
  };
  wireKeys(ctx);

  ctx.act(ctx.showMenu);
}
