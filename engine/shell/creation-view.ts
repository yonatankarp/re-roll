import type { GamePage } from "./game-page.ts";
import type { GameView } from "./session.ts";
import type { CreationChoice, CreationView } from "./system-ui.ts";
import { button, el, picture } from "./dom.ts";

// Making a character, one step at a time: where you are among the steps, the choices as cards with
// details in a drawer, what the character is so far, and Back. Drawn in place of the choices.
export function drawCreation(
  page: GamePage,
  view: GameView,
  creation: CreationView,
): void {
  const { ctx } = page;
  // The page is inert while it waits, so focus is handed over once it's done: to the name field, or the first card.
  const focusStep = (): void => {
    ctx.focusNext =
      page.options.querySelector<HTMLElement>(
        ".creation-name input, .creation-pick",
      ) ?? ctx.focusNext;
  };
  const answer = (id: string): void => {
    ctx.act(async () => {
      await ctx.game.answer(id);
      page.draw();
      page.flashSaved();
      focusStep();
    });
  };

  const drawer = el("dialog", { class: "drawer creation-drawer" });
  drawer.setAttribute("aria-label", "Details");
  const openDetails = (choice: CreationChoice, from: HTMLElement): void => {
    const art = view.creationArt[choice.id];
    const close = button("Close", () => {
      drawer.close();
    });
    const choose = button(`Choose ${choice.label}`, () => {
      drawer.close();
      answer(choice.id);
    });
    choose.className = "begin";
    drawer.replaceChildren(
      el(
        "div",
        { class: "drawer-head" },
        el("h2", { text: choice.label }),
        close,
      ),
      ...(art ? [picture(ctx.game, art, "", "creation-drawer-art")] : []),
      ...(choice.summary
        ? [el("p", { class: "creation-summary-line", text: choice.summary })]
        : []),
      el("p", { class: "creation-detail", text: choice.detail ?? "" }),
      choose,
    );
    drawer.onclose = () => {
      if (from.isConnected) from.focus();
    };
    drawer.showModal();
    choose.focus();
  };

  const card = (choice: CreationChoice, index: number): HTMLElement => {
    const art = view.creationArt[choice.id];
    const pick = button("", () => {
      answer(choice.id);
    });
    pick.className = "creation-pick";
    pick.append(
      ...(art ? [picture(ctx.game, art, "", "creation-art")] : []),
      el("strong", { text: choice.label }),
      ...(choice.summary ? [el("span", { text: choice.summary })] : []),
    );
    const item = el("li", { class: "creation-card" }, pick);
    item.style.setProperty("--i", String(index));
    if (choice.detail) {
      const info = button("Details", () => {
        openDetails(choice, info);
      });
      info.className = "creation-info";
      info.setAttribute("aria-label", `Details of ${choice.label}`);
      item.append(info);
    }
    return item;
  };

  const { decision } = view;
  const typed = decision?.text;
  const nameForm = (): HTMLElement => {
    const suggested = decision?.options[0]?.id ?? "";
    const input = el("input");
    input.type = "text";
    input.maxLength = typed?.maxLength ?? 40;
    input.placeholder = suggested;
    input.autocomplete = "off";
    input.spellcheck = false;
    const go = el("button", { class: "begin", text: "Begin the adventure" });
    go.type = "submit";
    const form = el(
      "form",
      { class: "creation-name" },
      el("label", { text: typed?.label ?? "Name" }, input),
      go,
    );
    // Typing a name is the step, so the field takes focus once it's drawn.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      answer(input.value.trim() || suggested);
    });
    return form;
  };

  const steps = creation.steps.map((step) => {
    const item = el("li", { class: step.status, text: step.title });
    if (step.status === "current") item.setAttribute("aria-current", "step");
    return item;
  });
  const summary = creation.summary.map((row) =>
    el(
      "div",
      { class: "creation-row" },
      el("dt", { text: row.label }),
      el("dd", { text: row.value }),
    ),
  );
  const back = view.canUndo
    ? button("Back", () => {
        ctx.act(async () => {
          await ctx.game.undo();
          page.draw();
          focusStep();
        });
      })
    : null;
  if (back) back.className = "creation-back";

  page.options.replaceChildren(
    el(
      "section",
      { class: "creation" },
      ...(steps.length > 0
        ? [el("ol", { class: "creation-steps" }, ...steps)]
        : []),
      ...(creation.heading
        ? [el("p", { class: "creation-heading", text: creation.heading })]
        : []),
      el(
        "div",
        { class: "creation-body" },
        el(
          "div",
          { class: "creation-main" },
          ...(creation.choices.length > 0
            ? [
                el(
                  "ul",
                  { class: `creation-choices ${creation.layout}` },
                  ...creation.choices.map(card),
                ),
              ]
            : []),
          ...(typed ? [nameForm()] : []),
        ),
        ...(summary.length > 0
          ? [
              el(
                "aside",
                { class: "creation-sheet" },
                el("h4", { text: "Your character" }),
                el("dl", {}, ...summary),
              ),
            ]
          : []),
      ),
      // Last, so a step's focus and Tab reach the choices first; it's drawn at the top.
      ...(back ? [back] : []),
      drawer,
    ),
  );
}
