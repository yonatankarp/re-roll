import { collapseCard, loadScreen } from "./load-screen.ts";
import { campfire } from "./campfire.ts";
import { adventureCard, adventureGrid } from "./adventure-picker.ts";
import type { Game, GameView } from "./session.ts";
import type {
  Board,
  BoardHost,
  CombatView,
  OptionView,
  SheetRow,
  SheetSection,
  SheetView,
} from "./system-ui.ts";

// The whole page, drawn from the plain data in GameView. Knows nothing about any rule system.

// A system's own encounter view, such as a combat board, keyed by system id. It draws its own DOM in the slot.
export type BoardFactory = (slot: HTMLElement, host: BoardHost) => Board;

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

// The player's sound setting, kept between visits. Storage can be blocked, which leaves sound on.
const SOUND_KEY = "re-roll:sound";
let soundOn = ((): boolean => {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
})();

function soundToggle(): HTMLButtonElement {
  const node = button("Sound", () => {
    node.textContent = soundOn ? "Sound: off" : "Sound: on";
    soundOn = !soundOn;
    node.setAttribute("aria-pressed", String(soundOn));
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
    } catch {
      // Not remembered, but still applies for now.
    }
  });
  node.setAttribute("aria-pressed", String(soundOn));
  node.textContent = soundOn ? "Sound: on" : "Sound: off";
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

function renderCombat(
  game: Game,
  combat: CombatView,
  art: GameView["monsterArt"],
): HTMLElement {
  return el(
    "section",
    { class: "combat" },
    el("h3", { text: `Initiative, round ${String(combat.round)}` }),
    el(
      "ol",
      { class: "initiative" },
      ...combat.combatants.map((actor) => {
        const details = [
          `HP ${String(actor.hp)} of ${String(actor.maxHp)}`,
          ...(actor.tempHp > 0 ? [`${String(actor.tempHp)} temp HP`] : []),
          ...(actor.status ? [actor.status] : []),
          ...actor.conditions,
          ...(actor.concentration
            ? [`concentrating on ${actor.concentration}`]
            : []),
        ];
        const portrait = art[actor.id];
        const item = el(
          "li",
          {
            class: `${actor.active ? "active" : ""} ${portrait ? "has-art" : ""}`,
          },
          ...(portrait
            ? [picture(game, portrait, actor.name, "portrait")]
            : []),
          el("span", {
            class: "who",
            text: `${actor.active ? "▶ " : ""}${actor.name}`,
          }),
          el("span", { class: "side", text: actor.side }),
          el("span", { class: "details", text: details.join(" · ") }),
        );
        if (actor.active) item.setAttribute("aria-current", "true");
        return item;
      }),
    ),
  );
}

// A sheet row's own choice, such as Equip, as a button while the pending decision offers it.
type RowOption = (row: SheetRow) => Node[];

function detailsRow(
  label: string,
  value: string,
  detail: string,
  extra: Node[] = [],
): HTMLElement {
  return el(
    "details",
    { class: "sheet-detail" },
    el(
      "summary",
      {},
      el("span", { text: label }),
      ...(value ? [el("span", { class: "sheet-value", text: value })] : []),
      ...extra,
    ),
    el("p", { text: detail }),
  );
}

function renderSection(
  section: SheetSection,
  rowOption: RowOption,
): HTMLElement {
  const heading = el("h3", { text: section.title });
  switch (section.layout) {
    case "boxes":
      return el(
        "section",
        {},
        heading,
        el(
          "div",
          { class: "boxes" },
          ...section.rows.map((row) =>
            el(
              "div",
              { class: "box" },
              el("span", { class: "box-label", text: row.label }),
              el("span", { class: "box-value", text: row.value }),
              ...(row.note
                ? [el("span", { class: "box-note", text: row.note })]
                : []),
            ),
          ),
        ),
      );
    case "marks":
      return el(
        "section",
        {},
        heading,
        el(
          "ul",
          { class: "marks" },
          ...section.rows.map((row) => {
            const dot = el("span", { class: "mark" });
            dot.setAttribute("aria-label", row.marked ? "proficient" : "");
            return el(
              "li",
              { class: row.marked ? "marked" : "" },
              dot,
              el("span", { class: "mark-value", text: row.value }),
              el("span", { text: row.label }),
              ...(row.note
                ? [el("span", { class: "mark-note", text: row.note })]
                : []),
            );
          }),
        ),
      );
    default: // a plain list
      return el(
        "section",
        {},
        heading,
        el(
          "dl",
          {},
          ...section.rows.flatMap((row) =>
            row.detail
              ? []
              : [
                  el("dt", { text: row.label }),
                  el("dd", { text: row.value }, ...rowOption(row)),
                ],
          ),
        ),
        ...section.rows.flatMap((row) =>
          row.detail
            ? [detailsRow(row.label, row.value, row.detail, rowOption(row))]
            : [],
        ),
      );
  }
}

// The side panel shows the pinned sections; the full sheet shows them all.
function renderSheet(
  sheet: SheetView,
  full: boolean,
  rowOption: RowOption = () => [],
): HTMLElement {
  return el(
    "section",
    { class: full ? "sheet-body full" : "sheet-body" },
    el(
      "header",
      { class: "sheet-head" },
      el("h2", { text: sheet.title }),
      ...(sheet.subtitle
        ? [el("p", { class: "sheet-subtitle", text: sheet.subtitle })]
        : []),
      ...(sheet.tags && sheet.tags.length > 0
        ? [
            el(
              "ul",
              { class: "tags" },
              ...sheet.tags.map((tag) => el("li", { text: tag })),
            ),
          ]
        : []),
    ),
    el(
      "div",
      { class: "sheet-sections" },
      ...sheet.sections
        .filter((section) => section.rows.length > 0)
        .filter((section) => full || section.pinned)
        .map((section) => renderSection(section, rowOption)),
    ),
  );
}

// A bar from 0 to 1, such as hit points left.
function meter(share: number): HTMLElement {
  const fill = el("i");
  fill.style.width = `${String(Math.round(Math.max(0, Math.min(1, share)) * 100))}%`;
  fill.dataset.level = share > 0.5 ? "high" : share > 0.25 ? "mid" : "low";
  return el("span", { class: "meter" }, fill);
}

// A redraw must not close what the player has opened to read.
function replaceKeepingOpen(container: HTMLElement, ...nodes: Node[]): void {
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

function endingOf(view: GameView): {
  readonly title: string;
  readonly text: string;
} | null {
  switch (view.ended) {
    case null:
      return null;
    case "ending":
      // The ending scene's own text is already on the page above this.
      return view.scene
        ? { title: view.endingName ?? "The end", text: "" }
        : {
            title: "Adventure complete",
            text: "You have reached the end of this story.",
          };
    case "deadEnd":
      return {
        title: "A dead end",
        text: "The story has no choices left to offer you.",
      };
    case "defeat":
      return view.playerDied
        ? {
            title: "You have died",
            text: "Your story ends here, whatever became of your companions.",
          }
        : {
            title: "Your party has fallen",
            text: "Nobody is left standing to carry on.",
          };
  }
}

export function mountShell(
  root: HTMLElement,
  game: Game,
  boards: Readonly<Record<string, BoardFactory>> = {},
  credits: readonly string[] = [], // the app's own, such as for its fonts
  cardSound?: () => void, // played as a card such as treasure found appears, when sound is on
): void {
  const notice = el("p", { class: "notice" });
  notice.setAttribute("role", "status");
  // It hangs over the page, so a click puts it away.
  notice.title = "Click to dismiss";
  notice.addEventListener("click", () => {
    notice.textContent = "";
  });
  const screen = el("div", { class: "screen" }, el("p", { text: "Loading…" }));
  root.replaceChildren(
    el(
      "header",
      { class: "top" },
      el(
        "div",
        { class: "bar" },
        el("h1", { text: "Re-roll" }),
        el("nav", { class: "bar-actions" }),
      ),
      notice,
    ),
    screen,
  );
  const actions = root.querySelector("nav");
  if (!actions) throw new Error("The page header is missing");

  // Errors stay until the next action; anything else clears itself, unless something newer replaced it.
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string, isError = false): void => {
    clearTimeout(sayTimer);
    notice.textContent = text;
    notice.classList.toggle("error", isError);
    if (text && !isError) {
      sayTimer = setTimeout(() => {
        if (notice.textContent === text) say("");
      }, 3000);
    }
  };

  // Keys for the whole page, such as Esc for Back, handled by the screen that owns them while it's shown.
  // `handle` says whether it used the key. Typing in a field and a busy page keep their keys.
  let keys: {
    readonly owner: HTMLElement;
    readonly handle: (event: KeyboardEvent) => boolean;
  } | null = null;
  document.addEventListener("keydown", (event) => {
    const { target } = event;
    if (
      !keys?.owner.isConnected ||
      root.inert ||
      event.defaultPrevented ||
      (target instanceof HTMLElement &&
        (target.isContentEditable || target.matches("input, textarea, select")))
    ) {
      return;
    }
    if (keys.handle(event)) event.preventDefault();
  });

  // A click anywhere outside the game's menu closes it, as a menu does.
  let currentMenu: HTMLDetailsElement | null = null;
  document.addEventListener("click", (event) => {
    if (currentMenu?.open && !currentMenu.contains(event.target as Node)) {
      currentMenu.open = false;
    }
  });

  // Number keys pick the story's numbered choices, as a reader turns to an entry. Never in a fight,
  // in a text field, with a drawer open or while the choices are held back.
  document.addEventListener("keydown", (event) => {
    const index = Number(event.key) - 1;
    if (!/^[1-9]$/.test(event.key) || event.repeat) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if ((event.target as Element).closest("input, textarea, select")) return;
    if (root.inert || document.querySelector("dialog[open]")) return;
    const story = screen.querySelector<HTMLElement>(".rail > .options.story");
    if (!story || story.closest("[inert]")) return;
    const picks = story.querySelectorAll<HTMLElement>(
      ".option > button:first-child",
    );
    const pick = picks[index];
    if (!pick) return;
    event.preventDefault();
    pick.click();
  });

  // Redrawing removes the button that had focus, so keyboard play needs it put somewhere new.
  let focusNext: HTMLElement | null = null;

  // Blocks input while a step is saving, so one click can't answer two decisions.
  const act = (work: () => Promise<void>): void => {
    // Going inert drops focus, so a button that survives the work (Save) gets it back.
    const previous = document.activeElement;
    root.inert = true;
    say("");
    work()
      .catch((error: unknown) => {
        say(error instanceof Error ? error.message : String(error), true);
      })
      .finally(() => {
        root.inert = false;
        if (focusNext) focusNext.focus();
        else if (previous instanceof HTMLElement) previous.focus();
        focusNext = null;
      });
  };

  // Before a new game: the choices its system asks for, such as difficulty, then Begin.
  const showSetup = async (adventure: {
    readonly id: string;
    readonly title: string;
  }): Promise<void> => {
    const settings = await game.settingsFor(adventure.id);
    const begin = (chosen: Readonly<Record<string, string>>): void => {
      act(async () => {
        await game.start(adventure.id, crypto.randomUUID().slice(0, 8), chosen);
        showGame();
      });
    };
    if (settings.length === 0) {
      begin({});
      return;
    }
    const chosen: Record<string, string> = Object.fromEntries(
      settings.map((setting) => [setting.id, setting.default]),
    );
    const heading = el("h2", { text: adventure.title });
    heading.tabIndex = -1;
    const groups = settings.map((setting) => {
      const cards = setting.options.map((option) => {
        const card = button("", () => {
          chosen[setting.id] = option.id;
          for (const other of cards) {
            other.setAttribute("aria-checked", String(other === card));
          }
        });
        card.className = "setting-card";
        card.setAttribute("role", "radio");
        card.setAttribute(
          "aria-checked",
          String(option.id === setting.default),
        );
        card.append(
          el("strong", { text: option.label }),
          el("span", { text: option.detail }),
        );
        return card;
      });
      const group = el("div", { class: "setting-cards" }, ...cards);
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", setting.label);
      return el(
        "section",
        { class: "setting" },
        el("h3", { text: setting.label }),
        group,
      );
    });
    const go = button("Begin the adventure", () => {
      begin({ ...chosen });
    });
    go.className = "begin";
    actions.replaceChildren(
      button("Menu", () => {
        act(showMenu);
      }),
    );
    screen.replaceChildren(
      el("section", { class: "setup" }, heading, ...groups, go),
    );
    focusNext = heading;
  };

  const showMenu = async (): Promise<void> => {
    actions.replaceChildren();
    document.title = "Re-roll";
    const [adventures, saves, books] = await Promise.all([
      game.listAdventures(),
      game.listSaves(),
      game.listBooks(),
    ]);
    const heading = el("h2", { text: "Choose an adventure" });
    heading.tabIndex = -1;
    const filter = el("input", { class: "search" });
    filter.type = "search";
    filter.placeholder = "Filter adventures";
    filter.setAttribute("aria-label", "Filter adventures");

    const row = (adventure: (typeof adventures)[number]): HTMLElement => {
      // Saves are sorted newest first, so the first match is the one to resume.
      const latest = saves.find((save) => save.adventure === adventure.id);
      return adventureCard(
        game,
        adventure,
        () => {
          act(() => showSetup(adventure));
        },
        latest
          ? {
              label: latest.label,
              go: () => {
                act(async () => {
                  await game.load(latest.path);
                  showGame();
                });
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

    // Saves come newest first, so the first is the game to carry on with.
    const [newest] = saves;
    const carryOn = newest
      ? [
          el(
            "section",
            { class: "continue" },
            el("h2", { text: "Continue" }),
            button(newest.label, () => {
              act(async () => {
                await game.load(newest.path);
                showGame();
              });
            }),
          ),
        ]
      : [];
    screen.replaceChildren(
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
                  act(() => showLoad(showMenu));
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
                  act(() => showLibrary(books));
                }),
              ),
            ]
          : []),
      ),
    );
    focusNext = heading;
  };

  // Opened from the main menu or a game, and Back returns there.
  const showLoad = async (back: () => void | Promise<void>): Promise<void> => {
    const saves = await game.listSaves();
    const goBack = (): void => {
      act(async () => {
        await back();
      });
    };
    actions.replaceChildren(button("Back", goBack));
    const { node, heading } = loadScreen(
      game,
      saves,
      {
        load: (save) => {
          act(async () => {
            await game.load(save.path);
            showGame();
          });
        },
        remove: (save, card) => {
          act(async () => {
            await game.deleteSave(save.path);
            focusNext = await collapseCard(card);
            say("Save deleted.");
          });
        },
      },
      back === showGame,
    );
    screen.replaceChildren(node);
    keys = {
      owner: node,
      handle: (event) => {
        if (event.key !== "Escape") return false;
        goBack();
        return true;
      },
    };
    focusNext = heading;
  };

  const showLibrary = async (books: readonly string[]): Promise<void> => {
    actions.replaceChildren(
      button("Menu", () => {
        act(showMenu);
      }),
    );
    const opened = await Promise.all(
      books.map((id) =>
        game
          .openBook(id)
          .then((book) => ({ id, title: book.title }))
          .catch(() => null),
      ),
    );
    const heading = el("h2", { text: "Book library" });
    heading.tabIndex = -1;
    screen.replaceChildren(
      el(
        "section",
        { class: "menu" },
        heading,
        el(
          "div",
          { class: "options" },
          ...opened.flatMap((book) =>
            book
              ? [
                  button(book.title, () => {
                    act(() => showBook(books, book.id));
                  }),
                ]
              : [],
          ),
        ),
      ),
    );
    focusNext = heading;
  };

  const showBook = async (
    books: readonly string[],
    id: string,
  ): Promise<void> => {
    const book = await game.openBook(id);
    actions.replaceChildren(
      button("Library", () => {
        act(() => showLibrary(books));
      }),
      button("Menu", () => {
        act(showMenu);
      }),
    );
    const heading = el("h2", { text: book.title });
    heading.tabIndex = -1;
    const search = el("input", { class: "search" });
    search.type = "search";
    search.placeholder = "Search headings";
    search.setAttribute("aria-label", "Search headings");
    const contents = el("nav", { class: "book-contents" });
    const text = el("pre", { class: "book-text" });
    text.tabIndex = -1;
    const drawContents = (): void => {
      const wanted = search.value.trim().toLowerCase();
      // shortcut: only the first matches are drawn, which is plenty once a search narrows them.
      const matches = book.sections
        .filter((section) => section.heading.toLowerCase().includes(wanted))
        .slice(0, 300);
      contents.replaceChildren(
        ...matches.map((section) => {
          const open = button(section.heading, () => {
            act(async () => {
              text.textContent = await game.readSection(id, section.file);
              focusNext = text;
            });
          });
          open.style.marginLeft = `${String((section.depth - 1) * 12)}px`;
          return open;
        }),
      );
    };
    search.addEventListener("input", drawContents);
    drawContents();
    screen.replaceChildren(
      el(
        "section",
        { class: "book" },
        heading,
        search,
        el("div", { class: "book-layout" }, contents, text),
      ),
    );
    focusNext = heading;
  };

  // A side drawer: the character sheet or the journal, opened from the top bar so the stage stays clear.
  // `head` is its heading, or for the sheet the party tabs, since the sheet names itself.
  const drawer = (
    label: string,
    head: Node,
    ...content: Node[]
  ): HTMLDialogElement => {
    const close = el("button", { text: "Close" });
    const node = el(
      "dialog",
      { class: "drawer" },
      el("header", { class: "drawer-head" }, head, el("form", {}, close)),
      ...content,
    );
    node.querySelector("form")?.setAttribute("method", "dialog");
    node.setAttribute("aria-label", label);
    // A click on the dimmed page beside the drawer closes it.
    node.addEventListener("click", (event) => {
      if (event.target === node) node.close();
    });
    return node;
  };

  // Restarts a CSS entrance animation on a node that stays in the page.
  const enter = (node: HTMLElement): void => {
    node.classList.remove("enter");
    node.getBoundingClientRect(); // a reflow, so the animation starts again
    node.classList.add("enter");
  };

  const showGame = (): void => {
    const title = el("h2", { class: "scene-title" });
    title.tabIndex = -1;
    const sceneArt = el("div", { class: "scene-art" });
    let artShown: string | null = null;
    const scene = el("p", { class: "scene-text" });
    let sceneShown: string | null = null;
    const ending = el("section", { class: "ending" });
    ending.hidden = true;
    const combat = el("div");
    const combatGridSlot = el("div");
    combatGridSlot.id = "combat-grid-slot";
    combatGridSlot.hidden = true;
    let board: Board | null = null;
    let cuesShown: number | null = null; // null until the first draw, which shows a loaded game as it stands
    // The newest lines of the journal, under the board, so the latest result is visible without the whole log.
    const ticker = el("ol", { class: "ticker" });
    ticker.setAttribute("aria-hidden", "true");
    // The player's level-up, set apart from the ticker as the books set off a callout.
    const levelUp = el("p", { class: "level-up" });
    levelUp.hidden = true;
    const prompt = el("p", { class: "prompt" });
    const card = el("section", { class: "decision-card" });
    card.setAttribute("role", "status"); // a find is news, read out as it appears
    card.hidden = true; // until a card comes
    const options = el("div", { class: "options" });
    let decisionShown: string | null = null;
    let openGroup: string | null = null;
    let showAll = false;
    const log = el("ol", { class: "log" });
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "What has happened so far");
    log.tabIndex = 0;
    const about = el("details", { class: "about" });
    const fullSheet = el("div");
    // One panel per party member, kept between redraws so each keeps its own open sections.
    const sheetPanels = new Map<string, HTMLElement>();
    let sheetShown: string | null = null; // null for the player's
    const sheetTabs = el("div", { class: "tabs" });
    const sheetDrawer = drawer("Character", sheetTabs, fullSheet);
    const journalDrawer = drawer(
      "Journal",
      el("h2", { text: "Journal" }),
      log,
      about,
    );
    const openSheet = (): void => {
      journalDrawer.close();
      sheetDrawer.showModal();
    };
    const openJournal = (): void => {
      sheetDrawer.close();
      journalDrawer.showModal();
      log.scrollTop = log.scrollHeight;
    };
    const hud = button("", openSheet);
    hud.className = "hud";
    hud.setAttribute("aria-label", "Open the character sheet");
    hud.setAttribute("aria-keyshortcuts", "Meta+I");
    hud.title = "Character (⌘I)";
    const journal = button("Journal", openJournal);
    journal.setAttribute("aria-keyshortcuts", "Meta+J");
    journal.title = "Journal (⌘J)";

    const restart = (): void => {
      act(async () => {
        await game.restart(crypto.randomUUID().slice(0, 8));
        showGame();
      });
    };
    // Restarting throws away progress since the last save, so it takes a second press.
    let restartArmed = false;
    const restartButton = button("Restart adventure", () => {
      if (!restartArmed) {
        restartArmed = true;
        restartButton.textContent = "Really restart?";
        return;
      }
      restart();
    });
    const summary = el("summary", { text: "Menu" });
    const saveGame = (): void => {
      gameMenu.open = false;
      act(async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await game.save(stamp);
        enter(saved);
        focusNext = summary;
      });
    };
    const loadGame = (): void => {
      gameMenu.open = false;
      act(() => showLoad(showGame));
    };
    // A menu item with its shortcut beside it, such as ⌘S.
    const shortcut = (
      item: HTMLButtonElement,
      key: string,
    ): HTMLButtonElement => {
      item.setAttribute("aria-keyshortcuts", `Meta+${key}`);
      const hint = el("kbd", { text: `⌘${key}` });
      hint.setAttribute("aria-hidden", "true"); // aria-keyshortcuts already says it
      item.append(hint);
      return item;
    };
    const menuItems = el(
      "div",
      { class: "game-menu-items" },
      shortcut(button("Save game", saveGame), "S"),
      shortcut(button("Load game", loadGame), "L"),
      restartButton,
      soundToggle(),
      button("Main menu", () => {
        act(showMenu);
      }),
    );
    const gameMenu = el("details", { class: "game-menu" }, summary, menuItems);
    const items = (): HTMLElement[] => [
      ...menuItems.querySelectorAll<HTMLElement>("button"),
    ];
    gameMenu.addEventListener("toggle", () => {
      restartArmed = false;
      restartButton.textContent = "Restart adventure";
      if (gameMenu.open) items()[0]?.focus();
    });
    // Keys as in a menu: Esc closes it back to its button, and the arrows walk its items.
    gameMenu.addEventListener("keydown", (event) => {
      if (!gameMenu.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        gameMenu.open = false;
        summary.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    });
    currentMenu = gameMenu;
    // Every choice is saved as it's made; this says so without getting in the way.
    const saved = el("span", { class: "saved", text: "✓ Saved" });
    saved.setAttribute("role", "status");
    const flashSaved = (): void => {
      if (game.view().warnings.length > 0) return; // a failed autosave shows its own warning
      enter(saved);
    };
    const camp = campfire(game, act, (rested) => {
      draw();
      if (rested) flashSaved();
      firstFocus().focus();
    });
    // ⌘ (or Ctrl) shortcuts for the bar, except while the camp is open, where leaving would cut a rest short.
    const shortcuts: Readonly<Record<string, () => void>> = {
      s: saveGame,
      l: loadGame,
      i: () => {
        if (sheetDrawer.open) sheetDrawer.close();
        else openSheet();
      },
      j: () => {
        if (journalDrawer.open) journalDrawer.close();
        else openJournal();
      },
    };
    actions.replaceChildren(saved, camp.button, hud, journal, gameMenu);
    const stage = el(
      "main",
      { class: "play" },
      title,
      sceneArt,
      scene,
      combatGridSlot,
      // In a fight this is the column beside the map; otherwise it lays out as if it weren't there.
      // The ending comes after the ticker's last lines, and beside the map when a fight ends the run.
      el(
        "div",
        { class: "rail" },
        ticker,
        levelUp,
        combat,
        card,
        prompt,
        options,
        ending,
      ),
    );
    screen.replaceChildren(
      el(
        "div",
        { class: "game" },
        stage,
        sheetDrawer,
        journalDrawer,
        camp.dialog,
      ),
    );
    keys = {
      owner: stage,
      handle: (event) => {
        const run = shortcuts[event.key.toLowerCase()];
        if (
          !run ||
          !(event.metaKey || event.ctrlKey) ||
          event.altKey ||
          event.shiftKey ||
          camp.dialog.open
        ) {
          return false;
        }
        run();
        return true;
      },
    };

    let linesShown = 0;
    let tickerShown = 0; // the latest ticker update, so a stale one never lands
    let choiceShown = 0; // the same, for revealing the choices
    // An ending takes focus on its heading, so a repeated key press can't skip past it.
    const firstFocus = (): HTMLElement =>
      options.querySelector("button") ?? ending.querySelector("h3") ?? title;
    const draw = (): void => {
      const view = game.view();
      const factory = boards[view.system];
      if (factory && !board) {
        board = factory(combatGridSlot, {
          imageUrl: (path) => game.imageUrl(path),
          sound: () => soundOn,
          answer: (...optionIds) => {
            act(async () => {
              for (const optionId of optionIds) await game.answer(optionId);
              draw();
              flashSaved();
              // Played on the map, so the page stays put rather than jumping to the buttons.
              focusNext = null;
            });
          },
        });
      }
      const cues = view.cues.slice(cuesShown ?? view.cues.length);
      board?.update({
        state: view.systemState,
        decision: view.decision,
        combat: view.combat,
        art: view.monsterArt,
        tokens: view.tokenArt,
        assetRoot: view.adventureRoot,
        sceneArt: view.sceneArt,
        cues,
      });
      const firstDraw = cuesShown === null;
      cuesShown = view.cues.length;
      stage.classList.toggle("in-combat", view.combat !== null);
      camp.update(view);

      title.textContent = view.title;
      document.title = view.sceneTitle
        ? `${view.title} — ${view.sceneTitle}`
        : view.title;
      if (view.scene !== sceneShown) {
        sceneShown = view.scene;
        scene.textContent = view.scene;
        if (!firstDraw) enter(scene);
      }
      // Only touched on a change, so staying in a scene doesn't reload its picture.
      if (view.sceneArt !== artShown) {
        artShown = view.sceneArt;
        sceneArt.replaceChildren(
          ...(view.sceneArt ? [picture(game, view.sceneArt, "", "art")] : []),
        );
        if (!firstDraw) enter(sceneArt);
      }
      const end = endingOf(view);
      const endTitle = el("h3", { text: end?.title ?? "" });
      endTitle.tabIndex = -1;
      const again = button("Play again", restart);
      again.className = "begin";
      const tally = (moment: string, one: string, many: string): string[] => {
        const count = view.log.filter((line) => line.moment === moment).length;
        return count > 0
          ? [`${String(count)} ${count === 1 ? one : many}`]
          : [];
      };
      const summary = [
        ...tally("foeDefeated", "foe defeated", "foes defeated"),
        ...tally("levelUp", "level gained", "levels gained"),
      ].join(" · ");
      ending.replaceChildren(
        ...(end
          ? [
              endTitle,
              ...(end.text ? [el("p", { text: end.text })] : []),
              ...(summary
                ? [el("p", { class: "ending-tally", text: summary })]
                : []),
              el(
                "div",
                { class: "ending-actions" },
                again,
                button("Back to the menu", () => {
                  act(showMenu);
                }),
              ),
            ]
          : []),
      );
      // A run that ends under a map can leave its ending below the fold, so it comes into view once
      // the board has shown how it ended.
      if (end && ending.hidden) {
        void (board?.settled?.() ?? Promise.resolve()).then(() => {
          ending.scrollIntoView({ block: "nearest" });
        });
      }
      ending.hidden = !end;
      ending.dataset.ending = view.ended ?? "";
      // With a board showing the fight, the written turn order folds away until it's wanted.
      const order = view.combat
        ? renderCombat(game, view.combat, view.monsterArt)
        : null;
      replaceKeepingOpen(
        combat,
        ...(order
          ? [
              board
                ? el(
                    "details",
                    { class: "initiative-details" },
                    el("summary", { text: "Turn order and conditions" }),
                    order,
                  )
                : order,
            ]
          : []),
      );

      const { decision } = view;
      // A card says what the prompt would, so it stands in for it.
      prompt.textContent =
        decision && decision.prompt !== view.scene && !view.card
          ? decision.prompt
          : "";
      const fresh = (decision?.id ?? null) !== decisionShown;
      // Keyed on what it says rather than on the decision, so equipping a find from the card doesn't
      // show it again; the purse is in the key, so a second find of the same things still shows.
      const shownCard = view.card;
      const cardKey = shownCard
        ? JSON.stringify([shownCard.title, shownCard.lines, shownCard.footer])
        : "";
      // Filled and shown once the board has finished, so its entrance isn't spent, and its news
      // isn't announced, while it's still hidden. The key is set only then, so a newer draw retries.
      const revealCard =
        cardKey !== (card.dataset.key ?? "")
          ? (): void => {
              card.dataset.key = cardKey;
              card.replaceChildren(
                ...(shownCard
                  ? [
                      el(
                        "h3",
                        {},
                        ...(shownCard.icon
                          ? [
                              el("span", {
                                class: "card-icon",
                                text: shownCard.icon,
                              }),
                            ]
                          : []),
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
              card.hidden = !shownCard;
              if (shownCard && !firstDraw) {
                enter(card);
                if (soundOn) cardSound?.();
              }
            }
          : null;
      if (fresh) {
        decisionShown = decision?.id ?? null;
        showAll = false;
        openGroup = null;
      }
      const optionRow = (option: OptionView, index: number): HTMLElement => {
        const row = el(
          "div",
          { class: "option" },
          button(option.label, () => {
            act(async () => {
              await game.answer(option.id);
              draw();
              flashSaved();
            });
          }),
        );
        row.style.setProperty("--i", String(index));
        if (option.detail) {
          const info = el("p", { class: "option-detail", text: option.detail });
          info.hidden = true;
          const toggle = button("ⓘ", () => {
            info.hidden = !info.hidden;
            toggle.setAttribute("aria-expanded", String(!info.hidden));
          });
          toggle.className = "info";
          toggle.setAttribute("aria-expanded", "false");
          toggle.setAttribute("aria-label", `Details of ${option.label}`);
          row.append(toggle, info);
        }
        return row;
      };
      // A long list shows its first few and its last, such as "Stay where you are", until asked for the rest.
      const trimmed = (list: readonly OptionView[]): HTMLElement[] => {
        if (showAll || list.length <= 7) return list.map(optionRow);
        const last = list.at(-1);
        const more = button(`More choices (${String(list.length - 6)})`, () => {
          showAll = true;
          draw();
          options.querySelectorAll<HTMLElement>(".option > button")[5]?.focus();
        });
        more.className = "more";
        return [
          ...list.slice(0, 5).map(optionRow),
          more,
          ...(last ? [optionRow(last, 6)] : []),
        ];
      };
      // A lone group of actions needs no tab to open it, so it lists with the rest.
      const titled = view.optionGroups.filter((group) => group.title !== null);
      const tabs = titled.length > 1 ? titled : [];
      const chosen = tabs.find((group) => group.title === openGroup);
      // Outside a fight the choices read as a book's numbered entries, and number keys pick them.
      options.classList.toggle("story", !view.combat);
      options.replaceChildren(
        ...view.optionGroups
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
                    openGroup = openGroup === name ? null : name;
                    draw();
                    // The redraw replaced this button, so focus goes to its replacement.
                    [...options.querySelectorAll<HTMLElement>(".tab")]
                      .find((item) => item.textContent === name)
                      ?.focus();
                  });
                  tab.className = name === openGroup ? "tab open" : "tab";
                  tab.setAttribute("aria-expanded", String(name === openGroup));
                  return tab;
                }),
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
      // The next choice waits for the board to finish, so it can't be picked under a die still to throw.
      if (!firstDraw && board?.settled && cues.length > 0) {
        const shownChoice = ++choiceShown;
        prompt.inert = options.inert = true;
        stage.classList.add("settling");
        void board.settled().then(() => {
          if (shownChoice !== choiceShown) return;
          prompt.inert = options.inert = false;
          stage.classList.remove("settling");
          if (fresh) enter(options);
          revealCard?.();
          // Focus meant for a choice was dropped while it was inert, or sits on a board that just hid.
          const focused = document.activeElement;
          if (
            !focused ||
            focused === document.body ||
            !focused.checkVisibility()
          ) {
            firstFocus().focus();
          }
        });
      } else {
        if (fresh && !firstDraw) enter(options);
        revealCard?.();
      }

      const added = view.log.slice(linesShown);
      log.append(
        ...added.map((line) =>
          el(
            "li",
            { class: line.kind },
            ...(line.actor && !line.text.startsWith(line.actor)
              ? [el("span", { class: "log-actor", text: `${line.actor}: ` })]
              : []),
            document.createTextNode(line.text),
          ),
        ),
      );
      linesShown = view.log.length;
      log.scrollTop = log.scrollHeight;
      const levels = added.filter((line) => line.moment === "levelUp");
      // A card stands in for the prompt, which repeats a journal line, so the ticker leaves that line out.
      const news = added
        .filter((line) => line.kind === "event" && !levels.includes(line))
        .filter((line) => !(view.card && line.text === decision?.prompt))
        .slice(-3);
      if (!firstDraw && (news.length > 0 || levels.length > 0)) {
        // The words wait for the board to finish showing what they describe.
        const shown = ++tickerShown;
        ticker.replaceChildren();
        levelUp.hidden = true;
        void (board?.settled?.() ?? Promise.resolve()).then(() => {
          if (shown !== tickerShown) return;
          levelUp.replaceChildren(
            el("strong", { text: "Level up!" }),
            ...levels.map((line) => el("span", { text: ` ${line.text}` })),
          );
          levelUp.hidden = levels.length === 0;
          if (levels.length > 0) enter(levelUp);
          ticker.replaceChildren(
            ...news.map((line, index) => {
              const item = el("li", { text: line.text });
              item.style.setProperty("--i", String(index));
              return item;
            }),
          );
          enter(ticker);
        });
      }

      const [playerSheet] = view.sheets;
      hud.hidden = !playerSheet;
      if (playerSheet) {
        hud.replaceChildren(
          el("span", { class: "hud-name", text: playerSheet.title }),
          ...(playerSheet.summary ?? []).map((row) =>
            el(
              "span",
              { class: "hud-stat" },
              el("small", { text: row.label }),
              document.createTextNode(` ${row.value}`),
              ...(row.meter === undefined ? [] : [meter(row.meter)]),
            ),
          ),
        );
      }
      const shown =
        view.sheets.find((item) => item.id === sheetShown) ?? playerSheet;
      const panels = view.sheets.map((item) => {
        const panel = sheetPanels.get(item.id) ?? el("div");
        sheetPanels.set(item.id, panel);
        replaceKeepingOpen(
          panel,
          renderSheet(item, true, (row) => {
            const { option } = row;
            // Only on the sheet of whoever the decision is for, so a companion's row can't answer for the player.
            const offered =
              decision?.actor === item.id &&
              decision.options.some((o) => o.id === option?.id);
            if (!option || (!offered && !option.hint)) return [];
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
              act(async () => {
                await game.answer(option.id);
                draw();
                flashSaved();
              });
            });
            pick.className = "row-option";
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
      sheetTabs.replaceChildren(
        ...(view.sheets.length > 1
          ? view.sheets.map((item) => {
              const tab = button(item.title, () => {
                sheetShown = item.id;
                draw();
                // The redraw replaced this button, so focus goes to its replacement.
                sheetTabs
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
      fullSheet.replaceChildren(...panels);
      about.replaceChildren(
        el("summary", { text: "About" }),
        el("p", { text: `Re-roll. ${view.about}` }),
        ...view.attributions.map((text) => el("p", { text })),
        ...credits.map((text) => el("p", { text })),
      );
      if (view.warnings.length > 0) say(view.warnings.join(" "), true);

      // While the board plays, keys go to it, so Enter throws your die.
      focusNext = stage.classList.contains("settling")
        ? combatGridSlot.querySelector<HTMLElement>("[tabindex]")
        : null;
      focusNext ??= firstFocus();
    };
    draw();
  };

  act(showMenu);
}
