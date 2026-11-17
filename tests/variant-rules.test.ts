import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PLAYER_ACTOR, type ContentAccess } from "#sdk";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deriveStats } from "../plugins/systems/dnd5.5e/core/stats.ts";
import {
  ENCUMBRANCE,
  NO_RULES_EFFECT,
  SKILLS_WITH_DIFFERENT_ABILITIES,
  VARIANT_SETTINGS,
  chosenVariants,
  variantOn,
} from "../plugins/systems/dnd5.5e/core/variant-rules.ts";
import { contextOf, hero, scripted, testRun } from "./feat-fixtures.ts";

const playing = (access: ContentAccess, variantRules: readonly string[]) => {
  const withState = { ...access, state: { variantRules } };
  return withState;
};

describe("variant rules (#190)", () => {
  it("keeps the rules a run turns on in its state, and none when it turns none on", async () => {
    const run = await testRun();
    const setup = (settings: Record<string, string>) =>
      run.system.createRun({
        settings,
        actors: [{ id: PLAYER_ACTOR, name: "You", role: "player" }],
        dice: scripted([]).dice,
        content: run.content,
        contentIds: run.contentIds,
      }) as Record<string, unknown>;
    expect(setup({ difficulty: "normal" })).not.toHaveProperty("variantRules");
    expect(setup({ [ENCUMBRANCE]: "on" })).toMatchObject({
      variantRules: [ENCUMBRANCE],
    });
    expect(chosenVariants({ [ENCUMBRANCE]: "off" })).toEqual([]);
    expect(
      run.system.settings?.filter((setting) => setting.variant).length,
    ).toBe(VARIANT_SETTINGS.length);
  });

  it("slows a loaded character with Encumbrance, and gives Disadvantage on Strength, Dexterity and Constitution rolls when heavily loaded", async () => {
    const run = await testRun();
    // A Strength of 17 carries 255 pounds: over 85 is encumbered and over 170 heavily. Chain mail is 55 pounds.
    const loaded = (count: number, rules: readonly string[] = [ENCUMBRANCE]) =>
      deriveStats(
        {
          ...hero([]),
          inventory: Array.from(
            { length: count },
            () => "srd52:item/chain-mail",
          ),
          stowed: Array.from({ length: count }, () => "srd52:item/chain-mail"),
        },
        playing(run, rules),
      );
    const speed = (count: number, rules?: readonly string[]) =>
      loaded(count, rules).speed;
    expect(speed(1)).toBe(30);
    expect(speed(2)).toBe(20);
    expect(speed(4)).toBe(10);
    expect(speed(5)).toBe(5); // past capacity, dragged
    expect(speed(4, [])).toBe(30);
    const hampered = (count: number) =>
      loaded(count).passives.filter(
        (passive) =>
          passive.kind === "modifier" &&
          passive.modifier.kind === "disadvantage" &&
          "ability" in passive.modifier,
      ).length;
    expect(hampered(2)).toBe(0);
    expect(hampered(4)).toBe(9);
  });

  it("adds a skill's proficiency to another ability's check only with Skills with Different Abilities", async () => {
    const run = await testRun();
    const total = (rules: readonly string[], check: object) => {
      const context = contextOf(run, [hero([])], scripted([10]).dice);
      const result = run.system.resolveCheck(check, {
        ...context,
        state: { ...context.state, variantRules: [...rules] },
      });
      const rolled = (result.events ?? []).find(
        (event) => "payload" in event && "total" in event.payload,
      );
      return rolled && "payload" in rolled ? rolled.payload.total : null;
    };
    const paired = { skill: "athletics", ability: "con", dc: 10 };
    const plain = { ability: "con", dc: 10 };
    expect(total([], paired)).toBe(total([], plain));
    expect(total([SKILLS_WITH_DIFFERENT_ABILITIES], paired)).toBe(
      Number(total([], plain)) + 2,
    );
  });

  it("reads a variant from the state beside the access, and none without one", async () => {
    const run = await testRun();
    expect(variantOn(run, ENCUMBRANCE)).toBe(false);
    expect(variantOn(playing(run, [ENCUMBRANCE]), ENCUMBRANCE)).toBe(true);
  });

  it.skipIf(!existsSync("books/rules"))(
    "has a verdict for every variant rule in the books",
    () => {
      const ids = readdirSync("books/rules").flatMap((book) => {
        const dir = `books/rules/${book}/variant-rules`;
        return existsSync(dir)
          ? readdirSync(dir).flatMap((file) =>
              (
                parse(readFileSync(`${dir}/${file}`, "utf8")) as {
                  id: string;
                }[]
              ).map((entry) => entry.id),
            )
          : [];
      });
      const known = [
        ...VARIANT_SETTINGS.map((setting) => setting.id),
        ...Object.keys(NO_RULES_EFFECT),
      ];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.filter((id) => !known.includes(id))).toEqual([]);
      expect(known.filter((id) => !ids.includes(id))).toEqual([]);
    },
  );
});
