// Fog of war on a battle map: what the party has seen of the picture, and which foes it sees now.
// The party's side knows only that; monsters, as the DM's side, know everything.
import type { ContentAccess, SystemResult } from "#sdk";
import {
  type Grid,
  type Square,
  coverBetween,
  parseSquare,
  squareKey,
} from "./grid.ts";
import { darkvisionOf, seeing } from "./sight.ts";
import {
  type Actor,
  type DndState,
  NS,
  applyDndEvent,
  dndEvent,
  isDown,
} from "./state.ts";
import { hasTactic } from "./tactics.ts";
import { zonesOf } from "./zones.ts";
import { enemies } from "./combat/queries.ts";
import { walksOf } from "./combat/movement.ts";

type Combat = NonNullable<DndState["combat"]>;

// Cells are counted on the picture's own grid, so fights cropped from one picture share what was seen there.
// The key keeps the cell size, so a crop drawn at another scale starts covered.
interface Lattice {
  readonly key: string;
  readonly dx: number;
  readonly dy: number;
}

function latticeOf(combat: Combat): Lattice | null {
  const { map, grid } = combat;
  if (!map || !grid) return null;
  const width = map.crop.width / grid.width;
  const height = map.crop.height / grid.height;
  return {
    key: `${map.image}@${String(Math.round(width))}x${String(Math.round(height))}`,
    dx: Math.round(map.crop.x / width),
    dy: Math.round(map.crop.y / height),
  };
}

// Whether this fight hides what the party hasn't seen. Older saves' fights, and fights off a battle map, don't.
export function fogged(state: DndState): boolean {
  return Boolean(state.combat?.fog && latticeOf(state.combat));
}

const NO_COVER = { half: new Set<string>(), threeQuarters: new Set<string>() };
const NOBODY: ReadonlySet<string> = new Set();

// The squares in line of sight from `from`, walls and all, found outward from it: a square counts unless it has
// total cover from there, and only open squares lead on. Kept by the map's size and walls, which never change in
// a fight, so a replayed save or a later fight on the same map finds them again.
const MAPS_KEPT = 64;
const lines = new Map<string, Map<string, ReadonlySet<string>>>();
const mapKeys = new WeakMap<object, string>();
function linesOf(combat: Combat, grid: Grid): Map<string, ReadonlySet<string>> {
  const owner = combat.walls ?? grid;
  const key =
    mapKeys.get(owner) ??
    `${String(grid.width)}x${String(grid.height)}:${(combat.walls ?? []).join(";")}`;
  mapKeys.set(owner, key);
  const known = lines.get(key);
  if (known) return known;
  if (lines.size >= MAPS_KEPT) lines.delete(lines.keys().next().value ?? "");
  const made = new Map<string, ReadonlySet<string>>();
  lines.set(key, made);
  return made;
}
function sightFrom(combat: Combat, from: Square): ReadonlySet<string> {
  const grid = combat.grid;
  if (!grid) return NOBODY;
  const byOrigin = linesOf(combat, grid);
  const start = squareKey(from);
  const known = byOrigin.get(start);
  if (known) return known;
  const walls = new Set(combat.walls);
  const seen = new Set([start]);
  const tried = new Set([start]);
  const queue = [from];
  for (let at = queue.pop(); at; at = queue.pop()) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const next = { x: at.x + dx, y: at.y + dy };
        const key = squareKey(next);
        if (
          tried.has(key) ||
          next.x < 0 ||
          next.y < 0 ||
          next.x >= grid.width ||
          next.y >= grid.height
        ) {
          continue;
        }
        tried.add(key);
        if (coverBetween(from, next, walls, NO_COVER, NOBODY) === "total") {
          continue;
        }
        seen.add(key);
        if (!walls.has(key)) queue.push(next);
      }
    }
  }
  byOrigin.set(start, seen);
  return seen;
}

const darkvisions = new WeakMap<Actor, number>();
function darkvisionFor(actor: Actor, access: ContentAccess): number {
  const known = darkvisions.get(actor);
  if (known !== undefined) return known;
  const feet = darkvisionOf(actor, access);
  darkvisions.set(actor, feet);
  return feet;
}

// Whether every square in line of sight is plainly seen: no zone, and nothing marked dim or dark.
function allLit(state: DndState): boolean {
  const terrain = state.combat?.terrain;
  return (
    zonesOf(state).length === 0 &&
    (!terrain ||
      (terrain.light === "bright" &&
        terrain.dim.length === 0 &&
        terrain.dark.length === 0))
  );
}

// The squares `viewer` sees from `at`, by line of sight against walls and then by light, zones and darkvision.
function seenFrom(
  viewer: Actor,
  at: Square,
  state: DndState,
  access: ContentAccess,
): readonly string[] {
  const combat = state.combat;
  if (!combat) return [];
  const sight = sightFrom(combat, at);
  if (allLit(state)) return [...sight];
  const standing = { ...viewer, position: at };
  const feet = darkvisionFor(viewer, access);
  return [...sight].filter((key) => {
    const square = parseSquare(key);
    return seeing(standing, square, state, access, feet) !== "none";
  });
}

function partyViewers(state: DndState): readonly Actor[] {
  return Object.values(state.actors).filter(
    (actor) => actor.side === "party" && actor.position && !isDown(actor),
  );
}

export interface PartySight {
  readonly squares: ReadonlySet<string>; // seen now, as "x,y"
  readonly foes: ReadonlySet<string>; // foes seen now, by id
}

const sights = new WeakMap<DndState, PartySight>();
// What the party sees right now, whether or not the fight has fog.
export function partySight(state: DndState, access: ContentAccess): PartySight {
  const known = sights.get(state);
  if (known) return known;
  const viewers = partyViewers(state);
  const squares = new Set<string>();
  for (const viewer of viewers) {
    if (!viewer.position) continue;
    for (const key of seenFrom(viewer, viewer.position, state, access)) {
      squares.add(key);
    }
  }
  // The search outward can miss a square the sight rules' own line reaches, such as one along the map's edge,
  // so a foe is also in view when a line runs between it and a party member either way: what can aim at the
  // party, or be aimed at, is seen.
  const walls = new Set(state.combat?.walls);
  const inView = (at: Square): boolean =>
    viewers.some(
      (viewer) =>
        viewer.position !== null &&
        (coverBetween(viewer.position, at, walls, NO_COVER, NOBODY) !==
          "total" ||
          coverBetween(at, viewer.position, walls, NO_COVER, NOBODY) !==
            "total") &&
        seeing(viewer, at, state, access, darkvisionFor(viewer, access)) !==
          "none",
    );
  const foes = new Set<string>();
  for (const actor of Object.values(state.actors)) {
    // A foe that has hidden isn't seen, even where its square is.
    if (actor.side === "party" || !actor.position) continue;
    if (hasTactic(actor, "hidden")) continue;
    const key = squareKey(actor.position);
    if (squares.has(key) || inView(actor.position)) {
      foes.add(actor.id);
      squares.add(key);
    }
  }
  const sight = { squares, foes };
  sights.set(state, sight);
  return sight;
}

// Whether `viewer`'s side knows where `target` is: monsters always do, and the party knows itself and the foes it sees.
export function knows(
  state: DndState,
  viewer: Actor,
  target: Actor,
  access: ContentAccess,
): boolean {
  return (
    viewer.side !== "party" ||
    target.side === "party" ||
    !fogged(state) ||
    partySight(state, access).foes.has(target.id)
  );
}

// The foes `actor`'s side knows of: for the party in fog, only the ones it sees now.
export function knownFoes(
  state: DndState,
  actor: Actor,
  access: ContentAccess,
): readonly Actor[] {
  const foes = enemies(state, actor);
  if (actor.side !== "party" || !fogged(state)) return foes;
  const seen = partySight(state, access).foes;
  return foes.filter((foe) => seen.has(foe.id));
}

const revealedSets = new WeakMap<readonly string[], ReadonlySet<string>>();
// The squares of this fight the party has ever seen, as "x,y" on the fight's grid. Null with no fog: all of it.
export function revealedSquares(state: DndState): ReadonlySet<string> | null {
  const combat = state.combat;
  const lattice = combat && fogged(state) ? latticeOf(combat) : null;
  if (!combat || !lattice) return null;
  const cells = state.revealed?.[lattice.key] ?? [];
  const known = revealedSets.get(cells);
  if (known) return known;
  const { width = 0, height = 0 } = combat.grid ?? {};
  const squares = new Set(
    cells.flatMap((cell) => {
      const square = parseSquare(cell);
      if (!square) return [];
      const x = square.x - lattice.dx;
      const y = square.y - lattice.dy;
      return x >= 0 && y >= 0 && x < width && y < height
        ? [squareKey({ x, y })]
        : [];
    }),
  );
  revealedSets.set(cells, squares);
  return squares;
}

// A step's result with the squares the party sees for the first time once its events land, as one more event.
// A walk shows what the party passes on the way, not only where it stops.
export function withReveal(
  result: SystemResult,
  context: ContentAccess & { readonly state: DndState },
): SystemResult {
  const events = result.events ?? [];
  const before = context.state;
  const starts = events.some((event) => event.kind === `${NS}:combatStarted`);
  if (events.length === 0 || (!before.combat?.fog && !starts)) return result;
  const after = events.reduce(applyDndEvent, before);
  const combat = after.combat;
  const lattice = combat && fogged(after) ? latticeOf(combat) : null;
  if (!combat || !lattice) return result;
  const seen = new Set(partySight(after, context).squares);
  for (const event of events) {
    if (event.kind !== `${NS}:moved`) continue;
    const {
      actor: id,
      to,
      feet,
    } = event.payload as {
      actor: string;
      to: Square;
      feet: number;
    };
    const walker = before.actors[id];
    const moved = after.actors[id];
    if (!walker || !moved || walker.side !== "party" || feet <= 0) continue;
    const path = walksOf(walker, before, context).get(squareKey(to)) ?? [];
    for (const square of path) {
      for (const key of seenFrom(moved, square, after, context)) seen.add(key);
    }
  }
  const known = new Set(after.revealed?.[lattice.key] ?? []);
  const cells = [...seen].flatMap((key) => {
    const square = parseSquare(key);
    const cell = square
      ? squareKey({ x: square.x + lattice.dx, y: square.y + lattice.dy })
      : null;
    return cell && !known.has(cell) ? [cell] : [];
  });
  return cells.length === 0
    ? result
    : {
        ...result,
        events: [
          ...events,
          dndEvent(`${NS}:squaresSeen`, { map: lattice.key, cells }),
        ],
      };
}

// Whether `id` is a foe of the party it can't see now, which the board, the turn order and the journal leave out.
export function unseenFoe(
  state: DndState,
  id: string,
  access: ContentAccess,
): boolean {
  const actor = state.actors[id];
  return (
    actor !== undefined &&
    actor.side !== "party" &&
    fogged(state) &&
    !partySight(state, access).foes.has(id)
  );
}
