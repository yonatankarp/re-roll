import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import type { CharacterBuild } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import type { Actor } from "../plugins/systems/dnd5.5e/core/state.ts";
import {
  deriveStats,
  type Stats,
} from "../plugins/systems/dnd5.5e/core/stats.ts";
import { swappable } from "../plugins/systems/dnd5.5e/core/swap.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

const EB = "eberron-forge-of-the-artificer";
const PLUGINS = ["phb", EB, "heroes-of-faerun", "xanathars-guide"];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

type Answers = CharacterBuild["levels"][number]["answers"];

// A fighter of the level with these answers at level 1 and at its last level, as a sample of #167's entries plays.
function fighter(
  run: RunContext,
  level: number,
  first: Answers,
  last: Answers = [],
  speciesId?: string,
): Actor {
  const built = levelTo(run, "phb:class/fighter", null, level);
  if (built.source.kind !== "character" || !built.source.build) {
    throw new Error("No build");
  }
  const { build } = built.source;
  const levels = build.levels.map((entry, index) => ({
    ...entry,
    answers: [
      ...entry.answers,
      ...(index === 0 ? first : []),
      ...(index === level - 1 && index > 0 ? last : []),
    ],
  }));
  return {
    ...built,
    source: {
      kind: "character",
      build: { ...build, levels, ...(speciesId ? { speciesId } : {}) },
    },
  };
}

const action = (stats: Stats, id: string) =>
  stats.actions.find((item) => item.id === id);

describe.skipIf(!BOOKS)("the books' spells from feats and species", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "feat-spells-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("casts Genie Magic's spell free as with a level 2 slot from level 11, without knowing it", () => {
    const genie = (level: number) =>
      deriveStats(
        fighter(
          run,
          level,
          [],
          [
            { kind: "feats", values: ["heroes-of-faerun:feat/genie-magic"] },
            { kind: "abilities", increases: { cha: 1 } },
          ],
        ),
        run,
      );
    const missile = "spell:phb:spell/magic-missile";
    expect(action(genie(4), `${missile}:free`)?.spellLevel).toBe(1);
    expect(action(genie(11), `${missile}:free`)?.spellLevel).toBe(2);
    expect(
      action(genie(11), `${missile}:free`)?.activation.cost,
    ).toContainEqual({ resource: "genie-magic" });
    expect(action(genie(11), missile)).toBeUndefined();
  });

  it("gives Potent Dragonmark's extra slot to the mark's spells at half the level", () => {
    const marked = (feats: readonly string[]) =>
      deriveStats(
        fighter(
          run,
          5,
          [{ kind: "feats", values: [`${EB}:feat/mark-of-making`] }],
          [
            { kind: "feats", values: [...feats] },
            { kind: "abilities", increases: { int: 1 } },
          ],
        ),
        run,
      );
    const extra = "spell:phb:spell/magic-weapon:free:potent-dragonmark";
    const potent = marked([`${EB}:feat/potent-dragonmark`]);
    expect(action(potent, extra)?.spellLevel).toBe(3);
    expect(potent.resources["potent-dragonmark"]).toBe(1);
    expect(action(potent, "spell:phb:spell/magic-weapon:free")).toBeDefined();
    expect(action(marked([]), extra)).toBeUndefined();
  });

  it("offers a High Elf's cantrip swap, and Forest Gnome casts Speak with Animals Proficiency Bonus times", () => {
    const elf = fighter(
      run,
      1,
      [{ kind: "features", values: ["phb:feature/elf-high-elf-lineage"] }],
      [],
      "phb:species/elf",
    );
    expect(
      swappable(elf, run).find(
        (item) => item.key === "trait:phb:feature/elf-high-elf-lineage",
      )?.open,
    ).toBe(true);
    const gnome = deriveStats(
      fighter(
        run,
        5,
        [
          {
            kind: "features",
            values: ["phb:feature/gnome-forest-gnome-lineage"],
          },
        ],
        [],
        "phb:species/gnome",
      ),
      run,
    );
    expect(gnome.resources["forest-gnome"]).toBe(3);
  });

  it("casts Drow High Magic's Dispel Magic once a Long Rest, and asks Ritual Caster's spells between scenes", () => {
    const drow = deriveStats(
      fighter(
        run,
        4,
        [{ kind: "features", values: ["phb:feature/elf-drow-lineage"] }],
        [
          { kind: "feats", values: ["xanathars-guide:feat/drow-high-magic"] },
          { kind: "abilities", increases: { cha: 1 } },
        ],
        "phb:species/elf",
      ),
      run,
    );
    expect(
      action(drow, "spell:phb:spell/dispel-magic:free")?.activation.cost,
    ).toContainEqual({ resource: "free:phb:spell/dispel-magic" });
    const ritualist = fighter(
      run,
      4,
      [],
      [
        { kind: "feats", values: ["phb:feat/ritual-caster"] },
        { kind: "abilities", increases: { int: 1 } },
      ],
    );
    expect(
      swappable(ritualist, run).find(
        (item) => item.key === "pick:phb:feat/ritual-caster#rituals",
      )?.open,
    ).toBe(true);
  });
});
