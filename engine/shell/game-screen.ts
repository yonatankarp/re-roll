import { type Board, type OptionView } from "./system-ui.ts";
import { soundControls } from "./sound-panel.ts";
import { journalTabs, rollsWhy } from "./journal-tabs.ts";
import { campfire } from "./campfire.ts";
import { shopPanel } from "./shop.ts";
import { CANT_OPEN, OPENING, type ShellContext } from "./context.ts";
import { button, el, picture, replaceKeepingOpen } from "./dom.ts";
import { keyshortcuts, MOD } from "./keys.ts";
import { endingOf } from "./ending.ts";
import { meter, renderCombat, renderSheet } from "./sheet-view.ts";

// A small "i" in a ring, for an option's details, drawn in the button's ink.
const INFO_ICON =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">' +
  '<circle cx="10" cy="10" r="8"/><path d="M10 9v5" stroke-linecap="round"/>' +
  '<circle cx="10" cy="6" r=".6" fill="currentColor"/></svg>';

// A side drawer: the character sheet or the journal, opened from the top bar so the stage stays clear.
// `head` is its heading, or for the sheet the party tabs, since the sheet names itself.
function drawer(
  label: string,
  head: Node,
  ...content: Node[]
): HTMLDialogElement {
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
}

// Restarts a CSS entrance animation on a node that stays in the page.
function enter(node: HTMLElement): void {
  node.classList.remove("enter");
  node.getBoundingClientRect(); // a reflow, so the animation starts again
  node.classList.add("enter");
}

export function showGame(ctx: ShellContext): void {
  const title = el("h2", { class: "scene-title" });
  title.tabIndex = -1;
  const sceneArt = el("div", { class: "scene-art" });
  let artShown: string | null = null;
  const scene = el("p", { class: "scene-text" });
  let sceneShown: string | null = null;
  const sound = soundControls((path) => ctx.game.imageUrl(path));
  const ending = el("section", { class: "ending" });
  ending.hidden = true;
  const combat = el("div");
  const combatGridSlot = el("div");
  combatGridSlot.id = "combat-grid-slot";
  combatGridSlot.hidden = true;
  let board: Board | null = null;
  let cuesShown: number | null = null; // null until the first draw, which shows a loaded game as it stands
  // The newest lines of the journal, under the board, so the latest result is visible without the whole log.
  // Read out as it changes, so hits, misses and enemy turns aren't silent.
  const ticker = el("ol", { class: "ticker" });
  ticker.setAttribute("aria-live", "polite");
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
  const journalTabsView = journalTabs(log);
  const why = rollsWhy();
  const journalDrawer = drawer(
    "Journal",
    journalTabsView.head,
    journalTabsView.body,
    about,
  );
  const openSheet = (): void => {
    journalDrawer.close();
    sheetDrawer.showModal();
  };
  const openJournal = (): void => {
    sheetDrawer.close();
    journalDrawer.showModal();
    journalTabsView.update(ctx.game.view()); // open now, so the leads shown count as seen
    log.scrollTop = log.scrollHeight;
  };
  const hud = button("", openSheet);
  hud.className = "hud";
  hud.setAttribute("aria-label", "Open the character sheet");
  hud.setAttribute("aria-keyshortcuts", keyshortcuts("I"));
  hud.title = `Character (${MOD}I)`;
  const journal = button("Journal", openJournal);
  journal.setAttribute("aria-keyshortcuts", keyshortcuts("J"));
  journal.title = `Journal (${MOD}J)`;

  const restart = (): void => {
    ctx.act(
      async () => {
        await ctx.game.restart(crypto.randomUUID().slice(0, 8));
        ctx.showGame();
      },
      { busy: OPENING, failed: CANT_OPEN },
    );
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
    ctx.act(async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await ctx.game.save(stamp);
      enter(saved);
      ctx.focusNext = summary;
    });
  };
  const loadGame = (): void => {
    gameMenu.open = false;
    ctx.act(() => ctx.showLoad(ctx.showGame), { busy: "" });
  };
  // Takes back the last choice, where a forgiving difficulty allows it.
  const undoChoice = (): void => {
    if (!ctx.game.view().canUndo) return;
    gameMenu.open = false;
    ctx.act(async () => {
      await ctx.game.undo();
      ctx.showGame();
      ctx.say("Your last choice is undone.");
    });
  };
  // A menu item with its shortcut beside it, such as ⌘S, or Ctrl+S off a Mac.
  const shortcut = (
    item: HTMLButtonElement,
    key: string,
  ): HTMLButtonElement => {
    item.setAttribute("aria-keyshortcuts", keyshortcuts(key));
    const hint = el("kbd", { text: `${MOD}${key}` });
    hint.setAttribute("aria-hidden", "true"); // aria-keyshortcuts already says it
    item.append(hint);
    return item;
  };
  const undoButton = shortcut(button("Undo last choice", undoChoice), "Z");
  const menuItems = el(
    "div",
    { class: "game-menu-items" },
    shortcut(button("Save game", saveGame), "S"),
    shortcut(button("Load game", loadGame), "L"),
    undoButton,
    restartButton,
    sound.menuItem,
    button("Main menu", () => {
      ctx.act(ctx.showMenu);
    }),
  );
  const gameMenu = el("details", { class: "game-menu" }, summary, menuItems);
  const items = (): HTMLElement[] => [
    ...menuItems.querySelectorAll<HTMLElement>("button:not([hidden])"),
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
  ctx.currentMenu = gameMenu;
  // Every choice is saved as it's made; this says so without getting in the way.
  const saved = el("span", { class: "saved", text: "✓ Saved" });
  saved.setAttribute("role", "status");
  const flashSaved = (): void => {
    if (ctx.game.view().warnings.length > 0) return; // a failed autosave shows its own warning
    enter(saved);
  };
  const camp = campfire(ctx.game, ctx.act, (rested) => {
    draw();
    if (rested) flashSaved();
    firstFocus().focus();
  });
  // ⌘ (or Ctrl) shortcuts for the bar, except while the camp is open, where leaving would cut a rest short.
  const shortcuts: Readonly<Record<string, () => void>> = {
    s: saveGame,
    l: loadGame,
    z: undoChoice,
    i: () => {
      if (sheetDrawer.open) sheetDrawer.close();
      else openSheet();
    },
    j: () => {
      if (journalDrawer.open) journalDrawer.close();
      else openJournal();
    },
  };
  sound.follow(camp.dialog);
  ctx.actions.replaceChildren(saved, camp.button, hud, journal, gameMenu);
  const shop = shopPanel(
    (optionId) => {
      ctx.act(async () => {
        await ctx.game.answer(optionId);
        draw();
        flashSaved();
      });
    },
    () => {
      if (sound.effects()) ctx.cardSound?.();
    },
  );
  const stage = el(
    "main",
    { class: "play" },
    title,
    sceneArt,
    scene,
    sound.narration,
    combatGridSlot,
    // In a fight this is the column beside the map; otherwise it lays out as if it weren't there.
    // The ending comes after the ticker's last lines, and beside the map when a fight ends the run.
    el(
      "div",
      { class: "rail" },
      ticker,
      why.node,
      levelUp,
      combat,
      card,
      prompt,
      options,
      shop.element,
      ending,
    ),
  );
  ctx.screen.replaceChildren(
    el(
      "div",
      { class: "game" },
      stage,
      sheetDrawer,
      journalDrawer,
      camp.dialog,
      sound.dialog,
    ),
  );
  ctx.keys = {
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

  let quickQuestion = false; // a plain list of choices in a fight, such as a reaction, not a whole turn
  let hudShown = 0; // the latest HUD update, so a stale one never lands
  let linesShown = 0;
  let tickerShown = 0; // the latest ticker update, so a stale one never lands
  let choiceShown = 0; // the same, for revealing the choices
  // An ending takes focus on its heading, so a repeated key press can't skip past it.
  const firstFocus = (): HTMLElement =>
    shop.focusTarget() ??
    options.querySelector("button") ??
    ending.querySelector("h3") ??
    title;
  const draw = (): void => {
    const view = ctx.game.view();
    const factory = ctx.boards[view.system];
    if (factory && !board) {
      board = factory(combatGridSlot, {
        imageUrl: (path) => ctx.game.imageUrl(path),
        sound: sound.effects,
        volume: sound.volume,
        answer: (...optionIds) => {
          ctx.act(async () => {
            for (const optionId of optionIds) await ctx.game.answer(optionId);
            draw();
            flashSaved();
            // Played on the map, so the page stays put rather than jumping to the buttons,
            // unless a quick question, such as a reaction, now waits there.
            if (!quickQuestion) ctx.focusNext = null;
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
    sound.update(view);

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
        ...(view.sceneArt ? [picture(ctx.game, view.sceneArt, "", "art")] : []),
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
      return count > 0 ? [`${String(count)} ${count === 1 ? one : many}`] : [];
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
                ctx.act(ctx.showMenu);
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
      ? renderCombat(ctx.game, view.combat, view.monsterArt)
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
      decision && decision.prompt !== view.scene && !view.card && !view.shop
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
              if (sound.effects()) ctx.cardSound?.();
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
          ctx.act(async () => {
            await ctx.game.answer(option.id);
            draw();
            flashSaved();
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
    quickQuestion =
      fresh &&
      view.combat !== null &&
      decision !== null &&
      view.optionGroups.every((group) => group.title === null);
    const chosen = tabs.find((group) => group.title === openGroup);
    // Outside a fight the choices read as a book's numbered entries, and number keys pick them.
    options.classList.toggle("story", !view.combat);
    options.replaceChildren(
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
                  openGroup = openGroup === name ? null : name;
                  draw();
                  // Focus goes into the panel just opened, or back to the replaced tab when it closed.
                  (openGroup
                    ? options.querySelector<HTMLElement>(
                        ".group-panel .option > button",
                      )
                    : [...options.querySelectorAll<HTMLElement>(".tab")].find(
                        (item) => item.textContent === name,
                      )
                  )?.focus();
                });
                tab.className = name === openGroup ? "tab open" : "tab";
                tab.setAttribute("aria-expanded", String(name === openGroup));
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
    options.hidden = view.shop !== null;
    shop.update(view.shop);
    // The next choice waits for the board to finish, so it can't be picked under a die still to throw.
    if (!firstDraw && board?.settled && cues.length > 0) {
      const shownChoice = ++choiceShown;
      const quick = quickQuestion;
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
          quick ||
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
    journalTabsView.update(view);
    undoButton.hidden = !view.canUndo;
    log.scrollTop = log.scrollHeight;
    const levels = added.filter((line) => line.moment === "levelUp");
    // A card stands in for the prompt, which repeats a journal line, so the ticker leaves that line out.
    const events = added
      .filter((line) => line.kind === "event" && !levels.includes(line))
      .filter((line) => !(view.card && line.text === decision?.prompt));
    // A fight has more to tell; the player's own latest result stays, even when allies act after it.
    const limit = view.combat ? 5 : 3;
    const own = events.findLast(
      (line) => line.actor && line.actor === view.sheets[0]?.title,
    );
    const latest = events.slice(-limit);
    const news =
      own && !latest.includes(own) ? [own, ...events.slice(1 - limit)] : latest;
    if (!firstDraw && (news.length > 0 || levels.length > 0)) {
      // The words wait for the board to finish showing what they describe.
      const shown = ++tickerShown;
      ticker.replaceChildren();
      why.update(null);
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
        why.update(view);
      });
    }

    const [playerSheet] = view.sheets;
    hud.hidden = !playerSheet;
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
      hud.replaceChildren(
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
    const shownHud = ++hudShown;
    if (!firstDraw && board?.settled && cues.length > 0) {
      void board.settled().then(() => {
        if (shownHud === hudShown) drawHud();
      });
    } else drawHud();
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
            ctx.act(async () => {
              await ctx.game.answer(option.id);
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
      ...ctx.credits.map((text) => el("p", { text })),
    );
    if (view.warnings.length > 0) ctx.say(view.warnings.join(" "), true);

    // While the board plays, keys go to it, so Enter throws your die.
    ctx.focusNext = stage.classList.contains("settling")
      ? combatGridSlot.querySelector<HTMLElement>("[tabindex]")
      : null;
    ctx.focusNext ??= firstFocus();
  };
  draw();
}
