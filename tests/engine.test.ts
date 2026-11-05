import {
  PLAYER_ACTOR,
  type SystemContext,
  awaitDecision,
  defineSystem,
  encounterKind,
  frameHandler,
} from "#sdk";
import { fc, test as propertyTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GameState } from "../engine/kernel/events.ts";
import {
  type Registry,
  loadRun,
  scanPlugins,
} from "../engine/kernel/loader.ts";
import {
  type LogEntry,
  createSave,
  loadSave,
  replayInputs,
} from "../engine/kernel/save.ts";
import {
  type RunContext,
  type StepResult,
  createRunContext,
  pendingDecision,
  startRun,
  step,
} from "../engine/kernel/turn.ts";
import type { GameSystem } from "../engine/kernel/system.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { playRun, testAdventure } from "../engine/tools/bot.ts";
import { d6System } from "./fixtures/system-d6/index.ts";
import { memoryStorage } from "./memory-storage.ts";

const SEEDS = Array.from({ length: 40 }, (_, index) => `seed-${String(index)}`);

async function loadInline(
  documents: Readonly<Record<string, string>>,
  system: GameSystem = d6System,
): Promise<{ registry: Registry; run: RunContext }> {
  const root = "plugins/adventures/inline";
  const files: Record<string, string> = {
    [`${root}/plugin.yaml`]: `id: inline\nkind: adventure\nversion: 1.0.0\nsdk: ^1\nsystem: ${system.id}@^1\ndistribution: shipped\n`,
    [`${root}/adventure.yaml`]: "title: Inline\nstartScene: start\n",
  };
  for (const [name, text] of Object.entries(documents)) {
    files[`${root}/${name}`] = text;
  }
  const storage = memoryStorage(files);
  const catalog = await scanPlugins(storage, ["plugins"]);
  const result = await loadRun(storage, catalog, [system], ["inline"]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return {
    registry: result.registry,
    run: createRunContext(result.registry, "inline"),
  };
}

async function loadFixture(
  adventure: string,
): Promise<{ registry: Registry; run: RunContext }> {
  const storage = await createNodeStorage(process.cwd());
  const catalog = await scanPlugins(storage, ["tests/fixtures"]);
  const result = await loadRun(storage, catalog, [d6System], [adventure]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return {
    registry: result.registry,
    run: createRunContext(result.registry, adventure),
  };
}

function choose(
  run: RunContext,
  current: StepResult,
  optionId: string,
): StepResult {
  const { pending } = current;
  if (!pending) throw new Error("Nothing is waiting for an answer");
  const outcome = step(run, current.state, {
    kind: "answer",
    decisionId: pending.id,
    optionId,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const kinds = (result: StepResult): readonly string[] =>
  result.events.map((event) => event.kind);

describe("starting a run", () => {
  it("gives the same start for the same seed", async () => {
    const { run } = await loadFixture("haunted-house");
    expect(startRun(run, "same")).toStrictEqual(startRun(run, "same"));
  });

  it("varies the party and the variants between seeds", async () => {
    const { run } = await loadFixture("haunted-house");
    const starts = SEEDS.map((seed) => startRun(run, seed).state);
    const parties = new Set(
      starts.map((state) =>
        Object.values(state.companions)
          .map((companion) => companion.name)
          .join(),
      ),
    );
    const moods = new Set(
      starts.map((state) => state.story.variants["ghost-mood"]),
    );
    expect(parties.size).toBeGreaterThan(5);
    expect(moods).toEqual(new Set(["mournful", "furious"]));
  });

  it("builds a party of the player and two companions", async () => {
    const { run } = await loadFixture("goblin-ambush");
    const { state } = startRun(run, "party");
    expect(state.partyIds).toEqual([
      PLAYER_ACTOR,
      "companion-1",
      "companion-2",
    ]);
    expect(Object.keys(state.companions)).toHaveLength(2);
  });

  it("applies the chosen variant's effects before the first scene", async () => {
    const { run } = await loadFixture("haunted-house");
    const { state } = startRun(run, "variant");
    const mood = state.story.variants["ghost-mood"] ?? "";
    expect(state.story.flags[`ghost-${mood}`]).toBe(true);
    expect(state.story.scene).toBe("hallway");
  });

  it("records the whole start in the first event", async () => {
    const { run } = await loadFixture("goblin-ambush");
    const { events } = startRun(run, "first");
    expect(events[0]?.kind).toBe("runStarted");
  });
});

describe("story rules", () => {
  it("applies a goto only after the choice's other effects, and the last one wins", async () => {
    const { run } = await loadInline({
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - label: Go
      effects:
        - { kind: goto, scene: wrong }
        - { kind: setFlag, flag: first }
        - { kind: goto, scene: finish }
        - { kind: setFlag, flag: second }
- { id: wrong, text: Wrong. }
- { id: finish, text: Finish. }
`,
    });
    const result = choose(run, startRun(run, "s"), "0");
    expect(result.state.story.scene).toBe("finish");
    expect(result.state.story.flags).toEqual({ first: true, second: true });
    const scene = result.events.findIndex((e) => e.kind === "sceneEntered");
    const flags = result.events.flatMap((e, i) =>
      e.kind === "flagSet" ? [i] : [],
    );
    expect(flags.every((index) => index < scene)).toBe(true);
    expect(result.state.story.ended).toBe("ending");
  });

  it("finishes an encounter before the choice's remaining effects", async () => {
    const { run } = await loadFixture("goblin-ambush");
    for (const seed of SEEDS) {
      let current = startRun(run, seed);
      current = choose(run, current, "0");
      const order: string[] = [...kinds(current)];
      while (current.pending?.id.startsWith("d6:cost")) {
        current = choose(run, current, "spendLuck");
        order.push(...kinds(current));
      }
      const started = order.indexOf("encounterStarted");
      if (started === -1) continue;
      expect(order.indexOf("encounterEnded")).toBeGreaterThan(started);
      expect(order.lastIndexOf("sceneEntered")).toBeGreaterThan(
        order.indexOf("encounterEnded"),
      );
      return;
    }
    throw new Error("No seed reached the encounter");
  });

  it("matches a check's outcome through a group", async () => {
    const { run } = await loadFixture("goblin-ambush");
    let saw = 0;
    for (const seed of SEEDS) {
      const result = choose(run, startRun(run, seed), "0");
      const check = result.events.find((e) => e.kind === "checkResolved");
      if (check?.kind === "checkResolved" && check.outcome !== "miss") {
        expect(result.state.story.flags["spotted-ambush"]).toBe(true);
        saw += 1;
      }
    }
    expect(saw).toBeGreaterThan(0);
  });

  it("fires a clock's threshold once, and its goto beats the choice's own", async () => {
    const { run } = await loadInline({
      "factions.yaml": `
- id: f
  name: F
  goal: G
  clocks:
    - id: dread
      label: Dread
      max: 2
      at:
        - value: 2
          effects:
            - { kind: goto, scene: doom }
`,
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - label: Wait
      effects:
        - { kind: advanceClock, clock: dread }
        - { kind: goto, scene: start }
- { id: doom, text: Doom. }
`,
    });
    let current = choose(run, startRun(run, "s"), "0");
    expect(current.state.story.clocks.dread).toBe(1);
    expect(current.state.story.scene).toBe("start");
    current = choose(run, current, "0");
    expect(current.state.story.clocks.dread).toBe(2);
    expect(current.state.story.scene).toBe("doom");
  });

  it("doesn't pass through the choice's scene when a threshold overrules it", async () => {
    const { run } = await loadInline({
      "beats.yaml":
        "- { id: wasted, scene: beat, when: { kind: clock, clock: dread, atLeast: 1 } }\n",
      "factions.yaml": `
- id: f
  name: F
  goal: G
  clocks:
    - id: dread
      label: Dread
      max: 1
      at:
        - value: 1
          effects:
            - { kind: goto, scene: doom }
`,
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - label: Go
      effects:
        - { kind: advanceClock, clock: dread }
        - { kind: goto, scene: middle }
- id: middle
  text: Middle.
  choices:
    - { label: Go, effects: [{ kind: goto, scene: doom }] }
- id: beat
  text: Beat.
  choices:
    - { label: Go, effects: [{ kind: goto, scene: doom }] }
- { id: doom, text: Doom. }
`,
    });
    const result = choose(run, startRun(run, "s"), "0");
    const entered = result.events.flatMap((event) =>
      event.kind === "sceneEntered" ? [event.scene] : [],
    );
    expect(entered).toEqual(["doom"]);
    expect(result.state.story.firedBeats).toEqual([]);
  });

  it("applies a threshold's effects when the choice has nothing left to do", async () => {
    const { run } = await loadInline({
      "factions.yaml": `
- id: f
  name: F
  goal: G
  clocks:
    - id: dread
      label: Dread
      max: 1
      at:
        - value: 1
          effects:
            - { kind: goto, scene: doom }
`,
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Go, effects: [{ kind: advanceClock, clock: dread }] }
- { id: doom, text: Doom. }
`,
    });
    expect(choose(run, startRun(run, "s"), "0").state.story.scene).toBe("doom");
  });

  it("caps a clock at its maximum", async () => {
    const { run } = await loadInline({
      "factions.yaml": `
- { id: f, name: F, goal: G, clocks: [{ id: c, label: C, max: 2 }] }
`,
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Push, effects: [{ kind: advanceClock, clock: c, by: 9 }, { kind: goto, scene: end }] }
- { id: end, text: End. }
`,
    });
    expect(choose(run, startRun(run, "s"), "0").state.story.clocks.c).toBe(2);
  });

  it("hides a choice whose condition fails", async () => {
    const { run } = await loadInline({
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Hidden, when: { kind: flag, flag: never }, effects: [{ kind: goto, scene: end }] }
    - { label: Visible, effects: [{ kind: goto, scene: end }] }
- { id: end, text: End. }
`,
    });
    expect(startRun(run, "s").pending?.options).toEqual([
      { id: "1", label: "Visible" },
    ]);
  });

  it("reports a dead end when every choice is hidden", async () => {
    const { run } = await loadInline({
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Hidden, when: { kind: flag, flag: never }, effects: [{ kind: goto, scene: end }] }
- { id: end, text: End. }
`,
    });
    const result = startRun(run, "s");
    expect(result.pending).toBeNull();
    expect(result.state.story.ended).toBe("deadEnd");
  });

  it("fires a beat once, on a scene change", async () => {
    const { run } = await loadInline({
      "beats.yaml": "- { id: once, scene: beat }\n",
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Go, effects: [{ kind: goto, scene: middle }] }
- id: middle
  text: Middle.
  choices:
    - { label: Go, effects: [{ kind: goto, scene: last }] }
- id: beat
  text: Beat.
  choices:
    - { label: Go, effects: [{ kind: goto, scene: middle }] }
- id: last
  text: Last.
`,
    });
    let current = startRun(run, "s");
    expect(current.state.story.scene).toBe("beat");
    current = choose(run, current, "0");
    expect(current.state.story.scene).toBe("middle");
    expect(current.state.story.firedBeats).toEqual(["once"]);
    current = choose(run, current, "0");
    expect(current.state.story.scene).toBe("last");
  });

  it("gives the director a turn when the rules offer the GM an opening", async () => {
    const { run } = await loadInline({
      "beats.yaml": `- { id: after-miss, scene: beat, when: { kind: flag, flag: missed } }\n`,
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - label: Roll
      check: { risk: high }
      results:
        notMiss:
          - { kind: goto, scene: end }
        miss:
          - { kind: setFlag, flag: missed }
- id: beat
  text: Beat.
  choices:
    - { label: Go, effects: [{ kind: goto, scene: end }] }
- { id: end, text: End. }
`,
    });
    const missed = SEEDS.map((seed) =>
      choose(run, startRun(run, seed), "0"),
    ).filter((result) => result.state.story.flags.missed === true);
    expect(missed.length).toBeGreaterThan(0);
    for (const result of missed) {
      expect(result.state.story.scene).toBe("beat");
    }
  });

  it("runs a system's story effect and predicate", async () => {
    const { run } = await loadInline({
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - label: Gain
      effects:
        - { kind: system, effect: "d6:gainLuck", args: { amount: 5 } }
    - label: Rich
      when: { kind: system, predicate: "d6:hasLuck", args: { atLeast: 5 } }
      effects:
        - { kind: goto, scene: end }
- { id: end, text: End. }
`,
    });
    let current = startRun(run, "s");
    expect(current.pending?.options.map((option) => option.id)).toEqual(["0"]);
    current = choose(run, current, "0");
    expect(current.pending?.options.map((option) => option.id)).toEqual([
      "0",
      "1",
    ]);
  });
});

describe("input handling", () => {
  it("rejects bad input and leaves the state untouched", async () => {
    const { run } = await loadFixture("goblin-ambush");
    const { state, pending } = startRun(run, "input");
    deepFreeze(state);
    expect(
      step(run, state, {
        kind: "answer",
        decisionId: "wrong",
        optionId: "0",
      }).ok,
    ).toBe(false);
    expect(
      step(run, state, {
        kind: "answer",
        decisionId: pending?.id ?? "",
        optionId: "99",
      }).ok,
    ).toBe(false);
    expect(pendingDecision(run, state)).toStrictEqual(pending);
  });

  it("refuses input after the adventure has ended", async () => {
    const { run } = await loadFixture("goblin-ambush");
    const ended = choose(run, startRun(run, "end"), "1");
    expect(ended.state.story.ended).toBe("ending");
    expect(
      step(run, ended.state, {
        kind: "answer",
        decisionId: "scene:village",
        optionId: "0",
      }).ok,
    ).toBe(false);
  });

  it("stops a handler that never settles", async () => {
    const looping = defineSystem({
      ...d6System,
      id: "looping",
      eventSchemas: {},
      storyEffects: {},
      storyPredicates: {},
      frames: {
        "looping:forever": frameHandler({
          schema: z.object({}),
          run: () => ({ frames: [{ kind: "looping:forever", payload: {} }] }),
        }),
      },
      startEncounter: () => ({
        frames: [{ kind: "looping:forever", payload: {} }],
      }),
    });
    const { run } = await loadInline(
      {
        "encounters.yaml": '- { id: e, foes: ["inline:foe/x"] }\n',
        "foes/x.yaml": '- { id: "inline:foe/x", name: X, menace: 1 }\n',
        "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Go, effects: [{ kind: startEncounter, encounter: e }, { kind: goto, scene: end }] }
- { id: end, text: End. }
`,
      },
      looping,
    );
    expect(() => choose(run, startRun(run, "s"), "0")).toThrow(
      "did not settle",
    );
  });

  it("rejects a system event outside the system's own namespace", async () => {
    const rude = defineSystem({
      ...d6System,
      id: "rude",
      eventSchemas: {},
      storyEffects: {},
      storyPredicates: {},
      frames: {},
      startEncounter: () => ({
        events: [{ kind: "other:thing", payload: {} }],
      }),
    });
    const { run } = await loadInline(
      {
        "encounters.yaml": '- { id: e, foes: ["inline:foe/x"] }\n',
        "foes/x.yaml": '- { id: "inline:foe/x", name: X, menace: 1 }\n',
        "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Go, effects: [{ kind: startEncounter, encounter: e }, { kind: goto, scene: end }] }
- { id: end, text: End. }
`,
      },
      rude,
    );
    expect(() => choose(run, startRun(run, "s"), "0")).toThrow(
      "doesn't own: other:thing",
    );
  });
});

// A tiny turn-based system, kept here so the shared d6 fixture stays free of turns.
const TurnsStateSchema = z.strictObject({
  order: z.array(z.string()),
  index: z.number().int(),
  rounds: z.number().int(),
  blocks: z.number().int(),
  hits: z.number().int(),
});
type TurnsState = z.infer<typeof TurnsStateSchema>;
type TurnsContext = SystemContext<TurnsState>;

const turnsSystem = defineSystem<TurnsState>({
  id: "turns",
  version: "1.0.0",
  sdk: "^1",
  contentKinds: {},
  checkSchema: z.object({}),
  encounters: encounterKind({ schema: z.object({ id: z.string() }) }),
  outcomes: { keys: ["done"] },
  stateSchema: TurnsStateSchema,
  eventSchemas: {
    "turns:began": z.object({}),
    "turns:nextActor": z.object({}),
    "turns:blocked": z.object({}),
    "turns:hit": z.object({}),
  },
  storyEffects: {},
  storyPredicates: {},
  frames: {
    "turns:act": frameHandler({
      schema: z.object({ actor: z.string(), answer: z.string() }),
      run: ({ actor }, _context: TurnsContext) =>
        // A monster's attack gives the player a reaction, which suspends the attack.
        actor === "monster"
          ? {
              frames: [
                awaitDecision({
                  id: "turns:reaction",
                  actor: PLAYER_ACTOR,
                  prompt: "Block?",
                  options: [
                    { id: "block", label: "Block" },
                    { id: "take", label: "Take it" },
                  ],
                  resume: { kind: "turns:afterReaction", payload: {} },
                }),
              ],
            }
          : { events: [{ kind: "turns:nextActor", payload: {} }] },
    }),
    "turns:afterReaction": frameHandler({
      schema: z.object({ answer: z.enum(["block", "take"]) }),
      run: ({ answer }, { dice }: TurnsContext) => ({
        events: [
          {
            kind: answer === "block" ? "turns:blocked" : "turns:hit",
            payload: { damage: dice.roll(6) },
          },
          { kind: "turns:nextActor", payload: {} },
        ],
      }),
    }),
  },
  createRun: () => ({ order: [], index: 0, rounds: 0, blocks: 0, hits: 0 }),
  resolveCheck: () => ({ outcome: "done" }),
  startEncounter: () => ({ events: [{ kind: "turns:began", payload: {} }] }),
  applyEvent: (state, event) => {
    switch (event.kind) {
      case "turns:began":
        return {
          ...state,
          order: [PLAYER_ACTOR, "monster"],
          index: 0,
          rounds: 2,
        };
      case "turns:nextActor": {
        const index = state.index + 1;
        return index >= state.order.length
          ? { ...state, index: 0, rounds: state.rounds - 1 }
          : { ...state, index };
      }
      case "turns:blocked":
        return { ...state, blocks: state.blocks + 1 };
      case "turns:hit":
        return { ...state, hits: state.hits + 1 };
      default:
        return state;
    }
  },
  nextDecision: (state) => {
    const actor = state.order[state.index];
    if (state.rounds <= 0 || actor === undefined) return null;
    return {
      id: `turns:turn:${actor}:${String(state.rounds)}`,
      actor,
      prompt: `${actor}'s turn`,
      options: [{ id: "act", label: "Act" }],
      resume: { kind: "turns:act", payload: { actor } },
    };
  },
  decidePolicy: (decision) => decision.options[0]?.id ?? "",
});

async function loadTurns() {
  return loadInline(
    {
      "encounters.yaml": "- { id: fight }\n",
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - label: Fight
      effects:
        - { kind: startEncounter, encounter: fight }
        - { kind: goto, scene: end }
- { id: end, text: End. }
`,
    },
    turnsSystem,
  );
}

describe("a turn-based system with interrupts", () => {
  it("runs turns through the system, with policy answering for the monster", async () => {
    const { run } = await loadTurns();
    let current = choose(run, startRun(run, "t"), "0");
    expect(current.pending?.id).toBe(`turns:turn:${PLAYER_ACTOR}:2`);
    current = choose(run, current, "act");
    // The monster acted without any input, then its attack paused for the player's reaction.
    expect(current.pending?.id).toBe("turns:reaction");
  });

  it("delays the choice's remaining effects until the encounter is over", async () => {
    const { run } = await loadTurns();
    let current = choose(run, startRun(run, "t"), "0");
    expect(current.state.story.scene).toBe("start");
    for (const answer of ["act", "block", "act", "take"]) {
      current = choose(run, current, answer);
    }
    expect(current.state.story.scene).toBe("end");
    expect(current.state.story.ended).toBe("ending");
  });

  it("resumes identically from a save made in the middle of an attack", async () => {
    const { run, registry } = await loadTurns();
    const started = startRun(run, "mid");
    const first = choose(run, started, "0");
    const second = choose(run, first, "act");
    expect(second.pending?.id).toBe("turns:reaction");

    const log: LogEntry[] = [
      { input: { kind: "start" }, events: started.events },
      {
        input: {
          kind: "answer",
          decisionId: started.pending?.id ?? "",
          optionId: "0",
        },
        events: first.events,
      },
      {
        input: {
          kind: "answer",
          decisionId: first.pending?.id ?? "",
          optionId: "act",
        },
        events: second.events,
      },
    ];
    const text = JSON.stringify(createSave(registry, "inline", "mid", log));
    const loaded = loadSave(text, registry, run);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.state).toStrictEqual(second.state);
    expect(pendingDecision(run, loaded.state)?.id).toBe("turns:reaction");

    const fromLive = step(run, second.state, {
      kind: "answer",
      decisionId: "turns:reaction",
      optionId: "block",
    });
    const fromSave = step(run, loaded.state, {
      kind: "answer",
      decisionId: "turns:reaction",
      optionId: "block",
    });
    expect(fromSave).toStrictEqual(fromLive);
  });
});

describe("saves", () => {
  async function savedRun() {
    const fixture = await loadFixture("haunted-house");
    const played = playRun(fixture.run, "save", { maxDecisions: 200 });
    const save = createSave(
      fixture.registry,
      "haunted-house",
      "save",
      played.log,
    );
    return { ...fixture, played, save };
  }

  it("rebuilds the exact state from the log", async () => {
    const { registry, run, played, save } = await savedRun();
    const loaded = loadSave(JSON.stringify(save), registry, run);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.state).toStrictEqual(played.state);
    expect(loaded.warnings).toEqual([]);
  });

  it("doesn't re-roll dice when loading", async () => {
    const { registry, run, save } = await savedRun();
    let rolled = false;
    const spying: RunContext = {
      ...run,
      system: {
        ...run.system,
        resolveCheck: (...args) => {
          rolled = true;
          return run.system.resolveCheck(...args);
        },
      },
    };
    expect(loadSave(JSON.stringify(save), registry, spying).ok).toBe(true);
    expect(rolled).toBe(false);
  });

  it("rejects text that isn't a save", async () => {
    const { registry, run } = await savedRun();
    expect(loadSave("not json", registry, run).ok).toBe(false);
    expect(loadSave('{"formatVersion":1}', registry, run).ok).toBe(false);
  });

  it("rejects an unknown format version", async () => {
    const { registry, run, save } = await savedRun();
    const text = JSON.stringify({ ...save, formatVersion: 99 });
    const loaded = loadSave(text, registry, run);
    expect(loaded.ok || loaded.error).toContain("Unknown save format");
  });

  it("rejects a save from another system", async () => {
    const { registry, run, save } = await savedRun();
    const text = JSON.stringify({
      ...save,
      system: { id: "other", version: "1.0.0" },
    });
    const loaded = loadSave(text, registry, run);
    expect(loaded.ok || loaded.error).toContain('"other" system');
  });

  it("refuses to load when a plugin is missing", async () => {
    const { registry, run, save } = await savedRun();
    const text = JSON.stringify({
      ...save,
      plugins: [...save.plugins, { id: "gone", version: "1.0.0", hash: "x" }],
    });
    const loaded = loadSave(text, registry, run);
    expect(loaded.ok || loaded.error).toContain('"gone"');
  });

  it("warns when a plugin has changed", async () => {
    const { registry, run, save } = await savedRun();
    const text = JSON.stringify({
      ...save,
      plugins: save.plugins.map((plugin) => ({ ...plugin, hash: "changed" })),
    });
    const loaded = loadSave(text, registry, run);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.warnings.length).toBeGreaterThan(0);
  });

  it("rejects a tampered system event", async () => {
    const { registry, run, save } = await savedRun();
    const log = [
      ...save.log,
      {
        input: { kind: "start" },
        events: [{ kind: "d6:luckChanged", payload: { actor: 7, by: "lots" } }],
      },
    ];
    const loaded = loadSave(JSON.stringify({ ...save, log }), registry, run);
    expect(loaded.ok || loaded.error).toContain("Invalid event");
  });

  it("rejects an event from outside the known list", async () => {
    const { registry, run, save } = await savedRun();
    const log = [
      ...save.log,
      { input: { kind: "start" }, events: [{ kind: "madeUp" }] },
    ];
    expect(loadSave(JSON.stringify({ ...save, log }), registry, run).ok).toBe(
      false,
    );
  });

  it("stores saves through Storage", async () => {
    const { registry, run, save } = await savedRun();
    const storage = memoryStorage({});
    await storage.replaceAtomically("saves/run.json", JSON.stringify(save));
    const loaded = loadSave(
      (await storage.read("saves/run.json")) ?? "",
      registry,
      run,
    );
    expect(loaded.ok).toBe(true);
  });
});

describe("the test bot", () => {
  it.each(["goblin-ambush", "haunted-house"])(
    "finishes %s across many seeds, with every run replaying exactly",
    async (adventure) => {
      const { run } = await loadFixture(adventure);
      const report = testAdventure(run, { runs: 150, maxDecisions: 300 });
      expect(report.failures).toEqual([]);
      expect(report.unvisitedScenes).toEqual([]);
    },
  );

  it("keeps state as frozen, plain JSON at every step", async () => {
    const { run } = await loadFixture("haunted-house");
    for (const seed of SEEDS) {
      playRun(run, seed, {
        maxDecisions: 300,
        onState: (state: GameState) => {
          // Freezing makes any handler that mutates state throw.
          deepFreeze(state);
          expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
        },
      });
    }
  });

  it("reports a dead end, with the seed and inputs to reproduce it", async () => {
    const { run } = await loadInline({
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Go, effects: [{ kind: goto, scene: stuck }] }
- id: stuck
  text: Stuck.
  choices:
    - { label: Hidden, when: { kind: flag, flag: never }, effects: [{ kind: goto, scene: end }] }
- { id: end, text: End. }
`,
    });
    const report = testAdventure(run, { runs: 1, maxDecisions: 10 });
    expect(report.failures[0]?.problem).toContain("deadEnd at scene stuck");
    expect(report.failures[0]?.seed).toBe("bot-0");
    expect(report.failures[0]?.inputs.length).toBe(2);
  });

  it("reports an adventure that never ends", async () => {
    const { run } = await loadInline({
      "scenes.yaml": `
- id: start
  text: Start.
  choices:
    - { label: Loop, effects: [{ kind: goto, scene: start }] }
    - { label: Hidden, when: { kind: flag, flag: never }, effects: [{ kind: goto, scene: end }] }
- { id: end, text: End. }
`,
    });
    const report = testAdventure(run, { runs: 1, maxDecisions: 10 });
    expect(report.failures[0]?.problem).toContain("tooLong");
  });

  it("reports a replay that diverges", async () => {
    const { run } = await loadFixture("goblin-ambush");
    let calls = 0;
    const flaky: RunContext = {
      ...run,
      system: {
        ...run.system,
        // Different results on repeat calls, as hidden randomness would give.
        createRun: () => {
          calls += 1;
          return { luck: { [PLAYER_ACTOR]: calls } };
        },
      },
    };
    const report = testAdventure(flaky, { runs: 1, maxDecisions: 300 });
    expect(report.failures[0]?.problem).toBe("Replay diverged");
  });

  propertyTest.prop([fc.string()], { numRuns: 60 })(
    "any seed gives a replayable run",
    async (seed) => {
      const { run } = await loadFixture("haunted-house");
      const played = playRun(run, seed, { maxDecisions: 300 });
      const replay = replayInputs(run, seed, played.inputs);
      expect(replay.state).toStrictEqual(played.state);
      expect(replay.log).toStrictEqual(played.log);
    },
  );
});
