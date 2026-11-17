import { describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import {
  type SaveStore,
  withSaves,
} from "../engine/platform/browser/storage.ts";
import { createNodeStorage } from "../engine/platform/node/storage.ts";
import { createGame } from "../engine/shell/session.ts";
import { excerpt, termFinder } from "../engine/shell/term-text.ts";
import { buildGlossary } from "../engine/tools/glossary.ts";
import { GLOSSARY_TERMS } from "../plugins/systems/dnd5.5e/core/glossary.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";
import {
  ConditionSchema,
  DAMAGE_TYPES,
  DOWNTIME_KINDS,
  ENVIRONMENT_KINDS,
  OPTION_KINDS,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

// Every heading, file and sentence here is invented.
describe("the glossary index", () => {
  const terms = [
    { id: "condition:wobbly", entity: "condition/wobbly" },
    { id: "rule:luck", entity: "rule-term/lucks-edge" },
    { id: "rule:nowhere", entity: "rule-term/nowhere" },
  ];
  const entity = (id: string, library: string[]) => ({
    id,
    file: `${id.slice(id.indexOf(":") + 1, id.indexOf("/"))}s/${id.slice(id.indexOf("/") + 1)}.yaml`,
    library,
  });

  it("takes each term's entity from the best book that has it, with the section it describes", () => {
    const glossary = buildGlossary(
      "test",
      terms,
      ["first", "second"],
      [
        entity("first:rule-term/lucks-edge", ["first/0100-luck"]),
        entity("second:condition/wobbly", ["second/0200-terms#wobbly"]),
        entity("second:rule-term/lucks-edge", ["second/0201-luck"]),
        entity("third:rule-term/nowhere", ["third/0300-nowhere"]), // not a glossary book
        entity("first:condition/sideways", ["first/0001-sideways"]),
      ],
    );
    expect(glossary).toEqual({
      system: "test",
      terms: {
        "condition:wobbly": {
          book: "second",
          file: "0200-terms.md",
          entity: "conditions/wobbly.yaml",
        },
        "rule:luck": {
          book: "first",
          file: "0100-luck.md",
          entity: "rule-terms/lucks-edge.yaml",
        },
      },
      missing: ["rule:nowhere"],
    });
  });

  it("lists every term as missing with no books", () => {
    expect(buildGlossary("test", terms, [], []).missing).toHaveLength(3);
  });

  it("covers every condition and damage type the D&D plugin knows, once each", () => {
    const ids = GLOSSARY_TERMS.map((term) => term.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const condition of ConditionSchema.options) {
      expect(ids).toContain(`condition:${condition}`);
    }
    for (const type of DAMAGE_TYPES) expect(ids).toContain(`damage:${type}`);
    expect(ids).toContain("mastery:slow"); // the slowed tactic's
    expect(
      GLOSSARY_TERMS.every((term) => /^[a-z-]+\/[a-z0-9-]+$/.test(term.entity)),
    ).toBe(true);
    expect(GLOSSARY_TERMS.every((term) => term.words.length > 0)).toBe(true);
  });
});

describe("a term's quick answer", () => {
  const section = [
    "### Wobbly [Condition]",
    "",
    "While ***wobbly***, you sway about.",
    "",
    "***Tipsy.*** You lean to the [left](#x) a lot.",
    "",
    "**Sways**",
    "",
    "| Kind | Example |",
    "| --- | --- |",
    "| Gentle | A breeze |",
    "| Wild | A gale |",
  ].join("\n");

  it("is the section's title and its first paragraphs, without markup", () => {
    expect(excerpt(section, "wobbly")).toEqual({
      title: "Wobbly [Condition]",
      paragraphs: [
        "While wobbly, you sway about.",
        "Tipsy. You lean to the left a lot.",
      ],
    });
  });

  it("adds the table row the word names", () => {
    expect(excerpt(section, "Wild").paragraphs).toEqual([
      "While wobbly, you sway about.",
      "Wild: A gale",
    ]);
  });

  it("adds the paragraph led by the word in bold, one or many", () => {
    const types = [
      "### Kinds",
      "",
      "Every thing has a kind.",
      "",
      "**Blobs** are round.",
      "",
      "**Fuzzies** are soft.",
      "",
      "**Fey** are fair.",
    ].join("\n");
    expect(excerpt(types, "Blob").paragraphs).toEqual([
      "Every thing has a kind.",
      "Blobs are round.",
    ]);
    expect(excerpt(types, "Fuzzy").paragraphs).toEqual([
      "Every thing has a kind.",
      "Fuzzies are soft.",
    ]);
    expect(excerpt(types, "Fey").paragraphs).toEqual([
      "Every thing has a kind.",
      "Fey are fair.",
    ]);
  });

  it("stays short for a long section", () => {
    const long = `### Long\n\n${"Many words here. ".repeat(80)}\n\nMore.`;
    const { paragraphs } = excerpt(long, "Long");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.length).toBeLessThan(440);
  });
});

describe("finding terms in the game's text", () => {
  const entry = (id: string, words: string[]) => ({
    id,
    words,
    book: "b",
    file: "f.md",
  });
  const find = termFinder([
    entry("condition:poisoned", ["poisoned", "Poisoned"]),
    entry("damage:poison", ["poison"]),
    entry("rule:opportunity-attack", ["Opportunity Attacks"]),
    entry("action:help", ["Help"]),
  ]);

  it("matches whole words as written, the longest first", () => {
    expect(
      find("Poisoned by poison, no Opportunity Attacks; help is not Help.").map(
        ({ word, term }) => `${word}=${term.id}`,
      ),
    ).toEqual([
      "Poisoned=condition:poisoned",
      "poison=damage:poison",
      "Opportunity Attacks=rule:opportunity-attack",
      "Help=action:help",
    ]);
  });

  it("links nothing inside a name from the run's content, as a creature type's or a skill's word", () => {
    const named = termFinder(
      [
        entry("creature-type:giant", ["Giant", "Giants"]),
        entry("creature-type:fey", ["Fey"]),
        entry("skill:nature", ["Nature"]),
      ],
      [
        "Giant Rat",
        "Storm Giant",
        "Fey Step",
        "Nature’s Veil",
        "Giant",
        "Longsword",
      ],
    );
    const words = (text: string) => named(text).map(({ word }) => word);
    expect(
      words("A Giant Rat, a Storm Giant and Fey Step; Nature's Veil."),
    ).toEqual([]);
    expect(words("Giants and Fey call on Nature.")).toEqual([
      "Giants",
      "Fey",
      "Nature",
    ]);
    expect(words("The Giant swings.")).toEqual(["Giant"]);
  });

  it("finds nothing without terms", () => {
    expect(termFinder([])("Poisoned")).toEqual([]);
  });
});

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

describe("the session's rules terms", () => {
  const gameWith = async (
    glossary: string | null,
    files: Readonly<Record<string, string>> = {},
  ) => {
    const content = await createNodeStorage(process.cwd());
    return createGame({
      storage: withSaves(
        {
          read: (path) =>
            path === "books/library/glossary.json"
              ? Promise.resolve(glossary)
              : Object.hasOwn(files, path)
                ? Promise.resolve(files[path] ?? null)
                : content.read(path),
          list: async (prefix) => [
            ...(await content.list(prefix)),
            ...(glossary !== null && prefix === "books/library"
              ? [{ path: "books/library/glossary.json", symlink: false }]
              : []),
            ...Object.keys(files)
              .filter((path) => path.startsWith(`${prefix}/`))
              .map((path) => ({ path, symlink: false })),
          ],
        },
        memorySaves(),
      ),
      roots: ["plugins"],
      systems,
      uis: [dndUi],
    });
  };

  it("gives the system's terms a book explains, with where", async () => {
    const game = await gameWith(
      JSON.stringify({
        system: "dnd5.5e",
        terms: {
          "condition:prone": {
            book: "made-up",
            file: "0001-prone.md",
            entity: "conditions/prone.yaml",
          },
          "condition:blinded": {
            book: "made-up",
            file: "0004-blinded.md",
            entity: "../escape.yaml",
          },
          "rule:advantage": { book: "../escape", file: "0002.md" },
          "rule:unknown": { book: "made-up", file: "0003.md" },
        },
        missing: [],
      }),
    );
    expect(await game.terms()).toEqual([]); // no game yet
    await game.start("goblin-ambush", "glossary-test", {});
    expect(await game.terms()).toEqual([
      {
        id: "condition:blinded",
        words: ["blinded", "Blinded"],
        book: "made-up",
        file: "0004-blinded.md",
      },
      {
        id: "condition:prone",
        words: ["prone", "Prone"],
        book: "made-up",
        file: "0001-prone.md",
        entity: "conditions/prone.yaml",
      },
    ]);
  });

  it("reads a term's entity as a section: its name, then its text", async () => {
    const game = await gameWith(null, {
      "books/rules/made-up/conditions/prone.yaml":
        "- id: made-up:condition/prone\n  name: Flat\n  source: Made Up\n  text: You lie about.\n",
    });
    expect(await game.readTerm("made-up", "conditions/prone.yaml")).toBe(
      "### Flat\n\nYou lie about.",
    );
    await expect(
      game.readTerm("..", "conditions/prone.yaml"),
    ).rejects.toThrow();
    await expect(game.readTerm("made-up", "../x.yaml")).rejects.toThrow();
  });

  it("says which text kind a book's section is, or nothing without a sound index (#134–#136)", async () => {
    const kinds = JSON.stringify({
      kinds: { "0001-ague.md": [{ heading: "Ague", kind: "disease" }] },
    });
    const game = await gameWith(null, {
      "books/library/made-up/kinds.json": kinds,
      "books/library/damaged/kinds.json": "not json",
    });
    expect(await game.kinds("made-up", "0001-ague.md")).toEqual([
      { heading: "Ague", kind: "disease" },
    ]);
    expect(await game.kinds("made-up", "0002-other.md")).toEqual([]);
    expect(await game.kinds("damaged", "0001-ague.md")).toEqual([]);
    expect(await game.kinds("absent", "0001-ague.md")).toEqual([]);
    expect(await game.kinds("..", "0001-ague.md")).toEqual([]);
  });

  it("reads a section's family links, another book's too (#188)", async () => {
    const links = JSON.stringify({
      links: {
        "0001-imp.md": [
          { file: "0002-imps.md", heading: "Imps", rel: "family" },
          {
            book: "bestiary",
            file: "0009-fiends.md",
            heading: "Fiends",
            rel: "family",
          },
        ],
      },
    });
    const game = await gameWith(null, {
      "books/library/made-up/links.json": links,
    });
    expect(await game.links("made-up", "0001-imp.md")).toEqual([
      { file: "0002-imps.md", heading: "Imps", rel: "family" },
      {
        book: "bestiary",
        file: "0009-fiends.md",
        heading: "Fiends",
        rel: "family",
      },
    ]);
    expect(await game.links("..", "0001-imp.md")).toEqual([]);
  });

  it("keeps the environment, downtime and option kinds out of the save hash, as lore", () => {
    const kinds = dnd55e.contentKinds;
    for (const map of [ENVIRONMENT_KINDS, DOWNTIME_KINDS, OPTION_KINDS])
      for (const [folder, idPrefix] of Object.entries(map))
        expect([folder, kinds[folder]?.idPrefix, kinds[folder]?.lore]).toEqual([
          folder,
          idPrefix,
          true,
        ]);
  });

  it("gives none without the owner's index, or with another system's", async () => {
    for (const glossary of [
      null,
      "not json",
      JSON.stringify({ system: "other", terms: {} }),
    ]) {
      const game = await gameWith(glossary);
      await game.start("goblin-ambush", "glossary-test", {});
      expect(await game.terms()).toEqual([]);
    }
  });
});
