import type { Game, GameView } from "./session.ts";
import type { SheetView } from "./system-ui.ts";

// The rest between scenes: a campfire button in the top bar, and a dimmed camp scene that asks
// which rest, plays any questions the rest asks (such as spending Hit Dice), then shows what came back.
// Knows nothing about any rule system: it answers decisions and compares the sheets before and after.

const NIGHTFALL_MS = 900; // how long the fire burns before the summary, so the time passing is felt

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) item.className = className;
  item.textContent = text;
  return item;
}

function action(label: string, onClick: () => void): HTMLButtonElement {
  const item = node("button", "", label);
  item.type = "button";
  item.addEventListener("click", onClick);
  return item;
}

function rows(sheets: readonly SheetView[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const sheet of sheets) {
    for (const row of sheet.sections.flatMap((section) => section.rows)) {
      values.set(`${sheet.title}\u0000${row.label}`, row.value);
    }
  }
  return values;
}

// One line per party member whose sheet changed, such as "Hit Points 7 → 12 of 12".
function recovered(
  before: Map<string, string>,
  after: readonly SheetView[],
): HTMLElement[] {
  return after.flatMap((sheet) => {
    const changes = sheet.sections
      .flatMap((section) => section.rows)
      .filter((row) => {
        const was = before.get(`${sheet.title}\u0000${row.label}`);
        return was !== undefined && was !== row.value;
      })
      .map((row) => {
        const was = before.get(`${sheet.title}\u0000${row.label}`) ?? "";
        return `${row.label} ${was} → ${row.value}${row.note ? ` ${row.note}` : ""}`;
      });
    if (changes.length === 0) return [];
    const line = node("li", "");
    line.append(node("strong", "", sheet.title), ` ${changes.join(", ")}`);
    return [line];
  });
}

export function campfire(
  game: Game,
  act: (work: () => Promise<void>) => void,
  done: () => void, // redraws the page behind once the party breaks camp
): {
  readonly button: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  readonly update: (view: GameView) => void;
} {
  const body = node("div", "campfire-body");
  const dialog = node("dialog", "campfire");
  dialog.setAttribute("aria-label", "Camp");
  const fire = node("div", "campfire-fire", "\u{1F525}");
  fire.setAttribute("aria-hidden", "true");
  dialog.append(fire, body);
  dialog.addEventListener("close", done);

  const show = (heading: string, text: string, ...children: Node[]): void => {
    body.replaceChildren(
      node("h2", "", heading),
      ...(text ? [node("p", "", text)] : []),
      ...children,
    );
    requestAnimationFrame(() => body.querySelector("button")?.focus());
  };

  const choices = (
    options: readonly { readonly id: string; readonly label: string }[],
    pick: (id: string) => void,
  ): HTMLElement => {
    const list = node("div", "options");
    list.append(
      ...options.map((item) =>
        action(item.label, () => {
          pick(item.id);
        }),
      ),
    );
    return list;
  };

  // Answers the rest's own questions until the scene's choice comes back, then sums up.
  const carryOn = (
    sceneDecision: string,
    before: Map<string, string>,
  ): void => {
    const view = game.view();
    const { decision } = view;
    if (decision && decision.id !== sceneDecision && !view.ended) {
      show(
        "Resting",
        decision.prompt,
        choices(decision.options, (id) => {
          act(async () => {
            await game.answer(id);
            carryOn(sceneDecision, before);
          });
        }),
      );
      return;
    }
    show("Resting", "The fire burns low.");
    setTimeout(() => {
      const lines = recovered(before, game.view().sheets);
      const summary = node("ul", "campfire-recovered");
      summary.append(...lines);
      show(
        "Rested",
        lines.length > 0 ? "" : "There was nothing to recover.",
        ...(lines.length > 0 ? [summary] : []),
        action("Break camp", () => {
          dialog.close();
        }),
      );
    }, NIGHTFALL_MS);
  };

  const button = action("", () => {
    const view = game.view();
    const sceneDecision = view.decision?.id ?? "";
    show(
      "Make camp",
      "The party stops to rest.",
      choices([...view.rests, { id: "", label: "Not now" }], (id) => {
        if (!id) {
          dialog.close();
          return;
        }
        const before = rows(game.view().sheets);
        act(async () => {
          await game.answer(id);
          carryOn(sceneDecision, before);
        });
      }),
    );
    dialog.showModal();
  });
  button.className = "campfire-button";
  button.setAttribute("aria-label", "Rest");
  button.title = "Rest";
  button.append(node("span", "campfire-icon", "\u{1F525}"));

  return {
    button,
    dialog,
    update: (view) => {
      button.hidden = view.rests.length === 0;
    },
  };
}
