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
// and can't stop where anyone else stands. Entering a square of difficult terrain costs double.
export function reachableSquares(
  start: Square,
  feet: number,
  grid: Grid,
  blocked: ReadonlySet<string>,
  occupied: ReadonlySet<string>,
  difficult: ReadonlySet<string> = new Set(),
): readonly {
  readonly square: Square;
  readonly feet: number;
  readonly path: readonly Square[]; // the squares walked through, ending on this one
}[] {
  // Cheapest first, from one bucket per 5 feet spent, since a square costs 5 or 10 feet.
  const cost = new Map<string, number>([[squareKey(start), 0]]);
  const from = new Map<string, Square>();
  const buckets: Square[][] = [[start]];
  for (let bucket = 0; bucket < buckets.length; bucket += 1) {
    for (const next of buckets[bucket] ?? []) {
      const spent = bucket * SQUARE_FEET;
      if (cost.get(squareKey(next)) !== spent) continue; // reached more cheaply since
      visit(next, spent);
    }
  }
  function visit(next: Square, spent: number): void {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const square = { x: next.x + dx, y: next.y + dy };
        const key = squareKey(square);
        const step = difficult.has(key) ? SQUARE_FEET * 2 : SQUARE_FEET;
        if (
          (dx === 0 && dy === 0) ||
          square.x < 0 ||
          square.y < 0 ||
          square.x >= grid.width ||
          square.y >= grid.height ||
          blocked.has(key) ||
          spent + step > feet ||
          spent + step >= (cost.get(key) ?? Infinity)
        ) {
          continue;
        }
        cost.set(key, spent + step);
        from.set(key, next);
        const bucket = (spent + step) / SQUARE_FEET;
        while (buckets.length <= bucket) buckets.push([]);
        buckets[bucket]?.push(square);
      }
    }
  }
  return [...cost]
    .filter(([key, spent]) => spent > 0 && !occupied.has(key))
    .flatMap(([key, spent]) => {
      const square = parseSquare(key);
      if (!square) return [];
      const path: Square[] = [];
      for (
        let at: Square | undefined = square;
        at;
        at = from.get(squareKey(at))
      ) {
        path.unshift(at);
      }
      return [{ square, feet: spent, path: path.slice(1) }];
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

// The squares of a battle map marked with one code, from one string per row.
// "#" is a wall, "~" difficult terrain, "h" half cover, "t" three-quarters cover, "d" dim light,
// "x" darkness, and anything else is open, bright ground.
// shortcut: a square holds one code, so dark rubble can't be written; give a square two codes when a map needs it.
export function codeKeys(rows: readonly string[], code: string): string[] {
  return rows.flatMap((row, y) =>
    row
      .split("") // map rows are plain ASCII
      .flatMap((cell, x) => (cell === code ? [squareKey({ x, y })] : [])),
  );
}

export function wallKeys(rows: readonly string[]): readonly string[] {
  return codeKeys(rows, "#");
}

export type Cover = 0 | 2 | 5 | "total";

// Whether the segment from (ax, ay) to (bx, by) passes through the inside of square (sx, sy), not just along
// an edge or through a corner. Clipped to the square's box, then its middle must be strictly inside.
function crosses(
  [ax, ay]: readonly [number, number],
  [bx, by]: readonly [number, number],
  { x: sx, y: sy }: Square,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let enter = 0;
  let leave = 1;
  for (const [p, q] of [
    [-dx, ax - sx],
    [dx, sx + 1 - ax],
    [-dy, ay - sy],
    [dy, sy + 1 - ay],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
  }
  if (leave - enter < 1e-9) return false;
  const mx = ax + (dx * (enter + leave)) / 2;
  const my = ay + (dy * (enter + leave)) / 2;
  const inside = (value: number, low: number): boolean =>
    value > low + 1e-9 && value < low + 1 - 1e-9;
  return inside(mx, sx) && inside(my, sy);
}

// Whether a segment passes through the inside of any of these squares.
function crossesAny(
  from: readonly [number, number],
  to: readonly [number, number],
  squares: readonly Square[],
): boolean {
  return squares.some((square) => crosses(from, to, square));
}

// Whether a segment along a grid line runs between two wall squares, which is inside the wall too.
function alongWalls(
  [ax, ay]: readonly [number, number],
  [bx, by]: readonly [number, number],
  walls: ReadonlySet<string>,
): boolean {
  const run = (
    line: number,
    start: number,
    end: number,
    square: (along: number, side: number) => Square,
  ): boolean => {
    if (!Number.isInteger(line)) return false;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    for (let along = Math.floor(low); along < high; along += 1) {
      const overlap = Math.min(along + 1, high) - Math.max(along, low);
      if (
        overlap > 1e-9 &&
        walls.has(squareKey(square(along, line - 1))) &&
        walls.has(squareKey(square(along, line)))
      ) {
        return true;
      }
    }
    return false;
  };
  if (ay === by) return run(ay, ax, bx, (x, y) => ({ x, y }));
  if (ax === bx) return run(ax, ay, by, (y, x) => ({ x, y }));
  return false;
}

// The cover a target at `to` has against something coming from `from`, as on the DMG's grid: lines from the
// attacker's best corner to the target square's four corners, where each one through a wall is blocked.
// One or two blocked is half cover, three is three-quarters, four is total. Cover squares and creatures
// standing between the two (not on either end) give at least their own cover; a creature gives half.
export function coverBetween(
  from: Square | null,
  to: Square | null,
  walls: ReadonlySet<string>,
  cover: {
    readonly half: ReadonlySet<string>;
    readonly threeQuarters: ReadonlySet<string>;
  },
  creatures: ReadonlySet<string>,
): Cover {
  if (!from || !to) return 0;
  // Only squares in the box the two span, other than the two themselves, can be in the way.
  const box: Square[] = [];
  for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y += 1) {
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x += 1) {
      if ((x !== from.x || y !== from.y) && (x !== to.x || y !== to.y)) {
        box.push({ x, y });
      }
    }
  }
  const near = (keys: ReadonlySet<string>): Square[] =>
    keys.size === 0 ? [] : box.filter((square) => keys.has(squareKey(square)));
  const corners = (square: Square): (readonly [number, number])[] =>
    [0, 1].flatMap((dx) =>
      [0, 1].map((dy) => [square.x + dx, square.y + dy] as const),
    );
  const nearWalls = near(walls);
  const blocked =
    nearWalls.length === 0
      ? 0
      : Math.min(
          ...corners(from).map(
            (corner) =>
              corners(to).filter(
                (target) =>
                  crossesAny(corner, target, nearWalls) ||
                  alongWalls(corner, target, walls),
              ).length,
          ),
        );
  if (blocked >= 4) return "total";
  const middle = (square: Square): readonly [number, number] => [
    square.x + 0.5,
    square.y + 0.5,
  ];
  const between = (keys: ReadonlySet<string>): boolean =>
    crossesAny(middle(from), middle(to), near(keys));
  const fromWalls = blocked === 3 ? 5 : blocked > 0 ? 2 : 0;
  const fromSquares = between(cover.threeQuarters)
    ? 5
    : between(cover.half) || between(creatures)
      ? 2
      : 0;
  return Math.max(fromWalls, fromSquares) as 0 | 2 | 5;
}

// Puts each creature on its listed square, and any extra on the nearest open square to the last one listed.
export function placeOnMap(
  ids: readonly string[],
  starts: readonly Square[],
  grid: Grid,
  taken: Set<string>,
): Record<string, Square> {
  const positions: Record<string, Square> = {};
  for (const [index, id] of ids.entries()) {
    const listed = starts[index];
    const square =
      listed && !taken.has(squareKey(listed))
        ? listed
        : nearestOpen(starts.at(-1) ?? { x: 0, y: 0 }, grid, taken);
    if (!square) continue; // shortcut: a creature with no room left stays off the map, and can reach everyone
    positions[id] = square;
    taken.add(squareKey(square));
  }
  return positions;
}

function nearestOpen(
  from: Square,
  grid: Grid,
  taken: ReadonlySet<string>,
): Square | null {
  const seen = new Set([squareKey(from)]);
  const queue = [from];
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (!taken.has(squareKey(next))) return next;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const square = { x: next.x + dx, y: next.y + dy };
        const key = squareKey(square);
        if (
          square.x < 0 ||
          square.y < 0 ||
          square.x >= grid.width ||
          square.y >= grid.height ||
          seen.has(key)
        ) {
          continue;
        }
        seen.add(key);
        queue.push(square);
      }
    }
  }
  return null;
}
