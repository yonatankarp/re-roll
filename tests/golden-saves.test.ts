import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { loadRun, scanPlugins } from "../engine/kernel/loader.ts";
import { loadSave, migrate } from "../engine/kernel/save.ts";
import {
  createRunContext,
  pendingDecision,
  step,
} from "../engine/kernel/turn.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";

// Saves written by older code, from tests/golden-saves.ts. A save (.json) is frozen: if one stops
// loading, players' saves of that kind stop loading too, so fix the code or add a migration.
// A snapshot (.state.json) may be rewritten with `node tests/golden-saves.ts --snapshots` when the
// state changed shape on purpose, after reviewing its diff.
const GOLDENS = ["mid-creation", "after-loot", "mid-combat", "mid-rest"];
const FOLDER = "tests/fixtures/saves";

async function open(adventure: string) {
  const storage = await createNodeStorage(process.cwd());
  const catalog = await scanPlugins(storage, ["plugins"]);
  const loaded = await loadRun(storage, catalog, systems, [adventure]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return {
    registry: loaded.registry,
    run: createRunContext(loaded.registry, adventure),
  };
}

const read = (name: string) => readFile(`${FOLDER}/${name}`, "utf8");

describe("golden saves", () => {
  it.each(GOLDENS)(
    "%s loads, folds to its snapshot and plays on",
    async (name) => {
      const text = await read(`${name}.json`);
      const { adventure } = JSON.parse(text) as { adventure: string };
      const { registry, run } = await open(adventure);
      const loaded = loadSave(text, registry, run);
      if (!loaded.ok) throw new Error(loaded.error);
      // Warnings are left alone: every content edit changes a plugin's hash.
      expect(JSON.parse(JSON.stringify(loaded.state))).toStrictEqual(
        JSON.parse(await read(`${name}.state.json`)),
      );
      // The first input after a load is where a stale frame used to fail.
      const decision = pendingDecision(run, loaded.state);
      if (!decision) throw new Error("The save waits on nothing");
      const outcome = step(run, loaded.state, {
        kind: "answer",
        decisionId: decision.id,
        optionId: decision.options[0]?.id ?? "",
      });
      expect(outcome.ok || outcome.error).toBe(true);
    },
  );

  it("refuses at load a save whose waiting step the rules no longer know", async () => {
    const text = (await read("mid-rest.json")).replaceAll(
      '"kind":"dnd5.5e:shortRestAnswer"',
      '"kind":"dnd5.5e:renamedAnswer"',
    );
    const { registry, run } = await open("goblin-ambush");
    const loaded = loadSave(text, registry, run);
    expect(loaded.ok || loaded.error).toContain("dnd5.5e:renamedAnswer");
  });

  it("refuses at load a waiting step whose payload no longer fits", async () => {
    // As if a later build renamed the draft field of character creation.
    const text = (await read("mid-creation.json")).replaceAll(
      '"draft":',
      '"oldDraft":',
    );
    const { registry, run } = await open("goblin-ambush");
    const loaded = loadSave(text, registry, run);
    expect(loaded.ok || loaded.error).toContain("no longer fits");
  });
});

describe("save migrations", () => {
  const table = {
    1: (raw: Record<string, unknown>) => ({ ...raw, renamed: raw.old }),
    2: (raw: Record<string, unknown>) => ({ ...raw, added: true }),
  };

  it("run in order from the save's format to the current one", () => {
    expect(migrate({ formatVersion: 1, old: "x" }, table, 3)).toStrictEqual({
      ok: true,
      raw: { formatVersion: 3, old: "x", renamed: "x", added: true },
    });
  });

  it("refuse a format with no migration and one from a newer build", () => {
    expect(migrate({ formatVersion: 0 }, table, 3).ok).toBe(false);
    expect(migrate({ formatVersion: 4 }, table, 3).ok).toBe(false);
  });
});
