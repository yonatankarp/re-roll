import type { Ambience } from "../story/ambience.ts";
import { shellAudio } from "./audio.ts";
import { soundUrl } from "./sound-files.ts";

// Music under the scene: a calm piece while exploring, a darker one in dark places, and a driving
// one in a fight. Each streams from an <audio> element into the shell's music node, so the long
// pieces aren't held decoded in memory. A change crossfades; the narrator ducks it.

export type Mood = "explore" | "tension" | "combat" | "none";

const LEVEL = 0.3; // under the ambience and effects, at full master volume
const DUCKED = 0.35; // of LEVEL, while the narrator reads
const FADE = 2; // seconds
const TENSE: ReadonlySet<Ambience> = new Set([
  "cave",
  "temple",
  "storm",
  "swamp",
]);

export function moodOf(
  ambience: Ambience,
  fighting: boolean,
  ended: boolean,
): Mood {
  if (ended) return "none";
  if (fighting) return "combat";
  return TENSE.has(ambience) ? "tension" : "explore";
}

export interface MusicPlayer {
  readonly play: (mood: Mood) => void;
  readonly duck: (ducked: boolean) => void;
  readonly stop: () => void; // silent at once, such as when the game screen goes
}

interface Track {
  readonly element: HTMLAudioElement;
  readonly level: GainNode;
}

// Shared by every game screen, since an element's Web Audio source can't be made twice or let go.
const tracks = new Map<Mood, Track>();

export function musicPlayer(): MusicPlayer {
  let playing: Mood = "none";
  let ducked = false;

  const track = (mood: Mood): Track | null => {
    const audio = shellAudio();
    if (!audio || mood === "none") return null;
    let found = tracks.get(mood);
    if (!found) {
      const element = new Audio(soundUrl(`music-${mood}`));
      element.loop = true;
      element.preload = "auto";
      const level = audio.context.createGain();
      level.gain.value = 0;
      audio.context
        .createMediaElementSource(element)
        .connect(level)
        .connect(audio.music);
      found = { element, level };
      tracks.set(mood, found);
    }
    return found;
  };
  const fade = (to: Track, value: number, then?: () => void): void => {
    const { context } = to.level;
    const at = context.currentTime;
    to.level.gain.cancelScheduledValues(at);
    to.level.gain.setValueAtTime(to.level.gain.value, at);
    to.level.gain.linearRampToValueAtTime(value, at + FADE);
    if (then) setTimeout(then, FADE * 1000 + 100);
  };
  const level = (): void => {
    const audio = shellAudio();
    audio?.music.gain.setTargetAtTime(
      LEVEL * (ducked ? DUCKED : 1),
      audio.context.currentTime,
      0.3,
    );
  };

  return {
    play(mood) {
      if (mood === playing || (mood !== "none" && !shellAudio())) return;
      try {
        const old = tracks.get(playing);
        if (old) {
          fade(old, 0, () => {
            if (old !== tracks.get(playing)) old.element.pause();
          });
        }
        const next = track(mood);
        playing = mood;
        if (next) {
          if (mood === "combat") next.element.currentTime = 0; // each fight from its start
          next.element.play().catch(() => undefined);
          fade(next, 1);
        }
        level();
      } catch {
        // No media elements in Web Audio here, so no music.
      }
    },
    duck(on) {
      if (on === ducked) return;
      ducked = on;
      level();
    },
    stop() {
      playing = "none";
      for (const { element, level } of tracks.values()) {
        element.pause();
        level.gain.cancelScheduledValues(level.context.currentTime);
        level.gain.value = 0;
      }
    },
  };
}
