import type { DndCue } from "./cues.ts";

// Short sounds for the board's cues, made with Web Audio so there are no files to load. Each is under
// about 600 ms and starts now, so nothing waits to play after a skip. Without Web Audio nothing plays.
// shortcut: a skip lets the current sound's last few hundred ms finish; stop its nodes if that ever grates.

const VOLUME = 0.15;

// Where the sounds go. The app gives the shell's own effects node, so the player's one volume rules every
// sound; until it does, nothing plays.
let output: () => AudioNode | null = () => null;
let mix: GainNode | null = null; // the effects' own level, on the output it was made for
let hiss: AudioBuffer | null = null; // a second of white noise, made once

export function setEffectsOutput(get: () => AudioNode | null): void {
  output = get;
}

// Cuts off what is sounding, such as when the board goes away.
export function stopEffects(): void {
  mix?.disconnect();
  mix = null;
}

function mixer(): GainNode | null {
  try {
    const to = output();
    if (!to) return null;
    if (mix?.context !== to.context) {
      mix = to.context.createGain();
      mix.gain.value = VOLUME;
      mix.connect(to);
    }
    return mix;
  } catch {
    return null; // no Web Audio here, so the game stays silent
  }
}

// A note whose pitch slides from `from` to `to` Hz, with a quick attack and an exponential fade.
function tone(
  type: OscillatorType,
  from: number,
  to: number,
  at: number,
  length: number,
  peak: number,
): void {
  const out = mixer();
  if (!out) return;
  const { context } = out;
  const start = context.currentTime + at;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(to, start + length);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

// A burst of noise through a filter that sweeps from `from` to `to` Hz.
function noise(
  filter: BiquadFilterType,
  from: number,
  to: number,
  at: number,
  length: number,
  peak: number,
): void {
  const out = mixer();
  if (!out) return;
  const { context } = out;
  if (!hiss) {
    hiss = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = hiss.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.random() * 2 - 1;
    }
  }
  const start = context.currentTime + at;
  const source = context.createBufferSource();
  const shape = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = hiss;
  shape.type = filter;
  shape.Q.value = 1.5;
  shape.frequency.setValueAtTime(from, start);
  shape.frequency.exponentialRampToValueAtTime(to, start + length);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  source.connect(shape).connect(gain).connect(out);
  source.start(start, Math.random() * 0.5);
  source.stop(start + length + 0.02);
}

// A d20 clattering across the table and settling.
export function diceSound(): void {
  let at = 0;
  for (let click = 0; click < 6; click += 1) {
    noise("bandpass", 2600, 1800, at, 0.03, 0.6);
    at += 0.035 + Math.random() * 0.03;
  }
  tone("triangle", 320, 200, at, 0.08, 0.4);
}

export function hitSound(critical: boolean): void {
  tone("sine", 150, 45, 0, 0.22, 1);
  noise("lowpass", 900, 200, 0, 0.09, 0.7);
  if (critical) {
    tone("triangle", 1320, 1760, 0.02, 0.3, 0.35);
    tone("sine", 2640, 2640, 0.06, 0.35, 0.2);
  }
}

// Played as the die lands, in time with the board's MISS.
export function missSound(at = 0): void {
  noise("bandpass", 500, 3500, at, 0.22, 0.5);
}

export function healSound(): void {
  [1047, 1319, 1568].forEach((pitch, step) => {
    tone("sine", pitch, pitch, step * 0.08, 0.4, 0.35);
  });
}

// Coins poured into the purse, for the moment treasure is found.
export function coinSound(): void {
  [2093, 2794, 2349, 3136].forEach((pitch, step) => {
    tone("triangle", pitch, pitch * 0.98, step * 0.06, 0.22, 0.25);
  });
  noise("highpass", 5000, 8000, 0, 0.06, 0.15);
}

export function castSound(): void {
  [1319, 1760, 2093, 2637].forEach((pitch, step) => {
    tone("sine", pitch, pitch * 1.01, step * 0.05, 0.3, 0.2);
  });
  noise("highpass", 3000, 7000, 0, 0.45, 0.15);
}

export function downSound(): void {
  tone("sine", 95, 35, 0, 0.45, 1);
  noise("lowpass", 300, 80, 0, 0.18, 0.6);
}

// Rising for the start of a fight, and resolving onto a chord for its end.
export function fightStartSound(): void {
  tone("triangle", 220, 220, 0, 0.14, 0.5);
  tone("triangle", 330, 330, 0.12, 0.14, 0.5);
  tone("triangle", 440, 452, 0.24, 0.32, 0.6);
}

export function fightEndSound(): void {
  tone("triangle", 392, 392, 0, 0.18, 0.5);
  tone("triangle", 523, 523, 0.16, 0.4, 0.5);
  tone("triangle", 659, 659, 0.16, 0.4, 0.35);
}

export function cueSound(cue: DndCue): void {
  switch (cue.kind) {
    case "attack":
      diceSound();
      if (!cue.hit) missSound(0.38);
      return;
    case "check":
    case "deathSave":
      diceSound();
      return;
    case "damage":
      hitSound(cue.critical);
      return;
    case "heal":
      healSound();
      return;
    case "cast":
      castSound();
      return;
    case "down":
      downSound();
      return;
    case "start":
      fightStartSound();
      return;
    case "end":
      fightEndSound();
      return;
    case "legendary":
    case "lair":
      castSound();
      return;
    case "move":
    case "turn":
    case "status":
    case "resist":
      return;
  }
}
