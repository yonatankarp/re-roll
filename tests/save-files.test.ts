import { describe, expect, it, vi } from "vitest";
import { systems } from "../app/systems.ts";
import {
  type SaveStore,
  moveSavesToFiles,
  storeFiles,
  withSaveFiles,
} from "../engine/platform/browser/storage.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import {
  createTauriSaves,
  gunzip,
  gzip,
} from "../engine/platform/tauri/saves.ts";
import { createGame } from "../engine/shell/session.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

function memoryStore(): SaveStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

// Stands in for the commands in src-tauri/src/main.rs, with the same name check.
function fakeCommands() {
  const files = new Map<string, Uint8Array>();
  const bare = (name: string) => {
    if (!/^[A-Za-z0-9_.%-]+$/.test(name) || name.startsWith(".")) {
      throw new Error(`${name} isn't a save file name`);
    }
    return name;
  };
  const call = (
    command: string,
    args?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<unknown> => {
    const named = args as { name: string };
    switch (command) {
      case "save_read":
        return Promise.resolve(
          (files.get(bare(named.name)) ?? new Uint8Array()).slice().buffer,
        );
      case "save_write":
        files.set(bare(options?.headers?.name ?? ""), args as Uint8Array);
        return Promise.resolve(null);
      case "save_list":
        return Promise.resolve([...files.keys()]);
      case "save_remove":
        files.delete(bare(named.name));
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(`No command ${command}`));
    }
  };
  return { files, call: call as Parameters<typeof createTauriSaves>[0] };
}

describe("desktop save files", () => {
  it("round-trip through gzip, and read plain text too", async () => {
    const text = JSON.stringify({ log: Array(200).fill("framePushed") });
    const packed = await gzip(text);
    expect(packed.length).toBeLessThan(text.length / 10);
    expect(await gunzip(packed)).toBe(text);
    expect(await gunzip(new TextEncoder().encode(text))).toBe(text);
  });

  it("keep any save path as one bare file name", async () => {
    const { files, call } = fakeCommands();
    const saves = createTauriSaves(call);
    const path = "saves/../goblin-ambush-2026-11-12T10:00 ü*.json";
    await saves.write(path, "hello");
    expect([...files.keys()]).toHaveLength(1);
    expect(await saves.list()).toEqual([path]);
    expect(await saves.read(path)).toBe("hello");
    expect(await saves.read("saves/missing.json")).toBeNull();
    await saves.remove(path);
    expect(await saves.list()).toEqual([]);
  });

  it("take the saves kept in localStorage once, never over a file, keeping the originals", async () => {
    const store = memoryStore();
    store.setItem("saves/a.json", "old a");
    store.setItem("saves/b.json", "old b");
    store.setItem("saves/times", "{}");
    store.setItem("other", "not a save");
    const { call } = fakeCommands();
    const files = createTauriSaves(call);
    await files.write("saves/b.json", "newer b");

    expect(await moveSavesToFiles(store, files)).toBe(2);
    expect(await files.read("saves/a.json")).toBe("old a");
    expect(await files.read("saves/b.json")).toBe("newer b");
    expect(await files.read("saves/times")).toBe("{}");
    expect([...(await files.list())].sort()).toEqual([
      "saves/a.json",
      "saves/b.json",
      "saves/times",
    ]);
    expect(store.getItem("saves/a.json")).toBe("old a");

    await files.remove("saves/a.json");
    expect(await moveSavesToFiles(store, files)).toBe(0);
    expect(await files.read("saves/a.json")).toBeNull();
  });
});

describe("autosaves", () => {
  it("keep only the newest five runs, and every manual save", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let clock = Date.parse("2026-11-12T10:00:00Z");
      const store = memoryStore();
      const game = createGame({
        storage: withSaveFiles(
          await createNodeStorage(process.cwd()),
          storeFiles(store),
        ),
        roots: ["plugins"],
        systems,
        uis: [dndUi],
      });
      for (const seed of ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]) {
        clock += 1000;
        vi.setSystemTime(clock);
        await game.start("goblin-ambush", seed);
        if (seed === "r1") await game.save("kept");
      }
      const paths = (await game.listSaves()).map((save) => save.path).sort();
      expect(paths).toEqual([
        "saves/goblin-ambush-kept.json",
        "saves/goblin-ambush-r3-autosave.json",
        "saves/goblin-ambush-r4-autosave.json",
        "saves/goblin-ambush-r5-autosave.json",
        "saves/goblin-ambush-r6-autosave.json",
        "saves/goblin-ambush-r7-autosave.json",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("write the save and one record per answer, and the menu brings the card up to date", async () => {
    const store = memoryStore();
    const game = createGame({
      storage: withSaveFiles(
        await createNodeStorage(process.cwd()),
        storeFiles(store),
      ),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });
    await game.start("goblin-ambush", "once");
    const path = "saves/goblin-ambush-once-autosave.json";
    const card = () =>
      (
        JSON.parse(store.getItem("saves/details") ?? "{}") as Record<
          string,
          { steps: number; character: string | null; savedAt: string }
        >
      )[path];
    expect(card()?.character).toBeNull(); // no hero chosen yet

    const writes = vi.spyOn(store, "setItem");
    const reads = vi.spyOn(store, "getItem");
    const option = game.view().decision?.options[0]?.id;
    if (!option) throw new Error("Nothing to choose");
    await game.answer(option);
    expect(writes.mock.calls.map(([key]) => key)).toEqual([
      path,
      "saves/details",
    ]);
    expect(reads).not.toHaveBeenCalled();
    expect(card()?.steps).toBe(2);
    expect(card()?.character).toBeNull(); // kept from before, until the menu

    const listed = (await game.listSaves()).find((save) => save.current);
    expect(listed?.character).toBeTruthy();
    expect(card()?.character).toBe(listed?.character);
    expect(store.getItem("saves/times")).toBeNull();
  });
});
