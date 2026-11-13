import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { scanPlugins } from "../../engine/run/loader.ts";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import {
  KOKORO_FILES,
  KOKORO_PATH_TEMPLATE,
  kokoroFetch,
  sha256,
} from "../../engine/shell/kokoro-files.ts";
import { readAloud } from "../../engine/shell/read-aloud.ts";
import {
  DEFAULT_VOICE,
  EMPTY_INDEX,
  KOKORO_MODEL,
  NARRATION_FOLDER,
  NARRATION_INDEX,
  NARRATOR_VOICES,
  type NarrationClip,
  type NarrationIndex,
  NarrationIndexSchema,
  narratedTexts,
  planNarration,
} from "../../engine/story/narration.ts";
import {
  PLUGIN_ROOTS,
  listAdventures,
  loadAdventure,
} from "./load-adventure.ts";

// Reads each scene aloud once with Kokoro-82M and keeps the clips beside the adventure:
//   npm run narrate -- <adventure> [--voice=af_heart]
// Unchanged text is skipped; changed text is read again and its old clip removed.
// Only for adventures under books/, since the clips are made from book text. Needs ffmpeg.

// Kokoro's phonemiser rethrows uncaught errors with its whole source, so say what went wrong plainly.
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const SAMPLE_RATE = 24000;

const args = process.argv.slice(2);
const adventure = args.find((arg) => !arg.startsWith("--"));
const voice =
  args.find((arg) => arg.startsWith("--voice="))?.slice("--voice=".length) ??
  DEFAULT_VOICE;
if (!adventure) {
  console.log(`Adventures: ${(await listAdventures()).join(", ")}`);
  console.log(
    `Usage: npm run narrate -- <adventure> [--voice=${NARRATOR_VOICES.map((item) => item.id).join("|")}]`,
  );
  process.exit(0);
}
if (!NARRATOR_VOICES.some((item) => item.id === voice)) {
  fail(`Unknown voice ${voice}`);
}

const catalog = await scanPlugins(
  await createNodeStorage(process.cwd()),
  PLUGIN_ROOTS,
);
const root = catalog.plugins.get(adventure)?.root;
if (!root?.startsWith("books/")) {
  fail(
    `${adventure} isn't a private adventure here; shipped ones are read aloud in the app`,
  );
}
const folder = join(process.cwd(), root, NARRATION_FOLDER);
const indexPath = join(process.cwd(), root, NARRATION_INDEX);
const { registry } = await loadAdventure(adventure);
const story = registry.adventure(adventure);
if (!story) fail(`${adventure} has no scenes`);

let saved: string | null = null;
try {
  saved = await readFile(indexPath, "utf8");
} catch {
  // No index yet, so every clip is made.
}
let index: NarrationIndex = EMPTY_INDEX;
if (saved !== null) {
  // Stale keys are deleted below, so a key like ../x must never get that far.
  const checked = NarrationIndexSchema.safeParse(parse(saved));
  if (!checked.success) fail(`${indexPath} isn't a valid narration index`);
  index = checked.data;
}
const sizes = new Map<string, number>();
for (const file of Object.keys(index.clips)) {
  try {
    sizes.set(file, (await stat(join(folder, file))).size);
  } catch {
    // Missing, so it's made again.
  }
}
const plan = planNarration(index, narratedTexts(story), voice, (file) =>
  sizes.has(file),
);
console.log(
  `${adventure}, ${voice}: ${String(plan.make.length)} to read, ${String(plan.keep.length)} unchanged, ${String(plan.stale.length)} stale`,
);

function encode(samples: Float32Array, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1"],
        ...["-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "48k", out],
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    ffmpeg.on("error", (error) => {
      reject(new Error(`ffmpeg is needed to compress clips: ${error.message}`));
    });
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${String(code)}`));
    });
    ffmpeg.stdin.end(
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
    );
  });
}

const clips = new Map<string, NarrationClip>(Object.entries(index.clips));
const save = (): Promise<void> =>
  writeFile(
    indexPath,
    stringify({ version: 1, clips: Object.fromEntries(clips) }),
  );

for (const file of plan.stale) {
  await rm(join(folder, file), { force: true });
  clips.delete(file);
}

if (plan.make.length > 0) {
  let started = performance.now();
  const { KokoroTTS, TextSplitterStream } = await import("kokoro-js");
  // From a pinned commit, each file checked against its hash (engine/shell/kokoro-files.ts).
  const { env: hub } = await import("@huggingface/transformers");
  hub.remotePathTemplate = KOKORO_PATH_TEMPLATE;
  hub.allowLocalModels = false; // its local folder would be read without a check
  globalThis.fetch = kokoroFetch(globalThis.fetch);
  // Node's file cache ignores the commit, so a copy cached before is checked here instead.
  for (const [file, hash] of Object.entries(KOKORO_FILES)) {
    const cached = join(hub.cacheDir, KOKORO_MODEL, file);
    const bytes = await readFile(cached).catch(() => null);
    if (bytes && (await sha256(new Uint8Array(bytes).buffer)) !== hash) {
      console.log(`Dropping ${cached}, which doesn't match its pinned hash`);
      await rm(cached);
    }
  }
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: "q8",
    device: "cpu",
  });
  console.log(
    `Model ready in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  for (const [number, item] of plan.make.entries()) {
    started = performance.now();
    const parts: Float32Array[] = [];
    for await (const piece of readAloud(
      tts,
      TextSplitterStream,
      item.text,
      voice as "af_heart", // kokoro-js checks it against its list
    )) {
      parts.push(piece.samples);
    }
    const samples = new Float32Array(
      parts.reduce((total, part) => total + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    const out = join(folder, item.file);
    await mkdir(dirname(out), { recursive: true });
    await encode(samples, out).catch((error: unknown) => {
      fail(String(error));
    });
    sizes.set(item.file, (await stat(out)).size);
    const seconds = samples.length / SAMPLE_RATE;
    clips.set(item.file, {
      scene: item.scene,
      voice,
      seconds: Math.round(seconds * 10) / 10,
    });
    await save(); // after each clip, so a stopped run keeps what it made
    const took = (performance.now() - started) / 1000;
    console.log(
      `${String(number + 1)}/${String(plan.make.length)} ${item.scene}: ${String(item.text.length)} chars, ${seconds.toFixed(1)}s of audio in ${took.toFixed(1)}s`,
    );
  }
}
await mkdir(folder, { recursive: true });
await save();
const bytes = [...clips.keys()].reduce(
  (total, file) => total + (sizes.get(file) ?? 0),
  0,
);
console.log(
  `${String(clips.size)} clips, ${(bytes / 1e6).toFixed(1)} MB in ${root}/${NARRATION_FOLDER}`,
);
