import type {
  BoardUpdate,
  Combatant,
  Face,
  TokenArt,
  Vitals,
} from "./board-data.ts";
import {
  type BoardContext,
  type Token,
  animate,
  el,
  fast,
  still,
} from "./board-context.ts";

// The creatures' tokens: their pictures, HP rings and tooltips, and where they stand.

function faceOf(art: TokenArt): Face | null {
  const face = art.face as Partial<Face> | undefined;
  return typeof face?.x === "number" &&
    typeof face.y === "number" &&
    typeof face.size === "number" &&
    face.size > 0
    ? (face as Face)
    : null;
}

// The combat view says "Enemy" or "Ally", for people to read.
export function sideOf(actor: Combatant): "enemy" | "party" {
  return actor.side.toLowerCase() === "enemy" ? "enemy" : "party";
}

export function artFor(update: BoardUpdate, id: string): TokenArt | null {
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

export function float(
  ctx: BoardContext,
  token: Token,
  text: string,
  className: string,
): void {
  if (fast(ctx)) return;
  // Held still, a float stands above any still showing on the token rather than on top of it.
  const above = `translate(-50%, ${String(-24 - 26 * token.node.querySelectorAll(".dnd-float").length)}px)`;
  const label = el("span", `dnd-float ${className}`, text);
  token.node.append(label);
  label
    .animate(
      still(ctx)
        ? // With reduced motion it stands above the token and fades, without rising.
          [
            { transform: above, opacity: 1 },
            { transform: above, opacity: 1, offset: 0.8 },
            { transform: above, opacity: 0 },
          ]
        : [
            { transform: "translate(-50%, 0) scale(0.6)", opacity: 0 },
            { transform: "translate(-50%, -18px) scale(1.15)", opacity: 1 },
            { transform: "translate(-50%, -46px) scale(1)", opacity: 0 },
          ],
      { duration: 1000, easing: "ease-out" },
    )
    .addEventListener("finish", () => {
      label.remove();
    });
}

export function setTip(token: Token): void {
  token.tip.textContent = [
    token.name,
    `${String(Math.max(0, token.hp))}/${String(token.maxHp)} HP`,
    ...token.notes,
  ].join(" · ");
}

// HP shows as a ring round the disc that empties as the creature is hurt.
export function setHp(token: Token, hp: number): void {
  token.hp = hp;
  const share = token.maxHp > 0 ? Math.max(0, hp) / token.maxHp : 0;
  token.node.style.setProperty("--hp", String(share));
  token.node.dataset.level =
    share > 0.5 ? "high" : share > 0.25 ? "mid" : "low";
  token.node.classList.toggle("down", hp <= 0);
  setTip(token);
}

// A picture fills the token; with a known face, the face fills it instead of the top of the picture.
export function setArt(
  ctx: BoardContext,
  token: Token,
  art: TokenArt | null,
): void {
  const path = art?.path ?? null;
  if (path === token.art) return;
  token.art = path;
  if (!art || !path) return;
  const face = faceOf(art);
  void Promise.resolve(ctx.host.imageUrl(path)).then((url) => {
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
}

export function tokenFor(ctx: BoardContext, actor: Combatant & Vitals): Token {
  const existing = ctx.tokens.get(actor.id);
  if (existing) return existing;
  const disc = el("div", "dnd-disc", initials(actor.name));
  const tip = el("span", "dnd-tip");
  tip.dataset.terms = ""; // the shell explains a condition named here
  const shield = el("span", "dnd-shield");
  shield.hidden = true;
  const node = el("div", "dnd-token");
  node.append(el("span", "dnd-ring"), disc, el("span", "dnd-foe"), tip, shield);
  node.dataset.side = sideOf(actor);
  node.dataset.id = actor.id;
  ctx.field.append(node);
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
  ctx.tokens.set(actor.id, token);
  setHp(token, actor.hp);
  animate(
    ctx,
    node,
    [
      { opacity: 0, transform: "translate(-50%, -50%) scale(0.4)" },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
    ],
    { duration: 350, easing: "ease-out" },
  );
  return token;
}

// On the grid when there is one; otherwise enemies across the top and the party along the bottom.
export function layout(ctx: BoardContext): void {
  if (ctx.grid) {
    const square = ctx.field.clientWidth / ctx.grid.width;
    ctx.field.style.setProperty("--sq", `${String(square)}px`);
    ctx.field.style.aspectRatio = `${String(ctx.grid.width)} / ${String(ctx.grid.height)}`;
    ctx.field.style.setProperty("--cols", String(ctx.grid.width));
    ctx.field.style.setProperty("--rows", String(ctx.grid.height));
  }
  ctx.field.classList.toggle("gridded", ctx.grid !== null);
  const sides = new Map<string, Token[]>();
  for (const token of ctx.tokens.values()) {
    if (ctx.grid && token.x !== null && token.y !== null) {
      token.node.style.left = `${String(((token.x + 0.5) / ctx.grid.width) * 100)}%`;
      token.node.style.top = `${String(((token.y + 0.5) / ctx.grid.height) * 100)}%`;
      // Near an edge, the tooltip opens inwards, clear of the caption and the frame.
      token.node.classList.toggle("high", token.y < 2);
      token.node.classList.toggle("west", token.x < 2);
      token.node.classList.toggle("east", token.x > ctx.grid.width - 3);
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
}

export function tokenAt(
  ctx: BoardContext,
  x: number,
  y: number,
): [string, Token] | undefined {
  return [...ctx.tokens].find(([, token]) => token.x === x && token.y === y);
}
