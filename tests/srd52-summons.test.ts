import { describe, expect, it } from "vitest";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { loadRun, scanPlugins } from "../engine/run/loader.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";

// Every creature an SRD spell makes or calls is in the SRD too, so srd52 plays without the books (#126).
describe("srd52's summons", () => {
  it("name only srd52 entries that load", async () => {
    const storage = await createNodeStorage(process.cwd());
    const loaded = await loadRun(
      storage,
      await scanPlugins(storage, ["plugins"]),
      [dnd55e],
      ["goblin-ambush"],
    );
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const { registry } = loaded;
    // Every content id an SRD entry names, such as a summon's monster or companion, a familiar's form or a class.
    const named: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        if (/^[a-z0-9-]+:[a-z-]+\/[a-z0-9-]+$/.test(value)) named.push(value);
      } else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object")
        Object.values(value).forEach(walk);
    };
    for (const id of registry.contentIds())
      if (id.startsWith("srd52:")) walk(registry.content(id));
    expect(named).toContain("srd52:monster/zombie");
    expect(named).toContain("srd52:companion/draconic-spirit");
    const unresolved = [...new Set(named)].filter(
      (id) => !id.startsWith("srd52:") || registry.content(id) === undefined,
    );
    expect(unresolved).toEqual([]);
  });
});
