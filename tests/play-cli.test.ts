import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCREEN_VERSION } from "../engine/tools/headless.ts";

// `npm run play -- --script=…` prints one JSON line per command: a contract agents rely on.
const run = promisify(execFile);
let folder = "";
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "re-roll-play-"));
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function play(
  commands: unknown[],
): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  const script = join(folder, `script-${String(commands.length)}.json`);
  await writeFile(script, JSON.stringify(commands));
  const args = [
    "app/cli/play.ts",
    "goblin-ambush",
    "--seed=cli",
    `--saves=${folder}`,
    `--script=${script}`,
  ];
  const result = await run(process.execPath, args).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { code: number; stdout: string }) => error,
  );
  const lines = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code: result.code, lines };
}

describe("the play CLI's script protocol", () => {
  it("prints the opening screen and one versioned line per command", async () => {
    const { code, lines } = await play(["Human Fighter", { saves: true }, 1]);
    expect(code).toBe(0);
    expect(lines.map((line) => line.step)).toEqual([0, 1, 2, 3]);
    for (const line of lines) {
      expect(line.version).toBe(SCREEN_VERSION);
      expect(line).toHaveProperty("command");
      expect(line).toHaveProperty("screen");
      expect(line).not.toHaveProperty("error");
    }
    expect(lines[0]?.command).toEqual({
      start: { adventure: "goblin-ambush", seed: "cli" },
    });
    expect(lines[2]?.result).toEqual([
      expect.objectContaining({ n: 1, kind: "autosave" }),
    ]);
  });

  it("exits 1 on a bad command, printing the error with the screen", async () => {
    const { code, lines } = await play(["Human Fighter", { bogus: true }, 1]);
    expect(code).toBe(1);
    expect(lines).toHaveLength(3); // the file script stops at the failed step
    const last = lines.at(-1);
    expect(last).toMatchObject({ version: SCREEN_VERSION, step: 2 });
    expect(last?.error).toEqual(expect.any(String));
    expect(last).toHaveProperty("screen");
  });
});
