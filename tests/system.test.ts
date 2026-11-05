import {
  ContentEntrySchema,
  type ContentEntry,
  type GameSystem,
  SDK_VERSION,
  defineSystem,
} from "#sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { d6System } from "./fixtures/system-d6/index.ts";

const valid: GameSystem = { ...d6System };

describe("defineSystem", () => {
  it("resolves #sdk and accepts a valid system", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(defineSystem(valid).id).toBe("d6");
  });

  it.each<[string, Partial<GameSystem>, string]>([
    ["an invalid id", { id: "Not Valid" }, "invalid id"],
    ["a bad version", { version: "1" }, "version"],
    ["an incompatible SDK", { sdk: "^99" }, "needs SDK"],
    ["no outcomes", { outcomes: { keys: [] } }, "at least one outcome"],
    ["duplicate outcomes", { outcomes: { keys: ["a", "a"] } }, "unique"],
    [
      "a group named like a key",
      { outcomes: { keys: ["a"], groups: { a: ["a"] } } },
      "same name",
    ],
    [
      "a group with an unknown key",
      { outcomes: { keys: ["a"], groups: { g: ["b"] } } },
      "unknown key",
    ],
    [
      "a reserved content folder",
      { contentKinds: { assets: d6System.contentKinds.foes as never } },
      "reserved",
    ],
    [
      "an unnamespaced effect",
      {
        storyEffects: { gainLuck: { schema: z.unknown(), apply: () => ({}) } },
      },
      "namespaced",
    ],
    [
      "an unnamespaced predicate",
      {
        storyPredicates: {
          hasLuck: { schema: z.unknown(), evaluate: () => true },
        },
      },
      "namespaced",
    ],
  ])("rejects %s", (_name, override, message) => {
    expect(() => defineSystem({ ...valid, ...override })).toThrow(message);
  });
});

describe("Zod with exactOptionalPropertyTypes", () => {
  it("lets parsed optional fields flow into engine types", () => {
    const parsed = ContentEntrySchema.parse({ id: "a:b/c" });
    const entry: ContentEntry = parsed;
    expect(entry.replaces).toBeUndefined();
    expect("replaces" in entry).toBe(false);
  });
});
