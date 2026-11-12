import { KOKORO_MODEL } from "../story/narration.ts";

// The Kokoro files come from one pinned commit and are checked against these hashes before the
// ONNX runtime parses them, so a changed or compromised upstream can't feed it anything else.
// The ONNX hashes are Hugging Face's LFS ids for that commit; the JSON ones were hashed by hand.
export const KOKORO_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const KOKORO_PATH_TEMPLATE = `{model}/resolve/${KOKORO_REVISION}/`;

export const KOKORO_FILES: Readonly<Record<string, string>> = {
  "config.json":
    "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
  "tokenizer.json":
    "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  "tokenizer_config.json":
    "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  "onnx/model.onnx":
    "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb", // fp32, for WebGPU
  "onnx/model_quantized.onnx":
    "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478", // q8, for the CPU
};

// The same as kokoro-js 1.2.1's own copies in node_modules/kokoro-js/voices.
export const KOKORO_VOICES: Readonly<Record<string, string>> = {
  af_heart: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
  bm_george: "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
  bf_emma: "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73",
};

const HUB = "https://huggingface.co/";
const PINNED = `${HUB}${KOKORO_MODEL}/resolve/${KOKORO_REVISION}/`;
// kokoro-js fetches voices from main in a browser, so those are answered from the bundled copies.
const VOICES = `${HUB}${KOKORO_MODEL}/resolve/main/voices/`;

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface KokoroFetchOptions {
  // Where a voice's bundled copy is, if this platform serves one.
  readonly voiceUrl?: (voice: string) => string | undefined;
  // Download progress of the model file, which the hash check holds back from the loader.
  readonly progress?: (percent: number) => void;
}

export async function readAll(
  response: Response,
  progress?: (percent: number) => void,
): Promise<ArrayBuffer> {
  const total = Number(response.headers.get("Content-Length"));
  if (!progress || !response.body || !total) return response.arrayBuffer();
  let bytes = new Uint8Array(total);
  let loaded = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // A compressed body decodes past its Content-Length.
    if (loaded + value.length > bytes.length) {
      const bigger = new Uint8Array(
        Math.max(bytes.length * 2, loaded + value.length),
      );
      bigger.set(bytes.subarray(0, loaded));
      bytes = bigger;
    }
    bytes.set(value, loaded);
    loaded += value.length;
    progress(Math.min(100, Math.floor((loaded / total) * 100)));
  }
  return bytes.buffer.slice(0, loaded);
}

// Wraps fetch so Hugging Face is reached only for the pinned files, and each arrives with its hash.
// Anything else on the hub is a 404; other URLs, such as the app's own, pass through.
export function kokoroFetch(
  inner: typeof fetch,
  { voiceUrl, progress }: KokoroFetchOptions = {},
): typeof fetch {
  const checked = async (
    url: string,
    expected: string,
    init?: RequestInit,
    onProgress?: (percent: number) => void,
  ): Promise<Response> => {
    const response = await inner(url, init);
    if (!response.ok) return response;
    const bytes = await readAll(response, onProgress);
    if ((await sha256(bytes)) !== expected) {
      throw new Error(`${url} doesn't match its pinned hash`);
    }
    return new Response(bytes, { status: 200, headers: response.headers });
  };
  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(HUB)) return inner(input, init);
    const file = url.startsWith(PINNED) ? url.slice(PINNED.length) : "";
    const model = Object.hasOwn(KOKORO_FILES, file) ? KOKORO_FILES[file] : "";
    if (model) {
      return checked(
        url,
        model,
        init,
        file.endsWith(".onnx") ? progress : undefined,
      );
    }
    const voice = url.startsWith(VOICES)
      ? url.slice(VOICES.length).replace(/\.bin$/, "")
      : "";
    const hash = Object.hasOwn(KOKORO_VOICES, voice)
      ? KOKORO_VOICES[voice]
      : "";
    const bundled = hash ? voiceUrl?.(voice) : undefined;
    if (hash && bundled) return checked(bundled, hash);
    return Promise.resolve(new Response(null, { status: 404 }));
  };
}
