import type { Board, BoardHost } from "./system-ui.ts";
import type { AdventureChoice, Game, SaveChoice } from "./session.ts";
import { el } from "./dom.ts";

// What every screen shares: the game, the page's fixed parts, the state the screens hand each other, and
// the way to move between screens. mountShell makes it once; each screen takes it.

export const OPENING = "Opening the book…";
export const CANT_OPEN = "This adventure couldn't be opened.";
export const CANT_LOAD =
  "This save couldn't be opened. It may be damaged, or from an older version of the adventure.";
const BUSY_AFTER_MS = 300; // a step quicker than this shows no overlay, so it doesn't flicker

// A system's own encounter view, such as a combat board, keyed by system id. It draws its own DOM in the slot,
// and may add an entry to the game menu with the dialog it opens, for the system's own settings.
export interface PageBoard extends Board {
  readonly menu?: {
    readonly item: HTMLButtonElement;
    readonly dialog: HTMLDialogElement;
  };
}
export type BoardFactory = (slot: HTMLElement, host: BoardHost) => PageBoard;

export interface ActOptions {
  readonly busy?: string;
  readonly failed?: string;
}

export interface ShellContext {
  readonly root: HTMLElement;
  readonly game: Game;
  readonly boards: Readonly<Record<string, BoardFactory>>;
  readonly credits: readonly string[]; // the app's own, such as for its fonts
  readonly cardSound: (() => void) | undefined; // played as a card such as treasure found appears, when sound is on
  readonly notice: HTMLElement;
  readonly busyText: HTMLElement;
  readonly busy: HTMLElement; // the busy overlay, outside the inert root so a screen reader still hears it
  readonly screen: HTMLElement;
  readonly actions: HTMLElement; // the top bar's buttons
  sayTimer: ReturnType<typeof setTimeout> | undefined;
  // Keys for the whole page, such as Esc for Back, handled by the screen that owns them while it's shown.
  // `handle` says whether it used the key. Typing in a field and a busy page keep their keys.
  keys: {
    readonly owner: HTMLElement;
    readonly handle: (event: KeyboardEvent) => boolean;
  } | null;
  currentMenu: HTMLDetailsElement | null; // the game's menu, closed by a click anywhere outside it
  // Redrawing removes the button that had focus, so keyboard play needs it put somewhere new.
  focusNext: HTMLElement | null;
  // Each bound to this context once, so a screen can pass one on and compare it, as Load's Back does.
  readonly say: (text: string, isError?: boolean, detail?: string) => void;
  readonly act: (work: () => Promise<void>, options?: ActOptions) => void;
  readonly showSetup: (adventure: AdventureChoice) => Promise<void>;
  readonly showMenu: () => Promise<void>;
  readonly resume: (save: SaveChoice) => void;
  readonly showLoad: (back: () => void | Promise<void>) => Promise<void>;
  readonly showLibrary: (books: readonly string[]) => Promise<void>;
  // Opened at a section, and with a way back to the game, when a rules term's "More" asks for it.
  readonly showBook: (
    books: readonly string[],
    id: string,
    at?: { readonly file: string; readonly back: () => void },
  ) => Promise<void>;
  readonly showGame: () => void;
}

// Errors stay until the next action; anything else clears itself, unless something newer replaced it.
// `detail` is the error as the game gave it, folded away under the friendly line.

export function say(
  ctx: ShellContext,
  text: string,
  isError = false,
  detail = "",
): void {
  clearTimeout(ctx.sayTimer);
  ctx.notice.setAttribute("role", isError ? "alert" : "status");
  ctx.notice.replaceChildren(
    ...(text ? [el("span", { text })] : []),
    ...(text && detail
      ? [
          el(
            "details",
            {},
            el("summary", { text: "Details" }),
            el("pre", { text: detail }),
          ),
        ]
      : []),
  );
  ctx.notice.classList.toggle("error", isError);
  if (text && !isError) {
    ctx.sayTimer = setTimeout(() => {
      if (ctx.notice.textContent === text) ctx.say("");
    }, 3000);
  }
}

// Blocks input while a step is saving, so one click can't answer two decisions. A slow step shows
// `busy` after a moment; a failed one shows `failed`, with what went wrong under Details.
export function act(
  ctx: ShellContext,
  work: () => Promise<void>,
  { busy: waiting = "One moment…", failed = "" } = {},
): void {
  // Going inert drops focus, so a button that survives the work (Save) gets it back.
  const previous = document.activeElement;
  ctx.root.inert = true;
  ctx.root.setAttribute("aria-busy", "true");
  const slow = setTimeout(() => {
    if (!waiting) return; // the screen draws its own placeholder
    ctx.busyText.textContent = waiting;
    ctx.busy.hidden = false;
  }, BUSY_AFTER_MS);
  ctx.say("");
  work()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (failed) ctx.say(failed, true, message);
      else if (message.includes("\n"))
        ctx.say("Something went wrong.", true, message);
      else ctx.say(message, true);
    })
    .finally(() => {
      clearTimeout(slow);
      ctx.busy.hidden = true;
      ctx.root.removeAttribute("aria-busy");
      ctx.root.inert = false;
      if (ctx.focusNext) ctx.focusNext.focus();
      else if (previous instanceof HTMLElement) previous.focus();
      ctx.focusNext = null;
    });
}
