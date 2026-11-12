import { describe, expect, it } from "vitest";
import type { LoadResult } from "../engine/run/loader.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { checkPlugins } from "../engine/tools/check-pack.ts";
import { d6System } from "./fixtures/system-d6/index.ts";
import { memoryStorage } from "./memory-storage.ts";

interface ManifestOptions {
  readonly kind?: string;
  readonly system?: string;
  readonly version?: string;
  readonly sdk?: string;
  readonly requires?: readonly (readonly [string, string])[];
}

function manifest(id: string, options: ManifestOptions = {}): string {
  const requires = (options.requires ?? [])
    .map(
      ([plugin, version]) => `  - { plugin: ${plugin}, version: "${version}" }`,
    )
    .join("\n");
  return [
    `id: ${id}`,
    `kind: ${options.kind ?? "rules"}`,
    `version: ${options.version ?? "1.0.0"}`,
    `sdk: "${options.sdk ?? "^1"}"`,
    `system: "${options.system ?? "d6@^1"}"`,
    requires ? `requires:\n${requires}` : "",
    "distribution: shipped",
  ].join("\n");
}

const ENDING_SCENES = "- { id: start, text: The end. }\n";

function adventureFiles(
  id: string,
  documents: Readonly<Record<string, string>> = {},
  options: ManifestOptions = {},
): Record<string, string> {
  const files: Record<string, string> = {
    [`plugins/adventures/${id}/plugin.yaml`]: manifest(id, {
      kind: "adventure",
      ...options,
    }),
    [`plugins/adventures/${id}/adventure.yaml`]:
      "title: Test\nstartScene: start\n",
    [`plugins/adventures/${id}/scenes.yaml`]: ENDING_SCENES,
  };
  for (const [name, text] of Object.entries(documents)) {
    files[`plugins/adventures/${id}/${name}`] = text;
  }
  return files;
}

async function load(
  files: Readonly<Record<string, string>>,
  requested: readonly string[],
  symlinks: readonly string[] = [],
): Promise<LoadResult> {
  const storage = memoryStorage(files, symlinks);
  const catalog = await scanPlugins(storage, ["plugins"]);
  return loadRun(storage, catalog, [d6System], requested);
}

async function errorsOf(
  files: Readonly<Record<string, string>>,
  requested: readonly string[],
  symlinks: readonly string[] = [],
): Promise<string> {
  const result = await load(files, requested, symlinks);
  return result.ok
    ? ""
    : result.issues.map((issue) => issue.message).join("\n");
}

const rules = (
  id: string,
  options: ManifestOptions = {},
): Record<string, string> => ({
  [`plugins/rules/${id}/plugin.yaml`]: manifest(id, options),
});

describe("plugin selection", () => {
  it("loads dependencies first", async () => {
    const result = await load(
      {
        ...rules("a", { requires: [["b", "^1"]] }),
        ...rules("b", { requires: [["c", "^1"]] }),
        ...rules("c"),
      },
      ["a"],
    );
    expect(
      result.ok && result.registry.plugins.map((plugin) => plugin.id),
    ).toEqual(["c", "b", "a"]);
  });

  it("reports a missing dependency", async () => {
    expect(
      await errorsOf(rules("a", { requires: [["b", "^1"]] }), ["a"]),
    ).toContain('missing plugin "b"');
  });

  it("reports a dependency cycle", async () => {
    const files = {
      ...rules("a", { requires: [["b", "^1"]] }),
      ...rules("b", { requires: [["a", "^1"]] }),
    };
    expect(await errorsOf(files, ["a"])).toContain("dependency cycle");
  });

  it("reports a dependency version mismatch", async () => {
    const files = { ...rules("a", { requires: [["b", "^2"]] }), ...rules("b") };
    expect(await errorsOf(files, ["a"])).toContain('needs "b" ^2, found 1.0.0');
  });

  it("reports an SDK mismatch", async () => {
    expect(await errorsOf(rules("a", { sdk: "^9" }), ["a"])).toContain(
      "needs SDK ^9",
    );
  });

  it("reports a system version mismatch", async () => {
    expect(await errorsOf(rules("a", { system: "d6@^9" }), ["a"])).toContain(
      "needs system d6 ^9",
    );
  });

  it("reports an unknown system", async () => {
    expect(await errorsOf(rules("a", { system: "other@^1" }), ["a"])).toContain(
      'unknown system "other"',
    );
  });

  it("refuses to mix systems in one run", async () => {
    const files = { ...rules("a"), ...rules("b", { system: "other@^1" }) };
    expect(await errorsOf(files, ["a", "b"])).toContain(
      "a run uses one system",
    );
  });

  it("reports duplicate plugin ids across roots", async () => {
    const storage = memoryStorage({
      "plugins/rules/a/plugin.yaml": manifest("a"),
      "books/rules/a/plugin.yaml": manifest("a"),
    });
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    expect(catalog.issues[0]?.message).toContain("duplicate plugin id");
  });

  it("requires the folder name to match the manifest id", async () => {
    const storage = memoryStorage({
      "plugins/rules/a/plugin.yaml": manifest("b"),
    });
    const catalog = await scanPlugins(storage, ["plugins"]);
    expect(catalog.issues[0]?.message).toContain("must match its folder name");
  });

  it("requires the plugin kind to match its parent folder", async () => {
    const storage = memoryStorage({
      "plugins/rules/a/plugin.yaml": manifest("a", { kind: "adventure" }),
    });
    const catalog = await scanPlugins(storage, ["plugins"]);
    expect(catalog.issues[0]?.message).toContain("does not belong in rules/");
  });

  it("reports malformed YAML rather than throwing", async () => {
    const storage = memoryStorage({
      "plugins/rules/a/plugin.yaml": "id: [unclosed",
    });
    const catalog = await scanPlugins(storage, ["plugins"]);
    expect(catalog.issues[0]?.message).toContain("cannot read");
  });
});

describe("data plugin safety", () => {
  it.each([
    "script.js",
    "script.mjs",
    "script.ts",
    "page.html",
    "logic.wasm",
    "image.svg",
    "noextension",
  ])("rejects %s", async (name) => {
    const files = { ...rules("a"), [`plugins/rules/a/${name}`]: "x" };
    expect(await errorsOf(files, ["a"])).toContain("file type is not allowed");
  });

  it("rejects symlinks", async () => {
    expect(
      await errorsOf(rules("a"), ["a"], ["plugins/rules/a/link.yaml"]),
    ).toContain("symlinks are not allowed");
  });

  it.each([
    "../../secret.png",
    "/etc/passwd",
    "assets/../../secret.png",
    "C:\\secret.png",
  ])("rejects the asset path %s", async (path) => {
    const scenes = `- { id: start, text: The end., art: "${path.replaceAll("\\", "\\\\")}" }\n`;
    expect(
      await errorsOf(adventureFiles("a", { "scenes.yaml": scenes }), ["a"]),
    ).toMatch(/must/);
  });

  it("reports a missing asset", async () => {
    const scenes = "- { id: start, text: The end., art: assets/missing.png }\n";
    expect(
      await errorsOf(adventureFiles("a", { "scenes.yaml": scenes }), ["a"]),
    ).toContain("missing asset");
  });

  it("accepts an existing asset", async () => {
    const scenes = "- { id: start, text: The end., art: assets/ok.png }\n";
    const files = adventureFiles("a", {
      "scenes.yaml": scenes,
      "assets/ok.png": "x",
    });
    expect(await errorsOf(files, ["a"])).toBe("");
  });
});

describe("content", () => {
  const trick = (id: string, extra = ""): string =>
    `- { id: "${id}", name: Trick${extra} }\n`;

  it("reports an unknown content folder", async () => {
    const files = { ...rules("a"), "plugins/rules/a/spells/x.yaml": "[]" };
    expect(await errorsOf(files, ["a"])).toContain(
      'unknown content folder "spells"',
    );
  });

  it("reports an unknown top-level file", async () => {
    const files = { ...rules("a"), "plugins/rules/a/extra.yaml": "[]" };
    expect(await errorsOf(files, ["a"])).toContain("unknown file");
  });

  it("reports schema errors with their path", async () => {
    const files = {
      ...rules("a"),
      "plugins/rules/a/foes/x.yaml": '- { id: "a:foe/x", name: X, menace: 9 }',
    };
    expect(await errorsOf(files, ["a"])).toContain("0.menace");
  });

  it("requires ids to carry the plugin and kind", async () => {
    const files = {
      ...rules("a"),
      "plugins/rules/a/tricks/x.yaml": trick("b:trick/x"),
    };
    expect(await errorsOf(files, ["a"])).toContain(
      'must start with "a:trick/"',
    );
  });

  it("reports duplicate ids", async () => {
    const files = {
      ...rules("a"),
      "plugins/rules/a/tricks/x.yaml": trick("a:trick/x") + trick("a:trick/x"),
    };
    expect(await errorsOf(files, ["a"])).toContain('duplicate id "a:trick/x"');
  });

  it("reports a missing reference", async () => {
    const files = {
      ...rules("a"),
      "plugins/rules/a/foes/x.yaml":
        '- { id: "a:foe/x", name: X, menace: 1, trick: "a:trick/nope" }',
    };
    expect(await errorsOf(files, ["a"])).toContain(
      'unknown reference "a:trick/nope"',
    );
  });

  it("requires a plugin to declare what it references", async () => {
    const files = {
      ...rules("a"),
      ...rules("b"),
      "plugins/rules/a/tricks/x.yaml": trick("a:trick/x"),
      "plugins/rules/b/foes/x.yaml":
        '- { id: "b:foe/x", name: X, menace: 1, trick: "a:trick/x" }',
    };
    expect(await errorsOf(files, ["a", "b"])).toContain(
      "needs its plugin in requires",
    );
  });

  describe("replacements", () => {
    const base = {
      ...rules("a"),
      "plugins/rules/a/tricks/x.yaml": trick("a:trick/old"),
      "plugins/rules/a/foes/x.yaml":
        '- { id: "a:foe/x", name: X, menace: 1, trick: "a:trick/old" }',
    };
    const needsA = { requires: [["a", "^1"]] } as const;

    it("resolves references to the old id to the replacement", async () => {
      const files = {
        ...base,
        ...rules("b", needsA),
        "plugins/rules/b/tricks/x.yaml":
          '- { id: "b:trick/new", replaces: "a:trick/old", name: New }',
      };
      const result = await load(files, ["b"]);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.registry.content("a:trick/old")?.id).toBe("b:trick/new");
      expect(result.registry.contentIds()).toEqual(["a:foe/x", "b:trick/new"]);
    });

    it("follows a chain of replacements", async () => {
      const files = {
        ...base,
        ...rules("b", needsA),
        ...rules("c", { requires: [["b", "^1"]] }),
        "plugins/rules/b/tricks/x.yaml":
          '- { id: "b:trick/new", replaces: "a:trick/old", name: New }',
        "plugins/rules/c/tricks/x.yaml":
          '- { id: "c:trick/newer", replaces: "b:trick/new", name: Newer }',
      };
      const result = await load(files, ["c"]);
      expect(result.ok && result.registry.content("a:trick/old")?.id).toBe(
        "c:trick/newer",
      );
    });

    it("rejects replacing an unknown entry", async () => {
      const files = {
        ...rules("a"),
        "plugins/rules/a/tricks/x.yaml":
          '- { id: "a:trick/n", replaces: "a:trick/no", name: N }',
      };
      expect(await errorsOf(files, ["a"])).toContain("replaces unknown entry");
    });

    it("rejects replacing an entry of a different kind", async () => {
      const files = {
        ...base,
        ...rules("b", needsA),
        "plugins/rules/b/tricks/x.yaml":
          '- { id: "b:trick/new", replaces: "a:foe/x", name: New }',
      };
      expect(await errorsOf(files, ["b"])).toContain(
        "replaces a different kind",
      );
    });

    it("rejects replacing an entry from an undeclared plugin", async () => {
      const files = {
        ...base,
        ...rules("b"),
        "plugins/rules/b/tricks/x.yaml":
          '- { id: "b:trick/new", replaces: "a:trick/old", name: New }',
      };
      expect(await errorsOf(files, ["a", "b"])).toContain(
        "without requiring its plugin",
      );
    });

    it("rejects two replacements of one entry", async () => {
      const files = {
        ...base,
        ...rules("b", needsA),
        ...rules("c", needsA),
        "plugins/rules/b/tricks/x.yaml":
          '- { id: "b:trick/new", replaces: "a:trick/old", name: New }',
        "plugins/rules/c/tricks/x.yaml":
          '- { id: "c:trick/new", replaces: "a:trick/old", name: New }',
      };
      expect(await errorsOf(files, ["b", "c"])).toContain(
        "is already replaced",
      );
    });

    it("rejects a replacement cycle", async () => {
      const files = {
        ...rules("a"),
        "plugins/rules/a/tricks/x.yaml":
          '- { id: "a:trick/one", replaces: "a:trick/two", name: One }\n- { id: "a:trick/two", replaces: "a:trick/one", name: Two }',
        "plugins/rules/a/foes/x.yaml":
          '- { id: "a:foe/x", name: X, menace: 1, trick: "a:trick/one" }',
      };
      expect(await errorsOf(files, ["a"])).toContain("replacement cycle");
    });
  });
});

describe("adventures", () => {
  const scene = (body: string): string =>
    `- id: start\n  text: Start.\n  choices:\n${body}\n- { id: end, text: End. }\n`;
  const direct = (effects: string): string =>
    `    - { label: Go, effects: [${effects}] }`;
  const toEnd = "{ kind: goto, scene: end }";
  const withCheck = (results: string, check = "{ risk: low }"): string =>
    `    - { label: Roll, check: ${check}, results: { ${results} } }`;

  it("requires an adventure.yaml and a scenes.yaml", async () => {
    const files = {
      "plugins/adventures/a/plugin.yaml": manifest("a", { kind: "adventure" }),
    };
    const errors = await errorsOf(files, ["a"]);
    expect(errors).toContain("file is required");
  });

  it("reports an unknown start scene", async () => {
    const files = adventureFiles("a", {
      "adventure.yaml": "title: T\nstartScene: nope\n",
    });
    expect(await errorsOf(files, ["a"])).toContain('unknown scene "nope"');
  });

  it("reports an unreachable scene", async () => {
    const files = adventureFiles("a", {
      "scenes.yaml": "- { id: start, text: S. }\n- { id: island, text: I. }\n",
    });
    expect(await errorsOf(files, ["a"])).toContain(
      'scene "island" is unreachable',
    );
  });

  it("counts beats as ways to reach a scene", async () => {
    const files = adventureFiles("a", {
      "scenes.yaml":
        "- { id: start, text: S. }\n- { id: beat-scene, text: B. }\n",
      "beats.yaml": "- { id: b, scene: beat-scene }\n",
    });
    expect(await errorsOf(files, ["a"])).toBe("");
  });

  it("requires a reachable ending", async () => {
    const files = adventureFiles("a", {
      "scenes.yaml":
        "- id: start\n  text: S.\n  choices:\n    - { label: Loop, effects: [{ kind: goto, scene: start }] }\n",
    });
    expect(await errorsOf(files, ["a"])).toContain("no reachable ending");
  });

  it("reports duplicate scene ids", async () => {
    const files = adventureFiles("a", {
      "scenes.yaml": ENDING_SCENES + ENDING_SCENES,
    });
    expect(await errorsOf(files, ["a"])).toContain('duplicate id "start"');
  });

  it.each([
    ["scene", "{ kind: goto, scene: nope }", "unknown scene"],
    ["clock", "{ kind: advanceClock, clock: nope }", "unknown clock"],
    ["NPC", "{ kind: adjustAttitude, npc: nope, by: 1 }", "unknown NPC"],
    [
      "encounter",
      "{ kind: startEncounter, encounter: nope }",
      "unknown encounter",
    ],
    ["secret", "{ kind: reveal, secret: nope }", "unknown secret"],
    [
      "system effect",
      '{ kind: system, effect: "d6:nope", args: {} }',
      'no story effect "d6:nope"',
    ],
    [
      "effect args",
      '{ kind: system, effect: "d6:gainLuck", args: { amount: 0 } }',
      "d6:gainLuck.amount",
    ],
  ])(
    "reports an unknown %s reference in an effect",
    async (_name, effect, message) => {
      const files = adventureFiles("a", {
        "scenes.yaml": scene(direct(`${effect}, ${toEnd}`)),
      });
      expect(await errorsOf(files, ["a"])).toContain(message);
    },
  );

  it("reports an unknown system predicate", async () => {
    const files = adventureFiles("a", {
      "scenes.yaml": scene(
        `    - { label: Go, when: { kind: system, predicate: "d6:nope", args: {} }, effects: [${toEnd}] }`,
      ),
    });
    expect(await errorsOf(files, ["a"])).toContain('no predicate "d6:nope"');
  });

  it("validates checks with the system's schema", async () => {
    const results = `hit: [${toEnd}], mixed: [${toEnd}], miss: [${toEnd}]`;
    const files = adventureFiles("a", {
      "scenes.yaml": scene(withCheck(results, "{ skill: perception, dc: 12 }")),
    });
    expect(await errorsOf(files, ["a"])).toContain("start.check");
  });

  it("reports an undeclared outcome", async () => {
    const results = `hit: [${toEnd}], mixed: [${toEnd}], miss: [${toEnd}], success: [${toEnd}]`;
    const files = adventureFiles("a", {
      "scenes.yaml": scene(withCheck(results)),
    });
    expect(await errorsOf(files, ["a"])).toContain(
      'undeclared outcome "success"',
    );
  });

  it("reports an uncovered outcome", async () => {
    const results = `hit: [${toEnd}], miss: [${toEnd}]`;
    const files = adventureFiles("a", {
      "scenes.yaml": scene(withCheck(results)),
    });
    expect(await errorsOf(files, ["a"])).toContain(
      'outcome "mixed" is not covered',
    );
  });

  it("reports an outcome covered twice through a group", async () => {
    const results = `notMiss: [${toEnd}], hit: [${toEnd}], miss: [${toEnd}]`;
    const files = adventureFiles("a", {
      "scenes.yaml": scene(withCheck(results)),
    });
    expect(await errorsOf(files, ["a"])).toContain(
      'outcome "hit" is covered twice',
    );
  });

  it("accepts outcomes covered through a group", async () => {
    const results = `notMiss: [${toEnd}], miss: [${toEnd}]`;
    const files = adventureFiles("a", {
      "scenes.yaml": scene(withCheck(results)),
    });
    expect(await errorsOf(files, ["a"])).toBe("");
  });

  it("checks references from encounters and NPC stats", async () => {
    const files = adventureFiles("a", {
      "encounters.yaml": '- { id: fight, foes: ["a:foe/nope"] }\n',
      "npcs.yaml":
        '- { id: n, name: N, pronouns: they/them, motive: M, statsId: "a:foe/also-nope" }\n',
    });
    const errors = await errorsOf(files, ["a"]);
    expect(errors).toContain('unknown reference "a:foe/nope"');
    expect(errors).toContain('unknown reference "a:foe/also-nope"');
  });

  it("requires secrets to have at least two clues", async () => {
    const files = adventureFiles("a", {
      "secrets.yaml":
        "- { id: s, truth: T, clues: [{ scene: start, text: C }] }\n",
    });
    expect(await errorsOf(files, ["a"])).toContain("clues");
  });

  it("freezes the loaded adventure", async () => {
    const result = await load(adventureFiles("a"), ["a"]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(Object.isFrozen(result.registry.adventure("a")?.scenes)).toBe(true);
  });
});

describe("real fixture files", () => {
  it("loads both sample adventures with the test system", async () => {
    const storage = await createNodeStorage(process.cwd());
    const report = await checkPlugins(storage, ["tests/fixtures"], [d6System]);
    expect(report.issues).toEqual([]);
    expect(report.checked).toEqual([
      "d6-base",
      "d6-override",
      "goblin-ambush",
      "haunted-house",
    ]);
  });

  it("applies a real replacement and an adventure's own content", async () => {
    const storage = await createNodeStorage(process.cwd());
    const catalog = await scanPlugins(storage, ["tests/fixtures"]);
    const result = await loadRun(
      storage,
      catalog,
      [d6System],
      ["goblin-ambush"],
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.registry.content("d6-base:trick/dirty-fighting")?.id).toBe(
      "d6-override:trick/nasty-fighting",
    );
    expect(result.registry.content("goblin-ambush:foe/chief")).toBeDefined();
    expect(result.registry.adventure("goblin-ambush")?.title).toBe(
      "Ambush on the Old Road",
    );
  });
});

describe("macOS folder metadata", () => {
  it("ignores .DS_Store but not a symlink with that name", async () => {
    const files = { ...rules("a"), "plugins/rules/a/.DS_Store": "binary" };
    expect(await errorsOf(files, ["a"])).toBe("");
    expect(
      await errorsOf(rules("a"), ["a"], ["plugins/rules/a/.DS_Store"]),
    ).toContain("symlinks are not allowed");
  });
});
