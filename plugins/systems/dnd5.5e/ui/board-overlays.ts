import { PLAYER_ACTOR } from "#sdk";
import { ALL, MOVE, SQUARE, parseOption } from "../core/combat/ids.ts";
import type { Terrain } from "../core/state.ts";
import {
  type AreaTargeting,
  BACK,
  CONFIRM,
  covers,
} from "../core/targeting.ts";
import {
  type BoardContext,
  aiming,
  el,
  extraOf,
  pendingId,
  picking,
  playerOptions,
  showCaption,
} from "./board-context.ts";

// What the board draws over the map for the player: the squares they can walk to and the route there,
// the reach of a creature, an area's outline, the ground's marks, and the bar for choosing targets.

// The first player turn of the first fight says how the map works, until the player uses it.
const HOW_TO = "Click a square to move, or a foe to attack";

// The map's codes as faint marks: hatching for difficult terrain, an outline for cover, shade for dim light
// and darkness. A map that's dim or dark everywhere is shaded all over.
// shortcut: a dim square on a dark map shows as dark; mark it lighter when a map needs it.
export function showGround(ctx: BoardContext, terrain: Terrain | null): void {
  const shown = JSON.stringify([terrain, ctx.grid]);
  if (shown === ctx.groundShown) return;
  ctx.groundShown = shown;
  ctx.ground.replaceChildren();
  ctx.ground.dataset.light = terrain?.light ?? "bright";
  if (!terrain || !ctx.grid) return;
  const kinds = [
    ["difficult", terrain.difficult, "Difficult terrain"],
    ["half", terrain.half, "Half cover"],
    ["threeQuarters", terrain.threeQuarters, "Three-quarters cover"],
    ["dim", terrain.dim, "Dim light"],
    ["dark", terrain.dark, "Darkness"],
  ] as const;
  for (const [kind, keys, name] of kinds) {
    for (const key of keys) {
      const match = SQUARE.exec(key);
      if (!match) continue;
      const square = el("div", `dnd-ground-square ${kind}`);
      square.title = name;
      square.style.left = `${String((Number(match[1]) / ctx.grid.width) * 100)}%`;
      square.style.top = `${String((Number(match[2]) / ctx.grid.height) * 100)}%`;
      ctx.ground.append(square);
    }
  }
}

// Parchment over what the party has never seen, and a sepia shade over what it saw once but doesn't see now.
// Drawn one pixel a square and scaled up smoothly, so the fog's edge fades across a square.
export function showFog(
  ctx: BoardContext,
  fog: {
    readonly revealed: readonly string[];
    readonly seen: readonly string[];
  } | null,
  grid: { readonly width: number; readonly height: number } | null,
): void {
  const shown = JSON.stringify([fog, grid]);
  if (shown === ctx.fogShown) return;
  ctx.fogShown = shown;
  ctx.fog.hidden = !fog || !grid;
  if (!fog || !grid) return;
  ctx.fog.width = grid.width;
  ctx.fog.height = grid.height;
  const paint = ctx.fog.getContext("2d");
  if (!paint) return;
  const revealed = new Set(fog.revealed);
  const seen = new Set(fog.seen);
  const pixels = paint.createImageData(grid.width, grid.height);
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const key = `${String(x)},${String(y)}`;
      const at = 4 * (y * grid.width + x);
      // A little mottling, the same every time, so the cover reads as old paper rather than a flat fill.
      const mottle = ((x * 73 + y * 151 + x * y * 7) % 23) - 11;
      const [r, g, b, a] = seen.has(key)
        ? [0, 0, 0, 0]
        : revealed.has(key)
          ? [58, 40, 20, 105]
          : [226 + mottle, 208 + mottle, 170 + mottle, 255];
      pixels.data.set([r, g, b, a], at);
    }
  }
  paint.putImageData(pixels, 0, 0);
}

// Where the player can walk. On the turn itself a square answers Move and then the square, so one
// click or drag does it; while the list is already asking where to, it answers that.
export function showCells(ctx: BoardContext): void {
  ctx.cells.replaceChildren();
  ctx.line.setAttribute("points", "");
  ctx.reachZone.hidden = true;
  if (!ctx.grid) return;
  const options = playerOptions(ctx);
  // Squares still in the fog aren't drawn, so the shading doesn't trace them; the list still offers them.
  const fog = extraOf(ctx.latest).fog;
  const revealed = fog ? new Set(fog.revealed) : null;
  const asked = options.flatMap((option) => {
    const match = SQUARE.exec(option.id);
    return match &&
      (!revealed || revealed.has(`${match[1] ?? ""},${match[2] ?? ""}`))
      ? [
          {
            x: Number(match[1]),
            y: Number(match[2]),
            label: option.label,
            steps: [option.id],
            provokes: 0,
            path: [],
            feet: Number(/(\d+) ft/.exec(option.label)?.[1] ?? 0),
          },
        ]
      : [];
  });
  const offered = options.some((option) => option.id === MOVE)
    ? (extraOf(ctx.latest).moves ?? []).map((move) => ({
        ...move,
        label:
          move.provokes > 0
            ? `${String(move.feet)} ft, gives an Opportunity Attack`
            : `${String(move.feet)} ft`,
        steps: [MOVE, `${String(move.x)},${String(move.y)}`],
      }))
    : [];
  for (const square of asked.length > 0 ? asked : offered) {
    const risky = square.provokes > 0;
    const cell = el(
      "div",
      `dnd-cell${asked.length > 0 ? "" : " soft"}${risky ? " risky" : ""}`,
    );
    cell.dataset.option = square.steps.join(" ");
    cell.dataset.path = square.path
      .map(([x, y]) => `${String(x)},${String(y)}`)
      .join(" ");
    cell.title = square.label;
    cell.dataset.feet = String(square.feet);
    cell.style.left = `${String((square.x / ctx.grid.width) * 100)}%`;
    cell.style.top = `${String((square.y / ctx.grid.height) * 100)}%`;
    cell.dataset.x = String(square.x);
    cell.dataset.y = String(square.y);
    ctx.cells.append(cell);
  }
  if (ctx.playing) return; // the caption is telling what's happening
  if (aiming(ctx) || picking(ctx)) {
    showCaption(ctx, ""); // the bar says what to do, and the caption names who an aim catches
    return;
  }
  if (ctx.howTo === "unseen" && options.length > 0) ctx.howTo = "showing";
  showCaption(ctx, ctx.howTo === "showing" ? HOW_TO : "");
}

// The player has used the map, so it needs no more explaining.
export function mapUsed(ctx: BoardContext): void {
  if (ctx.howTo !== "showing") return;
  ctx.howTo = "done";
  showCaption(ctx, "");
}

// The dashed route to a square the player is pointing at, from where they stand.
export function showRoute(ctx: BoardContext, cell: HTMLElement | null): void {
  const me = ctx.tokens.get(PLAYER_ACTOR);
  const steps = cell?.dataset.path;
  ctx.routeCost.hidden = true;
  if (!ctx.grid || !cell || me?.x == null || me.y === null || !steps) {
    ctx.line.setAttribute("points", "");
    return;
  }
  // What the walk costs, counting difficult terrain double, next to where it ends.
  if (cell.dataset.feet && cell.dataset.feet !== "0") {
    ctx.routeCost.textContent = `${cell.dataset.feet} ft`;
    ctx.routeCost.style.left = `${String(((Number(cell.dataset.x) + 0.5) / ctx.grid.width) * 100)}%`;
    ctx.routeCost.style.top = `${String((Number(cell.dataset.y) / ctx.grid.height) * 100)}%`;
    ctx.routeCost.hidden = false;
  }
  ctx.route.setAttribute(
    "viewBox",
    `0 0 ${String(ctx.grid.width)} ${String(ctx.grid.height)}`,
  );
  ctx.line.setAttribute(
    "points",
    [`${String(me.x)},${String(me.y)}`, ...steps.split(" ")]
      .map((point) => {
        const [x = 0, y = 0] = point.split(",").map(Number);
        return `${String(x + 0.5)},${String(y + 0.5)}`;
      })
      .join(" "),
  );
  ctx.route.classList.toggle("risky", cell.classList.contains("risky"));
}

// The squares a creature can hit in melee, while the pointer rests on it.
export function showReach(ctx: BoardContext, id: string | null): void {
  const token = id ? ctx.tokens.get(id) : undefined;
  const feet = id ? extraOf(ctx.latest).reach?.[id] : undefined;
  if (
    !ctx.grid ||
    token?.x == null ||
    token.y === null ||
    !feet ||
    id === PLAYER_ACTOR
  ) {
    ctx.reachZone.hidden = true;
    return;
  }
  const squares = feet / 5;
  const left = Math.max(0, token.x - squares);
  const top = Math.max(0, token.y - squares);
  const right = Math.min(ctx.grid.width, token.x + squares + 1);
  const bottom = Math.min(ctx.grid.height, token.y + squares + 1);
  ctx.reachZone.style.left = `${String((left / ctx.grid.width) * 100)}%`;
  ctx.reachZone.style.top = `${String((top / ctx.grid.height) * 100)}%`;
  ctx.reachZone.style.width = `${String(((right - left) / ctx.grid.width) * 100)}%`;
  ctx.reachZone.style.height = `${String(((bottom - top) / ctx.grid.height) * 100)}%`;
  ctx.reachZone.hidden = false;
}

// Lights the squares an area aimed at `aim` would cover, and rings everyone it would catch.
function outline(
  ctx: BoardContext,
  targeting: AreaTargeting | null | undefined,
  aim: { readonly x: number; readonly y: number } | null,
): void {
  ctx.blast.replaceChildren();
  for (const token of ctx.tokens.values())
    token.node.classList.remove("caught");
  const me = ctx.tokens.get(PLAYER_ACTOR);
  if (!ctx.grid || !targeting || !aim || me?.x == null || me.y === null) return;
  const origin = { x: me.x, y: me.y };
  for (let y = 0; y < ctx.grid.height; y += 1) {
    for (let x = 0; x < ctx.grid.width; x += 1) {
      if (!covers(targeting, origin, aim, { x, y })) continue;
      const square = el("div", "dnd-blast-square");
      square.style.left = `${String((x / ctx.grid.width) * 100)}%`;
      square.style.top = `${String((y / ctx.grid.height) * 100)}%`;
      ctx.blast.append(square);
    }
  }
  for (const token of ctx.tokens.values()) {
    if (token.x === null || token.y === null || token.hp <= 0) continue;
    const caught =
      (targeting.side === "enemy" || token.side === "party") &&
      covers(targeting, origin, aim, { x: token.x, y: token.y });
    token.node.classList.toggle("caught", caught);
  }
}

// Pointing at an area spell round the player in a menu lights the squares it covers.
export function showArea(ctx: BoardContext, optionId: string | null): void {
  const [actionId = "", target] = parseOption(optionId ?? "");
  const targeting = extraOf(ctx.latest).shapes?.[actionId];
  const me = ctx.tokens.get(PLAYER_ACTOR);
  outline(
    ctx,
    target === ALL && targeting?.area.shape === "emanation" ? targeting : null,
    me?.x == null || me.y === null ? null : { x: me.x, y: me.y },
  );
}

export function closeMenu(ctx: BoardContext): void {
  ctx.menu.hidden = true;
  showArea(ctx, null);
}

export function cellNodeAt(
  ctx: BoardContext,
  x: number,
  y: number,
): HTMLElement | undefined {
  return [...ctx.cells.querySelectorAll<HTMLElement>(".dnd-cell")].find(
    (cell) => cell.dataset.x === String(x) && cell.dataset.y === String(y),
  );
}

// The grid square under the pointer.
export function squareAt(
  ctx: BoardContext,
  event: MouseEvent,
): { x: number; y: number } | null {
  if (!ctx.grid) return null;
  const box = ctx.field.getBoundingClientRect();
  const x = Math.floor(
    ((event.clientX - box.left) / box.width) * ctx.grid.width,
  );
  const y = Math.floor(
    ((event.clientY - box.top) / box.height) * ctx.grid.height,
  );
  return x >= 0 && y >= 0 && x < ctx.grid.width && y < ctx.grid.height
    ? { x, y }
    : null;
}

// The aim option for a square: that square, or for an area from the player, the nearest of the 8 ways.
export function aimCellFor(
  ctx: BoardContext,
  square: { readonly x: number; readonly y: number } | null,
): HTMLElement | undefined {
  if (!square) return undefined;
  const exact = cellNodeAt(ctx, square.x, square.y);
  const me = ctx.tokens.get(PLAYER_ACTOR);
  if (
    exact ||
    aiming(ctx)?.range !== "self" ||
    me?.x == null ||
    me.y === null
  ) {
    return exact;
  }
  if (square.x === me.x && square.y === me.y) return undefined;
  const eighth =
    Math.round(Math.atan2(square.y - me.y, square.x - me.x) / (Math.PI / 4)) *
    (Math.PI / 4);
  return cellNodeAt(
    ctx,
    me.x + Math.round(Math.cos(eighth)),
    me.y + Math.round(Math.sin(eighth)),
  );
}

// Shows where an aim would land and who it catches, named in the caption.
export function showAim(
  ctx: BoardContext,
  cell: HTMLElement | undefined,
): void {
  for (const item of ctx.cells.children) {
    item.classList.toggle("hover", item === cell);
  }
  outline(
    ctx,
    aiming(ctx),
    cell ? { x: Number(cell.dataset.x), y: Number(cell.dataset.y) } : null,
  );
  showCaption(ctx, cell?.title ?? "");
}

// The bar while choosing targets or aiming: the count so far, Cast once it can, and Back.
export function showPickBar(ctx: BoardContext): void {
  const options = playerOptions(ctx);
  const id = pendingId(ctx);
  const choosing = picking(ctx);
  ctx.pickBar.hidden = !choosing && !aiming(ctx);
  for (const token of ctx.tokens.values()) {
    token.node.classList.remove("picked");
    delete token.node.dataset.count;
  }
  if (ctx.pickBar.hidden) return;
  const [, , total = "0", chosen = ""] = parseOption(id);
  const picked = chosen.split(",").filter(Boolean);
  for (const pickedId of new Set(picked)) {
    const token = ctx.tokens.get(pickedId);
    if (!token) continue;
    token.node.classList.add("picked");
    const times = picked.filter((item) => item === pickedId).length;
    if (times > 1) token.node.dataset.count = String(times);
  }
  const note = el(
    "span",
    "",
    choosing
      ? `${String(picked.length)} of ${total} chosen: click to add or remove`
      : "Point at where it lands, and click",
  );
  const buttons = [CONFIRM, BACK].flatMap((optionId) => {
    const option = options.find((item) => item.id === optionId);
    if (!option) return [];
    const button = el(
      "button",
      "",
      optionId === CONFIRM
        ? `Cast (${String(picked.length)} of ${total})`
        : "Back",
    );
    button.dataset.option = option.id;
    button.title = option.label;
    return [button];
  });
  ctx.pickBar.replaceChildren(note, ...buttons);
}
