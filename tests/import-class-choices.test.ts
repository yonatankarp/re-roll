import { describe, expect, it } from "vitest";
import type { ContentAccess, ContentEntry } from "../engine/kernel/system.ts";
import { levelChoices } from "../plugins/systems/dnd5.5e/core/character.ts";
import { parseClassesFromHtml } from "../plugins/systems/dnd5.5e/core/import/classes.ts";
import {
  type ClassDef,
  ClassSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";

// A made-up class in the Player's Handbook's layout.
const page = `
  <h1>Chapter 3: Callings</h1>
  <h2 id="Hexer">Hexer</h2>
  <table><caption><h3>Core Hexer Traits</h3></caption><tbody>
    <tr><th>Primary Ability</th><td>Charisma</td></tr>
    <tr><td>Hit Point Die</td><td>D8 per Hexer level</td></tr>
    <tr><td>Saving Throw Proficiencies</td><td>Wisdom and Charisma</td></tr>
    <tr><td>Weapon Proficiencies</td><td>Simple and Martial weapons</td></tr>
    <tr><td>Armor Training</td><td>Light armor</td></tr>
  </tbody></table>
  <h3>Hexer Class Features</h3>
  <table><caption><h3>Hexer Features</h3></caption><thead>
    <tr><th>Level</th><th>Proficiency Bonus</th><th>Class Features</th><th>Eldritch Invocations</th></tr>
  </thead><tbody>
    <tr><td>1</td><td>+2</td><td><a href="#L1Inv">Eldritch Invocations</a></td><td>1</td></tr>
    <tr><td>2</td><td>+2</td><td><a href="#L2Mastery">Weapon Mastery</a></td><td>3</td></tr>
    <tr><td>3</td><td>+2</td><td>—</td><td>3</td></tr>
  </tbody></table>
  <h4 id="L1Inv">Level 1: Eldritch Invocations</h4><p>You gain one invocation.</p>
  <h4 id="L2Mastery">Level 2: Weapon Mastery</h4><p>You can use the mastery properties of three kinds of weapons.</p>
  <h3>Eldritch Invocation Options</h3>
  <h4>Ember Sight</h4><p>You see embers.</p>
  <h4>Ash Step</h4><p>Prerequisite: Level 2+ Hexer</p>
  <h1>Chapter 4: Origins</h1>`;

describe("class tables that grant choices", () => {
  const [parsed] = parseClassesFromHtml(page, "my-book");
  const hexer = ClassSchema.parse(parsed?.entry);

  it("offers the options as the table's column grows", () => {
    const options = [
      "my-book:feature/hexer-ember-sight",
      "my-book:feature/hexer-ash-step",
    ];
    expect(hexer.levels.map((level) => level.choices)).toEqual([
      [{ kind: "option", id: "eldritch-invocations", count: 1, from: options }],
      [{ kind: "option", id: "eldritch-invocations", count: 2, from: options }],
      [],
    ]);
  });

  it("counts weapon masteries from the feature when the table has no column", () => {
    expect(hexer.levels.map((level) => level.scaling.weaponMastery)).toEqual([
      undefined,
      3,
      3,
    ]);
  });
});

describe("option choices for a class imported without them", () => {
  const warlock: ClassDef = ClassSchema.parse({
    id: "old:class/hexer",
    name: "Hexer",
    hitDie: "d8",
    primaryAbilities: ["cha"],
    savingThrows: ["wis", "cha"],
    weapons: ["simple"],
    armor: ["light"],
    levels: [
      {
        level: 1,
        grants: ["old:feature/hexer-eldritch-invocations"],
        scaling: { eldritchInvocations: 1 },
      },
      { level: 2, scaling: { eldritchInvocations: 3 } },
      {
        level: 3,
        grants: ["old:feature/hexer-subclass"],
        scaling: { eldritchInvocations: 3 },
      },
    ],
  });
  const feature = (id: string): ContentEntry =>
    ({ id, name: id, text: "Text.", automation: "text" }) as ContentEntry;
  const entries: Record<string, ContentEntry> = {
    [warlock.id]: warlock,
    "old:feature/hexer-eldritch-invocations": feature(
      "old:feature/hexer-eldritch-invocations",
    ),
    "old:feature/hexer-subclass": feature("old:feature/hexer-subclass"),
    "old:feature/hexer-ember-sight": feature("old:feature/hexer-ember-sight"),
    "old:feature/hexer-ash-step": feature("old:feature/hexer-ash-step"),
    "old:feature/hexer-grove-bark": feature("old:feature/hexer-grove-bark"),
    "old:subclass/hexer-grove": {
      id: "old:subclass/hexer-grove",
      name: "Grove",
      class: warlock.id,
      levels: [{ level: 3, grants: ["old:feature/hexer-grove-bark"] }],
    } as unknown as ContentEntry,
  };
  const access: ContentAccess = {
    content: (id) => entries[id],
    contentIds: () => Object.keys(entries),
  };

  it("offers the class's features that no level grants, as many as were gained", () => {
    const option = (level: number) =>
      levelChoices(warlock, level, undefined, access).find(
        (item) => item.kind === "option",
      );
    const from = [
      "old:feature/hexer-ember-sight",
      "old:feature/hexer-ash-step",
    ];
    expect(option(1)).toEqual({
      kind: "option",
      id: "eldritch-invocations",
      count: 1,
      from,
    });
    expect(option(2)).toMatchObject({ count: 2, from });
    expect(option(3)).toBeUndefined();
  });
});
