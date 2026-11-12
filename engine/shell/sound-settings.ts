import {
  DEFAULT_VOICE,
  NARRATOR_VOICES,
  type NarratorVoice,
} from "../story/narration.ts";

// The player's sound settings, kept in the page's localStorage or in a store passed in.

export interface SoundSettings {
  readonly volume: number; // 0 to 1, for everything
  readonly ambience: boolean;
  readonly effects: boolean;
  readonly narration: boolean;
  readonly voice: NarratorVoice;
}

const SETTINGS_KEY = "re-roll:audio";
const EFFECTS_KEY = "re-roll:sound"; // the older on/off setting, which now means effects

// Where the settings are kept: the page's localStorage unless a store is passed, as tests do.
export type SettingsStore = Pick<Storage, "getItem" | "setItem">;

// Storage can be blocked, which leaves the defaults: effects and quiet ambience on, narration off.
export function loadSettings(store?: SettingsStore): SoundSettings {
  const defaults: SoundSettings = {
    volume: 0.7,
    ambience: true,
    effects: true,
    narration: false,
    voice: DEFAULT_VOICE,
  };
  try {
    const from = store ?? localStorage;
    const effects = from.getItem(EFFECTS_KEY) !== "off";
    const saved = JSON.parse(from.getItem(SETTINGS_KEY) ?? "{}") as Partial<
      Record<keyof SoundSettings, unknown>
    >;
    return {
      volume:
        typeof saved.volume === "number"
          ? Math.min(1, Math.max(0, saved.volume))
          : defaults.volume,
      // Someone who turned sound off before ambience existed doesn't get it unasked.
      ambience: typeof saved.ambience === "boolean" ? saved.ambience : effects,
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

export function saveSettings(
  settings: SoundSettings,
  store?: SettingsStore,
): void {
  try {
    const to = store ?? localStorage;
    to.setItem(EFFECTS_KEY, settings.effects ? "on" : "off");
    const { volume, ambience, narration, voice } = settings;
    to.setItem(
      SETTINGS_KEY,
      JSON.stringify({ volume, ambience, narration, voice }),
    );
  } catch {
    // Not remembered, but still applies for now.
  }
}
