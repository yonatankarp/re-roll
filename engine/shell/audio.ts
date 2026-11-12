import { loadSettings } from "./sound-settings.ts";

// The shell's own sound: one Web Audio graph for ambience and narration, under a master volume.
// A system's effects (such as dice) play themselves, told the volume through the board host.
// Without Web Audio everything stays silent.

export interface ShellAudio {
  readonly context: AudioContext;
  readonly ambience: GainNode; // ambience plays into this
  readonly narration: GainNode; // and narration into this
}

let audio: ShellAudio | null = null;
let master: GainNode | null = null;
let level = loadSettings().volume;

// Browsers start audio only from a gesture, so the context is made, or woken, on one.
function unlock(): void {
  try {
    if (!audio) {
      const context = new AudioContext();
      master = context.createGain();
      master.gain.value = level;
      master.connect(context.destination);
      const ambience = context.createGain();
      const narration = context.createGain();
      ambience.connect(master);
      narration.connect(master);
      audio = { context, ambience, narration };
    }
    if (audio.context.state === "suspended") {
      audio.context.resume().catch(() => undefined);
    }
  } catch {
    // No Web Audio here.
  }
}

if (typeof window !== "undefined") {
  for (const type of ["pointerdown", "click", "keydown"]) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
}

export function shellAudio(): ShellAudio | null {
  return audio;
}

export function setMasterVolume(volume: number): void {
  level = volume;
  if (audio && master) {
    master.gain.setTargetAtTime(volume, audio.context.currentTime, 0.05);
  }
}
