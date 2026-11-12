import { describe, expect, it, vi } from "vitest";
import { systems } from "../app/systems.ts";
import {
  type SaveStore,
  withSaves,
} from "../engine/platform/browser/storage.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { createGame } from "../engine/shell/session.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

function memorySaves(): SaveStore {
  const items = new Map<string, string>();
  return {
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

describe("the session's loaded content", () => {
  it("is reused until a plugin's files change", async () => {
    const content = await createNodeStorage(process.cwd());
    let contentReads = 0;
    let extraFile = false;
    const game = createGame({
      storage: withSaves(
        {
          read: (path) => {
            // Manifests are read by every scan; the content behind them only by a load.
            if (path.startsWith("plugins/") && !path.endsWith("/plugin.yaml"))
              contentReads += 1;
            return content.read(path);
          },
          list: async (prefix) => [
            ...(await content.list(prefix)),
            ...(extraFile && prefix === "plugins/adventures"
              ? [
                  {
                    path: "plugins/adventures/goblin-ambush/notes.md",
                    symlink: false,
                  },
                ]
              : []),
          ],
        },
        memorySaves(),
      ),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });

    await game.start("goblin-ambush", "cache-1");
    expect(contentReads).toBeGreaterThan(0);

    contentReads = 0;
    await game.restart("cache-2");
    expect(contentReads).toBe(0);

    extraFile = true;
    await game.restart("cache-3");
    expect(contentReads).toBeGreaterThan(0);
    expect(game.view().steps).toBe(1);
  });
});

describe("the menu", () => {
  it("still lists everything when an adventure.yaml is malformed", async () => {
    const content = await createNodeStorage(process.cwd());
    const broken = "plugins/adventures/haunted-house/adventure.yaml";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const game = createGame({
      storage: withSaves(
        {
          read: (path) =>
            path === broken
              ? Promise.resolve("title: [unclosed")
              : content.read(path),
          list: (prefix) => content.list(prefix),
        },
        memorySaves(),
      ),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });
    await game.start("goblin-ambush", "menu-1");
    const adventures = await game.listAdventures();
    expect(adventures.find((item) => item.id === "haunted-house")?.title).toBe(
      "haunted-house",
    );
    expect((await game.listSaves(adventures)).length).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lists saves from their details without reading each save", async () => {
    const content = await createNodeStorage(process.cwd());
    const saves = memorySaves();
    const game = createGame({
      storage: withSaves(content, saves),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });
    await game.start("goblin-ambush", "menu-2");
    const path = await game.save("mine");
    const read = vi.spyOn(saves, "getItem");
    const listed = await game.listSaves();
    expect(listed.find((save) => save.path === path)?.steps).toBe(1);
    expect(read).toHaveBeenCalled(); // the times and details records
    expect(read.mock.calls.map(([key]) => key)).not.toContain(path);
  });
});
