import type { Game, SaveChoice } from "./session.ts";
import { button, el, picture } from "./shell.ts";

// The Load screen: one card per save, newest first, each with its own Delete.

export interface LoadHandlers {
  readonly load: (save: SaveChoice) => void;
  readonly remove: (save: SaveChoice) => void;
}

function card(
  game: Game,
  save: SaveChoice,
  { load, remove }: LoadHandlers,
): HTMLElement {
  const facts = [
    ...(save.level !== null ? [`Level ${String(save.level)}`] : []),
    ...save.settings,
  ].join(" · ");
  const open = button("", () => {
    load(save);
  });
  open.className = "save-open";
  open.append(
    ...(save.art ? [picture(game, save.art, "", "save-art")] : []),
    el(
      "span",
      { class: "save-text" },
      el("strong", { text: save.title }),
      ...(save.scene ? [el("span", { text: save.scene })] : []),
      ...(facts ? [el("span", { class: "save-facts", text: facts })] : []),
      el("small", {
        text: `${save.kind === "autosave" ? "Autosave" : "Saved"} · ${save.when ?? `${String(save.steps)} steps`}`,
      }),
    ),
  );
  open.setAttribute("aria-label", `Load ${save.label}`);
  // A second press confirms, which also works where the webview has no confirm dialog.
  let armed = false;
  const del = button("Delete", () => {
    if (!armed) {
      armed = true;
      del.textContent = "Really delete?";
      del.classList.add("armed");
      return;
    }
    remove(save);
  });
  del.className = "save-delete";
  del.setAttribute("aria-label", `Delete ${save.label}`);
  del.addEventListener("blur", () => {
    armed = false;
    del.textContent = "Delete";
    del.classList.remove("armed");
  });
  return el("li", { class: "save-card" }, open, del);
}

export function loadScreen(
  game: Game,
  saves: readonly SaveChoice[],
  handlers: LoadHandlers,
): { readonly node: HTMLElement; readonly heading: HTMLElement } {
  const heading = el("h2", { text: "Load a game" });
  heading.tabIndex = -1;
  const list = el(
    "ol",
    { class: "save-cards" },
    ...saves.map((save, index) => {
      const item = card(game, save, handlers);
      item.style.setProperty("--i", String(Math.min(index, 12)));
      return item;
    }),
  );
  return {
    heading,
    node: el(
      "section",
      { class: "menu load" },
      heading,
      saves.length > 0
        ? list
        : el("p", { class: "muted", text: "No saved games yet." }),
    ),
  };
}
