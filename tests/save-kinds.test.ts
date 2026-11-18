import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import { GameEventSchema } from "../engine/kernel/events.ts";
import { AWAIT_FRAME, REPLAY_FRAME } from "../engine/kernel/system.ts";
import { runStoryFrame } from "../engine/story/runtime.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";

// #207: saves store event and frame kinds by name, so none is ever renamed or removed (CLAUDE.md).
// tests/fixtures/kinds.json locks every kind there is. A new kind is added to "kinds" by hand;
// a locked kind the code no longer has fails here. "notInGoldens" lists the kinds no golden save
// (tests/fixtures/saves) holds yet; a golden that reaches one fails here until it leaves the list.
interface KindsFile {
  readonly kinds: readonly string[];
  readonly notInGoldens: readonly string[];
}
const file = JSON.parse(
  await readFile("tests/fixtures/kinds.json", "utf8"),
) as KindsFile;

const literalKinds = (union: { options: unknown[] }): string[] =>
  union.options.map(
    (option) =>
      (option as { shape: { kind: { value: string } } }).shape.kind.value,
  );
const [engineEvents, narrativeEvents] = GameEventSchema.options as unknown as [
  { options: unknown[] },
  { options: unknown[] },
];
const STORY_FRAMES = file.kinds.filter((kind) => kind.startsWith("story:"));

// Every kind today's code knows. The story frames have no list, so a locked one counts as known
// while the story runtime still has a case for it.
const known = (kind: string): boolean =>
  kind.startsWith("story:") ? !storyFrameUnknown(kind) : current.includes(kind);
const current = [
  ...literalKinds(engineEvents),
  ...literalKinds(narrativeEvents),
  ...Object.keys(dnd55e.eventSchemas),
  ...Object.keys(dnd55e.frames),
  AWAIT_FRAME,
  REPLAY_FRAME,
];

function storyFrameUnknown(kind: string): boolean {
  try {
    runStoryFrame(
      { system: {} } as never,
      { story: {}, system: {} } as never,
      createDice(rngFromSeed("kinds")),
      { kind, payload: {} },
    );
  } catch (error) {
    return (error as Error).message.startsWith("Unknown story frame");
  }
  return false;
}

interface Frame {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

// Kinds a frame on the stack names: itself, a replayed step inside it, the step a decision resumes.
function frameKinds(frame: Frame): string[] {
  const { payload } = frame;
  const inner = payload.frame as Frame | undefined;
  const decision = payload.decision as { resume?: Frame } | undefined;
  return [
    frame.kind,
    ...(inner ? frameKinds(inner) : []),
    ...(decision?.resume ? frameKinds(decision.resume) : []),
  ];
}

async function goldenKinds(): Promise<Set<string>> {
  const folder = "tests/fixtures/saves";
  const names = (await readdir(folder)).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".state.json"),
  );
  const kinds = new Set<string>();
  for (const name of names) {
    const save = JSON.parse(await readFile(`${folder}/${name}`, "utf8")) as {
      log: { events: Record<string, unknown>[] }[];
    };
    for (const event of save.log.flatMap(({ events }) => events)) {
      kinds.add(event.kind as string);
      if (event.kind === "framePushed") {
        for (const kind of frameKinds(event.frame as Frame)) kinds.add(kind);
      }
      if (event.kind === "runStarted") {
        const { stack } = event.state as { stack: Frame[] };
        for (const kind of stack.flatMap(frameKinds)) kinds.add(kind);
      }
    }
  }
  return kinds;
}

describe("event and frame kinds", () => {
  it("keeps every locked kind", () => {
    expect(file.kinds.filter((kind) => !known(kind))).toEqual([]);
    expect(STORY_FRAMES.length).toBeGreaterThan(0);
  });

  it("locks every kind the code has", () => {
    expect(current.filter((kind) => !file.kinds.includes(kind))).toEqual([]);
  });

  it("puts every kind in a golden save, or lists it as not there yet", async () => {
    const covered = await goldenKinds();
    expect(
      file.kinds.filter(
        (kind) => !covered.has(kind) && !file.notInGoldens.includes(kind),
      ),
    ).toEqual([]);
    expect(file.notInGoldens.filter((kind) => covered.has(kind))).toEqual([]);
    expect(
      file.notInGoldens.filter((kind) => !file.kinds.includes(kind)),
    ).toEqual([]);
  });
});
