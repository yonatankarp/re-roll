import type { OptionView } from "./system-ui.ts";
import type { GameView } from "./session.ts";
import type { GamePage } from "./game-page.ts";
import { button, el, enter } from "./dom.ts";

// The decision waiting on the player: its prompt, a card for news such as treasure found, and its choices,
// in tabs on a full turn.

// A small "i" in a ring, for an option's details, drawn in the button's ink.
const INFO_ICON =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">' +
  '<circle cx="10" cy="10" r="8"/><path d="M10 9v5" stroke-linecap="round"/>' +
  '<circle cx="10" cy="6" r=".6" fill="currentColor"/></svg>';

// The system's own markup, as the shell's icons are, so the card looks the same on every OS.
function cardIcon(svg: string): HTMLElement {
  const icon = el("span", { class: "card-icon" });
  icon.innerHTML = svg;
  return icon;
}

export function drawDecision(
  page: GamePage,
  view: GameView,
  cues: GameView["cues"],
  firstDraw: boolean,
): void {
  const { decision } = view;
  // A card says what the prompt would, so it stands in for it.
  page.prompt.textContent =
    decision && decision.prompt !== view.scene && !view.card && !view.shop
      ? decision.prompt
      : "";
  const fresh = (decision?.id ?? null) !== page.decisionShown;
  // Keyed on what it says rather than on the decision, so equipping a find from the card doesn't
  // show it again; the purse is in the key, so a second find of the same things still shows.
  const shownCard = view.card;
  const cardKey = shownCard
    ? JSON.stringify([shownCard.title, shownCard.lines, shownCard.footer])
    : "";
  // Filled and shown once the board has finished, so its entrance isn't spent, and its news
  // isn't announced, while it's still hidden. The key is set only then, so a newer draw retries.
  const revealCard =
    cardKey !== (page.card.dataset.key ?? "")
      ? (): void => {
          page.card.dataset.key = cardKey;
          page.card.replaceChildren(
            ...(shownCard
              ? [
                  el(
                    "h3",
                    {},
                    ...(shownCard.icon ? [cardIcon(shownCard.icon)] : []),
                    document.createTextNode(shownCard.title),
                  ),
                  el(
                    "ul",
                    {},
                    ...shownCard.lines.map((line, index) => {
                      const item = el("li", { text: line });
                      item.style.setProperty("--i", String(index));
                      return item;
                    }),
                  ),
                  ...(shownCard.footer
                    ? [
                        el("p", {
                          class: "card-footer",
                          text: shownCard.footer,
                        }),
                      ]
                    : []),
                ]
              : []),
          );
          page.card.hidden = !shownCard;
          if (shownCard && !firstDraw) {
            enter(page.card);
            if (page.sound.effects()) page.ctx.cardSound?.();
          }
        }
      : null;
  if (fresh) {
    page.decisionShown = decision?.id ?? null;
    page.showAll = false;
    page.openGroup = null;
  }
  const optionRow = (option: OptionView, index: number): HTMLElement => {
    const row = el(
      "div",
      { class: "option" },
      button(option.label, () => {
        page.ctx.act(async () => {
          await page.ctx.game.answer(option.id);
          page.draw();
          page.flashSaved();
        });
      }),
    );
    row.style.setProperty("--i", String(index));
    if (option.detail) {
      const info = el("p", { class: "option-detail", text: option.detail });
      info.hidden = true;
      const toggle = button("", () => {
        info.hidden = !info.hidden;
        toggle.setAttribute("aria-expanded", String(!info.hidden));
      });
      toggle.className = "info";
      toggle.innerHTML = INFO_ICON;
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", `Details of ${option.label}`);
      row.append(toggle, info);
    }
    return row;
  };
  // A long list shows its first few and its last, such as "Stay where you are", until asked for the rest.
  const trimmed = (list: readonly OptionView[]): HTMLElement[] => {
    if (page.showAll || list.length <= 7) return list.map(optionRow);
    const last = list.at(-1);
    const more = button(`More choices (${String(list.length - 6)})`, () => {
      page.showAll = true;
      page.draw();
      page.options
        .querySelectorAll<HTMLElement>(".option > button")[5]
        ?.focus();
    });
    more.className = "more";
    return [
      ...list.slice(0, 5).map(optionRow),
      more,
      ...(last ? [optionRow(last, 6)] : []),
    ];
  };
  // With the actions in tabs, the last choice, such as ending the turn, stays one click away beside them.
  const tabbed =
    view.optionGroups.filter((group) => group.title !== null).length > 1;
  const lastId = tabbed ? decision?.options.at(-1)?.id : undefined;
  const lastOption = view.optionGroups
    .flatMap((group) => group.options)
    .find((option) => option.id === lastId);
  const groups = view.optionGroups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => option !== lastOption),
    }))
    .filter((group) => group.options.length > 0);
  // A lone group of actions needs no tab to open it, so it lists with the rest.
  const titled = groups.filter((group) => group.title !== null);
  const tabs = titled.length > 1 ? titled : [];
  page.quickQuestion =
    fresh &&
    view.combat !== null &&
    decision !== null &&
    view.optionGroups.every((group) => group.title === null);
  const chosen = tabs.find((group) => group.title === page.openGroup);
  // Outside a fight the choices read as a book's numbered entries, and number keys pick them.
  page.options.classList.toggle("story", !view.combat);
  page.options.replaceChildren(
    ...groups
      .filter((group) => !tabs.includes(group))
      .map((group) =>
        el("div", { class: "options" }, ...trimmed(group.options)),
      ),
    ...(tabs.length > 0
      ? [
          el(
            "div",
            { class: "tabs" },
            ...tabs.map((group) => {
              const name = group.title ?? "";
              const tab = button(name, () => {
                page.openGroup = page.openGroup === name ? null : name;
                page.draw();
                // Focus goes into the panel just opened, or back to the replaced tab when it closed.
                (page.openGroup
                  ? page.options.querySelector<HTMLElement>(
                      ".group-panel .option > button",
                    )
                  : [
                      ...page.options.querySelectorAll<HTMLElement>(".tab"),
                    ].find((item) => item.textContent === name)
                )?.focus();
              });
              tab.className = name === page.openGroup ? "tab open" : "tab";
              tab.setAttribute(
                "aria-expanded",
                String(name === page.openGroup),
              );
              return tab;
            }),
            ...(lastOption ? [optionRow(lastOption, tabs.length)] : []),
          ),
        ]
      : []),
    ...(chosen
      ? [
          el(
            "div",
            { class: "options group-panel" },
            ...trimmed(chosen.options),
          ),
        ]
      : []),
  );
  page.options.hidden = view.shop !== null;
  page.shop.update(view.shop);
  // The next choice waits for the board to finish, so it can't be picked under a die still to throw.
  if (!firstDraw && page.board?.settled && cues.length > 0) {
    const shownChoice = ++page.choiceShown;
    const quick = page.quickQuestion;
    page.prompt.inert = page.options.inert = true;
    page.stage.classList.add("settling");
    void page.board.settled().then(() => {
      if (shownChoice !== page.choiceShown) return;
      page.prompt.inert = page.options.inert = false;
      page.stage.classList.remove("settling");
      if (fresh) enter(page.options);
      revealCard?.();
      // Focus meant for a choice was dropped while it was inert, or sits on a board that just hid.
      const focused = document.activeElement;
      if (
        quick ||
        !focused ||
        focused === document.body ||
        !focused.checkVisibility()
      ) {
        page.firstFocus().focus();
      }
    });
  } else {
    if (fresh && !firstDraw) enter(page.options);
    revealCard?.();
  }
}
