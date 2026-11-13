import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHeadless } from "../app/cli/headless-game.ts";
import { createDice, rngFromSeed } from "../engine/kernel/dice.ts";
import type { GameView } from "../engine/shell/session.ts";
import type { Driver, Screen } from "../engine/tools/headless.ts";
import { MOVE } from "../plugins/systems/dnd5.5e/core/combat/ids.ts";
import { runs } from "./depth.ts";

const folders: string[] = [];
async function savesFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "re-roll-headless-"));
  folders.push(folder);
  return folder;
}
async function driver(): Promise<Driver> {
  return openHeadless(await savesFolder());
}
afterAll(async () => {
  for (const folder of folders)
    await rm(folder, { recursive: true, force: true });
});

// Everything but the warnings, which only say how the last step went, and the board's cues, which a
// told-again log doesn't replay.
function settled(view: GameView): GameView {
  return { ...view, warnings: [], cues: [] };
}

const GEAR = /^(equip|stow|attune|unattune):/;

describe("headless play of goblin-ambush", () => {
  it("plays a fight, treasure, equipping, a rest, a save and load, an ending and a restart", async () => {
    const saves = await savesFolder();
    const play = await openHeadless(saves);
    await play.start("goblin-ambush", {
      seed: "fight1",
      settings: { difficulty: "story" },
    });
    await play.choose("Human Fighter");
    const done = {
      moved: false,
      movedAtOnce: false,
      attacked: 0,
      found: false,
      equipped: false,
      rested: false,
      reloaded: false,
      traded: false,
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
      // After attacking, the map's one-click move: Move and the square in one go.
      if (
        done.attacked > 0 &&
        !done.movedAtOnce &&
        ids.includes(MOVE) &&
        board &&
        board.moves.length > 0 &&
        !screen.choices.some((choice) => choice.group === "Attacks")
      ) {
        const [square] = board.moves;
        await play.act(MOVE, `${String(square?.x)},${String(square?.y)}`);
        expect(play.screen().decision).not.toBe(screen.decision);
        done.movedAtOnce = true;
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

        // A save, loaded by a fresh game as a later run would, gives back the same game replayed from its log.
        const before = settled(play.view());
        const path = await play.save("mid");
        const later = await openHeadless(saves);
        await later.load(path);
        expect(settled(later.view())).toEqual(before);
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
      // At camp: trade with the peddler, buying the first thing on offer and selling it straight back.
      const trade = screen.choices.find((choice) =>
        choice.label.startsWith("Trade with Tam"),
      );
      if (trade && !done.traded) {
        await play.choose(trade.n);
        const shop = play.view().shop;
        expect(shop?.merchant).toBe("Tam the Peddler");
        const purse = shop?.purse;
        const ware = shop?.buy.find((card) => card.option !== null);
        if (!ware?.option) throw new Error("Nothing affordable at Tam's");
        await play.act(ware.option);
        const after = play.view().shop;
        expect(after?.purse).not.toBe(purse);
        const back = after?.sell.find((card) => card.item === ware.item);
        if (!back?.option) throw new Error(`Tam won't buy ${ware.name}`);
        await play.act(back.option);
        expect(play.screen().lines.map((line) => line.text)).toContain(
          `${play.view().sheets[0]?.title ?? ""} sells ${ware.name} for ${back.price}.`,
        );
        await play.act(after?.leave ?? "leave");
        expect(play.view().shop).toBeNull();
        done.traded = true;
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
      movedAtOnce: true,
      attacked: done.attacked,
      found: true,
      equipped: true,
      rested: true,
      reloaded: true,
      traded: true,
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
    await expect(play.choose(9)).rejects.toThrow("no choice 9");

    // Story options have ids "0" and "1": a string is always an id, a number a place on screen.
    const other = await driver();
    await other.start("goblin-ambush", { seed: "refuse" });
    await other.choose("Human Fighter");
    expect((await play.choose("1")).id).toBe("1");
    expect((await other.choose(1)).id).toBe("0");
  });

  it("casts Bless on targets picked one by one, and a save replays them", async () => {
    const saves = await savesFolder();
    const play = await openHeadless(saves);
    await play.start("goblin-ambush", { seed: "bless" });
    await play.choose("Human Cleric");
    const bless = "spell:srd52:spell/bless|pick";
    for (let count = 0; count < 100; count += 1) {
      const ids = play.screen().choices.map((choice) => choice.id);
      if (ids.includes(bless)) break;
      const first = play.screen().choices.find((c) => c.where === "list");
      if (!first) throw new Error("Nothing to choose");
      await play.choose(first.n);
    }
    await play.act(bless);
    // Every ally the map would light, one click each, then Cast.
    const adds = play
      .screen()
      .choices.filter((choice) => choice.id.startsWith("+"))
      .map((choice) => choice.id);
    expect(adds.length).toBeGreaterThan(1);
    await play.act(...adds.slice(0, 2));
    expect(play.screen().choices.map((c) => c.label)).toContain(
      "Cast Bless (2 of 3)",
    );
    await play.act("cast");
    expect(play.screen().decision).not.toMatch(/:targets:/);
    const before = settled(play.view());
    const path = await play.save("blessed");
    const later = await openHeadless(saves);
    await later.load(path);
    expect(settled(later.view())).toEqual(before);
  }, 60_000);

  it("keeps a sheet's hinted buttons, disabled, while the fight doesn't offer them", async () => {
    const play = await driver();
    await play.start("goblin-ambush", { seed: "gear-hint" });
    await play.choose("Human Fighter");
    const gear = (): string[] =>
      (play.view().sheets[0]?.sections ?? []).flatMap((section) =>
        section.rows.flatMap(({ option }) =>
          option?.hint && GEAR.test(option.id) ? [option.id] : [],
        ),
      );
    const onSheet = (): string[] =>
      play
        .screen()
        .choices.filter((choice) => choice.where === "sheet")
        .map((choice) => choice.id);
    // Between choices the gear is offered, so its buttons are choices.
    expect(gear().length).toBeGreaterThan(0);
    expect(onSheet()).toEqual(expect.arrayContaining(gear()));
    await play.choose("[Perception] Check the treeline");
    for (let count = 0; count < 20 && !play.view().combat; count += 1) {
      const next = play.screen().choices.find((c) => c.where === "list");
      if (!next) throw new Error("Nothing to choose");
      await play.choose(next.n);
    }
    // In a fight they stay on the sheet, for the page to draw disabled, and aren't choices.
    expect(play.view().combat).not.toBeNull();
    expect(gear().length).toBeGreaterThan(0);
    expect(onSheet().filter((id) => GEAR.test(id))).toEqual([]);
  });
});

// Random choices from what is on screen, through every adventure, so a state no player could get past fails.
// Book adventures are git-ignored in books/, so they only run where it exists.
describe("headless random play of every adventure", async () => {
  const lister = await driver();
  const adventures = await lister.listAdventures();
  const shipped = adventures.filter((item) => item.source === "shipped");
  const books = adventures.filter((item) => item.source === "private");
  const MAX_DECISIONS = 1000;
  const SEEDS = Array.from(
    { length: runs(4, 8) },
    (_, index) => `headless-${String(index)}`,
  );

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
      // Rests and a sheet's buttons come back to the same choice, so they would only make runs longer.
      const choices = screen.choices.filter(
        (choice) => choice.where !== "rest" && choice.where !== "sheet",
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

  // A shipped adventure must end within MAX_DECISIONS, so an endless loop fails here.
  it.each(
    shipped.flatMap((item) => SEEDS.map((seed) => [item.id, seed] as const)),
  )(
    "finishes %s with seed %s",
    async (adventure, seed) => {
      expect(["ending", "defeat"]).toContain(
        await playThrough(adventure, seed),
      );
    },
    120_000,
  );

  it
    .skipIf(!existsSync("books") || books.length === 0)
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
