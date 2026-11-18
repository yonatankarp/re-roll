import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import {
  CompanionSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #144's entries as the books encode them.

const PLUGINS = ["phb", "dmg", "arcana-unleashed"];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

describe.skipIf(!BOOKS)("the books' summons", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "summons-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("lets Summon Undead call any of its three forms, each with its own attack", () => {
    const spell = SpellSchema.parse(run.content("phb:spell/summon-undead"));
    expect(spell.activation?.shapes?.map((shape) => shape.name)).toEqual([
      "Ghostly",
      "Putrid",
      "Skeletal",
    ]);
    const spirit = CompanionSchema.parse(
      run.content("phb:companion/undead-spirit"),
    );
    expect(
      spirit.play?.actions.find((action) => action.name === "Grave Bolt")
        ?.shapes,
    ).toEqual(["Skeletal"]);
  });

  it("keeps Animate Dead's undead between fights", () => {
    const spell = SpellSchema.parse(run.content("phb:spell/animate-dead"));
    expect(spell.activation?.outOfCombat).toBe(true);
    expect(spell.activation?.resolution).toMatchObject({
      effects: [{ kind: "retain", monster: "monster-manual:monster/skeleton" }],
    });
  });
});
