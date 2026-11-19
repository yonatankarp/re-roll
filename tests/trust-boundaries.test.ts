import { describe, expect, it } from "vitest";
import type { GameEvent } from "../engine/kernel/events.ts";
import { withSaveFiles } from "../engine/platform/browser/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { type LogEntry, createSave, loadSave } from "../engine/run/save.ts";
import {
  type RunContext,
  type StepResult,
  createRunContext,
  startRun,
  step,
} from "../engine/run/turn.ts";
import { d6System } from "./fixtures/system-d6/index.ts";
import { memoryStorage } from "./memory-storage.ts";

// #220: content, plugins and saves come from outside the game, so each is fed something hostile here.

const manifest = (id: string, kind = "rules", requires = ""): string =>
  `id: ${id}\nkind: ${kind}\nversion: 1.0.0\nsdk: ^1\nsystem: d6@^1\ndistribution: shipped\n${requires}`;

async function load(files: Record<string, string>, requested: string[]) {
  const storage = memoryStorage(files);
  return loadRun(
    storage,
    await scanPlugins(storage, ["plugins"]),
    [d6System],
    requested,
  );
}

async function errorsOf(files: Record<string, string>, requested: string[]) {
  const result = await load(files, requested);
  return result.ok
    ? ""
    : result.issues.map((issue) => issue.message).join("\n");
}

const ROOT = "plugins/adventures/inline";
function inline(documents: Record<string, string>): Record<string, string> {
  return {
    [`${ROOT}/plugin.yaml`]: manifest("inline", "adventure"),
    [`${ROOT}/adventure.yaml`]: "title: Inline\nstartScene: start\n",
    ...Object.fromEntries(
      Object.entries(documents).map(([name, text]) => [
        `${ROOT}/${name}`,
        text,
      ]),
    ),
  };
}

async function loadInline(documents: Record<string, string>) {
  const result = await load(inline(documents), ["inline"]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return {
    registry: result.registry,
    run: createRunContext(result.registry, "inline"),
  };
}

const TWO_WAYS = (first: string, second: string): string => `
- id: start
  text: Start.
  choices:
${first}
${second}
- { id: left, text: Left. }
- { id: right, text: Right. }
`;
const LEFT =
  "    - { id: go-left, label: Left, effects: [{ kind: goto, scene: left }] }";
const RIGHT =
  "    - { id: go-right, label: Right, effects: [{ kind: goto, scene: right }] }";

const bare = (line: string): string => line.replace(/id: go-\w+, /, "");

function answer(
  run: RunContext,
  from: StepResult,
  optionId: string,
): StepResult {
  const outcome = step(run, from.state, {
    kind: "answer",
    decisionId: from.pending?.id ?? "",
    optionId,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome;
}

describe("keys from content that name Object.prototype's own", () => {
  it("reports a content folder named constructor instead of throwing", async () => {
    const files = {
      "plugins/rules/a/plugin.yaml": manifest("a"),
      "plugins/rules/a/constructor/x.yaml": "- { id: x }\n",
    };
    expect(await errorsOf(files, ["a"])).toContain(
      'unknown content folder "constructor"',
    );
  });

  it("reports an adventure's story effect, predicate and outcome named after prototype keys", async () => {
    const scenes = `
- id: start
  text: Start.
  choices:
    - label: Odd
      when: { kind: system, predicate: toString, args: {} }
      effects: [{ kind: system, effect: constructor, args: {} }, { kind: goto, scene: end }]
    - { label: Roll, check: { risk: low }, results: { constructor: [{ kind: goto, scene: end }], hit: [{ kind: goto, scene: end }], mixed: [{ kind: goto, scene: end }], miss: [{ kind: goto, scene: end }] } }
- { id: end, text: End. }
`;
    const errors = await errorsOf(inline({ "scenes.yaml": scenes }), [
      "inline",
    ]);
    expect(errors).toContain('no story effect "constructor"');
    expect(errors).toContain('no predicate "toString"');
    expect(errors).toContain('undeclared outcome "constructor"');
  });

  it("reads a flag named constructor as unset", async () => {
    const scenes = `
- id: start
  text: Start.
  choices:
    - { label: Unset, when: { kind: flag, flag: constructor, is: false }, effects: [{ kind: goto, scene: end }] }
- { id: end, text: End. }
`;
    const { run } = await loadInline({ "scenes.yaml": scenes });
    expect(startRun(run, "s").pending?.options.map((o) => o.label)).toContain(
      "Unset",
    );
  });
});

describe("a plugin whose manifest doesn't load", () => {
  it("says why, rather than calling it missing", async () => {
    const files = {
      "plugins/rules/a/plugin.yaml": manifest(
        "a",
        "rules",
        "requires:\n  - { plugin: b, version: ^1 }\n",
      ),
      "plugins/rules/b/plugin.yaml": "id: b\nkind: [rules\n",
    };
    const errors = await errorsOf(files, ["a"]);
    expect(errors).toContain("cannot read");
    expect(errors).not.toContain('missing plugin "b"');
  });
});

describe("a hostile save", () => {
  const SCENES = TWO_WAYS(bare(LEFT), bare(RIGHT));
  async function saved() {
    const { registry, run } = await loadInline({ "scenes.yaml": SCENES });
    const started = startRun(run, "s");
    const log: LogEntry[] = [
      { input: { kind: "start" }, events: started.events },
    ];
    const save = createSave(registry, "inline", "s", log);
    return { registry, run, save, started };
  }
  const text = (save: object): string => JSON.stringify(save);

  it("is refused, not crashed on, when a valid-looking event breaks the rules", async () => {
    const { registry, run, save } = await saved();
    save.log[0]?.events.push({
      kind: "d6:luckChanged",
      payload: { actor: "player", by: 1 },
    });
    const throwing: RunContext = {
      ...run,
      system: {
        ...run.system,
        applyEvent: () => {
          throw new Error("luck for an actor who isn't there");
        },
      },
    };
    const loaded = loadSave(text(save), registry, throwing);
    expect(loaded.ok || loaded.error).toContain("damaged");
  });

  it("must start its run once, first", async () => {
    const { registry, run, save, started } = await saved();
    const [start] = started.events as GameEvent[];
    const twice = {
      ...save,
      log: [
        ...save.log,
        {
          input: { kind: "answer", decisionId: "x", optionId: "0" },
          events: [start],
        },
      ],
    };
    expect(loadSave(text(twice), registry, run).ok || "").toBe("");
    const late = {
      ...save,
      log: [
        {
          input: { kind: "start" },
          events: [
            { kind: "flagSet", flag: "f", value: true },
            ...(save.log[0]?.events ?? []),
          ],
        },
      ],
    };
    expect(loadSave(text(late), registry, run).ok).toBe(false);
    const restart = {
      ...save,
      log: [...save.log, { input: { kind: "start" }, events: [] }],
    };
    expect(loadSave(text(restart), registry, run).ok).toBe(false);
  });

  it.each([
    ["toString", {}, "unknown step"],
    ["story:enterScene", { scene: 7 }, "can't be read"],
    ["story:nowhere", {}, "unknown step"],
  ])("refuses a waiting step of kind %s", async (kind, payload, message) => {
    const { registry, run, save } = await saved();
    save.log[0]?.events.push({ kind: "framePushed", frame: { kind, payload } });
    const loaded = loadSave(text(save), registry, run);
    expect(loaded.ok || loaded.error).toContain(message);
  });

  it("refuses a state the game can't hold, and junk that isn't a save", async () => {
    const { registry, run, save } = await saved();
    const events = save.log[0]?.events ?? [];
    events.push({ kind: "sceneEntered", scene: "start" });
    const broken = JSON.parse(
      text(save).replace('"stack":[', '"stack":[7,'),
    ) as object;
    expect(loadSave(text(broken), registry, run).ok).toBe(false);
    for (const junk of [
      "",
      "null",
      "[]",
      '{"formatVersion":"1"}',
      '{"formatVersion":1e400}',
    ])
      expect(loadSave(junk, registry, run).ok).toBe(false);
  });
});

describe("a scene's choices", () => {
  it("are answered by their own ids, so moving them keeps a save's answer", async () => {
    const before = await loadInline({ "scenes.yaml": TWO_WAYS(LEFT, RIGHT) });
    const after = await loadInline({ "scenes.yaml": TWO_WAYS(RIGHT, LEFT) });
    const started = startRun(before.run, "s");
    expect(started.pending?.options.map((option) => option.id)).toEqual([
      "go-left",
      "go-right",
    ]);
    expect(answer(after.run, started, "go-right").state.story.scene).toBe(
      "right",
    );
  });

  it("without ids are answered by place, as saves from before ids were", async () => {
    const { run } = await loadInline({
      "scenes.yaml": TWO_WAYS(bare(LEFT), bare(RIGHT)),
    });
    const started = startRun(run, "s");
    expect(started.pending?.options.map((option) => option.id)).toEqual([
      "0",
      "1",
    ]);
    expect(answer(run, started, "1").state.story.scene).toBe("right");
  });

  it("can't take a number or another choice's id", async () => {
    const numbered = LEFT.replace("go-left", '"1"');
    expect(
      await errorsOf(inline({ "scenes.yaml": TWO_WAYS(numbered, RIGHT) }), [
        "inline",
      ]),
    ).toContain("must not be a number");
    const twice = RIGHT.replace("go-right", "go-left");
    expect(
      await errorsOf(inline({ "scenes.yaml": TWO_WAYS(LEFT, twice) }), [
        "inline",
      ]),
    ).toContain('duplicate choice id "go-left"');
  });
});

describe("smaller boundaries", () => {
  it("refuses a clock that runs backwards", async () => {
    const factions =
      "- { id: f, name: F, goal: G, clocks: [{ id: c, label: C, max: 3 }] }\n";
    const scenes = `
- id: start
  text: Start.
  choices:
    - { label: Back, effects: [{ kind: advanceClock, clock: c, by: -1 }, { kind: goto, scene: end }] }
- { id: end, text: End. }
`;
    expect(
      await errorsOf(
        inline({ "factions.yaml": factions, "scenes.yaml": scenes }),
        ["inline"],
      ),
    ).toContain("by");
  });

  it("loads a chain of twins whichever file comes first", async () => {
    const files = {
      "plugins/rules/a/plugin.yaml": manifest("a"),
      "plugins/rules/a/foes/1.yaml":
        '- { id: "a:foe/z", playsAs: "a:foe/y", name: Z }',
      "plugins/rules/a/foes/2.yaml":
        '- { id: "a:foe/y", playsAs: "a:foe/x", name: Y }',
      "plugins/rules/a/foes/3.yaml": '- { id: "a:foe/x", name: X, menace: 3 }',
    };
    const result = await load(files, ["a"]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.registry.content("a:foe/z")).toMatchObject({
      name: "Z",
      menace: 3,
    });
    const cycle = {
      "plugins/rules/a/plugin.yaml": manifest("a"),
      "plugins/rules/a/foes/1.yaml":
        '- { id: "a:foe/z", playsAs: "a:foe/y", name: Z }\n- { id: "a:foe/y", playsAs: "a:foe/z", name: Y }',
    };
    expect(await errorsOf(cycle, ["a"])).toContain("plays as unknown entry");
  });

  it("lists only the saves under the folder asked for in a browser", async () => {
    const saves = new Map([
      ["saves/a.json", "{}"],
      ["saves/old/b.json", "{}"],
    ]);
    const storage = withSaveFiles(memoryStorage({}), {
      read: (path) => Promise.resolve(saves.get(path) ?? null),
      write: () => Promise.resolve(),
      list: () => Promise.resolve([...saves.keys()]),
      remove: () => Promise.resolve(),
    });
    expect(
      (await storage.list("saves/old")).map((entry) => entry.path),
    ).toEqual(["saves/old/b.json"]);
    expect(await storage.list("saves")).toHaveLength(2);
  });

  it("fills the party from the adventure's own size and companions", async () => {
    const one = await loadInline({
      "adventure.yaml":
        "title: Inline\nstartScene: start\nparty: { size: 2, companions: [{ name: Kit, pronouns: they/them }] }\n",
      "scenes.yaml": "- { id: start, text: End. }\n",
    });
    const { state } = startRun(one.run, "s");
    expect(state.partyIds).toHaveLength(2);
    expect(Object.values(state.companions).map((c) => c.name)).toEqual(["Kit"]);
    const short = inline({
      "adventure.yaml":
        "title: Inline\nstartScene: start\nparty: { size: 3, companions: [{ name: Kit, pronouns: they/them }] }\n",
      "scenes.yaml": "- { id: start, text: End. }\n",
    });
    expect(await errorsOf(short, ["inline"])).toContain("fewer companions");
  });
});
