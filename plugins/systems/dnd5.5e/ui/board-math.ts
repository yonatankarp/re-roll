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
