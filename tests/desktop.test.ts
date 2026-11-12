import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BOOK_ROOTS } from "./depth.ts";
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
import { createGame, sheetChanges } from "../engine/shell/session.ts";
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
    ["books/rules/a.yaml", "books", "rules/a.yaml"],
    ["books/adventures/x/plugin.yaml", "books", "adventures/x/plugin.yaml"],
    ["books/assets/x/index.json", "books", "assets/x/index.json"],
    ["books/library/x/index.json", "books", "library/x/index.json"],
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
    "plugins/rules/../../books/a",
    "plugins/./a.yaml",
    "plugins//a.yaml",
    "plugins/a/",
    "plugins\\..\\package.json",
    "..\\plugins",
    "plugins/a\0.yaml",
    "books/.git/config",
    "books/rules/.hidden.yaml",
    // books/ is only reachable through the folders the game reads, not its importer working files.
    "books",
    "books/a.yaml",
    "books/sources/spells.txt",
    "books/import/x/report.md",
    "books/audit/x.md",
    "books/encodings/x.json",
    "books/Rules/a.yaml",
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
    await mkdir(join(base, "plugins/rules/.git"));
    await writeFile(join(base, "plugins/rules/.git/config"), "secret");
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
    expect(await reader.read("books/rules/a.yaml")).toBeNull();
    expect(await reader.list("books/rules")).toEqual([]);
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

  it("starts with the chosen difficulty and keeps it through a save and a restart", async () => {
    const game = newGame();
    const settings = await game.settingsFor("goblin-ambush");
    expect(settings.map((setting) => setting.id)).toEqual(["difficulty"]);
    await game.start("goblin-ambush", "difficulty-test", {
      difficulty: "story",
    });
    const difficulty = (): unknown =>
      (game.view().systemState as { difficulty?: string }).difficulty;
    expect(difficulty()).toBe("story");
    const path = await game.save("difficulty");
    await game.start("goblin-ambush", "other", { difficulty: "hard" });
    expect(difficulty()).toBe("hard");
    await game.load(path);
    expect(difficulty()).toBe("story");
    await game.restart("again");
    expect(difficulty()).toBe("story");
  });

  const pick = async (
    game: ReturnType<typeof newGame>,
    label: string,
  ): Promise<void> => {
    const option = game
      .view()
      .decision?.options.find((item) => item.label.includes(label));
    if (!option) throw new Error(`${label} isn't offered`);
    await game.answer(option.id);
  };

  it("undoes the last choice on Story, and the same choice rolls the same dice again", async () => {
    const game = newGame();
    await game.start("haunted-house", "undo-test", { difficulty: "story" });
    expect(game.view().canUndo).toBe(false); // nothing chosen yet
    await chooseCharacter(game, "Fighter");
    await pick(game, "Try the cellar door");
    await pick(game, "Keep moving"); // the dread clock's beat comes first
    const before = game.view();
    await pick(game, "Force the lock");
    const after = game.view();
    expect(after.rolls.at(-1)).toMatchObject({
      actor: "Human Fighter",
      label: "Athletics check",
      step: after.steps - 1,
    });
    expect(after.rolls.at(-1)?.math).toMatch(/^\d+ [+−] \d+ = \d+ vs DC 13$/);

    await game.undo();
    // A told-again log has no cues for the board to replay.
    expect({ ...game.view(), cues: [] }).toEqual({ ...before, cues: [] });
    // The autosave forgets the choice too, so loading it doesn't bring it back.
    const autosave = (await game.listSaves()).find((save) => save.current);
    if (!autosave) throw new Error("No autosave");
    await game.load(autosave.path);
    expect(game.view().steps).toBe(before.steps);

    await pick(game, "Force the lock");
    expect(game.view().rolls).toEqual(after.rolls);
    expect(game.view().systemState).toEqual(after.systemState);
  });

  it("offers no undo on Normal or Hard", async () => {
    for (const difficulty of ["normal", "hard"]) {
      const game = newGame();
      await game.start("haunted-house", "undo-test", { difficulty });
      await chooseCharacter(game, "Fighter");
      expect(game.view().canUndo).toBe(false);
      await expect(game.undo()).rejects.toThrow("doesn't allow undoing");
    }
  });

  it("keeps the clues found as leads, and the rolls made, from the events", async () => {
    const game = newGame();
    await game.start("haunted-house", "leads-test");
    await chooseCharacter(game, "Fighter");
    expect(game.view().leads).toEqual([]);
    await pick(game, "Talk to the caretaker");
    const { leads, steps } = game.view();
    expect(leads).toEqual([
      {
        clues: [
          { text: "Fresh mortar dust on the caretaker's sleeves.", step: 2 },
        ],
      },
    ]);
    expect(steps).toBe(3);
    // A save tells the same leads again.
    const path = await game.save("leads");
    await game.start("haunted-house", "other");
    await game.load(path);
    expect(game.view().leads).toEqual(leads);
  });

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

  it("gives an adventure the cover its book names, and the rest the title plate", async () => {
    const content = createContentReader(url);
    const game = createGame({
      storage: withSaves(
        {
          read: (path) =>
            path === "books/assets/book/index.json"
              ? Promise.resolve(
                  JSON.stringify([
                    { file: "cover.jpg", cover: ["haunted-house"] },
                    { file: "notes.txt", cover: ["goblin-ambush"] },
                  ]),
                )
              : content.read(path),
          list: (prefix) =>
            prefix === "books/assets"
              ? Promise.resolve([
                  { path: "books/assets/book/index.json", symlink: false },
                ])
              : content.list(prefix),
        },
        memorySaves(),
      ),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });
    const covers = Object.fromEntries(
      (await game.listAdventures()).map((item) => [item.id, item.cover]),
    );
    // A cover that isn't a picture is dropped, so that adventure shows its plate.
    expect(covers).toEqual({
      "haunted-house": "books/assets/book/cover.jpg",
      "goblin-ambush": null,
    });
  });

  // Runs only where the owner's books are present.
  it.skipIf(!BOOK_ROOTS || !existsSync("books/adventures"))(
    "finds a cover for every adventure from the books",
    async () => {
      const adventures = await createGame({
        storage: withSaves(createContentReader(url), memorySaves()),
        roots: ["plugins", "books"],
        systems,
        uis: [dndUi],
      }).listAdventures();
      for (const { id, source, cover } of adventures) {
        // Anything without a cover gets the title plate; a book's adventure must have one.
        if (source === "private") expect(cover, id).not.toBeNull();
        if (cover !== null) expect(existsSync(cover), cover).toBe(true);
      }
    },
  );

  it("plays a fight, saves mid-fight, loads and reaches an end", async () => {
    const game = newGame();
    await game.start("goblin-ambush", "desktop-test-1");
    expect(game.view().sheets).toEqual([]);
    await chooseCharacter(game, "Fighter");

    const [sheet, companion] = game.view().sheets;
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

    expect(companion?.sections.map((section) => section.title)).toContain(
      "Abilities",
    );

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
        expect(game.view().cues).toEqual([]);
        expect({ ...game.view(), cues: [] }).toEqual({ ...before, cues: [] });
        expect((await game.listSaves()).map((save) => save.path)).toContain(
          savedPath,
        );
      }
      await firstOption(game);
    }

    expect(savedPath).not.toBeNull();
    const end = game.view();
    expect(end.cues.map((cue) => (cue as { kind: string }).kind)).toEqual(
      expect.arrayContaining(["start", "turn", "attack", "damage", "end"]),
    );
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

  describe("save slots", () => {
    // Each step is a second apart, so the order never rests on two saves sharing a millisecond.
    let clock = Date.parse("2026-11-12T10:00:00Z");
    const tick = (): void => {
      clock += 1000;
      vi.setSystemTime(clock);
    };
    const gameOn = (store: SaveStore) =>
      createGame({
        storage: withSaves(createContentReader(url), store),
        roots: ["plugins"],
        systems,
        uis: [dndUi],
      });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps manual saves beside the autosave, newest first, and Continue takes the newest", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      tick();
      const store = memorySaves();
      const game = gameOn(store);
      await game.start("goblin-ambush", "slots", { difficulty: "hard" });
      tick();
      await chooseCharacter(game, "Fighter");
      tick();
      const first = await game.save("first");
      tick();
      await firstOption(game); // moves the autosave on
      tick();
      const second = await game.save("second");
      const autosave = "saves/goblin-ambush-slots-autosave.json";

      const saves = await game.listSaves();
      expect(saves.map((save) => save.path)).toEqual([second, autosave, first]);
      expect(saves.map((save) => save.kind)).toEqual([
        "manual",
        "autosave",
        "manual",
      ]);
      const [newest] = saves;
      expect(newest).toMatchObject({
        title: "Ambush on the Old Road",
        level: 1,
        settings: ["Hard"],
        savedAt: new Date(clock).toISOString(),
      });
      expect(newest).toMatchObject({
        scene: "The Old Road",
        character: "Human Fighter",
        characterKind: null, // the pregen's name already says it
        ago: "just now",
        current: false,
      });
      expect(newest?.health).toMatch(/^\d+\/\d+ HP$/);
      expect(newest?.label).toMatch(/, \d+ steps$/);
      expect(saves.find((save) => save.path === autosave)?.current).toBe(true);
      // Builds from before save cards read the times as plain strings, so they stay that way.
      const times: unknown = JSON.parse(store.getItem("saves/times") ?? "{}");
      expect(
        Object.values(times as object).every(
          (time) => typeof time === "string",
        ),
      ).toBe(true);

      // Continue loads the first save in the list, which an answer's autosave then replaces.
      tick();
      await firstOption(game);
      expect((await game.listSaves())[0]?.path).toBe(autosave);

      await game.deleteSave(first);
      expect((await game.listSaves()).map((save) => save.path)).toEqual([
        autosave,
        second,
      ]);
      await game.load(second);
      expect(game.view().decision).not.toBeNull();
    });

    // The save files themselves haven't changed, only the record of times beside them.
    it("loads saves from before save cards, and fills in their details", async () => {
      const made = memorySaves();
      const maker = gameOn(made);
      await maker.start("goblin-ambush", "old");
      await chooseCharacter(maker, "Wizard");
      const text = made.getItem("saves/goblin-ambush-old-autosave.json");
      if (text === null) throw new Error("No autosave was written");

      const store = memorySaves();
      store.setItem("saves/goblin-ambush-dated.json", text);
      store.setItem("saves/goblin-ambush-undated.json", text);
      store.setItem(
        "saves/times",
        JSON.stringify({
          "saves/goblin-ambush-dated.json": "2026-01-01T00:00:00.000Z",
        }),
      );
      // Details as cards first recorded them, before the character was kept.
      store.setItem(
        "saves/details",
        JSON.stringify({
          "saves/goblin-ambush-undated.json": {
            scene: "Road",
            level: 1,
            settings: [],
            art: null,
          },
        }),
      );
      const game = gameOn(store);

      const before = await game.listSaves();
      expect(before.map((save) => save.path)).toEqual([
        "saves/goblin-ambush-dated.json",
        "saves/goblin-ambush-undated.json",
      ]);
      expect(before[0]).toMatchObject({
        savedAt: "2026-01-01T00:00:00.000Z",
        scene: null,
        level: null,
        kind: "manual",
        character: null,
      });
      expect(before[1]).toMatchObject({ scene: "Road", character: null });

      await game.load("saves/goblin-ambush-dated.json");
      expect(game.view().sheets[0]?.title).toBeTruthy();
      const [dated] = await game.listSaves();
      expect(dated).toMatchObject({
        path: "saves/goblin-ambush-dated.json",
        savedAt: "2026-01-01T00:00:00.000Z",
        level: 1,
      });
      expect(dated?.scene).toBeTruthy();

      await game.load("saves/goblin-ambush-undated.json");
      const fresh = await game.save("new");
      expect((await game.listSaves())[0]?.path).toBe(fresh);
    });
  });

  it("finds a monster's picture by name and ignores art that isn't an image", async () => {
    const content = createContentReader(url);
    const game = createGame({
      storage: withSaves(
        {
          read: (path) =>
            path === "books/assets/book/index.json"
              ? Promise.resolve(
                  JSON.stringify([
                    { file: "a.png", monster: "goblin-warrior" },
                    { file: "../b.png", monster: "Goblin Chief" },
                  ]),
                )
              : content.read(path),
          list: (prefix) =>
            prefix === "books/assets"
              ? Promise.resolve([
                  { path: "books/assets/book/index.json", symlink: false },
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
      new Set(["books/assets/book/a.png"]),
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

  it("offers rests at the campfire, apart from the scene's choices", async () => {
    const game = newGame();
    await game.start("goblin-ambush", "desktop-test-1");
    await chooseCharacter(game, "Fighter");
    const view = game.view();
    expect(view.rests.map((rest) => rest.id)).toEqual([
      "rest:short",
      "rest:long",
    ]);
    const choices = view.optionGroups.flatMap((group) => group.options);
    expect(choices.some((option) => option.id.startsWith("rest:"))).toBe(false);
    await game.answer("rest:long");
    expect(game.view().rests).toEqual([]);
  });

  it("finds nothing to recover after resting at full health", async () => {
    for (const rest of ["rest:short", "rest:long"]) {
      const game = newGame();
      await game.start("goblin-ambush", "desktop-test-1");
      await chooseCharacter(game, "Wizard");
      const before = game.view().sheets;
      const scene = game.view().decision?.id;
      await game.answer(rest);
      // The rest's own questions, as the camp answers them, until the scene's choice is back.
      for (let count = 0; count < 10; count += 1) {
        const { decision } = game.view();
        if (!decision || decision.id === scene) break;
        const option =
          decision.options.find((item) => /^(Finish|Done)/.test(item.label)) ??
          decision.options[0];
        if (!option) break;
        await game.answer(option.id);
      }
      expect(sheetChanges(before, game.view().sheets)).toEqual([]);
    }
  });

  it("tells sheet rows apart by section when comparing them", () => {
    const sheet = (hp: string) => ({
      id: "player",
      title: "Merric",
      sections: [
        { title: "Combat", rows: [{ label: "Hit Points", value: hp }] },
        { title: "Attacks", rows: [{ label: "Dagger", value: "+4" }] },
        { title: "Equipment", rows: [{ label: "Dagger", value: "Equipped" }] },
      ],
    });
    expect(sheetChanges([sheet("3")], [sheet("3")])).toEqual([]);
    expect(sheetChanges([sheet("3")], [sheet("8")])).toEqual([
      { title: "Merric", changes: ["Hit Points 3 → 8"] },
    ]);
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
