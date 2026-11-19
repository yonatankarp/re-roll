import type { DndCue } from "./cues.ts";

// Short sounds for the board's cues: recorded ones from CC0 packs (sounds/credits.json says whose),
// and Web Audio ones made in code for the rest and for while the recordings load. Each starts now and
// is over within about a second, so nothing waits to play after a skip. Without Web Audio nothing plays.
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
      preload(to.context);
    }
    return mix;
  } catch {
    return null; // no Web Audio here, so the game stays silent
  }
}

// Opus in Ogg, or the AAC copy for a WebKit that can't play Ogg.
const OGG =
  typeof Audio !== "undefined" &&
  new Audio().canPlayType('audio/ogg; codecs="opus"') !== "";
const RECORDED = [
  "dice-1",
  "dice-2",
  "dice-3",
  "hit-1",
  "hit-2",
  "hit-3",
  "critical",
  "down",
  "step-1",
  "step-2",
  "step-3",
  "turn",
  "status",
  "resist",
  "legendary",
  "lair",
  "coins",
  "fight-start",
  "fight-won",
] as const;
type Recorded = (typeof RECORDED)[number];
const SAMPLE_LEVEL = 3; // the recordings are mastered loud, the made sounds peak near 1/3 of that
const recordings = new Map<Recorded, AudioBuffer>();

function preload(context: BaseAudioContext): void {
  recordings.clear();
  for (const name of RECORDED) {
    const url = OGG
      ? new URL(`./sounds/${name}.ogg`, import.meta.url)
      : new URL(`./sounds/${name}.m4a`, import.meta.url);
    fetch(url)
      .then((response) =>
        response.ok
          ? response.arrayBuffer()
          : Promise.reject(new Error(String(response.status))),
      )
      .then((data) => context.decodeAudioData(data))
      .then((buffer) => {
        recordings.set(name, buffer);
      })
      .catch(() => undefined); // the made sound stands in
  }
}

// Plays a recording `at` seconds from now; false while it isn't loaded, so a made sound can stand in.
function recorded(name: Recorded, at = 0, level = 1): boolean {
  const out = mixer();
  const buffer = recordings.get(name);
  if (!out || !buffer) return false;
  const { context } = out;
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  gain.gain.value = SAMPLE_LEVEL * level;
  source.connect(gain).connect(out);
  source.start(context.currentTime + at);
  return true;
}

function oneOf(name: "dice" | "hit" | "step"): Recorded {
  return `${name}-${String(1 + Math.floor(Math.random() * 3))}` as Recorded;
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
  if (recorded(oneOf("dice"))) return;
  let at = 0;
  for (let click = 0; click < 6; click += 1) {
    noise("bandpass", 2600, 1800, at, 0.03, 0.6);
    at += 0.035 + Math.random() * 0.03;
  }
  tone("triangle", 320, 200, at, 0.08, 0.4);
}

export function hitSound(critical: boolean): void {
  if (recorded(oneOf("hit"))) {
    if (critical) recorded("critical", 0.03, 0.8);
    return;
  }
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
  if (recorded("coins", 0, 0.7)) return;
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
  if (recorded("down")) {
    tone("sine", 95, 35, 0, 0.45, 0.6); // the weight of the fall under it
    return;
  }
  tone("sine", 95, 35, 0, 0.45, 1);
  noise("lowpass", 300, 80, 0, 0.18, 0.6);
}

// Rising for the start of a fight, and resolving onto a chord for its end.
export function fightStartSound(): void {
  if (recorded("fight-start")) return;
  tone("triangle", 220, 220, 0, 0.14, 0.5);
  tone("triangle", 330, 330, 0.12, 0.14, 0.5);
  tone("triangle", 440, 452, 0.24, 0.32, 0.6);
}

export function fightEndSound(): void {
  if (recorded("fight-won", 0, 0.5)) return;
  tone("triangle", 392, 392, 0, 0.18, 0.5);
  tone("triangle", 523, 523, 0.16, 0.4, 0.5);
  tone("triangle", 659, 659, 0.16, 0.4, 0.35);
}

// Two footsteps across a square or more.
export function moveSound(): void {
  if (recorded(oneOf("step"), 0, 0.6)) {
    recorded(oneOf("step"), 0.22, 0.5);
    return;
  }
  noise("lowpass", 400, 150, 0, 0.06, 0.4);
  noise("lowpass", 400, 150, 0.22, 0.06, 0.35);
}

// A soft tick as a new turn comes round.
export function turnSound(): void {
  if (recorded("turn", 0, 0.6)) return;
  tone("sine", 1200, 1150, 0, 0.06, 0.25);
}

// A shimmer as a condition takes hold or ends.
export function statusSound(): void {
  if (recorded("status", 0, 0.6)) return;
  tone("sine", 1760, 2093, 0, 0.25, 0.2);
  tone("sine", 2637, 2794, 0.05, 0.25, 0.12);
}

// A clang for a blow turned aside by resistance or immunity.
export function resistSound(): void {
  if (recorded("resist", 0, 0.8)) return;
  tone("square", 660, 640, 0, 0.18, 0.15);
  tone("sine", 1980, 1960, 0, 0.25, 0.15);
}

// A tolling bell for a legendary action, a deep rumble for the lair's own.
export function legendarySound(): void {
  if (recorded("legendary", 0, 0.7)) return;
  tone("triangle", 196, 190, 0, 0.6, 0.6);
  tone("sine", 98, 96, 0, 0.6, 0.6);
}

export function lairSound(): void {
  noise("lowpass", 160, 50, 0, 0.9, 0.8);
  recorded("lair", 0, 0.8);
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
      legendarySound();
      return;
    case "lair":
      lairSound();
      return;
    case "move":
      moveSound();
      return;
    case "turn":
      turnSound();
      return;
    case "status":
      statusSound();
      return;
    case "resist":
      resistSound();
      return;
  }
}
