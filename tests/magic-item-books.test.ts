import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import {
  type RunContext,
  createRunContext,
  startRun,
  step,
} from "../engine/run/turn.ts";
import {
  type Actor,
  NS,
  StateSchema,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  saveBonus,
  spellSaveDc,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of the book's magic items (issue #137), played by a pregen. Skipped where the books aren't present.
const BOOKS =
  BOOK_ROOTS &&
  existsSync("books/rules/dmg") &&
  existsSync("books/rules/arcana-unleashed-deadfall") &&
  existsSync("books/rules/eberron-forge-of-the-artificer");

let run: RunContext;

beforeAll(async () => {
  if (!BOOKS) return;
  const storage = await createPlayStorage(
    process.cwd(),
    await mkdtemp(join(tmpdir(), "magic-item-books-")),
  );
  const catalog = await scanPlugins(storage, ["plugins", "books"]);
  const loaded = await loadRun(storage, catalog, systems, [
    "goblin-ambush",
    "phb",
    "dmg",
    "arcana-unleashed-deadfall",
    "eberron-forge-of-the-artificer",
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  run = createRunContext(loaded.registry, "goblin-ambush");
});

// The pregen wearing `items` in place of its armor and shield, attuned to every one.
function wearing(items: readonly string[], pregen = "fighter"): Actor {
  const chosen = step(run, startRun(run, "books").state, {
    kind: "answer",
    decisionId: `${NS}:chooseCharacter`,
    optionId: `srd52:pregen/${pregen}`,
  });
  if (!chosen.ok) throw new Error(chosen.error);
  const actor = StateSchema.parse(chosen.state.system).actors[PLAYER_ACTOR];
  if (!actor) throw new Error("No player");
  return {
    ...actor,
    inventory: [
      ...actor.inventory.filter(
        (id) => id !== "srd52:item/chain-mail" && id !== "srd52:item/shield",
      ),
      ...items,
    ],
    attuned: [...items],
  };
}

describe.skipIf(!BOOKS)("the book's magic items", () => {
  it("gives a Cloak of Protection's AC and saves", () => {
    const plain = deriveStats(wearing([]), run);
    const cloaked = deriveStats(wearing(["dmg:item/cloak-of-protection"]), run);
    expect(cloaked.ac - plain.ac).toBe(1);
    expect(saveBonus(cloaked, "dex") - saveBonus(plain, "dex")).toBe(1);
  });

  it("wears +N armor and Shields, and Elven Chain without training", () => {
    const armor = "dmg:item/armor-1-2-or-3--1--chain-mail";
    const shield = "dmg:item/shield-1-2-or-3--3--shield";
    expect(run.content(armor)).toMatchObject({ name: "+1 Chain Mail" });
    expect(deriveStats(wearing([armor, shield]), run).ac).toBe(16 + 1 + 2 + 3);
    const wizard = deriveStats(
      wearing(["dmg:item/elven-chain--1--chain-mail"], "wizard"),
      run,
    );
    expect(wizard.untrainedArmor).toBe(false);
    expect(wizard.ac).toBe(17);
  });

  it("sets Strength with a Belt of Giant Strength", () => {
    const storm = "dmg:item/belt-of-giant-strength--6";
    expect(run.content(storm)).toMatchObject({
      name: "Belt of Giant Strength (storm)",
    });
    expect(deriveStats(wearing([storm]), run).abilities.str).toBe(29);
  });

  it("raises a Robe of Thayan Arcana's wearer's spell save DC", () => {
    const robe = "arcana-unleashed-deadfall:item/robe-of-thayan-arcana";
    const plain = deriveStats(wearing([], "wizard"), run);
    const robed = deriveStats(wearing([robe], "wizard"), run);
    expect(spellSaveDc(robed) - spellSaveDc(plain)).toBe(1);
  });

  it("makes a Returning Weapon from a thrown one", () => {
    expect(
      run.content(
        "eberron-forge-of-the-artificer:item/returning-weapon--1--javelin",
      ),
    ).toMatchObject({
      name: "Returning Weapon (Javelin)",
      type: "weapon",
      returning: true,
    });
  });
});
