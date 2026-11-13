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
import {
  ConditionSchema,
  DAMAGE_TYPES,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { dndUi } from "../plugins/systems/dnd5.5e/ui/index.ts";

// Every heading, file and sentence here is invented.
const GLOSSARY = ["Rules Glossary", "Rules Definitions"];
const book = (plugin: string, entries: [string[], string][]) => ({
  plugin,
  entries: entries.map(([path, file]) => ({ path, file })),
});

describe("the glossary index", () => {
  const terms = [
    { id: "condition:wobbly", heading: "Wobbly [Condition]" },
    { id: "rule:luck", heading: "Luck’s Edge" },
    { id: "rule:nowhere", heading: "Nowhere" },
  ];

  it("takes each term from the best book that has it, only from a Rules Glossary", () => {
    const glossary = buildGlossary("test", terms, [
      book("first", [
        [["Chapter 1", "Wobbly [Condition]"], "0001-wobbly.md"], // not the glossary
        [[...GLOSSARY, "Luck's  edge"], "0100-luck.md"],
      ]),
      book("second", [
        [[...GLOSSARY, "Wobbly [Condition]"], "0200-wobbly.md"],
        [[...GLOSSARY, "Luck’s Edge"], "0201-luck.md"],
      ]),
    ]);
    expect(glossary).toEqual({
      system: "test",
      terms: {
        "condition:wobbly": { book: "second", file: "0200-wobbly.md" },
        "rule:luck": { book: "first", file: "0100-luck.md" },
      },
      missing: ["rule:nowhere"],
    });
  });

  it("lists every term as missing with no books", () => {
    expect(buildGlossary("test", terms, []).missing).toHaveLength(3);
  });

  it("covers every condition and damage type the D&D plugin knows, once each", () => {
    const ids = GLOSSARY_TERMS.map((term) => term.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const condition of ConditionSchema.options) {
      expect(ids).toContain(`condition:${condition}`);
    }
    for (const type of DAMAGE_TYPES) expect(ids).toContain(`damage:${type}`);
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
  const gameWith = async (glossary: string | null) => {
    const content = await createNodeStorage(process.cwd());
    return createGame({
      storage: withSaves(
        {
          read: (path) =>
            path === "books/library/glossary.json"
              ? Promise.resolve(glossary)
              : content.read(path),
          list: async (prefix) => [
            ...(await content.list(prefix)),
            ...(glossary !== null && prefix === "books/library"
              ? [{ path: "books/library/glossary.json", symlink: false }]
              : []),
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
          "condition:prone": { book: "made-up", file: "0001-prone.md" },
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
        id: "condition:prone",
        words: ["prone", "Prone"],
        book: "made-up",
        file: "0001-prone.md",
      },
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
