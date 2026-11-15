import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import type { ContentAccess } from "../engine/kernel/system.ts";
import { createPlayStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { createRunContext } from "../engine/run/turn.ts";
import { choiceOptions } from "../plugins/systems/dnd5.5e/core/character.ts";
import { ClassSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { lookup } from "../plugins/systems/dnd5.5e/core/stats.ts";
import { BOOK_ROOTS } from "./depth.ts";
import { hero, testRun } from "./feat-fixtures.ts";

// The feats offered at a choice of the category: to the fixtures' fighter, or with books, to a new fighter.
function offered(access: ContentAccess, category: string): string[] {
  const actor = access.content("test:feat/marked")
    ? hero([], { level: 3 })
    : null;
  const build = actor?.source.kind === "character" ? actor.source.build : null;
  return choiceOptions(
    { kind: "feat", id: "feat", category } as never,
    { picks: {}, scores: [], backgroundId: "srd52:background/acolyte" },
    build,
    lookup(
      access,
      ClassSchema,
      build?.levels[0]?.classId ?? "phb:class/fighter",
    ),
    access,
  ).options.map(({ id }) => id);
}

describe("campaign prerequisites", () => {
  it("offers a feat that needs a campaign only in an adventure set there", async () => {
    const run = await testRun();
    expect(offered(run, "general")).not.toContain("test:feat/marked");
    expect(offered(run, "general")).not.toContain("test:feat/gifted");
    const ravenloft = offered({ ...run, setting: "ravenloft" }, "general");
    expect(ravenloft).toContain("test:feat/gifted");
    expect(ravenloft).not.toContain("test:feat/marked");
    expect(offered({ ...run, setting: "eberron" }, "general")).toContain(
      "test:feat/marked",
    );
  });

  it.skipIf(!BOOK_ROOTS || !existsSync("books/adventures/ravenloft-barovia"))(
    "offers Dark Gifts in Blood and Mist in Barovia and no dragonmark, and Dark Gifts nowhere else",
    async () => {
      const storage = await createPlayStorage(
        process.cwd(),
        await mkdtemp(join(tmpdir(), "campaign-")),
      );
      const catalog = await scanPlugins(storage, ["plugins", "books"]);
      const loaded = await loadRun(storage, catalog, systems, [
        "ravenloft-barovia",
      ]);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      const run = createRunContext(loaded.registry, "ravenloft-barovia");
      expect(run.setting).toBe("ravenloft");
      const eberron = "eberron-forge-of-the-artificer:feat/";
      const general = offered(run, "general");
      expect(general.some((id) => id.startsWith(eberron))).toBe(false);
      const gift = "ravenloft-horrors-within:feat/mist-walker";
      expect(offered(run, "darkGift")).toContain(gift);
      expect(offered({ ...run, setting: undefined }, "darkGift")).not.toContain(
        gift,
      );
      // Without the campaign check, Barovia offers the dragonmarks its rules book brings along.
      expect(
        offered({ ...run, setting: "eberron" }, "general").some((id) =>
          id.startsWith(eberron),
        ),
      ).toBe(true);
    },
  );
});
