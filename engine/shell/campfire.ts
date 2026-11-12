import { type Game, type GameView, sheetChanges } from "./session.ts";
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

// Each party member whose sheet changed, with a line per change.
function recovered(
  before: readonly SheetView[],
  after: readonly SheetView[],
): HTMLElement[] {
  return sheetChanges(before, after).map(({ title, changes }) => {
    const line = node("li", "");
    line.append(
      node("strong", "", title),
      ...changes.map((text) => node("span", "", text)),
    );
    return line;
  });
}

// A small campfire drawn in the top bar's ink, so it matches the other bar buttons.
const FIRE_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">' +
  '<path d="M12 2c.6 3-1.8 4.6-3 6.6-1.4 2.3-.9 5.4 1.4 6.9-.4-1.6.1-3.1 1.6-4.4.2 1.7 1.2 2.5 2 3.4.9 1 .9 2.2.3 3 2.3-1 3.6-3.3 3.2-5.9-.4-2.6-2.2-4.1-3.3-5.6C13.4 4.6 13 3.4 12 2z"/>' +
  '<path d="M3.5 20.2l16.4-3.4.5 2.2-16.4 3.4zM20.5 20.2L4.1 16.8l-.5 2.2 16.4 3.4z" opacity=".75"/>' +
  "</svg>";

// The camp's own fire, larger and in its colours: two flames over crossed logs.
const CAMP_FIRE =
  '<svg viewBox="0 0 24 24" width="84" height="84" aria-hidden="true">' +
  '<path fill="#e8641e" d="M12 2c.6 3-1.8 4.6-3 6.6-1.4 2.3-.9 5.4 1.4 6.9-.4-1.6.1-3.1 1.6-4.4.2 1.7 1.2 2.5 2 3.4.9 1 .9 2.2.3 3 2.3-1 3.6-3.3 3.2-5.9-.4-2.6-2.2-4.1-3.3-5.6C13.4 4.6 13 3.4 12 2z"/>' +
  '<path fill="#f7c04a" d="M12.2 9.6c.3 1.9-1.1 2.9-1.7 4.1-.7 1.4-.2 2.9 1 3.6 1.7-.3 2.8-1.7 2.5-3.4-.2-1.7-1.3-2.5-1.8-4.3z"/>' +
  '<path fill="#6b4425" d="M3.5 20.2l16.4-3.4.5 2.2-16.4 3.4zM20.5 20.2L4.1 16.8l-.5 2.2 16.4 3.4z"/>' +
  "</svg>";

const reducedMotion = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const FADE_MS = 800; // matches the 0.8s fade the camp opens with

export function campfire(
  game: Game,
  act: (work: () => Promise<void>) => void,
  // Redraws the page behind once the party breaks camp; `rested` is false when nothing was played.
  done: (rested: boolean) => void,
): {
  readonly button: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  readonly update: (view: GameView) => void;
} {
  const body = node("div", "campfire-body");
  const dialog = node("dialog", "campfire");
  dialog.setAttribute("aria-label", "Camp");
  const fire = node("div", "campfire-fire");
  fire.innerHTML = CAMP_FIRE;
  dialog.append(fire, body);
  let played = false; // whether an answer went into the game, so "Saved" only shows when it's true
  let resting = false; // between picking a rest and its summary, when leaving would leave it half done
  let closing = false;
  dialog.addEventListener("close", () => {
    done(played);
  });

  // Fades out over as long as the camp took to fade in.
  const breakCamp = (): void => {
    if (closing || !dialog.open) return;
    closing = true;
    dialog.classList.add("closing");
    setTimeout(
      () => {
        closing = false;
        dialog.classList.remove("closing");
        dialog.close();
      },
      reducedMotion() ? 0 : FADE_MS,
    );
  };
  // Esc is handled here rather than by the dialog, so a second Esc can't slip past a refused cancel.
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (!resting) breakCamp();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!resting) breakCamp();
  });

  const show = (heading: string, text: string, ...children: Node[]): void => {
    body.replaceChildren(
      node("h2", "", heading),
      ...(text ? [node("p", "", text)] : []),
      ...children,
    );
    requestAnimationFrame(() => body.querySelector("button")?.focus());
  };

  const choices = (
    options: readonly {
      readonly id: string;
      readonly label: string;
      readonly detail?: string | null;
    }[],
    pick: (id: string) => void,
  ): HTMLElement => {
    const list = node("div", "options");
    list.append(
      ...options.map((item) => {
        const choice = action(item.label, () => {
          pick(item.id);
        });
        if (item.detail) {
          choice.replaceChildren(
            node("strong", "", item.label),
            node("small", "", item.detail),
          );
        }
        return choice;
      }),
    );
    return list;
  };

  // Answers the rest's own questions until the scene's choice comes back, then sums up.
  const carryOn = (
    sceneDecision: string,
    before: readonly SheetView[],
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
      resting = false;
      show(
        "Rested",
        lines.length > 0 ? "" : "There was nothing to recover.",
        ...(lines.length > 0 ? [summary] : []),
        action("Break camp", breakCamp),
      );
    }, NIGHTFALL_MS);
  };

  const button = action("", () => {
    const view = game.view();
    const sceneDecision = view.decision?.id ?? "";
    played = false;
    resting = false;
    const notNow = action("Not now", breakCamp);
    notNow.className = "quiet";
    show(
      "Make camp",
      "The party stops to rest.",
      choices(view.rests, (id) => {
        const before = game.view().sheets;
        resting = true;
        act(async () => {
          try {
            await game.answer(id);
          } catch (error) {
            resting = false; // nothing started, so the player may leave
            throw error;
          }
          played = true;
          carryOn(sceneDecision, before);
        });
      }),
      notNow,
    );
    dialog.showModal();
  });
  button.className = "campfire-button";
  button.setAttribute("aria-label", "Rest");
  button.innerHTML = FIRE_ICON;

  return {
    button,
    dialog,
    // Disabled rather than hidden, so the bar doesn't shift when rests come and go.
    update: (view) => {
      const none = view.rests.length === 0;
      button.disabled = none;
      button.title = none ? "You can rest between scenes" : "Rest";
    },
  };
}
