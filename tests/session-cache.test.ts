import { describe, expect, it } from "vitest";
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
