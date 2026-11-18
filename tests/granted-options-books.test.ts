import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYER_ACTOR } from "#sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createRunContext, type RunContext } from "../engine/run/turn.ts";
import { type DndState, NS } from "../plugins/systems/dnd5.5e/core/state.ts";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { levelTo } from "./class-features.ts";
import { BOOK_ROOTS } from "./depth.ts";
import { scripted, settle } from "./feat-fixtures.ts";

const PLUGINS = [
  "phb",
  "dmg",
  "monster-manual",
  "ravenloft-horrors-within",
  "project-lamordia",
  "red-wizards-gambit-rules",
  "heroes-of-faerun",
  "xanathars-guide",
];
const BOOKS =
  BOOK_ROOTS && PLUGINS.every((id) => existsSync(`books/rules/${id}`));

describe.skipIf(!BOOKS)("the books' granted character options", () => {
  let run: RunContext;
  beforeAll(async () => {
    const storage = await createPlayStorage(
      process.cwd(),
      await mkdtemp(join(tmpdir(), "granted-options-books-")),
    );
    const catalog = await scanPlugins(storage, ["plugins", "books"]);
    const loaded = await loadRun(storage, catalog, systems, [
      "goblin-ambush",
      ...PLUGINS,
    ]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    run = createRunContext(loaded.registry, "goblin-ambush");
  });

  // A level 3 Fighter granted this option, answering its picks with `answer`.
  function granted(option: string, answer?: (ids: string[]) => string) {
    const fighter = levelTo(run, "phb:class/fighter", null, 3);
    const state: DndState = {
      actors: { [PLAYER_ACTOR]: fighter },
      combat: null,
    };
    const effect = run.system.storyEffects[`${NS}:grantOption`];
    if (!effect) throw new Error("No grantOption");
    const { dice } = scripted([]);
    const context = {
      state,
      dice,
      content: run.content,
      contentIds: run.contentIds,
    };
    const { state: after, decisions } = settle(
      run,
      state,
      effect.apply(effect.schema.parse({ option }), context).frames ?? [],
      dice,
      answer
        ? (decision) => answer(decision.options.map((item) => item.id))
        : undefined,
    );
    const actor = after.actors[PLAYER_ACTOR];
    if (!actor) throw new Error("No player");
    return { before: fighter, actor, decisions };
  }

  it("plays a Blessing of Health and a Blessing of Protection", () => {
    const health = granted("dmg:supernatural-gift/blessing-of-health");
    expect(deriveStats(health.actor, run).abilities.con).toBe(
      Math.min(22, deriveStats(health.before, run).abilities.con + 2),
    );
    const protection = granted("dmg:supernatural-gift/blessing-of-protection");
    expect(deriveStats(protection.actor, run).ac).toBe(
      deriveStats(protection.before, run).ac + 1,
    );
  });

  it("asks the Charm of the Slayer's weapon and a survivor talent's spell as they're granted", () => {
    const slayer = granted("dmg:supernatural-gift/charm-of-the-slayer");
    expect(slayer.decisions[0]?.options.map((item) => item.id)).toEqual([
      "dragon-slayer",
      "giant-slayer",
    ]);
    const miracle = granted(
      "project-lamordia:survivor-talent/scientific-miracle",
      (ids) => ids.find((id) => id.endsWith("/bless")) ?? ids[0] ?? "",
    );
    const free = deriveStats(miracle.actor, run).actions.some((action) =>
      action.id.startsWith("spell:srd52:spell/bless:free"),
    );
    expect(free).toBe(true);
  });

  it("lets a Darklord's Mark cast its spell once a Long Rest", () => {
    const mark = granted(
      "ravenloft-horrors-within:supernatural-gift/mark-of-the-dread-lord",
    );
    expect(
      deriveStats(mark.actor, run).actions.some((action) =>
        action.id.startsWith("spell:phb:spell/fear:free"),
      ),
    ).toBe(true);
  });
});
