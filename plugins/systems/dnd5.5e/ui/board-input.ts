import { PLAYER_ACTOR } from "#sdk";
import { STUDY } from "../core/actions.ts";
import { AIM, ALL, MOVE, SQUARE, parseOption } from "../core/combat/ids.ts";
import { TACTIC } from "../core/tactics.ts";
import {
  ADD,
  AIM_AREA,
  BACK,
  CONFIRM,
  PICK,
  REMOVE,
} from "../core/targeting.ts";
import {
  type BoardContext,
  aiming,
  el,
  picking,
  playerOptions,
} from "./board-context.ts";
import {
  aimCellFor,
  cellNodeAt,
  closeMenu,
  mapUsed,
  showAim,
  showArea,
  showReach,
  showRoute,
  squareAt,
} from "./board-overlays.ts";
import { tokenAt } from "./board-tokens.ts";

// Clicks, drags and keys on the board: each answers an option the list below also offers.

function answerCell(ctx: BoardContext, cell: HTMLElement): void {
  const steps = (cell.dataset.option ?? "").split(" ").filter(Boolean);
  if (steps.length === 0) return;
  mapUsed(ctx);
  ctx.host.answer(...steps);
}

function cellAt(event: PointerEvent): HTMLElement | null {
  const found = document
    .elementsFromPoint(event.clientX, event.clientY)
    .find((item) => item.classList.contains("dnd-cell"));
  return found instanceof HTMLElement ? found : null;
}

// The options aimed at a token, or for the player's own token, the ones aimed at nobody in particular.
// A click on a foe with one thing to do does it; keys always get the menu, and so does your own
// token, whose menu can hold End your turn, unless you're choosing targets.
function openMenu(
  ctx: BoardContext,
  id: string,
  anchor: HTMLElement,
  pointer = false,
): void {
  const own = id === PLAYER_ACTOR;
  // Study stays in the Actions tab, so a click on a foe out of reach still does nothing.
  const options = playerOptions(ctx).filter((option) => {
    if (SQUARE.test(option.id) || option.id === MOVE) return false;
    if (option.id.startsWith(STUDY)) return false;
    const target = parseOption(option.id)[1];
    if (target === id || target === `${AIM}${id}`) return true;
    if (option.id.startsWith(ADD) || option.id.startsWith(REMOVE)) {
      return option.id.slice(1) === id;
    }
    return (
      own &&
      (target === undefined || [ALL, AIM_AREA, PICK].includes(target)) &&
      !(picking(ctx) && (option.id === CONFIRM || option.id === BACK))
    );
  });
  if (options.length === 0) {
    closeMenu(ctx);
    return;
  }
  const [only] = options;
  // A click attacks at once, but Help, Grapple and the like always ask first, as each spends the action.
  if (
    pointer &&
    (!own || picking(ctx)) &&
    only &&
    options.length === 1 &&
    !only.id.startsWith(TACTIC)
  ) {
    closeMenu(ctx);
    mapUsed(ctx);
    ctx.host.answer(only.id);
    return;
  }
  ctx.menu.replaceChildren(
    ...options.map((option) => {
      const button = el("button", "", option.label);
      button.dataset.option = option.id;
      return button;
    }),
  );
  const box = ctx.board.getBoundingClientRect();
  const at = anchor.getBoundingClientRect();
  ctx.menu.style.left = `${String(Math.max(0, Math.min(at.right - box.left, box.width - 220)))}px`;
  // In the lower half it opens upwards, so the board's edge doesn't cut it off.
  const lower = at.top - box.top > box.height / 2;
  ctx.menu.style.top = lower ? "" : `${String(at.top - box.top)}px`;
  ctx.menu.style.bottom = lower ? `${String(box.bottom - at.bottom)}px` : "";
  ctx.menu.hidden = false;
}

// "C4" for the third column of the fourth row, as the move list names squares.
function squareName(x: number, y: number): string {
  return `${String.fromCharCode(65 + (x % 26))}${String(y + 1)}`;
}

// Puts the cursor on a square, shows what pointing there would, and says what's there.
export function placeCursor(ctx: BoardContext, x: number, y: number): void {
  if (!ctx.grid) return;
  ctx.cursor = {
    x: Math.max(0, Math.min(ctx.grid.width - 1, x)),
    y: Math.max(0, Math.min(ctx.grid.height - 1, y)),
  };
  ctx.cursorBox.style.left = `${String((ctx.cursor.x / ctx.grid.width) * 100)}%`;
  ctx.cursorBox.style.top = `${String((ctx.cursor.y / ctx.grid.height) * 100)}%`;
  // On a zoomed map the view pans to keep the cursor in sight.
  if (ctx.board.classList.contains("zoomed")) {
    ctx.cursorBox.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const found = tokenAt(ctx, ctx.cursor.x, ctx.cursor.y);
  const cell = cellNodeAt(ctx, ctx.cursor.x, ctx.cursor.y);
  if (aiming(ctx)) showAim(ctx, aimCellFor(ctx, ctx.cursor));
  showRoute(ctx, cell ?? null);
  showReach(ctx, found?.[0] ?? null);
  for (const token of ctx.tokens.values()) {
    token.node.classList.toggle("cursor", token === found?.[1]);
  }
  const name = squareName(ctx.cursor.x, ctx.cursor.y);
  if (found) {
    const [, token] = found;
    ctx.said.textContent = `${name}: ${token.name}, ${String(Math.max(0, token.hp))} of ${String(token.maxHp)} HP.`;
  } else {
    ctx.said.textContent = cell
      ? `${name}: ${cell.title}.`
      : `${name}: out of reach.`;
  }
}

const STEPS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

export function wireInput(ctx: BoardContext): void {
  // While cues play, a click skips them. Otherwise it picks a token or a square.
  ctx.board.addEventListener("click", (event) => {
    if (ctx.playing) {
      if (ctx.throwNow) {
        ctx.throwNow();
        return;
      }
      ctx.skipping = true;
      ctx.wake?.();
      return;
    }
    if (ctx.dragged) {
      ctx.dragged = false;
      return;
    }
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>(".dnd-cell");
    const token = target.closest<HTMLElement>(".dnd-token");
    const item = target.closest<HTMLElement>(
      ".dnd-menu button, .dnd-pickbar button",
    );
    const aim = aiming(ctx) ? aimCellFor(ctx, squareAt(ctx, event)) : undefined;
    if (item?.dataset.option) {
      closeMenu(ctx);
      ctx.board.focus(); // the menu button goes away, so focus stays on the map
      mapUsed(ctx);
      ctx.host.answer(item.dataset.option);
    } else if (aiming(ctx)) {
      if (aim) answerCell(ctx, aim);
    } else if (cell?.dataset.option) {
      answerCell(ctx, cell);
    } else if (token?.dataset.id) {
      openMenu(ctx, token.dataset.id, token, true);
    } else {
      closeMenu(ctx);
    }
  });
  ctx.menu.addEventListener("pointerover", (event) => {
    showArea(
      ctx,
      (event.target as HTMLElement).closest<HTMLElement>("button")?.dataset
        .option ?? null,
    );
  });
  ctx.menu.addEventListener("pointerleave", () => {
    showArea(ctx, null);
  });
  ctx.menu.addEventListener("focusin", (event) => {
    showArea(ctx, (event.target as HTMLElement).dataset.option ?? null);
  });

  ctx.field.addEventListener("pointerover", (event) => {
    const target = event.target as HTMLElement;
    showRoute(ctx, target.closest<HTMLElement>(".dnd-cell"));
    showReach(
      ctx,
      target.closest<HTMLElement>(".dnd-token")?.dataset.id ?? null,
    );
  });
  ctx.field.addEventListener("pointerleave", () => {
    showRoute(ctx, null);
    showReach(ctx, null);
    if (aiming(ctx)) showAim(ctx, undefined);
  });
  ctx.field.addEventListener("pointermove", (event) => {
    if (aiming(ctx) && !ctx.playing)
      showAim(ctx, aimCellFor(ctx, squareAt(ctx, event)));
  });
  // Dragging the player's token onto a lit square walks it there.
  ctx.field.addEventListener("pointerdown", (down) => {
    const token = (down.target as HTMLElement).closest<HTMLElement>(
      ".dnd-token",
    );
    if (
      ctx.playing ||
      token?.dataset.id !== PLAYER_ACTOR ||
      !ctx.cells.firstChild
    ) {
      return;
    }
    let moving = false;
    const move = (event: PointerEvent): void => {
      const dx = event.clientX - down.clientX;
      const dy = event.clientY - down.clientY;
      if (!moving && Math.hypot(dx, dy) < 6) return;
      moving = true;
      token.classList.add("dragging");
      token.style.translate = `${String(dx)}px ${String(dy)}px`;
      for (const cell of ctx.cells.children) cell.classList.remove("hover");
      const under = cellAt(event);
      under?.classList.add("hover");
      showRoute(ctx, under);
    };
    const up = (event: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      token.classList.remove("dragging");
      token.style.translate = "";
      showRoute(ctx, null);
      if (!moving) return;
      ctx.dragged = true;
      const cell = cellAt(event);
      if (cell) answerCell(ctx, cell);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // Focus says where the cursor is, starting on the player's own square.
  ctx.board.addEventListener("focus", () => {
    if (!ctx.grid) return;
    const me = ctx.tokens.get(PLAYER_ACTOR);
    placeCursor(ctx, ctx.cursor?.x ?? me?.x ?? 0, ctx.cursor?.y ?? me?.y ?? 0);
  });

  ctx.board.addEventListener("keydown", (event) => {
    const inMenu = (event.target as HTMLElement).closest(".dnd-menu");
    if (inMenu) {
      const buttons = [...ctx.menu.querySelectorAll<HTMLElement>("button")];
      const at = buttons.indexOf(event.target as HTMLElement);
      if (event.key === "Escape") {
        closeMenu(ctx);
        ctx.board.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      } else {
        return;
      }
      event.preventDefault();
      return;
    }
    if (event.target !== ctx.board) return;
    if (
      ctx.playing &&
      ctx.throwNow &&
      (event.key === "Enter" || event.key === " ")
    ) {
      ctx.throwNow();
      event.preventDefault();
      return;
    }
    if (
      ctx.playing &&
      (event.key === "Enter" || event.key === " " || event.key === "Escape")
    ) {
      ctx.skipping = true;
      ctx.wake?.();
      event.preventDefault();
      return;
    }
    const step = STEPS[event.key];
    if (step && ctx.grid) {
      const me = ctx.tokens.get(PLAYER_ACTOR);
      const from = ctx.cursor ?? { x: me?.x ?? 0, y: me?.y ?? 0 };
      placeCursor(ctx, from.x + step[0], from.y + step[1]);
      event.preventDefault();
    } else if ((event.key === "Enter" || event.key === " ") && aiming(ctx)) {
      event.preventDefault();
      const cell = aimCellFor(ctx, ctx.cursor);
      if (cell) answerCell(ctx, cell);
      else ctx.said.textContent = "It can't be aimed there.";
    } else if (event.key === "Escape" && (aiming(ctx) || picking(ctx))) {
      event.preventDefault();
      mapUsed(ctx);
      ctx.host.answer(BACK);
    } else if ((event.key === "Enter" || event.key === " ") && ctx.cursor) {
      event.preventDefault();
      const found = tokenAt(ctx, ctx.cursor.x, ctx.cursor.y);
      const cell = cellNodeAt(ctx, ctx.cursor.x, ctx.cursor.y);
      if (found) {
        openMenu(ctx, found[0], found[1].node);
        const first = ctx.menu.querySelector<HTMLElement>("button");
        if (first && !ctx.menu.hidden) first.focus();
        else ctx.said.textContent = "Nothing to do there.";
      } else if (cell) {
        answerCell(ctx, cell);
      }
    } else if (event.key === "Escape") {
      closeMenu(ctx);
    }
  });
}
