import { KokoroTTS, TextSplitterStream, env } from "kokoro-js";
import { KOKORO_MODEL } from "../story/narration.ts";

// Reads text aloud with Kokoro-82M off the page's thread, a sentence at a time, so playback can
// start before the whole scene is read. WebGPU when the device has it, else WASM on the CPU.
// The model comes from Hugging Face on first use and stays in the browser's cache after that.

export type NarrationRequest =
  | {
      readonly type: "speak";
      readonly id: number;
      readonly text: string;
      readonly voice: string;
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

const reply = (
  message: NarrationReply,
  transfer: Transferable[] = [],
): void => {
  postMessage(message, { transfer });
};

async function load(): Promise<KokoroTTS> {
  const started = performance.now();
  const adapter =
    "gpu" in navigator
      ? await navigator.gpu.requestAdapter().catch(() => null)
      : null;
  let percent = 0;
  const progress_callback = (info: { status: string; progress?: number }) => {
    // The model file dwarfs the rest, so its progress stands for the whole.
    if (info.status === "progress" && info.progress !== undefined) {
      const now = Math.floor(info.progress);
      if (now !== percent) {
        percent = now;
        reply({ type: "loading", percent });
      }
    }
  };
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

async function speak(id: number, text: string, voice: string): Promise<void> {
  if (cancelled.delete(id)) return;
  try {
    model ??= load();
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
  queue = queue.then(() => speak(request.id, request.text, request.voice));
});
