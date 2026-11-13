import { PLAYER_ACTOR } from "#sdk";
import { AIM, parseOption } from "../core/combat/ids.ts";
import type { BoardHost, BoardUpdate, ShellUpdate } from "./board-data.ts";
import {
  type BoardContext,
  el,
  extraOf,
  showCaption,
} from "./board-context.ts";
import { placeCursor, wireInput } from "./board-input.ts";
import {
  closeMenu,
  showCells,
  showGround,
  showPickBar,
} from "./board-overlays.ts";
import { play } from "./board-playback.ts";
import { wireZoom } from "./board-zoom.ts";
import { parseState } from "./parse-state.ts";
import { injectStyle } from "./board-style.ts";
import {
  artFor,
  layout,
  setArt,
  setHp,
  setTip,
  sideOf,
  tokenFor,
} from "./board-tokens.ts";

// The combat board: tokens on a 5-foot grid over the scene's picture, animated from cues one at a time.
// Clicking a token or a square, or moving a cursor with the arrow keys and pressing Enter, answers the
// same options the list below offers, so the board is a shortcut and never the only way to do something.
// Its animations only show what the journal says in words.

const MARKED = ["dodging", "hidden"] as const; // conditions drawn on the token itself

export function mountDndBoard(slot: HTMLElement, host: BoardHost) {
  injectStyle();
  const board = el("div", "dnd-board");
  // An application role passes the arrow keys to the board rather than to a screen reader's own navigation.
  board.setAttribute("role", "application");
  board.setAttribute("aria-roledescription", "battle map");
  board.setAttribute(
    "aria-label",
    "Battle map. Arrow keys move the cursor, Enter acts on its square, Escape closes a menu.",
  );
  board.tabIndex = 0;
  const said = el("div", "dnd-said"); // read out by screen readers, not shown
  said.setAttribute("aria-live", "polite");
  const cursorBox = el("div", "dnd-cursor");
  const field = el("div", "dnd-field plain"); // a parchment mat until a picture loads
  const banner = el("div", "dnd-banner");
  const hint = el("div", "dnd-hint", "Click to skip");
  const caption = el("div", "dnd-caption"); // who is doing what, during an attack
  const cells = el("div", "dnd-cells");
  const SVG = "http://www.w3.org/2000/svg";
  const route = document.createElementNS(SVG, "svg");
  route.classList.add("dnd-route");
  route.setAttribute("preserveAspectRatio", "none");
  const line = document.createElementNS(SVG, "polyline");
  route.append(line);
  const reachZone = el("div", "dnd-reach");
  reachZone.hidden = true;
  const blast = el("div", "dnd-blast");
  const ground = el("div", "dnd-ground"); // difficult terrain, cover and shadow, faint under everything
  const routeCost = el("div", "dnd-route-cost");
  routeCost.hidden = true;
  const menu = el("div", "dnd-menu");
  menu.dataset.terms = ""; // the shell explains an action such as Dodge on hover or "?"
  menu.hidden = true;
  // While choosing targets or aiming an area: how many are chosen, Cast and Back.
  const pickBar = el("div", "dnd-pickbar");
  pickBar.hidden = true;
  field.append(ground, reachZone, blast, cells, route, routeCost, cursorBox);
  // The map's window: it scrolls when the map is zoomed in, while what's over the map stays put.
  const view = el("div", "dnd-view");
  view.append(field);
  board.append(view, banner, caption, hint, menu, pickBar, said);
  slot.append(board);
  slot.hidden = true;
  const ctx: BoardContext = {
    slot,
    host,
    board,
    said,
    cursorBox,
    field,
    banner,
    hint,
    caption,
    cells,
    route,
    line,
    reachZone,
    blast,
    ground,
    routeCost,
    menu,
    pickBar,
    cursor: null,
    howTo: "unseen",
    decisionSeen: null,
    cursorHome: false,
    groundShown: "",
    tokens: new Map(),
    queue: [],
    latest: null,
    playing: false,
    skipping: false,
    wake: null,
    sceneArt: null,
    grid: null,
    dragged: false,
    throwNow: null,
    pendingDamage: null,
    waiting: [],
    fitMap: () => undefined,
  };
  new ResizeObserver(() => {
    layout(ctx);
  }).observe(field);
  wireInput(ctx);
  slot.append(wireZoom(ctx, view));

  // Values, arrivals and removals wait until the queue is done, so they don't spoil what's playing.
  const sync = (update: BoardUpdate, settle: boolean): void => {
    // The book's battle map when the fight has one, cut to the fight's squares; otherwise the scene's picture.
    const map = extraOf(update).map ?? null;
    const backdrop = map ? `${update.assetRoot}/${map.image}` : update.sceneArt;
    // A fight still playing keeps its map; a new one gets its own before its start cue plays.
    if (backdrop !== ctx.sceneArt && (settle || ctx.tokens.size === 0)) {
      ctx.sceneArt = backdrop;
      field.style.backgroundImage = "";
      field.classList.toggle("mapped", map !== null);
      // With no picture the fight is on a parchment mat, which also stands in until a picture loads.
      field.classList.add("plain");
      if (map) {
        const { crop, imageWidth, imageHeight } = map;
        const across = (start: number, size: number, whole: number): string =>
          whole > size ? `${String((start / (whole - size)) * 100)}%` : "0%";
        field.style.backgroundSize = `${String((imageWidth / crop.width) * 100)}% ${String((imageHeight / crop.height) * 100)}%`;
        field.style.backgroundPosition = `${across(crop.x, crop.width, imageWidth)} ${across(crop.y, crop.height, imageHeight)}`;
      } else {
        field.style.backgroundSize = "";
        field.style.backgroundPosition = "";
      }
      if (backdrop) {
        const path = backdrop;
        void Promise.resolve(host.imageUrl(path)).then((url) => {
          if (!url) return;
          // Loaded first, so a picture that fails leaves the mat rather than a black board.
          const image = new Image();
          image.addEventListener("load", () => {
            if (ctx.sceneArt !== path) return;
            field.style.backgroundImage = `url("${url}")`;
            field.classList.remove("plain");
          });
          image.src = url;
        });
      }
    }
    // A new decision starts the keyboard cursor again from the player's own square.
    const decision = update.decision?.id ?? null;
    if (
      decision !== ctx.decisionSeen &&
      update.decision?.actor === PLAYER_ACTOR
    ) {
      ctx.cursor = null;
      ctx.cursorHome = true;
    }
    ctx.decisionSeen = decision;
    const state = parseState(update.state);
    const actors = state.actors;
    if (settle) ctx.grid = state.combat?.grid ?? null;
    const present = new Set<string>();
    for (const actor of update.combat?.combatants ?? []) {
      present.add(actor.id);
      const isNew = !ctx.tokens.has(actor.id);
      // While cues play, the start cue brings everyone in as the fight began.
      if (isNew && !settle) continue;
      const token = tokenFor(ctx, actor);
      setArt(ctx, token, artFor(update, actor.id));
      token.maxHp = actor.maxHp;
      if (settle) {
        token.x = actors[actor.id]?.position?.x ?? null;
        token.y = actors[actor.id]?.position?.y ?? null;
        setHp(token, actor.hp);
        token.node.classList.toggle("active", actor.active);
        token.node.dataset.side = sideOf(actor);
        token.notes = [actor.status ?? "", ...actor.conditions].filter(Boolean);
        // Small marks for the two states that change how to fight a creature: Dodging and Hidden.
        const marks = MARKED.filter((mark) => actor.conditions.includes(mark));
        token.node.dataset.marks = marks.join(" · ");
        for (const mark of MARKED) {
          token.node.classList.toggle(`is-${mark}`, marks.includes(mark));
        }
        setTip(token);
      }
    }
    if (settle) {
      for (const [id, token] of ctx.tokens) {
        if (!present.has(id)) {
          token.node.remove();
          ctx.tokens.delete(id);
        }
      }
    }
    if (settle) {
      showGround(ctx, extraOf(update).terrain ?? null);
      // The shield shows the cover a foe has while the player has something to aim at it.
      const aimable = new Set(
        update.decision?.actor === PLAYER_ACTOR
          ? update.decision.options.map((option) =>
              // An area aimed at a creature names it as "@" and its id.
              parseOption(option.id)[1]?.replace(AIM, ""),
            )
          : [],
      );
      for (const [id, token] of ctx.tokens) {
        const bonus = extraOf(update).cover?.[id] ?? 0;
        token.shield.hidden = bonus === 0 || !aimable.has(id);
        token.shield.textContent = `+${String(bonus)}`;
        token.shield.title =
          bonus >= 5
            ? "Three-quarters cover: +5 to AC and Dexterity saves"
            : "Half cover: +2 to AC and Dexterity saves";
      }
    }
    layout(ctx);
    showCells(ctx);
    showPickBar(ctx);
    closeMenu(ctx);
    slot.hidden = ctx.tokens.size === 0 && !ctx.playing;
    // While the map has focus, the cursor visibly goes back to the player's square.
    const me = ctx.tokens.get(PLAYER_ACTOR);
    if (ctx.cursorHome && settle) {
      ctx.cursorHome = false;
      if (document.activeElement === board && me) {
        placeCursor(ctx, me.x ?? 0, me.y ?? 0);
      }
    }
  };

  const run = async (): Promise<void> => {
    ctx.playing = true;
    board.classList.add("playing");
    cells.replaceChildren();
    closeMenu(ctx);
    try {
      for (let cue = ctx.queue.shift(); cue; cue = ctx.queue.shift()) {
        // A cue that breaks is skipped, so the rest still play and the choices come back.
        await play(ctx, cue).catch((error: unknown) => {
          console.error("A board cue failed", cue, error);
          // Clears what a cue leaves showing while it plays.
          showCaption(ctx, "");
          ctx.throwNow = null;
          board.classList.remove("checking", "awaiting");
          slot.classList.remove("dnd-overlay");
          for (const node of board.querySelectorAll(".dnd-throw")) {
            node.remove();
          }
          for (const token of ctx.tokens.values()) {
            token.node.classList.remove("acting", "targeted");
          }
        });
      }
    } finally {
      ctx.playing = false;
      ctx.skipping = false;
      board.classList.remove("playing");
      try {
        if (ctx.latest) sync(ctx.latest, true);
      } finally {
        for (const done of ctx.waiting.splice(0)) done();
      }
    }
  };

  return {
    // Resolves once everything queued so far has played, so the shell can hold back text that would spoil it.
    settled(): Promise<void> {
      return ctx.playing || ctx.queue.length > 0
        ? new Promise((resolve) => ctx.waiting.push(resolve))
        : Promise.resolve();
    },
    update(received: ShellUpdate): void {
      // This plugin's own ui/index.ts and ui/cues.ts wrote the parts the shell leaves unknown.
      const update = received as BoardUpdate;
      ctx.latest = update;
      sync(update, !ctx.playing && update.cues.length === 0);
      ctx.queue.push(...update.cues);
      if (!ctx.playing && ctx.queue.length > 0) void run();
    },
  };
}
