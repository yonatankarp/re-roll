import { describe, expect, it } from "vitest";
import type { GameSystem } from "../engine/kernel/system.ts";
import { scanPlugins } from "../engine/run/loader.ts";
import {
  type CoverageFile,
  type Entity,
  type Heading,
  checkCoverage,
  classifyBook,
  formatCoverage,
  headingsOf,
  indexEntities,
  matchHeading,
  variants,
} from "../engine/tools/coverage.ts";

// Every name here is invented, or one the public issue (#126) already prints.
const entity = (
  id: string,
  name: string,
  edition = "new",
  library: string[] = [],
): Entity => ({
  id,
  plugin: id.slice(0, id.indexOf(":")),
  kind: /:([^/]+)\//.exec(id)?.[1] ?? "",
  name,
  edition,
  library,
});

const ENTITIES = [
  entity("hb:species/aasimar", "Aasimar"),
  entity("hb:class/bard", "Bard"),
  entity("hb:feature/barbarian-rage", "Rage"),
  entity("hb:item/acid", "Acid"),
  entity("hb:species/elf-high-elf-lineage", "High Elf Lineage"),
  entity("hb:spell/bane", "Bane"),
  entity("hb:spell/gloom", "Gloom"),
  entity("hb:bastion/treasure", "Treasure"),
  entity("mm:monster/yuan-ti-malison-type-1", "Yuan-ti Malison (Type 1)"),
  entity("mm:monster/yuan-ti-malison", "Yuan-ti Malison"),
  entity("mm:monster/glimmerwing", "Glimmerwing"),
  entity("old:spell/rage", "Rage", "old"),
  entity("hb:deity/glimmer", "Glimmer"),
];
const index = indexEntities(ENTITIES);
const scope = (book: string, kinds: string[] | null = null) => ({
  book,
  edition: "new",
  kinds,
  asked: false,
  adventure: null,
});
const match = (book: string, heading: string, kinds: string[] | null = null) =>
  matchHeading(index, heading, scope(book, kinds))?.id;

describe("the coverage matcher", () => {
  it("tries the heading as printed before stripping its labels", () => {
    expect(variants("Acid (25 GP)").named).toEqual(["acid-25-gp", "acid"]);
    expect(variants("Level 3: Rage").named).toEqual(["level-3-rage", "rage"]);
    expect(variants("Feature: Moss Haven").named).toEqual([
      "feature-moss-haven",
      "moss-haven",
    ]);
    expect(variants("Aasimar Traits").loose).toContain("aasimar");
    expect(variants("High Elves").loose).toContain("high-elf");
    expect(match("mm", "Yuan-ti Malison (Type 1)")).toBe(
      "mm:monster/yuan-ti-malison-type-1",
    );
  });

  it("strips wrapper labels and prices, and matches a plural to its singular", () => {
    expect(match("hb", "Aasimar Traits")).toBe("hb:species/aasimar");
    expect(match("hb", "Bard Spell List")).toBe("hb:class/bard");
    expect(match("hb", "Barbarian Class Features")).toBeUndefined();
    expect(match("hb", "Level 3: Rage")).toBe("hb:feature/barbarian-rage");
    expect(match("hb", "Acid (25 GP)")).toBe("hb:item/acid");
    expect(match("hb", "High Elves", ["species"])).toBe(
      "hb:species/elf-high-elf-lineage",
    );
  });

  it("matches within the same edition only", () => {
    expect(
      matchHeading(index, "Rage", { ...scope("old"), edition: "old" })?.id,
    ).toBe("old:spell/rage");
    expect(match("other", "Rage")).toBe("hb:feature/barbarian-rage");
  });

  it("keeps loose keys to the same book unless a rule asks", () => {
    expect(match("other", "Gloom Traits")).toBeUndefined();
    expect(
      matchHeading(index, "Gloom Traits", { ...scope("other"), asked: true })
        ?.id,
    ).toBe("hb:spell/gloom");
  });

  it("links lore by name in its own book, or where a rule asks for its kind", () => {
    expect(match("hb", "Glimmer")).toBe("hb:deity/glimmer");
    expect(match("other", "Glimmer")).toBeUndefined();
    expect(match("other", "Glimmer", ["deity"])).toBe("hb:deity/glimmer");
  });

  it("links an adventure's heading only to its own book or its adventure kinds", () => {
    const adventure = { ...scope("adv"), adventure: ["monster"] };
    expect(matchHeading(index, "Treasure", adventure)).toBeUndefined();
    expect(matchHeading(index, "Glimmerwing", adventure)?.id).toBe(
      "mm:monster/glimmerwing",
    );
  });
});

const heading = (
  file: string,
  level: number,
  text: string,
  id = `bk/${file}#${text}`,
): Heading => ({ id, book: "bk", file, level, text, body: "" });

const classify = (
  headings: Heading[],
  coverage: CoverageFile,
  linkedBy = new Map<string, string>(),
) =>
  classifyBook(
    { book: "bk", edition: "new", coverage, headings },
    index,
    linkedBy,
  ).map((verdict) => [
    verdict.heading.text,
    verdict.status,
    verdict.entity ?? verdict.kind,
  ]);

describe("the structural rule", () => {
  it("applies the first rule that fits a heading's section, level and wording", () => {
    const rules: CoverageFile["rules"] = [
      { sections: "0010-0019", levels: [3], is: "deity" },
      { sections: "0020-0029", keyed: true, is: "area" },
      { heading: "^Goals$", is: "structural" },
      { is: "structural" },
    ];
    expect(
      classify(
        [
          heading("0001-intro.md", 1, "Chapter 2: Welcome"),
          heading("0012-gods.md", 3, "Bane"),
          heading("0012-gods.md", 4, "Goals"),
          heading("0021-keep.md", 3, "B12. Treasure"),
          heading("0021-keep.md", 3, "Treasure"),
          heading("0030-spells.md", 3, "Gloom"),
        ],
        { rules },
      ),
    ).toEqual([
      ["Chapter 2: Welcome", "structural", "structural"],
      // The deity Bane doesn't link to the Bane spell: a rule's kind limits what it matches.
      ["Bane", "missing", "deity"],
      ["Goals", "structural", "structural"],
      ["B12. Treasure", "missing", "area"],
      // Treasure under a structural rule still links when the matcher finds it.
      ["Treasure", "linked", "hb:bastion/treasure"],
      ["Gloom", "linked", "hb:spell/gloom"],
    ]);
  });

  it("tries a rule's match before moving on, and leaves unruled headings unclassified", () => {
    expect(
      classify(
        [
          heading("0001-a.md", 2, "Gloom Spells"),
          heading("0002-b.md", 2, "Nowhere"),
        ],
        { rules: [{ heading: "Spells$", match: ["spell"] }] },
      ),
    ).toEqual([
      ["Gloom Spells", "linked", "hb:spell/gloom"],
      ["Nowhere", "missing", "unclassified"],
    ]);
  });

  it("links a family with one stat block, and names a mapped site", () => {
    const rules: CoverageFile["rules"] = [
      {
        levels: [2],
        heading: "^Glimmer",
        family: "monster",
        is: "monster-family",
      },
      { levels: [2], site: "place", is: "structural" },
      { is: "structural" },
    ];
    expect(
      classify(
        [
          heading("0001-a.md", 2, "Glimmerwing"),
          heading("0001-a.md", 3, "Glimmerwing Lore"),
          heading("0002-b.md", 2, "Glimmerwing"),
          heading("0002-b.md", 3, "Yuan-ti Malison"),
          heading("0002-b.md", 3, "Rage"),
          heading("0003-c.md", 2, "Old Mill"),
          heading("0003-c.md", 3, "Mill Features"),
          heading("0004-d.md", 2, "Old Road"),
        ],
        { rules },
      ).map(([text, status, kind]) => `${text}: ${status} ${kind}`),
    ).toEqual([
      "Glimmerwing: linked mm:monster/glimmerwing",
      "Glimmerwing Lore: structural structural",
      "Glimmerwing: missing monster-family",
      "Yuan-ti Malison: linked mm:monster/yuan-ti-malison",
      "Rage: linked hb:feature/barbarian-rage",
      "Old Mill: missing place",
      "Mill Features: structural structural",
      "Old Road: structural structural",
    ]);
  });

  it("takes an explicit link from an entity or the book's coverage file", () => {
    const one = heading("0001-a.md", 2, "Dark Lord", "bk/0001-a");
    const two = heading("0001-a.md", 3, "The Sly One", "bk/0001-a#the-sly-one");
    expect(
      classify(
        [one, two],
        {
          rules: [{ is: "npc" }],
          links: { "bk/0001-a#the-sly-one": ["mm:monster/glimmerwing"] },
        },
        new Map([["bk/0001-a", "hb:spell/gloom"]]),
      ),
    ).toEqual([
      ["Dark Lord", "linked", "hb:spell/gloom"],
      ["The Sly One", "linked", "mm:monster/glimmerwing"],
    ]);
  });

  it("gives each heading an id from its file and its words", () => {
    expect(
      headingsOf(
        "bk",
        "0003-keep.md",
        "## Keep\ntext\n### **Gate**\n### Gate\n",
      ).map((item) => `${item.id} ${String(item.level)}`),
    ).toEqual([
      "bk/0003-keep 2",
      "bk/0003-keep#gate 3",
      "bk/0003-keep#gate-2 3",
    ]);
  });
});

describe("the coverage report", () => {
  const files: Record<string, string> = {
    "books/rules/hb/plugin.yaml":
      "id: hb\nkind: rules\nversion: 1.0.0\nsdk: ^1\nsystem: sys@^1\ndistribution: private\n",
    "books/rules/hb/spells/gloom.yaml":
      "- id: hb:spell/gloom\n  name: Gloom\n  library: [hb/0002-gloom, hb/0009-gone]\n",
    "books/library/hb/0001-intro.md": "# Chapter 1: Intro\n",
    "books/library/hb/0002-gloom.md": "## Shadows\n### Bane\n",
    "books/coverage/hb.yaml":
      "rules:\n  - { levels: [3], is: deity }\nlinks:\n  hb/0002-gloom#nothing: [hb:spell/none]\n",
  };
  const storage = {
    read: (path: string) => Promise.resolve(files[path] ?? null),
    list: (prefix: string) =>
      Promise.resolve(
        Object.keys(files)
          .filter((path) => path.startsWith(`${prefix}/`))
          .map((path) => ({ path, symlink: false })),
      ),
  };
  const system = { id: "sys", edition: () => "new" } as unknown as GameSystem;

  it("counts each book's headings, and the missing ones by kind", async () => {
    const roots = ["books"];
    const report = await checkCoverage(
      storage,
      roots,
      await scanPlugins(storage, roots),
      [system],
    );
    expect(formatCoverage(report)).toEqual([
      "Library coverage, 1 books, 3 headings: 1 linked, 1 structural, 1 missing",
      "  hb: 3 headings: 1 linked, 1 structural, 1 missing (deity 1)",
      "Missing by kind: deity 1",
    ]);
    expect(report.issues.map((issue) => issue.message)).toEqual([
      "links hb/0002-gloom#nothing, which no heading has",
      "links hb/0002-gloom#nothing to hb:spell/none, which no entity has",
      "hb:spell/gloom names library heading hb/0009-gone, which no book has",
    ]);
  });

  it("reports no books when there is no library", async () => {
    const report = await checkCoverage(
      { read: () => Promise.resolve(null), list: () => Promise.resolve([]) },
      ["books"],
      { plugins: new Map(), issues: [] },
      [],
    );
    expect(report.books).toEqual([]);
  });
});
