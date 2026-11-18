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
  companionActors,
  companionFoundEvents,
} from "../plugins/systems/dnd5.5e/core/combat/companions.ts";
import { SpellSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import {
  type Actor,
  applyDndEvent,
} from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

const PLUGINS = [
  "phb",
  "dmg",
  "monster-manual",
  "eberron-forge-of-the-artificer",
  "ravenloft-horrors-within",
  "arcana-unleashed",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

// A sample of #145's entries as the books encode them.
describe.skipIf(!BOOKS)("the books' lasting companions", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "companions-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  // The companion an owner finds before its first fight, as it joins the fight.
  const companion = (owner: Actor): Actor | undefined => {
    const found = companionFoundEvents([owner], run, "fight").reduce(
      applyDndEvent,
      { actors: { [owner.id]: owner }, combat: null },
    );
    return companionActors([found.actors[owner.id] ?? owner], run)[0];
  };

  it("gives a Battle Smith a Steel Defender, a Beast Master a Primal Companion, a Reanimator and a Vestige Patron theirs", () => {
    const cases: [string, string, number][] = [
      [
        "eberron-forge-of-the-artificer:class/artificer",
        "eberron-forge-of-the-artificer:subclass/artificer-battle-smith",
        3,
      ],
      ["phb:class/ranger", "phb:subclass/ranger-beast-master", 3],
      [
        "eberron-forge-of-the-artificer:class/artificer",
        "ravenloft-horrors-within:subclass/artificer-reanimator",
        3,
      ],
      [
        "phb:class/warlock",
        "arcana-unleashed:subclass/warlock-vestige-patron",
        3,
      ],
    ];
    for (const [cls, sub, level] of cases) {
      const owner = levelTo(run, cls, sub, level);
      const pet = companion(owner);
      expect(pet, sub).toBeDefined();
      if (!pet) continue;
      const stats = deriveStats(pet, run);
      expect(stats.maxHp, sub).toBeGreaterThan(0);
      expect(stats.actions.length, sub).toBeGreaterThan(0);
    }
  });

  it("plays the PHB's Find Steed as the SRD's lasting summon", () => {
    const steed = JSON.stringify(
      lookup(run, SpellSchema, "phb:spell/find-steed").activation,
    );
    expect(steed).toContain('"lasting":true');
    expect(steed).toContain("otherworldly-steed");
  });

  it("leaves an Assassin with Infiltration Expertise one Steady Aim", () => {
    const rogue = levelTo(
      run,
      "phb:class/rogue",
      "phb:subclass/rogue-assassin",
      9,
    );
    const aims = deriveStats(rogue, run).actions.filter(({ name }) =>
      name.includes("Steady Aim"),
    );
    expect(aims.map(({ id }) => id)).toHaveLength(1);
  });
});
