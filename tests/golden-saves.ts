// Writes the golden saves under tests/fixtures/saves from fixed-seed runs of the shipped adventures.
// Run it only to add a save: the committed files stand for saves players already have, and
// tests/golden-saves.test.ts checks that today's code still loads them.
import { mkdir, writeFile } from "node:fs/promises";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { Decision, GameState, Input } from "../engine/kernel/events.ts";
import { type LogEntry, createSave } from "../engine/kernel/save.ts";
import { pendingDecision, startRun, step } from "../engine/kernel/turn.ts";

process.env.RE_ROLL_ROOTS = "plugins"; // shipped content only: the repository is public
const { loadAdventure } = await import("../app/cli/load-adventure.ts");

const GOLDEN_FOLDER = "tests/fixtures/saves";
const SEED = "golden";

interface Golden {
  readonly name: string;
  readonly adventure: string;
  readonly prefer: readonly string[]; // option ids containing these are picked first, in this order
  readonly stop: (state: GameState, pending: Decision) => boolean;
}

const inCombat = (state: GameState): boolean =>
  Boolean((state.system as { combat?: unknown }).combat);

const GOLDENS: readonly Golden[] = [
  {
    name: "mid-creation",
    adventure: "goblin-ambush",
    prefer: ["create"],
    stop: (_, pending) => pending.id.includes(":score-14"),
  },
  {
    name: "after-loot",
    adventure: "goblin-ambush",
    prefer: ["fighter", "done"],
    stop: (state) => state.story.scene === "fight" && state.stack.length === 0,
  },
  {
    name: "mid-combat",
    adventure: "goblin-ambush",
    prefer: ["fighter", "done"],
    stop: (state, pending) =>
      inCombat(state) && pending.id.includes(":turn:player:2"),
  },
  {
    name: "mid-rest",
    adventure: "goblin-ambush",
    prefer: ["fighter", "done", "rest:short"],
    stop: (_, pending) => pending.id.includes(":shortRest:"),
  },
];

const MAX_ANSWERS = 120;

for (const golden of GOLDENS) {
  const { registry, run } = await loadAdventure(golden.adventure);
  const tactics = createDice(rngFromSeed(`${SEED}:tactics`));
  const started = startRun(run, SEED);
  let state = started.state;
  const log: LogEntry[] = [
    { input: { kind: "start" }, events: started.events },
  ];
  let pending = pendingDecision(run, state);
  for (let count = 0; ; count += 1) {
    if (!pending || count >= MAX_ANSWERS) {
      throw new Error(`${golden.name} never reached its stopping point`);
    }
    if (count > 0 && golden.stop(state, pending)) break;
    const decision = pending;
    const preferred = golden.prefer
      .map((part) =>
        decision.options.find((option) => option.id.includes(part)),
      )
      .find((option) => option !== undefined);
    // Fights are played with the system's own tactics, so the hero lives long enough to rest.
    const optionId = run.system.tactical?.(decision)
      ? run.system.decidePolicy(decision, {
          state: state.system,
          dice: tactics,
          content: run.content,
          contentIds: run.contentIds,
        })
      : (preferred ?? decision.options[0])?.id;
    if (optionId === undefined)
      throw new Error(`${decision.id} has no options`);
    const input: Input = { kind: "answer", decisionId: decision.id, optionId };
    const outcome = step(run, state, input);
    if (!outcome.ok) throw new Error(outcome.error);
    state = outcome.state;
    log.push({ input, events: outcome.events });
    pending = outcome.pending;
  }
  await mkdir(GOLDEN_FOLDER, { recursive: true });
  const save = createSave(registry, golden.adventure, SEED, log);
  await writeFile(
    `${GOLDEN_FOLDER}/${golden.name}.json`,
    `${JSON.stringify(save)}\n`,
  );
  await writeFile(
    `${GOLDEN_FOLDER}/${golden.name}.state.json`,
    `${JSON.stringify(state)}\n`,
  );
  console.log(`${golden.name}: ${String(log.length)} inputs`);
}
