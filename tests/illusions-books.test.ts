import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import {
  FeatureSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

const PLUGINS = ["phb", "dmg"];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

// A sample of #147's entries as the books encode them.
describe.skipIf(!BOOKS)("the books' illusions and disguises", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "illusions-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("plays the PHB's Silent Image, Disguise Self and Magic Jar as the SRD's", () => {
    const text = (id: string) =>
      JSON.stringify(lookup(run, SpellSchema, id).activation);
    expect(text("phb:spell/silent-image")).toContain('"zone":"image"');
    expect(text("phb:spell/disguise-self")).toContain('"kind":"disguise"');
    expect(text("phb:spell/magic-jar")).toContain('"kind":"controlled"');
  });

  it("gives a Trickery cleric an image to distract with, and an Actor Impersonation", () => {
    const cleric = levelTo(
      run,
      "phb:class/cleric",
      "phb:subclass/cleric-trickery-domain",
      3,
    );
    const stats = deriveStats(cleric, run);
    expect(
      stats.actions.some(({ name }) => name.includes("Invoke Duplicity")),
    ).toBe(true);
    expect(stats.passives).toContainEqual({ kind: "distract" });
    expect(
      lookup(run, FeatureSchema, "phb:feature/feat-actor").passives,
    ).toContainEqual({ kind: "impersonation" });
  });
});
