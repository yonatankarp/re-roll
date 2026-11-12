import { describe, expect, it } from "vitest";
import { multiattackUses } from "../plugins/systems/dnd5.5e/core/multiattack-uses.ts";
import { MonsterSchema } from "../plugins/systems/dnd5.5e/core/schemas.ts";

// A made-up monster: one attack and two save actions, with the Multiattack sentence given per test.
const monster = (multiattack: string) =>
  MonsterSchema.parse({
    id: "my-book:monster/coiler",
    name: "Coiler",
    ac: 12,
    hp: 30,
    speed: 30,
    abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 10, cha: 4 },
    proficiency: 2,
    initiative: 1,
    text: `Actions\nMultiattack. ${multiattack}\nBite. …`,
    actions: [
      ["Bite", "attack"],
      ["Squeeze", "save"],
      ["Hiss", "save"],
    ].map(([name, kind]) => ({
      name,
      activation: {
        cost: ["action"],
        targeting: { creatures: 1, range: 5, side: "enemy" },
        resolution:
          kind === "attack"
            ? {
                kind: "attack",
                attack: { type: "weapon", flatBonus: 4 },
                damage: [{ amount: { dice: "1d6" }, type: "piercing" }],
              }
            : { kind: "save", ability: "con", dc: { base: 12 } },
      },
    })),
  });

describe("a multiattack's other actions", () => {
  it("reads the action a routine also uses, by id", () => {
    expect(
      multiattackUses(
        monster("The coiler makes one Bite attack and uses Squeeze."),
      ),
    ).toEqual(["monster:1"]);
  });

  it("takes the first of a choice, and a use made twice", () => {
    expect(
      multiattackUses(
        monster(
          "The coiler makes one Bite attack and uses either Hiss or Squeeze.",
        ),
      ),
    ).toEqual(["monster:2"]);
    expect(multiattackUses(monster("The coiler uses Hiss twice."))).toEqual([
      "monster:2",
      "monster:2",
    ]);
  });

  it("leaves out another routine to choose instead", () => {
    expect(
      multiattackUses(
        monster("The coiler makes two Bite attacks, or it uses Squeeze."),
      ),
    ).toEqual([]);
  });
});
