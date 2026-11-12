// The board's arithmetic that needs no page, so tests can check it.

// The longest a moment stays with reduced motion: long enough to read, without the time movement takes.
export const STILL_DWELL = 600;

// How long a moment of `ms` stays on screen.
export function dwell(ms: number, skipping: boolean, calm: boolean): number {
  if (skipping) return 0;
  return calm ? Math.min(ms, STILL_DWELL) : ms;
}
