import type { AdventureChoice, Game } from "./session.ts";
import { button, el, picture } from "./shell.ts";

// The main menu's adventures, one book cover each. The title plate sits under the cover,
// so an adventure with no cover, or one that won't load, still shows a designed card.

export interface Resume {
  readonly label: string;
  readonly go: () => void;
}

export function adventureCard(
  game: Game,
  adventure: AdventureChoice,
  start: () => void,
  resume: Resume | null,
): HTMLElement {
  const open = button("", start);
  open.className = "cover-open";
  open.append(
    el(
      "span",
      { class: "cover-art" },
      el("span", { class: "cover-plate", text: adventure.title }),
      // The button's label names the adventure, so the picture needs no words of its own.
      ...(adventure.cover
        ? [picture(game, adventure.cover, "", "cover-image")]
        : []),
    ),
    el("strong", { class: "cover-title", text: adventure.title }),
    ...(adventure.levels
      ? [el("span", { class: "meta", text: `Levels ${adventure.levels}` })]
      : []),
  );
  open.setAttribute(
    "aria-label",
    adventure.levels
      ? `${adventure.title}, levels ${adventure.levels}`
      : adventure.title,
  );
  const node = el("div", { class: "cover-card" }, open);
  if (resume) {
    const again = button("Resume", resume.go);
    again.className = "cover-resume";
    again.setAttribute(
      "aria-label",
      `Resume ${resume.label}`,
    );
    node.append(again);
  }
  node.dataset.title = adventure.title.toLowerCase();
  return node;
}

export function adventureGrid(cards: readonly HTMLElement[]): HTMLElement {
  cards.forEach((card, index) => {
    card.style.setProperty("--i", String(index));
  });
  return el("div", { class: "covers" }, ...cards);
}
