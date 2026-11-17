import { describe, expect, it } from "vitest";
import { RulingSchema, WORLD_KINDS } from "../engine/kernel/world.ts";
import {
  type Entity,
  type Verdict,
  indexEntities,
} from "../engine/tools/coverage.ts";
import { mentions, rulingIndex, subjectsOf } from "../engine/tools/rulings.ts";
import { draftWorld } from "../engine/tools/world.ts";

// Every name here is invented.
const entity = (id: string, name: string, edition = "new"): Entity => ({
  id,
  plugin: id.slice(0, id.indexOf(":")),
  kind: /:([^/]+)\//.exec(id)?.[1] ?? "",
  name,
  edition,
  library: [],
  about: [],
});

const INDEX = indexEntities([
  entity("hb:spell/gloom-lance", "Gloom Lance"),
  entity("hb:spell/hush", "Hush"),
  entity("hb:spell/stillness", "Stillness"),
  entity("hb:item/hush", "Hush"),
  entity("hb:item/ring-of-quiet", "Ring of Quiet"),
  entity("hb:item/scroll", "Scroll"),
  entity("hb:item/scroll-hush", "Scroll (Hush)"),
  entity("hb:class/warden", "Warden"),
  entity("hb:feature/warden-spellwork", "Spellwork"),
  entity("hb:place/hush", "Hush"),
  entity("hb:bastion/attack", "Attack"),
  entity("old:spell/gloom-lance", "Gloom Lance", "old"),
  entity("old:item/ring-of-quiet", "Ring of Quiet", "old"),
  entity("hb:spell/muffle", "Muffle"),
  entity("old:spell/muffle", "Muffle", "old"),
  { ...entity("hb:condition/muffled", "Muffled"), lore: true },
  { ...entity("hb:rule-term/muffle", "Muffle"), lore: true },
]);

const verdict = (
  level: number,
  text: string,
  status: Verdict["status"],
  kind: string,
  entity?: string,
): Verdict => ({
  heading: {
    id: `sa/0001-x#${text}`,
    book: "sa",
    file: "0001-x.md",
    level,
    text,
    body: `On ${text}.`,
  },
  status,
  kind,
  ...(entity ? { entity } : {}),
});

describe("what a ruling names", () => {
  it("finds capitalized names, a name before 'spell', and whole lower-case names, in the book's edition", () => {
    expect(
      mentions(INDEX, "Does Gloom Lance work with a Ring of Quiet?", "new"),
    ).toEqual(["hb:spell/gloom-lance", "hb:item/ring-of-quiet"]);
    expect(
      mentions(
        INDEX,
        "Can the gloom lance spell pierce a ring of quiet?",
        "old",
      ),
    ).toEqual(["old:spell/gloom-lance", "old:item/ring-of-quiet"]);
  });

  it("lets the word after a name pick its kind, and links both when nothing does", () => {
    expect(mentions(INDEX, "Is the Hush spell loud?", "new")).toEqual([
      "hb:spell/hush",
    ]);
    expect(mentions(INDEX, "Is a Hush loud?", "new")).toEqual([
      "hb:spell/hush",
      "hb:item/hush",
    ]);
    // A rules term's name is the term, unless the next word says otherwise.
    const terms = new Set(["hush"]);
    expect(mentions(INDEX, "Is a Hush loud?", "new", terms)).toEqual([]);
    expect(mentions(INDEX, "Is the Hush spell loud?", "new", terms)).toEqual([
      "hb:spell/hush",
    ]);
    // Where the edition has a glossary entity for the term (#132), the name links to it, and only there.
    expect(mentions(INDEX, "Is a Muffle loud?", "new")).toEqual([
      "hb:rule-term/muffle",
    ]);
    expect(mentions(INDEX, "Is the Muffle spell loud?", "new")).toEqual([
      "hb:spell/muffle",
    ]);
    expect(mentions(INDEX, "Is a Muffle loud?", "old")).toEqual([
      "old:spell/muffle",
    ]);
  });

  it("skips a sentence's first word, lore, Bastion orders, and one-word lower-case names", () => {
    expect(mentions(INDEX, "Hush, is it loud?", "new")).toEqual([]);
    expect(mentions(INDEX, "Can I Attack while I hush?", "new")).toEqual([]);
  });

  it("ends a name at a possessive, and leaves one word to the longer name it starts", () => {
    expect(
      mentions(
        INDEX,
        "Does the Warden’s Spellwork outlast Warden Lore?",
        "new",
      ),
    ).toEqual(["hb:class/warden", "hb:feature/warden-spellwork"]);
  });

  it("takes one lower-case spell only after a word that introduces one", () => {
    expect(
      mentions(INDEX, "Is a warden transformed by stillness still?", "new"),
    ).toEqual(["hb:spell/stillness"]);
    expect(mentions(INDEX, "Can stillness last?", "new")).toEqual([]);
  });

  it("names the thing itself over each of its variants", () => {
    expect(mentions(INDEX, "Who can read a Scroll?", "new")).toEqual([
      "hb:item/scroll",
    ]);
  });
});

describe("what a ruling rules on", () => {
  const bookOf = (title: string) =>
    title === "Handbook"
      ? { plugin: "hb", edition: "new" }
      : title === "Lost Tome"
        ? null
        : undefined;
  const verdicts = [
    verdict(1, "Compendium", "structural", "structural"),
    verdict(2, "Warden", "linked", "class", "hb:class/warden"),
    verdict(3, "Spellwork", "linked", "feature", "hb:feature/warden-spellwork"),
    verdict(4, "Can a Warden cast Hush twice?", "missing", "ruling"),
    verdict(1, "Handbook", "structural", "structural"),
    verdict(2, "Ring of Quiet (p. 9)", "missing", "ruling"),
    verdict(1, "Lost Tome", "structural", "structural"),
    verdict(2, "Gloom Lance (p. 3)", "missing", "ruling"),
    verdict(1, "Handbook", "structural", "structural"),
    verdict(2, "Muffle (p. 4)", "missing", "ruling"),
    verdict(2, "Muffled [Condition] (p. 5)", "missing", "ruling"),
  ];
  const subjects = (at: number) =>
    subjectsOf(verdicts, at, "new", INDEX, bookOf);

  it("takes a question's section and the names it prints, but not a feature its section shares a name with", () => {
    expect(subjects(3)).toEqual([
      "hb:class/warden",
      "hb:spell/hush",
      "hb:item/hush",
    ]);
  });

  it("finds an erratum's entry in the book it corrects, and nothing for a book the library lacks", () => {
    expect(subjects(5)).toEqual(["hb:item/ring-of-quiet"]);
    expect(subjects(7)).toEqual([]);
    expect(
      subjectsOf(verdicts, 5, "new", INDEX, bookOf, new Set(["ring-of-quiet"])),
    ).toEqual([]);
    // A rules term's erratum rules on its glossary entity, not the spell that shares its name.
    expect(subjects(9)).toEqual(["hb:rule-term/muffle"]);
    expect(subjects(10)).toEqual(["hb:condition/muffled"]);
  });

  it("lists each ruling beside the sections that describe what it rules on", () => {
    const sections = rulingIndex(
      [
        {
          plugin: "sa",
          library: ["sa/0001-x#Ring of Quiet (p. 9)"],
          about: ["hb:item/ring-of-quiet", "hb:spell/none"],
        },
      ],
      [
        ...verdicts,
        {
          heading: {
            id: "hb/0007-ring",
            book: "hb",
            file: "0007-ring.md",
            level: 3,
            text: "Ring of Quiet",
            body: "",
          },
          status: "linked",
          kind: "item",
          entity: "hb:item/ring-of-quiet",
        },
      ],
    );
    expect(Object.fromEntries(sections)).toEqual({
      sa: {
        "hb/0007-ring.md": [
          { book: "sa", file: "0001-x.md", heading: "Ring of Quiet (p. 9)" },
        ],
      },
    });
  });
});

describe("ruling entities", () => {
  it("are an engine kind whose about is a soft link, not a reference the loader checks", () => {
    const kind = WORLD_KINDS.rulings;
    expect(kind?.idPrefix).toBe("ruling");
    const parsed = kind?.parse({
      id: "sa:ruling/hush",
      name: "Hush?",
      source: "Sage",
      text: "Yes.",
      about: ["hb:spell/hush"],
    });
    expect(parsed?.ok && parsed.references).toEqual([]);
    expect(() =>
      RulingSchema.parse({
        id: "sa:ruling/x",
        name: "X",
        source: "S",
        text: "",
        extra: 1,
      }),
    ).toThrow();
  });

  it("take a name from a long question that stops at a word", () => {
    const long =
      "If a Warden casts Hush while holding a Ring of Quiet, does the ring stay silent?";
    const { drafts } = draftWorld(
      "sa",
      "Sage",
      [verdict(3, long, "missing", "ruling")],
      new Set(),
    );
    expect(drafts.map((draft) => draft.file)).toEqual([
      "rulings/if-a-warden-casts-hush-while-holding-a-ring-of-quiet-does.yaml",
    ]);
  });
});
