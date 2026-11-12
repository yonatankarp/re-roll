import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHeadless } from "../app/cli/headless-game.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { GameView } from "../engine/shell/session.ts";
import type { Driver, Screen } from "../engine/tools/headless.ts";

const folders: string[] = [];
async function driver(): Promise<Driver> {
  const folder = await mkdtemp(join(tmpdir(), "re-roll-headless-"));
  folders.push(folder);
  return openHeadless(folder);
}
afterAll(async () => {
  for (const folder of folders)
    await rm(folder, { recursive: true, force: true });
});

// Everything but the warnings, which only say how the last step went.
function settled(view: GameView): GameView {
  return { ...view, warnings: [] };
}

const MOVE = "move";
const GEAR = /^(equip|stow|attune|unattune):/;

describe("headless play of goblin-ambush", () => {
  it("plays a fight, treasure, equipping, a rest, a save and load, an ending and a restart", async () => {
    const play = await driver();
    await play.start("goblin-ambush", {
      seed: "fight1",
      settings: { difficulty: "story" },
    });
    await play.choose("Human Fighter");
    const done = {
      moved: false,
      attacked: 0,
      found: false,
      equipped: false,
      rested: false,
      reloaded: false,
    };

    for (let count = 0; count < 200; count += 1) {
      const screen: Screen = play.screen();
      expect(screen.problems).toEqual([]);
      if (!screen.decision) break;
      const ids = screen.choices.map((choice) => choice.id);
      const board = screen.combat?.board as
        { moves: { x: number; y: number }[] } | undefined;

      if (
        !done.moved &&
        ids.includes(MOVE) &&
        board &&
        board.moves.length > 0
      ) {
        // As the map does: Move, then a square. Every square it lights must then be offered.
        await play.act(MOVE);
        const offered = play.screen().choices.map((choice) => choice.id);
        for (const { x, y } of board.moves) {
          expect(offered).toContain(`${String(x)},${String(y)}`);
        }
        const [first] = board.moves;
        await play.act(`${String(first?.x)},${String(first?.y)}`);
        done.moved = true;
        continue;
      }
      const attack = screen.choices.find(
        (choice) => choice.group === "Attacks",
      );
      if (attack) {
        await play.choose(attack.n);
        done.attacked += 1;
        continue;
      }
      if (screen.card?.title === "Found") done.found = true;
      const fromSheet = screen.choices.find(
        (choice) => choice.where === "sheet" && choice.id.startsWith("equip:"),
      );
      if (fromSheet && !done.equipped) {
        await play.choose(fromSheet.n);
        const item = fromSheet.label
          .replace(/^Equip /, "")
          .replace(/ ×\d+$/, "");
        const row = play
          .view()
          .sheets[0]?.sections.flatMap((section) => section.rows)
          .find((each) => each.label.startsWith(item));
        expect(row?.value).toBe("Equipped");
        done.equipped = true;

        // A save then a load gives back the same game, replayed from its log.
        const before = settled(play.view());
        const path = await play.save("mid");
        await play.load(path);
        expect(settled(play.view())).toEqual(before);
        expect((await play.saves()).map((save) => save.path)).toContain(path);
        await play.deleteSave(path);
        expect((await play.saves()).map((save) => save.path)).not.toContain(
          path,
        );
        done.reloaded = true;
        continue;
      }
      const rest = screen.choices.find((choice) => choice.where === "rest");
      if (rest && !done.rested) {
        await play.choose(rest.n);
        done.rested = true;
        continue;
      }
      const next = screen.choices.find(
        (choice) =>
          choice.where === "list" &&
          choice.id !== MOVE &&
          !GEAR.test(choice.id),
      );
      if (!next) throw new Error(`Nothing to pick at ${screen.decision}`);
      await play.choose(next.n);
    }

    const end = play.screen();
    expect(end.ended).toBe("ending");
    expect(end.endingName).not.toBeNull();
    expect(end.choices).toEqual([]);
    expect(done).toEqual({
      moved: true,
      attacked: done.attacked,
      found: true,
      equipped: true,
      rested: true,
      reloaded: true,
    });
    expect(done.attacked).toBeGreaterThan(0);

    // The same adventure again, with the same settings and fresh dice.
    await play.restart("again");
    const again = play.screen();
    expect(again.decision).toBe("dnd5.5e:chooseCharacter");
    expect(again.ended).toBeNull();
    expect(
      (play.view().systemState as { difficulty?: string }).difficulty,
    ).toBe("story");
  }, 60_000);

  it("chooses only what is on screen", async () => {
    const play = await driver();
    await play.start("goblin-ambush", { seed: "refuse" });
    await expect(play.choose("Not a choice")).rejects.toThrow(
      "isn't one of the choices",
    );
    await expect(play.act(MOVE)).rejects.toThrow("isn't one of the choices");
    await play.choose("human fighter"); // labels ignore case
    expect(play.screen().decision).toBe("scene:road");
  });
});

// Random choices from what is on screen, through every adventure, so a state no player could get past fails.
// Book adventures are git-ignored in private/, so they only run where it exists.
describe("headless random play of every adventure", async () => {
  const lister = await driver();
  const adventures = await lister.listAdventures();
  const shipped = adventures.filter((item) => item.source === "shipped");
  const books = adventures.filter((item) => item.source === "private");
  const MAX_DECISIONS = 1000;
  const SEEDS = ["headless-0", "headless-1"];

  const playThrough = async (
    adventure: string,
    seed: string,
  ): Promise<string> => {
    const play = await driver();
    const dice = createDice(rngFromSeed(`${seed}:policy`));
    await play.start(adventure, { seed });
    for (let count = 0; count < MAX_DECISIONS; count += 1) {
      const screen = play.screen();
      if (screen.problems.length > 0) {
        throw new Error(
          `${adventure} ${seed}, step ${String(count)}: ${screen.problems.join("; ")}`,
        );
      }
      if (!screen.decision) return screen.ended ?? "none";
      // Rests come back to the same choice, so they would only make runs longer.
      const choices = screen.choices.filter(
        (choice) => choice.where === "list",
      );
      const choice = choices[dice.below(choices.length)];
      if (!choice)
        throw new Error(
          `${adventure} ${seed}: ${screen.decision} has only rests`,
        );
      await play.choose(choice.n);
    }
    return "tooLong"; // not stuck, only long
  };

  it.each(shipped.map((item) => item.id))(
    "finishes %s",
    async (adventure) => {
      for (const seed of SEEDS) {
        expect(["ending", "defeat", "tooLong"]).toContain(
          await playThrough(adventure, seed),
        );
      }
    },
    120_000,
  );

  it
    .skipIf(!existsSync("private") || books.length === 0)
    .each(
      books.length > 0
        ? books.map((item) => item.id)
        : ["(no private adventures)"],
    )(
    "finishes the book adventure %s",
    async (adventure) => {
      expect(["ending", "defeat", "tooLong"]).toContain(
        await playThrough(adventure, SEEDS[0] ?? ""),
      );
    },
    300_000,
  );
});
