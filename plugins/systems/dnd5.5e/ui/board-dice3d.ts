import {
  AmbientLight,
  type BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Sides } from "./board-math.ts";
import {
  type Shape,
  cellPoint,
  geometryOf,
  gridOf,
  restingTurn,
  shapeOf,
} from "./dice-shapes.ts";

// Dice drawn in 3D on one WebGL canvas laid over the board. Each die tumbles to the face the engine
// already rolled: Math.random only picks the spin, never the number. Loaded on the first throw, so the
// game's first page doesn't wait for three.js.

interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Cast {
  readonly sides: Sides;
  readonly value: number;
  readonly from: Point;
  readonly to: Point;
}

interface Die {
  readonly anchor: HTMLElement; // the die lives as long as this element stays on the page
  readonly mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  readonly shadow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly glow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly shape: Shape;
  readonly size: number; // across, in the board's pixels
  from: Point;
  to: Point;
  start: number;
  ms: number;
  held: boolean; // in the hand, waiting to be thrown
  spin: number; // how fast it turns in the hand, in radians a millisecond
  axis: Vector3;
  angle: number;
  lead: Quaternion; // where the spin starts from, so the die turns smoothly into the throw
  rest: Quaternion;
}

const CELL = 128;
const FONT = '"Scaly Sans", Georgia, serif';
const INK = "#2a1d0b";
const GOLD = new Color("#ffd24d");
const BLOOD = new Color("#e0503c");
const WHITE = new Color("#ffffff");
const CRIT_TINT = new Color("#f6cf62");
const FUMBLE_TINT = new Color("#d98473");

let stage: {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  readonly blot: CanvasTexture; // a soft round spot, for shadows and glows
  readonly plane: PlaneGeometry;
} | null = null;
let starting: Promise<boolean> | null = null;
let frame = 0;
const dice: Die[] = [];
const looks = new Map<
  Sides,
  { readonly geometry: BufferGeometry; readonly texture: CanvasTexture }
>();

function webgl(): boolean {
  try {
    const probe = document.createElement("canvas");
    const context = probe.getContext("webgl2") ?? probe.getContext("webgl");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

// Whether 3D dice can be drawn here. Checks WebGL first, since three.js logs an error when it can't start.
export function ready(): Promise<boolean> {
  starting ??= (async () => {
    if (!webgl()) return false;
    // The numbers are painted once per die, so the font has to be there first.
    await document.fonts.load(`bold 64px ${FONT}`).catch(() => []);
    try {
      const canvas = document.createElement("canvas");
      canvas.className = "dnd-dice-layer";
      canvas.setAttribute("aria-hidden", "true");
      const renderer = new WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
      });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      const scene = new Scene();
      scene.add(new AmbientLight(0xffffff, 1.5));
      const sun = new DirectionalLight(0xffffff, 2.2);
      sun.position.set(-0.6, 0.9, 1);
      scene.add(sun);
      const camera = new OrthographicCamera(0, 1, 0, -1, -1000, 1000);
      camera.position.z = 500;
      stage = {
        renderer,
        scene,
        camera,
        blot: blot(),
        plane: new PlaneGeometry(1, 1),
      };
      return true;
    } catch {
      return false;
    }
  })();
  return starting;
}

function blot(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d");
  if (g) {
    const fade = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    fade.addColorStop(0, "rgb(255 255 255 / 100%)");
    fade.addColorStop(1, "rgb(255 255 255 / 0%)");
    g.fillStyle = fade;
    g.fillRect(0, 0, 64, 64);
  }
  return new CanvasTexture(canvas);
}

// A die's faces painted on one texture: parchment, an inked edge and its numbers.
function lookOf(sides: Sides): {
  geometry: BufferGeometry;
  texture: CanvasTexture;
} {
  const known = looks.get(sides);
  if (known) return known;
  const shape = shapeOf(sides);
  const { columns, rows } = gridOf(shape);
  const canvas = document.createElement("canvas");
  canvas.width = columns * CELL;
  canvas.height = rows * CELL;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No 2D canvas for the dice");
  const at = (i: number, x: number, y: number): [number, number] => {
    const [u, v] = cellPoint(i, columns, rows, x, y);
    return [u * canvas.width, (1 - v) * canvas.height];
  };
  shape.faces.forEach((face, i) => {
    const [cx, cy] = at(i, 0, 0);
    const paper = g.createRadialGradient(cx, cy, 0, cx, cy, CELL * 0.6);
    paper.addColorStop(0, "#f7ecd2");
    paper.addColorStop(1, "#d9c193");
    g.fillStyle = paper;
    g.fillRect(cx - CELL / 2, cy - CELL / 2, CELL, CELL);
    g.beginPath();
    face.points.forEach(([x, y], k) => {
      const [px, py] = at(i, x * 0.92, y * 0.92);
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.closePath();
    g.strokeStyle = "rgb(110 72 32 / 55%)";
    g.lineWidth = 3;
    g.stroke();
    const height = Math.round(CELL * shape.font);
    g.font = `bold ${String(height)}px ${FONT}`;
    g.fillStyle = INK;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    for (const label of face.labels) {
      const [px, py] = at(i, label.x, label.y);
      const box = g.measureText(label.text);
      g.save();
      g.translate(px, py);
      g.rotate(label.angle);
      const lift =
        (box.actualBoundingBoxAscent - box.actualBoundingBoxDescent) / 2;
      g.fillText(label.text, 0, lift);
      if (label.mark) {
        g.fillRect(
          -box.width / 2,
          lift + height * 0.1,
          box.width,
          height * 0.08,
        );
      }
      g.restore();
    }
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  if (stage)
    texture.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();
  const look = { geometry: geometryOf(shape), texture };
  looks.set(sides, look);
  return look;
}

// The canvas covers the board it's throwing on, sized to it now, since a check makes the board taller.
function fit(board: HTMLElement): void {
  if (!stage) return;
  const { renderer, camera } = stage;
  const canvas = renderer.domElement;
  if (canvas.parentElement !== board) board.append(canvas);
  const width = Math.max(1, board.clientWidth);
  const height = Math.max(1, board.clientHeight);
  if (camera.right !== width || camera.bottom !== -height) {
    renderer.setSize(width, height, false);
    camera.right = width;
    camera.bottom = -height;
    camera.updateProjectionMatrix();
  }
}

function randomAxis(from: Point, to: Point): Vector3 {
  // A die rolls about the line across its path, with a wobble.
  const along = new Vector3(to.x - from.x, from.y - to.y, 0);
  const axis =
    along.lengthSq() > 1
      ? new Vector3(-along.y, along.x, 0).normalize()
      : new Vector3(1, 0, 0);
  return axis
    .add(
      new Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5,
      ).multiplyScalar(0.8),
    )
    .normalize();
}

function randomTurn(): Quaternion {
  return new Quaternion().random().normalize();
}

function add(
  anchor: HTMLElement,
  sides: Sides,
  value: number,
  at: Point,
  size: number,
): Die | null {
  if (!stage) return null;
  const { scene, plane, blot: spotTexture } = stage;
  const { geometry, texture } = lookOf(sides);
  const shape = shapeOf(sides);
  const mesh = new Mesh(
    geometry,
    new MeshLambertMaterial({ map: texture, transparent: true }),
  );
  const spot = (color: Color): Mesh<PlaneGeometry, MeshBasicMaterial> =>
    new Mesh(
      plane,
      new MeshBasicMaterial({
        map: spotTexture,
        color,
        transparent: true,
        depthWrite: false,
      }),
    );
  const shadow = spot(new Color("#1a0f05"));
  const glow = spot(GOLD);
  glow.visible = false;
  scene.add(glow, shadow, mesh);
  const die: Die = {
    anchor,
    mesh,
    shadow,
    glow,
    shape,
    size,
    from: at,
    to: at,
    start: performance.now(),
    ms: 0,
    held: false,
    spin: 0,
    axis: new Vector3(1, 0, 0),
    angle: 0,
    lead: new Quaternion(),
    rest: restingTurn(shape, value),
  };
  dice.push(die);
  return die;
}

// A die in the hand at `at`, until cast throws it. It spins unless `calm`, and shows no rolled number yet.
export function hold(
  board: HTMLElement,
  anchor: HTMLElement,
  sides: Sides,
  at: Point,
  size: number,
  calm: boolean,
): Die | null {
  fit(board);
  const die = add(anchor, sides, 1, at, size);
  if (!die) return null;
  die.held = true;
  die.spin = calm ? 0 : 0.004;
  die.axis = randomAxis(at, at);
  die.lead = randomTurn();
  schedule();
  return die;
}

// Throws dice from where each starts to where it lands, settling `ms` later on its number. With ms 0 they
// are simply there, at rest. A die from hold() is thrown from the hand rather than made anew.
export function cast(
  board: HTMLElement,
  anchor: HTMLElement,
  casts: readonly Cast[],
  size: number,
  ms: number,
  held: Die | null = null,
): void {
  fit(board);
  const now = performance.now();
  casts.forEach((roll, i) => {
    const die =
      i === 0 && held && dice.includes(held)
        ? held
        : add(anchor, roll.sides, roll.value, roll.from, size);
    if (!die) return;
    const lead = die.held ? pose(die, now) : randomTurn();
    die.held = false;
    die.rest = restingTurn(die.shape, roll.value);
    die.from = roll.from;
    die.to = roll.to;
    die.start = now;
    die.ms = ms;
    die.axis = randomAxis(roll.from, roll.to);
    die.angle = Math.PI * (3 + Math.random() * 2) * (ms / 1000);
    // Spins back from the rest, so the die starts at `lead` and the spin unwinds onto the rolled face.
    die.lead = new Quaternion()
      .setFromAxisAngle(die.axis, -die.angle)
      .multiply(lead);
  });
  schedule();
}

// Puts the anchor's dice at rest now, as when the player skips ahead.
export function settle(anchor: HTMLElement): void {
  for (const die of dice) {
    if (die.anchor === anchor) die.start = -Infinity;
  }
  schedule();
}

// How high a die is in the hand.
const HAND = 0.6;
const RISE = Math.asin(HAND) / Math.PI;

// How high a thrown die is over the table: up from the hand to 1, then down through two bounces to 0 at rest.
function hop(t: number): number {
  if (t < 0.42) return Math.sin(Math.PI * (RISE + (1 - RISE) * (t / 0.42)));
  if (t < 0.72) return 0.32 * Math.sin((Math.PI * (t - 0.42)) / 0.3);
  if (t < 0.88) return 0.09 * Math.sin((Math.PI * (t - 0.72)) / 0.16);
  return 0;
}

// Places a die for the moment `now`, and returns how it's turned.
function pose(die: Die, now: number): Quaternion {
  const turn = new Quaternion();
  let x = die.to.x;
  let y = die.to.y;
  let height = 0;
  if (die.held) {
    height = HAND;
    turn
      .setFromAxisAngle(die.axis, (now - die.start) * die.spin)
      .multiply(die.lead);
  } else {
    const t =
      die.ms > 0 ? Math.min(1, Math.max(0, (now - die.start) / die.ms)) : 1;
    const glide = 1 - (1 - t) ** 2;
    const unwind = 1 - (1 - t) ** 3;
    x = die.from.x + (die.to.x - die.from.x) * glide;
    y = die.from.y + (die.to.y - die.from.y) * glide;
    height = hop(t);
    turn
      .setFromAxisAngle(die.axis, die.angle * (1 - unwind))
      .multiply(die.lead.clone().slerp(die.rest, unwind));
    if (die.ms <= 0 || t >= 1) turn.copy(die.rest);
  }
  const lift = height * die.size * 0.9;
  const fade = Number(getComputedStyle(die.anchor).opacity) || 0;
  const radius = (die.size / 2) * die.shape.size;
  die.mesh.position.set(x, -(y - lift), 0);
  die.mesh.scale.setScalar(radius * (1 + 0.25 * height));
  die.mesh.quaternion.copy(turn);
  die.mesh.material.opacity = fade;
  const crit = die.anchor.classList.contains("crit");
  const fumble = die.anchor.classList.contains("fumble");
  die.mesh.material.color.copy(crit ? CRIT_TINT : fumble ? FUMBLE_TINT : WHITE);
  die.shadow.position.set(
    x + die.size * 0.12,
    -(y + die.size * 0.28),
    -die.size * 2,
  );
  die.shadow.scale.setScalar(die.size * 1.15 * (1 - 0.35 * height));
  die.shadow.material.opacity = 0.5 * (1 - 0.5 * height) * fade;
  die.glow.visible = crit || fumble;
  die.glow.material.color.copy(crit ? GOLD : BLOOD);
  die.glow.position.set(x, -y, -die.size * 2.5);
  die.glow.scale.setScalar(die.size * (2.1 + 0.15 * Math.sin(now / 160)));
  die.glow.material.opacity = 0.85 * fade;
  return turn;
}

function drop(die: Die): void {
  dice.splice(dice.indexOf(die), 1);
  stage?.scene.remove(die.mesh, die.shadow, die.glow);
  // The shape's geometry and texture are kept for the next throw; only this die's own materials go.
  die.mesh.material.dispose();
  die.shadow.material.dispose();
  die.glow.material.dispose();
}

function schedule(): void {
  if (frame === 0) frame = requestAnimationFrame(paint);
}

// Draws every die each frame while any is on the board, and once more to clear the canvas after the last.
function paint(): void {
  frame = 0;
  if (!stage) return;
  for (const die of [...dice]) {
    if (!die.anchor.isConnected) drop(die);
  }
  const now = performance.now();
  for (const die of dice) pose(die, now);
  stage.renderer.render(stage.scene, stage.camera);
  if (dice.length > 0) schedule();
}
