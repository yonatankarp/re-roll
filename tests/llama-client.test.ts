import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlamaClient,
  isLoopbackUrl,
} from "../engine/platform/node/llama-client.ts";

describe("the LLM client", () => {
  it.each([
    "http://127.0.0.1:8181",
    "http://localhost:8181",
    "http://[::1]:8181",
    "http://LOCALHOST:8181",
  ])("talks to %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    "http://127.0.0.1.evil.com",
    "http://localhost@evil.com",
    "http://localhost.evil.com:8181",
    "http://0.0.0.0:8181",
    "http://192.168.1.2:8181",
    "https://api.example.com",
    "127.0.0.1:8181",
    "",
  ])("refuses %j", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
    expect(() => createLlamaClient(url)).toThrow(/allow-remote/);
  });

  it("goes off the machine only when told to", () => {
    expect(() =>
      createLlamaClient("https://api.example.com", { allowRemote: true }),
    ).not.toThrow();
  });
});

describe("the LLM client's replies", () => {
  const request = {
    system: "s",
    prompt: "p",
    schema: {},
    maxTokens: 10,
    temperature: 0,
    seed: 1,
  };
  const serving = (reply: (signal: AbortSignal) => Promise<Response>) => {
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) =>
      reply(init.signal),
    );
  };
  afterEach(() => vi.unstubAllGlobals());

  it("gives up on a server that stops answering, saying so", async () => {
    serving(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
    );
    const client = createLlamaClient("http://127.0.0.1:1", { timeoutMs: 20 });
    await expect(client.complete(request)).rejects.toThrow("didn't answer");
  });

  it.each([
    ["not JSON", "<html>", "isn't JSON"],
    [
      "no choices",
      JSON.stringify({ choices: [], usage: {} }),
      "isn't a chat completion",
    ],
    [
      "the wrong shape",
      JSON.stringify({ text: "hi" }),
      "isn't a chat completion",
    ],
  ])("says a reply with %s isn't one it can read", async (_, body, message) => {
    serving(() => Promise.resolve(new Response(body, { status: 200 })));
    const client = createLlamaClient("http://127.0.0.1:1");
    await expect(client.complete(request)).rejects.toThrow(message);
  });

  it("reads a chat completion", async () => {
    serving(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
            usage: { completion_tokens: 3 },
          }),
        ),
      ),
    );
    const reply =
      await createLlamaClient("http://127.0.0.1:1").complete(request);
    expect(reply).toMatchObject({
      text: "{}",
      finishReason: "stop",
      completionTokens: 3,
    });
  });
});
