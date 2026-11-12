import { afterEach, describe, expect, it, vi } from "vitest";
import { imageCache, isNotFound } from "../engine/platform/tauri/files.ts";

describe("isNotFound", () => {
  it("is true for a missing file or folder, and false for a refused path", () => {
    const open = "failed to open file at path: /x/a.yaml with error:";
    expect(isNotFound(`${open} No such file or directory (os error 2)`)).toBe(
      true,
    );
    expect(
      isNotFound(
        `${open} The system cannot find the path specified. (os error 3)`,
      ),
    ).toBe(true);
    expect(isNotFound("forbidden path: /etc/passwd")).toBe(false);
    expect(isNotFound(`${open} Permission denied (os error 13)`)).toBe(false);
  });
});

describe("imageCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bytes = (size: number) => () =>
    Promise.resolve(new Uint8Array(new ArrayBuffer(size)));

  it("reuses a URL, and revokes the oldest once over budget", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const images = imageCache(10);
    const a = await images("a", bytes(4));
    const b = await images("b", bytes(4));
    expect(await images("a", bytes(4))).toBe(a); // now the newest
    const c = await images("c", bytes(4));
    expect(revoke.mock.calls).toEqual([[b]]);
    expect(await images("b", bytes(4))).not.toBe(b);
    expect(revoke.mock.calls).toEqual([[b], [a]]);
    expect(await images("c", bytes(4))).toBe(c);
  });

  it("keeps an image bigger than the whole budget until the next one", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const images = imageCache(10);
    const big = await images("big", bytes(50));
    expect(revoke).not.toHaveBeenCalled();
    await images("small", bytes(1));
    expect(revoke.mock.calls).toEqual([[big]]);
  });

  it("gives null for a file that won't load", async () => {
    const images = imageCache(10);
    expect(await images("gone", () => Promise.reject(new Error("no")))).toBe(
      null,
    );
  });
});
