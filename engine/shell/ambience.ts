import type { Ambience } from "../story/ambience.ts";
import { shellAudio } from "./audio.ts";

// Background soundscapes made with Web Audio from looped noise, filters and slow oscillators,
// with random one-off sounds (drips, crackles, clinks, thunder) on timers, so nothing repeats
// and there are no files. A change of scene crossfades; a fight or the narrator ducks it.

const LEVEL = 0.35; // under everything else, at full master volume
const DUCKED = 0.3; // of LEVEL, during a fight or while the narrator reads
const FADE = 1.5; // seconds

interface Soundscape {
  readonly out: GainNode;
  readonly stop: () => void;
}

let whiteNoise: AudioBuffer | null = null;

// Four seconds of white noise. Looped, its seam is inaudible, unlike brown noise's drift.
function noiseBuffer(context: AudioContext): AudioBuffer {
  if (whiteNoise?.sampleRate !== context.sampleRate) {
    whiteNoise = context.createBuffer(
      1,
      context.sampleRate * 4,
      context.sampleRate,
    );
    const samples = whiteNoise.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.random() * 2 - 1;
    }
  }
  return whiteNoise;
}

function between(low: number, high: number): number {
  return low + Math.random() * (high - low);
}

function build(context: AudioContext, kind: Ambience): Soundscape | null {
  if (kind === "none") return null;
  const out = context.createGain();
  out.gain.value = 0;
  const sources: AudioScheduledSourceNode[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const now = (): number => context.currentTime;

  const start = <T extends AudioScheduledSourceNode>(source: T): T => {
    sources.push(source);
    source.start();
    return source;
  };
  // Looped noise through a filter, at a level, into `to`.
  const bed = (
    type: BiquadFilterType,
    frequency: number,
    q: number,
    gain: number,
    to: AudioNode = out,
  ): { filter: BiquadFilterNode; level: GainNode } => {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer(context);
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = source.buffer.duration;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const level = context.createGain();
    level.gain.value = gain;
    source.connect(filter).connect(level).connect(to);
    // Each starts at its own point in the buffer, so layers don't share a pattern.
    sources.push(source);
    source.start(0, Math.random() * 4);
    return { filter, level };
  };
  // A slow wobble of `param` around its value, `depth` either way.
  const sway = (param: AudioParam, rate: number, depth: number): void => {
    const lfo = context.createOscillator();
    lfo.frequency.value = rate;
    const amount = context.createGain();
    amount.gain.value = depth;
    lfo.connect(amount).connect(param);
    start(lfo);
  };
  // Calls `make` again and again, `low` to `high` ms apart, until the soundscape stops.
  const every = (low: number, high: number, make: () => void): void => {
    const next = (): void => {
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          make();
          next();
        },
        between(low, high),
      );
      timers.add(timer);
    };
    next();
  };
  // A short burst of noise through a filter, fading out over `length` seconds.
  const burst = (
    type: BiquadFilterType,
    frequency: number,
    length: number,
    peak: number,
    to: AudioNode = out,
  ): void => {
    const at = now() + 0.02;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer(context);
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    const level = context.createGain();
    level.gain.setValueAtTime(0.0001, at);
    level.gain.exponentialRampToValueAtTime(peak, at + 0.003);
    level.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(filter).connect(level).connect(to);
    source.start(at, Math.random() * 3);
    source.stop(at + length + 0.05);
  };
  // A short note that falls in pitch, like a drip or a clink.
  const ping = (
    from: number,
    to: number,
    length: number,
    peak: number,
    into: AudioNode = out,
  ): void => {
    const at = now() + 0.02;
    const osc = context.createOscillator();
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + length);
    const level = context.createGain();
    level.gain.setValueAtTime(0.0001, at);
    level.gain.exponentialRampToValueAtTime(peak, at + 0.004);
    level.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(level).connect(into);
    osc.start(at);
    osc.stop(at + length + 0.05);
  };
  // An echo, for the stone of a cave.
  const echo = (): GainNode => {
    const input = context.createGain();
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.23;
    const feedback = context.createGain();
    feedback.gain.value = 0.4;
    const dull = context.createBiquadFilter();
    dull.type = "lowpass";
    dull.frequency.value = 1800;
    input.connect(out);
    input.connect(delay).connect(dull).connect(feedback).connect(delay);
    feedback.connect(out);
    return input;
  };
  const wind = (strength: number): void => {
    const gust = bed("bandpass", 500, 0.8, 0.5 * strength);
    sway(gust.filter.frequency, 0.07, 250);
    sway(gust.level.gain, 0.11, 0.25 * strength);
    const low = bed("lowpass", 180, 0.5, 0.6 * strength);
    sway(low.level.gain, 0.05, 0.25 * strength);
  };
  const rain = (heavy: boolean): void => {
    bed("bandpass", 2500, 0.4, heavy ? 0.6 : 0.4);
    bed("highpass", 6000, 0.5, heavy ? 0.2 : 0.12);
    every(30, heavy ? 90 : 160, () => {
      burst("bandpass", between(2000, 5000), 0.02, between(0.1, 0.35));
    });
  };

  switch (kind) {
    case "wind":
      wind(1);
      break;
    case "cave": {
      for (const [pitch, gain] of [
        [55, 0.12],
        [55.4, 0.12],
        [82.6, 0.05],
      ] as const) {
        const hum = context.createOscillator();
        hum.frequency.value = pitch;
        const level = context.createGain();
        level.gain.value = gain;
        hum.connect(level).connect(out);
        start(hum);
      }
      const air = bed("lowpass", 220, 0.7, 0.35);
      sway(air.level.gain, 0.04, 0.15);
      const stone = echo();
      every(1200, 4500, () => {
        const pitch = between(1100, 2200);
        ping(pitch, pitch * 0.55, 0.09, between(0.15, 0.35), stone);
      });
      break;
    }
    case "town": {
      // Voices: bands of noise in the range of speech, each rising and falling at a talking pace.
      for (const [band, rate] of [
        [450, 3.1],
        [800, 4.3],
        [1300, 5.2],
        [2000, 3.7],
      ] as const) {
        const voice = bed("bandpass", band, 3, 0.25);
        sway(voice.level.gain, rate, 0.18);
        sway(voice.filter.frequency, rate / 7, band * 0.15);
      }
      bed("lowpass", 300, 0.5, 0.2);
      every(2500, 8000, () => {
        const pitch = between(2400, 3600);
        ping(pitch, pitch * 0.98, 0.25, between(0.05, 0.12));
      });
      break;
    }
    case "rain":
      rain(false);
      break;
    case "storm":
      rain(true);
      wind(0.8);
      every(12000, 30000, () => {
        burst("lowpass", between(90, 160), between(2.5, 5), 1.2);
        burst("lowpass", 500, 0.4, 0.5);
      });
      break;
    case "campfire": {
      const roar = bed("lowpass", 350, 0.6, 0.5);
      sway(roar.level.gain, 0.3, 0.15);
      every(40, 350, () => {
        burst(
          "highpass",
          between(1500, 4500),
          between(0.004, 0.02),
          between(0.1, 0.6),
        );
      });
      every(1500, 6000, () => {
        burst("bandpass", between(600, 1200), 0.06, 0.8);
      });
      break;
    }
  }

  return {
    out,
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      out.disconnect();
    },
  };
}

export interface AmbiencePlayer {
  readonly play: (kind: Ambience) => void;
  readonly duck: (ducked: boolean) => void;
}

export function ambiencePlayer(): AmbiencePlayer {
  let playing: { kind: Ambience; scape: Soundscape | null } = {
    kind: "none",
    scape: null,
  };
  let ducked = false;

  const level = (): void => {
    const audio = shellAudio();
    if (!audio) return;
    audio.ambience.gain.setTargetAtTime(
      LEVEL * (ducked ? DUCKED : 1),
      audio.context.currentTime,
      0.3,
    );
  };

  return {
    play(kind) {
      const audio = shellAudio();
      if (!audio || kind === playing.kind) return;
      const { context } = audio;
      const at = context.currentTime;
      const old = playing.scape;
      if (old) {
        old.out.gain.cancelScheduledValues(at);
        old.out.gain.setValueAtTime(old.out.gain.value, at);
        old.out.gain.linearRampToValueAtTime(0, at + FADE);
        setTimeout(old.stop, FADE * 1000 + 100);
      }
      const scape = build(context, kind);
      if (scape) {
        scape.out.connect(audio.ambience);
        scape.out.gain.setValueAtTime(0, at);
        scape.out.gain.linearRampToValueAtTime(1, at + FADE);
      }
      playing = { kind, scape };
      level();
    },
    duck(on) {
      if (on === ducked) return;
      ducked = on;
      level();
    },
  };
}
