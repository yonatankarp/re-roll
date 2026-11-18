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
  SpellSchema,
  SubclassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { understands } from "../plugins/systems/dnd5.5e/core/explore.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #150's and #151's entries as the books encode them.

const PLUGINS = ["phb", "arcana-unleashed", "dmg"];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

describe.skipIf(!BOOKS)("the books' language and social entries", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "social-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("teaches a Druid Druidic, which a Fighter doesn't know", () => {
    const druid = levelTo(run, "phb:class/druid", null, 1);
    const fighter = levelTo(run, "phb:class/fighter", null, 1);
    expect(understands("druidic", [druid], run)).toBe(true);
    expect(understands("druidic", [fighter], run)).toBe(false);
    expect(deriveStats(druid, run).actions.map((item) => item.id)).toContain(
      "spell:phb:spell/speak-with-animals",
    );
  });

  it("casts Comprehend Languages between fights, understanding every language", () => {
    const spell = SpellSchema.parse(
      run.content("phb:spell/comprehend-languages"),
    );
    expect(spell.activation?.outOfCombat).toBe("scene");
    expect(spell.activation?.resolution).toMatchObject({
      effects: [{ modifier: { kind: "comprehension" } }],
    });
  });

  it("gives an Enchanter's pick of Deception, Intimidation or Persuasion its Intelligence bonus", () => {
    const enchanter = SubclassSchema.parse(
      run.content("arcana-unleashed:subclass/wizard-enchanter"),
    );
    const picks = enchanter.levels.find((item) => item.level === 3)?.choices;
    expect(
      picks?.some((choice) => choice.kind === "skills" && choice.bonus),
    ).toBe(true);
  });

  it("casts Detect Magic between fights to help find what's hidden, and gives a Paladin Divine Sense", () => {
    const detect = SpellSchema.parse(run.content("phb:spell/detect-magic"));
    expect(detect.activation?.outOfCombat).toBe("scene");
    expect(detect.activation?.resolution).toMatchObject({
      effects: [{ modifier: { kind: "sceneAid", about: ["hidden", "lore"] } }],
    });
    const paladin = deriveStats(
      levelTo(run, "phb:class/paladin", null, 3),
      run,
    );
    expect(
      paladin.actions.some((item) => item.name.includes("Divine Sense")),
    ).toBe(true);
    const spike = SpellSchema.parse(run.content("phb:spell/mind-spike"));
    expect(spike.activation?.resolution).toMatchObject({
      onFail: [{ modifier: { kind: "outlined" } }],
    });
  });
});
