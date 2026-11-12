import {
  type Grid,
  type Square,
  distanceFeet,
  inArea,
  rangeFeet,
} from "./grid.ts";
import type { Targeting } from "./schemas.ts";
import { type Actor, isDown } from "./state.ts";

// Choosing a spell's targets and aiming its area, as follow-up decisions after the turn's choice.
// Pure: no rolls and no content, so the board can use the same geometry as the rules.

export const PICK = "pick"; // a turn option's target: choose the targets one at a time
export const AIM_AREA = "aim"; // a turn option's target: aim the area at a square
export const ADD = "+"; // a pick option: "+" and a creature's id
export const REMOVE = "-";
export const CONFIRM = "cast";
export const BACK = "back";

export type AreaTargeting = Extract<Targeting, { readonly area: unknown }>;

const DIRECTIONS: readonly (readonly [number, number, string])[] = [
  [0, -1, "North"],
  [1, -1, "North-east"],
  [1, 0, "East"],
  [1, 1, "South-east"],
  [0, 1, "South"],
  [-1, 1, "South-west"],
  [-1, 0, "West"],
  [-1, -1, "North-west"],
];

// "North-east" for the square up and to the right of the caster, for an area aimed by direction.
export function directionName(origin: Square, aim: Square): string {
  const found = DIRECTIONS.find(
    ([dx, dy]) => origin.x + dx === aim.x && origin.y + dy === aim.y,
  );
  return found?.[2] ?? "";
}

// Where an area can be aimed. One that starts at the caster (a cone, a line, a cube such as Thunderwave)
// is aimed by one of the 8 squares next to them; any other at a square in range.
export function aimSquares(
  targeting: AreaTargeting,
  origin: Square,
  grid: Grid,
): readonly Square[] {
  const onGrid = ({ x, y }: Square): boolean =>
    x >= 0 && y >= 0 && x < grid.width && y < grid.height;
  if (targeting.range === "self") {
    return DIRECTIONS.map(([dx, dy]) => ({
      x: origin.x + dx,
      y: origin.y + dy,
    })).filter(onGrid);
  }
  const feet = rangeFeet(targeting.range);
  const squares: Square[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      if (distanceFeet(origin, { x, y }) <= feet) squares.push({ x, y });
    }
  }
  return squares;
}

// Whether an area aimed at `aim` covers `point`. A cube from the caster sits just past them, along the aim.
export function covers(
  targeting: AreaTargeting,
  origin: Square,
  aim: Square,
  point: Square,
): boolean {
  const { shape, radius } = targeting.area;
  const out =
    targeting.range === "self" && shape === "cube"
      ? Math.max(1, Math.ceil(radius / 10))
      : 1;
  const centre = {
    x: origin.x + (aim.x - origin.x) * out,
    y: origin.y + (aim.y - origin.y) * out,
  };
  return inArea(shape, radius, origin, centre, point);
}

// Everyone an area would catch: both sides, and the caster if they stand in it. A helpful area only
// takes the caster's side, as such spells name creatures of the caster's choice.
export function caughtBy(
  targeting: AreaTargeting,
  caster: Actor,
  aim: Square,
  creatures: readonly Actor[],
): readonly Actor[] {
  const origin = caster.position;
  if (!origin) return [];
  return creatures.filter(
    (item) =>
      item.position !== null &&
      (targeting.side === "enemy" || item.side === caster.side) &&
      covers(targeting, origin, aim, item.position),
  );
}

// What an area is worth to its caster: each standing foe caught counts 1, each ally 2 against, and the
// caster 3 against. A helpful area counts its own side instead.
export function aimScore(
  targeting: AreaTargeting,
  caster: Actor,
  caught: readonly Actor[],
): number {
  return caught.reduce((total, item) => {
    if (targeting.side === "ally") return total + (isDown(item) ? 2 : 1);
    if (item.id === caster.id) return total - 3;
    if (item.side === caster.side) return total - 2;
    return total + (isDown(item) ? 0 : 1);
  }, 0);
}

// "catches Goblin and Wolf, and also Mira and you": who an area catches, with the caster's own side named apart.
export function describeCaught(
  caster: Actor,
  caught: readonly Actor[],
): string {
  const names = (list: readonly Actor[]): string => {
    const named = [
      ...list.filter((item) => item.id !== caster.id).map((item) => item.name),
      ...(list.some((item) => item.id === caster.id) ? ["you"] : []),
    ];
    return named.length > 1
      ? `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`
      : (named[0] ?? "");
  };
  const foes = caught.filter((item) => item.side !== caster.side);
  const own = caught.filter((item) => item.side === caster.side);
  if (caught.length === 0) return "catches nobody";
  if (own.length === 0) return `catches ${names(foes)}`;
  if (foes.length === 0) return `catches only your side: ${names(own)}`;
  return `catches ${names(foes)}, and also ${names(own)}`;
}

// The options while choosing targets: add or take back a creature, cast once any are chosen, or go back.
// Separate darts or rays can go at the same creature, and must all be aimed before casting.
export function pickOptions(
  spell: string,
  candidates: readonly Actor[],
  picked: readonly string[],
  count: number,
  repeats: boolean,
): readonly { id: string; label: string }[] {
  const full = picked.length >= count;
  const options: { id: string; label: string }[] = [];
  if (picked.length > 0 && (!repeats || full)) {
    options.push({
      id: CONFIRM,
      label: `Cast ${spell} (${String(picked.length)} of ${String(count)})`,
    });
  }
  for (const item of candidates) {
    const times = picked.filter((id) => id === item.id).length;
    const hp = `${String(item.hp)} HP`;
    if (!full && (repeats || times === 0)) {
      options.push({
        id: `${ADD}${item.id}`,
        label: repeats
          ? `One at ${item.name} (${hp}${times > 0 ? `, ${String(times)} aimed` : ""})`
          : `Add ${item.name} (${hp})`,
      });
    }
    if (times > 0) {
      options.push({
        id: `${REMOVE}${item.id}`,
        label: repeats
          ? `Take one back from ${item.name}`
          : `Remove ${item.name}`,
      });
    }
  }
  options.push({ id: BACK, label: "Choose something else" });
  return options;
}

// Who a sensible caster adds next, or null when it should cast. A harmful spell goes for the weakest foe
// not yet held by it, and darts pile on whoever they can still drop, by `perHit` damage each; a helpful
// one goes to allies it isn't helping yet.
export function nextPick(
  candidates: readonly Actor[],
  picked: readonly string[],
  count: number,
  repeats: boolean,
  options: { readonly sourceId: string; readonly perHit: number },
): string | null {
  if (picked.length >= count) return null;
  const left = (item: Actor): number =>
    item.hp - options.perHit * picked.filter((id) => id === item.id).length;
  const free = candidates.filter(
    (item) =>
      (repeats || !picked.includes(item.id)) &&
      (repeats ||
        !item.activeEffects.some(
          (effect) => effect.sourceId === options.sourceId,
        )),
  );
  // Whoever is still standing and nearest to dropping; once all would drop, the least overkill.
  const order = [...free].sort((a, b) => {
    const alive = Number(left(b) > 0) - Number(left(a) > 0);
    if (alive !== 0) return alive;
    return left(a) > 0 ? left(a) - left(b) : left(b) - left(a);
  });
  return order[0]?.id ?? null;
}
