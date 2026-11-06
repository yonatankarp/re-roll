// The 5-foot grid. Each square costs 5 feet, diagonals too, as the SRD's grid rules allow.
// A creature with no square, as in a save from before the grid, is within reach of everyone.

export interface Square {
  readonly x: number;
  readonly y: number;
}

export interface Grid {
  readonly width: number;
  readonly height: number;
}

export const SQUARE_FEET = 5;
const ROWS_APART = 6; // 30 feet between the sides when a fight starts

export function squareKey(square: Square): string {
  return `${String(square.x)},${String(square.y)}`;
}

export function parseSquare(key: string): Square | null {
  const match = /^(\d+),(\d+)$/.exec(key);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

export function distanceFeet(a: Square | null, b: Square | null): number {
  if (!a || !b) return 0;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * SQUARE_FEET;
}

// "touch" is 5 feet, and "self" reaches only the creature itself.
export function rangeFeet(range: number | "touch" | "self"): number {
  if (range === "touch") return SQUARE_FEET;
  if (range === "self") return 0;
  return range;
}

// The party along the bottom and the enemies along the top, each side centred, two squares between neighbours.
export function placeSides(
  party: readonly string[],
  enemies: readonly string[],
): { readonly grid: Grid; readonly positions: Record<string, Square> } {
  const perRow = 6;
  const rowsOf = (count: number): number =>
    Math.max(1, Math.ceil(count / perRow));
  const widest = Math.min(perRow, Math.max(party.length, enemies.length, 1));
  const width = Math.max(10, widest * 2 + 2);
  const enemyRows = rowsOf(enemies.length);
  const partyRows = rowsOf(party.length);
  const height = 1 + enemyRows + ROWS_APART - 1 + partyRows + 1;
  const positions: Record<string, Square> = {};
  const place = (ids: readonly string[], firstRow: number, step: 1 | -1) => {
    ids.forEach((id, index) => {
      const row = Math.floor(index / perRow);
      const inRow = Math.min(perRow, ids.length - row * perRow);
      const column = index % perRow;
      const left = Math.floor((width - (inRow * 2 - 1)) / 2);
      positions[id] = { x: left + column * 2, y: firstRow + row * step };
    });
  };
  place(enemies, enemyRows, -1);
  place(party, enemyRows + ROWS_APART, 1);
  return { grid: { width, height }, positions };
}

// Every square a creature can end its move on, with what it costs. It can pass allies but not enemies,
// and can't stop where anyone else stands.
export function reachableSquares(
  start: Square,
  feet: number,
  grid: Grid,
  blocked: ReadonlySet<string>,
  occupied: ReadonlySet<string>,
): readonly { readonly square: Square; readonly feet: number }[] {
  const cost = new Map<string, number>([[squareKey(start), 0]]);
  const queue: Square[] = [start];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const spent = cost.get(squareKey(next)) ?? 0;
    if (spent + SQUARE_FEET > feet) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const square = { x: next.x + dx, y: next.y + dy };
        const key = squareKey(square);
        if (
          (dx === 0 && dy === 0) ||
          square.x < 0 ||
          square.y < 0 ||
          square.x >= grid.width ||
          square.y >= grid.height ||
          blocked.has(key) ||
          cost.has(key)
        ) {
          continue;
        }
        cost.set(key, spent + SQUARE_FEET);
        queue.push(square);
      }
    }
  }
  return [...cost]
    .filter(([key, spent]) => spent > 0 && !occupied.has(key))
    .flatMap(([key, spent]) => {
      const square = parseSquare(key);
      return square ? [{ square, feet: spent }] : [];
    });
}

export type AreaShape = "sphere" | "cone" | "cube" | "line" | "emanation";

// Whether a square is caught by an area cast from `origin` and aimed at `aim`.
// Spheres and cubes centre on the aim, emanations on the caster, and cones and lines point at the aim.
export function inArea(
  shape: AreaShape,
  size: number,
  origin: Square | null,
  aim: Square | null,
  point: Square | null,
): boolean {
  if (!origin || !aim || !point) return true;
  switch (shape) {
    case "sphere":
      return distanceFeet(aim, point) <= size;
    case "cube":
      return distanceFeet(aim, point) <= Math.max(SQUARE_FEET, size / 2);
    case "emanation":
      return distanceFeet(origin, point) <= size;
    case "cone":
    case "line": {
      const ax = aim.x - origin.x;
      const ay = aim.y - origin.y;
      const px = point.x - origin.x;
      const py = point.y - origin.y;
      const length = Math.hypot(ax, ay);
      if (length === 0 || (px === 0 && py === 0)) return false;
      const along = (px * ax + py * ay) / length; // in squares
      const across = Math.abs(px * ay - py * ax) / length;
      if (along <= 0 || along * SQUARE_FEET > size + SQUARE_FEET / 2) {
        return false;
      }
      // A cone is as wide as it is far from its point; a line is one square wide.
      return shape === "cone" ? across <= along / 2 + 0.5 : across <= 0.75;
    }
  }
}
