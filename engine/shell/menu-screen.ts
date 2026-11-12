import { type SaveChoice } from "./session.ts";
import { adventureCard, adventureGrid } from "./adventure-picker.ts";
import { contentFolderOption } from "./content-folder.ts";
import {
  collapseCard,
  loadScreen,
  loadSkeleton,
  saveHeading,
} from "./load-screen.ts";
import { CANT_LOAD, CANT_OPEN, OPENING, type ShellContext } from "./context.ts";
import { button, el } from "./dom.ts";

// The main menu, and the screen for loading a save.

export async function showMenu(ctx: ShellContext): Promise<void> {
  ctx.actions.replaceChildren();
  document.title = "Re-roll";
  const listing = ctx.game.listAdventures();
  const [adventures, saves, books] = await Promise.all([
    listing,
    listing.then((found) => ctx.game.listSaves(found)),
    ctx.game.listBooks(),
  ]);
  // A run that has ended, or a file that isn't a save, has nothing to carry on with.
  const playable = saves.filter((save) => !save.ended && !save.damaged);
  const heading = el("h2", { text: "Choose an adventure" });
  heading.tabIndex = -1;
  const filter = el("input", { class: "search" });
  filter.type = "search";
  filter.placeholder = "Filter adventures";
  filter.setAttribute("aria-label", "Filter adventures");

  const row = (adventure: (typeof adventures)[number]): HTMLElement => {
    // Saves are sorted newest first, so the first match is the one to resume.
    const latest = playable.find((save) => save.adventure === adventure.id);
    return adventureCard(
      ctx.game,
      adventure,
      () => {
        ctx.act(() => ctx.showSetup(adventure), {
          busy: OPENING,
          failed: CANT_OPEN,
        });
      },
      latest
        ? {
            label: [latest.title, whereOf(latest)].filter(Boolean).join(", "),
            go: () => {
              ctx.resume(latest);
            },
          }
        : null,
    );
  };

  const groups = (
    [
      ["Shipped", "shipped"],
      ["Private, from your books", "private"],
    ] as const
  ).flatMap(([title, source]) => {
    const chosen = adventures.filter((item) => item.source === source);
    return chosen.length > 0
      ? [
          el(
            "section",
            { class: "adventure-group" },
            el("h3", { text: `${title} (${String(chosen.length)})` }),
            adventureGrid(chosen.map(row)),
          ),
        ]
      : [];
  });
  filter.addEventListener("input", () => {
    const wanted = filter.value.trim().toLowerCase();
    for (const group of groups) {
      const rows = [...group.querySelectorAll<HTMLElement>(".cover-card")];
      for (const item of rows) {
        item.hidden = !item.dataset.title?.includes(wanted);
      }
      group.hidden = rows.every((item) => item.hidden);
    }
  });

  // Saves come newest first, so the first is the game to carry on with. It reads as its save card does.
  const [newest] = playable;
  const carryOn = newest
    ? [
        el(
          "section",
          { class: "continue" },
          el("h2", { text: "Continue" }),
          continueButton(ctx, newest),
        ),
      ]
    : [];
  ctx.screen.replaceChildren(
    el(
      "section",
      { class: "menu" },
      ...carryOn,
      ...(saves.length > 0
        ? [
            el(
              "div",
              { class: "options saves" },
              button(`Load a game (${String(saves.length)})`, () => {
                ctx.act(() => ctx.showLoad(ctx.showMenu), { busy: "" });
              }),
            ),
          ]
        : []),
      heading,
      filter,
      ...groups,
      ...(books.length > 0
        ? [
            el(
              "div",
              { class: "options" },
              button("Book library", () => {
                ctx.act(() => ctx.showLibrary(books));
              }),
            ),
          ]
        : []),
      ...contentFolderOption(ctx.act),
    ),
  );
  ctx.focusNext = heading;
}

export function resume(ctx: ShellContext, save: SaveChoice): void {
  ctx.act(
    async () => {
      await ctx.game.load(save.path);
      ctx.showGame();
    },
    { busy: OPENING, failed: CANT_LOAD },
  );
}

// Who and where, as the save's card reads: "Sera, Fighter · Level 2 · 9 HP · The Old Road".
function whereOf(save: SaveChoice): string {
  return [saveHeading(save), save.scene].filter(Boolean).join(" · ");
}

function continueButton(
  ctx: ShellContext,
  save: SaveChoice,
): HTMLButtonElement {
  const where = whereOf(save);
  const go = button("", () => {
    ctx.resume(save);
  });
  go.append(
    el("strong", { text: save.title }),
    ...(where ? [el("span", { text: where })] : []),
    ...(save.ago || save.when
      ? [el("small", { text: save.ago ?? save.when ?? "" })]
      : []),
  );
  go.setAttribute(
    "aria-label",
    `Continue ${save.title}${where ? `, ${where}` : ""}`,
  );
  return go;
}

// Opened from the main menu or a game, and Back returns there. The cards' outlines show
// while the saves are read, so the screen isn't blank.
export async function showLoad(
  ctx: ShellContext,
  back: () => void | Promise<void>,
): Promise<void> {
  const goBack = (): void => {
    ctx.act(async () => {
      await back();
    });
  };
  ctx.actions.replaceChildren(button("Back", goBack));
  ctx.screen.replaceChildren(loadSkeleton());
  const saves = await ctx.game.listSaves();
  const { node, heading } = loadScreen(
    ctx.game,
    saves,
    {
      load: ctx.resume,
      remove: (save, card) => {
        ctx.act(async () => {
          await ctx.game.deleteSave(save.path);
          ctx.focusNext = await collapseCard(card);
          ctx.say("Save deleted.");
        });
      },
    },
    back === ctx.showGame,
  );
  ctx.screen.replaceChildren(node);
  ctx.keys = {
    owner: node,
    handle: (event) => {
      if (event.key !== "Escape") return false;
      goBack();
      return true;
    },
  };
  ctx.focusNext = heading;
}
