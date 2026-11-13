import { type Game, type GameView } from "./session.ts";

// Small DOM helpers the shell's screens share.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { readonly class?: string; readonly text?: string } = {},
  ...children: readonly Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  node.append(...children);
  return node;
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", { text: label });
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// A picture that is missing or won't load shows nothing at all.
export function picture(
  game: Game,
  path: string,
  alt: string,
  className: string,
): HTMLImageElement {
  const image = el("img", { class: className });
  if (game.isCover(path)) image.classList.add("is-cover");
  image.alt = alt;
  image.loading = "lazy";
  image.addEventListener("error", () => {
    image.remove();
  });
  void Promise.resolve(game.imageUrl(path)).then((url) => {
    if (url) image.src = url;
    else image.remove();
  });
  return image;
}

// The picture for the first of a card's or a row's looks that has one, or else its book's cover.
export function lookArt(
  view: GameView,
  looks: readonly string[] | undefined,
): string | undefined {
  return (
    looks?.map((look) => view.itemArt[look]).find(Boolean) ??
    looks?.map((look) => view.coverArt?.[look]).find(Boolean)
  );
}

// A redraw must not close what the player has opened to read.
export function replaceKeepingOpen(
  container: HTMLElement,
  ...nodes: Node[]
): void {
  const opened = new Set(
    [...container.querySelectorAll("details[open] > summary")].map(
      (item) => item.textContent,
    ),
  );
  container.replaceChildren(...nodes);
  for (const item of container.querySelectorAll("details")) {
    item.open = opened.has(item.querySelector("summary")?.textContent ?? "");
  }
}

// Restarts a CSS entrance animation on a node that stays in the page.
export function enter(node: HTMLElement): void {
  node.classList.remove("enter");
  node.getBoundingClientRect(); // a reflow, so the animation starts again
  node.classList.add("enter");
}
