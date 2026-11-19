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

// A button for something that can't be undone: the first press arms it, the second does it. Works where
// the webview has no confirm dialog. Leaving it, or Esc, takes the press back.
export function confirmButton(
  label: string,
  name: string, // what it acts on, read out, as "Delete Sera's save"
  onConfirm: () => void,
): HTMLButtonElement {
  let armed = false;
  const disarm = (): void => {
    armed = false;
    node.textContent = label;
    node.classList.remove("armed");
    node.setAttribute("aria-label", `${label} ${name}`);
  };
  const node = button(label, () => {
    if (!armed) {
      armed = true;
      node.textContent = `Really ${label.toLowerCase()}?`;
      node.classList.add("armed");
      node.setAttribute("aria-label", `Confirm ${label.toLowerCase()} ${name}`);
      // WebKit doesn't focus a clicked button, and without focus Esc and leaving can't take it back.
      node.focus();
      return;
    }
    onConfirm();
  });
  disarm();
  node.addEventListener("blur", disarm);
  // Its own press mustn't blur it, as WebKit's mousedown does: the blur's new text loses the click.
  node.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && armed) {
      event.stopPropagation();
      disarm();
    }
  });
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
