import { describe, expect, it } from "vitest";
import {
  type Placed,
  familyLinks,
  linksIndex,
} from "../plugins/systems/dnd5.5e/core/import/families.ts";
import {
  LairSchema,
  MonsterFamilySchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";

// A made-up bestiary, names and ids only.
const B = "bestiary";
const at = (
  file: string,
  level: number,
  text: string,
  entity?: string,
  body = "",
): Placed => ({ file, level, text, body, ...(entity ? { entity } : {}) });

const BOOK: Placed[] = [
  at("01.md", 2, "Gloomwings", `${B}:monster-family/gloomwings`),
  at("02.md", 3, "Gloomwing Lairs", `${B}:lair/gloomwing-lairs`),
  at("03.md", 3, "Gloomwing Hatchling", `${B}:monster/gloomwing-hatchling`),
  at("03.md", 4, "Gloomwing Hatchling", `${B}:monster/gloomwing-hatchling`),
  at("04.md", 3, "Elder Gloomwing", `${B}:monster/elder-gloomwing`),
  at("05.md", 2, "Mirelings", `${B}:monster-family/mirelings`),
  at("05.md", 3, "Mireling Brood", `${B}:monster-family/mireling-brood`),
  at("06.md", 4, "Mireling", `${B}:monster/mireling`),
  at("07.md", 3, "Mireling Sage", `${B}:monster/mireling-sage`),
  at(
    "08.md",
    2,
    "Fiends of the Fen",
    `${B}:monster-family/fiends-of-the-fen`,
    "Gloomwings (all)\n\nBogbeast\n\nNothing at all",
  ),
  at("09.md", 2, "Domains"),
  at("10.md", 3, "Old Morra’s Lair", `${B}:lair/old-morras-lair`),
  at("10.md", 4, "Morra’s Hut", `${B}:place/morras-hut`),
];
const look = {
  inLair: (id: string) => id.endsWith("/elder-gloomwing"),
  named: (name: string) =>
    name === "Bogbeast" ? "other:monster/bogbeast" : undefined,
  people: [
    { id: `${B}:npc/old-morra`, name: "Old Morra" },
    { id: `${B}:monster/elder-gloomwing`, name: "Elder Gloomwing" },
  ],
};

describe("monster families and lairs", () => {
  const links = familyLinks(B, BOOK, look);

  it("hold the stat blocks below them, once each, and a family inside one holds its own", () => {
    expect(links.get(`${B}:monster-family/gloomwings`)).toEqual([
      `${B}:monster/gloomwing-hatchling`,
      `${B}:monster/elder-gloomwing`,
    ]);
    expect(links.get(`${B}:monster-family/mirelings`)).toEqual([
      `${B}:monster-family/mireling-brood`,
      `${B}:monster/mireling-sage`,
    ]);
    expect(links.get(`${B}:monster-family/mireling-brood`)).toEqual([
      `${B}:monster/mireling`,
    ]);
  });

  it("read a group's list of names and whole families", () => {
    expect(links.get(`${B}:monster-family/fiends-of-the-fen`)).toEqual([
      `${B}:monster-family/gloomwings`,
      "other:monster/bogbeast",
    ]);
  });

  it("belong to the family's stat blocks that print in-Lair numbers, or to whoever they're named for", () => {
    expect(links.get(`${B}:lair/gloomwing-lairs`)).toEqual([
      `${B}:monster/elder-gloomwing`,
    ]);
    expect(links.get(`${B}:lair/old-morras-lair`)).toEqual([
      `${B}:npc/old-morra`,
    ]);
  });

  it("index the sections both ways, leaving out links to their own section", () => {
    const index = linksIndex(BOOK, links);
    expect(index["04.md"]).toEqual([
      { file: "01.md", heading: "Gloomwings", rel: "family" },
      { file: "02.md", heading: "Gloomwing Lairs", rel: "lair" },
    ]);
    expect(index["02.md"]).toEqual([
      { file: "04.md", heading: "Elder Gloomwing", rel: "owner" },
    ]);
    // Both families start in 05.md, so it lists the members of each.
    expect(index["05.md"]).toEqual([
      { file: "07.md", heading: "Mireling Sage", rel: "member" },
      { file: "06.md", heading: "Mireling", rel: "member" },
    ]);
    expect(index["06.md"]).toEqual([
      { file: "05.md", heading: "Mireling Brood", rel: "family" },
    ]);
  });

  it("link another book's family or stat block one way, from this book's section (#188)", () => {
    const away = (id: string) =>
      id === "other:monster/bogbeast"
        ? { book: "other", file: "20.md", heading: "Bogbeast" }
        : id === "other:monster-family/bogbeasts"
          ? { book: "other", file: "19.md", heading: "Bogbeasts" }
          : undefined;
    const index = linksIndex(
      BOOK,
      new Map([
        ...links,
        ["other:monster-family/bogbeasts", [`${B}:monster/mireling`]],
      ]),
      away,
    );
    expect(index["08.md"]).toEqual([
      { file: "01.md", heading: "Gloomwings", rel: "member" },
      { book: "other", file: "20.md", heading: "Bogbeast", rel: "member" },
    ]);
    expect(index["06.md"]).toEqual([
      { file: "05.md", heading: "Mireling Brood", rel: "family" },
      { book: "other", file: "19.md", heading: "Bogbeasts", rel: "family" },
    ]);
  });

  it("parse as entities with their links", () => {
    const entry = {
      id: `${B}:lair/x`,
      name: "X",
      source: "Bestiary",
      text: "",
    };
    expect(LairSchema.parse(entry).owners).toEqual([]);
    expect(
      MonsterFamilySchema.parse({ ...entry, members: [`${B}:monster/y`] })
        .members,
    ).toEqual([`${B}:monster/y`]);
  });
});
