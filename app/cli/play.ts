import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  SCREEN_VERSION,
  type Driver,
  screenText,
} from "../../engine/tools/headless.ts";
import { openHeadless } from "./headless-game.ts";

// Plays an adventure with no browser, through the same game layer as the app.
// npm run play -- <adventure> [--seed=N] [--difficulty=story|normal|hard] [--saves=dir] [--script=file.json|-]
// Without --script it is interactive text. With it, each command's screen is printed as one JSON line.

const Ref = z.union([z.string(), z.number()]);
const CommandSchema = z.union([
  Ref, // a choice on screen: its number, id or label
  z.object({ choose: Ref }).strict(),
  z.object({ act: z.array(z.string()).min(1) }).strict(), // option ids in turn, as the map sends them
  z.object({ save: z.string().min(1) }).strict(),
  z.object({ saves: z.literal(true) }).strict(),
  z.object({ load: Ref }).strict(), // a number in the save list, or a path
  z.object({ delete: Ref }).strict(),
  z.object({ restart: z.string().nullable() }).strict(), // a new seed, or null for a random one
]);
type Command = z.infer<typeof CommandSchema>;

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const [adventure] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"));
const flag = (name: string): string | undefined =>
  flags.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

const driver = await openHeadless(flag("saves"));
if (!adventure) {
  for (const item of await driver.listAdventures()) {
    console.log(`${item.id}  ${item.title} (${item.source})`);
  }
  console.log(
    "Usage: npm run play -- <adventure> [--seed=N] [--difficulty=…] [--saves=dir] [--script=file.json|-]",
  );
  process.exit(0);
}

const difficulty = flag("difficulty");
const seed = flag("seed");
await driver.start(adventure, {
  ...(seed ? { seed } : {}),
  ...(difficulty ? { settings: { difficulty } } : {}),
});

// What the command returns beyond the new screen, such as the save list.
async function run(play: Driver, command: Command): Promise<unknown> {
  if (typeof command === "string" || typeof command === "number") {
    return play.choose(command);
  }
  if ("choose" in command) return play.choose(command.choose);
  if ("act" in command) return play.act(...command.act);
  if ("save" in command) return { path: await play.save(command.save) };
  if ("saves" in command) {
    return (await play.saves()).map((save, index) => ({
      n: index + 1,
      ...save,
    }));
  }
  if ("load" in command) return play.load(command.load);
  if ("delete" in command) return play.deleteSave(command.delete);
  await play.restart(command.restart ?? undefined);
  return { seed: play.seed() };
}

// Interactive words, as the same commands a script uses.
function parseLine(line: string): Command {
  const [word = "", ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (word.toLowerCase()) {
    case "act":
      return { act: rest };
    case "save":
      return { save: arg || new Date().toISOString().replace(/[:.]/g, "-") };
    case "saves":
      return { saves: true };
    case "load":
      return { load: arg };
    case "delete":
      return { delete: arg };
    case "restart":
      return { restart: arg || null };
    default:
      return line.trim();
  }
}

const script = flag("script");
if (script !== undefined) {
  let step = 0;
  const emit = (command: unknown, result: unknown): void => {
    console.log(
      JSON.stringify({
        version: SCREEN_VERSION,
        step,
        command,
        ...(result === undefined ? {} : { result }),
        screen: driver.screen(),
      }),
    );
  };
  const perform = async (raw: unknown): Promise<void> => {
    step += 1;
    try {
      const command = CommandSchema.parse(raw);
      emit(command, (await run(driver, command)) ?? undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        JSON.stringify({
          version: SCREEN_VERSION,
          step,
          command: raw,
          error: message,
        }),
      );
      process.exit(1);
    }
  };
  emit(
    {
      start: {
        adventure,
        seed: driver.seed(),
        ...(difficulty ? { settings: { difficulty } } : {}),
      },
    },
    undefined,
  );
  if (script === "-") {
    // One JSON command per line, so an agent can read each screen before sending the next.
    for await (const line of createInterface({ input: process.stdin })) {
      if (line.trim()) await perform(JSON.parse(line) as unknown);
    }
  } else {
    const commands = z
      .array(z.unknown())
      .parse(JSON.parse(await readFile(script, "utf8")));
    for (const command of commands) await perform(command);
  }
} else {
  console.log(
    `Seed ${driver.seed()}. Type a number, or: act <ids…>, save [name], saves, load <n>, delete <n>, restart [seed], json, quit.`,
  );
  console.log(screenText(driver.screen()));
  process.stdout.write("> ");
  for await (const line of createInterface({ input: process.stdin })) {
    const text = line.trim();
    if (text === "quit") break;
    if (text === "json") {
      console.log(JSON.stringify(driver.screen(), null, 2));
    } else if (text) {
      try {
        const command = parseLine(text);
        const result = await run(driver, command);
        if (typeof command === "object" && "save" in command) {
          console.log(
            `Saved to ${z.object({ path: z.string() }).parse(result).path}`,
          );
        } else if (typeof command === "object" && "delete" in command) {
          console.log("Deleted.");
        } else if (Array.isArray(result)) {
          for (const save of z
            .array(
              z.object({ n: z.number(), label: z.string(), path: z.string() }),
            )
            .parse(result)) {
            console.log(`  ${String(save.n)}. ${save.label}  (${save.path})`);
          }
        } else {
          console.log(screenText(driver.screen()));
        }
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    }
    process.stdout.write("> ");
  }
}
