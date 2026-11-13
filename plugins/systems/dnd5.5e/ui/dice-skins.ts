// The dice sets a player can choose, each painted in code: no images to download. The choice is the
// player's own taste, kept in this browser's storage, never in the game or its saves.

export interface Skin {
  readonly id: string;
  readonly name: string;
  readonly paper: readonly [string, string]; // a face's colour at its centre and at its edge
  readonly ink: string;
  readonly outline: string | null; // round each number, so it stands off a busy face
  readonly edge: string;
  readonly glow: string | null; // numbers that shine, even in shade
  readonly pattern: ((face: Painter) => void) | null;
}

// Where one face sits in the texture being painted: its middle, its size and its outline.
export interface Painter {
  readonly g: CanvasRenderingContext2D;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly outline: () => void; // starts a path round the face
}

export const FONT = '"Scaly Sans", Georgia, serif';
const KEY = "re-roll:dice";

// Overlapping scales, rows offset by half a scale, each shaded towards its lower edge.
function scales(face: Painter): void {
  const { g, x, y, size } = face;
  const r = size / 7;
  for (let row = -6; row <= 6; row += 1) {
    for (let column = -6; column <= 6; column += 1) {
      const cx = x + (column + (row % 2 === 0 ? 0 : 0.5)) * r * 1.6;
      const cy = y + row * r * 0.95;
      const shade = g.createRadialGradient(cx, cy - r * 0.4, 0, cx, cy, r);
      shade.addColorStop(0, "rgb(255 200 120 / 30%)");
      shade.addColorStop(1, "rgb(20 8 0 / 45%)");
      g.fillStyle = shade;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI);
      g.fill();
      g.strokeStyle = "rgb(255 205 130 / 60%)";
      g.lineWidth = 2;
      g.stroke();
    }
  }
}

// Faint pale veins through the stone.
function veins(face: Painter): void {
  const { g, x, y, size } = face;
  g.strokeStyle = "rgb(230 255 235 / 22%)";
  for (let line = 0; line < 5; line += 1) {
    g.lineWidth = 1 + Math.random() * 2;
    g.beginPath();
    let px = x - size / 2;
    let py = y + (Math.random() - 0.5) * size;
    g.moveTo(px, py);
    while (px < x + size / 2) {
      px += size / 8;
      py += (Math.random() - 0.5) * size * 0.25;
      g.lineTo(px, py);
    }
    g.stroke();
  }
}

// Stars, and a ring of rune marks round the number.
function arcane(face: Painter): void {
  const { g, x, y, size } = face;
  for (let star = 0; star < 26; star += 1) {
    const sx = x + (Math.random() - 0.5) * size;
    const sy = y + (Math.random() - 0.5) * size;
    g.fillStyle = `rgb(220 230 255 / ${String(30 + Math.random() * 60)}%)`;
    g.beginPath();
    g.arc(sx, sy, Math.random() * 1.6 + 0.4, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "rgb(150 230 255 / 35%)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(x, y, size * 0.3, 0, Math.PI * 2);
  g.stroke();
  for (let mark = 0; mark < 12; mark += 1) {
    const a = (mark / 12) * Math.PI * 2;
    const inner = size * 0.27;
    const outer = size * (mark % 2 === 0 ? 0.36 : 0.33);
    g.beginPath();
    g.moveTo(x + Math.cos(a) * inner, y + Math.sin(a) * inner);
    g.lineTo(x + Math.cos(a) * outer, y + Math.sin(a) * outer);
    g.stroke();
  }
}

const BONE: Skin = {
  id: "bone",
  name: "Bone & ink",
  paper: ["#f7ecd2", "#d9c193"],
  ink: "#2a1d0b",
  outline: null,
  edge: "rgb(110 72 32 / 55%)",
  glow: null,
  pattern: null,
};

export const SKINS: readonly Skin[] = [
  BONE,
  {
    id: "crimson",
    name: "Crimson & gold",
    paper: ["#c9352a", "#6e130c"],
    ink: "#f6cf62",
    outline: "rgb(60 10 0 / 70%)",
    edge: "rgb(40 5 0 / 60%)",
    glow: null,
    pattern: null,
  },
  {
    id: "obsidian",
    name: "Obsidian & silver",
    paper: ["#45454d", "#0e0e12"],
    ink: "#e4e8f0",
    outline: "rgb(0 0 0 / 60%)",
    edge: "rgb(210 215 230 / 35%)",
    glow: null,
    pattern: null,
  },
  {
    id: "jade",
    name: "Jade & white",
    paper: ["#6fb388", "#1f5a3a"],
    ink: "#f6fff8",
    outline: "rgb(10 40 20 / 60%)",
    edge: "rgb(10 40 20 / 50%)",
    glow: null,
    pattern: veins,
  },
  {
    id: "dragon",
    name: "Dragon scale",
    paper: ["#86561f", "#1e0f04"],
    ink: "#ffd36b",
    outline: "rgb(26 8 2 / 90%)",
    edge: "rgb(255 170 90 / 40%)",
    glow: null,
    pattern: scales,
  },
  {
    id: "arcane",
    name: "Arcane",
    paper: ["#4a35a8", "#0c0826"],
    ink: "#a8f4ff",
    outline: null,
    edge: "rgb(150 230 255 / 45%)",
    glow: "#5fe0ff",
    pattern: arcane,
  },
];

export function skinOf(id: string): Skin {
  return SKINS.find((skin) => skin.id === id) ?? BONE;
}

// The player's set. Storage can be blocked, which leaves bone.
export function chosenSkin(): Skin {
  try {
    return skinOf(localStorage.getItem(KEY) ?? "");
  } catch {
    return skinOf("");
  }
}

export function chooseSkin(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not remembered, so the next throw is bone again.
  }
}

// One face's ground: its colour, its pattern clipped to it, and an inked edge.
export function paintGround(skin: Skin, face: Painter): void {
  const { g, x, y, size } = face;
  const [inner, outer] = skin.paper;
  const paper = g.createRadialGradient(x, y, 0, x, y, size * 0.6);
  paper.addColorStop(0, inner);
  paper.addColorStop(1, outer);
  g.fillStyle = paper;
  g.fillRect(x - size / 2, y - size / 2, size, size);
  if (skin.pattern) {
    g.save();
    face.outline();
    g.clip();
    skin.pattern(face);
    g.restore();
  }
  face.outline();
  g.strokeStyle = skin.edge;
  g.lineWidth = 3;
  g.stroke();
}

// A number, centred on (x, y) and turned by `angle`; `mark` underlines it, so a 6 isn't read as a 9.
// `ink` overrides the skin's colour, as the glow layer does.
export function paintNumber(
  skin: Skin,
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  angle: number,
  height: number,
  mark: boolean,
  ink: string = skin.ink,
): void {
  g.save();
  g.font = `bold ${String(Math.round(height))}px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  const box = g.measureText(text);
  g.translate(x, y);
  g.rotate(angle);
  const lift = (box.actualBoundingBoxAscent - box.actualBoundingBoxDescent) / 2;
  if (skin.glow && ink === skin.ink) {
    g.shadowColor = skin.glow;
    g.shadowBlur = height * 0.35;
  }
  if (skin.outline && ink === skin.ink) {
    g.strokeStyle = skin.outline;
    g.lineWidth = height * 0.12;
    g.lineJoin = "round";
    g.strokeText(text, 0, lift);
  }
  g.fillStyle = ink;
  g.fillText(text, 0, lift);
  if (mark) {
    g.fillRect(-box.width / 2, lift + height * 0.1, box.width, height * 0.08);
  }
  g.restore();
}

// A d20's face with a 20 on it, for picking a set.
export function preview(skin: Skin, size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = Math.round(size * scale);
  canvas.style.width = canvas.style.height = `${String(size)}px`;
  const g = canvas.getContext("2d");
  if (!g) return canvas;
  g.scale(scale, scale);
  const r = size * 0.5;
  const x = size / 2;
  const y = size * 0.56;
  const corners = [0, 1, 2].map((k): [number, number] => {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  });
  const outline = (): void => {
    g.beginPath();
    corners.forEach(([px, py], k) => {
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.closePath();
  };
  g.save();
  outline();
  g.clip();
  paintGround(skin, { g, x, y, size, outline });
  g.restore();
  paintNumber(skin, g, "20", x, y + size * 0.04, 0, size * 0.3, false);
  return canvas;
}
