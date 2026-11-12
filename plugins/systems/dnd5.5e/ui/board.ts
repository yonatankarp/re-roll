import { PLAYER_ACTOR } from "#sdk";
import { NS, StateSchema, type Terrain } from "../core/state.ts";
import { STUDY } from "../core/actions.ts";
import { TACTIC } from "../core/tactics.ts";
import { AIM, ALL, MOVE, SQUARE, parseOption } from "../core/combat/ids.ts";
import {
  ADD,
  type AreaTargeting,
  BACK,
  CONFIRM,
  REMOVE,
  covers,
} from "../core/targeting.ts";
import type {
  BoardExtra,
  BoardHost,
  BoardUpdate,
  Combatant,
  Face,
  Option,
  ShellUpdate,
  TokenArt,
} from "./board-data.ts";
import type { DndCue } from "./cues.ts";
import { injectStyle } from "./board-style.ts";
import { cueSound, diceSound, setEffectsVolume } from "./sound.ts";

// The combat board: tokens on a 5-foot grid over the scene's picture, animated from cues one at a time.
// Clicking a token or a square, or moving a cursor with the arrow keys and pressing Enter, answers the
// same options the list below offers, so the board is a shortcut and never the only way to do something.
// Its animations only show what the journal says in words.

function faceOf(art: TokenArt): Face | null {
  const face = art.face as Partial<Face> | undefined;
  return typeof face?.x === "number" &&
    typeof face.y === "number" &&
    typeof face.size === "number" &&
    face.size > 0
    ? (face as Face)
    : null;
}

interface Token {
  readonly node: HTMLElement;
  readonly disc: HTMLElement;
  readonly tip: HTMLElement; // the name, HP and conditions, shown on hover or under the cursor
  readonly shield: HTMLElement; // the cover it has against the player, shown on hover while the player can attack it
  readonly name: string;
  notes: readonly string[]; // status and conditions
  side: string;
  x: number | null;
  y: number | null;
  hp: number;
  maxHp: number;
  art: string | null;
}

// Milliseconds each kind of moment stays on screen.
const PACE: Record<DndCue["kind"], number> = {
  start: 1100,
  end: 1300,
  turn: 250,
  attack: 1100,
  check: 1300,
  damage: 650,
  heal: 650,
  down: 700,
  status: 550,
  cast: 450,
  move: 450,
  deathSave: 900,
  legendary: 900,
  resist: 900,
  lair: 1100,
};

// A d20 drawn flat: an outline, its top face and the edges that meet there.
const D20 = `<svg viewBox="0 0 100 100" aria-hidden="true"><polygon class="d20-body" points="50,3 93,27 93,73 50,97 7,73 7,27"/><polygon class="d20-face" points="50,22 76,66 24,66"/><path class="d20-edge" d="M50,3 50,22 M93,27 76,66 M93,73 76,66 M50,97 50,66 M7,73 24,66 M7,27 24,66 M50,22 93,27 M50,22 7,27 M24,66 50,97 76,66"/></svg>`;

const FADE: KeyframeAnimationOptions = { duration: 250, easing: "ease-out" };
const MARKED = ["dodging", "hidden"] as const; // conditions drawn on the token itself

function extraOf(update: BoardUpdate | null): BoardExtra {
  return update?.combat?.board ?? {};
}

const DAMAGE_COLORS: Record<string, string> = {
  fire: "#ff7a2f",
  cold: "#7fd3ff",
  lightning: "#ffe14d",
  thunder: "#c9b3ff",
  acid: "#9be35a",
  poison: "#7ccf5b",
  necrotic: "#b88cff",
  radiant: "#fff3a8",
  psychic: "#ff8ad8",
  force: "#a7b8ff",
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The combat view says "Enemy" or "Ally", for people to read.
function sideOf(actor: Combatant): "enemy" | "party" {
  return actor.side.toLowerCase() === "enemy" ? "enemy" : "party";
}

function artFor(update: BoardUpdate, id: string): TokenArt | null {
  const token = update.tokens[id];
  if (token) return token;
  const path = update.art[id];
  return path ? { path } : null;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

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
  let cursor: { x: number; y: number } | null = null;
  const field = el("div", "dnd-field plain"); // a parchment mat until a picture loads
  const banner = el("div", "dnd-banner");
  const hint = el("div", "dnd-hint", "Click to skip");
  const caption = el("div", "dnd-caption"); // who is doing what, during an attack
  // The first player turn of the first fight says how the map works, until the player uses it.
  const HOW_TO = "Click a square to move, or a foe to attack";
  let howTo: "unseen" | "showing" | "done" = "unseen";
  let decisionSeen: string | null = null;
  let cursorHome = false; // the cursor goes back to the player once the board settles
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
  let groundShown = "";
  const routeCost = el("div", "dnd-route-cost");
  routeCost.hidden = true;
  const menu = el("div", "dnd-menu");
  menu.hidden = true;
  // While choosing targets or aiming an area: how many are chosen, Cast and Back.
  const pickBar = el("div", "dnd-pickbar");
  pickBar.hidden = true;
  field.append(ground, reachZone, blast, cells, route, routeCost, cursorBox);
  board.append(field, banner, caption, hint, menu, pickBar, said);
  slot.append(board);
  slot.hidden = true;

  const tokens = new Map<string, Token>();
  new ResizeObserver(() => {
    layout();
  }).observe(field);
  const queue: DndCue[] = [];
  let latest: BoardUpdate | null = null;
  let playing = false;
  let skipping = false;
  let wake: (() => void) | null = null;
  let sceneArt: string | null = null;
  let grid: { readonly width: number; readonly height: number } | null = null;
  const reduced = (): boolean =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fast = (): boolean => skipping || reduced();

  // While cues play, a click skips them. Otherwise it picks a token or a square.
  board.addEventListener("click", (event) => {
    if (playing) {
      if (throwNow) {
        throwNow();
        return;
      }
      skipping = true;
      wake?.();
      return;
    }
    if (dragged) {
      dragged = false;
      return;
    }
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>(".dnd-cell");
    const token = target.closest<HTMLElement>(".dnd-token");
    const item = target.closest<HTMLElement>(
      ".dnd-menu button, .dnd-pickbar button",
    );
    const aim = aiming() ? aimCellFor(squareAt(event)) : undefined;
    if (item?.dataset.option) {
      closeMenu();
      board.focus(); // the menu button goes away, so focus stays on the map
      mapUsed();
      host.answer(item.dataset.option);
    } else if (aiming()) {
      if (aim) answerCell(aim);
    } else if (cell?.dataset.option) {
      answerCell(cell);
    } else if (token?.dataset.id) {
      openMenu(token.dataset.id, token, true);
    } else {
      closeMenu();
    }
  });

  const wait = (ms: number): Promise<void> =>
    fast()
      ? Promise.resolve()
      : new Promise((resolve) => {
          const done = (): void => {
            wake = null;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, ms);
          wake = done;
        });

  const animate = (
    node: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): void => {
    if (!fast()) node.animate(frames, options);
  };

  const float = (token: Token, text: string, className: string): void => {
    if (fast()) return;
    const label = el("span", `dnd-float ${className}`, text);
    token.node.append(label);
    label
      .animate(
        [
          { transform: "translate(-50%, 0) scale(0.6)", opacity: 0 },
          { transform: "translate(-50%, -18px) scale(1.15)", opacity: 1 },
          { transform: "translate(-50%, -46px) scale(1)", opacity: 0 },
        ],
        { duration: 1000, easing: "ease-out" },
      )
      .addEventListener("finish", () => {
        label.remove();
      });
  };

  const setTip = (token: Token): void => {
    token.tip.textContent = [
      token.name,
      `${String(Math.max(0, token.hp))}/${String(token.maxHp)} HP`,
      ...token.notes,
    ].join(" · ");
  };

  // HP shows as a ring round the disc that empties as the creature is hurt.
  const setHp = (token: Token, hp: number): void => {
    token.hp = hp;
    const share = token.maxHp > 0 ? Math.max(0, hp) / token.maxHp : 0;
    token.node.style.setProperty("--hp", String(share));
    token.node.dataset.level =
      share > 0.5 ? "high" : share > 0.25 ? "mid" : "low";
    token.node.classList.toggle("down", hp <= 0);
    setTip(token);
  };

  // A picture fills the token; with a known face, the face fills it instead of the top of the picture.
  const setArt = (token: Token, art: TokenArt | null): void => {
    const path = art?.path ?? null;
    if (path === token.art) return;
    token.art = path;
    if (!art || !path) return;
    const face = faceOf(art);
    void Promise.resolve(host.imageUrl(path)).then((url) => {
      if (!url || token.art !== path) return;
      const image = document.createElement("img");
      image.alt = "";
      image.addEventListener("error", () => {
        image.remove();
      });
      if (face) {
        image.classList.add("framed");
        image.addEventListener("load", () => {
          const wide = 100 / face.size; // the picture's width, as a share of the token's
          const tall = (wide * image.naturalHeight) / image.naturalWidth;
          image.style.width = `${String(wide)}%`;
          image.style.left = `${String(50 - face.x * wide)}%`;
          image.style.top = `${String(50 - face.y * tall)}%`;
        });
      }
      image.src = url;
      token.disc.replaceChildren(image);
    });
  };

  const tokenFor = (actor: Combatant): Token => {
    const existing = tokens.get(actor.id);
    if (existing) return existing;
    const disc = el("div", "dnd-disc", initials(actor.name));
    const tip = el("span", "dnd-tip");
    const shield = el("span", "dnd-shield");
    shield.hidden = true;
    const node = el("div", "dnd-token");
    node.append(el("span", "dnd-ring"), disc, tip, shield);
    node.dataset.side = sideOf(actor);
    node.dataset.id = actor.id;
    field.append(node);
    const token: Token = {
      node,
      disc,
      tip,
      shield,
      name: actor.name,
      notes: [],
      side: sideOf(actor),
      x: null,
      y: null,
      hp: actor.hp,
      maxHp: actor.maxHp,
      art: null,
    };
    tokens.set(actor.id, token);
    setHp(token, actor.hp);
    animate(
      node,
      [
        { opacity: 0, transform: "translate(-50%, -50%) scale(0.4)" },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
      ],
      { duration: 350, easing: "ease-out" },
    );
    return token;
  };

  // On the grid when there is one; otherwise enemies across the top and the party along the bottom.
  const layout = (): void => {
    if (grid) {
      const square = field.clientWidth / grid.width;
      field.style.setProperty("--sq", `${String(square)}px`);
      field.style.aspectRatio = `${String(grid.width)} / ${String(grid.height)}`;
      field.style.setProperty("--cols", String(grid.width));
      field.style.setProperty("--rows", String(grid.height));
    }
    field.classList.toggle("gridded", grid !== null);
    const sides = new Map<string, Token[]>();
    for (const token of tokens.values()) {
      if (grid && token.x !== null && token.y !== null) {
        token.node.style.left = `${String(((token.x + 0.5) / grid.width) * 100)}%`;
        token.node.style.top = `${String(((token.y + 0.5) / grid.height) * 100)}%`;
        // Near an edge, the tooltip opens inwards, clear of the caption and the frame.
        token.node.classList.toggle("high", token.y < 2);
        token.node.classList.toggle("west", token.x < 2);
        token.node.classList.toggle("east", token.x > grid.width - 3);
        continue;
      }
      sides.set(token.side, [...(sides.get(token.side) ?? []), token]);
    }
    for (const [side, group] of sides) {
      const rows = Math.ceil(group.length / 6);
      group.forEach((token, index) => {
        const row = Math.floor(index / 6);
        const inRow = Math.min(6, group.length - row * 6);
        const x = ((index % 6) + 1) / (inRow + 1);
        const spread = rows > 1 ? (row - (rows - 1) / 2) * 0.18 : 0;
        const y = (side === "enemy" ? 0.36 : 0.76) + spread;
        token.node.style.left = `${String(x * 100)}%`;
        token.node.style.top = `${String(y * 100)}%`;
      });
    }
  };

  const playerOptions = (): readonly Option[] =>
    !playing && latest?.decision?.actor === PLAYER_ACTOR
      ? latest.decision.options
      : [];

  // The map's codes as faint marks: hatching for difficult terrain, an outline for cover, shade for dim light
  // and darkness. A map that's dim or dark everywhere is shaded all over.
  // shortcut: a dim square on a dark map shows as dark; mark it lighter when a map needs it.
  const showGround = (terrain: Terrain | null): void => {
    const shown = JSON.stringify([terrain, grid]);
    if (shown === groundShown) return;
    groundShown = shown;
    ground.replaceChildren();
    ground.dataset.light = terrain?.light ?? "bright";
    if (!terrain || !grid) return;
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
        square.style.left = `${String((Number(match[1]) / grid.width) * 100)}%`;
        square.style.top = `${String((Number(match[2]) / grid.height) * 100)}%`;
        ground.append(square);
      }
    }
  };

  // Where the player can walk. On the turn itself a square answers Move and then the square, so one
  // click or drag does it; while the list is already asking where to, it answers that.
  const showCells = (): void => {
    cells.replaceChildren();
    line.setAttribute("points", "");
    reachZone.hidden = true;
    if (!grid) return;
    const options = playerOptions();
    const asked = options.flatMap((option) => {
      const match = SQUARE.exec(option.id);
      return match
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
      ? (extraOf(latest).moves ?? []).map((move) => ({
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
      cell.style.left = `${String((square.x / grid.width) * 100)}%`;
      cell.style.top = `${String((square.y / grid.height) * 100)}%`;
      cell.dataset.x = String(square.x);
      cell.dataset.y = String(square.y);
      cells.append(cell);
    }
    if (playing) return; // the caption is telling what's happening
    if (aiming() || picking()) {
      showCaption(""); // the bar says what to do, and the caption names who an aim catches
      return;
    }
    if (howTo === "unseen" && options.length > 0) howTo = "showing";
    showCaption(howTo === "showing" ? HOW_TO : "");
  };

  // The player has used the map, so it needs no more explaining.
  const mapUsed = (): void => {
    if (howTo !== "showing") return;
    howTo = "done";
    showCaption("");
  };

  // The dashed route to a square the player is pointing at, from where they stand.
  const showRoute = (cell: HTMLElement | null): void => {
    const me = tokens.get(PLAYER_ACTOR);
    const steps = cell?.dataset.path;
    routeCost.hidden = true;
    if (!grid || !cell || me?.x == null || me.y === null || !steps) {
      line.setAttribute("points", "");
      return;
    }
    // What the walk costs, counting difficult terrain double, next to where it ends.
    if (cell.dataset.feet && cell.dataset.feet !== "0") {
      routeCost.textContent = `${cell.dataset.feet} ft`;
      routeCost.style.left = `${String(((Number(cell.dataset.x) + 0.5) / grid.width) * 100)}%`;
      routeCost.style.top = `${String((Number(cell.dataset.y) / grid.height) * 100)}%`;
      routeCost.hidden = false;
    }
    route.setAttribute(
      "viewBox",
      `0 0 ${String(grid.width)} ${String(grid.height)}`,
    );
    line.setAttribute(
      "points",
      [`${String(me.x)},${String(me.y)}`, ...steps.split(" ")]
        .map((point) => {
          const [x = 0, y = 0] = point.split(",").map(Number);
          return `${String(x + 0.5)},${String(y + 0.5)}`;
        })
        .join(" "),
    );
    route.classList.toggle("risky", cell.classList.contains("risky"));
  };

  // The squares a creature can hit in melee, while the pointer rests on it.
  const showReach = (id: string | null): void => {
    const token = id ? tokens.get(id) : undefined;
    const feet = id ? extraOf(latest).reach?.[id] : undefined;
    if (
      !grid ||
      token?.x == null ||
      token.y === null ||
      !feet ||
      id === PLAYER_ACTOR
    ) {
      reachZone.hidden = true;
      return;
    }
    const squares = feet / 5;
    const left = Math.max(0, token.x - squares);
    const top = Math.max(0, token.y - squares);
    const right = Math.min(grid.width, token.x + squares + 1);
    const bottom = Math.min(grid.height, token.y + squares + 1);
    reachZone.style.left = `${String((left / grid.width) * 100)}%`;
    reachZone.style.top = `${String((top / grid.height) * 100)}%`;
    reachZone.style.width = `${String(((right - left) / grid.width) * 100)}%`;
    reachZone.style.height = `${String(((bottom - top) / grid.height) * 100)}%`;
    reachZone.hidden = false;
  };

  // Lights the squares an area aimed at `aim` would cover, and rings everyone it would catch.
  const outline = (
    targeting: AreaTargeting | null | undefined,
    aim: { readonly x: number; readonly y: number } | null,
  ): void => {
    blast.replaceChildren();
    for (const token of tokens.values()) token.node.classList.remove("caught");
    const me = tokens.get(PLAYER_ACTOR);
    if (!grid || !targeting || !aim || me?.x == null || me.y === null) return;
    const origin = { x: me.x, y: me.y };
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        if (!covers(targeting, origin, aim, { x, y })) continue;
        const square = el("div", "dnd-blast-square");
        square.style.left = `${String((x / grid.width) * 100)}%`;
        square.style.top = `${String((y / grid.height) * 100)}%`;
        blast.append(square);
      }
    }
    for (const token of tokens.values()) {
      if (token.x === null || token.y === null || token.hp <= 0) continue;
      const caught =
        (targeting.side === "enemy" || token.side === "party") &&
        covers(targeting, origin, aim, { x: token.x, y: token.y });
      token.node.classList.toggle("caught", caught);
    }
  };

  // Pointing at an area spell round the player in a menu lights the squares it covers.
  const showArea = (optionId: string | null): void => {
    const [actionId = "", target] = parseOption(optionId ?? "");
    const targeting = extraOf(latest).shapes?.[actionId];
    const me = tokens.get(PLAYER_ACTOR);
    outline(
      target === ALL && targeting?.area.shape === "emanation"
        ? targeting
        : null,
      me?.x == null || me.y === null ? null : { x: me.x, y: me.y },
    );
  };

  // The follow-up the player is answering: aiming an area (with its shape), or choosing targets.
  const pendingId = (): string =>
    playerOptions().length > 0 ? (latest?.decision?.id ?? "") : "";
  const aiming = (): AreaTargeting | null => {
    const id = pendingId();
    if (!id.startsWith(`${NS}:aim:`)) return null;
    return extraOf(latest).shapes?.[parseOption(id).at(-1) ?? ""] ?? null;
  };
  const picking = (): boolean => pendingId().startsWith(`${NS}:targets:`);

  // The grid square under the pointer.
  const squareAt = (event: MouseEvent): { x: number; y: number } | null => {
    if (!grid) return null;
    const box = field.getBoundingClientRect();
    const x = Math.floor(((event.clientX - box.left) / box.width) * grid.width);
    const y = Math.floor(
      ((event.clientY - box.top) / box.height) * grid.height,
    );
    return x >= 0 && y >= 0 && x < grid.width && y < grid.height
      ? { x, y }
      : null;
  };

  // The aim option for a square: that square, or for an area from the player, the nearest of the 8 ways.
  const aimCellFor = (
    square: { readonly x: number; readonly y: number } | null,
  ): HTMLElement | undefined => {
    if (!square) return undefined;
    const exact = cellNodeAt(square.x, square.y);
    const me = tokens.get(PLAYER_ACTOR);
    if (exact || aiming()?.range !== "self" || me?.x == null || me.y === null) {
      return exact;
    }
    if (square.x === me.x && square.y === me.y) return undefined;
    const eighth =
      Math.round(Math.atan2(square.y - me.y, square.x - me.x) / (Math.PI / 4)) *
      (Math.PI / 4);
    return cellNodeAt(
      me.x + Math.round(Math.cos(eighth)),
      me.y + Math.round(Math.sin(eighth)),
    );
  };

  // Shows where an aim would land and who it catches, named in the caption.
  const showAim = (cell: HTMLElement | undefined): void => {
    for (const item of cells.children) {
      item.classList.toggle("hover", item === cell);
    }
    outline(
      aiming(),
      cell ? { x: Number(cell.dataset.x), y: Number(cell.dataset.y) } : null,
    );
    showCaption(cell?.title ?? "");
  };

  // The bar while choosing targets or aiming: the count so far, Cast once it can, and Back.
  const showPickBar = (): void => {
    const options = playerOptions();
    const id = pendingId();
    const choosing = picking();
    pickBar.hidden = !choosing && !aiming();
    for (const token of tokens.values()) {
      token.node.classList.remove("picked");
      delete token.node.dataset.count;
    }
    if (pickBar.hidden) return;
    const [, , total = "0", chosen = ""] = parseOption(id);
    const picked = chosen.split(",").filter(Boolean);
    for (const pickedId of new Set(picked)) {
      const token = tokens.get(pickedId);
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
    pickBar.replaceChildren(note, ...buttons);
  };
  menu.addEventListener("pointerover", (event) => {
    showArea(
      (event.target as HTMLElement).closest<HTMLElement>("button")?.dataset
        .option ?? null,
    );
  });
  menu.addEventListener("pointerleave", () => {
    showArea(null);
  });
  menu.addEventListener("focusin", (event) => {
    showArea((event.target as HTMLElement).dataset.option ?? null);
  });

  field.addEventListener("pointerover", (event) => {
    const target = event.target as HTMLElement;
    showRoute(target.closest<HTMLElement>(".dnd-cell"));
    showReach(target.closest<HTMLElement>(".dnd-token")?.dataset.id ?? null);
  });
  field.addEventListener("pointerleave", () => {
    showRoute(null);
    showReach(null);
    if (aiming()) showAim(undefined);
  });
  field.addEventListener("pointermove", (event) => {
    if (aiming() && !playing) showAim(aimCellFor(squareAt(event)));
  });

  const answerCell = (cell: HTMLElement): void => {
    const steps = (cell.dataset.option ?? "").split(" ").filter(Boolean);
    if (steps.length === 0) return;
    mapUsed();
    host.answer(...steps);
  };

  // Dragging the player's token onto a lit square walks it there.
  let dragged = false;
  field.addEventListener("pointerdown", (down) => {
    const token = (down.target as HTMLElement).closest<HTMLElement>(
      ".dnd-token",
    );
    if (playing || token?.dataset.id !== PLAYER_ACTOR || !cells.firstChild) {
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
      for (const cell of cells.children) cell.classList.remove("hover");
      const under = cellAt(event);
      under?.classList.add("hover");
      showRoute(under);
    };
    const up = (event: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      token.classList.remove("dragging");
      token.style.translate = "";
      showRoute(null);
      if (!moving) return;
      dragged = true;
      const cell = cellAt(event);
      if (cell) answerCell(cell);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  const cellAt = (event: PointerEvent): HTMLElement | null => {
    const found = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((item) => item.classList.contains("dnd-cell"));
    return found instanceof HTMLElement ? found : null;
  };

  // The options aimed at a token, or for the player's own token, the ones aimed at nobody in particular.
  // A click on a foe with one thing to do does it; keys always get the menu, and so does your own
  // token, whose menu can hold End your turn, unless you're choosing targets.
  const openMenu = (id: string, anchor: HTMLElement, pointer = false): void => {
    const own = id === PLAYER_ACTOR;
    // Study stays in the Actions tab, so a click on a foe out of reach still does nothing.
    const options = playerOptions().filter((option) => {
      if (SQUARE.test(option.id) || option.id === MOVE) return false;
      if (option.id.startsWith(STUDY)) return false;
      const target = parseOption(option.id)[1];
      if (target === id || target === `${AIM}${id}`) return true;
      if (option.id.startsWith(ADD) || option.id.startsWith(REMOVE)) {
        return option.id.slice(1) === id;
      }
      return (
        own &&
        (target === undefined || ["all", "aim", "pick"].includes(target)) &&
        !(picking() && (option.id === CONFIRM || option.id === BACK))
      );
    });
    if (options.length === 0) {
      closeMenu();
      return;
    }
    const [only] = options;
    // A click attacks at once, but Help, Grapple and the like always ask first, as each spends the action.
    if (
      pointer &&
      (!own || picking()) &&
      only &&
      options.length === 1 &&
      !only.id.startsWith(TACTIC)
    ) {
      closeMenu();
      mapUsed();
      host.answer(only.id);
      return;
    }
    menu.replaceChildren(
      ...options.map((option) => {
        const button = el("button", "", option.label);
        button.dataset.option = option.id;
        return button;
      }),
    );
    const box = board.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    menu.style.left = `${String(Math.max(0, Math.min(at.right - box.left, box.width - 220)))}px`;
    // In the lower half it opens upwards, so the board's edge doesn't cut it off.
    const lower = at.top - box.top > box.height / 2;
    menu.style.top = lower ? "" : `${String(at.top - box.top)}px`;
    menu.style.bottom = lower ? `${String(box.bottom - at.bottom)}px` : "";
    menu.hidden = false;
  };

  const closeMenu = (): void => {
    menu.hidden = true;
    showArea(null);
  };

  // "C4" for the third column of the fourth row, as the move list names squares.
  const squareName = (x: number, y: number): string =>
    `${String.fromCharCode(65 + (x % 26))}${String(y + 1)}`;

  const tokenAt = (x: number, y: number): [string, Token] | undefined =>
    [...tokens].find(([, token]) => token.x === x && token.y === y);

  const cellNodeAt = (x: number, y: number): HTMLElement | undefined =>
    [...cells.querySelectorAll<HTMLElement>(".dnd-cell")].find(
      (cell) => cell.dataset.x === String(x) && cell.dataset.y === String(y),
    );

  // Puts the cursor on a square, shows what pointing there would, and says what's there.
  const placeCursor = (x: number, y: number): void => {
    if (!grid) return;
    cursor = {
      x: Math.max(0, Math.min(grid.width - 1, x)),
      y: Math.max(0, Math.min(grid.height - 1, y)),
    };
    cursorBox.style.left = `${String((cursor.x / grid.width) * 100)}%`;
    cursorBox.style.top = `${String((cursor.y / grid.height) * 100)}%`;
    const found = tokenAt(cursor.x, cursor.y);
    const cell = cellNodeAt(cursor.x, cursor.y);
    if (aiming()) showAim(aimCellFor(cursor));
    showRoute(cell ?? null);
    showReach(found?.[0] ?? null);
    for (const token of tokens.values()) {
      token.node.classList.toggle("cursor", token === found?.[1]);
    }
    const name = squareName(cursor.x, cursor.y);
    if (found) {
      const [, token] = found;
      said.textContent = `${name}: ${token.name}, ${String(Math.max(0, token.hp))} of ${String(token.maxHp)} HP.`;
    } else {
      said.textContent = cell
        ? `${name}: ${cell.title}.`
        : `${name}: out of reach.`;
    }
  };

  // Focus says where the cursor is, starting on the player's own square.
  board.addEventListener("focus", () => {
    if (!grid) return;
    const me = tokens.get(PLAYER_ACTOR);
    placeCursor(cursor?.x ?? me?.x ?? 0, cursor?.y ?? me?.y ?? 0);
  });

  const STEPS: Readonly<Record<string, readonly [number, number]>> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };

  board.addEventListener("keydown", (event) => {
    const inMenu = (event.target as HTMLElement).closest(".dnd-menu");
    if (inMenu) {
      const buttons = [...menu.querySelectorAll<HTMLElement>("button")];
      const at = buttons.indexOf(event.target as HTMLElement);
      if (event.key === "Escape") {
        closeMenu();
        board.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      } else {
        return;
      }
      event.preventDefault();
      return;
    }
    if (event.target !== board) return;
    if (playing && throwNow && (event.key === "Enter" || event.key === " ")) {
      throwNow();
      event.preventDefault();
      return;
    }
    if (
      playing &&
      (event.key === "Enter" || event.key === " " || event.key === "Escape")
    ) {
      skipping = true;
      wake?.();
      event.preventDefault();
      return;
    }
    const step = STEPS[event.key];
    if (step && grid) {
      const me = tokens.get(PLAYER_ACTOR);
      const from = cursor ?? { x: me?.x ?? 0, y: me?.y ?? 0 };
      placeCursor(from.x + step[0], from.y + step[1]);
      event.preventDefault();
    } else if ((event.key === "Enter" || event.key === " ") && aiming()) {
      event.preventDefault();
      const cell = aimCellFor(cursor);
      if (cell) answerCell(cell);
      else said.textContent = "It can't be aimed there.";
    } else if (event.key === "Escape" && (aiming() || picking())) {
      event.preventDefault();
      mapUsed();
      host.answer(BACK);
    } else if ((event.key === "Enter" || event.key === " ") && cursor) {
      event.preventDefault();
      const found = tokenAt(cursor.x, cursor.y);
      const cell = cellNodeAt(cursor.x, cursor.y);
      if (found) {
        openMenu(found[0], found[1].node);
        const first = menu.querySelector<HTMLElement>("button");
        if (first && !menu.hidden) first.focus();
        else said.textContent = "Nothing to do there.";
      } else if (cell) {
        answerCell(cell);
      }
    } else if (event.key === "Escape") {
      closeMenu();
    }
  });

  // Values, arrivals and removals wait until the queue is done, so they don't spoil what's playing.
  const sync = (update: BoardUpdate, settle: boolean): void => {
    // The book's battle map when the fight has one, cut to the fight's squares; otherwise the scene's picture.
    const map = extraOf(update).map ?? null;
    const backdrop = map ? `${update.assetRoot}/${map.image}` : update.sceneArt;
    if (backdrop !== sceneArt) {
      sceneArt = backdrop;
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
            if (sceneArt !== path) return;
            field.style.backgroundImage = `url("${url}")`;
            field.classList.remove("plain");
          });
          image.src = url;
        });
      }
    }
    // A new decision starts the keyboard cursor again from the player's own square.
    const decision = update.decision?.id ?? null;
    if (decision !== decisionSeen && update.decision?.actor === PLAYER_ACTOR) {
      cursor = null;
      cursorHome = true;
    }
    decisionSeen = decision;
    const parsed = StateSchema.safeParse(update.state);
    const actors = parsed.success ? parsed.data.actors : {};
    if (settle) grid = parsed.data?.combat?.grid ?? null;
    const present = new Set<string>();
    for (const actor of update.combat?.combatants ?? []) {
      present.add(actor.id);
      const isNew = !tokens.has(actor.id);
      // While cues play, the start cue brings everyone in as the fight began.
      if (isNew && !settle) continue;
      const token = tokenFor(actor);
      setArt(token, artFor(update, actor.id));
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
      for (const [id, token] of tokens) {
        if (!present.has(id)) {
          token.node.remove();
          tokens.delete(id);
        }
      }
    }
    if (settle) {
      showGround(extraOf(update).terrain ?? null);
      // The shield shows the cover a foe has while the player has something to aim at it.
      const aimable = new Set(
        update.decision?.actor === PLAYER_ACTOR
          ? update.decision.options.map((option) =>
              // An area aimed at a creature names it as "@" and its id.
              parseOption(option.id)[1]?.replace(AIM, ""),
            )
          : [],
      );
      for (const [id, token] of tokens) {
        const bonus = extraOf(update).cover?.[id] ?? 0;
        token.shield.hidden = bonus === 0 || !aimable.has(id);
        token.shield.textContent = `+${String(bonus)}`;
        token.shield.title =
          bonus >= 5
            ? "Three-quarters cover: +5 to AC and Dexterity saves"
            : "Half cover: +2 to AC and Dexterity saves";
      }
    }
    layout();
    showCells();
    showPickBar();
    closeMenu();
    slot.hidden = tokens.size === 0 && !playing;
    // While the map has focus, the cursor visibly goes back to the player's square.
    const me = tokens.get(PLAYER_ACTOR);
    if (cursorHome && settle) {
      cursorHome = false;
      if (document.activeElement === board && me) {
        placeCursor(me.x ?? 0, me.y ?? 0);
      }
    }
  };

  const showBanner = async (text: string, ms: number): Promise<void> => {
    banner.textContent = text;
    banner.classList.add("shown");
    animate(
      banner,
      [
        { opacity: 0, transform: "translate(-50%, -50%) scale(1.6)" },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
      ],
      { duration: 300, easing: "ease-out" },
    );
    await wait(ms);
    banner.classList.remove("shown");
  };

  // The player throws their own dice: the die waits for a click, Enter or Space.
  let throwNow: (() => void) | null = null;
  const waitForThrow = (prompt: HTMLElement): Promise<void> =>
    fast()
      ? Promise.resolve()
      : new Promise((resolve) => {
          prompt.classList.add("waiting");
          board.classList.add("awaiting");
          throwNow = () => {
            throwNow = null;
            prompt.classList.remove("waiting");
            board.classList.remove("awaiting");
            if (host.sound?.() === true) {
              setEffectsVolume(host.volume?.() ?? 1);
              diceSound();
            }
            resolve();
          };
        });

  // Where a token's centre is, in the board's own pixels.
  const centreOf = (node: HTMLElement): { x: number; y: number } => {
    const box = board.getBoundingClientRect();
    const at = node.getBoundingClientRect();
    return {
      x: at.left - box.left + at.width / 2,
      y: at.top - box.top + at.height / 2,
    };
  };

  // A d20 tumbles from one point to another and lands on the roll. Yours waits for you to throw it.
  const throwD20 = async (
    start: { x: number; y: number },
    to: { x: number; y: number },
    natural: number,
    before: string, // what it's for, such as "Perception · DC 12"
    note: string,
    mine: boolean,
  ): Promise<HTMLElement> => {
    let from = start;
    const die = el("div", mine ? "dnd-throw mine" : "dnd-throw");
    die.innerHTML = D20;
    const face = el("span", "dnd-throw-number", "20");
    const label = el(
      "small",
      "dnd-throw-note",
      mine ? `${before}: click or press Return` : "",
    );
    die.append(face, label);
    board.append(die);
    const place = (point: { x: number; y: number }): void => {
      die.style.left = `${String(point.x)}px`;
      die.style.top = `${String(point.y)}px`;
    };
    if (mine && !fast()) {
      const box = board.getBoundingClientRect();
      from = { x: box.width / 2, y: box.height / 2 };
      place(from);
      await waitForThrow(die);
      label.textContent = "";
    }
    place(to);
    if (!fast()) {
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      const at = (x: number, y: number, turn: number, size: number): string =>
        `translate(calc(-50% + ${String(x)}px), calc(-50% + ${String(y)}px)) rotate(${String(turn)}deg) scale(${String(size)})`;
      const tumble = die.animate(
        [
          { transform: at(dx, dy, 0, 1.3) },
          { transform: at(dx * 0.45, dy * 0.45 - 60, 400, 1.15), offset: 0.45 },
          { transform: at(dx * 0.12, dy * 0.12, 640, 1), offset: 0.8 },
          { transform: at(0, -14, 700, 1), offset: 0.9 },
          { transform: at(0, 0, 720, 1) },
        ],
        { duration: mine ? 1100 : 750, easing: "cubic-bezier(.3,.7,.4,1)" },
      );
      for (let tick = 0; tick < (mine ? 14 : 8) && !fast(); tick += 1) {
        face.textContent = String(1 + Math.floor(Math.random() * 20));
        await wait(mine ? 70 : 80);
      }
      await tumble.finished.catch(() => undefined);
    }
    face.textContent = String(natural);
    label.textContent = note;
    die.classList.toggle("crit", natural === 20);
    die.classList.toggle("fumble", natural === 1);
    return die;
  };

  // A swing at the target, a shot flying to it, or a spell streaking to it.
  const strike = async (
    attacker: Token,
    target: Token,
    style: "melee" | "ranged" | "spell",
  ): Promise<void> => {
    if (fast()) return;
    const from = centreOf(attacker.node);
    const to = centreOf(target.node);
    if (style === "melee") {
      const dx = (to.x - from.x) * 0.45;
      const dy = (to.y - from.y) * 0.45;
      attacker.node.animate(
        [
          { transform: "translate(-50%, -50%)" },
          {
            transform: `translate(calc(-50% + ${String(dx)}px), calc(-50% + ${String(dy)}px)) scale(1.12)`,
          },
          { transform: "translate(-50%, -50%)" },
        ],
        { duration: 380, easing: "ease-in-out" },
      );
      await wait(170);
      const slash = el("div", "dnd-slash");
      slash.style.left = `${String(to.x)}px`;
      slash.style.top = `${String(to.y)}px`;
      board.append(slash);
      await slash
        .animate(
          [
            {
              transform: "translate(-50%, -50%) rotate(-70deg) scale(0.6)",
              opacity: 0,
            },
            {
              transform: "translate(-50%, -50%) rotate(10deg) scale(1.1)",
              opacity: 1,
              offset: 0.5,
            },
            {
              transform: "translate(-50%, -50%) rotate(40deg) scale(1.2)",
              opacity: 0,
            },
          ],
          { duration: 320, easing: "ease-out" },
        )
        .finished.catch(() => undefined);
      slash.remove();
      return;
    }
    const shot = el("div", style === "spell" ? "dnd-bolt" : "dnd-arrow");
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    shot.style.left = `${String(from.x)}px`;
    shot.style.top = `${String(from.y)}px`;
    board.append(shot);
    await shot
      .animate(
        [
          { transform: `translate(-50%, -50%) rotate(${String(angle)}deg)` },
          {
            transform: `translate(calc(-50% + ${String(to.x - from.x)}px), calc(-50% + ${String(to.y - from.y)}px)) rotate(${String(angle)}deg)`,
          },
        ],
        { duration: style === "spell" ? 420 : 300, easing: "ease-in" },
      )
      .finished.catch(() => undefined);
    shot.remove();
  };

  const showCaption = (text: string): void => {
    caption.textContent = text;
    caption.classList.toggle("shown", text !== "");
  };

  // The damage dice the last attack rolls, kept until its damage arrives.
  let pendingDamage: {
    readonly target: string;
    readonly dice: string;
    readonly mine: boolean;
  } | null = null;

  const play = async (cue: DndCue): Promise<void> => {
    // The player's own roll makes its sound when they throw it, not before.
    const ownRoll =
      (cue.kind === "attack" ||
        cue.kind === "check" ||
        cue.kind === "deathSave") &&
      cue.actor === PLAYER_ACTOR;
    if (!fast() && !ownRoll && host.sound?.() === true) {
      setEffectsVolume(host.volume?.() ?? 1);
      cueSound(cue);
    }
    const ms = PACE[cue.kind];
    switch (cue.kind) {
      case "start":
        grid = cue.grid;
        for (const actor of cue.combatants) {
          const token = tokenFor({
            ...actor,
            active: false,
            conditions: [],
            status: null,
          });
          token.x = actor.x;
          token.y = actor.y;
          setArt(token, latest ? artFor(latest, actor.id) : null);
        }
        layout();
        slot.hidden = false;
        await showBanner("Roll for initiative!", ms);
        if (cue.surprised) {
          await showBanner(
            cue.surprised === "party"
              ? "Surprised!"
              : "You catch them by surprise!",
            ms,
          );
        }
        return;
      case "end": {
        howTo = howTo === "unseen" ? "unseen" : "done";
        const enemies = [...tokens.values()].filter((t) => t.side === "enemy");
        const party = [...tokens.values()].filter((t) => t.side !== "enemy");
        const text = enemies.every((t) => t.hp <= 0)
          ? "Victory!"
          : party.every((t) => t.hp <= 0)
            ? "Defeat"
            : "The fight is over";
        await showBanner(text, ms);
        return;
      }
      case "move": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        token.x = cue.x;
        token.y = cue.y;
        layout();
        await wait(ms);
        return;
      }
      case "turn":
        for (const [id, token] of tokens) {
          token.node.classList.toggle("active", id === cue.actor);
        }
        await wait(ms);
        return;
      case "attack": {
        const attacker = tokens.get(cue.actor);
        const target = tokens.get(cue.target);
        if (!attacker || !target) return;
        const mine = cue.actor === PLAYER_ACTOR;
        showCaption(
          `${attacker.name} attacks ${target.name} with ${cue.label}`,
        );
        attacker.node.classList.add("acting");
        target.node.classList.add("targeted");
        const from = centreOf(attacker.node);
        const to = centreOf(target.node);
        const die = await throwD20(
          from,
          { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
          cue.natural,
          `${cue.label} · AC ${String(cue.ac)}`,
          `${String(cue.total)} vs AC ${String(cue.ac)}: ${cue.hit ? (cue.natural === 20 ? "Critical hit" : "Hit") : "Miss"}`,
          mine,
        );
        await wait(mine ? 350 : 200);
        await strike(attacker, target, cue.style);
        float(
          target,
          cue.hit ? (cue.natural === 20 ? "CRIT!" : "HIT") : "MISS",
          cue.hit ? "hit" : "miss",
        );
        if (!cue.hit) {
          animate(
            target.node,
            [
              { transform: "translate(-50%, -50%)" },
              { transform: "translate(calc(-50% + 14px), -50%)" },
              { transform: "translate(-50%, -50%)" },
            ],
            { duration: 260, easing: "ease-out" },
          );
        }
        pendingDamage =
          cue.hit && cue.damage
            ? { target: cue.target, dice: cue.damage, mine }
            : null;
        await wait(Math.max(200, ms - 900));
        die.remove();
        attacker.node.classList.remove("acting");
        target.node.classList.remove("targeted");
        showCaption("");
        return;
      }
      case "deathSave": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        const at = centreOf(token.node);
        const die = await throwD20(
          at,
          { x: at.x, y: at.y - 50 },
          cue.natural,
          "Death save · DC 10",
          `Death save: ${cue.natural >= 10 ? "Success" : "Failed"}`,
          cue.actor === PLAYER_ACTOR,
        );
        await wait(ms);
        die.remove();
        return;
      }
      case "check": {
        // Outside a fight the check rises over the page and fades away after, rather than pushing it about.
        const alone = tokens.size === 0;
        slot.classList.toggle("dnd-overlay", alone);
        slot.hidden = false;
        board.classList.add("checking");
        if (alone) animate(slot, [{ opacity: 0 }, { opacity: 1 }], FADE);
        const box = board.getBoundingClientRect();
        const middle = { x: box.width / 2, y: Math.max(110, box.height / 2) };
        const skill = `${cue.label.charAt(0).toUpperCase()}${cue.label.slice(1)}`;
        const die = await throwD20(
          { x: middle.x - 120, y: middle.y + 40 },
          middle,
          cue.natural,
          `${skill} · DC ${String(cue.dc)}`,
          `${skill} ${String(cue.total)} vs DC ${String(cue.dc)}: ${cue.success ? "Success" : "Failed"}`,
          cue.actor === PLAYER_ACTOR,
        );
        die.classList.add("big", cue.success ? "pass" : "fail");
        await wait(ms - 300);
        if (alone && !fast()) {
          await slot
            .animate([{ opacity: 1 }, { opacity: 0 }], FADE)
            .finished.catch(() => undefined);
        }
        die.remove();
        board.classList.remove("checking");
        slot.classList.remove("dnd-overlay");
        slot.hidden = tokens.size === 0;
        return;
      }
      case "damage": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        const color = DAMAGE_COLORS[cue.type] ?? "#ff4d4d";
        // The damage dice, rolled where the blow lands, for the attack just shown.
        if (pendingDamage?.target === cue.actor && !fast()) {
          const roll = el(
            "div",
            "dnd-damage-dice",
            `${pendingDamage.dice} = ${String(cue.amount)}`,
          );
          const at = centreOf(token.node);
          roll.style.left = `${String(at.x)}px`;
          roll.style.top = `${String(at.y - 40)}px`;
          board.append(roll);
          roll
            .animate(
              [
                {
                  transform: "translate(-50%, -50%) scale(0.5) rotate(-20deg)",
                  opacity: 0,
                },
                {
                  transform: "translate(-50%, -50%) scale(1.1) rotate(4deg)",
                  opacity: 1,
                  offset: 0.3,
                },
                {
                  transform: "translate(-50%, -70%) scale(1)",
                  opacity: 1,
                  offset: 0.8,
                },
                { transform: "translate(-50%, -90%) scale(1)", opacity: 0 },
              ],
              {
                duration: pendingDamage.mine ? 1400 : 1000,
                easing: "ease-out",
              },
            )
            .addEventListener("finish", () => {
              roll.remove();
            });
        }
        pendingDamage = null;
        token.node.style.setProperty("--flash", color);
        animate(
          token.node,
          [
            { transform: "translate(-50%, -50%)" },
            { transform: "translate(calc(-50% - 6px), -50%) rotate(-4deg)" },
            { transform: "translate(calc(-50% + 6px), -50%) rotate(4deg)" },
            { transform: "translate(-50%, -50%)" },
          ],
          { duration: 300 },
        );
        animate(
          token.disc,
          [
            { boxShadow: `0 0 0 0 ${color}`, filter: "brightness(2)" },
            { boxShadow: `0 0 24px 8px ${color}`, filter: "brightness(1)" },
            { boxShadow: "0 0 0 0 transparent", filter: "brightness(1)" },
          ],
          { duration: 500 },
        );
        float(
          token,
          `-${String(cue.amount)}`,
          cue.critical ? "damage crit" : "damage",
        );
        setHp(token, cue.hp);
        await wait(ms);
        return;
      }
      case "heal": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        animate(
          token.disc,
          [
            { boxShadow: "0 0 0 0 #6dff9b" },
            { boxShadow: "0 0 26px 10px #6dff9b" },
            { boxShadow: "0 0 0 0 transparent" },
          ],
          { duration: 600 },
        );
        float(token, `+${String(cue.amount)}`, "heal");
        setHp(token, cue.hp);
        await wait(ms);
        return;
      }
      case "down": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        token.node.classList.add("down");
        float(token, "Down!", "miss");
        await wait(ms);
        return;
      }
      case "status": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        float(token, cue.text, "status");
        await wait(ms);
        return;
      }
      case "legendary": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        showCaption(`${token.name}: legendary action, ${cue.label}`);
        float(token, cue.label, "legendary");
        animate(
          token.disc,
          [
            { boxShadow: "0 0 0 0 #ffd36b" },
            { boxShadow: "0 0 26px 10px #ffd36b" },
            { boxShadow: "0 0 0 0 transparent" },
          ],
          { duration: 700 },
        );
        await wait(ms);
        return;
      }
      case "resist": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        showCaption(
          `${token.name} shrugs it off: Legendary Resistance (${String(cue.left)} left)`,
        );
        float(
          token,
          `Legendary Resistance (${String(cue.left)} left)`,
          "legendary",
        );
        await wait(ms);
        return;
      }
      case "lair": {
        animate(
          board,
          [
            { boxShadow: "inset 0 0 0 0 transparent" },
            { boxShadow: "inset 0 0 90px 30px rgb(150 40 20 / 70%)" },
            { boxShadow: "inset 0 0 0 0 transparent" },
          ],
          { duration: 900 },
        );
        await showBanner(`Lair action: ${cue.label}`, ms);
        return;
      }
      case "cast": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        animate(
          token.disc,
          [
            { boxShadow: "0 0 0 0 #b38cff", filter: "hue-rotate(0deg)" },
            { boxShadow: "0 0 30px 12px #b38cff", filter: "hue-rotate(40deg)" },
            { boxShadow: "0 0 0 0 transparent", filter: "hue-rotate(0deg)" },
          ],
          { duration: 500 },
        );
        await wait(ms);
        return;
      }
    }
  };

  const run = async (): Promise<void> => {
    playing = true;
    board.classList.add("playing");
    cells.replaceChildren();
    closeMenu();
    for (let cue = queue.shift(); cue; cue = queue.shift()) {
      await play(cue);
    }
    playing = false;
    skipping = false;
    board.classList.remove("playing");
    if (latest) sync(latest, true);
    for (const done of waiting.splice(0)) done();
  };

  const waiting: (() => void)[] = [];

  return {
    // Resolves once everything queued so far has played, so the shell can hold back text that would spoil it.
    settled(): Promise<void> {
      return playing || queue.length > 0
        ? new Promise((resolve) => waiting.push(resolve))
        : Promise.resolve();
    },
    update(received: ShellUpdate): void {
      // This plugin's own ui/index.ts and ui/cues.ts wrote the parts the shell leaves unknown.
      const update = received as BoardUpdate;
      latest = update;
      sync(update, !playing && update.cues.length === 0);
      queue.push(...update.cues);
      if (!playing && queue.length > 0) void run();
    },
  };
}
