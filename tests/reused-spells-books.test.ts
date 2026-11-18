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

const PLUGINS = [
  "phb",
  "dmg",
  "xanathars-guide",
  "heroes-of-faerun",
  "arcana-unleashed",
  "lorwyn-first-light",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

const SPELLS = [
  "phb:spell/aura-of-vitality",
  "phb:spell/bigby-s-hand",
  "phb:spell/cloud-of-daggers",
  "phb:spell/grasping-vine",
  "phb:spell/hunter-s-mark",
  "phb:spell/witch-bolt",
  "arcana-unleashed:spell/spirit-lantern",
  "arcana-unleashed:spell/waves-of-exhaustion",
  "heroes-of-faerun:spell/blade-of-disaster",
  "heroes-of-faerun:spell/holy-star-of-mystra",
  "xanathars-guide:spell/crown-of-stars",
  "xanathars-guide:spell/watery-sphere",
  "xanathars-guide:spell/whirlwind",
  "xanathars-guide:spell/wrath-of-nature",
];

// A sample of #154's entries as the books encode them.
describe.skipIf(!BOOKS)(
  "the books' spells moved or reused on later turns",
  () => {
    let run: RunContext;
    beforeAll(async () => {
      const storage = await createPlayStorage(
        process.cwd(),
        await mkdtemp(join(tmpdir(), "reused-books-")),
      );
      const catalog = await scanPlugins(storage, ["plugins", "books"]);
      const loaded = await loadRun(storage, catalog, systems, [
        "goblin-ambush",
        ...PLUGINS,
      ]);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      run = createRunContext(loaded.registry, "goblin-ambush");
    });

    it("plays their later turns", () => {
      for (const id of SPELLS) {
        expect(lookup(run, SpellSchema, id).automation, id).toBe("full");
      }
      expect(
        lookup(run, SpellSchema, "phb:spell/grasping-vine").lasting?.anchor,
      ).toEqual({
        moves: 0,
        reach: 30,
      });
      expect(
        lookup(run, SpellSchema, "arcana-unleashed:spell/spirit-lantern")
          .spheres?.gathered,
      ).toBe(true);
    });

    it("gives the ranger's Hunter's Mark its d10 and the Great Old One's Hex its saves", () => {
      expect(
        lookup(run, FeatureSchema, "phb:feature/ranger-foe-slayer").redice,
      ).toMatchObject({ "phb:spell/hunter-s-mark": "1d10" });
      expect(
        lookup(
          run,
          FeatureSchema,
          "phb:feature/warlock-great-old-one-patron-eldritch-hex",
        ).addsTo?.["phb:spell/hex"],
      ).toHaveLength(6);
      expect(
        JSON.stringify(
          lookup(run, ItemSchema, "dmg:item/ring-of-shooting-stars"),
        ),
      ).toContain("Lightning Sphere");
    });
  },
);
