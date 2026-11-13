// The board's arithmetic that needs no page, so tests can check it.

// The longest a moment stays with reduced motion: long enough to read, without the time movement takes.
export const STILL_DWELL = 600;

// How long a moment of `ms` stays on screen.
export function dwell(ms: number, skipping: boolean, calm: boolean): number {
  if (skipping) return 0;
  return calm ? Math.min(ms, STILL_DWELL) : ms;
}

// How far a battle map zooms in: four times its fitted size.
export const MAX_ZOOM = 4;

// The zoom `steps` notches from `zoom`, each a quarter bigger or smaller, between fitted and MAX_ZOOM.
export function nextZoom(zoom: number, steps: number): number {
  return Math.min(MAX_ZOOM, Math.max(1, zoom * 1.25 ** steps));
}

// The dice the board draws in 3D.
export const DIE_SIDES = [4, 6, 8, 10, 12, 20] as const;
export type Sides = (typeof DIE_SIDES)[number];
export function isSides(sides: number): sides is Sides {
  return (DIE_SIDES as readonly number[]).includes(sides);
}

// Faces a handful of `formula`'s dice (such as "2d6+1d4+3", doubled on a critical hit) could show for
// `amount`. Events log only the total, so the faces are made up to fit it, each between 1 and its sides;
// when resistance or a split damage type means no faces fit, they come as close as they can.
export function damageFaces(
  formula: string,
  amount: number,
  critical: boolean,
  random: () => number,
): { readonly sides: Sides; value: number }[] {
  const faces: { sides: Sides; value: number }[] = [];
  for (const [, count, sides] of formula.matchAll(/(\d*)d(\d+)/g)) {
    const size = Number(sides);
    const many = Number(count === "" ? "1" : count) * (critical ? 2 : 1);
    for (let i = 0; i < many && faces.length < 10 && isSides(size); i += 1) {
      faces.push({ sides: size, value: 1 });
    }
  }
  const bonus = (formula.replace(/\d*d\d+/g, "").match(/[+-]?\s*\d+/g) ?? [])
    .map((term) => Number(term.replace(/\s/g, "")))
    .reduce((sum, term) => sum + term, 0);
  let rest = amount - bonus - faces.length;
  while (rest > 0) {
    const open = faces.filter((face) => face.value < face.sides);
    const face = open[Math.floor(random() * open.length)];
    if (!face) break;
    face.value += 1;
    rest -= 1;
  }
  return faces;
}
