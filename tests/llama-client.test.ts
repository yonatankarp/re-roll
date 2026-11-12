import { describe, expect, it } from "vitest";
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
