import { normaliseText } from "../story/narration.ts";

// How a scene is read aloud with Kokoro, the same in the app's worker and in npm run narrate:
// game terms said as words, short sentences read together so the voice keeps its tone, and each
// piece trimmed of Kokoro's own uneven silence and given an even pause before it.

const SENTENCE_PAUSE = 0.35; // seconds before each piece after a paragraph's first
const PARAGRAPH_PAUSE = 0.7;
const SHORT = 60; // characters: a sentence this short is read with its neighbour
const LONGEST = 220; // characters a joined piece stays under, well inside Kokoro's 510 tokens
const FIRST = 100; // characters the scene's first piece stays under, so the first word comes soon
const QUIET = 0.004; // below this, a sample at a piece's edge counts as silence
const TAIL = 0.06; // seconds kept after the last sound, so endings like "s" aren't cut
const FADE = 0.005; // seconds faded in and out at the cut, so it doesn't click

const COINS: Readonly<Record<string, string>> = {
  cp: "copper pieces",
  sp: "silver pieces",
  ep: "electrum pieces",
  gp: "gold pieces",
  pp: "platinum pieces",
};

// Game shorthand as it would be said at the table. Book text is unchanged; this is only what's read.
export function spokenText(text: string): string {
  return text
    .replace(
      /\b(\d+)?d(\d+)(?:\s*([+−-])\s*(\d+))?\b/g,
      (_, count?: string, sides?: string, sign?: string, bonus?: string) =>
        `${count ? `${count} ` : ""}D ${sides ?? ""}${sign && bonus ? ` ${sign === "+" ? "plus" : "minus"} ${bonus}` : ""}`,
    )
    .replace(/(^|[\s(])\+(\d+)/g, "$1plus $2")
    .replace(/\b(\d+)\s*(cp|sp|ep|gp|pp)\b/g, (_, n: string, coin: string) => {
      const name = COINS[coin] ?? coin;
      return `${n} ${n === "1" ? name.replace(/s$/, "") : name}`;
    })
    .replace(/\b(\d+)\s*ft\.?(?=\W|$)/g, "$1 feet")
    .replace(/\b(\d+)\s*lb\.?(?=\W|$)/g, "$1 pounds")
    .replace(/\bDC\b/g, "D C")
    .replace(/\bAC\b/g, "A C")
    .replace(/\bHP\b/g, "hit points")
    .replace(/\bXP\b/g, "X P");
}

// The text's paragraphs, each on one line, for the longer pause between them.
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map(normaliseText)
    .filter((paragraph) => paragraph.length > 0);
}

// Sentences joined where one of a pair is short, so "He nods. Then he leaves." is read in one go.
// The first piece can be held shorter, since nothing plays until it's made.
export function groupSentences(
  sentences: readonly string[],
  first = LONGEST,
): string[] {
  const groups: string[] = [];
  for (const sentence of sentences) {
    const last = groups.at(-1);
    if (
      last !== undefined &&
      (last.length < SHORT || sentence.length < SHORT) &&
      last.length + sentence.length < (groups.length === 1 ? first : LONGEST)
    ) {
      groups[groups.length - 1] = `${last} ${sentence}`;
    } else {
      groups.push(sentence);
    }
  }
  return groups;
}

// A piece without its own leading and trailing silence, faded at the cuts, after `pause` seconds of quiet.
export function evenOut(
  samples: Float32Array,
  rate: number,
  pause: number,
): Float32Array {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start] ?? 0) < QUIET) {
    start += 1;
  }
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1] ?? 0) < QUIET) end -= 1;
  end = Math.min(samples.length, end + Math.round(TAIL * rate));
  const lead = Math.round(pause * rate);
  const out = new Float32Array(lead + end - start);
  out.set(samples.subarray(start, end), lead);
  const fade = Math.min(Math.round(FADE * rate), Math.floor((end - start) / 2));
  for (let i = 0; i < fade; i += 1) {
    const gain = i / fade;
    out[lead + i] = (out[lead + i] ?? 0) * gain;
    out[out.length - 1 - i] = (out[out.length - 1 - i] ?? 0) * gain;
  }
  return out;
}

// What reads a piece of text: kokoro-js's KokoroTTS, or a stand-in in tests.
export interface PieceReader<Voice extends string> {
  generate(
    text: string,
    options: { voice: Voice },
  ): Promise<{ readonly audio: Float32Array; readonly sampling_rate: number }>;
}

// kokoro-js's TextSplitterStream, which knows where sentences end better than a pattern would.
export interface SentenceSplitter extends AsyncIterable<string> {
  push(text: string): void;
  close(): void;
}

// Reads the text a piece at a time, each ready to play as it comes, with the seconds it took to
// make and the length of each piece still to read after it, so a player can tell what's left.
export async function* readAloud<Voice extends string>(
  tts: PieceReader<Voice>,
  splitter: new () => SentenceSplitter,
  text: string,
  voice: Voice,
): AsyncGenerator<{
  readonly samples: Float32Array;
  readonly rate: number;
  readonly spent: number;
  readonly chars: number;
  readonly left: readonly number[];
}> {
  const pieces: { readonly text: string; readonly pause: number }[] = [];
  for (const [p, paragraph] of paragraphs(spokenText(text)).entries()) {
    const sentences = new splitter();
    sentences.push(paragraph);
    sentences.close();
    const found: string[] = [];
    for await (const sentence of sentences) found.push(sentence);
    for (const [g, piece] of groupSentences(
      found,
      p === 0 ? FIRST : LONGEST,
    ).entries()) {
      pieces.push({
        text: piece,
        pause: g > 0 ? SENTENCE_PAUSE : p > 0 ? PARAGRAPH_PAUSE : 0,
      });
    }
  }
  for (const [index, piece] of pieces.entries()) {
    const started = performance.now();
    const audio = await tts.generate(piece.text, { voice });
    yield {
      samples: evenOut(audio.audio, audio.sampling_rate, piece.pause),
      rate: audio.sampling_rate,
      spent: (performance.now() - started) / 1000,
      chars: piece.text.length,
      left: pieces.slice(index + 1).map((later) => later.text.length),
    };
  }
}

// Whether playing now goes to the end without stalling: each piece still to read has to be ready
// by the time playback reaches it, and comes whole. `ahead` seconds are ready to play, `unread`
// is the speech each piece to come will make, `making` the seconds the one being read has had, and
// `pace` the seconds it takes to make a second of speech. A margin covers the pace wavering.
export function canPlayThrough(
  ahead: number,
  unread: readonly number[],
  making: number,
  pace: number,
): boolean {
  let ready = -making; // when the next piece will be ready, in seconds from now
  let reached = ahead; // when playback will reach it
  for (const speech of unread) {
    ready += speech * pace * 1.15;
    if (ready > reached) return false;
    reached += speech;
  }
  return true;
}
