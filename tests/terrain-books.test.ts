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
  ItemSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";

const PLUGINS = ["phb", "dmg", "xanathars-guide", "heroes-of-faerun"];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

// A sample of #159's entries as the books encode them.
describe.skipIf(!BOOKS)("the books' terrain, walls and areas", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "terrain-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("plays its spells' areas", () => {
    const spell = (id: string) => lookup(run, SpellSchema, id);
    const text = (id: string) => JSON.stringify(spell(id).activation);
    expect(spell("phb:spell/web").automation).toBe("full");
    expect(text("phb:spell/web")).toContain('"burns"');
    expect(spell("phb:spell/hunger-of-hadar").activation?.areas).toHaveLength(
      2,
    );
    expect(text("xanathars-guide:spell/wall-of-sand")).toContain(
      '"shape":"line"',
    );
    expect(text("xanathars-guide:spell/control-winds")).toContain(
      '"softFalls":true',
    );
    expect(text("heroes-of-faerun:spell/spellfire-storm")).toContain(
      '"foilsSpells"',
    );
    expect(spell("xanathars-guide:spell/wall-of-light").spheres?.count).toBe(6);
  });

  it("plays Wrath of the Sea, its Stormborn flight and Winter Strider", () => {
    const feature = (id: string) => lookup(run, FeatureSchema, id);
    const wrath = feature(
      "phb:feature/druid-circle-of-the-sea-wrath-of-the-sea",
    );
    expect(wrath.activations.map(({ label }) => label)).toContain(
      "Ocean Spray",
    );
    expect(
      feature("phb:feature/druid-circle-of-the-sea-stormborn").passives,
    ).toContainEqual(
      expect.objectContaining({
        modifier: { kind: "movementMode", mode: "fly" },
      }) as unknown,
    );
    const boots = lookup(run, ItemSchema, "dmg:item/boots-of-the-winterlands");
    expect(JSON.stringify(boots)).toContain('"ice":true');
  });
});
