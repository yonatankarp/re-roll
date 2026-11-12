import { env as hub } from "@huggingface/transformers";
import { KokoroTTS, TextSplitterStream, env } from "kokoro-js";
import { KOKORO_MODEL } from "../story/narration.ts";
import { KOKORO_PATH_TEMPLATE, kokoroFetch } from "./kokoro-files.ts";

// Reads text aloud with Kokoro-82M off the page's thread, a sentence at a time, so playback can
// start before the whole scene is read. WebGPU when the device has it, else WASM on the CPU.
// The model comes from Hugging Face on first use, from a pinned commit and checked against its
// hashes (kokoro-files.ts), and stays in the browser's cache after that. The voices ship with the app.

export type NarrationRequest =
  | {
      readonly type: "speak";
      readonly id: number;
      readonly text: string;
      readonly voice: string;
      readonly cpu: boolean; // skip WebGPU, as after a reading hung on it
    }
  | { readonly type: "cancel"; readonly id: number };

export type NarrationReply =
  | { readonly type: "loading"; readonly percent: number }
  | {
      readonly type: "ready";
      readonly device: string;
      readonly seconds: number;
    }
  | {
      readonly type: "chunk";
      readonly id: number;
      readonly samples: Float32Array;
      readonly rate: number;
    }
  | {
      readonly type: "done";
      readonly id: number;
      readonly seconds: number; // spent reading
      readonly audio: number; // seconds of speech made
    }
  | { readonly type: "error"; readonly id: number; readonly message: string };

// The ONNX runtime's WASM ships with the app rather than coming from a CDN.
env.wasmPaths = {
  wasm: new URL(
    "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm",
    import.meta.url,
  ).href,
};

// Bundled with the app, so a voice never comes from the network.
const VOICE_URLS: Readonly<Record<string, string>> = {
  af_heart: new URL(
    "../../node_modules/kokoro-js/voices/af_heart.bin",
    import.meta.url,
  ).href,
  bm_george: new URL(
    "../../node_modules/kokoro-js/voices/bm_george.bin",
    import.meta.url,
  ).href,
  bf_emma: new URL(
    "../../node_modules/kokoro-js/voices/bf_emma.bin",
    import.meta.url,
  ).href,
};

// The pinned commit is also in the cache key, so copies fetched from main before aren't reused.
hub.remotePathTemplate = KOKORO_PATH_TEMPLATE;
// Without the Cache API the model is downloaded again each launch, rather than failing to load.
hub.useBrowserCache = typeof caches !== "undefined";
let downloaded: (percent: number) => void = () => undefined;
globalThis.fetch = kokoroFetch(fetch.bind(globalThis), {
  voiceUrl: (voice) => VOICE_URLS[voice],
  progress: (percent) => {
    downloaded(percent);
  },
});

const reply = (
  message: NarrationReply,
  transfer: Transferable[] = [],
): void => {
  postMessage(message, { transfer });
};

async function load(cpu: boolean): Promise<KokoroTTS> {
  const started = performance.now();
  const adapter =
    !cpu && "gpu" in navigator
      ? await navigator.gpu.requestAdapter().catch(() => null)
      : null;
  let percent = 0;
  const show = (now: number): void => {
    if (now !== percent) {
      percent = now;
      reply({ type: "loading", percent });
    }
  };
  // While the hash check holds the download back, kokoroFetch reports it instead.
  downloaded = show;
  const progress_callback = (info: { status: string; progress?: number }) => {
    // The model file dwarfs the rest, so its progress stands for the whole.
    if (info.status === "progress" && info.progress !== undefined) {
      show(Math.floor(info.progress));
    }
  };
  // Voices kokoro-js cached from the network before are dropped, so the checked bundled ones are read.
  if (typeof caches !== "undefined") {
    await caches.delete("kokoro-voices").catch(() => false);
  }
  const ready = (tts: KokoroTTS, device: string): KokoroTTS => {
    reply({
      type: "ready",
      device,
      seconds: (performance.now() - started) / 1000,
    });
    return tts;
  };
  if (adapter) {
    try {
      // Kokoro's advice: full precision on WebGPU, where quantised weights read badly.
      return ready(
        await KokoroTTS.from_pretrained(KOKORO_MODEL, {
          dtype: "fp32",
          device: "webgpu",
          progress_callback,
        }),
        "webgpu",
      );
    } catch {
      // Fall through to the CPU.
    }
  }
  return ready(
    await KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback,
    }),
    "wasm",
  );
}

let model: Promise<KokoroTTS> | null = null;
let queue = Promise.resolve();
// Read in the order asked; the page cancels what it no longer wants, such as read-ahead
// for a scene the player didn't pick, and a cancelled reading stops at its next sentence.
const cancelled = new Set<number>();

async function speak(
  id: number,
  text: string,
  voice: string,
  cpu: boolean,
): Promise<void> {
  if (cancelled.delete(id)) return;
  try {
    model ??= load(cpu); // a worker loads once, so the first request picks the device
    const tts = await model;
    const started = performance.now();
    let audio = 0;
    // kokoro-js 1.2.1 never closes the splitter it makes for a plain string, so stream() would hang.
    const sentences = new TextSplitterStream();
    sentences.push(text);
    sentences.close();
    for await (const chunk of tts.stream(sentences, {
      voice: voice as "af_heart",
    })) {
      if (cancelled.delete(id)) return;
      const samples = chunk.audio.audio;
      audio += samples.length / chunk.audio.sampling_rate;
      reply({ type: "chunk", id, samples, rate: chunk.audio.sampling_rate }, [
        samples.buffer,
      ]);
    }
    reply({
      type: "done",
      id,
      seconds: (performance.now() - started) / 1000,
      audio,
    });
  } catch (error) {
    model = null; // a failed load can be tried again later
    reply({ type: "error", id, message: String(error) });
  }
}

addEventListener("message", (event: MessageEvent<NarrationRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.id);
    return;
  }
  queue = queue.then(() =>
    speak(request.id, request.text, request.voice, request.cpu),
  );
});
