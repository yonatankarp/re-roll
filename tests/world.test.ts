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

describe("drafting into a world plugin", () => {
  it("gives lore the world plugin's id, and keeps rulings and a system's kinds in the book's", () => {
    const { drafts } = draftWorld(
      "bk",
      "A Book",
      [
        verdict(2, "Gloomfen", "missing", "place"),
        verdict(3, "1: Gate", "missing", "area"),
        verdict(2, "Brindle", "linked", "place", "bk-world:place/brindle"),
        verdict(2, "Can I Hide?", "missing", "ruling"),
        verdict(2, "Dizzy", "missing", "condition"),
      ],
      new Set(),
      { condition: "conditions" },
      "bk-world",
    );
    expect(drafts.map(({ entry }) => [entry.id, entry.place])).toEqual([
      ["bk-world:place/gloomfen", undefined],
      ["bk-world:area/gloomfen-1-gate", "bk-world:place/gloomfen"],
      ["bk:ruling/can-i-hide", undefined],
      ["bk:condition/dizzy", undefined],
    ]);
  });
});

describe("drafting a system's text kinds", () => {
  it("leaves a heading's label, such as its kind or price, out of the id and name", () => {
    const { drafts } = draftWorld(
      "bk",
      "A Book",
      [
        verdict(3, "Dizzy [Condition]", "missing", "condition"),
        verdict(3, "Two-Step", "missing", "weapon-property"),
        verdict(3, "Unlisted [Thing]", "missing", "unlisted"),
        verdict(3, "Variant: Lucky Dice", "missing", "variant-rule"),
        verdict(3, "Snug (1,500 GP per Day)", "missing", "lifestyle"),
        verdict(3, "Huddled (Free)", "missing", "lifestyle"),
        verdict(3, "Ferry (1 SP/Trip)", "missing", "service"),
        verdict(3, "Toll (Bridge)", "missing", "service"),
      ],
      new Set(),
      {
        condition: "conditions",
        "weapon-property": "weapon-properties",
        "variant-rule": "variant-rules",
        lifestyle: "lifestyles",
        service: "services",
      },
    );
    expect(
      drafts.map(({ file, entry }) => [file, entry.id, entry.name]),
    ).toEqual([
      ["conditions/dizzy.yaml", "bk:condition/dizzy", "Dizzy"],
      [
        "weapon-properties/two-step.yaml",
        "bk:weapon-property/two-step",
        "Two-Step",
      ],
      [
        "variant-rules/lucky-dice.yaml",
        "bk:variant-rule/lucky-dice",
        "Lucky Dice",
      ],
      ["lifestyles/snug.yaml", "bk:lifestyle/snug", "Snug"],
      ["lifestyles/huddled.yaml", "bk:lifestyle/huddled", "Huddled"],
      ["services/ferry.yaml", "bk:service/ferry", "Ferry"],
      ["services/toll-bridge.yaml", "bk:service/toll-bridge", "Toll (Bridge)"],
    ]);
  });
});
