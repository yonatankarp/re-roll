export type RngState = [number, number, number, number];

// cyrb128: a fast, non-cryptographic hash. Used for seeds and for spotting changed plugins.
function cyrb128(text: string): RngState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function hashText(text: string): string {
  return cyrb128(text)
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}

// sfc32 uses only integer operations, so it gives identical results in every JavaScript engine.
function nextUint32(state: RngState): {
  readonly state: RngState;
  readonly value: number;
} {
  const [a, b, c, d] = state;
  const counter = (d + 1) | 0;
  const value = (((a + b) | 0) + d) | 0;
  return {
    state: [
      (b ^ (b >>> 9)) >>> 0,
      ((c + (c << 3)) | 0) >>> 0,
      ((((c << 21) | (c >>> 11)) + value) | 0) >>> 0,
      counter >>> 0,
    ],
    value: value >>> 0,
  };
}

export function rngFromSeed(seed: string): RngState {
  let state = cyrb128(seed);
  for (let round = 0; round < 12; round += 1) state = nextUint32(state).state;
  return state;
}

export interface DiceRoll {
  readonly below: number;
  readonly value: number;
}

export interface Dice {
  below(count: number): number; // a whole number from 0 up to, but not including, count
  roll(sides: number): number; // a whole number from 1 to sides
}

export interface RecordingDice extends Dice {
  readonly rolls: () => readonly DiceRoll[];
  readonly state: () => RngState;
}

const UINT32_RANGE = 2 ** 32;

export function createDice(start: RngState): RecordingDice {
  let state = start;
  const rolls: DiceRoll[] = [];

  const below = (count: number): number => {
    if (!Number.isSafeInteger(count) || count < 1 || count > UINT32_RANGE) {
      throw new Error(`Dice can't roll below ${String(count)}`);
    }
    // Rejecting the uneven tail avoids the bias a plain modulo would give.
    const limit = UINT32_RANGE - (UINT32_RANGE % count);
    for (;;) {
      const next = nextUint32(state);
      state = next.state;
      if (next.value < limit) {
        const value = next.value % count;
        rolls.push({ below: count, value });
        return value;
      }
    }
  };

  return {
    below,
    roll: (sides) => below(sides) + 1,
    rolls: () => rolls,
    state: () => state,
  };
}
