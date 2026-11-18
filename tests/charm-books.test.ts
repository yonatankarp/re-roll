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
  type LeafEffect,
  SpellSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

// A sample of #148's entries as the books encode them.

const PLUGINS = ["phb", "xanathars-guide", "arcana-unleashed"];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

const onFail = (spell: unknown): readonly LeafEffect[] => {
  const { resolution } = SpellSchema.parse(spell).activation ?? {};
  return resolution?.kind === "save" ? resolution.onFail : [];
};
const options = (effects: readonly LeafEffect[]): string[] => [
  ...new Set(
    effects.flatMap((effect) =>
      "option" in effect && effect.option ? [effect.option] : [],
    ),
  ),
];

describe.skipIf(!BOOKS)("the books' charm and control entries", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "charm-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  it("gives Command its five commands and Calm Emotions its two choices", () => {
    expect(options(onFail(run.content("phb:spell/command")))).toEqual([
      "Halt",
      "Grovel",
      "Approach",
      "Flee",
      "Drop",
    ]);
    expect(options(onFail(run.content("phb:spell/calm-emotions")))).toEqual([
      "Indifferent",
      "Calm",
    ]);
  });

  it("puts a Dominate Person target under control, saving again when hurt", () => {
    const effects = onFail(run.content("phb:spell/dominate-person"));
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "applyCondition", saveOnDamage: true }),
    );
    expect(effects).toContainEqual(
      expect.objectContaining({ modifier: { kind: "controlled" } }),
    );
  });

  it("lets a College of Glamour Bard cast Command from Mantle of Majesty, failed by those it charmed", () => {
    const bard = deriveStats(
      levelTo(run, "phb:class/bard", "phb:subclass/bard-college-of-glamour", 6),
      run,
    );
    const mantle = bard.actions.filter((item) =>
      item.id.includes("mantle-of-majesty"),
    );
    expect(mantle.length).toBeGreaterThanOrEqual(2);
    const gated = mantle.find((item) => item.activation.while);
    const { resolution } = gated?.activation ?? {};
    expect(resolution?.kind === "save" && resolution.edges).toEqual([
      { charmedByCaster: true, roll: "fail" },
    ]);
    expect(bard.actions.map((item) => item.id)).toContain(
      "spell:phb:spell/charm-person",
    );
  });
});
