import type { GameView } from "./session.ts";
import type { GamePage } from "./game-page.ts";
import { button, el, replaceKeepingOpen } from "./dom.ts";
import { meter, renderSheet } from "./sheet-view.ts";

// The top bar's summary of the player, and the character sheets with a tab for each party member.

export function drawSheets(
  page: GamePage,
  view: GameView,
  cues: GameView["cues"],
  firstDraw: boolean,
): void {
  const [playerSheet] = view.sheets;
  page.hud.hidden = !playerSheet;
  // The bar shows what the board has shown, so a hit doesn't land on the HP before the die does.
  const drawHud = (): void => {
    if (!playerSheet) return;
    const summary = playerSheet.summary ?? [];
    // Out of hit points: the fight's own word for it, such as dying, or "Down" outside one.
    const status = view.combat?.combatants.find(
      (actor) => actor.id === playerSheet.id,
    )?.status;
    const down = status
      ? status.charAt(0).toUpperCase() + status.slice(1)
      : summary[0]?.meter === 0
        ? "Down"
        : null;
    page.hud.replaceChildren(
      el("span", { class: "hud-name", text: playerSheet.title }),
      ...summary.map((row) =>
        el(
          "span",
          { class: "hud-stat" },
          el("small", { text: row.label }),
          document.createTextNode(` ${row.value}`),
          ...(row.meter === undefined ? [] : [meter(row.meter)]),
        ),
      ),
      ...(down ? [el("span", { class: "hud-down", text: down })] : []),
    );
  };
  const shownHud = ++page.hudShown;
  if (!firstDraw && page.board?.settled && cues.length > 0) {
    void page.board.settled().then(() => {
      if (shownHud === page.hudShown) drawHud();
    });
  } else drawHud();
  const shown =
    view.sheets.find((item) => item.id === page.sheetShown) ?? playerSheet;
  const panels = view.sheets.map((item) => {
    const panel = page.sheetPanels.get(item.id) ?? el("div");
    page.sheetPanels.set(item.id, panel);
    replaceKeepingOpen(
      panel,
      renderSheet(item, true, (row) => {
        const { option } = row;
        if (!option) return [];
        const offered = view.choices.some(
          (choice) =>
            choice.where === "sheet" &&
            choice.sheet === item.id &&
            choice.id === option.id,
        );
        if (!offered) {
          // Shown but not offered, so the player sees what can change, and when.
          const later = button(option.label, () => undefined);
          later.className = "row-option";
          later.disabled = true;
          later.title = option.hint ?? "";
          later.setAttribute(
            "aria-label",
            `${option.label} ${row.label}: ${option.hint ?? ""}`,
          );
          return [later];
        }
        const pick = button(option.label, () => {
          page.ctx.act(async () => {
            await page.ctx.game.answer(option.id);
            page.draw();
            page.flashSaved();
          });
        });
        pick.className = "row-option";
        pick.dataset.choice = option.id;
        pick.setAttribute("aria-label", `${option.label} ${row.label}`);
        // Inside a row's summary, the button shouldn't also open the row.
        pick.addEventListener("click", (event) => {
          event.preventDefault();
        });
        return [pick];
      }),
    );
    panel.hidden = item !== shown;
    return panel;
  });
  page.sheetTabs.replaceChildren(
    ...(view.sheets.length > 1
      ? view.sheets.map((item) => {
          const tab = button(item.title, () => {
            page.sheetShown = item.id;
            page.draw();
            // The redraw replaced this button, so focus goes to its replacement.
            page.sheetTabs
              .querySelector<HTMLElement>(
                `.tab[data-id="${CSS.escape(item.id)}"]`,
              )
              ?.focus();
          });
          tab.className = item === shown ? "tab open" : "tab";
          tab.dataset.id = item.id;
          tab.setAttribute("aria-pressed", String(item === shown));
          return tab;
        })
      : []),
  );
  page.fullSheet.replaceChildren(...panels);
}
