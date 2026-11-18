// Writes the golden saves under tests/fixtures/saves from fixed-seed runs of the shipped adventures.
// A save (<name>.json) stands for saves players already have, so it is only ever added, never
// rewritten: this skips any that exist. tests/golden-saves.test.ts checks today's code still loads them.
// With --snapshots it rewrites only each save's snapshot (<name>.state.json) by loading it, for when
// the state's shape changed on purpose. Review that diff: the snapshot is what the save must fold to.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { Decision, GameState, Input } from "../engine/kernel/events.ts";
import { type LogEntry, createSave, loadSave } from "../engine/run/save.ts";
import { pendingDecision, startRun, step } from "../engine/run/turn.ts";

process.env.RE_ROLL_ROOTS = "plugins"; // shipped content only: the repository is public
const { loadAdventure } = await import("../app/cli/load-adventure.ts");

const GOLDEN_FOLDER = "tests/fixtures/saves";
const SEED = "golden";

interface Golden {
  readonly name: string;
  readonly adventure: string;
  readonly prefer: readonly string[]; // option ids containing these are picked first, in this order
  readonly choose?: Readonly<Record<string, string>>; // the exact option picked for a decision id, before prefer
  readonly seed?: string;
  readonly stop: (state: GameState, pending: Decision) => boolean;
}

const inCombat = (state: GameState): boolean =>
  Boolean((state.system as { combat?: unknown }).combat);

const carried = (state: GameState, actor: string): readonly string[] =>
  (state.system as { actors: Record<string, { inventory: string[] }> }).actors[
    actor
  ]?.inventory ?? [];

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
  {
    name: "wizard-reaction", // a goblin's attack waits on the wizard's Shield
    adventure: "goblin-ambush",
    prefer: ["pregen/wizard", "done"],
    stop: (_, pending) => pending.id === "dnd5.5e:reaction:player",
  },
  {
    name: "level-up", // the wizard picks the spells level 2 gives
    adventure: "goblin-ambush",
    prefer: ["pregen/wizard", "done"],
    stop: (_, pending) => pending.id.includes(":build:player:2:spells"),
  },
  {
    name: "shop", // a dagger bought from Tam, still at the counter
    adventure: "goblin-ambush",
    prefer: ["pregen/wizard", "done"],
    choose: { "scene:camp": "2", "dnd5.5e:shop:0": "buy:srd52:item/dagger" },
    stop: (_, pending) => pending.id === "dnd5.5e:shop:1",
  },
  {
    name: "long-rest", // back on the road after a night's sleep
    adventure: "goblin-ambush",
    prefer: ["pregen/wizard", "done"],
    choose: { "scene:road": "rest:long" },
    stop: (state, pending) =>
      pending.id === "scene:road" && state.story.restedIn !== undefined,
  },
  {
    name: "death-saves", // the wizard down, one death save made
    adventure: "goblin-ambush",
    seed: "golden-7", // a fight the wizard loses
    prefer: ["pregen/wizard", "done"],
    stop: (_, pending) => pending.id === "dnd5.5e:deathSave:player:2",
  },
  {
    name: "haunted-house", // the caretaker won over and a secret told
    adventure: "haunted-house",
    prefer: ["pregen/cleric", "done"],
    choose: { "scene:hallway": "1" },
    stop: (_, pending) => pending.id === "scene:cellar-door",
  },
  {
    name: "haunted-house-dread", // the dread clock run up and its beat fired
    adventure: "haunted-house",
    prefer: ["pregen/cleric", "done"],
    choose: { "scene:hallway": "0" },
    stop: (_, pending) => pending.id === "scene:cellar-door",
  },
  {
    name: "camp-potion", // a potion drunk at camp
    adventure: "goblin-ambush",
    prefer: ["pregen/wizard", "done"],
    choose: { "scene:camp": "drink:srd52:item/potion-of-healing" },
    stop: (state, pending) =>
      pending.id === "scene:camp" &&
      !carried(state, "player").includes("srd52:item/potion-of-healing"),
  },
];

const MAX_ANSWERS = 120;

const snapshotsOnly = process.argv.includes("--snapshots");

for (const golden of GOLDENS) {
  const { registry, run } = await loadAdventure(golden.adventure);
  const savePath = `${GOLDEN_FOLDER}/${golden.name}.json`;
  const statePath = `${GOLDEN_FOLDER}/${golden.name}.state.json`;
  if (existsSync(savePath)) {
    if (snapshotsOnly) {
      const loaded = loadSave(await readFile(savePath, "utf8"), registry, run);
      if (!loaded.ok) throw new Error(`${golden.name}: ${loaded.error}`);
      await writeFile(statePath, `${JSON.stringify(loaded.state)}\n`);
      console.log(`${golden.name}: snapshot rewritten`);
    } else {
      console.log(`${golden.name}: kept, since saves are never rewritten`);
    }
    continue;
  }
  const seed = golden.seed ?? SEED;
  const tactics = createDice(rngFromSeed(`${seed}:tactics`));
  const started = startRun(run, seed);
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
    const chosen = golden.choose?.[decision.id];
    const preferred = chosen
      ? decision.options.find((option) => option.id === chosen)
      : golden.prefer
          .map((part) =>
            decision.options.find((option) => option.id.includes(part)),
          )
          .find((option) => option !== undefined);
    // Fights are played with the system's own tactics, so the hero lives long enough to rest.
    const optionId = chosen
      ? preferred?.id
      : run.system.tactical?.(decision)
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
  const save = createSave(registry, golden.adventure, seed, log);
  await writeFile(savePath, `${JSON.stringify(save)}\n`);
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  console.log(`${golden.name}: ${String(log.length)} inputs`);
}
