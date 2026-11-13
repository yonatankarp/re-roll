import { type Game } from "./session.ts";
import { el, enter, picture } from "./dom.ts";

// A book's full picture laid over the page for a moment, as turning to a plate: a foe met for the first
// time, or a chapter's title page. Only the page shows it, so nothing reaches the log and saves stay
// the same. It leaves on a click, on Esc, or when the player answers, and never takes focus, so the
// keys stay with the choices and the board.
export interface ArtPlate {
  readonly element: HTMLElement;
  readonly show: (
    game: Game,
    plate: {
      readonly kind: "foe" | "chapter";
      readonly kicker: string; // a small line over the title, such as "A foe appears"
      readonly title: string;
      readonly pictures: readonly {
        readonly path: string;
        readonly alt: string;
      }[];
    },
  ) => void;
  readonly close: () => void;
}

export function artPlate(): ArtPlate {
  const element = el("section", { class: "art-plate" });
  element.hidden = true;
  element.setAttribute("role", "status"); // read out as it appears
  const close = (): void => {
    element.hidden = true;
    element.replaceChildren();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  element.addEventListener("click", close);
  return {
    element,
    close,
    show(game, { kind, kicker, title, pictures }) {
      element.dataset.kind = kind;
      element.replaceChildren(
        el(
          "figure",
          {},
          el(
            "div",
            { class: "plate-pictures" },
            ...pictures.map(({ path, alt }) =>
              picture(game, path, alt, "plate-art"),
            ),
          ),
          el(
            "figcaption",
            {},
            el("span", { class: "plate-kicker", text: kicker }),
            el("strong", { class: "plate-title", text: title }),
            el("span", { class: "plate-hint", text: "Click to continue" }),
          ),
        ),
      );
      element.hidden = false;
      enter(element);
      document.addEventListener("keydown", onKey, true);
    },
  };
}

// Plates already shown, per run: each foe kind and chapter once, however often the page is drawn again,
// such as after an undo. Kept by the page alone, so a reload may show one again.
let seen: { run: string; keys: Set<string> } = { run: "", keys: new Set() };

// Those not shown before in the run, and marks them shown. `quiet` marks them without returning them,
// for a game shown as it stands, such as one just loaded.
export function unseen<T extends { readonly key: string }>(
  run: string,
  items: readonly T[],
  quiet: boolean,
): T[] {
  if (seen.run !== run) seen = { run, keys: new Set() };
  const fresh = items.filter(
    (item, index) =>
      !seen.keys.has(item.key) &&
      items.findIndex((other) => other.key === item.key) === index,
  );
  for (const item of fresh) seen.keys.add(item.key);
  return quiet ? [] : fresh;
}
