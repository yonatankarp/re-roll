import type { GamePage } from "./game-page.ts";
import type { GameView } from "./session.ts";
import type {
  CreationCard,
  CreationChoice,
  CreationDoor,
  CreationGroup,
  CreationView,
} from "./system-ui.ts";
import { button, el, picture } from "./dom.ts";

// Making a character the easy way: three doors in, then a sheet that is always complete, with the character kept in
// view as a card. Which door is open is only where the player is looking; every choice is an answer.

// Which door, and which answer to its question, the player has open. Kept across draws of the same decision.
let opened: {
  decision: string;
  door: string | null;
  answer: number | null;
} = {
  decision: "",
  door: null,
  answer: null,
};

export function drawCreationSheet(
  page: GamePage,
  view: GameView,
  creation: CreationView,
): void {
  const { ctx } = page;
  const decisionId = view.decision?.id ?? "";
  if (opened.decision !== decisionId) {
    opened = { decision: decisionId, door: null, answer: null };
  }
  const listed = new Set(view.decision?.options.map((option) => option.id));
  // focus is a key that stays the same when the answer changes, such as "minus:Strength", so focus can return.
  const tag = (
    node: HTMLElement,
    answer: string,
    focus?: string,
  ): HTMLElement => {
    node.dataset.answer = answer;
    if (focus !== undefined) node.dataset.focus = focus;
    // Buttons that answer one of the decision's listed options are marked as the rest of the shell marks them.
    if (listed.has(answer)) node.dataset.choice = answer;
    return node;
  };
  // Focus comes back to the control that was pressed, so a keyboard player can press + again; with nothing to
  // come back to, such as after Next, it goes to the heading at the top.
  const refocus = (keys: readonly string[]): void => {
    const again = keys
      .map((key) =>
        page.options.querySelector<HTMLElement>(
          `[data-focus="${CSS.escape(key)}"]:not(:disabled)`,
        ),
      )
      .find((node) => node !== null);
    ctx.focusNext =
      again ??
      page.options.querySelector<HTMLElement>(".sheet-heading") ??
      ctx.focusNext;
  };
  const answer = (
    focus: readonly string[],
    ...answers: readonly string[]
  ): void => {
    ctx.act(async () => {
      for (const id of answers) await ctx.game.answer(id);
      page.draw();
      page.flashSaved();
      refocus(focus);
    });
  };
  const redraw = (): void => {
    drawCreationSheet(page, view, creation);
    refocus([]);
    const focus = ctx.focusNext;
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
  };
  const art = (id: string, className: string): Node[] => {
    const path = view.creationArt[id];
    if (!path) return [];
    const image = picture(ctx.game, path, "", className);
    const focus = view.creationFocus?.[id];
    if (focus) image.style.objectPosition = focus;
    return [image];
  };

  const drawer = el("dialog", { class: "drawer creation-drawer" });
  drawer.setAttribute("aria-label", "Details");
  const openDetails = (choice: CreationChoice, from: HTMLElement): void => {
    const close = button("Close", () => {
      drawer.close();
    });
    drawer.replaceChildren(
      el(
        "div",
        { class: "drawer-head" },
        el("h2", { text: choice.label }),
        close,
      ),
      ...art(choice.id, "creation-drawer-art"),
      ...(choice.summary
        ? [el("p", { class: "creation-summary-line", text: choice.summary })]
        : []),
      el("p", { class: "creation-detail", text: choice.detail ?? "" }),
    );
    drawer.onclose = () => {
      if (from.isConnected) from.focus();
    };
    drawer.showModal();
    close.focus();
  };

  const badge = (choice: CreationChoice): Node[] =>
    choice.recommended
      ? [el("em", { class: "sheet-badge", text: "Suggested" })]
      : [];
  const details = (choice: CreationChoice, className: string): Node[] => {
    if (!choice.detail) return [];
    const info = button("Details", () => {
      openDetails(choice, info);
    });
    info.className = className;
    info.setAttribute("aria-label", `Details of ${choice.label}`);
    return [info];
  };
  const pickCard = (
    choice: CreationChoice,
    index: number,
    onPick: () => void,
  ): HTMLElement => {
    const pick = button("", onPick);
    pick.className = "creation-pick";
    if (choice.selected !== undefined) {
      pick.setAttribute("aria-pressed", String(choice.selected));
    }
    pick.append(
      ...art(choice.id, "creation-art"),
      el("strong", { text: choice.label }),
      ...(choice.summary ? [el("span", { text: choice.summary })] : []),
      ...badge(choice),
    );
    tag(pick, choice.answer ?? choice.id, `pick:${choice.id}`);
    const item = el(
      "li",
      { class: "creation-card" },
      pick,
      ...details(choice, "creation-info"),
    );
    item.style.setProperty("--i", String(index));
    return item;
  };
  const cards = (choices: readonly CreationChoice[]): HTMLElement =>
    el(
      "ul",
      { class: "creation-choices cards" },
      ...choices.map((choice, index) =>
        pickCard(choice, index, () => {
          answer([`pick:${choice.id}`], choice.answer ?? choice.id);
        }),
      ),
    );

  const heading = (text: string): HTMLElement => {
    const node = el("h3", { class: "sheet-heading", text });
    node.tabIndex = -1;
    return node;
  };
  const back = view.canUndo
    ? button(creation.doors ? "Back" : "Undo", () => {
        ctx.act(async () => {
          await ctx.game.undo();
          page.draw();
          refocus([]);
        });
      })
    : null;
  if (back) back.className = "creation-back";

  page.options.replaceChildren(
    el(
      "section",
      { class: "creation sheet" },
      ...(creation.doors ? doorsScreen(creation.doors) : sheetScreen(creation)),
      ...(back ? [back] : []),
      drawer,
    ),
  );

  function doorsScreen(doors: readonly CreationDoor[]): Node[] {
    const door = doors.find((item) => item.id === opened.door);
    const toDoors = button("All the ways in", () => {
      opened = { ...opened, door: null, answer: null };
      redraw();
    });
    toDoors.className = "sheet-back-link";
    if (!door) {
      return [
        heading(creation.heading),
        el(
          "ul",
          { class: "sheet-doors" },
          ...doors.map((item, index) => {
            const pick = button("", () => {
              if (item.answer !== undefined) {
                answer([], item.answer);
                return;
              }
              opened = { ...opened, door: item.id, answer: null };
              redraw();
            });
            pick.className = "sheet-door";
            pick.append(
              ...art(item.id, "sheet-door-art"),
              el("strong", { text: item.label }),
              el("span", { text: item.summary }),
            );
            if (item.answer !== undefined) tag(pick, item.answer);
            const li = el("li", {}, pick);
            li.style.setProperty("--i", String(index));
            return li;
          }),
        ),
      ];
    }
    if (door.question) {
      const chosen =
        opened.answer === null ? null : door.question.answers[opened.answer];
      if (!chosen) {
        return [
          toDoors,
          heading(door.question.prompt),
          el(
            "ul",
            { class: "creation-choices cards sheet-styles" },
            ...door.question.answers.map((item, index) =>
              pickCard(
                {
                  id: `style-${String(index)}`,
                  label: item.label,
                  summary: item.summary,
                },
                index,
                () => {
                  opened = { ...opened, answer: index };
                  redraw();
                },
              ),
            ),
          ),
        ];
      }
      const again = button("Another answer", () => {
        opened = { ...opened, answer: null };
        redraw();
      });
      again.className = "sheet-back-link";
      return [
        again,
        heading(`${chosen.label}: heroes for you`),
        el("p", {
          class: "sheet-intro",
          text: "The first suits it best. Each is ready to play, and you can change anything before you begin.",
        }),
        cards(chosen.choices),
      ];
    }
    return [toDoors, heading(door.label), cards(door.choices ?? [])];
  }

  function sheetScreen(sheet: CreationView): Node[] {
    const steps = el(
      "ol",
      { class: "creation-steps sheet-steps" },
      ...sheet.steps.map((step) => {
        const item = el("li", { class: step.status });
        if (step.status === "current") {
          item.setAttribute("aria-current", "step");
          item.append(el("span", { text: step.title }));
        } else if (step.answer !== undefined) {
          const go = button(step.title, () => {
            if (step.answer !== undefined) answer([], step.answer);
          });
          item.append(tag(go, step.answer));
        } else {
          item.append(el("span", { text: step.title }));
        }
        return item;
      }),
    );
    const main = el(
      "div",
      { class: "creation-main" },
      heading(sheet.heading),
      ...(sheet.intro
        ? [el("p", { class: "sheet-intro", text: sheet.intro })]
        : []),
      // Steppers, such as scores, follow the first group, such as how scores are set.
      ...(sheet.groups ?? []).slice(0, 1).map(group),
      ...(sheet.steppers ? [steppers(sheet.steppers)] : []),
      ...(sheet.groups ?? []).slice(1).map(group),
      ...(sheet.name ? [nameForm(sheet.name)] : []),
      ...(sheet.review ? [review(sheet.review)] : []),
    );
    if (sheet.next) {
      const { label, answer: id } = sheet.next;
      const go = button(label, () => {
        const typed = page.options.querySelector<HTMLInputElement>(
          ".creation-name input",
        );
        // A name typed but not yet saved goes with Next.
        const name = typed?.value.trim();
        if (sheet.name && name && name !== sheet.name.value) {
          answer([], `${sheet.name.prefix}${name}`, id);
        } else answer([], id);
      });
      go.className = "begin sheet-next";
      main.append(tag(go, id));
    }
    return [
      steps,
      el(
        "div",
        { class: "creation-body sheet-body" },
        main,
        ...(sheet.card ? [heroCard(sheet.card)] : []),
      ),
    ];
  }

  function group(item: CreationGroup): HTMLElement {
    const body =
      item.layout === "cards"
        ? cards(item.choices)
        : el(
            "ul",
            { class: "sheet-chips" },
            ...item.choices.map((choice) => {
              const chip = button("", () => {
                if (!choice.selected) {
                  answer([`chip:${choice.id}`], choice.answer ?? choice.id);
                }
              });
              chip.className = "sheet-chip";
              chip.setAttribute(
                "aria-pressed",
                String(choice.selected === true),
              );
              chip.append(
                el("strong", { text: choice.label }),
                ...(choice.summary
                  ? [el("span", { text: choice.summary })]
                  : []),
                ...badge(choice),
              );
              tag(chip, choice.answer ?? choice.id, `chip:${choice.id}`);
              return el("li", {}, chip, ...details(choice, "sheet-chip-info"));
            }),
          );
    const note = item.note
      ? [el("p", { class: "sheet-note", text: item.note })]
      : [];
    if (item.folded) {
      const fold = el(
        "details",
        { class: "sheet-group sheet-fold" },
        el("summary", {
          text: `${item.title} (${String(item.choices.length)})`,
        }),
        ...note,
        body,
      );
      fold.open = item.choices.some((choice) => choice.selected);
      return fold;
    }
    return el(
      "section",
      { class: "sheet-group" },
      el("h4", { text: item.title }),
      ...note,
      body,
    );
  }

  function steppers(item: NonNullable<CreationView["steppers"]>): HTMLElement {
    return el(
      "section",
      { class: "sheet-group" },
      el("h4", { text: item.title }),
      el("p", { class: "sheet-note", text: item.note }),
      el(
        "ul",
        { class: "sheet-steppers" },
        ...item.rows.map((row) => {
          const step = (
            sign: "−" | "+",
            id: string | undefined,
            verb: string,
          ) => {
            // Back to this button, or to the row's other one when this reaches its limit.
            const own = `${verb}:${row.label}`;
            const keys = [
              own,
              `${verb === "Lower" ? "Raise" : "Lower"}:${row.label}`,
            ];
            const control = button(sign, () => {
              if (id !== undefined) answer(keys, id);
            });
            control.className = "sheet-step";
            control.setAttribute("aria-label", `${verb} ${row.label}`);
            control.disabled = id === undefined;
            if (id !== undefined) tag(control, id);
            control.dataset.focus = own;
            return control;
          };
          const label = el("span", {
            class: "sheet-stat-label",
            text: row.label,
          });
          if (row.term) label.dataset.term = row.term;
          return el(
            "li",
            {},
            el(
              "div",
              { class: "sheet-stepper-name" },
              label,
              ...(row.note ? [el("small", { text: row.note })] : []),
            ),
            step("−", row.minus, "Lower"),
            el("output", { class: "sheet-value", text: row.value }),
            step("+", row.plus, "Raise"),
          );
        }),
      ),
    );
  }

  function nameForm(item: NonNullable<CreationView["name"]>): HTMLElement {
    const input = el("input");
    input.type = "text";
    input.maxLength = item.maxLength;
    input.value = item.value;
    input.autocomplete = "off";
    input.spellcheck = false;
    const save = el("button", { text: "Use this name" });
    save.type = "submit";
    const form = el(
      "form",
      { class: "creation-name" },
      el("label", { text: item.label }, input),
      save,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name && name !== item.value) answer([], `${item.prefix}${name}`);
    });
    return form;
  }

  function review(rows: NonNullable<CreationView["review"]>): HTMLElement {
    return el(
      "dl",
      { class: "sheet-review" },
      ...rows.map((row) => {
        const change =
          row.change === undefined
            ? []
            : [
                tag(
                  button("Change", () => {
                    if (row.change !== undefined) answer([], row.change);
                  }),
                  row.change,
                ),
              ];
        for (const node of change) {
          if (node instanceof HTMLElement) {
            node.className = "sheet-change";
            node.setAttribute("aria-label", `Change ${row.label}`);
          }
        }
        return el(
          "div",
          { class: "sheet-review-row" },
          el("dt", { text: row.label }),
          el("dd", { text: row.value }),
          ...change,
        );
      }),
    );
  }

  function heroCard(item: CreationCard): HTMLElement {
    const stat = (
      stats: CreationCard["numbers"],
      className: string,
    ): HTMLElement =>
      el(
        "dl",
        { class: className },
        ...stats.map((entry) => {
          const label = el("dt", { text: entry.label });
          if (entry.term) label.dataset.term = entry.term;
          return el("div", {}, label, el("dd", { text: entry.value }));
        }),
      );
    const aside = el(
      "aside",
      { class: "sheet-card" },
      ...art("card", "sheet-card-art"),
      el(
        "div",
        { class: "sheet-card-text" },
        el("h4", { text: item.title }),
        el("p", { class: "sheet-card-subtitle", text: item.subtitle }),
        stat(item.numbers, "sheet-numbers"),
        stat(item.abilities, "sheet-abilities"),
        el(
          "ul",
          { class: "sheet-strengths" },
          ...item.strengths.map((line) => el("li", { text: line })),
        ),
      ),
    );
    aside.setAttribute("aria-label", "Your hero");
    return aside;
  }
}
