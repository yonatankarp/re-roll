import type { Game, GameView } from "./session.ts";
import type { CombatView, OptionView, SheetView } from "./system-ui.ts";

// The whole page, drawn from the plain data in GameView. Knows nothing about any rule system.

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
    el("summary", { text: value ? `${label} (${value})` : label }),
    el("p", { text: detail }),
  );
}

function renderSheet(sheet: SheetView): HTMLElement {
  return el(
    "section",
    { class: "sheet-body" },
    el("h2", { text: sheet.title }),
    ...sheet.sections
      .filter((section) => section.rows.length > 0)
      .map((section) =>
        el(
          "section",
          {},
          el("h3", { text: section.title }),
          el(
            "dl",
            {},
            ...section.rows.flatMap((row) =>
              row.detail
                ? []
                : [
                    el("dt", { text: row.label }),
                    el("dd", { text: row.value }),
                  ],
            ),
          ),
          ...section.rows.flatMap((row) =>
            row.detail ? [detailsRow(row.label, row.value, row.detail)] : [],
          ),
        ),
      ),
  );
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

export function mountShell(root: HTMLElement, game: Game): void {
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

  const showGame = (): void => {
    const title = el("h2");
    title.tabIndex = -1;
    const sceneArt = el("div", { class: "scene-art" });
    let artShown: string | null = null;
    const scene = el("p", { class: "scene-text" });
    const ending = el("section", { class: "ending" });
    const combat = el("div");
    // The PixiJS combat grid mounts here once the engine tracks positions (section 3 of the design).
    const combatGridSlot = el("div");
    combatGridSlot.id = "combat-grid-slot";
    combatGridSlot.hidden = true;
    const prompt = el("p", { class: "prompt" });
    const options = el("div", { class: "options" });
    const log = el("ol", { class: "log" });
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "What has happened so far");
    log.tabIndex = 0;
    const sheet = el("aside", { class: "sheet" });
    const about = el("details", { class: "about" });

    actions.replaceChildren(
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
    screen.replaceChildren(
      el(
        "div",
        { class: "game" },
        el(
          "main",
          { class: "play" },
          title,
          sceneArt,
          scene,
          ending,
          combat,
          combatGridSlot,
          prompt,
          options,
          el("h3", { text: "Story so far" }),
          log,
          about,
        ),
        sheet,
      ),
    );

    let linesShown = 0;
    const draw = (): void => {
      const view = game.view();
      title.textContent = view.title;
      scene.textContent = view.scene;
      // Only touched on a change, so staying in a scene doesn't reload its picture.
      if (view.sceneArt !== artShown) {
        artShown = view.sceneArt;
        sceneArt.replaceChildren(
          ...(view.sceneArt ? [picture(game, view.sceneArt, "", "art")] : []),
        );
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
      combat.replaceChildren(
        ...(view.combat
          ? [renderCombat(game, view.combat, view.monsterArt)]
          : []),
      );

      const { decision } = view;
      prompt.textContent =
        decision && decision.prompt !== view.scene ? decision.prompt : "";
      const optionRow = (option: OptionView): HTMLElement => {
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
        if (option.detail) {
          const info = el("p", { class: "option-detail", text: option.detail });
          info.hidden = true;
          const toggle = button("Details", () => {
            info.hidden = !info.hidden;
            toggle.setAttribute("aria-expanded", String(!info.hidden));
          });
          toggle.setAttribute("aria-expanded", "false");
          toggle.setAttribute("aria-label", `Details of ${option.label}`);
          row.append(toggle, info);
        }
        return row;
      };
      options.replaceChildren(
        ...view.optionGroups.map((group) => {
          if (group.title === null) {
            return el(
              "div",
              { class: "options" },
              ...group.options.map(optionRow),
            );
          }
          const node = el(
            "details",
            { class: "option-group" },
            el("summary", { text: group.title }),
            el("div", { class: "options" }, ...group.options.map(optionRow)),
          );
          node.open = true;
          return node;
        }),
      );

      log.append(
        ...view.log
          .slice(linesShown)
          .map((line) =>
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

      // A redraw must not close what the player has opened to read.
      const opened = new Set(
        [...sheet.querySelectorAll("details[open] > summary")].map(
          (item) => item.textContent,
        ),
      );
      sheet.replaceChildren(...(view.sheet ? [renderSheet(view.sheet)] : []));
      for (const item of sheet.querySelectorAll("details")) {
        item.open = opened.has(
          item.querySelector("summary")?.textContent ?? "",
        );
      }
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
