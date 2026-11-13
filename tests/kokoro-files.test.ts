import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  KOKORO_REVISION,
  KOKORO_VOICES,
  kokoroFetch,
  pickBackend,
  readAll,
  sha256,
} from "../engine/shell/kokoro-files.ts";
import { KOKORO_MODEL } from "../engine/story/narration.ts";

const HUB = `https://huggingface.co/${KOKORO_MODEL}/resolve`;
const voiceBytes = (voice: string) =>
  readFile(`node_modules/kokoro-js/voices/${voice}.bin`);

describe("fetching the narration model", () => {
  it("hashes like sha256sum", async () => {
    expect(await sha256(new TextEncoder().encode("abc").buffer)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("lists the same voices kokoro-js ships", async () => {
    for (const [voice, hash] of Object.entries(KOKORO_VOICES)) {
      const bytes = new Uint8Array(await voiceBytes(voice));
      expect(await sha256(bytes.buffer)).toBe(hash);
    }
  });

  it("refuses a pinned file whose bytes don't match", async () => {
    const fetch = kokoroFetch(() => Promise.resolve(new Response("evil")));
    await expect(
      fetch(`${HUB}/${KOKORO_REVISION}/onnx/model_quantized.onnx`),
    ).rejects.toThrow(/pinned hash/);
  });

  it("answers anything else on the hub with a 404, without asking it", async () => {
    const inner = vi.fn(() => Promise.resolve(new Response("x")));
    const fetch = kokoroFetch(inner);
    for (const url of [
      `${HUB}/main/onnx/model_quantized.onnx`,
      `${HUB}/${KOKORO_REVISION}/onnx/model_q4.onnx`,
      `${HUB}/${KOKORO_REVISION}/../x`,
      `${HUB}/main/voices/af_heart.bin`, // no bundled copy given
      `${HUB}/main/voices/am_adam.bin`,
      "https://huggingface.co/api/upload",
    ]) {
      expect((await fetch(url)).status).toBe(404);
    }
    expect(inner).not.toHaveBeenCalled();
  });

  it("reads a voice from its bundled copy, checked", async () => {
    const inner = vi.fn(async (url: string | URL | Request) =>
      url === "bundled/af_heart"
        ? new Response(await voiceBytes("af_heart"))
        : new Response("wrong"),
    );
    const fetch = kokoroFetch(inner, { voiceUrl: (v) => `bundled/${v}` });
    const response = await fetch(`${HUB}/main/voices/af_heart.bin`);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(522240);
    await expect(
      kokoroFetch(inner, { voiceUrl: () => "elsewhere" })(
        `${HUB}/main/voices/af_heart.bin`,
      ),
    ).rejects.toThrow(/pinned hash/);
  });

  it("reads a body past its Content-Length, as when it was compressed", async () => {
    const bytes = new Uint8Array(await voiceBytes("af_heart"));
    const seen: number[] = [];
    const response = new Response(new Blob([bytes]).stream(), {
      headers: { "Content-Length": String(bytes.length / 4) },
    });
    const read = await readAll(response, (percent) => seen.push(percent));
    expect(await sha256(read)).toBe(KOKORO_VOICES.af_heart);
    expect(seen.at(-1)).toBe(100);
  });

  it("passes the app's own requests through", async () => {
    const inner = vi.fn(() => Promise.resolve(new Response("wasm")));
    const response = await kokoroFetch(inner)("/assets/ort.wasm");
    expect(await response.text()).toBe("wasm");
  });
});

describe("choosing where the narrator reads", () => {
  it("takes the graphics card, then threads, then one thread", () => {
    expect(pickBackend(true, true, true, 8)).toEqual({
      device: "webgpu",
      threads: 4,
    });
    expect(pickBackend(false, true, true, 6)).toEqual({
      device: "wasm",
      threads: 3,
    });
    expect(pickBackend(false, false, false, 8)).toEqual({
      device: "wasm",
      threads: 1,
    });
  });

  it("stays on one thread when isolated without shared memory, as in WKWebView", () => {
    expect(pickBackend(false, true, false, 8).threads).toBe(1);
  });

  it("copes with a device that doesn't say how many cores it has", () => {
    expect(pickBackend(false, true, true, 0).threads).toBe(1);
  });
});
