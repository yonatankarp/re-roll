import { z } from "zod";
import type { Adventure } from "./adventure.ts";

// Where read-aloud clips live and how they're named, shared by the CLI that makes them ahead of
// time and the app that plays them (or makes them itself when one is missing).
// A clip is named by its voice and a hash of its text, so changed text is a new clip and the app
// can find one without reading anything else. The index holds ids, hashes and numbers, never text.

export const NARRATION_FOLDER = "narration";
export const NARRATION_INDEX = `${NARRATION_FOLDER}/index.yaml`;

// Kokoro-82M voices that suit reading a fantasy story aloud. Heart is its best-graded voice.
export const NARRATOR_VOICES = [
  { id: "af_heart", label: "Heart, warm" },
  { id: "bm_george", label: "George, warm British" },
  { id: "bf_emma", label: "Emma, British" },
] as const;
export type NarratorVoice = (typeof NARRATOR_VOICES)[number]["id"];
export const DEFAULT_VOICE: NarratorVoice = "af_heart";
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export interface NarrationClip {
  readonly scene: string;
  readonly voice: string;
  readonly seconds: number;
}

// Keyed by clip file, such as "bm_george/1a2b3c4d5e6f7.mp3".
export interface NarrationIndex {
  readonly version: 1;
  readonly clips: Readonly<Record<string, NarrationClip>>;
}

export const EMPTY_INDEX: NarrationIndex = { version: 1, clips: {} };

// The index is read back from disk and its keys become paths to delete, so each must be a voice and a hash.
const CLIP_FILE = /^[a-z]{2}_[a-z]+\/[0-9a-f]+\.mp3$/;
export const NarrationIndexSchema = z.object({
  version: z.literal(1),
  clips: z.record(
    z.string().regex(CLIP_FILE),
    z.object({ scene: z.string(), voice: z.string(), seconds: z.number() }),
  ),
});

export function normaliseText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// cyrb53: a 53-bit string hash, synchronous and the same in Node and every browser.
export function textHash(text: string): string {
  const input = normaliseText(text);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function clipFile(voice: string, text: string): string {
  return `${voice}/${textHash(text)}.mp3`;
}

// Every text a scene can show: its own and each variant's.
export function narratedTexts(
  adventure: Pick<Adventure, "scenes">,
): { readonly scene: string; readonly text: string }[] {
  return adventure.scenes.flatMap((scene) => [
    { scene: scene.id, text: scene.text },
    ...scene.textVariants.map((variant) => ({
      scene: scene.id,
      text: variant.text,
    })),
  ]);
}

export interface NarrationPlan {
  readonly make: readonly {
    readonly scene: string;
    readonly text: string;
    readonly file: string;
  }[];
  readonly keep: readonly string[];
  readonly stale: readonly string[]; // this voice's clips whose text is gone
}

// What a run for one voice has to make, given the index and which clip files exist on disk.
export function planNarration(
  index: NarrationIndex,
  texts: readonly { readonly scene: string; readonly text: string }[],
  voice: string,
  exists: (file: string) => boolean,
): NarrationPlan {
  const wanted = new Map<string, { scene: string; text: string }>();
  for (const item of texts) {
    const file = clipFile(voice, item.text);
    if (!wanted.has(file)) wanted.set(file, item);
  }
  const make: { scene: string; text: string; file: string }[] = [];
  const keep: string[] = [];
  for (const [file, item] of wanted) {
    if (index.clips[file] && exists(file)) keep.push(file);
    else make.push({ ...item, file });
  }
  const stale = Object.entries(index.clips)
    .filter(([file, clip]) => clip.voice === voice && !wanted.has(file))
    .map(([file]) => file);
  return { make, keep, stale };
}

// The first few scenes a scene's choices go to, which the app reads ahead on a slow CPU.
export function scenesAhead(
  scene: Adventure["scenes"][number] | undefined,
  most = 3,
): string[] {
  const ids = (scene?.choices ?? []).flatMap((choice) =>
    ("effects" in choice
      ? choice.effects
      : Object.values(choice.results).flat()
    ).flatMap((effect) => (effect.kind === "goto" ? [effect.scene] : [])),
  );
  return [...new Set(ids)].slice(0, most);
}
