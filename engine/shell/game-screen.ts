import { soundControls } from "./sound-panel.ts";
import { journalTabs, rollsWhy } from "./journal-tabs.ts";
import { campfire } from "./campfire.ts";
import { shopPanel } from "./shop.ts";
import { CANT_OPEN, OPENING, type ShellContext } from "./context.ts";
import type { GamePage } from "./game-page.ts";
import { drawEnding } from "./ending.ts";
import { drawDecision } from "./game-options.ts";
import { drawJournal } from "./game-journal.ts";
import { drawSheets } from "./game-sheet.ts";
import { button, el, enter, picture, replaceKeepingOpen } from "./dom.ts";
import { keyshortcuts, MOD } from "./keys.ts";
import { renderCombat } from "./sheet-view.ts";

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
  let cuesShown: number | null = null; // null until the first draw, which shows a loaded game as it stands
  let sceneDraws = 0; // the latest scene update, so a stale one never lands
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
  const log = el("ol", { class: "log" });
  log.setAttribute("role", "log");
  log.setAttribute("aria-label", "What has happened so far");
  log.tabIndex = 0;
  const about = el("details", { class: "about" });
  const fullSheet = el("div");
  // One panel per party member, kept between redraws so each keeps its own open sections.
  const sheetPanels = new Map<string, HTMLElement>();
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
  // An ending takes focus on its heading, so a repeated key press can't skip past it.
  const firstFocus = (): HTMLElement =>
    shop.focusTarget() ??
    options.querySelector("button") ??
    ending.querySelector("h3") ??
    title;
  const draw = (): void => {
    const view = ctx.game.view();
    const factory = ctx.boards[view.system];
    if (factory && !page.board) {
      page.board = factory(combatGridSlot, {
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
            if (!page.quickQuestion) ctx.focusNext = null;
          });
        },
      });
      // A system's own settings, such as its dice, go in the game menu after Sound.
      const menu = page.board.menu;
      if (menu) {
        sound.menuItem.after(menu.item);
        sound.dialog.after(menu.dialog);
      }
    }
    const cues = view.cues.slice(cuesShown ?? view.cues.length);
    page.board?.update({
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
    // A fight's layout comes at once, so its start plays on the map; leaving it waits like the scene.
    if (view.combat) stage.classList.add("in-combat");

    // The next scene, and its narrator, wait for the board to finish the fight that leads to it.
    const drawScene = (): void => {
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
          ...(view.sceneArt
            ? [picture(ctx.game, view.sceneArt, "", "art")]
            : []),
        );
        if (!firstDraw) enter(sceneArt);
      }
    };
    // Every later draw waits, since one without cues can still come while the board replays.
    const shownScene = ++sceneDraws;
    if (!firstDraw && page.board?.settled) {
      void page.board.settled().then(() => {
        // Not once the player has left this screen, as its title and sound would then leak out.
        if (shownScene === sceneDraws && stage.isConnected) drawScene();
      });
    } else drawScene();
    drawEnding(page, view);
    // With a board showing the fight, the written turn order folds away until it's wanted.
    const order = view.combat
      ? renderCombat(ctx.game, view.combat, view.monsterArt)
      : null;
    replaceKeepingOpen(
      combat,
      ...(order
        ? [
            page.board
              ? el(
                  "details",
                  { class: "initiative-details" },
                  el("summary", { text: view.combat?.listName ?? "" }),
                  order,
                )
              : order,
          ]
        : []),
    );

    drawDecision(page, view, cues, firstDraw);
    undoButton.hidden = !view.canUndo;
    drawJournal(page, view, firstDraw);
    drawSheets(page, view, cues, firstDraw);
    if (view.warnings.length > 0) ctx.say(view.warnings.join(" "), true);

    // While the board plays, keys go to it, so Enter throws your die.
    ctx.focusNext = stage.classList.contains("settling")
      ? combatGridSlot.querySelector<HTMLElement>("[tabindex]")
      : null;
    ctx.focusNext ??= firstFocus();
  };
  const page: GamePage = {
    ctx,
    sound,
    ending,
    ticker,
    levelUp,
    prompt,
    card,
    options,
    log,
    about,
    fullSheet,
    sheetPanels,
    sheetTabs,
    journalTabsView,
    why,
    hud,
    stage,
    shop,
    draw,
    flashSaved,
    firstFocus,
    restart,
    board: null,
    decisionShown: null,
    openGroup: null,
    showAll: false,
    sheetShown: null,
    quickQuestion: false,
    hudShown: 0,
    linesShown: 0,
    tickerShown: 0,
    choiceShown: 0,
  };
  draw();
}
