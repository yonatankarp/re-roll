import { describe, expect, it } from "vitest";
import { skillRows } from "../plugins/systems/dnd5.5e/core/import/skills.ts";
import { GLOSSARY_TERMS } from "../plugins/systems/dnd5.5e/core/glossary.ts";

// Invented example uses.
describe("a book's Skills table (#187)", () => {
  it("makes each row a skill: its name, and its other cells as text", () => {
    const body = [
      "Some words.",
      "",
      "| Skill | Ability | Example Uses |",
      "| --- | --- | --- |",
      "| Acrobatics | Dexterity | Tumble about. |",
      "| Sleight of Hand | Dexterity | Palm a coin. |",
    ].join("\n");
    expect(skillRows(body)).toEqual([
      {
        id: "acrobatics",
        name: "Acrobatics",
        text: "Dexterity: Tumble about.",
      },
      {
        id: "sleight-of-hand",
        name: "Sleight of Hand",
        text: "Dexterity: Palm a coin.",
      },
    ]);
  });

  it("finds none in a table whose rows aren't all skills, or in no table", () => {
    expect(
      skillRows("| Ability | Skill |\n| --- | --- |\n| Strength | Athletics |"),
    ).toEqual([]);
    expect(skillRows("Just words.")).toEqual([]);
  });

  it("gives the hover each skill and creature type, capitalized only", () => {
    const words = (id: string) =>
      GLOSSARY_TERMS.find((term) => term.id === id)?.words;
    expect(words("skill:sleightOfHand")).toEqual(["Sleight of Hand"]);
    expect(words("skill:animalHandling")).toEqual(["Animal Handling"]);
    expect(words("creature-type:undead")).toEqual(["Undead"]);
  });
});
