import type { ShellContext } from "./context.ts";

// Shortcuts show ⌘ on a Mac and Ctrl elsewhere; the key handler takes either, and says so.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = MAC ? "⌘" : "Ctrl+";
export const keyshortcuts = (key: string): string =>
  `Control+${key} Meta+${key}`;

// The letter a shortcut means: the one the layout types, or, on a layout without Latin letters (Hebrew,
// Cyrillic, Greek), the key in that place on a US keyboard, so Ctrl+S still saves.
export const letterOf = (event: KeyboardEvent): string => {
  const key = event.key.toLowerCase();
  return /^[a-z]$/.test(key)
    ? key
    : (/^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() ?? key);
};

export function wireKeys(ctx: ShellContext): void {
  // Esc puts an error away first, before it means Back.
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      !ctx.notice.classList.contains("error") ||
      !ctx.notice.hasChildNodes() ||
      document.querySelector("dialog[open]")
    ) {
      return;
    }
    event.preventDefault();
    ctx.say("");
  });
  // Keys for the whole page go to the screen that owns them while it's shown (ShellContext.keys).
  document.addEventListener("keydown", (event) => {
    const { target } = event;
    if (
      !ctx.keys?.owner.isConnected ||
      ctx.root.inert ||
      event.defaultPrevented ||
      (target instanceof HTMLElement &&
        (target.isContentEditable || target.matches("input, textarea, select")))
    ) {
      return;
    }
    if (ctx.keys.handle(event)) event.preventDefault();
  });
  // A click anywhere outside the game's menu closes it, as a menu does.
  document.addEventListener("click", (event) => {
    if (
      ctx.currentMenu?.open &&
      !ctx.currentMenu.contains(event.target as Node)
    ) {
      ctx.currentMenu.open = false;
    }
  });

  // Number keys pick the story's numbered choices, as a reader turns to an entry. Never in a fight,
  // in a text field, with a drawer open or while the choices are held back.
  document.addEventListener("keydown", (event) => {
    // By the key's place too, as AZERTY's top row types &é" unshifted.
    const digit = /^[1-9]$/.test(event.key)
      ? event.key
      : /^Digit([1-9])$/.exec(event.code)?.[1];
    if (!digit || event.repeat) return;
    const index = Number(digit) - 1;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if ((event.target as Element).closest("input, textarea, select")) return;
    if (ctx.root.inert || document.querySelector("dialog[open]")) return;
    const story = ctx.screen.querySelector<HTMLElement>(
      ".rail > .options.story",
    );
    if (!story || story.closest("[inert]")) return;
    const picks = story.querySelectorAll<HTMLElement>(
      ".option > button:first-child",
    );
    const pick = picks[index];
    if (!pick) return;
    event.preventDefault();
    pick.click();
  });
}
