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
  BackgroundSchema,
  SpeciesSchema,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { formsFor } from "../plugins/systems/dnd5.5e/core/forms.ts";
import { lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { hero } from "./feat-fixtures.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #182's older books' entries as the books encode them: what plays, and what links to its 2024 version.

const PLUGINS = [
  "phb",
  "dmg",
  "basic-rules-2014",
  "sword-coast-guide",
  "xanathars-guide",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

describe.skipIf(!BOOKS)("the books' older entries (#182)", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "older-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("plays the 2014 species with no 2024 version, as Humanoids", () => {
    for (const id of [
      "basic-rules-2014:species/half-elf",
      "basic-rules-2014:species/half-orc",
      "sword-coast-guide:species/duergar",
      "sword-coast-guide:species/deep-gnome",
    ]) {
      const species = lookup(run, SpeciesSchema, id);
      expect(species.creatureType).toBe("Humanoid");
      expect(species.traits.length).toBeGreaterThan(1);
    }
  });

  it("gives an older background any abilities and no feat of its own", () => {
    const watch = lookup(
      run,
      BackgroundSchema,
      "sword-coast-guide:background/city-watch",
    );
    expect(watch.abilities).toHaveLength(6);
    expect(watch.feat).toBeUndefined();
  });

  it("puts Xanathar's spells on the 2024 class lists, and marks its reprinted ones", () => {
    const absorb = lookup(
      run,
      SpellSchema,
      "xanathars-guide:spell/absorb-elements",
    );
    expect(absorb.classes).toContain("phb:class/wizard");
    const toll = run.content(
      "xanathars-guide:spell/toll-the-dead",
    ) as unknown as {
      readonly reprint?: string;
      readonly classes: readonly string[];
    };
    expect(toll.reprint).toBe("phb:spell/toll-the-dead");
    expect(toll.classes).toEqual([]);
  });

  it("drives the Apparatus of Kwalish as its own stat block", () => {
    const forms = formsFor(
      { forms: { ids: ["dmg:monster/apparatus-of-kwalish"] } },
      hero([]),
      run,
    );
    expect(forms.map((item) => item.hp)).toEqual([200]);
  });
});
