import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  Decision,
  GameEvent,
  GameState,
} from "../../engine/kernel/events.ts";
import {
  type LogEntry,
  type SaveFile,
  createSave,
  loadSave,
} from "../../engine/kernel/save.ts";
import { pendingDecision, startRun, step } from "../../engine/kernel/turn.ts";
import { createNodeStorage } from "../../engine/platform/node/storage.ts";
import { listAdventures, loadAdventure } from "./load-adventure.ts";

// A plain text way to play before the UI exists: npm run play -- <adventure> [seed]
// Using the same adventure and seed again resumes that run from its save.

const [adventure, seedArgument] = process.argv.slice(2);
if (!adventure) {
  console.log(`Adventures: ${(await listAdventures()).join(", ")}`);
  console.log("Usage: npm run play -- <adventure> [seed]");
  process.exit(0);
}

const seed = seedArgument ?? randomUUID();
const savePath = `saves/${adventure}-${seed}.json`;
const storage = await createNodeStorage(process.cwd());
const { registry, run } = await loadAdventure(adventure);

const ActorNamesSchema = z.object({
  actors: z.record(z.string(), z.object({ name: z.string() })),
});
const knownNames = new Map<string, string>();

// Monsters leave the state when a fight ends, so names are remembered as they appear.
function learnNames(system: unknown): void {
  const parsed = ActorNamesSchema.safeParse(system);
  if (!parsed.success) return;
  for (const [id, { name }] of Object.entries(parsed.data.actors)) {
    knownNames.set(id, name);
  }
}

function nameOf(id: unknown): string {
  return knownNames.get(String(id)) ?? String(id);
}

function describe(event: GameEvent): string | null {
  switch (event.kind) {
    case "sceneEntered":
      return `\n--- ${event.scene} ---`;
    case "checkResolved":
      return `Result: ${event.outcome}.`;
    case "encounterStarted":
      return "\nA fight breaks out!";
    case "encounterEnded":
      return "The fight is over.";
    case "actorDowned":
      return `${nameOf(event.actor)} is down!`;
    case "actorDefeated":
      return `${nameOf(event.actor)} is defeated.`;
    case "adventureEnded":
      return `\nThe adventure is over (${event.reason}).`;
    case "partyDefeated":
      return "\nYour party has fallen.";
    default:
      if ("payload" in event && event.kind.endsWith(":rollReported")) {
        const { label, natural, total, target, success } = event.payload;
        return `${String(label)}: rolled ${String(natural)}, total ${String(total)} against ${String(target)}, ${success === true ? "success" : "failure"}.`;
      }
      if ("payload" in event && event.kind.endsWith(":damaged")) {
        const { actor, amount, type } = event.payload;
        return `${nameOf(actor)} takes ${String(amount)} ${String(type)} damage.`;
      }
      if ("payload" in event && event.kind.endsWith(":healed")) {
        const { actor, amount } = event.payload;
        return `${nameOf(actor)} regains ${String(amount)} HP.`;
      }
      return null;
  }
}

function report(events: readonly GameEvent[]): void {
  for (const event of events) {
    if ("payload" in event && event.kind.endsWith(":combatStarted")) {
      learnNames({
        actors: Object.fromEntries(
          z
            .array(z.object({ id: z.string(), name: z.string() }))
            .parse(event.payload.monsters)
            .map(({ id, name }) => [id, { name }]),
        ),
      });
    }
    const line = describe(event);
    if (line !== null) console.log(line);
  }
}

function ask(decision: Decision): void {
  console.log(`\n${decision.prompt}`);
  decision.options.forEach((option, index) => {
    console.log(`  ${String(index + 1)}. ${option.label}`);
  });
  process.stdout.write("> ");
}

async function persist(log: readonly LogEntry[]): Promise<void> {
  const save: SaveFile = createSave(registry, adventure ?? "", seed, log);
  await storage.replaceAtomically(savePath, JSON.stringify(save));
}

const log: LogEntry[] = [];
let state: GameState;
let pending: Decision | null;

const existing = await storage.read(savePath);
if (existing !== null) {
  const loaded = loadSave(existing, registry, run);
  if (!loaded.ok) throw new Error(loaded.error);
  for (const warning of loaded.warnings) console.warn(`Warning: ${warning}`);
  log.push(...(loaded.save.log as readonly LogEntry[]));
  ({ state } = loaded);
  learnNames(state.system);
  pending = pendingDecision(run, state);
  console.log(`Resuming ${savePath}`);
} else {
  const started = startRun(run, seed);
  ({ state, pending } = started);
  log.push({ input: { kind: "start" }, events: started.events });
  learnNames(state.system);
  report(started.events);
  await persist(log);
}

if (!pending) {
  console.log(
    `This run has already ended (${state.story.ended ?? "unknown"}).`,
  );
  process.exit(0);
}
ask(pending);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  // Always set here: the loop stops as soon as nothing is waiting.
  const decision = pendingDecision(run, state);
  if (!decision) break;
  const option = decision.options[Number(line.trim()) - 1];
  if (!option) {
    console.log("Please enter one of the numbers above.");
    process.stdout.write("> ");
    continue;
  }
  const input = {
    kind: "answer",
    decisionId: decision.id,
    optionId: option.id,
  } as const;
  const outcome = step(run, state, input);
  if (!outcome.ok) throw new Error(outcome.error);
  ({ state } = outcome);
  learnNames(state.system);
  log.push({ input, events: outcome.events });
  report(outcome.events);
  await persist(log);
  if (!outcome.pending) break;
  ask(outcome.pending);
}
lines.close();
console.log(`\nSaved to ${savePath}`);
