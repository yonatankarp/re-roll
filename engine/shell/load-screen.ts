import { type Game, type SaveChoice, stepsText } from "./session.ts";
import { button, el, picture } from "./shell.ts";

// The Load screen: one card per save, newest first, each with its own Delete.

export interface LoadHandlers {
  readonly load: (save: SaveChoice) => void;
  // `card` is the save's card, for collapseCard once the save is gone.
  readonly remove: (save: SaveChoice, card: HTMLElement) => void;
}

const COLLAPSE_MS = 200;

// Who is playing, such as "Human Wizard · Level 1 · 6/8 HP", or null for a save from before that was kept.
function heading(save: SaveChoice): string | null {
  if (!save.character) return null;
  return [
    save.characterKind
      ? `${save.character}, ${save.characterKind}`
      : save.character,
    ...(save.level !== null ? [`Level ${String(save.level)}`] : []),
    ...(save.health ? [save.health] : []),
  ].join(" · ");
}

function card(
  game: Game,
  save: SaveChoice,
  { load, remove }: LoadHandlers,
  showCurrent: boolean,
): HTMLElement {
  const who = heading(save);
  // A save without a character still says its level beside its settings, as before.
  const facts = [
    ...(!who && save.level !== null ? [`Level ${String(save.level)}`] : []),
    ...save.settings,
  ].join(" · ");
  const current = showCurrent && save.current;
  const when = el("small", {
    text: `${save.kind === "autosave" ? "Autosave" : "Saved"} · ${save.ago ?? save.when ?? stepsText(save.steps)}`,
  });
  if (save.when) when.title = save.when;
  const open = button("", () => {
    load(save);
  });
  open.className = "save-open";
  open.append(
    ...(save.art ? [picture(game, save.art, "", "save-art")] : []),
    el(
      "span",
      { class: "save-text" },
      el("strong", { text: who ?? save.title }),
      ...(who
        ? [el("span", { class: "save-adventure", text: save.title })]
        : []),
      ...(save.scene ? [el("span", { text: save.scene })] : []),
      ...(facts ? [el("span", { class: "save-facts", text: facts })] : []),
      el(
        "span",
        { class: "save-when" },
        when,
        ...(current
          ? [el("span", { class: "save-current", text: "Current" })]
          : []),
      ),
    ),
  );
  open.setAttribute(
    "aria-label",
    `Load ${save.label}${who ? `, ${who}` : ""}${current ? ", the game in progress" : ""}`,
  );
  // A second press confirms, which also works where the webview has no confirm dialog.
  let armed = false;
  const disarm = (): void => {
    armed = false;
    del.textContent = "Delete";
    del.classList.remove("armed");
    del.setAttribute("aria-label", `Delete ${save.label}`);
  };
  const item = el("li", { class: "save-card" }, open);
  const del = button("Delete", () => {
    if (!armed) {
      armed = true;
      del.textContent = "Really delete?";
      del.classList.add("armed");
      del.setAttribute("aria-label", `Confirm delete ${save.label}`);
      return;
    }
    remove(save, item);
  });
  del.className = "save-delete";
  disarm();
  del.addEventListener("blur", disarm);
  // Esc takes back an armed Delete; otherwise it goes on to the screen, where it means Back.
  del.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && armed) {
      event.stopPropagation();
      disarm();
    }
  });
  item.append(del);
  return item;
}

export function loadScreen(
  game: Game,
  saves: readonly SaveChoice[],
  handlers: LoadHandlers,
  showCurrent: boolean, // opened from a game, so its own autosave is marked
): { readonly node: HTMLElement; readonly heading: HTMLElement } {
  const title = el("h2", { text: "Load a game" });
  title.tabIndex = -1;
  const list = el(
    "ol",
    { class: "save-cards" },
    ...saves.map((save, index) => {
      const item = card(game, save, handlers, showCurrent);
      item.style.setProperty("--i", String(Math.min(index, 12)));
      return item;
    }),
  );
  return {
    heading: title,
    node: el(
      "section",
      { class: "menu load" },
      title,
      saves.length > 0
        ? list
        : el("p", { class: "muted", text: "No saved games yet." }),
    ),
  };
}

// Folds a deleted save's card away where it was, and gives back what should take focus next:
// the next card, else the one before, else the screen's heading.
export async function collapseCard(item: HTMLElement): Promise<HTMLElement> {
  const list = item.parentElement;
  const neighbour = (
    item.nextElementSibling ?? item.previousElementSibling
  )?.querySelector<HTMLElement>(".save-open");
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    item.style.overflow = "hidden";
    await item
      .animate(
        [
          { height: `${String(item.offsetHeight)}px`, opacity: 1 },
          { height: "0px", opacity: 0, marginTop: "-10px" },
        ],
        { duration: COLLAPSE_MS, easing: "ease-in" },
      )
      .finished.catch(() => undefined);
  }
  item.remove();
  const screen = list?.closest("section");
  if (list?.children.length === 0) {
    list.replaceWith(el("p", { class: "muted", text: "No saved games yet." }));
  }
  return neighbour ?? screen?.querySelector<HTMLElement>("h2") ?? document.body;
}
