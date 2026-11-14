import { describe, expect, it } from "vitest";
import type { StoreIndex, StorePackage } from "../engine/shell/store-index.ts";
import {
  installOrder,
  packageStatus,
  parseRepo,
  readStoreState,
  sha256,
  verifyDownload,
} from "../engine/shell/store.ts";

const pkg = (
  id: string,
  plugins: [string, string[]][] = [[id, []]],
  hash = "a".repeat(64),
): StorePackage => ({
  id,
  title: id.toUpperCase(),
  file: `${id}.zip`,
  size: 3,
  sha256: hash,
  parts: plugins.map(([plugin]) => `rules/${plugin}`),
  plugins: plugins.map(([plugin, requires]) => ({
    id: plugin,
    kind: "rules",
    version: "1.0.0",
    distribution: "private",
    requires,
  })),
});
const index = (...packages: StorePackage[]): StoreIndex => ({
  format: 1,
  packages,
});

describe("parseRepo", () => {
  it("takes owner/repo, or any GitHub link into the repo", () => {
    for (const input of [
      "owner/repo",
      " owner/repo ",
      "https://github.com/owner/repo",
      "github.com/owner/repo.git",
      "https://www.github.com/owner/repo/releases/tag/store?x=1",
    ])
      expect(parseRepo(input)).toBe("owner/repo");
    for (const input of [
      "",
      "owner",
      "https://gitlab.com/owner/repo",
      "-owner/repo",
      "owner/..",
      "owner/re po",
      "a@b/c",
    ])
      expect(parseRepo(input), input).toBeNull();
  });
});

describe("readStoreState", () => {
  it("starts empty from nothing, or from a record it can't read", () => {
    const empty = { repos: [], installed: {} };
    expect(readStoreState(null)).toEqual(empty);
    expect(readStoreState("not json")).toEqual(empty);
    expect(readStoreState('{"repos": 3}')).toEqual(empty);
    expect(readStoreState('{"repos": ["a/b"]}')).toEqual({
      repos: ["a/b"],
      installed: {},
    });
  });
});

describe("verifyDownload", () => {
  it("passes only the exact file the index lists", async () => {
    const bytes = new TextEncoder().encode("abc");
    const listed = pkg("phb", [["phb", []]], await sha256(bytes));
    await expect(verifyDownload(bytes, listed)).resolves.toBeUndefined();
    await expect(
      verifyDownload(new TextEncoder().encode("abd"), listed),
    ).rejects.toThrow(/didn't download/);
    await expect(
      verifyDownload(new TextEncoder().encode("ab"), listed),
    ).rejects.toThrow(/didn't download/);
  });
});

describe("packageStatus", () => {
  it("tells an install from an update by the hash it came with", () => {
    const phb = pkg("phb");
    const state = (sha: string, repo = "a/store") => ({
      repos: [],
      installed: { phb: { repo, sha256: sha } },
    });
    const none = new Set<string>();
    expect(packageStatus("a/store", phb, state(phb.sha256), none)).toBe(
      "installed",
    );
    expect(packageStatus("a/store", phb, state("b".repeat(64)), none)).toBe(
      "update",
    );
    expect(
      packageStatus("a/store", phb, { repos: [], installed: {} }, none),
    ).toBe("install");
    // From a zip, or another store: its plugins are there, so it can only be put in again.
    expect(
      packageStatus(
        "a/store",
        phb,
        state(phb.sha256, "b/store"),
        new Set(["phb"]),
      ),
    ).toBe("present");
  });
});

describe("installOrder", () => {
  const phb = pkg("phb");
  const mm = pkg("monster-manual", [["monster-manual", ["phb"]]]);
  const adventure = pkg("deadfall", [
    ["deadfall", ["srd52", "phb", "monster-manual"]],
  ]);

  it("installs what a package needs first, once each, skipping what the game has", () => {
    const stores = new Map([["a/store", index(adventure, mm, phb)]]);
    expect(
      installOrder(
        { repo: "a/store", pkg: adventure },
        stores,
        new Set(["srd52"]),
      ).map(({ pkg: step }) => step.id),
    ).toEqual(["phb", "monster-manual", "deadfall"]);
    expect(
      installOrder(
        { repo: "a/store", pkg: adventure },
        stores,
        new Set(["srd52", "phb", "monster-manual"]),
      ).map(({ pkg: step }) => step.id),
    ).toEqual(["deadfall"]);
  });

  it("looks in the package's own store first, then in the others", () => {
    const stores = new Map([
      ["b/other", index(pkg("phb", [["phb", []]], "b".repeat(64)))],
      ["a/store", index(mm, phb)],
    ]);
    expect(
      installOrder({ repo: "a/store", pkg: mm }, stores, new Set()).map(
        ({ repo }) => repo,
      ),
    ).toEqual(["a/store", "a/store"]);
    const elsewhere = new Map([
      ["b/other", index(phb)],
      ["a/store", index(mm)],
    ]);
    expect(
      installOrder({ repo: "a/store", pkg: mm }, elsewhere, new Set()).map(
        ({ repo, pkg: step }) => `${repo}:${step.id}`,
      ),
    ).toEqual(["b/other:phb", "a/store:monster-manual"]);
  });

  it("says which plugin no store has", () => {
    expect(() =>
      installOrder(
        { repo: "a/store", pkg: mm },
        new Map([["a/store", index(mm)]]),
        new Set(),
      ),
    ).toThrow(/needs phb/);
  });
});
