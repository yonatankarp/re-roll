import { shellAudio } from "./audio.ts";
import type { GameView } from "./session.ts";

// The shell's recorded sounds, from CC0 and CC BY packs (sounds/credits.json says whose). Each is
// Opus in Ogg, with an AAC copy for a WebKit that can't play Ogg.

const OGG =
  typeof Audio !== "undefined" &&
  new Audio().canPlayType('audio/ogg; codecs="opus"') !== "";

export function soundUrl(name: string): string {
  return (
    OGG
      ? new URL(`./sounds/${name}.ogg`, import.meta.url)
      : new URL(`./sounds/${name}.m4a`, import.meta.url)
  ).href;
}

export type Sting =
  "level-up" | "victory" | "defeat" | "rest" | "shop" | "page";

const STING_LEVEL = 0.5;
const loaded = new Map<string, Promise<AudioBuffer | null>>();

function load(
  context: BaseAudioContext,
  name: string,
): Promise<AudioBuffer | null> {
  let buffer = loaded.get(name);
  if (!buffer) {
    buffer = fetch(soundUrl(name))
      .then((response) =>
        response.ok
          ? response.arrayBuffer()
          : Promise.reject(new Error(String(response.status))),
      )
      .then((data) => context.decodeAudioData(data))
      .catch(() => null); // missing or undecodable, so the moment stays silent
    loaded.set(name, buffer);
  }
  return buffer;
}

// A short sound for a moment, into the effects, under the one volume. Loaded the first time, and
// dropped if `wanted` says no by then, such as when the game screen went while it loaded.
export function playSting(
  name: Sting,
  wanted: () => boolean = () => true,
): void {
  const audio = shellAudio();
  if (!audio) return;
  void load(audio.context, name).then((buffer) => {
    if (!buffer || !wanted()) return;
    const source = audio.context.createBufferSource();
    source.buffer = buffer;
    const level = audio.context.createGain();
    level.gain.value = STING_LEVEL;
    source.connect(level).connect(audio.effects);
    source.start();
  });
}

type Heard = Pick<GameView, "run" | "ended" | "scene" | "moments" | "shop">;

// What changed between two views that deserves a sound, if anything.
export function stingsBetween(
  before: Heard | null,
  after: Heard,
): readonly Sting[] {
  if (before?.run !== after.run) return []; // a new or loaded game isn't a moment
  const count = (view: Heard): number =>
    view.moments.filter((moment) => moment === "levelUp").length;
  const stings: Sting[] = [];
  if (after.ended !== before.ended && after.ended === "ending")
    stings.push("victory");
  else if (after.ended !== before.ended && after.ended === "defeat")
    stings.push("defeat");
  else if (after.scene !== before.scene && after.scene !== null)
    stings.push("page");
  if (count(after) > count(before)) stings.push("level-up");
  if (after.shop && !before.shop) stings.push("shop");
  return stings;
}
