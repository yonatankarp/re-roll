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
  formsFor,
  type Polymorph,
} from "../plugins/systems/dnd5.5e/core/forms.ts";
import { SpellSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { deriveStats, lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";

const PLUGINS = ["phb", "dmg", "monster-manual"];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

// A sample of #146's entries as the books encode them.
describe.skipIf(!BOOKS)("the books' shape-changing", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "shape-changing-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  const polymorphOf = (
    actions: ReturnType<typeof deriveStats>["actions"],
    name: string,
  ): Polymorph => {
    const action = actions.find((item) => item.name.endsWith(`(${name})`));
    const { resolution } = action?.activation ?? {};
    const effect =
      resolution?.kind === "automatic"
        ? resolution.effects.find((item) => item.kind === "polymorph")
        : undefined;
    if (effect?.kind !== "polymorph") throw new Error(`no ${name} form`);
    return effect;
  };

  it("gives a level 4 druid Beasts up to CR 1/2 without a Fly Speed, and a Moon druid stronger ones", () => {
    const druid = levelTo(run, "phb:class/druid", null, 4);
    const wild = polymorphOf(deriveStats(druid, run).actions, "Wild Shape");
    const forms = formsFor(wild, druid, run);
    expect(forms.length).toBeGreaterThan(0);
    expect(
      forms.every(({ cr, type, fly }) => cr <= 0.5 && type === "beast" && !fly),
    ).toBe(true);
    const moon = levelTo(
      run,
      "phb:class/druid",
      "phb:subclass/druid-circle-of-the-moon",
      6,
    );
    const lunar = polymorphOf(deriveStats(moon, run).actions, "Wild Shape");
    expect(lunar.acFloor).toBeDefined();
    expect(Math.max(...formsFor(lunar, moon, run).map(({ cr }) => cr))).toBe(2);
  });

  it("offers a Stars druid its three constellations, and plays the PHB's Polymorph as the SRD's", () => {
    const stars = levelTo(
      run,
      "phb:class/druid",
      "phb:subclass/druid-circle-of-the-stars",
      3,
    );
    const names = deriveStats(stars, run).actions.map(({ name }) => name);
    for (const constellation of ["Archer", "Chalice", "Dragon"]) {
      expect(names.some((name) => name.includes(constellation))).toBe(true);
    }
    const polymorph = lookup(run, SpellSchema, "phb:spell/polymorph");
    expect(polymorph.automation).toBe("full");
    expect(JSON.stringify(polymorph.activation)).toContain('"willing":true');
  });
});
