import {
  DEFAULT_VOICE,
  NARRATOR_VOICES,
  type NarratorVoice,
} from "../story/narration.ts";

// The shell's own sound: one Web Audio graph for ambience and narration, under a master volume,
// and the player's sound settings. A system's effects (such as dice) play themselves, told the
// volume through the board host. Without Web Audio everything stays silent.

export interface SoundSettings {
  readonly volume: number; // 0 to 1, for everything
  readonly ambience: boolean;
  readonly effects: boolean;
  readonly narration: boolean;
  readonly voice: NarratorVoice;
}

const SETTINGS_KEY = "re-roll:audio";
const EFFECTS_KEY = "re-roll:sound"; // the older on/off setting, which now means effects

// Storage can be blocked, which leaves the defaults: effects on, the rest off, quiet.
export function loadSettings(): SoundSettings {
  const defaults: SoundSettings = {
    volume: 0.7,
    ambience: true,
    effects: true,
    narration: false,
    voice: DEFAULT_VOICE,
  };
  try {
    const effects = localStorage.getItem(EFFECTS_KEY) !== "off";
    const saved = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? "{}",
    ) as Partial<Record<keyof SoundSettings, unknown>>;
    return {
      volume:
        typeof saved.volume === "number"
          ? Math.min(1, Math.max(0, saved.volume))
          : defaults.volume,
      ambience:
        typeof saved.ambience === "boolean"
          ? saved.ambience
          : defaults.ambience,
      effects,
      narration:
        typeof saved.narration === "boolean"
          ? saved.narration
          : defaults.narration,
      voice:
        NARRATOR_VOICES.find((item) => item.id === saved.voice)?.id ??
        defaults.voice,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: SoundSettings): void {
  try {
    localStorage.setItem(EFFECTS_KEY, settings.effects ? "on" : "off");
    const { volume, ambience, narration, voice } = settings;
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ volume, ambience, narration, voice }),
    );
  } catch {
    // Not remembered, but still applies for now.
  }
}

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
