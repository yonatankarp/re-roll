import type { Game, GameView } from "./session.ts";
import type {
  Board,
  BoardHost,
  CombatView,
  OptionView,
  SheetSection,
  SheetView,
} from "./system-ui.ts";

// The whole page, drawn from the plain data in GameView. Knows nothing about any rule system.

// A system's own encounter view, such as a combat board, keyed by system id. It draws its own DOM in the slot.
export type BoardFactory = (slot: HTMLElement, host: BoardHost) => Board;

function el<K extends keyof HTMLElementTagNameMap>(
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

function button(label: string, onClick: () => void): HTMLButtonElement {
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
    soundOn = !soundOn;
    node.setAttribute("aria-pressed", String(soundOn));
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
    } catch {
      // Not remembered, but still applies for now.
    }
  });
  node.setAttribute("aria-pressed", String(soundOn));
  return node;
}

// A picture that is missing or won't load shows nothing at all.
function picture(
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

function detailsRow(label: string, value: string, detail: string): HTMLElement {
  return el(
    "details",
    { class: "sheet-detail" },
    el(
      "summary",
      {},
      el("span", { text: label }),
      ...(value ? [el("span", { class: "sheet-value", text: value })] : []),
    ),
    el("p", { text: detail }),
  );
}

function renderSection(section: SheetSection): HTMLElement {
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
              : [el("dt", { text: row.label }), el("dd", { text: row.value })],
          ),
        ),
        ...section.rows.flatMap((row) =>
          row.detail ? [detailsRow(row.label, row.value, row.detail)] : [],
        ),
      );
  }
}

// The side panel shows the pinned sections; the full sheet shows them all.
function renderSheet(sheet: SheetView, full: boolean): HTMLElement {
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
        .map(renderSection),
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
): void {
  const notice = el("p", { class: "notice" });
  notice.setAttribute("role", "status");
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

  const say = (text: string, isError = false): void => {
    notice.textContent = text;
    notice.classList.toggle("error", isError);
  };

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

  const showMenu = async (): Promise<void> => {
    actions.replaceChildren();
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
      const start = button(adventure.title, () => {
        act(async () => {
          await game.start(adventure.id, crypto.randomUUID().slice(0, 8));
          showGame();
        });
      });
      if (adventure.levels) {
        start.append(
          el("span", {
            class: "meta",
            text: ` levels ${adventure.levels}`,
          }),
        );
      }
      const node = el("div", { class: "row" }, start);
      if (latest) {
        const resume = button("Resume", () => {
          act(async () => {
            await game.load(latest.path);
            showGame();
          });
        });
        resume.setAttribute(
          "aria-label",
          `Resume ${adventure.title}, ${latest.label}`,
        );
        node.append(resume);
      }
      node.dataset.title = adventure.title.toLowerCase();
      return node;
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
              el("div", { class: "options" }, ...chosen.map(row)),
            ),
          ]
        : [];
    });
    filter.addEventListener("input", () => {
      const wanted = filter.value.trim().toLowerCase();
      for (const group of groups) {
        const rows = [...group.querySelectorAll<HTMLElement>(".row")];
        for (const item of rows) {
          item.hidden = !item.dataset.title?.includes(wanted);
        }
        group.hidden = rows.every((item) => item.hidden);
      }
    });

    const saveRow = (save: (typeof saves)[number]): HTMLElement => {
      const load = button(save.label, () => {
        act(async () => {
          await game.load(save.path);
          showGame();
        });
      });
      // A second press confirms, which also works where the webview has no confirm dialog.
      let armed = false;
      const remove = button("Delete", () => {
        if (!armed) {
          armed = true;
          remove.textContent = "Really delete?";
          return;
        }
        act(async () => {
          await game.deleteSave(save.path);
          await showMenu();
        });
      });
      remove.setAttribute("aria-label", `Delete ${save.label}`);
      return el("div", { class: "row" }, load, remove);
    };

    screen.replaceChildren(
      el(
        "section",
        { class: "menu" },
        heading,
        filter,
        ...groups,
        ...(saves.length > 0
          ? [
              el(
                "details",
                { class: "saves" },
                el("summary", {
                  text: `Saved games (${String(saves.length)})`,
                }),
                el("div", { class: "options" }, ...saves.map(saveRow)),
              ),
            ]
          : []),
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
  const drawer = (label: string, ...content: Node[]): HTMLDialogElement => {
    const close = el("button", { text: "Close" });
    const node = el(
      "dialog",
      { class: "drawer" },
      el(
        "header",
        { class: "drawer-head" },
        el("h2", { text: label }),
        el("form", {}, close),
      ),
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
    const combat = el("div");
    const combatGridSlot = el("div");
    combatGridSlot.id = "combat-grid-slot";
    combatGridSlot.hidden = true;
    let board: Board | null = null;
    let cuesShown: number | null = null; // null until the first draw, which shows a loaded game as it stands
    // The newest lines of the journal, under the board, so the latest result is visible without the whole log.
    const ticker = el("ol", { class: "ticker" });
    ticker.setAttribute("aria-hidden", "true");
    const prompt = el("p", { class: "prompt" });
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
    const sheetDrawer = drawer("Character", fullSheet);
    const journalDrawer = drawer("Journal", log, about);
    const hud = button("", () => {
      sheetDrawer.showModal();
    });
    hud.className = "hud";
    hud.setAttribute("aria-label", "Open the character sheet");
    const journal = button("Journal", () => {
      journalDrawer.showModal();
      log.scrollTop = log.scrollHeight;
    });

    actions.replaceChildren(
      hud,
      journal,
      soundToggle(),
      button("Save", () => {
        act(async () => {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const path = await game.save(stamp);
          say(`Saved as ${path}.`);
        });
      }),
      button("Menu", () => {
        act(showMenu);
      }),
    );
    const stage = el(
      "main",
      { class: "play" },
      title,
      sceneArt,
      scene,
      ending,
      combatGridSlot,
      ticker,
      combat,
      prompt,
      options,
    );
    screen.replaceChildren(
      el("div", { class: "game" }, stage, sheetDrawer, journalDrawer),
    );

    let linesShown = 0;
    let tickerShown = 0; // the latest ticker update, so a stale one never lands
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
              // Played on the map, so the page stays put rather than jumping to the buttons.
              focusNext = null;
            });
          },
        });
      }
      board?.update({
        state: view.systemState,
        decision: view.decision,
        combat: view.combat,
        art: view.monsterArt,
        sceneArt: view.sceneArt,
        cues: view.cues.slice(cuesShown ?? view.cues.length),
      });
      const firstDraw = cuesShown === null;
      cuesShown = view.cues.length;
      stage.classList.toggle("in-combat", view.combat !== null);

      title.textContent = view.title;
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
      ending.replaceChildren(
        ...(end
          ? [
              endTitle,
              ...(end.text ? [el("p", { text: end.text })] : []),
              button("Back to the menu", () => {
                act(showMenu);
              }),
            ]
          : []),
      );
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
      prompt.textContent =
        decision && decision.prompt !== view.scene ? decision.prompt : "";
      const fresh = (decision?.id ?? null) !== decisionShown;
      if (fresh) {
        decisionShown = decision?.id ?? null;
        showAll = false;
        const titled = view.optionGroups.filter((group) => group.title);
        // A single group of actions opens by itself; with several, the player picks one.
        openGroup = titled.length === 1 ? (titled[0]?.title ?? null) : null;
      }
      const optionRow = (option: OptionView, index: number): HTMLElement => {
        const row = el(
          "div",
          { class: "option" },
          button(option.label, () => {
            act(async () => {
              await game.answer(option.id);
              draw();
            });
          }),
        );
        row.style.setProperty("--i", String(index));
        if (option.detail) {
          const info = el("p", { class: "option-detail", text: option.detail });
          info.hidden = true;
          const toggle = button("i", () => {
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
      const tabs = view.optionGroups.filter((group) => group.title !== null);
      const chosen = tabs.find((group) => group.title === openGroup);
      options.replaceChildren(
        ...view.optionGroups
          .filter((group) => group.title === null)
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
      if (fresh && !firstDraw) enter(options);

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
      const news = added.filter((line) => line.kind === "event").slice(-3);
      if (!firstDraw && news.length > 0) {
        // The words wait for the board to finish showing what they describe.
        const shown = ++tickerShown;
        ticker.replaceChildren();
        void (board?.settled?.() ?? Promise.resolve()).then(() => {
          if (shown !== tickerShown) return;
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
        replaceKeepingOpen(panel, renderSheet(item, true));
        panel.hidden = item !== shown;
        return panel;
      });
      fullSheet.replaceChildren(
        ...(view.sheets.length > 1
          ? [
              el(
                "div",
                { class: "tabs" },
                ...view.sheets.map((item) => {
                  const tab = button(item.title, () => {
                    sheetShown = item.id;
                    draw();
                    // The redraw replaced this button, so focus goes to its replacement.
                    fullSheet
                      .querySelector<HTMLElement>(
                        `.tab[data-id="${CSS.escape(item.id)}"]`,
                      )
                      ?.focus();
                  });
                  tab.className = item === shown ? "tab open" : "tab";
                  tab.dataset.id = item.id;
                  tab.setAttribute("aria-pressed", String(item === shown));
                  return tab;
                }),
              ),
            ]
          : []),
        ...panels,
      );
      about.replaceChildren(
        el("summary", { text: "About" }),
        el("p", { text: `Re-roll. ${view.about}` }),
        ...view.attributions.map((text) => el("p", { text })),
      );
      if (view.warnings.length > 0) say(view.warnings.join(" "), true);

      // An ending takes focus on its heading, so a repeated key press can't skip past it.
      focusNext =
        options.querySelector("button") ?? ending.querySelector("h3") ?? title;
    };
    draw();
  };

  act(showMenu);
}
