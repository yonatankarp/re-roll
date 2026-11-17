import { describe, expect, it } from "vitest";
import type { Status, Verdict } from "../engine/tools/coverage.ts";
import { draftWorld } from "../engine/tools/world.ts";

// Every name here is invented.
const verdict = (
  level: number,
  text: string,
  status: Status,
  kind: string,
  entity?: string,
): Verdict => ({
  heading: {
    id: `bk/0001-x#${text}`,
    book: "bk",
    file: "0001-x.md",
    level,
    text,
    body: `About ${text}.`,
  },
  status,
  kind,
  ...(entity ? { entity } : {}),
});

describe("drafting world entities", () => {
  it("names each from its heading, takes its parts' text, and links it to what it sits in", () => {
    // A heading matched only to another book's lore still gets this book's own entity.
    const { drafts, homeless } = draftWorld(
      "bk",
      "A Book",
      [
        verdict(2, "Gloomfen", "missing", "place"),
        verdict(3, "History", "structural", "structural"),
        verdict(3, "The Drowned Choir", "missing", "faction"),
        verdict(4, "Goals", "structural", "structural"),
        verdict(4, "Wren Ashby", "missing", "npc"),
        verdict(3, "Gloomfen Features", "structural", "structural"),
        verdict(3, "1: Gate", "missing", "area"),
        verdict(2, "The Pale Court", "linked", "pantheon", "bk:pantheon/pale"),
        verdict(3, "Óth", "missing", "deity"),
        verdict(2, "2: Well", "missing", "area"),
        verdict(2, "Ashvale", "linked", "place", "other:place/ashvale"),
        verdict(2, "Brindle", "linked", "place", "bk:place/brindle"),
      ],
      new Set(["places/gloomfen.yaml"]),
    );
    expect(homeless).toEqual(["bk/0001-x#2: Well"]);
    expect(drafts.map(({ file, entry }) => [file, entry])).toEqual([
      [
        "places/gloomfen-2.yaml",
        {
          id: "bk:place/gloomfen-2",
          name: "Gloomfen",
          source: "A Book",
          text: "About Gloomfen.\n\n### History\n\nAbout History.\n\n### Gloomfen Features\n\nAbout Gloomfen Features.",
          library: ["bk/0001-x#Gloomfen"],
        },
      ],
      [
        "factions/the-drowned-choir.yaml",
        expect.objectContaining({
          text: "About The Drowned Choir.\n\n#### Goals\n\nAbout Goals.",
        }),
      ],
      [
        "npcs/wren-ashby.yaml",
        expect.objectContaining({
          place: "bk:place/gloomfen-2",
          faction: "bk:faction/the-drowned-choir",
        }),
      ],
      [
        "areas/gloomfen-2-1-gate.yaml",
        expect.objectContaining({
          id: "bk:area/gloomfen-2-1-gate",
          place: "bk:place/gloomfen-2",
        }),
      ],
      [
        "deities/oth.yaml",
        expect.objectContaining({ pantheon: "bk:pantheon/pale" }),
      ],
      [
        "places/ashvale.yaml",
        expect.objectContaining({ id: "bk:place/ashvale" }),
      ],
    ]);
  });
});
