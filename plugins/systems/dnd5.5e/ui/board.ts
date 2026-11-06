import { PLAYER_ACTOR } from "#sdk";
import { StateSchema } from "../core/state.ts";
import type { DndCue } from "./cues.ts";
import { cueSound } from "./sound.ts";

// The combat board: tokens on a 5-foot grid over the scene's picture, animated from cues one at a time.
// Clicking a token or a square, or moving a cursor with the arrow keys and pressing Enter, answers the
// same options the list below offers, so the board is a shortcut and never the only way to do something.
// Its animations only show what the journal says in words.
// Matched by shape with engine/shell, which plugins never import.

interface Combatant {
  readonly id: string;
  readonly name: string;
  readonly side: string;
  readonly active: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly conditions: readonly string[];
  readonly status: string | null;
}

interface Option {
  readonly id: string;
  readonly label: string;
}

interface BoardUpdate {
  readonly state: unknown;
  readonly decision: {
    readonly id: string;
    readonly actor: string;
    readonly options: readonly Option[];
  } | null;
  readonly combat: {
    readonly combatants: readonly Combatant[];
    readonly board?: unknown; // from this plugin's combat view: where the player can move
  } | null;
  readonly art: Readonly<Record<string, string>>;
  readonly sceneArt: string | null;
  readonly cues: readonly unknown[];
}

interface BoardHost {
  readonly imageUrl: (path: string) => string | Promise<string | null> | null;
  readonly answer: (...optionIds: readonly string[]) => void;
  readonly sound?: () => boolean;
}

interface Token {
  readonly node: HTMLElement;
  readonly disc: HTMLElement;
  readonly bar: HTMLElement;
  readonly hpText: HTMLElement;
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
  attack: 900,
  check: 1300,
  damage: 650,
  heal: 650,
  down: 700,
  status: 550,
  cast: 450,
  move: 450,
};

const SQUARE = /^(\d+),(\d+)$/; // a move option's id
const SEPARATOR = "|"; // between an option id's action, target and slot
const AIM = "@"; // an area aimed at a creature
const MOVE = "move"; // the turn option that asks where to go

interface Move {
  readonly x: number;
  readonly y: number;
  readonly feet: number;
  readonly path: readonly (readonly [number, number])[];
  readonly provokes: number; // how many enemies get an Opportunity Attack
}

interface BoardExtra {
  readonly moves?: readonly Move[];
  readonly reach?: Readonly<Record<string, number>>; // melee reach in feet, by creature
  // The squares an area spell would cover, by its option id without the slot level.
  readonly areas?: Readonly<
    Record<string, readonly (readonly [number, number])[]>
  >;
}

// Written by this plugin's own combat view in ui/index.ts, so its shape is known.
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
  const field = el("div", "dnd-field");
  const banner = el("div", "dnd-banner");
  const hint = el("div", "dnd-hint", "Click to skip");
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
  const menu = el("div", "dnd-menu");
  menu.hidden = true;
  field.append(reachZone, blast, cells, route, cursorBox);
  board.append(field, banner, hint, menu, said);
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
    const item = target.closest<HTMLElement>(".dnd-menu button");
    if (item?.dataset.option) {
      closeMenu();
      board.focus(); // the menu button goes away, so focus stays on the map
      host.answer(item.dataset.option);
    } else if (cell?.dataset.option) {
      answerCell(cell);
    } else if (token?.dataset.id) {
      openMenu(token.dataset.id, token);
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

  const setHp = (token: Token, hp: number): void => {
    token.hp = hp;
    const share = token.maxHp > 0 ? Math.max(0, hp) / token.maxHp : 0;
    token.bar.style.width = `${String(Math.round(share * 100))}%`;
    token.bar.dataset.level =
      share > 0.5 ? "high" : share > 0.25 ? "mid" : "low";
    token.hpText.textContent = `${String(Math.max(0, hp))}/${String(token.maxHp)}`;
    token.node.classList.toggle("down", hp <= 0);
  };

  const setArt = (token: Token, path: string | null): void => {
    if (path === token.art) return;
    token.art = path;
    if (!path) return;
    void Promise.resolve(host.imageUrl(path)).then((url) => {
      if (!url || token.art !== path) return;
      const image = document.createElement("img");
      image.alt = "";
      image.src = url;
      image.addEventListener("error", () => {
        image.remove();
      });
      token.disc.replaceChildren(image);
    });
  };

  const tokenFor = (actor: Combatant): Token => {
    const existing = tokens.get(actor.id);
    if (existing) return existing;
    const disc = el("div", "dnd-disc", initials(actor.name));
    const bar = el("i", "");
    const hpText = el("span", "dnd-hp");
    const node = el("div", "dnd-token");
    node.append(
      disc,
      el("span", "dnd-name", actor.name),
      el("span", "dnd-bar"),
      hpText,
    );
    node.querySelector(".dnd-bar")?.append(bar);
    node.dataset.side = sideOf(actor);
    node.dataset.id = actor.id;
    field.append(node);
    const token: Token = {
      node,
      disc,
      bar,
      hpText,
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
      field.style.setProperty(
        "--sq",
        `${String(field.clientWidth / grid.width)}px`,
      );
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
      cell.style.left = `${String((square.x / grid.width) * 100)}%`;
      cell.style.top = `${String((square.y / grid.height) * 100)}%`;
      cell.dataset.x = String(square.x);
      cell.dataset.y = String(square.y);
      cells.append(cell);
    }
  };

  // The dashed route to a square the player is pointing at, from where they stand.
  const showRoute = (cell: HTMLElement | null): void => {
    const me = tokens.get(PLAYER_ACTOR);
    const steps = cell?.dataset.path;
    if (!grid || !cell || me?.x == null || me.y === null || !steps) {
      line.setAttribute("points", "");
      return;
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

  // Pointing at an area spell in a menu lights the squares it would cover.
  const showArea = (optionId: string | null): void => {
    blast.replaceChildren();
    if (!grid || !optionId) return;
    const key = optionId.split(SEPARATOR).slice(0, 2).join(SEPARATOR);
    for (const [x, y] of extraOf(latest).areas?.[key] ?? []) {
      const square = el("div", "dnd-blast-square");
      square.style.left = `${String((x / grid.width) * 100)}%`;
      square.style.top = `${String((y / grid.height) * 100)}%`;
      blast.append(square);
    }
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
  });

  const answerCell = (cell: HTMLElement): void => {
    const steps = (cell.dataset.option ?? "").split(" ").filter(Boolean);
    if (steps.length > 0) host.answer(...steps);
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
  const openMenu = (id: string, anchor: HTMLElement): void => {
    const own = id === PLAYER_ACTOR;
    const options = playerOptions().filter((option) => {
      if (SQUARE.test(option.id) || option.id === MOVE) return false;
      const target = option.id.split(SEPARATOR)[1];
      if (target === id || target === `${AIM}${id}`) return true;
      return own && (target === undefined || target === "all");
    });
    if (options.length === 0) {
      closeMenu();
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
    showRoute(cell ?? null);
    showReach(found?.[0] ?? null);
    const name = squareName(cursor.x, cursor.y);
    if (found) {
      const [id, token] = found;
      const who = token.node.querySelector(".dnd-name")?.textContent ?? id;
      said.textContent = `${name}: ${who}, ${String(Math.max(0, token.hp))} of ${String(token.maxHp)} HP.`;
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
      const from = cursor ?? { x: 0, y: 0 };
      placeCursor(from.x + step[0], from.y + step[1]);
      event.preventDefault();
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
    if (update.sceneArt !== sceneArt) {
      sceneArt = update.sceneArt;
      field.style.backgroundImage = "";
      if (sceneArt) {
        const path = sceneArt;
        void Promise.resolve(host.imageUrl(path)).then((url) => {
          if (url && sceneArt === path) {
            field.style.backgroundImage = `url("${url}")`;
          }
        });
      }
    }
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
      setArt(token, update.art[actor.id] ?? null);
      token.maxHp = actor.maxHp;
      if (settle) {
        token.x = actors[actor.id]?.position?.x ?? null;
        token.y = actors[actor.id]?.position?.y ?? null;
        setHp(token, actor.hp);
        token.node.classList.toggle("active", actor.active);
        token.node.dataset.side = sideOf(actor);
        token.node.title = [actor.name, actor.status, ...actor.conditions]
          .filter(Boolean)
          .join(", ");
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
    layout();
    showCells();
    closeMenu();
    slot.hidden = tokens.size === 0 && !playing;
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

  // A d20 that tumbles through numbers before landing on the roll.
  const rollDie = async (
    anchor: HTMLElement,
    natural: number,
    caption: string,
    big: boolean,
  ): Promise<HTMLElement> => {
    const die = el("div", big ? "dnd-die big" : "dnd-die");
    const face = el("span", "", "20");
    die.append(face, el("small", "", caption));
    anchor.append(die);
    if (!fast()) {
      die.animate(
        [
          { transform: "translate(-50%, 0) rotate(-200deg) scale(0.3)" },
          { transform: "translate(-50%, 0) rotate(0) scale(1)" },
        ],
        { duration: 450, easing: "cubic-bezier(.2,1.4,.4,1)" },
      );
      for (let tick = 0; tick < 6 && !fast(); tick += 1) {
        face.textContent = String(1 + Math.floor(Math.random() * 20));
        await wait(55);
      }
    }
    face.textContent = String(natural);
    die.classList.toggle("crit", natural === 20);
    die.classList.toggle("fumble", natural === 1);
    return die;
  };

  const play = async (cue: DndCue): Promise<void> => {
    if (!fast() && host.sound?.() === true) cueSound(cue);
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
          setArt(token, latest?.art[actor.id] ?? null);
        }
        layout();
        slot.hidden = false;
        await showBanner("Roll for initiative!", ms);
        return;
      case "end": {
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
        const from = attacker.node.getBoundingClientRect();
        const to = target.node.getBoundingClientRect();
        const dx = (to.left - from.left) * 0.4;
        const dy = (to.top - from.top) * 0.4;
        animate(
          attacker.node,
          [
            { transform: "translate(-50%, -50%)" },
            {
              transform: `translate(calc(-50% + ${String(dx)}px), calc(-50% + ${String(dy)}px)) scale(1.08)`,
            },
            { transform: "translate(-50%, -50%)" },
          ],
          { duration: 420, easing: "ease-in-out" },
        );
        const die = await rollDie(attacker.node, cue.natural, cue.label, false);
        await wait(180);
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
        await wait(ms - 400);
        die.remove();
        return;
      }
      case "check": {
        slot.hidden = false;
        board.classList.add("checking");
        const die = await rollDie(
          board,
          cue.natural,
          `${cue.label}: ${String(cue.total)} vs DC ${String(cue.dc)}`,
          true,
        );
        die.classList.add(cue.success ? "pass" : "fail");
        await wait(ms - 300);
        die.remove();
        board.classList.remove("checking");
        slot.hidden = tokens.size === 0;
        return;
      }
      case "damage": {
        const token = tokens.get(cue.actor);
        if (!token) return;
        const color = DAMAGE_COLORS[cue.type] ?? "#ff4d4d";
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
    update(update: BoardUpdate): void {
      latest = update;
      sync(update, !playing && update.cues.length === 0);
      queue.push(...(update.cues as DndCue[]));
      if (!playing && queue.length > 0) void run();
    },
  };
}

let styled = false;

// A constructed sheet rather than a <style> element, which the desktop app's content policy blocks.
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(BOARD_CSS);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

const BOARD_CSS = `
.dnd-board {
  position: relative;
  background: #1a1712;
  margin: 12px 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  user-select: none;
}
.dnd-field {
  position: relative;
  height: clamp(260px, 42vw, 380px);
  background-color: #2a2620;
  background-image: radial-gradient(circle at 50% 50%, #3d3528, #1a1712);
  background-size: cover;
  background-position: center;
}
.dnd-field::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgb(0 0 0 / 35%), rgb(0 0 0 / 55%)),
    repeating-linear-gradient(0deg, transparent 0 39px, rgb(255 255 255 / 4%) 39px 40px),
    repeating-linear-gradient(90deg, transparent 0 39px, rgb(255 255 255 / 4%) 39px 40px);
}
.dnd-token {
  --disc: 64px;
  position: absolute;
  transform: translate(-50%, -50%);
  width: var(--disc);
  height: var(--disc);
  transition: left 0.4s ease, top 0.4s ease, filter 0.4s, opacity 0.4s;
  color: #f4efe4;
  font-family: system-ui, sans-serif;
  text-shadow: 0 1px 2px #000;
}
.dnd-disc {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border-radius: 50%;
  overflow: hidden;
  border: 3px solid #4f8fd6;
  background: radial-gradient(circle at 35% 30%, #5b6f8c, #1f2735);
  font-size: 1.3rem;
  font-weight: 700;
  box-shadow: 0 4px 10px rgb(0 0 0 / 60%);
}
.dnd-token[data-side="enemy"] .dnd-disc {
  border-color: #c9473b;
  background: radial-gradient(circle at 35% 30%, #8c5b5b, #351f1f);
}
.dnd-disc img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}
.dnd-token.active .dnd-disc {
  border-color: #ffd36b;
  box-shadow: 0 0 0 3px rgb(255 211 107 / 35%), 0 0 22px 4px rgb(255 211 107 / 55%);
}
.dnd-token.active::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid rgb(255 211 107 / 70%);
  animation: dnd-pulse 1.4s ease-in-out infinite;
  pointer-events: none;
  z-index: -1;
}
@keyframes dnd-pulse { 50% { opacity: 0.3; } }
.dnd-token.down { filter: grayscale(1) brightness(0.6); opacity: 0.7; }
.dnd-token.down .dnd-disc { transform: rotate(-80deg) scale(0.85); transition: transform 0.4s; }
.dnd-name, .dnd-bar, .dnd-hp {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}
.dnd-name { top: calc(100% + 1px); }
.dnd-bar { top: calc(100% + 15px); }
.dnd-hp { top: calc(100% + 22px); white-space: nowrap; }
.gridded .dnd-hp { display: none; }
.gridded .dnd-name { font-size: 0.6rem; }
.gridded .dnd-bar { top: calc(100% + 12px); width: 80%; }
.dnd-name {
  max-width: 92px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.72rem;
  font-weight: 600;
}
.dnd-bar {
  width: 60px;
  height: 6px;
  border-radius: 3px;
  background: rgb(0 0 0 / 55%);
  overflow: hidden;
}
.dnd-bar i {
  display: block;
  height: 100%;
  background: #4cc96a;
  transition: width 0.45s ease, background 0.45s;
}
.dnd-bar i[data-level="mid"] { background: #e3b341; }
.dnd-bar i[data-level="low"] { background: #e0533f; }
.dnd-hp { font-size: 0.65rem; opacity: 0.85; }
.dnd-float {
  position: absolute;
  top: -6px;
  left: 50%;
  transform: translate(-50%, 0);
  font: 800 1.3rem/1 system-ui, sans-serif;
  white-space: nowrap;
  pointer-events: none;
  text-shadow: 0 2px 4px #000, 0 0 8px #000;
  z-index: 3;
}
.dnd-float.damage { color: #ff5a4d; }
.dnd-float.damage.crit { color: #ffd84d; font-size: 1.8rem; }
.dnd-float.heal { color: #6dff9b; }
.dnd-float.hit { color: #ffd36b; font-size: 1rem; }
.dnd-float.miss { color: #d8d4cc; font-size: 1rem; }
.dnd-float.status { color: #c9b3ff; font-size: 0.9rem; text-transform: capitalize; }
.dnd-die {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translate(-50%, 0);
  display: flex;
  flex-direction: column;
  align-items: center;
  z-index: 4;
  pointer-events: none;
}
.dnd-die span {
  display: grid;
  place-items: center;
  width: 40px;
  height: 44px;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: linear-gradient(160deg, #f1e3c4, #b99a62);
  color: #2a1d0b;
  font: 800 1.05rem/1 system-ui, sans-serif;
  text-shadow: none;
}
.dnd-die small {
  margin-top: 2px;
  padding: 0 6px;
  border-radius: 4px;
  background: rgb(0 0 0 / 65%);
  font-size: 0.65rem;
  white-space: nowrap;
}
.dnd-die.crit span { background: linear-gradient(160deg, #fff4b0, #e0a521); box-shadow: 0 0 18px #ffd84d; }
.dnd-die.fumble span { background: linear-gradient(160deg, #e9a0a0, #8c2a2a); color: #fff; }
.dnd-die.big {
  top: 50%;
  bottom: auto;
  transform: translate(-50%, -50%);
}
.dnd-die.big span { width: 96px; height: 106px; font-size: 2.4rem; }
.dnd-die.big small { font-size: 0.85rem; margin-top: 8px; color: #f4efe4; }
.dnd-die.big.pass small { background: #2c6b3a; }
.dnd-die.big.fail small { background: #8c2a2a; }
.dnd-board.checking .dnd-field { min-height: 220px; }
.dnd-banner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 10px 28px;
  border-radius: 10px;
  background: rgb(10 8 6 / 80%);
  border: 1px solid #ffd36b;
  color: #ffd36b;
  font: 700 1.6rem/1.2 Georgia, serif;
  letter-spacing: 0.03em;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  z-index: 5;
}
.dnd-banner.shown { opacity: 1; }
.dnd-hint {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font: 0.7rem system-ui, sans-serif;
  color: rgb(255 255 255 / 55%);
  opacity: 0;
  transition: opacity 0.3s;
}
.dnd-board.playing .dnd-hint { opacity: 1; }
.dnd-board.playing { cursor: pointer; }
.dnd-field.gridded {
  height: auto;
  max-height: 72vh;
  margin: 0 auto;
}
.dnd-field.gridded::before {
  background:
    linear-gradient(rgb(0 0 0 / 30%), rgb(0 0 0 / 45%)),
    linear-gradient(to right, rgb(255 255 255 / 9%) 1px, transparent 1px) 0 0 / calc(100% / var(--cols)) 100%,
    linear-gradient(to bottom, rgb(255 255 255 / 9%) 1px, transparent 1px) 0 0 / 100% calc(100% / var(--rows));
}
.gridded .dnd-token { --disc: calc(var(--sq, 48px) * 0.86); }
.gridded .dnd-disc { font-size: calc(var(--sq, 48px) * 0.3); border-width: 2px; }
.dnd-cells { position: absolute; inset: 0; }
.dnd-cell {
  position: absolute;
  width: calc(100% / var(--cols));
  height: calc(100% / var(--rows));
  box-sizing: border-box;
  background: rgb(255 211 107 / 16%);
  border: 1px solid rgb(255 211 107 / 35%);
  cursor: pointer;
}
.dnd-cell:hover, .dnd-cell.hover { background: rgb(255 211 107 / 45%); }
.dnd-cell.soft {
  background: rgb(255 211 107 / 4%);
  border-color: transparent;
}
.dnd-cell.risky { background: rgb(224 83 63 / 6%); }
.dnd-cell.risky:hover, .dnd-cell.risky.hover { background: rgb(224 83 63 / 40%); }
.dnd-route {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.dnd-route polyline {
  fill: none;
  stroke: #ffd36b;
  stroke-width: 3;
  stroke-dasharray: 6 5;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.dnd-route.risky polyline { stroke: #ff6a55; }
.dnd-blast { position: absolute; inset: 0; pointer-events: none; }
.dnd-blast-square {
  position: absolute;
  width: calc(100% / var(--cols));
  height: calc(100% / var(--rows));
  background: rgb(255 140 60 / 38%);
  box-shadow: inset 0 0 0 1px rgb(255 190 120 / 55%);
}
.dnd-cursor {
  position: absolute;
  display: none;
  width: calc(100% / var(--cols));
  height: calc(100% / var(--rows));
  box-sizing: border-box;
  border: 3px solid #fff;
  border-radius: 4px;
  box-shadow: 0 0 0 2px #000;
  pointer-events: none;
  z-index: 5;
}
.dnd-board:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.dnd-board:focus-visible .gridded .dnd-cursor { display: block; }
.dnd-said {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.dnd-reach {
  position: absolute;
  box-sizing: border-box;
  background: rgb(224 83 63 / 14%);
  border: 2px dashed rgb(224 83 63 / 60%);
  border-radius: 6px;
  pointer-events: none;
}
.dnd-token.dragging {
  z-index: 7;
  pointer-events: none;
  transition: none;
  filter: drop-shadow(0 8px 12px rgb(0 0 0 / 60%));
}
.dnd-board:not(.playing) .dnd-token[data-id="player"] { cursor: grab; touch-action: none; }
.dnd-board:not(.playing) .dnd-token { cursor: pointer; }
.dnd-menu {
  position: absolute;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 200px;
  max-height: 60%;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}
.dnd-menu button {
  min-height: 32px;
  padding: 4px 10px;
  text-align: left;
  font: 0.85rem system-ui, sans-serif;
}
@media (max-width: 520px) {
  .gridded .dnd-name { display: none; }
  .dnd-token { --disc: 48px; }
  .dnd-disc { font-size: 1rem; }
}
`;
