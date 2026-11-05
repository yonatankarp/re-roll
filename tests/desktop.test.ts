import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import {
  CONTENT_ROUTE,
  contentEndpoint,
  parseContentPath,
} from "../engine/platform/node/content-endpoint.ts";
import {
  type SaveStore,
  createContentReader,
  withSaves,
} from "../engine/platform/browser/storage.ts";
import { createGame } from "../engine/shell/session.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

function serve(root: string): Promise<{ server: Server; url: string }> {
  const handle = contentEndpoint(root);
  const server = createServer((request, response) => {
    request.url = (request.url ?? "").slice(CONTENT_ROUTE.length);
    void handle(request, response);
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      done({ server, url: `http://127.0.0.1:${String(port)}` });
    });
  });
}

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

describe("parseContentPath", () => {
  it.each([
    ["plugins/rules/a.yaml", "plugins", "rules/a.yaml"],
    ["private/rules/a.yaml", "private", "rules/a.yaml"],
    ["plugins", "plugins", ""],
  ])("allows %s", (path, folder, rest) => {
    expect(parseContentPath(path)).toEqual({ folder, rest });
  });

  it.each([
    "",
    "/etc/passwd",
    "/plugins/a.yaml",
    "saves/a.json",
    "pluginsX/a.yaml",
    "plugins/../package.json",
    "plugins/rules/../../private/a",
    "plugins/./a.yaml",
    "plugins//a.yaml",
    "plugins/a/",
    "plugins\\..\\package.json",
    "..\\plugins",
    "plugins/a\0.yaml",
  ])("refuses %j", (path) => {
    expect(parseContentPath(path)).toBeNull();
  });
});

describe("the content endpoint", () => {
  let base: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "re-roll-"));
    await mkdir(join(base, "plugins/rules"), { recursive: true });
    await writeFile(join(base, "plugins/rules/a.yaml"), "good: true");
    await writeFile(join(base, "package.json"), "stolen");
    await symlink(join(base, "package.json"), join(base, "plugins/link.yaml"));
    ({ server, url } = await serve(base));
  });

  afterAll(async () => {
    server.close();
    await rm(base, { recursive: true, force: true });
  });

  const read = (path: string) =>
    fetch(`${url}${CONTENT_ROUTE}/read?path=${encodeURIComponent(path)}`);

  it("reads and lists files in the folders", async () => {
    const reader = createContentReader(url);
    expect(await reader.read("plugins/rules/a.yaml")).toBe("good: true");
    expect(await reader.read("plugins/rules/none.yaml")).toBeNull();
    expect(await reader.list("plugins/rules")).toEqual([
      { path: "plugins/rules/a.yaml", symlink: false },
    ]);
  });

  it("treats a missing private folder as empty", async () => {
    const reader = createContentReader(url);
    expect(await reader.read("private/a.yaml")).toBeNull();
    expect(await reader.list("private/rules")).toEqual([]);
  });

  it("refuses paths outside the folders, and says nothing about them", async () => {
    for (const path of ["package.json", "plugins/../package.json"]) {
      const response = await read(path);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("stolen");
    }
  });

  it("refuses a symlink that leaves the folder, even inside the repo", async () => {
    const response = await read("plugins/link.yaml");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("stolen");
  });

  it("is read-only", async () => {
    const response = await fetch(
      `${url}${CONTENT_ROUTE}/read?path=plugins/rules/a.yaml`,
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("refuses other host names, which blocks DNS rebinding", async () => {
    const status = await new Promise<number | undefined>((done) => {
      const { hostname, port } = new URL(url);
      request(
        {
          hostname,
          port,
          path: `${CONTENT_ROUTE}/read?path=plugins/rules/a.yaml`,
          headers: { Host: "evil.example" },
        },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      ).end();
    });
    expect(status).toBe(403);
  });
});

describe("playing through the shell's session", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await serve(process.cwd()));
  });

  afterAll(() => {
    server.close();
  });

  const newGame = () =>
    createGame({
      storage: withSaves(createContentReader(url), memorySaves()),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });

  async function chooseCharacter(
    game: ReturnType<typeof newGame>,
    name: string,
  ): Promise<void> {
    const option = game
      .view()
      .decision?.options.find((item) => item.label.includes(name));
    if (!option) throw new Error(`${name} isn't offered`);
    await game.answer(option.id);
  }

  async function firstOption(game: ReturnType<typeof newGame>): Promise<void> {
    const option = game.view().decision?.options[0];
    if (!option) throw new Error("Nothing to answer");
    await game.answer(option.id);
  }

  it("lists the adventures by title", async () => {
    const adventures = await newGame().listAdventures();
    expect(adventures.map((item) => item.id).sort()).toEqual([
      "goblin-ambush",
      "haunted-house",
    ]);
    expect(adventures.map((item) => item.title)).toContain(
      "The House on Mere Lane",
    );
  });

  it("plays a fight, saves mid-fight, loads and reaches an end", async () => {
    const game = newGame();
    await game.start("goblin-ambush", "desktop-test-1");
    expect(game.view().sheet).toBeNull();
    await chooseCharacter(game, "Fighter");

    const sheet = game.view().sheet;
    expect(sheet?.title).toContain("Fighter");
    expect(sheet?.sections.map((section) => section.title)).toContain(
      "Abilities",
    );
    const skills = sheet?.sections.find(
      (section) => section.title === "Skills",
    );
    expect(skills?.layout).toBe("marks");
    expect(skills?.rows).toHaveLength(18);
    expect(skills?.rows.some((row) => row.marked)).toBe(true);
    expect(
      sheet?.sections.filter((section) => section.pinned).map((s) => s.title),
    ).toEqual(expect.arrayContaining(["Combat", "Abilities"]));

    let savedPath: string | null = null;
    for (let count = 0; count < 500 && game.view().decision; count += 1) {
      const view = game.view();
      if (view.combat && savedPath === null) {
        expect(view.combat.combatants.length).toBeGreaterThan(1);
        expect(
          view.combat.combatants.filter((actor) => actor.active),
        ).toHaveLength(1);
        for (const actor of view.combat.combatants) {
          expect(actor.maxHp).toBeGreaterThan(0);
        }
        savedPath = await game.save("mid-fight");
        const before = game.view();
        await firstOption(game); // moves on, so the load has something to undo
        await game.load(savedPath);
        expect(game.view()).toEqual(before);
        expect((await game.listSaves()).map((save) => save.path)).toContain(
          savedPath,
        );
      }
      await firstOption(game);
    }

    expect(savedPath).not.toBeNull();
    const end = game.view();
    expect(end.decision).toBeNull();
    expect(end.ended).not.toBeNull();
    expect(end.log.some((line) => line.text.includes("Goblin"))).toBe(true);
    expect(end.log.some((line) => line.text.includes("goblin-"))).toBe(false);
  });

  it("tells a dead character from a fallen party and from a win", async () => {
    const endings = new Set<string>();
    for (
      let seed = 0;
      seed < 60 && !(endings.has("ending") && endings.has("died"));
      seed += 1
    ) {
      const game = newGame();
      await game.start("goblin-ambush", `endings-${String(seed)}`);
      await chooseCharacter(game, "Wizard");
      // Passing every turn when possible makes defeat common enough to test.
      for (let count = 0; count < 500; count += 1) {
        const options = game.view().decision?.options;
        const last = options?.at(-1);
        if (!last) break;
        await game.answer(seed % 2 === 0 ? last.id : (options?.[0]?.id ?? ""));
      }
      const view = game.view();
      // A win is named by its own scene, and shows that scene's text.
      if (view.ended === "ending") expect(view.endingName).toBeTruthy();
      endings.add(
        view.ended === "defeat"
          ? view.playerDied
            ? "died"
            : "party"
          : String(view.ended),
      );
    }
    expect(endings).toContain("ending");
    expect(endings).toContain("died");
  }, 120_000);

  it("keeps an earlier run's autosave when a new run starts", async () => {
    const game = newGame();
    await game.start("goblin-ambush", "run-one");
    await game.start("goblin-ambush", "run-two");
    const saves = await game.listSaves();
    expect(saves.map((save) => save.path).sort()).toEqual([
      "saves/goblin-ambush-run-one-autosave.json",
      "saves/goblin-ambush-run-two-autosave.json",
    ]);
    expect(saves[0]?.label).toContain("Autosave");
    expect(saves[0]?.label).not.toContain("goblin-ambush");

    const [first, second] = saves;
    if (!first || !second) throw new Error("Expected two saves");
    await game.deleteSave(first.path);
    expect((await game.listSaves()).map((save) => save.path)).toEqual([
      second.path,
    ]);
  });

  it("finds a monster's picture by name and ignores art that isn't an image", async () => {
    const content = createContentReader(url);
    const game = createGame({
      storage: withSaves(
        {
          read: (path) =>
            path === "private/assets/book/index.json"
              ? Promise.resolve(
                  JSON.stringify([
                    { file: "a.png", monster: "goblin-warrior" },
                    { file: "../b.png", monster: "Goblin Chief" },
                  ]),
                )
              : content.read(path),
          list: (prefix) =>
            prefix === "private/assets"
              ? Promise.resolve([
                  { path: "private/assets/book/index.json", symlink: false },
                ])
              : content.list(prefix),
        },
        memorySaves(),
      ),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });
    await game.start("goblin-ambush", "desktop-test-1");
    await chooseCharacter(game, "Wizard");
    for (let count = 0; count < 100 && !game.view().combat; count += 1) {
      const option = game.view().decision?.options[0];
      if (!option) break;
      await game.answer(option.id);
    }
    // Every Goblin Warrior gets the picture, and the path that climbs out of its folder is dropped.
    expect(new Set(Object.values(game.view().monsterArt))).toEqual(
      new Set(["private/assets/book/a.png"]),
    );
    await game.start("haunted-house", "desktop-test-1");
    // Its only art is a text file, which must never reach an <img>.
    expect(game.view().sceneArt).toBeNull();
  });

  it("serves only real image types from the image route", async () => {
    const status = async (path: string): Promise<number> =>
      (await fetch(`${url}/__content/image?path=${encodeURIComponent(path)}`))
        .status;
    expect(await status("plugins/adventures/haunted-house/plugin.yaml")).toBe(
      404,
    );
    expect(await status("plugins/missing.png")).toBe(404);
    expect(await status("plugins/../package.json")).toBe(403);
  });

  it("groups a character's combat options and explains them", async () => {
    const game = newGame();
    await game.start("goblin-ambush", "desktop-test-1");
    await chooseCharacter(game, "Wizard");
    for (let count = 0; count < 100; count += 1) {
      const groups = game.view().optionGroups;
      const spell = groups
        .flatMap((group) => group.options)
        .find((option) => option.label.includes("Magic Missile"));
      if (spell) {
        expect(groups.map((group) => group.title)).toContain("Level 1 spells");
        expect(spell.detail).toContain("damage");
        return;
      }
      const option = game.view().decision?.options[0];
      if (!option) break;
      await game.answer(option.id);
    }
    throw new Error("The wizard never got a turn");
  });

  it("names the caster of a spell that never rolls, before its effect", async () => {
    const game = newGame();
    await game.start("goblin-ambush", "desktop-test-1");
    await chooseCharacter(game, "Wizard");
    for (let count = 0; count < 100; count += 1) {
      const missile = game
        .view()
        .decision?.options.find((item) => item.label.includes("Magic Missile"));
      if (missile) {
        await game.answer(missile.id);
        break;
      }
      await firstOption(game);
    }
    const lines = game.view().log.map((line) => line.text);
    const spent = lines.findIndex((text) => text.includes("spends a level 1"));
    expect(spent).toBeGreaterThan(-1);
    expect(lines[spent + 1]).toContain("force damage");
  });

  it("reports a broken save instead of throwing it away silently", async () => {
    const saves = memorySaves();
    saves.setItem("saves/bad.json", "not json");
    const game = createGame({
      storage: withSaves(createContentReader(url), saves),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });
    await expect(game.load("saves/bad.json")).rejects.toThrow("valid JSON");
    await expect(game.load("saves/none.json")).rejects.toThrow("no save");
  });

  it("refuses to write anywhere but saves", async () => {
    const storage = withSaves(createContentReader(url), memorySaves());
    await expect(
      storage.replaceAtomically("plugins/x.yaml", "bad"),
    ).rejects.toThrow("read-only");
  });
});
